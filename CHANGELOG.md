# Changelog

All notable changes to this project are documented here.

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
- Expiring HMAC-SHA256 signed transform URLs and the `npm run sign` helper.
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
