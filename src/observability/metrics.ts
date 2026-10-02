import { Counter, Gauge, Histogram, Registry } from "prom-client";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { BatchQueue } from "../jobs/types.js";
import type { ConcurrencyLimiter } from "../security/concurrency.js";
import { trace } from "@opentelemetry/api";

export class ServiceMetrics {
  readonly registry = new Registry();
  private readonly requestStarts = new WeakMap<FastifyRequest, number>();
  private readonly requests: Counter<string>;
  private readonly requestDuration: Histogram<string>;
  private readonly operationDuration: Histogram<string>;
  private readonly cacheRequests: Counter<string>;
  private readonly queueDepth: Gauge<string>;
  private readonly queueAvailable: Gauge<string>;
  private readonly inFlight: Gauge<string>;
  private readonly errors: Counter<string>;

  constructor() {
    const common = { registers: [this.registry] };
    this.requests = new Counter({
      ...common,
      name: "image_craft_http_requests_total",
      help: "Completed HTTP requests by normalized route and status code.",
      labelNames: ["method", "route", "status_code"],
    });
    this.requestDuration = new Histogram({
      ...common,
      name: "image_craft_http_request_duration_seconds",
      help: "HTTP request duration in seconds by normalized route.",
      labelNames: ["method", "route"],
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    });
    this.operationDuration = new Histogram({
      ...common,
      name: "image_craft_transform_operation_duration_seconds",
      help: "Image transform duration in seconds by operation.",
      labelNames: ["operation"],
      buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
    });
    this.cacheRequests = new Counter({
      ...common,
      name: "image_craft_cache_requests_total",
      help: "Image transform cache lookups by result.",
      labelNames: ["result"],
    });
    this.queueDepth = new Gauge({
      ...common,
      name: "image_craft_queue_depth",
      help: "BullMQ job count by state.",
      labelNames: ["state"],
    });
    this.queueAvailable = new Gauge({
      ...common,
      name: "image_craft_queue_metrics_available",
      help: "Whether batch queue metrics can currently be collected.",
    });
    this.inFlight = new Gauge({
      ...common,
      name: "image_craft_transforms_in_flight",
      help: "Image transforms currently holding a processing slot.",
    });
    this.errors = new Counter({
      ...common,
      name: "image_craft_errors_total",
      help: "Failed HTTP responses by stable error code.",
      labelNames: ["code"],
    });
  }

  attach(app: FastifyInstance): void {
    app.addHook("onRequest", async (request) => {
      this.requestStarts.set(request, performance.now());
      trace.getActiveSpan()?.setAttribute("http.request_id", request.id);
    });
    app.addHook("onResponse", async (request, reply) => {
      const started = this.requestStarts.get(request);
      if (started === undefined) return;
      const labels = {
        method: request.method,
        route: request.routeOptions.url ?? "unmatched",
      };
      this.requests.inc({ ...labels, status_code: String(reply.statusCode) });
      this.requestDuration.observe(
        labels,
        (performance.now() - started) / 1000,
      );
    });
    app.addHook("onSend", async (_request, reply, payload) => {
      if (reply.statusCode >= 400) this.countError(reply.statusCode, payload);
      return payload;
    });
  }

  async render(
    queue: BatchQueue | undefined,
    processingLimiter: ConcurrencyLimiter,
  ): Promise<string> {
    this.inFlight.set(processingLimiter.activeCount);
    let depth: { waiting: number; active: number; delayed: number } | undefined;
    let available = queue?.getQueueDepth === undefined ? 0 : 1;
    try {
      depth = await queue?.getQueueDepth?.();
    } catch {
      available = 0;
    }
    this.queueAvailable.set(available);
    for (const state of ["waiting", "active", "delayed"] as const)
      this.queueDepth.set({ state }, depth?.[state] ?? 0);
    return this.registry.metrics();
  }

  recordCacheResult(result: "HIT" | "MISS"): void {
    this.cacheRequests.inc({ result: result.toLowerCase() });
  }

  recordOperation(operation: string, durationSeconds: number): void {
    this.operationDuration.observe({ operation }, durationSeconds);
  }

  private countError(statusCode: number, payload: unknown): void {
    let code = `http_${statusCode}`;
    if (typeof payload === "string" && payload.length < 8192) {
      try {
        const body: unknown = JSON.parse(payload);
        if (
          typeof body === "object" &&
          body !== null &&
          "code" in body &&
          typeof body.code === "string" &&
          /^[A-Z][A-Z0-9_]{0,63}$/u.test(body.code)
        )
          code = body.code;
      } catch {
        // Keep the status-based label when the response is not JSON.
      }
    }
    this.errors.inc({ code });
  }
}
