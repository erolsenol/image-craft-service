# Deployment

## Docker

```sh
docker run --rm -p 3000:3000 ghcr.io/erolsenol/image-craft-service:1.0.0
```

The image supports `linux/amd64` and `linux/arm64`. Production deployments
should pin the release tag or digest, configure health checks, set an API key,
and persist the cache path when using the disk storage driver. See the
[deployment recipes](https://github.com/erolsenol/image-craft-service/blob/master/docs/deployment.md)
for Compose, Kubernetes, Helm, Fly.io, and Railway.

## Redis and S3

Redis, AI, and PDF workers are optional Compose profiles. Enable the PDF service
with `PDF_ENABLED=true docker compose --profile pdf up --build`. It runs in a
separate non-root, read-only container with no external network, resource
quotas, and a temporary filesystem. Configure an S3-compatible
bucket with `STORAGE_DRIVER=s3`; the same adapter stores the transform cache
and batch inputs/results. Use provider lifecycle rules to remove expired
objects.

## Kubernetes

The repository contains a Kubernetes manifest and Helm chart skeleton. Add a
Secret for credentials and provide Redis/S3 resources before enabling batch or
object storage features.
