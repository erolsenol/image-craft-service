# Changelog

All notable changes to this project are documented here.

## [Unreleased]

## [1.2.1] - 2026-10-06

- Treat corrupt disk-cache metadata as a cache miss instead of a server failure.
- Reject invalid and overflowing TTL values consistently across disk, memory and S3 storage before overwriting cache entries.
- Synchronize SDK package versions with the service maintenance release; API contracts are unchanged.

## [1.2.0] - 2026-10-04

### Added

- Added optional Redis-backed cross-node cache-miss locks with short renewable leases, cache rechecks, bounded wait, and fail-open behavior; added Helm HPA examples, scaling architecture guidance, and a reproducible load generator/report template for 1k/5k/10k RPS.
- Added an optional, read-only `/admin` dashboard with live cache, image request, error, queue, and tenant usage summaries. The dashboard is disabled by default and its data endpoint requires an API key with the `admin` scope.
- Added tenant-associated hashed API keys, daily request/byte quotas, source and operation allowlists, named URL presets, tenant-namespaced cache and batch storage, admin usage endpoints, and tenant-labeled Prometheus counters.
- Added smart lossy quality selection (`quality: "smart"`) with a configurable SSIM threshold, a five-encode maximum, per-source quality caching, and `POST /v1/analyze` format/size estimates.
- Added a reproducible `npm run benchmark:smart-quality` script and documented its CPU/latency trade-off.
- Add opt-in `GET /v1/pdf/*src` PDF-page rasterization through an isolated Poppler worker, with page selection, DPI/page/pixel/byte caps, CPU and memory limits, and bounded worker health checks.

- Preserve animated GIF and WebP frames through resize, convert animations to WebP, and support zero-based `?frame=n` extraction. AVIF sequences are decoded to WebP because animated AVIF encoding is unavailable in Sharp/libvips.
- Bound animation decoding with a 100-frame hard cap and the cumulative `MAX_INPUT_PIXELS` budget.

## [1.1.0] - 2026-10-03

### Added

- Added a disk-backed storage adapter with TTL, size-bounded LRU eviction, atomic writes, and restart recovery.
- Added canonical SHA-256 transform cache keys and request coalescing for concurrent identical transforms.
- Added cache hit/miss headers, ETags, conditional `304` responses, configurable cache control, and cache bypass support.
- Added path-based HMAC-SHA256 signed URLs, secret rotation, an optional signed-request requirement, and the `npm run sign` CLI.
- Updated the OpenAPI document and JavaScript/Python SDK signing contract.

### Added

- Integrated storage cache reads, writes, and single-flight transforms into remote URL and multipart transform endpoints. Upload caching is opt-in through `X-Cache-Key`.
- Added configurable cache disabling with `CACHE_ENABLED=false`, `X-Cache`, content ETags, conditional `304` responses, and `Cache-Control` headers for both transform endpoints.
- Updated the OpenAPI document and generated SDK contracts for upload cache headers and responses.
- Added path-based HMAC-SHA256 URL signatures, required-signature mode, generic invalid-signature responses, and previous-secret rotation support.

## [1.0.0] - 2026-10-03

### Added

- Declared `/v1` stable with a documented compatibility/deprecation policy and a 0.9.x upgrade guide.
- Added a VitePress documentation site and GitHub Pages deployment for setup, API, configuration, deployment, plugins, FAQ, and security guides.
- Added Changesets release PR automation and a release workflow for signed multi-architecture GHCR images with SPDX SBOM attestations.
- Added reproducible k6 comparison scripts, a local transform-engine profile, and raw three-service HTTP results. The published run shows image-craft-service slower than imgproxy and Thumbor across the tested operations and load levels.
- Added a production dependency/license inventory covering Sharp and bundled libvips terms.
- Fixed pinned HTTPS fetches for Node's multi-address DNS callback mode; the regression test covers both lookup callback shapes.

### Changed

- Removed the unnecessary full-image auto-orientation and PNG encode/decode intermediate. Sharp now applies orientation and encodes directly from its pipeline unless rounded corners require an intermediate.
- Added bounded Sharp/libvips thread and cache settings (`SHARP_CONCURRENCY=2`, `SHARP_CACHE_MEMORY_MB=32`) and a 2 GiB Compose API memory limit.
- Updated deployment examples to the v1.0.0 GHCR image.

## [0.9.0] - 2026-10-03

### Added

- OpenAPI-generated `image-craft-client` JavaScript/TypeScript SDK with fluent resize/format URLs, browser-compatible HMAC-signed URLs, and responsive React `<CraftImage />` helper.
- `image-craft transform` CLI for local uploads and format conversion.
- Python SDK source package and generated route contract from the shared OpenAPI document.
- Next.js, Express, plain HTML, and interactive upload/preview playground examples.
- CI contract checks for generated TypeScript/Python contracts and a trusted-publisher workflow for npm and PyPI releases.

## [0.8.0] - 2026-10-03

### Added

- Versioned plugin contract with Zod option validation, duplicate-safe registration, isolated timeouts, request context, and bounded input/output sizes.
- Optional HTTP workers for background removal, Real-ESRGAN upscaling, vision-based alt text, and NSFW scoring with configurable blocking thresholds.
- `ai` Docker Compose profile and plugin author guide with a working example.
- `X-Image-Alt-Text` and `X-NSFW-Score` response headers for analysis plugins; analysis outputs bypass the image cache.

## [0.7.0] - 2026-10-03

### Added

- Pluggable S3-compatible storage for transform cache and batch upload/output objects, supporting AWS credential chains and custom S3 endpoints for R2 and MinIO.
- Presigned S3 uploads through JSON `POST /v1/uploads` when the S3 storage adapter is enabled.
- Named remote source aliases with per-source hostname allowlists, credential headers, redirect credential isolation, and path traversal checks.
- MinIO integration coverage, Compose test profile, Kubernetes manifest, Helm chart skeleton, and Fly.io/Railway deployment recipes.

## [0.6.0] - 2026-10-02

### Added

- Prometheus `/metrics` for HTTP request count/latency, per-operation transform duration, cache results, queue depth, in-flight transforms, and errors by code.
- Optional OpenTelemetry Fastify request tracing and fetch, transform, and cache spans, with request ID correlation.
- Request-log redaction for full URLs and credential headers.
- Provisioned Grafana dashboard and Prometheus + Grafana Docker Compose `monitoring` profile.

## [0.5.0] - 2026-10-02

### Security

- Count all decoded image pages against the configured pixel budget and stream batch ZIP entries with one result file open at a time.
- Require digest-only API key configuration with route scopes and per-key request limits; add exact-origin CORS enforcement and browser security headers.
- Reject SVG inputs and SVG watermark payloads; text watermarks remain escaped and are served only as raster output.
- Add the v0.5.0 security audit, `npm audit` CI gate, and coordinated vulnerability disclosure process.

## [0.4.0] - 2026-10-02

### Added

- Optional Redis and BullMQ batch processing with 100-image batch limit, exponential retries, per-client concurrency and rate limits, and expiring job results.
- Multipart batch uploads, job status with item errors, and streamed ZIP downloads backed by disk storage.
- Optional HMAC-signed completion webhooks with public-address validation and redirect rejection.
- Graceful queue shutdown and Redis-backed integration coverage in CI.

## [0.3.0] - 2026-10-02

### Added

- Accept-based `f_auto` format negotiation with `Vary: Accept` and source-format fallback.
- Smart and focal-point crops, padding, flips, tint, color adjustments, image watermarks, and rounded corners.
- EXIF auto-orientation, GPS-safe metadata stripping, and remote BlurHash previews.
- Strict operation validation, configurable operation-chain limits, and machine-readable validation errors.
- Per-operation visual regression fixtures using perceptual pixel comparison.

## [0.2.0] - 2026-10-02

### Added

- Storage statistics and normalized cache keys that include the output format.
- Single-flight handling for concurrent identical remote image transforms.
- Content-based ETags, `If-None-Match` responses, and documented cache headers.
- Expiring HMAC-SHA256 path-signed transform URLs, previous-secret rotation, optional required signatures, and `npm run sign -- --ops ... --src ... [--ttl ...]`.
- Per-IP rate limiting for remote URL transforms, configurable through environment variables.

## [0.1.5] - 2026-10-02

### Changed

- Rewrite the README with a concise project overview, usage example, comparison, and roadmap.

## [0.1.4] - 2026-10-02

### Security

- Restrict remote fetches to globally routable unicast IPs, including IPv6 special-purpose range checks.
- Bound shared image-processing concurrency and aggregate batch-result memory; use a fixed ZIP download filename.
- Validate resource limits at startup and return safe image-processing errors.

## [0.1.3] - 2026-10-02

### Added

- Optional typed image plugin interface and rembg-backed background removal plugin.
- Docker Compose `plugins` profile and plugin author documentation.

## [0.1.2] - 2026-10-02

### Added

- Optional BullMQ and Redis batch jobs with progress polling and downloadable ZIP results.

## [0.1.1] - 2026-10-02

### Added

- TTL-aware disk storage behind the `Storage` interface with size-bounded LRU eviction.
- SHA-256 cache keys based on canonical source URLs and normalized operation chains.
- `X-Cache` hit/miss response headers for URL-based transforms.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-10-02

### Added

- Initial self-hosted image processing API with Sharp.
- Multipart transform and metadata endpoints, remote URL transforms, health checks, and OpenAPI UI.
- Input validation, DNS/IP SSRF defenses, configurable limits, optional signed URLs, and local response cache.
- Docker deployment, CI workflows, security policy, and contributor documentation.
