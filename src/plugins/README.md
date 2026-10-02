# Image plugins

Plugins run at the API orchestration boundary. The Sharp transform engine stays independent of Fastify and plugins.

## Interface

Implement `ImagePlugin<Options>` in `src/plugins`:

```ts
interface ImagePlugin<Options> {
  readonly name: string;
  readonly schema: z.ZodType<Options>;
  run(buffer: Buffer, options: Options): Promise<Buffer>;
}
```

The Zod schema validates the operation's `options` at runtime. `run` receives validated image bytes and returns image bytes. Keep the implementation independent of Fastify, enforce time and output limits for external services, and throw `AppError` with a safe client message on expected failures. The orchestration layer validates the returned image signature, pixel count, and dimensions.

## Adding a plugin

1. Add a plugin module exporting a factory that returns `ImagePlugin<Options>`.
2. Give it a stable, lowercase `name` and a strict Zod schema. Use `z.object({}).strict()` for plugins without options.
3. Register it in `src/plugins/registry.ts`. Gate optional integrations with an environment setting that defaults to disabled.
4. Add tests for option validation, successful output, upstream errors, and limits. Keep third party calls mocked in unit and integration tests.
5. Document configuration and operation JSON in the root README.

Clients invoke a plugin in the same `ops` array as core operations:

```json
[{ "op": "plugin", "name": "remove-background", "options": {} }]
```

Operation order is preserved. Before a plugin runs, preceding core operations are encoded as PNG to retain transparency. Any following core operations run against the plugin output. Unknown or disabled plugin names return a validation error.

## Built-in: remove-background

This optional plugin sends the input as multipart field `file` to the private rembg worker's `POST /api/remove` endpoint. It is disabled by default. With Docker Compose, enable it by setting `REMOVE_BACKGROUND_ENABLED=true` in `.env`, then run:

```sh
docker compose --profile plugins up --build
```

The rembg container downloads its model on first use; model files persist in the `rembg-models` volume. `REMBG_URL` defaults to `http://rembg:7000`. Keep the worker on a private Docker network and do not expose its port publicly.
