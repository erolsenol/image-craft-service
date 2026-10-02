import { z } from "zod";
import type { ImagePlugin } from "./interface.js";
import {
  postWorker,
  readWorkerBytes,
  type HttpWorkerOptions,
} from "./http-worker.js";

const optionsSchema = z
  .object({ scale: z.union([z.literal(2), z.literal(4)]).default(2) })
  .strict();
export function createUpscalePlugin(
  worker: HttpWorkerOptions,
): ImagePlugin<typeof optionsSchema> {
  return {
    name: "upscale",
    version: "1.0.0",
    optionsSchema,
    async run(input, options, ctx) {
      const form = new FormData();
      form.set("file", new Blob([new Uint8Array(input)]), "input.png");
      form.set("scale", String(options.scale));
      const response = await postWorker(
        worker,
        "/api/upscale",
        form,
        {},
        ctx.signal,
      );
      return readWorkerBytes(response, worker.maxBytes);
    },
  };
}
