import { z } from "zod";
import type { ImagePlugin } from "./interface.js";
import {
  postWorker,
  readWorkerBytes,
  type HttpWorkerOptions,
} from "./http-worker.js";

const optionsSchema = z.object({}).strict();

export function createRemoveBackgroundPlugin(
  worker: HttpWorkerOptions,
): ImagePlugin<typeof optionsSchema> {
  return {
    name: "remove-background",
    version: "1.0.0",
    optionsSchema,
    async run(buffer, _options, ctx) {
      const form = new FormData();
      form.set("file", new Blob([new Uint8Array(buffer)]), "input.png");
      const response = await postWorker(
        worker,
        "/api/remove",
        form,
        {},
        ctx.signal,
      );
      return readWorkerBytes(response, worker.maxBytes);
    },
  };
}
