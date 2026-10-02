# image-craft-service

[![CI](https://github.com/erolsenol/image-craft-service/actions/workflows/ci.yml/badge.svg)](https://github.com/erolsenol/image-craft-service/actions/workflows/ci.yml) [![npm](https://img.shields.io/npm/v/image-craft-service)](https://www.npmjs.com/package/image-craft-service) [![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE) [![Node.js 20+](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org/)

**A self-hosted image processing API for teams that want image transforms on their own infrastructure.** Built with Node.js, Fastify, and Sharp.

## Features

- Resize, smart and focal-point crop, padding, rotate, flip/flop, tint, color adjustments, watermarks, rounded corners, blur, sharpen, grayscale, and convert to JPEG, PNG, WebP, or AVIF.
- Accept-based auto format selection (AVIF, then WebP, then source format) and BlurHash previews.
- Transform uploaded images or public remote URLs; strip metadata from output.
- Disk cache with TTL, size-bounded LRU eviction, request coalescing, and `X-Cache` / ETag headers.
- Optional Redis-backed batch jobs with streamed ZIP downloads, per-item errors, retries, and per-client limits.
- SSRF defenses, signed URLs, input and output limits, and bounded processing concurrency.
- Optional rembg background removal plugin.

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

Requires Docker. Start the API from a local checkout:

```sh
git clone https://github.com/erolsenol/image-craft-service.git
cd image-craft-service
docker build -t image-craft-service .
docker run --rm -p 3000:3000 image-craft-service
```

Open [localhost:3000/docs](http://localhost:3000/docs) for interactive API docs. For local development with Node.js 20+, use `npm ci && npm run dev`.

Transform a public image by URL:

```sh
curl -L 'http://localhost:3000/v1/img/w_400,h_300,fit_cover,f_webp/https://example.com/photo.jpg' \
  --output photo.webp
```

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

No benchmark results are published yet. Performance depends on the image, operation chain, hardware, and concurrency settings. A future benchmark will include its dataset, environment, and reproducible commands.

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

The default maximum is 100 sources per job. The worker processes items sequentially and persists each transformed result to disk; ZIP downloads pipe those files to the response, so image and archive contents are not accumulated in memory. Set `API_KEYS` to comma-separated client keys to enable key authentication and per-key quotas. Configure `BATCH_CONCURRENCY_PER_API_KEY`, `BATCH_RATE_LIMIT_PER_API_KEY`, and `BATCH_RATE_WINDOW_MS` for admission limits. Job data and result files expire according to `BATCH_RESULT_TTL_SECONDS`.

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

## Configuration

All settings are environment variables validated at startup. See [.env.example](.env.example) for the full list.

| Variable                                        | Default                            | Purpose                                                          |
| ----------------------------------------------- | ---------------------------------- | ---------------------------------------------------------------- |
| `MAX_UPLOAD_BYTES`                              | `20971520`                         | Maximum input size in bytes                                      |
| `MAX_INPUT_PIXELS`                              | `40000000`                         | Decompression-bomb pixel limit                                   |
| `MAX_OUTPUT_DIMENSION`                          | `4096`                             | Maximum output width or height                                   |
| `CONCURRENCY_LIMIT`                             | `8`                                | Maximum simultaneous requests                                    |
| `REMOTE_TRANSFORM_RATE_LIMIT`                   | `60`                               | Remote transforms allowed per IP per window                      |
| `REMOTE_TRANSFORM_RATE_WINDOW_MS`               | `60000`                            | Remote transform rate-limit window in milliseconds               |
| `IMAGE_PROCESSING_CONCURRENCY`                  | `2`                                | Concurrent image and plugin operations                           |
| `MAX_OPS_CHAIN`                                 | `20`                               | Maximum operations accepted in one transform chain               |
| `ALLOWED_HOSTS`                                 | unset                              | Optional comma-separated remote host allowlist                   |
| `SIGNING_SECRET`                                | unset                              | Require signed remote transform URLs                             |
| `CACHE_MAX_SIZE_BYTES`                          | `536870912`                        | Maximum disk cache size                                          |
| `QUEUE_ENABLED` / `REDIS_URL`                   | `false` / `redis://127.0.0.1:6379` | Enable Redis-backed batch jobs                                   |
| `API_KEYS`                                      | unset                              | Comma-separated keys for batch authentication and per-key quotas |
| `BATCH_MAX_ITEMS`                               | `100`                              | Maximum sources in one batch                                     |
| `BATCH_CONCURRENCY_PER_API_KEY`                 | `2`                                | Active queued jobs per client key                                |
| `BATCH_RATE_LIMIT_PER_API_KEY`                  | `10`                               | Jobs admitted per client within the rate window                  |
| `BATCH_RATE_WINDOW_MS`                          | `60000`                            | Per-key job rate window                                          |
| `BATCH_JOB_ATTEMPTS` / `BATCH_BACKOFF_DELAY_MS` | `3` / `1000`                       | Retry count and exponential backoff base                         |
| `BATCH_RESULT_TTL_SECONDS`                      | `86400`                            | Job and output retention period                                  |
| `WEBHOOK_SIGNING_SECRET`                        | unset                              | HMAC key for optional completion webhooks                        |
| `REMOVE_BACKGROUND_ENABLED`                     | `false`                            | Enable the optional rembg plugin                                 |

## Security

Remote fetches use HTTP(S), reject non-public IP ranges, pin checked DNS results, and validate redirect targets. Optional `ALLOWED_HOSTS` narrows remote sources further. URL transforms are rate limited per client IP; keep Fastify proxy trust disabled unless the proxy chain is configured safely. Uploads are checked by file signature and bounded by byte and pixel limits. Keep the service behind trusted access controls; use `SIGNING_SECRET` and TLS when clients can request remote transforms. See [SECURITY.md](SECURITY.md).

## Roadmap

- S3-compatible storage adapter
- Authentication and per-client quotas
- Metrics and tracing
- More formats and animation controls
- Reproducible published benchmarks

## License

MIT. See [LICENSE](LICENSE).
