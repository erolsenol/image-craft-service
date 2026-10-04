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
import { createCacheKey } from "../../core/cache-key.js";
import { getOutputFormat } from "../../storage/cache-key.js";
import { negotiateFormat } from "../../core/engine.js";
import type { Storage } from "../../storage/storage.js";
import { operationsSchema, type Operation } from "../schemas/operations.js";
import { SingleFlight } from "../../core/single-flight.js";
import type { DistributedCacheLock } from "../../core/distributed-cache-lock.js";
import type { ServiceMetrics } from "../../observability/metrics.js";
import { withSpan } from "../../observability/tracing.js";
import { resolveImageSource } from "../../security/sources.js";
import type { PdfRasterizer } from "../../core/pdf-rasterizer.js";
import {
  namespaceTenantKey,
  tenantAllowsOperations,
  tenantAllowsSource,
  type TenantUsage,
} from "../../security/tenants.js";

const jsonOpsSchema = z.object({ ops: operationsSchema });
const analyzeBodySchema = z
  .object({ source: z.string().min(1).max(2048) })
  .strict();
export async function transformRoutes(
  app: FastifyInstance,
  options: {
    config: AppConfig;
    storage: Storage;
    plugins?: PluginRegistry;
    processingLimiter?: ConcurrencyLimiter;
    remoteImageFetcher?: typeof fetchRemoteImage;
    pdfRasterizer?: PdfRasterizer;
    metrics?: ServiceMetrics;
    tenantUsage?: TenantUsage;
    onSourceRequest?: (source: string) => void;
    distributedCacheLock?: DistributedCacheLock;
  },
): Promise<void> {
  const { config, storage, metrics, tenantUsage } = options;
  const plugins = options.plugins ?? createPluginRegistry(config);
  const { processingLimiter } = options;
  const fetchImage = options.remoteImageFetcher ?? fetchRemoteImage;
  const pdfRasterizer = options.pdfRasterizer;
  const transformFlights = new SingleFlight<{
    buffer: Buffer;
    contentType: string;
    metadata?: Record<string, string | number | boolean>;
  }>();
  app.addSchema({
    $id: "Error",
    type: "object",
    properties: {
      error: { type: "string" },
      code: { type: "string" },
    },
  });
  app.post<{ Body: { source: string } }>(
    "/v1/analyze",
    {
      config: {
        rateLimit: {
          max: config.REMOTE_TRANSFORM_RATE_LIMIT,
          timeWindow: config.REMOTE_TRANSFORM_RATE_WINDOW_MS,
        },
      },
      schema: {
        body: {
          type: "object",
          required: ["source"],
          properties: { source: { type: "string", maxLength: 2048 } },
          additionalProperties: false,
        },
        response: {
          200: {
            type: "object",
            required: [
              "format",
              "quality",
              "ssim",
              "thresholdMet",
              "sourceBytes",
              "expectedBytes",
              "expectedSavingsBytes",
              "expectedSavingsPercent",
            ],
            properties: {
              format: { type: "string", enum: ["webp", "avif"] },
              quality: { type: "integer" },
              ssim: { type: "number" },
              thresholdMet: { type: "boolean" },
              sourceBytes: { type: "integer" },
              expectedBytes: { type: "integer" },
              expectedSavingsBytes: { type: "integer" },
              expectedSavingsPercent: { type: "number" },
            },
          },
          400: { $ref: "Error#" },
          403: { $ref: "Error#" },
          429: { $ref: "Error#" },
          413: { $ref: "Error#" },
          502: { $ref: "Error#" },
          503: { $ref: "Error#" },
        },
      },
    },
    async (request, reply) => {
      const parsedBody = analyzeBodySchema.safeParse(request.body);
      if (!parsedBody.success)
        return reply.code(400).send({
          error: "source is required",
          code: "INVALID_ANALYZE_REQUEST",
        });
      assertTenantSource(
        request.tenantPrincipal?.tenantId,
        config,
        parsedBody.data.source,
      );
      assertTenantOperations(request.tenantPrincipal?.tenantId, config, [
        { op: "format", format: "avif", quality: "smart" },
      ]);
      let remoteSource;
      try {
        remoteSource = resolveImageSource(
          parsedBody.data.source,
          config.NAMED_SOURCES,
          config.ALLOWED_HOSTS.split(",")
            .map((host) => host.trim().toLowerCase())
            .filter(Boolean),
        );
      } catch {
        return reply
          .code(400)
          .send({ error: "Invalid source", code: "INVALID_SOURCE" });
      }
      const remote = await fetchImage(remoteSource.url.toString(), {
        allowedHosts: remoteSource.allowedHosts,
        timeoutMs: config.REQUEST_TIMEOUT_MS,
        maxBytes: config.MAX_UPLOAD_BYTES,
        ...(remoteSource.headers ? { headers: remoteSource.headers } : {}),
        ...(remoteSource.credentialOrigin
          ? { credentialOrigin: remoteSource.credentialOrigin }
          : {}),
      });
      if (
        request.tenantPrincipal?.tenantId &&
        !tenantUsage?.recordBytes(
          request.tenantPrincipal.tenantId,
          remote.body.length,
        )
      )
        return reply.code(429).send({
          error: "Tenant daily byte quota exceeded",
          code: "TENANT_BYTES_QUOTA_EXCEEDED",
        });
      await validateImage(
        remote.body,
        config.MAX_INPUT_PIXELS,
        config.MAX_ANIMATION_FRAMES,
      );
      const candidates: Array<{
        format: "webp" | "avif";
        buffer: Buffer;
        quality: number;
        ssim: number;
        thresholdMet: boolean;
      }> = [];
      for (const format of ["avif", "webp"] as const) {
        const qualityKey = smartQualityCacheKey(
          remote.body,
          format,
          config.SMART_QUALITY_SSIM_THRESHOLD,
          [],
          request.tenantPrincipal?.tenantId,
        );
        const cachedQuality = config.CACHE_ENABLED
          ? await readSmartQuality(storage, qualityKey)
          : undefined;
        try {
          const result = await runImageOperations(
            remote.body,
            [{ op: "format", format, quality: "smart" }],
            plugins,
            config.MAX_INPUT_PIXELS,
            config.MAX_OUTPUT_DIMENSION,
            processingLimiter,
            undefined,
            undefined,
            request.id,
            {
              maxFrames: config.MAX_ANIMATION_FRAMES,
              smartQualityThreshold: config.SMART_QUALITY_SSIM_THRESHOLD,
              ...(cachedQuality ? { cachedSmartQuality: cachedQuality } : {}),
            },
          );
          if (result.smartQuality && config.CACHE_ENABLED)
            await storage.set(
              qualityKey,
              Buffer.from(String(result.smartQuality.quality)),
              config.CACHE_MAX_AGE_SECONDS,
            );
          if (result.smartQuality)
            candidates.push({
              format,
              buffer: result.buffer,
              ...result.smartQuality,
            });
        } catch (error) {
          if (format === "webp") throw error;
        }
      }
      const best = candidates.sort(
        (left, right) => left.buffer.length - right.buffer.length,
      )[0];
      if (!best)
        return reply.code(503).send({
          error: "No supported lossy encoder is available",
          code: "ANALYSIS_UNAVAILABLE",
        });
      const sourceBytes = remote.body.length;
      const expectedBytes = best.buffer.length;
      const expectedSavingsBytes = Math.max(0, sourceBytes - expectedBytes);
      return {
        format: best.format,
        quality: best.quality,
        ssim: best.ssim,
        thresholdMet: best.thresholdMet,
        sourceBytes,
        expectedBytes,
        expectedSavingsBytes,
        expectedSavingsPercent:
          sourceBytes === 0
            ? 0
            : Number(((expectedSavingsBytes / sourceBytes) * 100).toFixed(2)),
      };
    },
  );
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
              description:
                'JSON operation array. Set format.quality to "smart" for SSIM-targeted JPEG/WebP/AVIF quality. Optional plugins: remove-background, upscale, auto-alt-text, nsfw-check.',
            },
          },
        },
        headers: {
          type: "object",
          properties: {
            "x-cache-key": {
              type: "string",
              description: "Opt in to caching this upload",
            },
            "if-none-match": { type: "string" },
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
              "X-Image-Alt-Text": { schema: { type: "string" } },
              "X-NSFW-Score": {
                schema: { type: "number", minimum: 0, maximum: 1 },
              },
            },
          },
          304: {
            type: "null",
            description: "The representation matches If-None-Match",
            headers: {
              "X-Cache": { schema: { type: "string", enum: ["HIT", "MISS"] } },
              ETag: { schema: { type: "string" } },
              "Cache-Control": { schema: { type: "string" } },
              Vary: { schema: { type: "string" } },
            },
          },
          429: { $ref: "Error#" },
          400: {
            type: "object",
            required: ["error", "code"],
            properties: { error: { type: "string" }, code: { type: "string" } },
          },
          422: { $ref: "Error#" },
          503: { $ref: "Error#" },
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
      assertTenantOperations(
        request.tenantPrincipal?.tenantId,
        config,
        parsed.data,
      );
      if (
        request.tenantPrincipal?.tenantId &&
        !tenantUsage?.recordBytes(
          request.tenantPrincipal.tenantId,
          image.length,
        )
      )
        return reply.code(429).send({
          error: "Tenant daily byte quota exceeded",
          code: "TENANT_BYTES_QUOTA_EXCEEDED",
        });
      if (hasAutoFormat(parsed.data)) reply.header("Vary", "Accept");
      const cacheKeyHeader = request.headers["x-cache-key"];
      const requestedCacheKey =
        typeof cacheKeyHeader === "string" ? cacheKeyHeader.trim() : undefined;
      const shouldCache =
        config.CACHE_ENABLED &&
        requestedCacheKey !== undefined &&
        requestedCacheKey.length > 0 &&
        requestedCacheKey.length <= 512;
      const outputFormat = outputFormatForRequest(
        parsed.data,
        request.headers.accept,
      );
      const inputDigest = createHash("sha256").update(image).digest("hex");
      const key = shouldCache
        ? namespaceTenantKey(
            request.tenantPrincipal?.tenantId,
            createCacheKey(
              new URL(`https://upload.invalid/${inputDigest}`),
              parsed.data,
              outputFormat,
              `upload:${requestedCacheKey}`,
            ),
          )
        : undefined;
      reply.header(
        "Cache-Control",
        `public, max-age=${config.CACHE_MAX_AGE_SECONDS}`,
      );
      const metadataPlugin = parsed.data.some(
        (operation) =>
          operation.op === "plugin" &&
          ["auto-alt-text", "nsfw-check"].includes(operation.name),
      );
      const smartFormat = smartQualityFormat(
        parsed.data,
        request.headers.accept,
      );
      const qualityKey = smartFormat
        ? smartQualityCacheKey(
            image,
            smartFormat,
            config.SMART_QUALITY_SSIM_THRESHOLD,
            parsed.data,
            request.tenantPrincipal?.tenantId,
          )
        : undefined;
      const cachedQuality =
        qualityKey && config.CACHE_ENABLED
          ? await readSmartQuality(storage, qualityKey)
          : undefined;
      const cached =
        key && !metadataPlugin ? await storage.get(key) : undefined;
      const wasCacheHit = cached !== undefined;
      reply.header("X-Cache", wasCacheHit ? "HIT" : "MISS");
      if (key && !metadataPlugin)
        metrics?.recordCacheResult(wasCacheHit ? "HIT" : "MISS");

      const runTransform = async () => {
        if (key && !metadataPlugin) {
          const concurrentCacheValue = await storage.get(key);
          if (concurrentCacheValue !== undefined)
            return {
              buffer: concurrentCacheValue,
              contentType:
                outputFormat === "original" ||
                outputFormat === "preserve" ||
                hasAutoFormat(parsed.data)
                  ? "application/octet-stream"
                  : contentTypeFor(outputFormat),
            };
        }
        const result = await withSpan(
          "image.transform",
          { "image.operation_count": parsed.data.length },
          () =>
            runImageOperations(
              image!,
              parsed.data,
              plugins,
              config.MAX_INPUT_PIXELS,
              config.MAX_OUTPUT_DIMENSION,
              processingLimiter,
              request.headers.accept,
              (operation, seconds) =>
                metrics?.recordOperation(operation, seconds),
              request.id,
              {
                maxFrames: config.MAX_ANIMATION_FRAMES,
                smartQualityThreshold: config.SMART_QUALITY_SSIM_THRESHOLD,
                ...(cachedQuality ? { cachedSmartQuality: cachedQuality } : {}),
              },
            ),
        );
        if (qualityKey && result.smartQuality && config.CACHE_ENABLED)
          await storage.set(
            qualityKey,
            Buffer.from(String(result.smartQuality.quality)),
            config.CACHE_MAX_AGE_SECONDS,
          );
        if (key && !metadataPlugin)
          await withSpan("image.cache.set", { "cache.key": key }, () =>
            storage.set(key, result.buffer, config.CACHE_MAX_AGE_SECONDS),
          );
        return result;
      };
      const result: {
        buffer: Buffer;
        contentType: string;
        metadata?: Record<string, string | number | boolean>;
      } =
        cached !== undefined
          ? {
              buffer: cached,
              contentType:
                outputFormat === "original" ||
                outputFormat === "preserve" ||
                hasAutoFormat(parsed.data)
                  ? "application/octet-stream"
                  : contentTypeFor(outputFormat),
            }
          : key
            ? await transformFlights.run(key, () => {
                if (
                  !options.distributedCacheLock ||
                  !config.CACHE_ENABLED ||
                  metadataPlugin
                )
                  return runTransform();
                return options.distributedCacheLock.run(
                  key,
                  async () => {
                    const value = await storage.get(key);
                    return value === undefined
                      ? undefined
                      : {
                          buffer: value,
                          contentType:
                            outputFormat === "original" ||
                            outputFormat === "preserve" ||
                            hasAutoFormat(parsed.data)
                              ? "application/octet-stream"
                              : contentTypeFor(outputFormat),
                        };
                  },
                  runTransform,
                );
              })
            : await runTransform();
      setPluginMetadataHeaders(reply, result.metadata);
      let contentType = result.contentType;
      if (contentType === "application/octet-stream") {
        const metadata = await sharp(result.buffer).metadata();
        contentType =
          metadata.format === "heif" && metadata.compression === "av1"
            ? "image/avif"
            : contentTypeFor(metadata.format ?? "jpeg");
      }
      const etag = `"${createHash("sha256").update(result.buffer).digest("base64url")}"`;
      reply.header("ETag", etag);
      if (matchesEtag(request.headers["if-none-match"], etag))
        return reply.code(304).send();
      return reply.type(contentType).send(result.buffer);
    },
  );

  app.get<{
    Params: { "*": string };
    Querystring: { page?: number; dpi?: number };
  }>(
    "/v1/pdf/*",
    {
      schema: {
        params: {
          type: "object",
          properties: {
            "*": { type: "string", description: "Remote PDF URL" },
          },
        },
        querystring: {
          type: "object",
          properties: {
            page: {
              type: "integer",
              minimum: 1,
              maximum: config.PDF_MAX_PAGES,
              default: 1,
              description: "One-based page number; defaults to the first page",
            },
            dpi: {
              type: "integer",
              minimum: 36,
              maximum: config.PDF_MAX_DPI,
              default: Math.min(150, config.PDF_MAX_DPI),
            },
          },
        },
        response: {
          200: {
            type: "string",
            format: "binary",
            description: "Rasterized PDF page as PNG",
          },
          400: { $ref: "Error#" },
          403: { $ref: "Error#" },
          413: { $ref: "Error#" },
          415: { $ref: "Error#" },
          429: { $ref: "Error#" },
          503: { $ref: "Error#" },
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
      if (!config.PDF_ENABLED || !pdfRasterizer)
        throw new AppError("PDF processing is disabled", 503);
      let resolvedSource: ReturnType<typeof resolveImageSource>;
      let input: string;
      try {
        input = decodeURIComponent(request.params["*"]);
        resolvedSource = resolveImageSource(
          input,
          config.NAMED_SOURCES,
          config.ALLOWED_HOSTS.split(",")
            .map((host) => host.trim().toLowerCase())
            .filter(Boolean),
        );
      } catch (error) {
        if (error instanceof AppError) throw error;
        throw new AppError("Invalid remote PDF URL", 400);
      }
      assertTenantSource(request.tenantPrincipal?.tenantId, config, input);
      const remote = await fetchImage(resolvedSource.url.toString(), {
        allowedHosts: resolvedSource.allowedHosts,
        timeoutMs: config.REQUEST_TIMEOUT_MS,
        maxBytes: config.MAX_UPLOAD_BYTES,
        accept: "application/pdf",
        ...(resolvedSource.headers ? { headers: resolvedSource.headers } : {}),
        ...(resolvedSource.credentialOrigin
          ? { credentialOrigin: resolvedSource.credentialOrigin }
          : {}),
      });
      if (
        request.tenantPrincipal?.tenantId &&
        !tenantUsage?.recordBytes(
          request.tenantPrincipal.tenantId,
          remote.body.length,
        )
      )
        throw new AppError("Tenant daily byte quota exceeded", 429);
      if (!isPdf(remote.body)) throw new AppError("Input is not a PDF", 415);
      const page = request.query.page ?? 1;
      const dpi = request.query.dpi ?? Math.min(150, config.PDF_MAX_DPI);
      if (page > config.PDF_MAX_PAGES || dpi > config.PDF_MAX_DPI)
        throw new AppError("PDF exceeds configured limits", 413);
      const render = () => pdfRasterizer.render(remote.body, { page, dpi });
      const png = processingLimiter
        ? await processingLimiter.run(render)
        : await render();
      return reply.type("image/png").send(png);
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
          429: { $ref: "Error#" },
        },
      },
    },
    async (request, reply) => {
      const part = await request.file({
        limits: { fileSize: config.MAX_UPLOAD_BYTES, files: 1 },
      });
      if (!part) return reply.code(400).send({ error: "file is required" });
      const buffer = await part.toBuffer();
      if (
        request.tenantPrincipal?.tenantId &&
        !tenantUsage?.recordBytes(
          request.tenantPrincipal.tenantId,
          buffer.length,
        )
      )
        return reply.code(429).send({
          error: "Tenant daily byte quota exceeded",
          code: "TENANT_BYTES_QUOTA_EXCEEDED",
        });
      const sharp = (await import("sharp")).default;
      const readMetadata = async () => {
        await validateImage(
          buffer,
          config.MAX_INPUT_PIXELS,
          config.MAX_ANIMATION_FRAMES,
        );
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
    Querystring: { sig?: string; expires?: string; frame?: number };
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
                "Unsigned URLs use comma-separated operations here; use q_smart for SSIM-targeted quality. Signed URLs use /v1/img/<signature>/<ops>/<source>; operation parameters are canonicalized before signing.",
            },
            "*": {
              type: "string",
              description:
                "Remote HTTP(S) image URL or configured source alias path such as cdn:products/photo.jpg",
            },
          },
        },
        querystring: {
          type: "object",
          properties: {
            expires: {
              type: "string",
              description: "Optional Unix expiry time in seconds",
            },
            frame: {
              type: "integer",
              minimum: 0,
              maximum: config.MAX_ANIMATION_FRAMES - 1,
              description:
                "Optional zero-based animation frame index; returns a still image",
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
              "X-Image-Alt-Text": { schema: { type: "string" } },
              "X-NSFW-Score": {
                schema: { type: "number", minimum: 0, maximum: 1 },
              },
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
              "X-Image-Alt-Text": { schema: { type: "string" } },
              "X-NSFW-Score": {
                schema: { type: "number", minimum: 0, maximum: 1 },
              },
            },
          },
          403: {
            $ref: "Error#",
            description: "Invalid, missing, tampered, or expired signature",
          },
          404: { $ref: "Error#" },
          400: {
            $ref: "Error#",
            description: "Invalid transform parameters or frame index",
          },
          413: {
            $ref: "Error#",
            description: "Input exceeds frame or cumulative pixel limits",
          },
          422: { $ref: "Error#" },
          503: { $ref: "Error#" },
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
      const pathSignature = /^[a-f0-9]{64}$/iu.test(request.params.ops)
        ? request.params.ops
        : undefined;
      let signature = request.query.sig;
      let compactOperations = request.params.ops;
      let rawSource = request.params["*"];
      if (pathSignature) {
        const separator = rawSource.indexOf("/");
        if (separator < 1)
          return reply.code(403).send({
            error: "Invalid signature",
            code: "SIGNATURE_INVALID",
          });
        signature = pathSignature;
        compactOperations = rawSource.slice(0, separator);
        rawSource = rawSource.slice(separator + 1);
      }

      let url: string;
      try {
        url = decodeURIComponent(rawSource);
      } catch {
        if (signature || config.SIGNING_REQUIRED)
          return reply.code(403).send({
            error: "Invalid signature",
            code: "SIGNATURE_INVALID",
          });
        throw new AppError("Invalid remote URL", 400);
      }
      let signatureSource: URL;
      try {
        signatureSource = new URL(url);
      } catch {
        if (signature || config.SIGNING_REQUIRED)
          return reply.code(403).send({
            error: "Invalid signature",
            code: "SIGNATURE_INVALID",
          });
        throw new AppError("Invalid remote URL", 400);
      }
      if (
        !verifyTransformSignature(
          signatureSource,
          compactOperations,
          request.query.expires,
          signature,
          config.SIGNING_SECRET,
          {
            required: config.SIGNING_REQUIRED,
            ...(config.SIGNING_SECRET_PREVIOUS
              ? { previousSecret: config.SIGNING_SECRET_PREVIOUS }
              : {}),
            ...(request.query.frame === undefined
              ? {}
              : { frame: String(request.query.frame) }),
          },
        )
      )
        return reply.code(403).send({
          error: "Invalid signature",
          code: "SIGNATURE_INVALID",
        });
      let remoteSource: ReturnType<typeof resolveImageSource>;
      try {
        remoteSource = resolveImageSource(
          url,
          config.NAMED_SOURCES,
          config.ALLOWED_HOSTS.split(",")
            .map((host) => host.trim().toLowerCase())
            .filter(Boolean),
        );
      } catch (error) {
        if (error instanceof AppError)
          return reply.code(error.statusCode).send({ error: error.message });
        throw error;
      }
      const source = remoteSource.url;
      options.onSourceRequest?.(source.toString());
      assertTenantSource(request.tenantPrincipal?.tenantId, config, url);
      let parsedOps: Operation[];
      try {
        const tenantId = request.tenantPrincipal?.tenantId;
        parsedOps = parseCompactOps(
          compactOperations,
          config.MAX_OPS_CHAIN,
          tenantId ? config.TENANTS[tenantId]?.presets : undefined,
        );
      } catch (error) {
        if (error instanceof Error && error.message === "OPS_CHAIN_TOO_LONG")
          return reply.code(400).send({
            error: `Operation chain exceeds ${config.MAX_OPS_CHAIN} operations`,
            code: "OPS_CHAIN_TOO_LONG",
          });
        if (error instanceof Error && error.message === "UNKNOWN_PRESET")
          return reply.code(404).send({
            error: "Preset is not configured for this tenant",
            code: "PRESET_NOT_FOUND",
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
      assertTenantOperations(
        request.tenantPrincipal?.tenantId,
        config,
        parsedOps,
      );
      if (hasAutoFormat(parsedOps)) reply.header("Vary", "Accept");
      const outputFormat = outputFormatForRequest(
        parsedOps,
        request.headers.accept,
      );
      const key = namespaceTenantKey(
        request.tenantPrincipal?.tenantId,
        createCacheKey(
          source,
          parsedOps,
          outputFormat,
          remoteSource.cacheScope,
          request.query.frame,
        ),
      );
      reply.header(
        "Cache-Control",
        `public, max-age=${config.CACHE_MAX_AGE_SECONDS}`,
      );
      const metadataPlugin = parsedOps.some(
        (operation) =>
          operation.op === "plugin" &&
          ["auto-alt-text", "nsfw-check"].includes(operation.name),
      );
      const smartFormat = smartQualityFormat(parsedOps, request.headers.accept);
      let output =
        metadataPlugin || !config.CACHE_ENABLED
          ? undefined
          : await withSpan("image.cache.get", { "cache.key": key }, () =>
              storage.get(key),
            );
      const wasCacheHit = output !== undefined;
      metrics?.recordCacheResult(wasCacheHit ? "HIT" : "MISS");
      reply.header("X-Cache", wasCacheHit ? "HIT" : "MISS");
      let contentType = contentTypeFor(outputFormat);
      if (output === undefined) {
        const performTransform = async () => {
          const concurrentCacheValue = config.CACHE_ENABLED
            ? await storage.get(key)
            : undefined;
          if (concurrentCacheValue !== undefined)
            return { buffer: concurrentCacheValue, contentType };

          const remote = await withSpan(
            "image.fetch",
            { "server.address": source.hostname },
            () =>
              fetchImage(source.toString(), {
                allowedHosts: remoteSource.allowedHosts,
                timeoutMs: config.REQUEST_TIMEOUT_MS,
                maxBytes: config.MAX_UPLOAD_BYTES,
                ...(remoteSource.headers
                  ? { headers: remoteSource.headers }
                  : {}),
                ...(remoteSource.credentialOrigin
                  ? { credentialOrigin: remoteSource.credentialOrigin }
                  : {}),
              }),
          );
          if (
            request.tenantPrincipal?.tenantId &&
            !tenantUsage?.recordBytes(
              request.tenantPrincipal.tenantId,
              remote.body.length,
            )
          )
            throw new AppError("Tenant daily byte quota exceeded", 429);
          const qualityKey = smartFormat
            ? smartQualityCacheKey(
                remote.body,
                smartFormat,
                config.SMART_QUALITY_SSIM_THRESHOLD,
                parsedOps,
                request.tenantPrincipal?.tenantId,
              )
            : undefined;
          const cachedQuality =
            qualityKey && config.CACHE_ENABLED
              ? await readSmartQuality(storage, qualityKey)
              : undefined;
          const result = await withSpan(
            "image.transform",
            { "image.operation_count": parsedOps.length },
            () =>
              runImageOperations(
                remote.body,
                parsedOps,
                plugins,
                config.MAX_INPUT_PIXELS,
                config.MAX_OUTPUT_DIMENSION,
                processingLimiter,
                request.headers.accept,
                (operation, seconds) =>
                  metrics?.recordOperation(operation, seconds),
                request.id,
                {
                  ...(request.query.frame === undefined
                    ? {}
                    : { frame: request.query.frame }),
                  maxFrames: config.MAX_ANIMATION_FRAMES,
                  smartQualityThreshold: config.SMART_QUALITY_SSIM_THRESHOLD,
                  ...(cachedQuality
                    ? { cachedSmartQuality: cachedQuality }
                    : {}),
                },
              ),
          );
          if (qualityKey && result.smartQuality && config.CACHE_ENABLED)
            await storage.set(
              qualityKey,
              Buffer.from(String(result.smartQuality.quality)),
              config.CACHE_MAX_AGE_SECONDS,
            );
          if (!metadataPlugin && config.CACHE_ENABLED)
            await withSpan("image.cache.set", { "cache.key": key }, () =>
              storage.set(key, result.buffer, config.CACHE_MAX_AGE_SECONDS),
            );
          return {
            buffer: result.buffer,
            contentType: result.contentType,
            ...(result.metadata ? { metadata: result.metadata } : {}),
          };
        };
        const transformed = await transformFlights.run(key, () => {
          if (
            options.distributedCacheLock &&
            config.CACHE_ENABLED &&
            !metadataPlugin
          )
            return options.distributedCacheLock.run(
              key,
              async () => {
                const value = await storage.get(key);
                return value === undefined
                  ? undefined
                  : { buffer: value, contentType };
              },
              performTransform,
            );
          return performTransform();
        });
        output = transformed.buffer;
        contentType = transformed.contentType;
        setPluginMetadataHeaders(reply, transformed.metadata);
      }
      if (
        outputFormat === "original" ||
        outputFormat === "preserve" ||
        hasAutoFormat(parsedOps)
      ) {
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
          404: { $ref: "Error#" },
        },
      },
    },
    async (request) => {
      let resolvedSource: ReturnType<typeof resolveImageSource>;
      try {
        const input = decodeURIComponent(request.params["*"]);
        assertTenantSource(request.tenantPrincipal?.tenantId, config, input);
        resolvedSource = resolveImageSource(
          input,
          config.NAMED_SOURCES,
          config.ALLOWED_HOSTS.split(",")
            .map((host) => host.trim().toLowerCase())
            .filter(Boolean),
        );
      } catch (error) {
        if (error instanceof AppError) throw error;
        throw new AppError("Invalid remote URL", 400);
      }
      const source = resolvedSource.url;
      options.onSourceRequest?.(source.toString());
      const remote = await fetchImage(source.toString(), {
        allowedHosts: resolvedSource.allowedHosts,
        timeoutMs: config.REQUEST_TIMEOUT_MS,
        maxBytes: config.MAX_UPLOAD_BYTES,
        ...(resolvedSource.headers ? { headers: resolvedSource.headers } : {}),
        ...(resolvedSource.credentialOrigin
          ? { credentialOrigin: resolvedSource.credentialOrigin }
          : {}),
      });
      if (
        request.tenantPrincipal?.tenantId &&
        !tenantUsage?.recordBytes(
          request.tenantPrincipal.tenantId,
          remote.body.length,
        )
      )
        throw new AppError("Tenant daily byte quota exceeded", 429);
      const makeHash = async () => {
        await validateImage(
          remote.body,
          config.MAX_INPUT_PIXELS,
          config.MAX_ANIMATION_FRAMES,
        );
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

function setPluginMetadataHeaders(
  reply: import("fastify").FastifyReply,
  metadata?: Record<string, string | number | boolean>,
): void {
  if (typeof metadata?.altText === "string")
    reply.header("X-Image-Alt-Text", encodeURIComponent(metadata.altText));
  if (typeof metadata?.nsfwScore === "number")
    reply.header("X-NSFW-Score", String(metadata.nsfwScore));
}

function contentTypeFor(format: string): string {
  return format === "jpeg"
    ? "image/jpeg"
    : format === "original" || format === "preserve" || format === "auto"
      ? "application/octet-stream"
      : `image/${format}`;
}

function smartQualityFormat(
  operations: readonly Operation[],
  accept?: string,
): "jpeg" | "webp" | "avif" | undefined {
  const formatOperation = [...operations]
    .reverse()
    .find((operation) => operation.op === "format");
  if (formatOperation?.op !== "format" || formatOperation.quality !== "smart")
    return undefined;
  const format =
    formatOperation.format === "auto"
      ? negotiateFormat(accept, "jpeg")
      : formatOperation.format;
  return format === "jpeg" || format === "webp" || format === "avif"
    ? format
    : undefined;
}

function assertTenantSource(
  tenantId: string | undefined,
  config: AppConfig,
  source: string,
): void {
  if (!tenantId) return;
  const policy = config.TENANTS[tenantId];
  if (!policy || !tenantAllowsSource(policy, source))
    throw new AppError("Source is not allowed for this tenant", 403);
}

function assertTenantOperations(
  tenantId: string | undefined,
  config: AppConfig,
  operations: readonly Operation[],
): void {
  if (!tenantId) return;
  const policy = config.TENANTS[tenantId];
  if (!policy || !tenantAllowsOperations(policy, operations))
    throw new AppError("Operation is not allowed for this tenant", 403);
}

function smartQualityCacheKey(
  input: Buffer,
  format: string,
  threshold: number,
  operations: readonly Operation[] = [],
  tenantId?: string,
): string {
  const sourceHash = createHash("sha256").update(input).digest("hex");
  const transformContext = operations
    .filter((operation) => operation.op !== "format")
    .map((operation) => JSON.stringify(operation))
    .join("|");
  return createHash("sha256")
    .update(
      `smart-quality\n${tenantId ?? "public"}\n${sourceHash}\n${format}\n${threshold}\n${transformContext}`,
    )
    .digest("hex");
}

async function readSmartQuality(
  storage: Storage,
  key: string,
): Promise<number | undefined> {
  const value = await storage.get(key);
  if (!value) return undefined;
  const quality = Number(value.toString("utf8"));
  return Number.isInteger(quality) && quality >= 30 && quality <= 95
    ? quality
    : undefined;
}

function isPdf(buffer: Buffer): boolean {
  return buffer.subarray(0, 1024).includes(Buffer.from("%PDF-"));
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
  if (hasAutoFormat(ops)) return negotiateFormat(accept, "original");
  return getOutputFormat(ops);
}

function matchesEtag(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  return header.split(",").some((candidate) => {
    const value = candidate.trim();
    return value === "*" || value === etag || value === `W/${etag}`;
  });
}

function parseCompactOps(
  value: string,
  maxOperations: number,
  presets?: Readonly<Record<string, readonly Operation[]>>,
): Operation[] {
  let presetOperations: readonly Operation[] = [];
  const tokens = value.split(",");
  if (tokens[0]?.startsWith("p:")) {
    const presetName = tokens.shift()!.slice(2);
    if (!/^[a-z][a-z0-9_-]{0,31}$/u.test(presetName) || !presets?.[presetName])
      throw new Error("UNKNOWN_PRESET");
    presetOperations = presets[presetName];
  }
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
  for (const token of tokens) {
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
    if (key === "q" && raw === "smart") group.quality = "smart";
    else if (numericKeys.has(key)) {
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
  if (presetOperations.length + operationObjects.length > maxOperations)
    throw new Error("OPS_CHAIN_TOO_LONG");
  const result = operationsSchema.safeParse(operationObjects);
  if (!result.success)
    throw new Error(
      result.error.issues[0]?.message ?? "Invalid URL operations",
    );
  return [...presetOperations, ...result.data];
}
