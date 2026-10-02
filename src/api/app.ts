import Fastify from "fastify";
import { config as defaultConfig } from "../config/index.js";
import multipart from "@fastify/multipart";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import type { AppConfig } from "../config/index.js";
import { healthRoutes } from "./routes/health.js";
import { transformRoutes } from "./routes/transform.js";
import { LocalCache } from "../storage/local-cache.js";
import { AppError } from "../core/errors.js";
import type { FastifyRequest } from "fastify";

export async function createApp(config: AppConfig = defaultConfig) {
  const app = Fastify({
    logger: { level: config.NODE_ENV === "development" ? "debug" : "info" },
    requestIdHeader: "x-request-id",
    requestTimeout: config.REQUEST_TIMEOUT_MS,
    bodyLimit: config.MAX_UPLOAD_BYTES + 1024 * 1024,
  });
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
        version: "0.1.0",
        description: "Self-hosted image processing HTTP API",
      },
      servers: [{ url: "/" }],
    },
  });
  await app.register(swaggerUi, { routePrefix: "/docs" });
  await app.register(healthRoutes);
  await app.register(transformRoutes, {
    config,
    cache: new LocalCache(config.CACHE_DIR),
  });
  return app;
}
