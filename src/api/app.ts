import Fastify from "fastify";
import { config as defaultConfig } from "../config/index.js";
import multipart from "@fastify/multipart";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import type { AppConfig } from "../config/index.js";
import { healthRoutes } from "./routes/health.js";
import { transformRoutes } from "./routes/transform.js";
import { DiskStorage } from "../storage/disk-storage.js";
import type { Storage } from "../storage/storage.js";
import { AppError } from "../core/errors.js";
import type { FastifyRequest } from "fastify";
import { batchRoutes } from "./routes/batch.js";
import type { BatchQueue } from "../jobs/types.js";
import { BullMqBatchQueue } from "../jobs/bullmq-batch-queue.js";
import { createPluginRegistry } from "../plugins/registry.js";
import type { PluginRegistry } from "../plugins/interface.js";
import { ConcurrencyLimiter } from "../security/concurrency.js";
import { fetchRemoteImage } from "../security/ssrf.js";

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
  const app = Fastify({
    logger: { level: config.NODE_ENV === "development" ? "debug" : "info" },
    requestIdHeader: "x-request-id",
    requestTimeout: config.REQUEST_TIMEOUT_MS,
    bodyLimit: config.MAX_UPLOAD_BYTES + 1024 * 1024,
  });
  const activeStorage =
    storage ?? new DiskStorage(config.CACHE_DIR, config.CACHE_MAX_SIZE_BYTES);
  const activePlugins = plugins ?? createPluginRegistry(config);
  const processingLimiter = new ConcurrencyLimiter(
    config.IMAGE_PROCESSING_CONCURRENCY,
  );
  const activeQueue =
    batchQueue ??
    (config.QUEUE_ENABLED
      ? new BullMqBatchQueue(config, activeStorage, app.log, processingLimiter)
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
  app.setErrorHandler((error, _request, reply) => {
    app.log.error({ err: error }, "Request failed");
    const statusCode =
      error instanceof AppError
        ? error.statusCode
        : typeof error === "object" && error !== null && "statusCode" in error
          ? Number(error.statusCode)
          : 500;
    const status = statusCode >= 400 && statusCode < 500 ? statusCode : 500;
    const message =
      error instanceof AppError ? error.message : "Request failed";
    return reply
      .code(status)
      .send({ error: status === 500 ? "Internal server error" : message });
  });
  await app.register(multipart, {
    limits: { fileSize: config.MAX_UPLOAD_BYTES, files: 1, fields: 1 },
  });
  await app.register(swagger, {
    openapi: {
      info: {
        title: "Image Craft Service",
        version: "0.2.0",
        description: "Self-hosted image processing HTTP API",
      },
      servers: [{ url: "/" }],
    },
  });
  await app.register(swaggerUi, { routePrefix: "/docs" });
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
  });
  await app.register(batchRoutes, {
    config,
    storage: activeStorage,
    ...(activeQueue ? { queue: activeQueue } : {}),
  });
  if (activeQueue) app.addHook("onClose", () => activeQueue.close());
  return app;
}
