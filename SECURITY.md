# Security Policy

## Supported Versions

| Version | Supported |
| ------- | --------- |
| 0.1.x   | Yes       |

## Reporting a Vulnerability

Please do not report security vulnerabilities in public issues. Use GitHub's private vulnerability reporting for this repository. Include affected version, impact, reproduction details, and any suggested mitigation. Reports will be acknowledged and triaged as soon as practical.

## Deployment Notes

Run behind a TLS-terminating reverse proxy, keep the service updated, restrict remote sources with `ALLOWED_HOSTS` where practical, set a private `SIGNING_SECRET` when signed URLs are needed, and tune upload/pixel/concurrency limits for the host. The service rejects private and link-local remote destinations to reduce SSRF risk.
