# Benchmarks

This document separates a local transform profile from cross-project load-test results. The local profile measures the transform-engine change; it is not a server-throughput comparison. No imgproxy or Thumbor numbers are published until the same public source image and load-test environment have been run against all three services.

## Reproduce the local transform profile

Requires Node.js 20+ and dependencies installed with `npm ci`.

```sh
npm run benchmark:profile
```

The script generates a deterministic 2400×1600 solid-color PNG in memory, then runs 12 sequential 800-pixel WebP transforms and 12 AVIF transforms at quality 75. It prints Node, Sharp and libvips versions, input size, elapsed time, and process RSS. Set `PROFILE_ITERATIONS`, `PROFILE_WIDTH`, and `PROFILE_HEIGHT` to change the workload. Results vary with CPU, libvips build, and thermal state.

### Recorded profile

Captured on an Apple M4 with 16 GiB RAM, macOS, Node v26.8.2, Sharp 0.35.5, libvips 8.18.7. The baseline is the v0.9.0 engine; the optimized result is the same runtime and fixture after removing the full-size auto-oriented PNG intermediate and encoding directly from the Sharp pipeline. Both were run in one Node process, sequentially, with no warm-up. RSS is sampled after each format's 12 transforms, so the AVIF value includes allocations retained from the preceding WebP workload.

| Engine          | Format | Images | Total time | Time / image | RSS after run |
| --------------- | ------ | -----: | ---------: | -----------: | ------------: |
| v0.9.0 baseline | WebP   |     12 |   256.6 ms |     21.38 ms |     126.3 MiB |
| optimized       | WebP   |     12 |   164.6 ms |     13.72 ms |      97.0 MiB |
| v0.9.0 baseline | AVIF   |     12 |   487.6 ms |     40.63 ms |     142.9 MiB |
| optimized       | AVIF   |     12 |   353.3 ms |     29.44 ms |     113.8 MiB |

With Sharp concurrency and cache settings held at the v1.0.0 defaults, the profile showed 36% lower WebP time per image, 28% lower AVIF time per image, and about 29 MiB lower RSS at both sampling points. The raw capture is [engine-profile.json](benchmark-results/engine-profile.json). This small synthetic case is not representative of throughput on photographic assets or production hardware. Use the load test below before selecting concurrency for a deployment.

## Reproduce the HTTP comparison

Install [k6](https://grafana.com/docs/k6/latest/set-up/install-k6/). Run image-craft-service, imgproxy, and Thumbor on the same machine with the same resource limits. Set `SOURCE_URL` to the repository's stable, publicly reachable `docs/benchmark-assets/benchmark.jpg`; all services fetch the exact same bytes. Its SHA-256 and size are recorded with the raw results. The source is JPEG so resize preserves the same output format across services. WebP and AVIF use quality 75. image-craft-service correctly blocks private and loopback sources, so a local-only fixture URL is not valid. The k6 script adds a unique query parameter to every source URL, keeping each iteration a transform/cache miss across services.

The benchmark service must allow at least 16 simultaneous requests and more than 60 requests per minute. For image-craft-service, set `CONCURRENCY_LIMIT=16`, `API_RATE_LIMIT=10000`, `REMOTE_TRANSFORM_RATE_LIMIT=10000`, and `MAX_UPLOAD_BYTES=16777216` (the Zod config caps their product at 256 MiB). Keep these benchmark-only limits separate from production settings. All three containers use 2 CPUs and 2 GiB memory; the full Colima VM has 4 CPUs and 6 GiB.

Before each k6 run, export exactly one target base URL, `IMAGE_CRAFT_URL`, `IMGPROXY_URL`, or `THUMBOR_URL`, plus `SOURCE_URL`. Then run the matrix:

```sh
mkdir -p docs/benchmark-results
for target in image-craft imgproxy thumbor; do
  case "$target" in
    image-craft) export IMAGE_CRAFT_URL='http://127.0.0.1:3000' ;;
    imgproxy) export IMGPROXY_URL='http://127.0.0.1:8080' ;;
    thumbor) export THUMBOR_URL='http://127.0.0.1:8888' ;;
  esac
  for format in resize webp avif; do
    for vus in 1 4 16; do
      TARGET="$target" FORMAT="$format" VUS="$vus" k6 run \
        --summary-export "docs/benchmark-results/${target}-${format}-${vus}vus.json" \
        scripts/benchmark.js
    done
  done
done
```

Set `SOURCE_URL='https://your-public-fixture.example.test/benchmark.jpg'` before the loop. The script accepts `DURATION` (default `30s`). The `resize` case emits the source's original format; WebP and AVIF request explicit output formats. imgproxy is expected to allow unsigned paths for this isolated benchmark (`/insecure/`); Thumbor uses its unsafe URL mode. Do not expose either setting on a public service.

The script emits a request each iteration and checks status/content type. Keep the unmodified k6 summary JSON files with any published comparison, alongside the exact image SHA-256, service image digests, CPU/memory limits, OS, Node, Sharp/libvips, imgproxy and Thumbor versions, and cache state. Report failures and p95/p99 latency as well as throughput. Do not compare runs from different hosts or with different source bytes as if they were controlled results.

### Raw cross-project results

| Service             | Resize                      | WebP                        | AVIF                        |
| ------------------- | --------------------------- | --------------------------- | --------------------------- |
| image-craft-service | Not run in this environment | Not run in this environment | Not run in this environment |
| imgproxy            | Not run in this environment | Not run in this environment | Not run in this environment |
| Thumbor             | Not run in this environment | Not run in this environment | Not run in this environment |

The development environment used to prepare this release did not have Docker or k6 installed, and no equivalent three-service deployment was available. Therefore there are no honest cross-project HTTP results yet. The local engine profile above is the only measurement; it does not imply image-craft-service is faster than imgproxy or Thumbor.
