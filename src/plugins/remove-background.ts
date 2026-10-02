import { z } from "zod";
import type { ImagePlugin } from "./interface.js";
import { AppError } from "../core/errors.js";

export type RemoveBackgroundOptions = Record<string, never>;

export function createRemoveBackgroundPlugin(options: {
  workerUrl: string;
  timeoutMs: number;
  maxOutputBytes: number;
}): ImagePlugin<RemoveBackgroundOptions> {
  return {
    name: "remove-background",
    schema: z.object({}).strict(),
    async run(buffer) {
      const form = new FormData();
      form.set("file", new Blob([new Uint8Array(buffer)]), "input.png");
      let response: Response;
      try {
        response = await fetch(
          `${options.workerUrl.replace(/\/+$/u, "")}/api/remove`,
          {
            method: "POST",
            body: form,
            signal: AbortSignal.timeout(options.timeoutMs),
          },
        );
      } catch {
        throw new AppError("Background removal worker is unavailable", 502);
      }
      if (!response.ok) throw new AppError("Background removal failed", 502);
      if (!response.body)
        throw new AppError(
          "Background removal returned an empty response",
          502,
        );
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let totalBytes = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        totalBytes += value.byteLength;
        if (totalBytes > options.maxOutputBytes) {
          await reader.cancel();
          throw new AppError("Plugin output exceeds size limit", 413);
        }
        chunks.push(value);
      }
      return Buffer.concat(
        chunks.map((chunk) => Buffer.from(chunk)),
        totalBytes,
      );
    },
  };
}
