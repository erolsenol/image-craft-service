# image-craft-service

[![CI](https://github.com/erolsenol/image-craft-service/actions/workflows/ci.yml/badge.svg)](https://github.com/erolsenol/image-craft-service/actions/workflows/ci.yml) [![npm](https://img.shields.io/npm/v/image-craft-service)](https://www.npmjs.com/package/image-craft-service) [![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE) [![Node.js 20+](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org/)

**A self-hosted image processing API for teams that want image transforms on their own infrastructure.** Built with Node.js, Fastify, and Sharp.

## Features

- Resize, smart and focal-point crop, padding, rotate, flip/flop, tint, color adjustments, watermarks, rounded corners, blur, sharpen, grayscale, and convert to JPEG, PNG, WebP, or AVIF.
- Accept-based auto format selection (AVIF, then WebP, then source format) and BlurHash previews.
- Transform uploaded images or public remote URLs; strip metadata from output.
- Disk cache with TTL, size-bounded LRU eviction, request coalescing, and `X-Cache` / ETag headers; optional S3-compatible storage for cache, uploads, and batch outputs.
- Optional Redis-backed batch jobs with streamed ZIP downloads, per-item errors, retries, and per-client limits.
- SSRF defenses, signed URLs, input and output limits, and bounded processing concurrency.
- SHA-256 API key digests with optional route scopes, per-key request limits, exact-origin CORS, and browser security headers.
- SVG uploads are rejected; image watermarks accept PNG only and responses are rasterized.
- Optional rembg background removal plugin.
- Prometheus metrics for HTTP traffic, operation latency, cache, queue, in-flight transforms, and errors; optional OpenTelemetry traces.
- Provisioned Grafana dashboard and a Compose `monitoring` profile.
- Named, allowlisted source aliases with per-source credentials and S3-presigned upload URLs.

## Before and after

Turn a large JPEG into a smaller WebP with one request:

```text
photo.jpg (2400 × 1600, JPEG)  ── resize 400 × 300 + WebP ──▶  photo.webp
```

```sh
curl -X POST http://localhost:3000/v1/transform \
  -F 'file=@photo.jpg' \
  -F 'ops=[{"op":"resize","width":400,"height":300,"fit":"cover"},{"op":"format","format":"webp","quality":82}]' \
  --output photo.webp
```

## Quick start

Start the published v1.0.0 image (multi-architecture `amd64` and `arm64`):

```sh
docker run --rm -p 3000:3000 ghcr.io/erolsenol/image-craft-service:1.0.0
```

Open [localhost:3000/docs](http://localhost:3000/docs) for interactive API docs. For local development with Node.js 20+, use `npm ci && npm run dev`.

Transform a public image by URL:

```sh
curl -L 'http://localhost:3000/v1/img/w_400,h_300,fit_cover,f_webp/https://example.com/photo.jpg' \
  --output photo.webp
```

For TypeScript, install `image-craft-client`:

```sh
npm install image-craft-client
```

```ts
import { createCraftClient } from "image-craft-client";

const craft = createCraftClient({ baseUrl: "http://localhost:3000" });
const url = craft
  .image("https://example.com/photo.jpg")
  .resize(800)
  .format("webp")
  .url();
const signedUrl = await craft
  .image("https://example.com/photo.jpg")
  .resize(800)
  .format("webp")
  .signedUrl(process.env.SIGNING_SECRET!, { expiresInSeconds: 3600 });
```

The Python package is `pip install image-craft-client` and provides the same builder and signed URL flow. The CLI accepts `image-craft transform photo.jpg --resize 800 --format webp`. React users can import `<CraftImage />` from `image-craft-client/react` to create width-based responsive URLs. See [`examples/`](examples/) for Next.js, Express, plain HTML, and the interactive [playground](examples/playground/README.md).

Remote images must resolve to public IP addresses. See [Security](#security) before exposing the API to untrusted clients.

Remote transform cache keys combine the normalized source URL, canonical operation chain, and output format. Concurrent identical misses share one fetch and transform. Responses include `X-Cache: HIT|MISS`, a content-based `ETag`, and `Cache-Control`.

Send the ETag from the first response in `If-None-Match` to get `304 Not Modified` when the cached image is unchanged:

```sh
curl -i -H 'If-None-Match: "<etag-from-first-response>"' \
  'http://localhost:3000/v1/img/w_400,f_webp/https://example.com/photo.jpg'
```

### Sign transform URLs

Set the same `SIGNING_SECRET` on the service and when creating a signature. The helper accepts a complete `/v1/img/:ops/*src` URL; `--expires-in` adds an optional expiry in seconds.

```sh
export SIGNING_SECRET='replace-with-a-long-random-secret'
npm run sign -- 'http://localhost:3000/v1/img/w_400,f_webp/https://example.com/photo.jpg' --expires-in 3600
```

The command prints the signed URL with `sig` and `expires` query parameters. Use that URL as usual; altered operations, source URLs, or expired signatures are rejected with `403`.

## Benchmarks

We profile the engine and publish reproducible k6 comparisons. Results and all raw summary files are in [docs/benchmarks.md](docs/benchmarks.md). In the recorded two-CPU HTTP run, image-craft-service was slower than imgproxy and Thumbor for resize, WebP, and AVIF; the local engine profile does not represent remote-fetch endpoint throughput.

## How it compares

These projects overlap, but have different runtimes and feature sets. This table describes their published focus; it is not a performance or feature-parity claim.

| Project                                       | Runtime and interface                                      | Published focus                                                                 |
| --------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------- |
| **image-craft-service**                       | Node.js / TypeScript; multipart uploads and URL transforms | A small self-hosted API with optional Redis batch jobs, disk cache, and plugins |
| [imgproxy](https://docs.imgproxy.net/)        | Standalone server; URL-based transforms                    | Broad image processing and optimization, including advanced formats and options |
| [Thumbor](https://github.com/thumbor/thumbor) | Python; URL-based transforms and extensions                | Extensible image service with smart cropping and feature detection              |

Choose based on your runtime, deployment model, and required transforms. This project is an early release and does not aim for feature parity with either established service.

## API at a glance

| Endpoint                    | Purpose                                                      |
| --------------------------- | ------------------------------------------------------------ |
| `POST /v1/transform`        | Upload and transform an image                                |
| `GET /v1/img/:ops/*src`     | Fetch and transform a public remote image                    |
| `GET /v1/hash/*src`         | Generate a BlurHash preview for a remote image               |
| `POST /v1/metadata`         | Read dimensions, format, and EXIF without GPS fields         |
| `POST /v1/uploads`          | Store an image for a later batch job (returns file ID)       |
| `POST /v1/batch`            | Submit URL or uploaded-file transforms when Redis is enabled |
| `GET /v1/jobs/:id`          | Poll job status, progress, and per-item errors               |
| `GET /v1/jobs/:id/download` | Stream the completed ZIP archive                             |
| `GET /health`, `GET /ready` | Liveness and readiness checks                                |
| `GET /docs`                 | OpenAPI documentation and Swagger UI                         |

The checked-in [OpenAPI document](openapi/openapi.json) is the source for generated TypeScript types and the Python route contract. Run `npm run sdk:generate` after an API schema change; CI checks that the generated files match the live Fastify specification.

The `/v1` API is stable from v1.0.0; see the [compatibility and deprecation policy](docs/api-stability.md) and [upgrade guide](docs/upgrade-v1.md). SDK publishing uses GitHub OIDC; see [SDK publishing](docs/sdk-publishing.md). Container signatures and SBOMs are attached to GitHub releases; see [licensing notes](docs/licensing.md).

For the remote transform endpoint, OpenAPI documents `sig`, `expires`, `If-None-Match`, and the `X-Cache`, `ETag`, and `Cache-Control` response headers.

Invalid operation requests return a JSON `error` and machine-readable `code`, such as `INVALID_OPERATIONS` or `OPS_CHAIN_TOO_LONG`.

For URL transforms, operation tokens include `w`, `h`, `fit`, `rot`, `blur`, `sharp`, `gray_1`, `wm`, `f`, and `q`. Multipart requests accept a JSON `ops` array. See the examples above and [Swagger UI](http://localhost:3000/docs) for request schemas.

### Batch jobs

Run Redis and the API with Docker Compose (copy `.env.example` to `.env` first, then set `QUEUE_ENABLED=true`):

```sh
cp .env.example .env
# Set QUEUE_ENABLED=true in .env
docker compose up --build
```

Submit source URLs directly, or upload images first and use their expiring IDs:

```sh
curl -X POST http://localhost:3000/v1/uploads \\
  -F 'file=@photo.jpg' -H 'X-API-Key: your-configured-key'

curl -X POST http://localhost:3000/v1/batch \\
  -H 'Content-Type: application/json' -H 'X-API-Key: your-configured-key' \\
  -d '{"sources":["https://example.com/a.jpg","file_<returned-id>"],"ops":[{"op":"resize","width":400}]}'

curl -H 'X-API-Key: your-configured-key' http://localhost:3000/v1/jobs/<job-id>
curl -L -H 'X-API-Key: your-configured-key' http://localhost:3000/v1/jobs/<job-id>/download -o results.zip
```

The default maximum is 100 sources per job. The worker processes items sequentially and persists each transformed result through the configured storage adapter; ZIP downloads stream those files to the response, so image and archive contents are not accumulated in memory. Set `API_KEYS` to comma-separated client keys to enable key authentication and per-key quotas. Configure `BATCH_CONCURRENCY_PER_API_KEY`, `BATCH_RATE_LIMIT_PER_API_KEY`, and `BATCH_RATE_WINDOW_MS` for admission limits. Job data and result files expire according to `BATCH_RESULT_TTL_SECONDS`.

### S3-compatible storage and presigned uploads

Set `STORAGE_DRIVER=s3` and configure an AWS S3, Cloudflare R2, or MinIO bucket. This single setting switches the cache, uploaded batch inputs, and batch outputs from disk to the configured object store. AWS deployments can use the SDK credential chain (for example, an IAM role); use `S3_ENDPOINT`, bucket credentials, and `S3_FORCE_PATH_STYLE=true` for R2 or MinIO. For R2, use its account endpoint and `S3_REGION=auto`.

```env
STORAGE_DRIVER=s3
S3_ENDPOINT=http://minio:9000
S3_REGION=us-east-1
S3_BUCKET=image-craft
S3_ACCESS_KEY_ID=minioadmin
S3_SECRET_ACCESS_KEY=replace-with-secret
S3_FORCE_PATH_STYLE=true
```

The disk multipart upload route stays available. With S3 selected and `QUEUE_ENABLED=true`, `POST /v1/uploads` also accepts JSON and returns a presigned `PUT` URL. Put the file with the returned headers, then pass the returned `fileId` to `/v1/batch`:

```sh
upload=$(curl -sS -X POST http://localhost:3000/v1/uploads \
  -H 'Content-Type: application/json' -H 'X-API-Key: your-key' \
  -d '{"contentType":"image/png","sizeBytes":12345}')
upload_url=$(printf '%s' "$upload" | jq -r .uploadUrl)
expires_at=$(printf '%s' "$upload" | jq -r '.headers["x-amz-meta-expiresat"]')
file_id=$(printf '%s' "$upload" | jq -r .fileId)
curl -X PUT "$upload_url" -H 'Content-Type: image/png' \
  -H "x-amz-meta-expiresat: $expires_at" --upload-file photo.png
curl -X POST http://localhost:3000/v1/batch \
  -H 'Content-Type: application/json' -H 'X-API-Key: your-key' \
  -d "{\"sources\":[\"$file_id\"],\"ops\":[{\"op\":\"resize\",\"width\":400}]}"
```

The client must be permitted by the bucket's CORS policy when uploading from a browser. S3 TTL expiry is enforced when an object is read. Add bucket lifecycle rules with retention at least as long as your maximum cache and job TTL to remove expired objects according to the provider's lifecycle schedule. The disk adapter enforces `CACHE_MAX_SIZE_BYTES`; S3 capacity is managed by the bucket and lifecycle policy.

Remote source aliases are configured as JSON in `NAMED_SOURCES`. Each alias requires an HTTP(S) `origin` and an `allowedHosts` list that includes the origin hostname. Optional `headers` can contain only `authorization`, `x-api-key`, or `x-access-token`; values are sent only to the configured origin and never forwarded to a different redirect origin.

```env
NAMED_SOURCES={"cdn":{"origin":"https://cdn.example.com/assets/","allowedHosts":["cdn.example.com"],"headers":{"authorization":"Bearer source-token"}}}
```

Use the alias in a transform URL: `/v1/img/w_400,f_webp/cdn:products/photo.jpg`. Alias paths cannot traverse above the configured origin path and still pass through the service's public-IP and redirect checks.

Run the MinIO-backed adapter tests locally with Docker Compose:

```sh
docker compose --profile s3-test run --rm s3-integration
```

Set `WEBHOOK_SIGNING_SECRET` (at least 32 characters) and pass `webhookUrl` when submitting a job to receive a completion callback. The service signs `timestamp + "." + raw JSON body` with HMAC-SHA256 in `X-Image-Craft-Timestamp` and `X-Image-Craft-Signature` headers. Callback hosts must resolve to public IPs; redirects are rejected.

Use `f_auto` to negotiate AVIF, WebP, or the original image format from the request's `Accept` header. The response includes `Vary: Accept`.

```sh
curl -H 'Accept: image/avif,image/webp,image/*' \
  'http://localhost:3000/v1/img/w_400,h_300,fit_cover,f_auto/https://example.com/photo.jpg' \
  --output photo.avif
```

Additional URL tokens include `strategy_attention` or `strategy_entropy`, `fx_0.5,fy_0.4`, `padtop_16,padleft_16,bg_%23ffffff`, `flip_1`, `flop_1`, `tint_%23ffcc00`, `bright_1.1`, `contrast_0.1`, `sat_1.2`, and `radius_24`. Image watermarks use a base64url encoded PNG with `wmimg_<data>,wmop_0.5,pos_southeast`. Unknown operation names are rejected; operation chains are capped by `MAX_OPS_CHAIN`.

Get a compact BlurHash preview for a remote image:

```sh
curl 'http://localhost:3000/v1/hash/https://example.com/photo.jpg'
```

### Optional AI plugins

Four versioned plugins are available: remove background, Real-ESRGAN upscaling, vision-generated alt text, and NSFW scoring. They are disabled by default and run through separate HTTP worker containers. The API image does not include model runtimes. Enable only the plugin you need and configure its private worker/backend URL. Worker outages return `503` for that operation; the API continues serving other requests.

```sh
docker compose --profile ai up --build
```

Analysis responses include percent-encoded `X-Image-Alt-Text` or `X-NSFW-Score`. NSFW operations can set `{"threshold":0.85,"blockAbove":true}` to reject higher scores with `422`. See [How to write a plugin](docs/plugins.md) for the worker contracts, configuration, and a working TypeScript example.

## Configuration

All settings are environment variables validated at startup. See [.env.example](.env.example) for the full list.

| Variable                                        | Default                            | Purpose                                                                |
| ----------------------------------------------- | ---------------------------------- | ---------------------------------------------------------------------- |
| `MAX_UPLOAD_BYTES`                              | `20971520`                         | Maximum input size in bytes                                            |
| `MAX_INPUT_PIXELS`                              | `40000000`                         | Decompression-bomb pixel limit                                         |
| `MAX_OUTPUT_DIMENSION`                          | `4096`                             | Maximum output width or height                                         |
| `CONCURRENCY_LIMIT`                             | `8`                                | Maximum simultaneous requests                                          |
| `REMOTE_TRANSFORM_RATE_LIMIT`                   | `60`                               | Remote transforms allowed per IP per window                            |
| `REMOTE_TRANSFORM_RATE_WINDOW_MS`               | `60000`                            | Remote transform rate-limit window in milliseconds                     |
| `IMAGE_PROCESSING_CONCURRENCY`                  | `2`                                | Concurrent image and plugin operations                                 |
| `SHARP_CONCURRENCY`                             | `2`                                | libvips worker threads per image                                       |
| `SHARP_CACHE_MEMORY_MB`                         | `32`                               | Per-process libvips operation cache memory budget                      |
| `MAX_OPS_CHAIN`                                 | `20`                               | Maximum operations accepted in one transform chain                     |
| `ALLOWED_HOSTS`                                 | unset                              | Optional comma-separated remote host allowlist                         |
| `SIGNING_SECRET`                                | unset                              | Require signed remote transform URLs                                   |
| `CACHE_MAX_SIZE_BYTES`                          | `536870912`                        | Maximum disk cache size                                                |
| `STORAGE_DRIVER`                                | `disk`                             | `disk` or S3-compatible `s3` for cache and batch object storage        |
| `S3_ENDPOINT` / `S3_REGION`                     | unset / `us-east-1`                | S3 API endpoint and signing region (`auto` for Cloudflare R2)          |
| `S3_BUCKET`                                     | unset                              | Bucket used when `STORAGE_DRIVER=s3`                                   |
| `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY`     | unset                              | Optional static credentials; AWS may use its role credential chain     |
| `S3_FORCE_PATH_STYLE`                           | `true`                             | Use path-style addressing for R2 and MinIO                             |
| `S3_PRESIGNED_UPLOAD_TTL_SECONDS`               | `900`                              | Lifetime of returned upload URLs, maximum one hour                     |
| `NAMED_SOURCES`                                 | empty                              | JSON map of source aliases, origin allowlists, and credentials         |
| `QUEUE_ENABLED` / `REDIS_URL`                   | `false` / `redis://127.0.0.1:6379` | Enable Redis-backed batch jobs                                         |
| `API_KEYS`                                      | unset                              | Semicolon-separated SHA-256 digests with optional `=scope+scope`       |
| `API_RATE_LIMIT` / `API_RATE_WINDOW_MS`         | `120` / `60000`                    | API requests allowed per client key in the time window                 |
| `CORS_ORIGINS`                                  | unset                              | Comma-separated exact browser origins; wildcard is rejected            |
| `BATCH_MAX_ITEMS`                               | `100`                              | Maximum sources in one batch                                           |
| `BATCH_CONCURRENCY_PER_API_KEY`                 | `2`                                | Active queued jobs per client key                                      |
| `BATCH_RATE_LIMIT_PER_API_KEY`                  | `10`                               | Jobs admitted per client within the rate window                        |
| `BATCH_RATE_WINDOW_MS`                          | `60000`                            | Per-key job rate window                                                |
| `BATCH_JOB_ATTEMPTS` / `BATCH_BACKOFF_DELAY_MS` | `3` / `1000`                       | Retry count and exponential backoff base                               |
| `BATCH_RESULT_TTL_SECONDS`                      | `86400`                            | Job and output retention period                                        |
| `WEBHOOK_SIGNING_SECRET`                        | unset                              | HMAC key for optional completion webhooks                              |
| `REMOVE_BACKGROUND_ENABLED`                     | `false`                            | Enable the optional rembg plugin                                       |
| `UPSCALE_ENABLED`                               | `false`                            | Enable the Real-ESRGAN worker plugin                                   |
| `AUTO_ALT_TEXT_ENABLED`                         | `false`                            | Enable vision-based alt-text generation                                |
| `NSFW_CHECK_ENABLED`                            | `false`                            | Enable NSFW scoring and optional threshold blocking                    |
| `AI_PLUGIN_TIMEOUT_MS`                          | `20000`                            | Per-plugin timeout; worker request and response bytes use upload limit |
| `REALESRGAN_BACKEND_URL`                        | unset                              | Private Real-ESRGAN HTTP inference endpoint                            |
| `VISION_MODEL_URL`                              | unset                              | Private vision endpoint implementing `POST /api/alt-text`              |
| `NSFW_MODEL_URL`                                | unset                              | Private image scoring endpoint implementing `POST /api/nsfw-check`     |
| `OTEL_ENABLED`                                  | `false`                            | Enable OpenTelemetry tracing and Fastify request spans                 |
| `OTEL_EXPORTER_OTLP_ENDPOINT`                   | `http://localhost:4318`            | OTLP/HTTP collector base URL; traces are sent to `/v1/traces`          |
| `GRAFANA_ADMIN_USER` / `GRAFANA_ADMIN_PASSWORD` | `admin` / local-only placeholder   | Local dashboard login for Compose monitoring profile                   |
| `PROMETHEUS_PORT` / `GRAFANA_PORT`              | `9090` / `3001`                    | Loopback ports for local monitoring services                           |

## Observability

`GET /metrics` exports Prometheus text format. Route labels use Fastify route templates to avoid source URLs and high-cardinality labels. The service records request counts and latency, per-operation transform duration, cache hits/misses, BullMQ waiting/active/delayed depth, in-flight transforms, and HTTP errors by stable code. Request logs keep Fastify request IDs and redact the full URL plus API-key, authorization, and cookie headers; signed query parameters therefore never appear in request logs.

Start the API, Prometheus, and Grafana locally (copy `.env.example` to `.env` first):

```sh
docker compose --profile monitoring up --build
```

Open [Grafana](http://localhost:3001) to see the provisioned **Image Craft Service** dashboard. Prometheus scrapes the API every five seconds; its UI is at [localhost:9090](http://localhost:9090). The Compose ports bind to loopback. Change `GRAFANA_ADMIN_PASSWORD` before exposing Grafana beyond the local machine, and keep `/metrics` behind trusted network access in deployed environments.

Generate local request and transform samples for the dashboard:

```sh
node scripts/observability-load-test.mjs http://127.0.0.1:3000 40
```

For traces, set `OTEL_ENABLED=true` and point `OTEL_EXPORTER_OTLP_ENDPOINT` at an OTLP/HTTP collector. Fastify creates request spans; the service adds child spans for image fetch, transform, and cache operations. Request IDs are attached to spans for log correlation. Tracing remains off unless enabled.

## Security

Remote fetches use HTTP(S), reject non-public IP ranges, pin checked DNS results, and validate every redirect target. Optional `ALLOWED_HOSTS` narrows remote sources further. Configure API keys as SHA-256 digests; raw keys are sent in the `X-API-Key` header and are not stored by the service. Records use `digest=scope+scope` and are separated by semicolons. Supported scopes are `transform`, `metadata`, `batch:read`, and `batch:write`; omit scopes to grant all four. Generate a digest with Node.js:

```sh
node -e 'console.log(require("node:crypto").createHash("sha256").update(process.argv[1]).digest("hex"))' 'replace-with-a-long-random-key'
```

Set `CORS_ORIGINS` to exact origins such as `https://app.example.com`; requests from other browser origins are rejected. Uploads are checked by file signature and bounded by byte and total decoded-pixel limits. SVG input is not accepted, and image watermark overlays require raster PNG. Keep the service behind TLS and trusted access controls; use `SIGNING_SECRET` when clients can request remote transforms. See [SECURITY.md](SECURITY.md) and the [v0.5.0 security audit](docs/security-audit.md).

## Deployment recipes

See [docs/deployment.md](docs/deployment.md) for Docker, Kubernetes/Helm, Fly.io, and Railway recipes. Use object storage for persistent cache and batch files on platforms where local filesystems are ephemeral.

The [documentation site](https://erolsenol.github.io/image-craft-service/) covers getting started, API, configuration, deployment, plugins, FAQ, and security. [API stability](docs/api-stability.md) and the [v1 upgrade guide](docs/upgrade-v1.md) describe compatibility changes.

## Roadmap

- More first-party plugins and model worker recipes
- Richer identity providers and quota policies
- More formats and animation controls
- Reproducible published benchmarks

## License

The service code is MIT licensed. Third-party packages keep their own licenses; see [Sharp/libvips notices and the dependency audit](docs/licensing.md) and [LICENSE](LICENSE).
