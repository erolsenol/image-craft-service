import type { FastifyInstance } from "fastify";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { AppConfig } from "../../config/index.js";
import { AppError } from "../../core/errors.js";
import { runImageOperations } from "../../plugins/run-operations.js";
import { createPluginRegistry } from "../../plugins/registry.js";
import type { PluginRegistry } from "../../plugins/interface.js";
import type { ConcurrencyLimiter } from "../../security/concurrency.js";
import { fetchRemoteImage } from "../../security/ssrf.js";
import { verifyTransformSignature } from "../../security/signing.js";
import { validateImage } from "../../security/limits.js";
import { createCacheKey, getOutputFormat } from "../../storage/cache-key.js";
import type { Storage } from "../../storage/storage.js";
import { operationsSchema, type Operation } from "../schemas/operations.js";
import { SingleFlight } from "../../core/single-flight.js";

const jsonOpsSchema = z.object({ ops: operationsSchema });
export async function transformRoutes(
  app: FastifyInstance,
  options: {
    config: AppConfig;
    storage: Storage;
    plugins?: PluginRegistry;
    processingLimiter?: ConcurrencyLimiter;
    remoteImageFetcher?: typeof fetchRemoteImage;
  },
): Promise<void> {
  const { config, storage } = options;
  const plugins = options.plugins ?? createPluginRegistry(config);
  const { processingLimiter } = options;
  const fetchImage = options.remoteImageFetcher ?? fetchRemoteImage;
  const transformFlights = new SingleFlight<{
    buffer: Buffer;
    contentType: string;
  }>();
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
      const result = await runImageOperations(
        image,
        parsed.data,
        plugins,
        config.MAX_INPUT_PIXELS,
        config.MAX_OUTPUT_DIMENSION,
        processingLimiter,
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
      const sharp = (await import("sharp")).default;
      const readMetadata = async () => {
        await validateImage(buffer, config.MAX_INPUT_PIXELS);
        return sharp(buffer, {
          limitInputPixels: config.MAX_INPUT_PIXELS,
        }).metadata();
      };
      const metadata = processingLimiter
        ? await processingLimiter.run(readMetadata)
        : await readMetadata();
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
    Querystring: { sig?: string; expires?: string };
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
          properties: {
            sig: { type: "string", description: "HMAC-SHA256 signature" },
            expires: {
              type: "string",
              description: "Optional Unix expiry time in seconds",
            },
          },
        },
        headers: {
          type: "object",
          properties: {
            "if-none-match": {
              type: "string",
              description: "Return 304 when the cached image matches this ETag",
            },
          },
        },
        response: {
          200: {
            type: "string",
            format: "binary",
            description: "Transformed image",
            headers: {
              "X-Cache": { schema: { type: "string", enum: ["HIT", "MISS"] } },
              ETag: { schema: { type: "string" } },
              "Cache-Control": { schema: { type: "string" } },
            },
          },
          304: {
            type: "null",
            description: "The cached representation matches If-None-Match",
            headers: {
              "X-Cache": { schema: { type: "string", enum: ["HIT", "MISS"] } },
              ETag: { schema: { type: "string" } },
              "Cache-Control": { schema: { type: "string" } },
            },
          },
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
        !verifyTransformSignature(
          source,
          request.params.ops,
          request.query.expires,
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
      const outputFormat = getOutputFormat(parsedOps);
      const key = createCacheKey(source, parsedOps, outputFormat);
      reply.header(
        "Cache-Control",
        `public, max-age=${config.CACHE_MAX_AGE_SECONDS}`,
      );
      let output = await storage.get(key);
      const wasCacheHit = output !== undefined;
      reply.header("X-Cache", wasCacheHit ? "HIT" : "MISS");
      let contentType = contentTypeFor(outputFormat);
      if (output === undefined) {
        const transformed = await transformFlights.run(key, async () => {
          const concurrentCacheValue = await storage.get(key);
          if (concurrentCacheValue !== undefined)
            return { buffer: concurrentCacheValue, contentType };

          const remote = await fetchImage(source.toString(), {
            allowedHosts: config.ALLOWED_HOSTS.split(",")
              .map((host) => host.trim().toLowerCase())
              .filter(Boolean),
            timeoutMs: config.REQUEST_TIMEOUT_MS,
            maxBytes: config.MAX_UPLOAD_BYTES,
          });
          const result = await runImageOperations(
            remote.body,
            parsedOps,
            plugins,
            config.MAX_INPUT_PIXELS,
            config.MAX_OUTPUT_DIMENSION,
            processingLimiter,
          );
          await storage.set(key, result.buffer, config.CACHE_MAX_AGE_SECONDS);
          return { buffer: result.buffer, contentType: result.contentType };
        });
        output = transformed.buffer;
        contentType = transformed.contentType;
      }

      const etag = `"${createHash("sha256").update(output).digest("base64url")}"`;
      reply.header("ETag", etag);
      if (matchesEtag(request.headers["if-none-match"], etag))
        return reply.code(304).send();
      return reply.type(contentType).send(output);
    },
  );
}

function contentTypeFor(format: string): string {
  return format === "jpeg" ? "image/jpeg" : `image/${format}`;
}

function matchesEtag(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  return header.split(",").some((candidate) => {
    const value = candidate.trim();
    return value === "*" || value === etag || value === `W/${etag}`;
  });
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
