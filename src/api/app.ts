import Fastify from "fastify";
import { config as defaultConfig } from "../config/index.js";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import type { AppConfig } from "../config/index.js";
import { healthRoutes } from "./routes/health.js";
import { transformRoutes } from "./routes/transform.js";
import type { Storage } from "../storage/storage.js";
import { createStorage } from "../storage/create-storage.js";
import { AppError } from "../core/errors.js";
import type { FastifyRequest } from "fastify";
import { batchRoutes } from "./routes/batch.js";
import type { BatchQueue } from "../jobs/types.js";
import { BullMqBatchQueue } from "../jobs/bullmq-batch-queue.js";
import { createPluginRegistry } from "../plugins/registry.js";
import type { PluginRegistry } from "../plugins/interface.js";
import { ConcurrencyLimiter } from "../security/concurrency.js";
import { fetchRemoteImage } from "../security/ssrf.js";
import { authenticateApiKey, requiredApiScope } from "../security/api-keys.js";
import { ServiceMetrics } from "../observability/metrics.js";
import { supportsPresignedUploads } from "../storage/presigned-upload-storage.js";
import sharp from "sharp";

export interface AppDependencies {
  remoteImageFetcher?: typeof fetchRemoteImage;
}

export async function createApp(
  config: AppConfig = defaultConfig,
  storage?: Storage,
  batchQueue?: BatchQueue,
  plugins?: PluginRegistry,
  dependencies: AppDependencies = {},
) {
  sharp.concurrency(config.SHARP_CONCURRENCY);
  sharp.cache({ memory: config.SHARP_CACHE_MEMORY_MB, files: 0, items: 100 });
  const app = Fastify({
    logger: {
      level: config.NODE_ENV === "development" ? "debug" : "info",
      redact: {
        paths: [
          "req.url",
          "req.headers.x-api-key",
          "req.headers.authorization",
          "req.headers.cookie",
          "err.message",
          "err.stack",
        ],
        censor: "[REDACTED]",
      },
    },
    requestIdHeader: "x-request-id",
    requestTimeout: config.REQUEST_TIMEOUT_MS,
    bodyLimit: config.MAX_UPLOAD_BYTES + 1024 * 1024,
  });
  const metrics = new ServiceMetrics();
  metrics.attach(app);
  const activeStorage = storage ?? createStorage(config);
  const activePlugins = plugins ?? createPluginRegistry(config);
  const processingLimiter = new ConcurrencyLimiter(
    config.IMAGE_PROCESSING_CONCURRENCY,
  );
  const activeQueue =
    batchQueue ??
    (config.QUEUE_ENABLED
      ? new BullMqBatchQueue(
          config,
          activeStorage,
          app.log,
          processingLimiter,
          metrics,
        )
      : undefined);
  let active = 0;
  const trackedRequests = new WeakSet<FastifyRequest>();
  app.addHook("onRequest", async (request, reply) => {
    if (active >= config.CONCURRENCY_LIMIT)
      return reply.code(503).send({ error: "Service busy" });
    active += 1;
    trackedRequests.add(request);
  });
  app.addHook("onResponse", async (request) => {
    if (trackedRequests.delete(request)) active -= 1;
  });
  app.addHook("onRequest", async (request, reply) => {
    const origin = request.headers.origin;
    if (origin !== undefined) {
      const allowedOrigins = config.CORS_ORIGINS.split(",")
        .map((value) => value.trim())
        .filter(Boolean);
      if (!allowedOrigins.includes(origin))
        return reply.code(403).send({ error: "Origin is not allowed" });
      reply.header("Access-Control-Allow-Origin", origin);
      reply.header("Vary", "Origin");
      reply.header(
        "Access-Control-Expose-Headers",
        "ETag, X-Cache, X-Request-Id, X-Image-Alt-Text, X-NSFW-Score",
      );
      if (request.method === "OPTIONS") {
        const requestedMethod =
          request.headers["access-control-request-method"];
        const methods = ["GET", "HEAD", "POST"];
        if (
          typeof requestedMethod !== "string" ||
          !methods.includes(requestedMethod)
        )
          return reply.code(403).send({ error: "CORS method is not allowed" });
        const allowedHeaders = new Set([
          "authorization",
          "content-type",
          "if-none-match",
          "x-api-key",
          "x-request-id",
        ]);
        const requestedHeaders =
          request.headers["access-control-request-headers"]
            ?.split(",")
            .map((header) => header.trim().toLowerCase())
            .filter(Boolean) ?? [];
        if (requestedHeaders.some((header) => !allowedHeaders.has(header)))
          return reply.code(403).send({ error: "CORS header is not allowed" });
        reply
          .header("Access-Control-Allow-Methods", methods.join(", "))
          .header(
            "Access-Control-Allow-Headers",
            [...allowedHeaders].join(", "),
          )
          .header("Access-Control-Max-Age", "600");
        return reply.code(204).send();
      }
    } else if (request.method === "OPTIONS") {
      return reply.code(403).send({ error: "CORS origin is required" });
    }

    if (!request.url.startsWith("/v1/")) return;
    const apiKeyHeader = request.headers["x-api-key"];
    const providedKey =
      typeof apiKeyHeader === "string" ? apiKeyHeader : undefined;
    const principal = authenticateApiKey(
      providedKey,
      request.ip,
      config.API_KEYS,
    );
    if (!principal)
      return reply.code(401).send({ error: "Valid API key required" });
    const scope = requiredApiScope(request.url);
    if (!principal.scopes.includes(scope))
      return reply.code(403).send({ error: "API key scope is insufficient" });
  });
  app.addHook("onSend", async (request, reply, payload) => {
    const vary = reply.getHeader("Vary");
    const varyValues = (Array.isArray(vary) ? vary : [vary])
      .filter((value): value is string => typeof value === "string")
      .flatMap((value) => value.split(","))
      .map((value) => value.trim())
      .filter(Boolean);
    if (
      request.headers.origin !== undefined &&
      config.CORS_ORIGINS.split(",")
        .map((value) => value.trim())
        .includes(request.headers.origin)
    )
      varyValues.push("Origin");
    if (varyValues.length > 0)
      reply.header("Vary", [...new Set(varyValues)].join(", "));
    reply
      .header("X-Content-Type-Options", "nosniff")
      .header("X-Frame-Options", "DENY")
      .header("Referrer-Policy", "no-referrer")
      .header("X-DNS-Prefetch-Control", "off")
      .header("X-Permitted-Cross-Domain-Policies", "none")
      .header("Cross-Origin-Opener-Policy", "same-origin")
      .header("Cross-Origin-Resource-Policy", "cross-origin")
      .header("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
      .header(
        "Content-Security-Policy",
        "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
      );
    return payload;
  });
  app.setErrorHandler((error, request, reply) => {
    const statusCode =
      error instanceof AppError
        ? error.statusCode
        : typeof error === "object" && error !== null && "statusCode" in error
          ? Number(error.statusCode)
          : 500;
    const status =
      error instanceof AppError && statusCode === 503
        ? 503
        : statusCode >= 400 && statusCode < 500
          ? statusCode
          : 500;
    request.log.error(
      {
        errorName: error instanceof Error ? error.name : "UnknownError",
        statusCode: status,
      },
      "Request failed",
    );
    const message =
      error instanceof AppError
        ? error.message
        : status === 429
          ? "Rate limit exceeded"
          : "Request failed";
    return reply
      .code(status)
      .send({ error: status === 500 ? "Internal server error" : message });
  });
  await app.register(multipart, {
    limits: { fileSize: config.MAX_UPLOAD_BYTES, files: 1, fields: 1 },
  });
  await app.register(rateLimit, {
    global: true,
    max: config.API_RATE_LIMIT,
    timeWindow: config.API_RATE_WINDOW_MS,
    keyGenerator: (request) => {
      const value = request.headers["x-api-key"];
      const providedKey = typeof value === "string" ? value : undefined;
      return (
        authenticateApiKey(providedKey, request.ip, config.API_KEYS)?.id ??
        `ip:${request.ip}`
      );
    },
  });
  await app.register(swagger, {
    transformObject: (document) => {
      const documentObject =
        "openapiObject" in document
          ? document.openapiObject
          : document.swaggerObject;
      const paths = documentObject.paths as
        Record<string, Record<string, Record<string, unknown>>> | undefined;
      const uploadPost = paths?.["/v1/uploads"]?.post;
      if (uploadPost) {
        uploadPost.requestBody = {
          required: true,
          content: {
            "multipart/form-data": {
              schema: {
                type: "object",
                required: ["file"],
                properties: { file: { type: "string", format: "binary" } },
              },
            },
            ...(supportsPresignedUploads(activeStorage)
              ? {
                  "application/json": {
                    schema: {
                      type: "object",
                      required: ["contentType", "sizeBytes"],
                      properties: {
                        contentType: {
                          type: "string",
                          enum: [
                            "image/jpeg",
                            "image/png",
                            "image/webp",
                            "image/avif",
                          ],
                        },
                        sizeBytes: {
                          type: "integer",
                          minimum: 1,
                          maximum: config.MAX_UPLOAD_BYTES,
                        },
                      },
                    },
                  },
                }
              : {}),
          },
        };
      }
      return documentObject;
    },
    openapi: {
      info: {
        title: "Image Craft Service",
        version: "1.0.0",
        description: "Self-hosted image processing HTTP API",
      },
      servers: [{ url: "/" }],
      components: {
        securitySchemes: {
          ApiKeyAuth: {
            type: "apiKey",
            in: "header",
            name: "X-API-Key",
          },
        },
      },
      security: [{ ApiKeyAuth: [] }],
    },
  });
  await app.register(swaggerUi, { routePrefix: "/docs" });
  app.get(
    "/metrics",
    {
      config: { otel: false },
      schema: {
        summary: "Prometheus metrics",
        tags: ["Observability"],
        response: {
          200: {
            description: "Prometheus text exposition format",
            content: {
              "text/plain; version=0.0.4; charset=utf-8": {
                schema: { type: "string" },
              },
            },
          },
        },
      },
    },
    async (_request, reply) => {
      const output = await metrics.render(activeQueue, processingLimiter);
      return reply.type(metrics.registry.contentType).send(output);
    },
  );
  app.options("/v1/*", async (_request, reply) => reply.code(204).send());
  await app.register(healthRoutes, {
    ...(activeQueue ? { queue: activeQueue } : {}),
  });
  await app.register(transformRoutes, {
    config,
    storage: activeStorage,
    plugins: activePlugins,
    processingLimiter,
    ...(dependencies.remoteImageFetcher
      ? { remoteImageFetcher: dependencies.remoteImageFetcher }
      : {}),
    metrics,
  });
  await app.register(batchRoutes, {
    config,
    storage: activeStorage,
    ...(activeQueue ? { queue: activeQueue } : {}),
  });
  app.addHook("onClose", async () => {
    await activeQueue?.close();
    await activeStorage.close?.();
  });
  return app;
}
