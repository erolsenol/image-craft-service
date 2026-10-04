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
import {
  createHttpPdfRasterizer,
  type PdfRasterizer,
} from "../core/pdf-rasterizer.js";
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
import packageJson from "../../package.json" with { type: "json" };
import { TenantUsage } from "../security/tenants.js";
import { AdminDashboardStats } from "../observability/admin-dashboard.js";
import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Redis } from "ioredis";
import { DistributedCacheLock } from "../core/distributed-cache-lock.js";

export interface AppDependencies {
  remoteImageFetcher?: typeof fetchRemoteImage;
  pdfRasterizer?: PdfRasterizer;
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
  const dashboardStats = config.ADMIN_DASHBOARD_ENABLED
    ? new AdminDashboardStats()
    : undefined;
  metrics.attach(app);
  const tenantUsage = new TenantUsage(
    config.TENANTS,
    (tenant) => metrics.recordTenantRequest(tenant),
    (tenant, bytes) => metrics.recordTenantBytes(tenant, bytes),
  );
  const activeStorage = storage ?? createStorage(config);
  const lockRedis = config.CACHE_DISTRIBUTED_LOCK_ENABLED
    ? new Redis(config.REDIS_URL, {
        maxRetriesPerRequest: 1,
        enableOfflineQueue: false,
        connectTimeout: 1000,
        retryStrategy: (attempt) => (attempt < 3 ? attempt * 100 : null),
      })
    : undefined;
  lockRedis?.on("error", (error) =>
    app.log.warn({ err: error }, "Distributed cache lock Redis unavailable"),
  );
  const distributedCacheLock = lockRedis
    ? new DistributedCacheLock(
        {
          acquire: async (key, token, ttlMs) =>
            (await lockRedis.set(key, token, "PX", ttlMs, "NX")) === "OK",
          extend: async (key, token, ttlMs) =>
            Number(
              await lockRedis.eval(
                "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('PEXPIRE', KEYS[1], ARGV[2]) else return 0 end",
                1,
                key,
                token,
                String(ttlMs),
              ),
            ) === 1,
          release: async (key, token) => {
            await lockRedis.eval(
              "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end",
              1,
              key,
              token,
            );
          },
        },
        config.CACHE_DISTRIBUTED_LOCK_TTL_MS,
        config.CACHE_DISTRIBUTED_LOCK_WAIT_MS,
      )
    : undefined;
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
          tenantUsage,
        )
      : undefined);
  let active = 0;
  const trackedRequests = new WeakSet<FastifyRequest>();
  app.decorateRequest("tenantPrincipal", null);
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
          "x-cache-key",
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
    request.tenantPrincipal = principal;
    const scope = requiredApiScope(request.url);
    if (!principal.scopes.includes(scope))
      return reply.code(403).send({ error: "API key scope is insufficient" });
    if (principal.tenantId) {
      if (!config.TENANTS[principal.tenantId])
        return reply.code(403).send({ error: "Tenant is not configured" });
      if (!tenantUsage.recordRequest(principal.tenantId))
        return reply.code(429).send({
          error: "Tenant daily request quota exceeded",
          code: "TENANT_REQUEST_QUOTA_EXCEEDED",
        });
    }
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
        request.url === "/admin" || request.url.startsWith("/admin/")
          ? "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'"
          : "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
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
        version: packageJson.version,
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
  if (config.ADMIN_DASHBOARD_ENABLED && dashboardStats) {
    const dashboardDirectory = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "../../dashboard/dist",
    );
    app.get("/admin", async (_request, reply) => {
      try {
        const html = await readFile(resolve(dashboardDirectory, "index.html"));
        return reply.type("text/html; charset=utf-8").send(html);
      } catch {
        return reply.code(503).send({
          error:
            "Dashboard assets are unavailable; run npm run build:dashboard",
        });
      }
    });
    app.get("/admin/dashboard.js", async (_request, reply) => {
      try {
        const script = await readFile(resolve(dashboardDirectory, "main.js"));
        return reply.type("text/javascript; charset=utf-8").send(script);
      } catch {
        return reply.code(404).send({ error: "Dashboard asset not found" });
      }
    });
    app.get("/admin/dashboard.css", async (_request, reply) => {
      try {
        const styles = await readFile(
          resolve(dashboardDirectory, "styles.css"),
        );
        return reply.type("text/css; charset=utf-8").send(styles);
      } catch {
        return reply.code(404).send({ error: "Dashboard asset not found" });
      }
    });
  }
  app.get(
    "/v1/admin/dashboard/data",
    {
      schema: {
        summary: "Read dashboard cache, request, queue, and tenant stats",
        tags: ["Admin"],
        response: {
          200: {
            type: "object",
            required: ["cache", "requests", "topImages", "queue", "tenants"],
            properties: {
              cache: { type: "object", additionalProperties: true },
              requests: { type: "object", additionalProperties: true },
              topImages: { type: "array", items: { type: "object" } },
              queue: { type: "object", additionalProperties: true },
              tenants: { type: "array", items: { type: "object" } },
            },
          },
          404: {
            type: "object",
            required: ["error"],
            properties: { error: { type: "string" } },
          },
        },
      },
    },
    async (_request, reply) => {
      if (!config.ADMIN_DASHBOARD_ENABLED || !dashboardStats)
        return reply.code(404).send({ error: "Admin dashboard is disabled" });
      await metrics.render(activeQueue, processingLimiter);
      const [cache, metricSnapshots] = await Promise.all([
        activeStorage.stats(),
        metrics.registry.getMetricsAsJSON(),
      ]);
      const requests = metricSnapshots.find(
        (metric) => metric.name === "image_craft_http_requests_total",
      );
      const cacheMetric = metricSnapshots.find(
        (metric) => metric.name === "image_craft_cache_requests_total",
      );
      const queueMetric = metricSnapshots.find(
        (metric) => metric.name === "image_craft_queue_depth",
      );
      const availableMetric = metricSnapshots.find(
        (metric) => metric.name === "image_craft_queue_metrics_available",
      );
      const requestValues = requests?.values ?? [];
      const requestCount = requestValues.reduce(
        (total, value) => total + Number(value.value ?? 0),
        0,
      );
      const errorValues = requestValues.filter((value) => {
        const status = Number(value.labels.status_code ?? 0);
        return status >= 400;
      });
      const errorCount = errorValues.reduce(
        (total, value) => total + Number(value.value ?? 0),
        0,
      );
      const cacheValues = cacheMetric?.values ?? [];
      const cacheHits = cacheValues
        .filter((value) => value.labels.result === "hit")
        .reduce((total, value) => total + Number(value.value ?? 0), 0);
      const cacheMisses = cacheValues
        .filter((value) => value.labels.result === "miss")
        .reduce((total, value) => total + Number(value.value ?? 0), 0);
      const queueDepth = Object.fromEntries(
        (queueMetric?.values ?? []).map((value) => [
          String(value.labels.state),
          Number(value.value ?? 0),
        ]),
      );
      const tenants = Object.entries(config.TENANTS).map(([id, policy]) => ({
        id,
        requestsPerDay: policy.requestsPerDay,
        bytesPerDay: policy.bytesPerDay,
        usage: tenantUsage.get(id),
      }));
      return {
        updatedAt: new Date().toISOString(),
        cache: {
          ...cache,
          hits: cacheHits,
          misses: cacheMisses,
          hitRatio:
            cacheHits + cacheMisses === 0
              ? 0
              : cacheHits / (cacheHits + cacheMisses),
        },
        requests: {
          total: requestCount,
          errors: errorCount,
          errorRate: requestCount === 0 ? 0 : errorCount / requestCount,
          byStatus: errorValues.map((value) => ({
            method: value.labels.method,
            route: value.labels.route,
            status: value.labels.status_code,
            count: value.value,
          })),
        },
        topImages: dashboardStats.topImages(),
        queue: {
          enabled: Boolean(activeQueue),
          available: Number(availableMetric?.values[0]?.value ?? 0) === 1,
          depth: queueDepth,
        },
        tenants,
      };
    },
  );
  app.get(
    "/v1/admin/tenants",
    {
      schema: {
        summary: "List tenant policies and daily usage",
        response: {
          200: {
            type: "array",
            items: {
              type: "object",
              required: ["id", "requestsPerDay", "bytesPerDay", "usage"],
              properties: {
                id: { type: "string" },
                requestsPerDay: { type: "integer" },
                bytesPerDay: { type: "integer" },
                allowedSources: { type: "array", items: { type: "string" } },
                allowedOps: { type: "array", items: { type: "string" } },
                presets: { type: "array", items: { type: "string" } },
                usage: {
                  type: "object",
                  properties: {
                    day: { type: "string" },
                    requests: { type: "integer" },
                    bytes: { type: "integer" },
                  },
                },
              },
            },
          },
          403: {
            type: "object",
            properties: { error: { type: "string" } },
          },
        },
      },
    },
    async () =>
      Object.entries(config.TENANTS).map(([id, policy]) => ({
        id,
        requestsPerDay: policy.requestsPerDay,
        bytesPerDay: policy.bytesPerDay,
        allowedSources: policy.allowedSources,
        allowedOps: policy.allowedOps,
        presets: Object.keys(policy.presets),
        usage: tenantUsage.get(id),
      })),
  );
  app.get<{ Params: { tenantId: string } }>(
    "/v1/admin/tenants/:tenantId",
    {
      schema: {
        summary: "Get tenant policy and daily usage",
        params: {
          type: "object",
          required: ["tenantId"],
          properties: { tenantId: { type: "string" } },
        },
        response: {
          200: {
            type: "object",
            required: ["id", "requestsPerDay", "bytesPerDay", "usage"],
            properties: {
              id: { type: "string" },
              requestsPerDay: { type: "integer" },
              bytesPerDay: { type: "integer" },
              allowedSources: { type: "array", items: { type: "string" } },
              allowedOps: { type: "array", items: { type: "string" } },
              presets: { type: "object", additionalProperties: true },
              usage: {
                type: "object",
                properties: {
                  day: { type: "string" },
                  requests: { type: "integer" },
                  bytes: { type: "integer" },
                },
              },
            },
          },
          403: {
            type: "object",
            properties: { error: { type: "string" } },
          },
          404: {
            type: "object",
            properties: { error: { type: "string" }, code: { type: "string" } },
          },
        },
      },
    },
    async (request, reply) => {
      const policy = config.TENANTS[request.params.tenantId];
      if (!policy)
        return reply
          .code(404)
          .send({ error: "Tenant not found", code: "TENANT_NOT_FOUND" });
      return {
        id: request.params.tenantId,
        ...policy,
        usage: tenantUsage.get(request.params.tenantId),
      };
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
    pdfRasterizer:
      dependencies.pdfRasterizer ??
      createHttpPdfRasterizer({
        workerUrl: config.PDF_RASTERIZER_URL,
        timeoutMs: config.PDF_WORKER_TIMEOUT_MS,
        maxOutputBytes: config.MAX_UPLOAD_BYTES,
      }),
    metrics,
    tenantUsage,
    ...(distributedCacheLock ? { distributedCacheLock } : {}),
    ...(dashboardStats
      ? {
          onSourceRequest: (source: string) =>
            dashboardStats.recordImageRequest(source),
        }
      : {}),
  });
  await app.register(batchRoutes, {
    config,
    storage: activeStorage,
    tenantUsage,
    ...(activeQueue ? { queue: activeQueue } : {}),
  });
  app.addHook("onClose", async () => {
    await activeQueue?.close();
    if (lockRedis) {
      if (lockRedis.status === "ready") await lockRedis.quit();
      else lockRedis.disconnect();
    }
    await activeStorage.close?.();
  });
  return app;
}
