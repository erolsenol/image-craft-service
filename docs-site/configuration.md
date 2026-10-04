# Configuration

Every setting is an environment variable validated before the server starts.
The complete reference, grouped by runtime limits, security, storage, queue,
plugins, and tracing, is in the repository's
[configuration guide](https://github.com/erolsenol/image-craft-service/blob/master/docs/configuration.md).

Copy `.env.example` as a starting point. Important defaults include a 20 MiB
upload limit, 40 million input pixels, 4,096 output dimensions, two concurrent
image jobs, two Sharp worker threads, and a 32 MiB libvips operation cache.
Smart quality defaults to an SSIM threshold of `0.98`; analysis compares AVIF
and WebP and adds encode work, so it costs CPU and request latency. See the
README benchmark command for a local measurement.
Tune concurrency against the CPU and memory limits of your container; review
the [benchmark methodology](https://github.com/erolsenol/image-craft-service/blob/master/docs/benchmarks.md)
before changing defaults.

Secrets (`API_KEYS`, signing keys, storage credentials, and worker credentials)
belong in your deployment secret manager.

`TENANTS` binds key scope markers such as `tenant:acme` to daily request and
byte quotas, exact hostname/source-alias and operation allowlists, and presets.
Empty allowlists deny access; use `"*"` for an explicit wildcard. Daily quota
counters are process-local and reset on restart, so hard quotas require one
service instance. Tenant storage keys remain namespaced across instances using
the configured storage adapter.

PDF conversion is disabled by default. Enable `PDF_ENABLED` and start the
`pdf` Compose profile to use the isolated Poppler worker. `PDF_MAX_DPI`,
`PDF_MAX_PAGES`, `PDF_MAX_PIXELS`, `PDF_CPU_SECONDS`, and `PDF_MEMORY_MB` bound
work per request; PDF input and PNG output bytes use `MAX_UPLOAD_BYTES`.
