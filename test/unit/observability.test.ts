import { describe, expect, it } from "vitest";
import { ServiceMetrics } from "../../src/observability/metrics.js";
import { withSpan } from "../../src/observability/tracing.js";
import { ConcurrencyLimiter } from "../../src/security/concurrency.js";
import type { BatchQueue } from "../../src/jobs/types.js";

describe("service observability", () => {
  it("records cache and per-operation measurements in Prometheus format", async () => {
    const metrics = new ServiceMetrics();
    metrics.recordCacheResult("HIT");
    metrics.recordCacheResult("MISS");
    metrics.recordOperation("resize", 0.025);

    const output = await metrics.render(undefined, new ConcurrencyLimiter(2));
    expect(output).toContain(
      'image_craft_cache_requests_total{result="hit"} 1',
    );
    expect(output).toContain(
      'image_craft_cache_requests_total{result="miss"} 1',
    );
    expect(output).toContain(
      'image_craft_transform_operation_duration_seconds_count{operation="resize"} 1',
    );
    expect(output).toContain("image_craft_transforms_in_flight 0");
  });

  it("runs instrumented operations with tracing disabled", async () => {
    await expect(
      withSpan("test.operation", {}, async () => "ok"),
    ).resolves.toBe("ok");
  });

  it("collects waiting, active, and delayed queue depth", async () => {
    const metrics = new ServiceMetrics();
    const queue = {
      getQueueDepth: async () => ({ waiting: 3, active: 2, delayed: 1 }),
    } as BatchQueue;
    const output = await metrics.render(queue, new ConcurrencyLimiter(2));
    expect(output).toContain('image_craft_queue_depth{state="waiting"} 3');
    expect(output).toContain('image_craft_queue_depth{state="active"} 2');
    expect(output).toContain('image_craft_queue_depth{state="delayed"} 1');
  });
});
