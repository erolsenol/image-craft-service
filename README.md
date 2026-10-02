# image-craft-service

[![CI](https://github.com/erolsenol/image-craft-service/actions/workflows/ci.yml/badge.svg)](https://github.com/erolsenol/image-craft-service/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE) [![Node.js 20+](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org/)

A self-hosted HTTP API for resizing, converting, and optimizing images with Sharp.

## Quick start

```sh
docker build -t image-craft-service:0.1.1 .
docker run --rm -p 3000:3000 image-craft-service:0.1.1
```

The service listens at `http://localhost:3000`; interactive API docs are at `/docs`. Remote URL transforms report `X-Cache: HIT` or `X-Cache: MISS`; disk entries expire according to `CACHE_MAX_AGE_SECONDS` and are evicted least-recently-used when the size limit is reached.
For local development, copy `.env.example` to `.env`, then run `npm ci && npm run dev`. To run the published npm package, use `npx image-craft-service@0.1.1` (Node.js 20+).

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

| Variable                | Default                  | Description                                                                      |
| ----------------------- | ------------------------ | -------------------------------------------------------------------------------- |
| `HOST`                  | `0.0.0.0`                | Bind address                                                                     |
| `PORT`                  | `3000`                   | HTTP port                                                                        |
| `MAX_UPLOAD_BYTES`      | `20971520`               | Maximum uploaded or fetched input size                                           |
| `MAX_INPUT_PIXELS`      | `40000000`               | Maximum decoded image pixels                                                     |
| `MAX_OUTPUT_DIMENSION`  | `4096`                   | Maximum output width or height                                                   |
| `REQUEST_TIMEOUT_MS`    | `30000`                  | Remote request and server request timeout                                        |
| `CONCURRENCY_LIMIT`     | `8`                      | Maximum simultaneous requests                                                    |
| `ALLOWED_HOSTS`         | empty                    | Optional comma-separated remote host allowlist                                   |
| `SIGNING_SECRET`        | unset                    | Optional secret requiring HMAC-signed remote URLs                                |
| `CACHE_DIR`             | `/tmp/image-craft-cache` | Local disk cache directory                                                       |
| `CACHE_MAX_SIZE_BYTES`  | `536870912`              | Maximum disk cache size (512 MiB); least-recently-used entries are evicted first |
| `CACHE_MAX_AGE_SECONDS` | `86400`                  | Disk entry TTL and browser/proxy cache lifetime                                  |
| `NODE_ENV`              | `production`             | Runtime environment                                                              |

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
