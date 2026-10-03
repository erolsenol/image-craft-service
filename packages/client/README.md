# image-craft-client

Typed JavaScript/TypeScript SDK and CLI for [image-craft-service](https://github.com/erolsenol/image-craft-service).

```sh
npm install image-craft-client
```

```ts
import { createCraftClient } from "image-craft-client";

const craft = createCraftClient({ baseUrl: "https://images.example.com" });
const url = craft
  .image("https://example.com/photo.jpg")
  .resize(800)
  .format("webp")
  .url();

const signedUrl = await craft
  .image("https://example.com/photo.jpg")
  .resize(800)
  .format("webp")
  .signedUrl(process.env.SIGNING_SECRET!, { expiresInSeconds: 3600 });
```

The `craft` singleton reads `IMAGE_CRAFT_URL` and defaults to localhost. `signedUrl()` uses the service's HMAC-SHA256 URL format and returns an absolute URL.

```sh
image-craft transform photo.jpg --resize 800 --format webp
```

Set `IMAGE_CRAFT_URL` and optional `IMAGE_CRAFT_API_KEY` for the CLI. Use the `/react` export for the optional `<CraftImage />` helper. React is an optional peer dependency.
