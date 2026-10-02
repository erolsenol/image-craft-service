# Security Policy

## Supported Versions

| Version | Supported |
| ------- | --------- |
| 0.5.x   | Yes       |
| < 0.5   | No        |

## Reporting a Vulnerability

Please do not report security vulnerabilities in public issues, discussions, or pull requests. Submit a private report through **Security → Report a vulnerability** on the GitHub repository. If private vulnerability reporting is unavailable, contact the maintainers through the email listed in the repository owner's GitHub profile and ask for an encrypted disclosure channel.

Include the affected version or commit, impact, required conditions, a minimal reproduction, and any suggested mitigation. Do not include real credentials, personal data, or customer images. The maintainers will acknowledge receipt and coordinate triage, a fix, and a disclosure date with the reporter. Please allow time for a fix before publishing details. Reports are handled confidentially until coordinated disclosure.

## Deployment Notes

Run behind a TLS-terminating reverse proxy, keep the service updated, restrict remote sources with `ALLOWED_HOSTS` where practical, configure SHA-256 digests in `API_KEYS`, use `CORS_ORIGINS` for exact browser origins, set a private `SIGNING_SECRET` when signed URLs are needed, and tune upload/pixel/concurrency limits for the host. The service rejects private and link-local remote destinations to reduce SSRF risk. See [`docs/security-audit.md`](docs/security-audit.md) for the v0.5.0 review and mitigations.
