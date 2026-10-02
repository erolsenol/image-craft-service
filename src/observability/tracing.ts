import { context, SpanStatusCode, trace } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { FastifyOtelInstrumentation } from "@fastify/otel";
import { NodeSDK } from "@opentelemetry/sdk-node";
import type { AppConfig } from "../config/index.js";

let sdk: NodeSDK | undefined;

export function startTracing(
  config: AppConfig,
): (() => Promise<void>) | undefined {
  if (!config.OTEL_ENABLED) return undefined;
  const endpoint = new URL(config.OTEL_EXPORTER_OTLP_ENDPOINT);
  const tracesUrl = endpoint.pathname.endsWith("/v1/traces")
    ? endpoint.toString()
    : `${endpoint.toString().replace(/\/$/u, "")}/v1/traces`;
  sdk = new NodeSDK({
    serviceName: "image-craft-service",
    traceExporter: new OTLPTraceExporter({ url: tracesUrl }),
    instrumentations: [
      new FastifyOtelInstrumentation({ registerOnInitialization: true }),
    ],
  });
  sdk.start();
  return async () => {
    const currentSdk = sdk;
    sdk = undefined;
    await currentSdk?.shutdown();
  };
}

export async function withSpan<T>(
  name: string,
  attributes: Record<string, string | number | boolean>,
  operation: () => Promise<T>,
): Promise<T> {
  const tracer = trace.getTracer("image-craft-service");
  return tracer.startActiveSpan(name, { attributes }, async (span) => {
    try {
      return await context.with(
        trace.setSpan(context.active(), span),
        operation,
      );
    } catch (error) {
      span.recordException(
        error instanceof Error ? error : new Error("Unknown operation error"),
      );
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      span.end();
    }
  });
}
