# Plugins

Plugins add optional transforms without tying the core engine to Fastify. A
plugin declares a name, version, Zod options schema, and async buffer
transform. Plugins are opt-in and isolated by a timeout; external AI workers
are separate containers.

Start with the full [plugin authoring guide](https://github.com/erolsenol/image-craft-service/blob/master/docs/plugins.md).
It includes a working example, registration, contract tests, and worker
protocol details. The optional AI profile includes background removal,
upscaling, alt-text generation, and NSFW scoring.
