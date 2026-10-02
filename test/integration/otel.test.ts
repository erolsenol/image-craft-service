import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { envSchema } from "../../src/config/index.js";
import { startTracing, withSpan } from "../../src/observability/tracing.js";

describe("optional OpenTelemetry export", () => {
  let closeTracing: (() => Promise<void>) | undefined;
  let closeCollector: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await closeTracing?.();
    closeTracing = undefined;
    await closeCollector?.();
    closeCollector = undefined;
  });

  it("exports fetch, transform, and cache spans to an OTLP/HTTP collector", async () => {
    let receivedTraceExport = false;
    const collector = createServer((request, response) => {
      if (request.method === "POST" && request.url === "/v1/traces") {
        receivedTraceExport = true;
        request.resume();
        response.writeHead(200).end();
        return;
      }
      response.writeHead(404).end();
    });
    await new Promise<void>((resolve) =>
      collector.listen(0, "127.0.0.1", resolve),
    );
    closeCollector = () =>
      new Promise<void>((resolve, reject) =>
        collector.close((error) => (error ? reject(error) : resolve())),
      );
    const address = collector.address();
    if (!address || typeof address === "string")
      throw new Error("OTLP test collector did not bind a TCP port");

    const config = envSchema.parse({
      OTEL_ENABLED: "true",
      OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${address.port}`,
    });
    closeTracing = startTracing(config);
    const { createApp } = await import("../../src/api/app.js");
    const app = await createApp(config);
    await app.ready();
    const health = await app.inject({
      url: "/health",
      headers: { "x-request-id": "otel-request-fixture" },
    });
    expect(health.statusCode).toBe(200);
    await app.close();
    await withSpan("image.fetch", { "server.address": "example.test" }, () =>
      withSpan("image.transform", { "image.operation_count": 1 }, () =>
        withSpan(
          "image.cache.get",
          { "cache.key": "fixture" },
          async () => "ok",
        ),
      ),
    );
    await closeTracing?.();
    closeTracing = undefined;

    expect(receivedTraceExport).toBe(true);
  });
});
