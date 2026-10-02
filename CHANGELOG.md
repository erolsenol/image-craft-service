# Changelog

All notable changes to this project are documented here.

## [0.1.3] - 2026-10-02

### Added

- Optional typed image plugin interface and rembg-backed background removal plugin.
- Docker Compose `plugins` profile and plugin author documentation.

## [Unreleased]

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
