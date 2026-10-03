# Deployment recipes

## Docker

Build and run with the disk adapter:

```sh
docker run --rm -p 3000:3000 \
  -e STORAGE_DRIVER=disk \
  -v image-cache:/var/cache/image-craft \
  ghcr.io/erolsenol/image-craft-service:1.1.0
```

To use S3-compatible storage, pass `STORAGE_DRIVER=s3`, `S3_BUCKET`, and `S3_REGION`. Set `S3_ENDPOINT`, `S3_ACCESS_KEY_ID`, and `S3_SECRET_ACCESS_KEY` for Cloudflare R2 or MinIO. AWS can use its default credential chain, including task or instance roles. `S3_FORCE_PATH_STYLE=true` is recommended for MinIO and R2.

## Kubernetes manifest

Build and push the image to your container registry, edit the image in [the manifest](../deploy/kubernetes/image-craft-service.yaml), create the referenced Secret, then apply it:

```sh
kubectl create secret generic image-craft-secrets \
  --from-literal=S3_ACCESS_KEY_ID="$S3_ACCESS_KEY_ID" \
  --from-literal=S3_SECRET_ACCESS_KEY="$S3_SECRET_ACCESS_KEY"
kubectl apply -f deploy/kubernetes/image-craft-service.yaml
```

The manifest uses an S3-compatible bucket for shared cache and batch data. For AWS on Kubernetes, replace static credential references with your workload identity mechanism. Keep `/metrics` and the object-store endpoint on private networks.

## Helm chart skeleton

The chart under [deploy/helm/image-craft-service](../deploy/helm/image-craft-service) contains a basic Deployment, Service, and configurable environment. Build and publish your image, then install with the bucket and Secret name:

```sh
helm upgrade --install image-craft ./deploy/helm/image-craft-service \
  --set image.repository=ghcr.io/erolsenol/image-craft-service \
  --set image.tag=1.1.0 \
  --set env.STORAGE_DRIVER=s3 \
  --set env.S3_BUCKET=image-craft \
  --set env.S3_REGION=us-east-1 \
  --set existingSecret=image-craft-secrets
```

The chart is a starting point. Add your ingress, TLS, service account/workload identity, resource requests, network policies, and secret-management integration before production use.

## Fly.io

Use the repository Dockerfile (`fly launch --no-deploy`, then `fly deploy`). Set the app's internal port to `3000` and configure the health check to `/ready`. For persistent cache across instances and deploys, set S3 variables as Fly secrets:

```sh
fly secrets set STORAGE_DRIVER=s3 S3_ENDPOINT=https://ACCOUNT_ID.r2.cloudflarestorage.com \
  S3_REGION=auto S3_BUCKET=image-craft S3_ACCESS_KEY_ID=... S3_SECRET_ACCESS_KEY=...
```

For disk mode, attach a Fly volume and set `CACHE_DIR` to its mount path. A local volume is instance-local and does not share cache entries across multiple Machines.

## Railway

Create a Railway service from the GitHub repository and select the Dockerfile builder. Set the service's target port to `3000` and health-check path to `/ready`. Add `STORAGE_DRIVER=s3` and the required endpoint, region, bucket, and credentials in the service variables for persistent multi-replica storage. Railway's local writable filesystem is suitable for a single ephemeral instance only.

Do not expose S3 credentials in a Docker build argument or image. Store them in the platform's runtime secret variables. Browser clients using presigned uploads require a bucket CORS rule that allows the application's origin, `PUT`, and the returned `Content-Type` and `x-amz-meta-expiresat` headers.
