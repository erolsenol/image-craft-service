# API reference

The stable API contract is available from the running service at
`/docs` (Swagger UI) and `/docs/json` (OpenAPI JSON). The checked-in source
specification is [`openapi/openapi.json`](https://github.com/erolsenol/image-craft-service/blob/master/openapi/openapi.json).

| Endpoint                          | Description                                          |
| --------------------------------- | ---------------------------------------------------- |
| `POST /v1/transform`              | Multipart image upload and operation chain           |
| `POST /v1/analyze`                | Estimate best AVIF/WebP quality and byte savings     |
| `GET /v1/img/:ops/*src`           | URL transform with cache and conditional requests    |
| `GET /v1/pdf/*src`                | Rasterize one remote PDF page as PNG (opt-in worker) |
| `GET /v1/hash/*src`               | BlurHash generation                                  |
| `POST /v1/metadata`               | Dimensions, format, and EXIF with GPS removed        |
| `POST /v1/uploads`                | Disk upload or S3 presigned upload                   |
| `POST /v1/batch`                  | Submit URL or uploaded-file sources (Redis enabled)  |
| `GET /v1/jobs/:id`                | Batch status and item errors                         |
| `GET /v1/jobs/:id/download`       | Stream completed ZIP results                         |
| `GET /v1/admin/tenants`           | List tenant policies and current-day usage (admin)   |
| `GET /v1/admin/tenants/:tenantId` | Read one tenant policy and usage (admin)             |
| `GET /health`, `GET /ready`       | Liveness and readiness                               |

Requests under `/v1` require an API key when keys are configured. Responses
include a request ID. URL transforms accept `If-None-Match` and return
`ETag`, `Cache-Control`, and `X-Cache` headers.

Format operations may set `quality` to `"smart"`; this uses at most five
candidate encodes against the configured SSIM threshold. `POST /v1/analyze`
fetches an image and compares AVIF and WebP estimates, with up to five candidate
encodes per format. These operations use additional CPU; analysis reports
estimated rather than guaranteed perceptual quality and byte savings.

Enable PDF processing with `PDF_ENABLED=true` and start the Compose `pdf` profile.
The route defaults to page 1 and 150 DPI; `?page=2&dpi=200` selects another
one-based page and rasterization density. The configured DPI, page count, input
and output bytes, and rendered pixels are capped. The separate Poppler worker
uses process CPU/memory limits and container CPU, memory, PID, network, and
temporary-disk isolation. PDF rendering is CPU and memory intensive, especially
at larger page sizes and DPI.

See the generated [TypeScript client](https://www.npmjs.com/package/image-craft-client)
or [Python package](https://pypi.org/project/image-craft-client/) for typed
SDKs.

Tenant API keys use the `tenant:<id>` scope marker and are configured through
`TENANTS`. Tenant-scoped keys must also have ordinary API scopes such as
`transform`; admin routes additionally require `admin`. Tenant presets use
`/v1/img/p:<preset>/<source>`. See the README tenant example for the policy
shape and daily usage behavior.
