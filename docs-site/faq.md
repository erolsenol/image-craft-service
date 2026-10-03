# FAQ

## Does this service store uploaded images permanently?

No. The transform route returns output directly. Optional cache and batch
storage use TTLs. Disk cache has a size limit; S3 retention also needs bucket
lifecycle rules.

## Can remote transforms access private hosts?

No. Loopback, private, link-local, and metadata IP ranges are blocked, including
after DNS resolution. Redirects are revalidated. Configure an explicit host
allowlist or named source when needed.

## Is Redis required?

No. Redis is needed only when `QUEUE_ENABLED=true` for batch jobs.

## Are AI plugins included in the core image?

The core includes only lightweight HTTP adapters. Model runtimes run in
optional worker containers and are disabled by default.

## How do I report an issue?

Use the GitHub issue templates for bugs and feature requests. Send security
reports privately as described in [SECURITY.md](https://github.com/erolsenol/image-craft-service/blob/master/SECURITY.md).
