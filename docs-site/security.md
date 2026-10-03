# Security

The service treats uploaded and remote images as untrusted input. It applies
MIME sniffing, pixel and byte limits, DNS/redirect SSRF checks, rate and
concurrency limits, signed-URL verification, API-key scopes, and response
security headers. User SVG is rasterized before it can be returned.

Use TLS at the edge, a secret manager, explicit CORS origins, and remote host
allowlists where appropriate. Avoid public imgproxy/Thumbor unsafe modes.

Read the full [security policy](https://github.com/erolsenol/image-craft-service/blob/master/SECURITY.md)
and [security audit](https://github.com/erolsenol/image-craft-service/blob/master/docs/security-audit.md).
Please do not put API keys or signed URLs in public issues.
