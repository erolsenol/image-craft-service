# Horizontal scaling load-test report

## Status

This report defines the reproducible 1k/5k/10k RPS runs. No multi-replica Kubernetes/S3/Redis target is attached to this development workspace, so there are no measured latency, error-rate, or memory results to publish yet. Values below are marked **not measured**; they are not estimates or service-capacity claims.

## Workload and method

Use the same immutable image and transform URL for all requests to exercise warm-cache reads. Run the generator from a separate machine so it does not contend with API pods. Use an image-sized response small enough to complete at the selected rate. Warm the transform cache for 30 seconds, then run each target for 5 minutes, repeating each run three times. Use one API key with sufficient request quota and include its scope. Keep the same pod requests/limits, S3 bucket/region, Redis deployment, and client location for every run.

Build/deploy the API with `STORAGE_DRIVER=s3`, `CACHE_DISTRIBUTED_LOCK_ENABLED=true`, shared `REDIS_URL`, and at least two replicas. Choose a cacheable remote transform URL allowed by SSRF/host configuration. From the load generator:

```sh
export LOAD_URL='https://images.example.test/v1/img/w_800,f_webp/https://assets.example.test/fixture.jpg'
export LOAD_API_KEY='<test API key>'
npm run load:scale -- --url "$LOAD_URL" --rps 1000 --duration 300
npm run load:scale -- --url "$LOAD_URL" --rps 5000 --duration 300
npm run load:scale -- --url "$LOAD_URL" --rps 10000 --duration 300
```

The script prints JSON with achieved RPS, status counts, dropped requests, p50/p95/p99/max latency, and generator memory. Preserve each JSON output with the deployment commit, chart values, pod count, node size, and S3/Redis tier. During each run, collect pod CPU/memory/restarts, HPA replica count, Redis CPU/memory/commands, S3 request latency/errors, and `image_craft_cache_requests_total` deltas. Reject a run if the generator reports dropped work or if 5xx rate exceeds the pre-agreed service SLO.

## Results

| Target request rate | Achieved rate |          p50 |          p95 |          p99 | 5xx / network errors | Peak API pod memory | Repetitions |
| ------------------: | ------------: | -----------: | -----------: | -----------: | -------------------: | ------------------: | ----------: |
|           1,000 RPS |  Not measured | Not measured | Not measured | Not measured |         Not measured |        Not measured |           0 |
|           5,000 RPS |  Not measured | Not measured | Not measured | Not measured |         Not measured |        Not measured |           0 |
|          10,000 RPS |  Not measured | Not measured | Not measured | Not measured |         Not measured |        Not measured |           0 |

## Limits and interpretation

These results must be filled from a deployed, multi-node run before publishing a capacity claim. The load script uses a single Node.js generator and caps in-flight requests; use multiple generator instances if its CPU or network saturates. A warm-cache run measures shared object-store and API overhead, not image encode throughput. Repeat with a cold cache and a realistic source/ops distribution to measure transform CPU, Redis lock contention, and stampede behavior. Do not compare cache-hit throughput with imgproxy or Thumbor transform throughput as if they were the same workload.
