#!/usr/bin/env node
import { config } from "./config/index.js";
import { startTracing } from "./observability/tracing.js";

const stopTracing = startTracing(config);
const { createApp } = await import("./api/app.js");
const app = await createApp(config);
try {
  await app.listen({ host: config.HOST, port: config.PORT });
  const shutdown = (signal: NodeJS.Signals) => {
    app.log.info({ signal }, "Shutting down gracefully");
    void app
      .close()
      .then(() => stopTracing?.())
      .catch((error: unknown) => {
        app.log.error({ err: error }, "Graceful shutdown failed");
        process.exitCode = 1;
      });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
} catch (error) {
  app.log.error({ err: error }, "Server failed to start");
  await stopTracing?.();
  process.exitCode = 1;
}
