# Writing an image plugin

Plugins run in the API orchestration layer. The core Sharp engine does not depend on Fastify, AI SDKs, or model packages. Every plugin is opt-in, versioned, validates options with Zod, and runs behind a timeout and byte limit.

## Contract

```ts
export interface ImagePlugin<Schema extends z.ZodType = z.ZodType> {
  readonly name: string;
  readonly version: string;
  readonly optionsSchema: Schema;
  run(
    input: Buffer,
    options: z.output<Schema>,
    ctx: PluginContext,
  ): Promise<Buffer>;
}

export interface PluginContext {
  readonly requestId: string;
  readonly signal: AbortSignal;
  readonly metadata: Record<string, string | number | boolean>;
}
```

`name` uses lowercase kebab-case and `version` uses semantic-version syntax. `run` receives validated options, an abort signal, and request-scoped metadata. It must return a supported raster image buffer. The orchestrator checks the returned MIME signature, pixel count, and dimensions before continuing the operation chain.

## Working example

This plugin inverts pixels and emits PNG. Add it beside the other plugin modules:

```ts
import sharp from "sharp";
import { z } from "zod";
import type { ImagePlugin } from "../plugins/interface.js";

const optionsSchema = z
  .object({ amount: z.number().min(0).max(1).default(1) })
  .strict();
type InvertPlugin = ImagePlugin<typeof optionsSchema>;

export const invertPlugin: InvertPlugin = {
  name: "invert-colors",
  version: "1.0.0",
  optionsSchema,
  async run(input, options, ctx) {
    if (ctx.signal.aborted) throw ctx.signal.reason;
    const { data, info } = await sharp(input)
      .raw()
      .toBuffer({ resolveWithObject: true });
    const channels = info.channels;
    for (let i = 0; i < data.length; i += channels) {
      for (let channel = 0; channel < Math.min(3, channels); channel++) {
        const original = data[i + channel]!;
        data[i + channel] = Math.round(
          original * (1 - options.amount) + (255 - original) * options.amount,
        );
      }
    }
    return sharp(data, { raw: info }).png().toBuffer();
  },
};
```

Register it in `src/plugins/registry.ts` only when its environment flag is true:

```ts
if (config.INVERT_COLORS_ENABLED) {
  registerPlugin(
    plugins,
    adaptPlugin(invertPlugin, {
      timeoutMs: config.AI_PLUGIN_TIMEOUT_MS,
      maxBytes: config.MAX_UPLOAD_BYTES,
    }),
  );
}
```

Add a strict Zod schema test, a success test, invalid-option coverage, a timeout test, and a mocked worker test if the plugin uses HTTP. Keep model clients and credentials outside the core process where possible.

Call the plugin as an operation in the normal chain:

```json
[{ "op": "plugin", "name": "invert-colors", "options": { "amount": 0.8 } }]
```

## Built-in AI plugins

The four built-ins are disabled by default. Enable each plugin independently with its `*_ENABLED=true` setting. Workers expose `GET /health`; inference requests are time bounded and use bounded request and response bodies. A worker outage or invalid worker response returns HTTP 503 for that request, while the API remains available for other operations.

| Plugin              | Options                                | Worker contract                                                                                                                                                            |
| ------------------- | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `remove-background` | `{}`                                   | Multipart `file` to `POST /api/remove`; returns a raster image.                                                                                                            |
| `upscale`           | `{"scale":2}` or `{"scale":4}`         | Multipart `file` and `scale` to `POST /api/upscale`; returns a raster image.                                                                                               |
| `auto-alt-text`     | `{"language":"en","prompt":"..."}`     | JSON `{image: base64, options}` to `POST /api/alt-text`; returns `{text}`. The service sends percent-encoded UTF-8 text in `X-Image-Alt-Text`.                             |
| `nsfw-check`        | `{"threshold":0.85,"blockAbove":true}` | JSON `{image: base64}` to `POST /api/nsfw-check`; returns `{score}` between 0 and 1. The score is in `X-NSFW-Score`; `blockAbove` rejects scores above threshold with 422. |

`docker compose --profile ai up --build` starts the optional HTTP adapters and the rembg model container. The adapters intentionally do not bundle model runtimes into the API image. Configure `REALESRGAN_BACKEND_URL`, `VISION_MODEL_URL`, and `NSFW_MODEL_URL` to private inference endpoints implementing the table's route contract. Vision and safety adapters also accept their corresponding `*_HEALTH_URL`; otherwise the adapter checks `<backend>/health`. Keep these backends on private networks and do not expose their ports publicly.

Set the matching `*_ENABLED=true` and `*_URL` values in the API environment to register a plugin. `AI_PLUGIN_TIMEOUT_MS` and `MAX_UPLOAD_BYTES` bound calls. Analysis plugins bypass image caching so their score/text headers cannot be lost on cache hits.

Example request:

```sh
curl -X POST http://localhost:3000/v1/transform \
  -F 'file=@photo.jpg' \
  -F 'ops=[{"op":"plugin","name":"auto-alt-text","options":{"language":"en"}}]' \
  --output captioned.png -D -
```

The returned raster is unchanged by analysis plugins; read `X-Image-Alt-Text` (percent-decode its value) or `X-NSFW-Score` from response headers.
