# image-craft-service

[![CI](https://github.com/erolsenol/image-craft-service/actions/workflows/ci.yml/badge.svg)](https://github.com/erolsenol/image-craft-service/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE) [![Node.js 20+](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org/)

A self-hosted HTTP API for resizing, converting, and optimizing images with Sharp.

## Quick start

```sh
docker build -t image-craft-service:0.1.3 .
docker run --rm -p 3000:3000 image-craft-service:0.1.3
```

The service listens at `http://localhost:3000`; interactive API docs are at `/docs`. Remote URL transforms report `X-Cache: HIT` or `X-Cache: MISS`; disk entries expire according to `CACHE_MAX_AGE_SECONDS` and are evicted least-recently-used when the size limit is reached.
For local development, copy `.env.example` to `.env`, then run `npm ci && npm run dev`. To run the published npm package, use `npx image-craft-service@0.1.3` (Node.js 20+).

### Batch jobs (optional)

Set `QUEUE_ENABLED=true` and `REDIS_URL=redis://redis:6379` in `.env`, then start the API with Redis:

```sh
docker compose --profile queue up --build
```

Submit up to `BATCH_MAX_ITEMS` source URLs with one shared operation chain. Poll the returned `statusUrl`; it returns JSON while queued or processing, then the downloadable ZIP when complete.

```sh
curl -X POST http://localhost:3000/v1/batch \
  -H 'content-type: application/json' \
  -d '{"sources":["https://example.com/a.jpg","https://example.com/b.png"],"ops":[{"op":"resize","width":800},{"op":"format","format":"webp","quality":82}]}'

# Poll the returned URL; when complete, save its ZIP response.
curl -L http://localhost:3000/v1/jobs/JOB_ID -o images.zip
```

Remote batch sources use the same SSRF protections, host allowlist, request timeout, upload-size cap, pixel limit, and output-dimension limit as URL transforms. Redis stores job state; ZIP results use `BATCH_RESULT_TTL_SECONDS`.

### Optional plugins

The `remove-background` plugin uses a separate rembg container and is disabled by default. Set `REMOVE_BACKGROUND_ENABLED=true` in `.env`, then start the service with:

```sh
docker compose --profile plugins up --build
```

Use it in a multipart transform or batch operation chain with `{"op":"plugin","name":"remove-background","options":{}}`. The worker image and its model are downloaded separately; the model is retained in a Docker volume. See [src/plugins/README.md](src/plugins/README.md) to add plugins.

## API

Upload and transform an image with a JSON operation array in the multipart `ops` field:

```sh
curl -X POST http://localhost:3000/v1/transform \
  -F 'file=@photo.jpg' \
  -F 'ops=[{"op":"resize","width":400,"height":300,"fit":"cover"},{"op":"format","format":"webp","quality":82}]' \
  --output photo.webp
```

Fetch and transform a remote image (only public hosts are allowed):

```sh
curl -L 'http://localhost:3000/v1/img/w_400,h_300,fit_cover,f_webp/https://example.com/photo.jpg' \
  --output photo.webp
```

Inspect dimensions, format, and available EXIF fields (GPS fields are omitted):

```sh
curl -X POST http://localhost:3000/v1/metadata -F 'file=@photo.jpg'
```

Remote URL operations support `w`, `h`, `fit`, `l` (left), `t` (top), `cw`/`ch` (crop width/height), `rot`, `blur`, `sharp`, `gray_1`, `wm` (URL-encoded text), `grav`, `f`, and `q` tokens. Operations are grouped in the order their operation type first appears.

Operations are applied in order: `resize` (`width`, `height`, `fit`), `crop` (`left`, `top`, `width`, `height`), `rotate` (`angle`), `blur` (`sigma`), `sharpen` (`sigma`), `grayscale`, `watermark` (`text`, optional `gravity`), and `format` (`format`, optional `quality`). Metadata is stripped from transformed images.

## Configuration

| Variable                    | Default                  | Description                                                                      |
| --------------------------- | ------------------------ | -------------------------------------------------------------------------------- |
| `HOST`                      | `0.0.0.0`                | Bind address                                                                     |
| `PORT`                      | `3000`                   | HTTP port                                                                        |
| `MAX_UPLOAD_BYTES`          | `20971520`               | Maximum uploaded or fetched input size                                           |
| `MAX_INPUT_PIXELS`          | `40000000`               | Maximum decoded image pixels                                                     |
| `MAX_OUTPUT_DIMENSION`      | `4096`                   | Maximum output width or height                                                   |
| `REQUEST_TIMEOUT_MS`        | `30000`                  | Remote request and server request timeout                                        |
| `CONCURRENCY_LIMIT`         | `8`                      | Maximum simultaneous requests                                                    |
| `ALLOWED_HOSTS`             | empty                    | Optional comma-separated remote host allowlist                                   |
| `SIGNING_SECRET`            | unset                    | Optional secret requiring HMAC-signed remote URLs                                |
| `CACHE_DIR`                 | `/tmp/image-craft-cache` | Local disk cache directory                                                       |
| `CACHE_MAX_SIZE_BYTES`      | `536870912`              | Maximum disk cache size (512 MiB); least-recently-used entries are evicted first |
| `CACHE_MAX_AGE_SECONDS`     | `86400`                  | Disk entry TTL and browser/proxy cache lifetime                                  |
| `QUEUE_ENABLED`             | `false`                  | Enable BullMQ batch jobs backed by Redis                                         |
| `REDIS_URL`                 | `redis://127.0.0.1:6379` | Redis connection URL                                                             |
| `BATCH_MAX_ITEMS`           | `20`                     | Maximum source URLs accepted by one batch                                        |
| `BATCH_CONCURRENCY`         | `1`                      | Maximum batch jobs processed at the same time                                    |
| `BATCH_RESULT_TTL_SECONDS`  | `86400`                  | How long completed ZIP results and job records are retained                      |
| `REMOVE_BACKGROUND_ENABLED` | `false`                  | Enable the optional rembg background removal plugin                              |
| `REMBG_URL`                 | `http://rembg:7000`      | Private rembg HTTP worker URL                                                    |
| `NODE_ENV`                  | `production`             | Runtime environment                                                              |

When `SIGNING_SECRET` is set, add `?sig=<hex HMAC-SHA256>` to a URL transform request. The signature is calculated over `<ops>/<source-url>`.

## Security

Remote URLs are restricted to HTTP(S), DNS-resolved addresses are checked and pinned for the connection, and every redirect is validated again. Loopback, private, link-local, reserved, and cloud metadata ranges are blocked. Set `ALLOWED_HOSTS` to further restrict remote fetches. Uploads are sniffed by file signature, decoded pixel and byte limits are enforced, and API errors do not return stack traces or file paths. Keep `SIGNING_SECRET` private and use TLS at the reverse proxy.

## Development

```sh
npm ci
npm run lint
npm run typecheck
npm test
npm run build
```

## Roadmap

- S3-compatible cache adapter
- More compact URL operation syntax
- Per-client authentication and rate limits
- Metrics and tracing
- Additional image formats and animation controls

## License

MIT. See [LICENSE](LICENSE).
