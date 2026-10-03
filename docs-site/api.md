# API reference

The stable API contract is available from the running service at
`/docs` (Swagger UI) and `/docs/json` (OpenAPI JSON). The checked-in source
specification is [`openapi/openapi.json`](https://github.com/erolsenol/image-craft-service/blob/master/openapi/openapi.json).

| Endpoint                    | Description                                         |
| --------------------------- | --------------------------------------------------- |
| `POST /v1/transform`        | Multipart image upload and operation chain          |
| `GET /v1/img/:ops/*src`     | URL transform with cache and conditional requests   |
| `GET /v1/hash/*src`         | BlurHash generation                                 |
| `POST /v1/metadata`         | Dimensions, format, and EXIF with GPS removed       |
| `POST /v1/uploads`          | Disk upload or S3 presigned upload                  |
| `POST /v1/batch`            | Submit URL or uploaded-file sources (Redis enabled) |
| `GET /v1/jobs/:id`          | Batch status and item errors                        |
| `GET /v1/jobs/:id/download` | Stream completed ZIP results                        |
| `GET /health`, `GET /ready` | Liveness and readiness                              |

Requests under `/v1` require an API key when keys are configured. Responses
include a request ID. URL transforms accept `If-None-Match` and return
`ETag`, `Cache-Control`, and `X-Cache` headers.

See the generated [TypeScript client](https://www.npmjs.com/package/image-craft-client)
or [Python package](https://pypi.org/project/image-craft-client/) for typed
SDKs.
