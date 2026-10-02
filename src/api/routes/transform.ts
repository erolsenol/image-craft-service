import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppConfig } from "../../config/index.js";
import { AppError } from "../../core/errors.js";
import { transformImage } from "../../core/engine.js";
import { fetchRemoteImage } from "../../security/ssrf.js";
import { verifySignature } from "../../security/signing.js";
import { validateImage } from "../../security/limits.js";
import type { CacheAdapter } from "../../storage/cache.js";
import { operationsSchema, type Operation } from "../schemas/operations.js";

const jsonOpsSchema = z.object({ ops: operationsSchema });
export async function transformRoutes(
  app: FastifyInstance,
  options: { config: AppConfig; cache: CacheAdapter },
): Promise<void> {
  const { config, cache } = options;
  app.addSchema({
    $id: "Error",
    type: "object",
    properties: { error: { type: "string" } },
  });
  app.post(
    "/v1/transform",
    {
      attachValidation: true,
      schema: {
        consumes: ["multipart/form-data"],
        body: {
          type: "object",
          required: ["file"],
          properties: {
            file: {
              type: "string",
              format: "binary",
              description: "Image upload",
            },
            ops: {
              type: "string",
              description: "JSON array of image operations",
            },
          },
        },
        response: {
          200: {
            type: "string",
            format: "binary",
            description: "Transformed image",
          },
          400: { $ref: "Error#" },
        },
      },
    },
    async (request, reply) => {
      const parts = request.parts({
        limits: { fileSize: config.MAX_UPLOAD_BYTES, files: 1, fields: 1 },
      });
      let image: Buffer | undefined;
      let ops: unknown = [];
      for await (const part of parts) {
        if (part.type === "file") image = await part.toBuffer();
        else if (part.fieldname === "ops") {
          try {
            ops = JSON.parse(String(part.value));
          } catch {
            return reply.code(400).send({ error: "Invalid ops JSON" });
          }
        }
      }
      if (!image) return reply.code(400).send({ error: "file is required" });
      const parsed = operationsSchema.safeParse(
        Array.isArray(ops)
          ? ops
          : jsonOpsSchema.safeParse(ops).success
            ? (ops as { ops: unknown[] }).ops
            : undefined,
      );
      if (!parsed.success)
        return reply.code(400).send({ error: "Invalid operations" });
      await validateImage(image, config.MAX_INPUT_PIXELS);
      const result = await transformImage(
        image,
        parsed.data,
        config.MAX_INPUT_PIXELS,
        config.MAX_OUTPUT_DIMENSION,
      );
      return reply.type(result.contentType).send(result.buffer);
    },
  );

  app.post(
    "/v1/metadata",
    {
      attachValidation: true,
      schema: {
        consumes: ["multipart/form-data"],
        body: {
          type: "object",
          required: ["file"],
          properties: { file: { type: "string", format: "binary" } },
        },
        response: {
          200: {
            type: "object",
            properties: {
              width: { type: "integer" },
              height: { type: "integer" },
              format: { type: "string" },
              exif: { type: "object" },
            },
          },
          400: { $ref: "Error#" },
        },
      },
    },
    async (request, reply) => {
      const part = await request.file({
        limits: { fileSize: config.MAX_UPLOAD_BYTES, files: 1 },
      });
      if (!part) return reply.code(400).send({ error: "file is required" });
      const buffer = await part.toBuffer();
      await validateImage(buffer, config.MAX_INPUT_PIXELS);
      const sharp = (await import("sharp")).default;
      const metadata = await sharp(buffer, {
        limitInputPixels: config.MAX_INPUT_PIXELS,
      }).metadata();
      let exif: Record<string, unknown> | undefined;
      if (metadata.exif) {
        try {
          const parseExif = (await import("exif-reader")).default;
          const safeExif = { ...parseExif(metadata.exif) };
          delete safeExif.GPSInfo;
          exif = safeExif as unknown as Record<string, unknown>;
        } catch {
          exif = undefined;
        }
      }
      return {
        width: metadata.width,
        height: metadata.height,
        format: metadata.format,
        ...(exif ? { exif } : {}),
      };
    },
  );

  app.get<{
    Params: { ops: string; "*": string };
    Querystring: { sig?: string };
  }>(
    "/v1/img/:ops/*",
    {
      schema: {
        params: {
          type: "object",
          properties: {
            ops: {
              type: "string",
              description: "Comma-separated image operations",
            },
            "*": { type: "string", description: "Remote image URL" },
          },
        },
        querystring: {
          type: "object",
          properties: { sig: { type: "string" } },
        },
        response: {
          200: {
            type: "string",
            format: "binary",
            description: "Transformed image",
          },
          304: { type: "null", description: "Cached representation is fresh" },
          403: { $ref: "Error#" },
        },
      },
    },
    async (request, reply) => {
      let url: string;
      try {
        url = decodeURIComponent(request.params["*"]);
      } catch {
        throw new AppError("Invalid remote URL", 400);
      }
      let source: URL;
      try {
        source = new URL(url);
      } catch {
        throw new AppError("Invalid remote URL", 400);
      }
      if (
        !verifySignature(
          `${request.params.ops}/${url}`,
          request.query.sig,
          config.SIGNING_SECRET,
        )
      )
        return reply.code(403).send({ error: "Invalid signature" });
      let parsedOps: Operation[];
      try {
        parsedOps = parseCompactOps(request.params.ops);
      } catch {
        throw new AppError("Invalid URL operations", 400);
      }
      const key = `${source.toString()}|${JSON.stringify(parsedOps)}`;
      const etag = `"${createHash("sha256").update(key).digest("hex")}"`;
      reply
        .header("ETag", etag)
        .header(
          "Cache-Control",
          `public, max-age=${config.CACHE_MAX_AGE_SECONDS}`,
        );
      if (request.headers["if-none-match"] === etag)
        return reply.code(304).send();
      let output = await cache.get(key);
      let contentType = "image/jpeg";
      if (!output) {
        const remote = await fetchRemoteImage(source.toString(), {
          allowedHosts: config.ALLOWED_HOSTS.split(",")
            .map((host) => host.trim().toLowerCase())
            .filter(Boolean),
          timeoutMs: config.REQUEST_TIMEOUT_MS,
          maxBytes: config.MAX_UPLOAD_BYTES,
        });
        await validateImage(remote.body, config.MAX_INPUT_PIXELS);
        const result = await transformImage(
          remote.body,
          parsedOps,
          config.MAX_INPUT_PIXELS,
          config.MAX_OUTPUT_DIMENSION,
        );
        output = result.buffer;
        contentType = result.contentType;
        await cache.set(key, output);
      } else {
        const format = [...parsedOps]
          .reverse()
          .find((operation) => operation.op === "format");
        if (format?.op === "format") contentType = `image/${format.format}`;
      }
      return reply.type(contentType).send(output);
    },
  );
}

function parseCompactOps(value: string): Operation[] {
  const groups = new Map<string, Record<string, unknown>>();
  const sequence: string[] = [];
  const categoryByKey: Record<string, string> = {
    w: "resize",
    h: "resize",
    fit: "resize",
    l: "crop",
    t: "crop",
    cw: "crop",
    ch: "crop",
    rot: "rotate",
    blur: "blur",
    sharp: "sharpen",
    gray: "grayscale",
    wm: "watermark",
    grav: "watermark",
    f: "format",
    q: "format",
  };
  for (const token of value.split(",")) {
    const separator = token.indexOf("_");
    if (separator < 1) throw new Error("Invalid operation syntax");
    const key = token.slice(0, separator);
    const raw = token.slice(separator + 1);
    const category = categoryByKey[key];
    if (!category) throw new Error("Unsupported URL operation");
    if (!groups.has(category)) {
      groups.set(category, {});
      sequence.push(category);
    }
    const group = groups.get(category)!;
    if (
      ["w", "h", "l", "t", "cw", "ch", "rot", "blur", "sharp", "q"].includes(
        key,
      )
    ) {
      const number = Number(raw);
      if (!Number.isFinite(number))
        throw new Error("Invalid numeric operation");
      const property: Record<string, string> = {
        w: "width",
        h: "height",
        l: "left",
        t: "top",
        cw: "width",
        ch: "height",
        rot: "angle",
        sharp: "sigma",
        q: "quality",
      };
      group[property[key] ?? key] = number;
    } else if (key === "fit") group.fit = raw;
    else if (key === "f") group.format = raw;
    else if (key === "gray") {
      if (raw !== "1") throw new Error("Invalid grayscale operation");
    } else if (key === "wm") group.text = raw;
    else if (key === "grav") group.gravity = raw;
    else if (key === "blur") group.sigma = Number(raw);
  }
  const operationObjects = sequence.map((category) => ({
    op: category,
    ...groups.get(category),
  }));
  const result = operationsSchema.safeParse(operationObjects);
  if (!result.success) throw new Error("Invalid URL operations");
  return result.data;
}
