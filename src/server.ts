#!/usr/bin/env node
import { config } from "./config/index.js";
import { createApp } from "./api/app.js";
const app = await createApp(config);
try {
  await app.listen({ host: config.HOST, port: config.PORT });
} catch (error) {
  app.log.error({ err: error }, "Server failed to start");
  process.exitCode = 1;
}
