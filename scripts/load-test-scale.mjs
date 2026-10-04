#!/usr/bin/env node
import { performance } from "node:perf_hooks";

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? fallback : process.argv[index + 1];
}

const url = option("url", process.env.LOAD_URL);
const apiKey = option("api-key", process.env.LOAD_API_KEY);
const targetRps = Number(option("rps", "1000"));
const durationSeconds = Number(option("duration", "60"));
const maxInFlight = Number(option("max-in-flight", String(targetRps * 2)));
const accept = option("accept", "image/webp,image/avif,image/*;q=0.8");

if (
  !url ||
  !Number.isSafeInteger(targetRps) ||
  targetRps < 1 ||
  !Number.isFinite(durationSeconds) ||
  durationSeconds < 1 ||
  !Number.isSafeInteger(maxInFlight) ||
  maxInFlight < 1
) {
  console.error(
    "Usage: node scripts/load-test-scale.mjs --url <transform-url> [--rps 1000] [--duration 60] [--api-key key] [--max-in-flight n]",
  );
  process.exit(2);
}

const latencies = [];
const statuses = new Map();
let completed = 0;
let failed = 0;
let dropped = 0;
let inFlight = 0;
let scheduled = 0;
const pending = new Set();
const began = performance.now();
const endsAt = began + durationSeconds * 1000;
const tickMs = 100;
let fractional = 0;

async function request() {
  const started = performance.now();
  inFlight += 1;
  try {
    const response = await fetch(url, {
      headers: {
        Accept: accept,
        ...(apiKey ? { "X-API-Key": apiKey } : {}),
      },
      signal: AbortSignal.timeout(120_000),
    });
    await response.arrayBuffer();
    const status = response.status;
    statuses.set(status, (statuses.get(status) ?? 0) + 1);
    if (status >= 200 && status < 400) completed += 1;
    else failed += 1;
  } catch {
    failed += 1;
    statuses.set("network_error", (statuses.get("network_error") ?? 0) + 1);
  } finally {
    latencies.push(performance.now() - started);
    inFlight -= 1;
  }
}

while (performance.now() < endsAt) {
  await new Promise((resolve) => setTimeout(resolve, tickMs));
  const elapsed = performance.now() - began;
  fractional += (targetRps * tickMs) / 1000;
  const count = Math.floor(fractional);
  fractional -= count;
  for (let index = 0; index < count; index += 1) {
    scheduled += 1;
    if (inFlight >= maxInFlight) {
      dropped += 1;
      continue;
    }
    const job = request().finally(() => pending.delete(job));
    pending.add(job);
  }
  if (elapsed >= durationSeconds * 1000) break;
}
await Promise.all(pending);

latencies.sort((left, right) => left - right);
const percentile = (p) =>
  latencies.length
    ? latencies[
        Math.min(latencies.length - 1, Math.ceil(latencies.length * p) - 1)
      ]
    : 0;
const elapsedSeconds = (performance.now() - began) / 1000;
console.log(
  JSON.stringify(
    {
      url: new URL(url).origin,
      targetRps,
      durationSeconds,
      elapsedSeconds: Number(elapsedSeconds.toFixed(2)),
      scheduled,
      completed,
      failed,
      dropped,
      achievedRps: Number((completed / elapsedSeconds).toFixed(1)),
      statusCounts: Object.fromEntries(statuses),
      latencyMs: {
        p50: Number(percentile(0.5).toFixed(1)),
        p95: Number(percentile(0.95).toFixed(1)),
        p99: Number(percentile(0.99).toFixed(1)),
        max: Number((latencies.at(-1) ?? 0).toFixed(1)),
      },
      runnerMemory: process.memoryUsage(),
    },
    null,
    2,
  ),
);
if (dropped > 0 || failed > 0) process.exitCode = 1;
