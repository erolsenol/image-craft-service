# Benchmarks

This document separates a local transform profile from cross-project load-test results. The local profile measures the transform-engine change; it is not a server-throughput comparison. The HTTP comparison records a controlled run against imgproxy and Thumbor and includes the raw k6 summaries.

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
      TARGET="$target" FORMAT="$format" VUS="$vus" DURATION=10s k6 run \
        --summary-export "docs/benchmark-results/${target}-${format}-${vus}vus.json" \
        scripts/benchmark.js
    done
  done
done
```

Set `SOURCE_URL='https://your-public-fixture.example.test/benchmark.jpg'` before the loop. The script accepts `DURATION` (default `30s`). The `resize` case emits the source's original format; WebP and AVIF request explicit output formats. imgproxy is expected to allow unsigned paths for this isolated benchmark (`/insecure/`); Thumbor uses its unsafe URL mode. Do not expose either setting on a public service.

The script emits a request each iteration and checks status/content type. Keep the unmodified k6 summary JSON files with any published comparison, alongside the exact image SHA-256, service image digests, CPU/memory limits, OS, Node, Sharp/libvips, imgproxy and Thumbor versions, and cache state. Report failures and p95/p99 latency as well as throughput. Do not compare runs from different hosts or with different source bytes as if they were controlled results.

### Raw cross-project results

Each run lasted 10 seconds at a fixed VU count. Table values are requests per second and p95 request latency in milliseconds. All 27 runs had zero failed requests and passed the HTTP status/content-type checks. Each raw k6 summary is in [`benchmark-results/http/`](benchmark-results/http/).

| Operation | Service             | VUs | Requests/s | p95 ms |
| --------- | ------------------- | --: | ---------: | -----: |
| Resize    | image-craft-service |   1 |        5.6 |  186.1 |
| Resize    | image-craft-service |   4 |       11.6 |  649.1 |
| Resize    | image-craft-service |  16 |       15.7 | 2689.6 |
| Resize    | imgproxy            |   1 |       34.3 |   31.4 |
| Resize    | imgproxy            |   4 |      141.8 |   31.4 |
| Resize    | imgproxy            |  16 |      138.5 |  134.9 |
| Resize    | Thumbor             |   1 |       10.6 |  136.9 |
| Resize    | Thumbor             |   4 |       35.8 |  200.7 |
| Resize    | Thumbor             |  16 |       71.6 |  629.6 |
| WebP      | image-craft-service |   1 |        4.7 |  220.8 |
| WebP      | image-craft-service |   4 |        9.8 |  776.1 |
| WebP      | image-craft-service |  16 |       13.2 | 3112.4 |
| WebP      | imgproxy            |   1 |       25.3 |   43.7 |
| WebP      | imgproxy            |   4 |       94.3 |   49.1 |
| WebP      | imgproxy            |  16 |       79.9 |  218.5 |
| WebP      | Thumbor             |   1 |       22.8 |  143.8 |
| WebP      | Thumbor             |   4 |       54.2 |  195.8 |
| WebP      | Thumbor             |  16 |       57.9 |  696.8 |
| AVIF      | image-craft-service |   1 |        4.1 |  274.0 |
| AVIF      | image-craft-service |   4 |        8.6 |  854.6 |
| AVIF      | image-craft-service |  16 |       11.8 | 3496.8 |
| AVIF      | imgproxy            |   1 |       31.2 |   41.5 |
| AVIF      | imgproxy            |   4 |      113.4 |   44.5 |
| AVIF      | imgproxy            |  16 |      114.4 |  165.3 |
| AVIF      | Thumbor             |   1 |       28.7 |  137.4 |
| AVIF      | Thumbor             |   4 |       70.6 |  157.6 |
| AVIF      | Thumbor             |  16 |       77.1 |  563.1 |

In this setup, image-craft-service was slower than both imgproxy and Thumbor for every tested operation and concurrency. At 16 VUs its p95 ranged from 2.7 to 3.5 seconds, reflecting its configured two transform slots. This is a real gap in the current HTTP path; the local engine profile does not hide it. The comparison includes remote fetch, image validation, DNS/IP checks, and transformation for image-craft-service, while imgproxy and Thumbor used their unsigned `/insecure/` and `/unsafe/` paths. It is one machine and one synthetic image, not a general ranking or a security-equivalent deployment comparison.

### Captured environment

- Apple M4, 16 GiB host RAM, macOS 26.5.2; Colima 0.10.3, 4 vCPU/6 GiB VM, Docker Engine 29.5.2; containers ran sequentially with 2 CPUs and 2 GiB each.
- image-craft-service v1.0.0 candidate, Node 20.20.2, Sharp 0.35.5, libvips 8.18.7, `IMAGE_PROCESSING_CONCURRENCY=2`, `SHARP_CONCURRENCY=2`, 32 MiB libvips cache; image ID `sha256:570d31c0cab29914306dd36cfea994b9c49d3d2600f38ed06daabe9ca4e5c807`.
- imgproxy image `ghcr.io/imgproxy/imgproxy:latest`, OCI version label `latest-arm64`, digest `sha256:c0d8c00be50c091b975c230d50b5d8bed93c5eefee30444b4b490367d58566a8`.
- Thumbor 7.7.7 / Python 3.13, digest `sha256:8e10758c3c2306bfd9ec200aadc2752250fe8187fb0611e7ca9d831d508d80f5`.
- k6 2.3.0; source fixture `benchmark.jpg`, 2400×1600, 45,269 bytes, SHA-256 `893a33e420f760b4f6cc20f5d3a40ea3378f779f9142f5818f2e7ed25c469161`.

The fixture is a solid-color image, so it is deterministic but not representative of photographic content. All services fetched it from the same public GitHub raw URL on each request; requests included unique query parameters to avoid transform-cache hits. Results vary with image complexity, remote network latency, service tuning, and native codec builds.
