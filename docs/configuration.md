# Configuration reference

All configuration is read from environment variables and validated with Zod
before the server starts. Invalid values stop startup. See
[`.env.example`](../.env.example) for a complete sample.

The PDF endpoint is disabled unless `PDF_ENABLED=true`. In Docker Compose start it
with `docker compose --profile pdf up`; `PDF_RASTERIZER_URL` selects the internal
worker address. The API and worker must use matching PDF resource-limit values.
PDF inputs and rendered PNG outputs are bounded by `MAX_UPLOAD_BYTES`.

## Runtime and limits

| Variable                        |            Default | Description                                                                                                          |
| ------------------------------- | -----------------: | -------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`                      |       `production` | `development`, `test`, or `production`                                                                               |
| `HOST` / `PORT`                 | `0.0.0.0` / `3000` | Listen address and port                                                                                              |
| `MAX_UPLOAD_BYTES`              |             20 MiB | Multipart upload limit                                                                                               |
| `MAX_INPUT_PIXELS`              |         40,000,000 | Pixel limit used to reject decompression bombs                                                                       |
| `MAX_ANIMATION_FRAMES`          |                100 | Maximum decoded frames in an animation (hard maximum: 100); cumulative frame pixels must also fit `MAX_INPUT_PIXELS` |
| `SMART_QUALITY_SSIM_THRESHOLD`  |               0.98 | SSIM target for `quality: "smart"` and `/v1/analyze` (range 0.8–0.999)                                               |
| `MAX_OUTPUT_DIMENSION`          |               4096 | Maximum output width or height                                                                                       |
| `REQUEST_TIMEOUT_MS`            |             30,000 | Fastify request timeout                                                                                              |
| `CONCURRENCY_LIMIT`             |                  8 | Maximum simultaneous HTTP requests                                                                                   |
| `IMAGE_PROCESSING_CONCURRENCY`  |                  2 | Simultaneous service-level transform jobs                                                                            |
| `SHARP_CONCURRENCY`             |                  2 | libvips worker threads per image                                                                                     |
| `SHARP_CACHE_MEMORY_MB`         |                 32 | libvips operation-cache memory budget                                                                                |
| `MAX_OPS_CHAIN`                 |                 20 | Maximum operations per request                                                                                       |
| `PDF_ENABLED`                   |            `false` | Enable `GET /v1/pdf/*src`                                                                                            |
| `PDF_MAX_DPI` / `PDF_MAX_PAGES` |           200 / 50 | Maximum DPI and PDF pages; hard DPI cap is 300                                                                       |
| `PDF_CPU_SECONDS`               |                  5 | CPU seconds permitted per Poppler process                                                                            |
| `PDF_MEMORY_MB`                 |                512 | Per-process address-space limit, also bounded by the worker container                                                |
| `PDF_MAX_PIXELS`                |         20,000,000 | Maximum rasterized pixels for one PDF page                                                                           |
| `PDF_WORKER_TIMEOUT_MS`         |             10,000 | HTTP timeout for the PDF worker                                                                                      |

## Authentication and network policy

Tenant request/byte counters are process-local and reset on restart. Keep one
service instance when enforcing hard daily quotas; API and storage keys remain
tenant-scoped regardless of the cache driver.

| Variable                                | Default      | Description                                                                                  |
| --------------------------------------- | ------------ | -------------------------------------------------------------------------------------------- |
| `API_KEYS`                              | empty        | Semicolon-separated SHA-256 digests with scopes; add `tenant:<id>` or `admin` as needed      |
| `TENANTS`                               | `{}`         | Tenant policy JSON: daily quotas, exact source allowlists, operation allowlists, and presets |
| `API_RATE_LIMIT` / `API_RATE_WINDOW_MS` | 120 / 60,000 | Per-key HTTP request quota and window                                                        |
| `CORS_ORIGINS`                          | empty        | Comma-separated exact HTTP(S) origins                                                        |
| `ALLOWED_HOSTS`                         | empty        | Optional comma-separated hostname allowlist for remote images                                |
| `NAMED_SOURCES`                         | `{}`         | JSON alias map with origins, host allowlists, and optional auth headers                      |
| `SIGNING_SECRET`                        | unset        | Active HMAC secret for signed remote transform URLs                                          |
| `SIGNING_SECRET_PREVIOUS`               | unset        | Previous HMAC secret accepted during key rotation                                            |
| `SIGNING_REQUIRED`                      | `false`      | Reject unsigned remote transform URLs                                                        |

## Cache and object storage

| Variable                                    | Default                  | Description                                                 |
| ------------------------------------------- | ------------------------ | ----------------------------------------------------------- |
| `STORAGE_DRIVER`                            | `disk`                   | `disk` or `s3` for cache and batch files                    |
| `CACHE_DIR`                                 | `/tmp/image-craft-cache` | Disk adapter path                                           |
| `CACHE_MAX_SIZE_BYTES`                      | 512 MiB                  | Disk cache maximum size                                     |
| `CACHE_MAX_AGE_SECONDS`                     | 86,400                   | Cache TTL                                                   |
| `CACHE_ENABLED`                             | `true`                   | Enable cache reads and writes                               |
| `S3_ENDPOINT`                               | unset                    | S3, R2, or MinIO endpoint override                          |
| `S3_REGION`                                 | `us-east-1`              | Bucket region (`auto` for Cloudflare R2)                    |
| `S3_BUCKET`                                 | unset                    | Bucket name; required when using S3                         |
| `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | unset                    | Optional static credentials; AWS role chain also works      |
| `S3_FORCE_PATH_STYLE`                       | `true`                   | Enable path-style access for MinIO and compatible endpoints |
| `S3_PRESIGNED_UPLOAD_TTL_SECONDS`           | 900                      | Presigned upload URL lifetime                               |

## Queue, webhooks, and AI workers

| Variable                                                          | Default                  | Description                                                                                                                        |
| ----------------------------------------------------------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| `QUEUE_ENABLED`                                                   | `false`                  | Enable Redis and BullMQ batch jobs                                                                                                 |
| `REDIS_URL`                                                       | `redis://127.0.0.1:6379` | Redis connection URL                                                                                                               |
| `BATCH_MAX_ITEMS`                                                 | 100                      | Maximum sources in a job                                                                                                           |
| `BATCH_CONCURRENCY`                                               | 1                        | Number of active batch workers                                                                                                     |
| `BATCH_CONCURRENCY_PER_API_KEY`                                   | 1                        | Active jobs per API key                                                                                                            |
| `BATCH_RATE_LIMIT_PER_API_KEY` / `BATCH_RATE_WINDOW_MS`           | 10 / 60,000              | Job submissions per key and window                                                                                                 |
| `BATCH_JOB_ATTEMPTS` / `BATCH_BACKOFF_DELAY_MS`                   | 3 / 1,000                | Retry count and initial exponential delay                                                                                          |
| `BATCH_MAX_RESULT_BYTES`                                          | 1 GiB                    | Maximum output per job                                                                                                             |
| `BATCH_RESULT_TTL_SECONDS`                                        | 86,400                   | Job and result retention                                                                                                           |
| `WEBHOOK_SIGNING_SECRET`                                          | unset                    | Optional HMAC secret for completion webhooks (minimum 32 characters)                                                               |
| `*_ENABLED`                                                       | `false`                  | Set `REMOVE_BACKGROUND_ENABLED`, `UPSCALE_ENABLED`, `AUTO_ALT_TEXT_ENABLED`, or `NSFW_CHECK_ENABLED` to enable an AI worker plugin |
| `REMBG_URL`, `UPSCALE_URL`, `AUTO_ALT_TEXT_URL`, `NSFW_CHECK_URL` | unset                    | Corresponding worker HTTP URL                                                                                                      |
| `AI_PLUGIN_TIMEOUT_MS`                                            | 30,000                   | AI worker request timeout                                                                                                          |

## Observability

| Variable                      | Default                 | Description                  |
| ----------------------------- | ----------------------- | ---------------------------- |
| `OTEL_ENABLED`                | `false`                 | Enable OpenTelemetry tracing |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://localhost:4318` | OTLP HTTP exporter endpoint  |

All secrets should come from a deployment secret manager. Do not commit real
keys, signed URLs, or worker credentials to `.env` files tracked by Git.
