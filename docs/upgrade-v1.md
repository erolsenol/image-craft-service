# Upgrade guide: 0.9.x to 1.0.0

v1.0.0 stabilizes the existing `/v1` API and adds tuned Sharp resource
defaults. The request and response shapes are unchanged.

## Before upgrading

- Review [API stability](api-stability.md) and the complete
  [configuration reference](configuration.md).
- Back up the cache directory if it contains useful local cache entries. Cache
  contents are disposable, but a disk cache can be rebuilt after upgrade.
- Keep `QUEUE_ENABLED`, `STORAGE_DRIVER`, `API_KEYS`, and signing secrets
  unchanged when preserving the same deployment behavior.
- If you use a custom container build, pull `ghcr.io/erolsenol/image-craft-service:1.0.0`
  for your architecture or use the multi-architecture `latest` tag.

## Install and deploy

The service image is multi-architecture (`linux/amd64` and `linux/arm64`). SDK
users should pin compatible major versions:

```sh
npm install image-craft-client@^1
python -m pip install 'image-craft-client>=1,<2'
```

For Docker Compose, pull and recreate the service after reviewing environment
changes:

```sh
docker compose pull api
docker compose up -d --remove-orphans
```

`SHARP_CONCURRENCY=2` and `SHARP_CACHE_MEMORY_MB=32` are safe conservative
defaults for the included container. Adjust them only after measuring under
your CPU and memory limits. `IMAGE_PROCESSING_CONCURRENCY` remains the upper
bound for simultaneous service transform jobs.

## Verify

```sh
curl -fsS http://localhost:3000/health
curl -fsS http://localhost:3000/ready
curl -fsS http://localhost:3000/docs
```

Call the transforms you rely on with a known image and compare content type,
dimensions, and output appearance. The v1 OpenAPI contract is published at
`/docs/json` and versioned in `openapi/openapi.json`.

For future versions, see the [deprecation policy](api-stability.md).
