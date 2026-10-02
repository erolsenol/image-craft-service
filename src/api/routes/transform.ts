import type { FastifyInstance } from "fastify";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { encode } from "blurhash";
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
import { negotiateFormat } from "../../core/engine.js";
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
          400: {
            type: "object",
            required: ["error", "code"],
            properties: { error: { type: "string" }, code: { type: "string" } },
          },
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
            return reply.code(400).send({
              error: "Invalid ops JSON",
              code: "OPS_JSON_INVALID",
            });
          }
        }
      }
      if (!image)
        return reply.code(400).send({
          error: "file is required",
          code: "FILE_REQUIRED",
        });
      const operationValues = Array.isArray(ops)
        ? ops
        : jsonOpsSchema.safeParse(ops).success
          ? (ops as { ops: unknown[] }).ops
          : undefined;
      if (operationValues && operationValues.length > config.MAX_OPS_CHAIN)
        return reply.code(400).send({
          error: `Operation chain exceeds ${config.MAX_OPS_CHAIN} operations`,
          code: "OPS_CHAIN_TOO_LONG",
        });
      const parsed = operationsSchema.safeParse(operationValues);
      if (!parsed.success)
        return reply.code(400).send({
          error: parsed.error.issues[0]?.message ?? "Invalid operations",
          code: "INVALID_OPERATIONS",
        });
      if (parsed.data.length > config.MAX_OPS_CHAIN)
        return reply.code(400).send({
          error: `Operation chain exceeds ${config.MAX_OPS_CHAIN} operations`,
          code: "OPS_CHAIN_TOO_LONG",
        });
      if (hasAutoFormat(parsed.data)) reply.header("Vary", "Accept");
      const result = await runImageOperations(
        image,
        parsed.data,
        plugins,
        config.MAX_INPUT_PIXELS,
        config.MAX_OUTPUT_DIMENSION,
        processingLimiter,
        request.headers.accept,
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
              description:
                "Comma-separated operations; supports f_auto Accept negotiation, smart/focal crop, padding, effects, watermarks, and rounded corners",
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
              Vary: { schema: { type: "string" } },
            },
          },
          304: {
            type: "null",
            description: "The cached representation matches If-None-Match",
            headers: {
              "X-Cache": { schema: { type: "string", enum: ["HIT", "MISS"] } },
              ETag: { schema: { type: "string" } },
              "Cache-Control": { schema: { type: "string" } },
              Vary: { schema: { type: "string" } },
            },
          },
          403: { $ref: "Error#" },
          429: {
            $ref: "Error#",
            description: "Remote transform rate limit exceeded",
          },
        },
      },
      config: {
        rateLimit: {
          max: config.REMOTE_TRANSFORM_RATE_LIMIT,
          timeWindow: config.REMOTE_TRANSFORM_RATE_WINDOW_MS,
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
        parsedOps = parseCompactOps(request.params.ops, config.MAX_OPS_CHAIN);
      } catch (error) {
        if (error instanceof Error && error.message === "OPS_CHAIN_TOO_LONG")
          return reply.code(400).send({
            error: `Operation chain exceeds ${config.MAX_OPS_CHAIN} operations`,
            code: "OPS_CHAIN_TOO_LONG",
          });
        return reply.code(400).send({
          error: "Invalid URL operations",
          code: "INVALID_URL_OPERATIONS",
        });
      }
      if (parsedOps.length > config.MAX_OPS_CHAIN)
        return reply.code(400).send({
          error: `Operation chain exceeds ${config.MAX_OPS_CHAIN} operations`,
          code: "OPS_CHAIN_TOO_LONG",
        });
      if (hasAutoFormat(parsedOps)) reply.header("Vary", "Accept");
      const outputFormat = outputFormatForRequest(
        parsedOps,
        request.headers.accept,
      );
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
            request.headers.accept,
          );
          await storage.set(key, result.buffer, config.CACHE_MAX_AGE_SECONDS);
          return { buffer: result.buffer, contentType: result.contentType };
        });
        output = transformed.buffer;
        contentType = transformed.contentType;
      }
      if (outputFormat === "original") {
        const metadata = await sharp(output).metadata();
        contentType =
          metadata.format === "heif" && metadata.compression === "av1"
            ? "image/avif"
            : contentTypeFor(metadata.format ?? "jpeg");
      }

      const etag = `"${createHash("sha256").update(output).digest("base64url")}"`;
      reply.header("ETag", etag);
      if (matchesEtag(request.headers["if-none-match"], etag))
        return reply.code(304).send();
      return reply.type(contentType).send(output);
    },
  );

  app.get<{ Params: { "*": string } }>(
    "/v1/hash/*",
    {
      config: {
        rateLimit: {
          max: config.REMOTE_TRANSFORM_RATE_LIMIT,
          timeWindow: config.REMOTE_TRANSFORM_RATE_WINDOW_MS,
        },
      },
      schema: {
        params: {
          type: "object",
          properties: {
            "*": { type: "string", description: "Remote image URL" },
          },
        },
        response: {
          200: {
            type: "object",
            required: ["hash", "width", "height"],
            properties: {
              hash: { type: "string" },
              width: { type: "integer" },
              height: { type: "integer" },
            },
          },
          400: {
            type: "object",
            required: ["error", "code"],
            properties: { error: { type: "string" }, code: { type: "string" } },
          },
          403: { $ref: "Error#" },
          429: { $ref: "Error#" },
        },
      },
    },
    async (request) => {
      let source: URL;
      try {
        source = new URL(decodeURIComponent(request.params["*"]));
      } catch {
        throw new AppError("Invalid remote URL", 400);
      }
      const remote = await fetchImage(source.toString(), {
        allowedHosts: config.ALLOWED_HOSTS.split(",")
          .map((host) => host.trim().toLowerCase())
          .filter(Boolean),
        timeoutMs: config.REQUEST_TIMEOUT_MS,
        maxBytes: config.MAX_UPLOAD_BYTES,
      });
      const makeHash = async () => {
        await validateImage(remote.body, config.MAX_INPUT_PIXELS);
        const resized = await sharp(remote.body, {
          limitInputPixels: config.MAX_INPUT_PIXELS,
        })
          .rotate()
          .resize(32, 32, { fit: "inside" })
          .ensureAlpha()
          .toColourspace("srgb")
          .raw()
          .toBuffer({ resolveWithObject: true });
        const componentsX = Math.min(4, resized.info.width);
        const componentsY = Math.min(3, resized.info.height);
        return {
          hash: encode(
            new Uint8ClampedArray(resized.data),
            resized.info.width,
            resized.info.height,
            componentsX,
            componentsY,
          ),
          width: resized.info.width,
          height: resized.info.height,
        };
      };
      return processingLimiter ? processingLimiter.run(makeHash) : makeHash();
    },
  );
}

function contentTypeFor(format: string): string {
  return format === "jpeg"
    ? "image/jpeg"
    : format === "original"
      ? "application/octet-stream"
      : `image/${format}`;
}

function hasAutoFormat(ops: readonly Operation[]): boolean {
  return (
    [...ops].reverse().find((operation) => operation.op === "format")
      ?.format === "auto"
  );
}

function outputFormatForRequest(
  ops: readonly Operation[],
  accept: string | undefined,
): string {
  return hasAutoFormat(ops)
    ? negotiateFormat(accept, "original")
    : getOutputFormat(ops);
}

function matchesEtag(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  return header.split(",").some((candidate) => {
    const value = candidate.trim();
    return value === "*" || value === etag || value === `W/${etag}`;
  });
}

function parseCompactOps(value: string, maxOperations: number): Operation[] {
  const groups = new Map<string, Record<string, unknown>>();
  const sequence: string[] = [];
  const categoryByKey: Record<string, string> = {
    w: "resize",
    h: "resize",
    fit: "resize",
    strategy: "resize",
    fx: "resize",
    fy: "resize",
    l: "crop",
    t: "crop",
    cw: "crop",
    ch: "crop",
    cstrategy: "crop",
    cfx: "crop",
    cfy: "crop",
    rot: "rotate",
    blur: "blur",
    sharp: "sharpen",
    gray: "grayscale",
    wm: "watermark",
    wmimg: "watermark",
    grav: "watermark",
    pos: "watermark",
    wmop: "watermark",
    f: "format",
    q: "format",
    padtop: "padding",
    padright: "padding",
    padbottom: "padding",
    padleft: "padding",
    bg: "padding",
    flip: "flip",
    flop: "flop",
    tint: "tint",
    bright: "adjust",
    contrast: "adjust",
    sat: "adjust",
    radius: "roundedCorners",
  };
  const properties: Record<string, string> = {
    w: "width",
    h: "height",
    l: "left",
    t: "top",
    cw: "width",
    ch: "height",
    rot: "angle",
    sharp: "sigma",
    q: "quality",
    fx: "fx",
    fy: "fy",
    cfx: "fx",
    cfy: "fy",
    cstrategy: "strategy",
    padtop: "top",
    padright: "right",
    padbottom: "bottom",
    padleft: "left",
    bg: "background",
    bright: "brightness",
    sat: "saturation",
    radius: "radius",
    wmimg: "image",
    pos: "position",
    wmop: "opacity",
  };
  const numericKeys = new Set([
    "w",
    "h",
    "l",
    "t",
    "cw",
    "ch",
    "rot",
    "blur",
    "sharp",
    "q",
    "fx",
    "fy",
    "cfx",
    "cfy",
    "wmop",
    "padtop",
    "padright",
    "padbottom",
    "padleft",
    "bright",
    "contrast",
    "sat",
    "radius",
  ]);
  for (const token of value.split(",")) {
    const separator = token.indexOf("_");
    if (separator < 1) throw new Error("Invalid operation syntax");
    const key = token.slice(0, separator);
    const raw = decodeURIComponent(token.slice(separator + 1));
    const category = categoryByKey[key];
    if (!category) throw new Error("Unsupported URL operation");
    if (!groups.has(category)) {
      groups.set(category, {});
      sequence.push(category);
    }
    const group = groups.get(category)!;
    if (numericKeys.has(key)) {
      const number = Number(raw);
      if (!Number.isFinite(number))
        throw new Error("Invalid numeric operation");
      group[properties[key] ?? key] = number;
    } else if (key === "fit" || key === "strategy") group[key] = raw;
    else if (key === "f") group.format = raw;
    else if (key === "gray" || key === "flip" || key === "flop") {
      if (raw !== "1") throw new Error(`Invalid ${key} operation`);
    } else if (key === "wm") group.text = raw;
    else if (key === "grav") group.gravity = raw;
    else if (key === "pos") group.position = raw;
    else if (key === "tint") group.color = raw;
    else if (key === "contrast") group.contrast = Number(raw);
    else if (key === "blur") group.sigma = Number(raw);
  }
  const operationObjects = sequence.map((category) => ({
    op: category,
    ...groups.get(category),
  }));
  if (operationObjects.length > maxOperations)
    throw new Error("OPS_CHAIN_TOO_LONG");
  const result = operationsSchema.safeParse(operationObjects);
  if (!result.success)
    throw new Error(
      result.error.issues[0]?.message ?? "Invalid URL operations",
    );
  return result.data;
}
