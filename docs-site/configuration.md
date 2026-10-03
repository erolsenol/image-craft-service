# Configuration

Every setting is an environment variable validated before the server starts.
The complete reference, grouped by runtime limits, security, storage, queue,
plugins, and tracing, is in the repository's
[configuration guide](https://github.com/erolsenol/image-craft-service/blob/master/docs/configuration.md).

Copy `.env.example` as a starting point. Important defaults include a 20 MiB
upload limit, 40 million input pixels, 4,096 output dimensions, two concurrent
image jobs, two Sharp worker threads, and a 32 MiB libvips operation cache.
Tune concurrency against the CPU and memory limits of your container; review
the [benchmark methodology](https://github.com/erolsenol/image-craft-service/blob/master/docs/benchmarks.md)
before changing defaults.

Secrets (`API_KEYS`, signing keys, storage credentials, and worker credentials)
belong in your deployment secret manager.
