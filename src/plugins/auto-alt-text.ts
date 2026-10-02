import { z } from "zod";
import type { ImagePlugin } from "./interface.js";
import { postJsonWorker, type HttpWorkerOptions } from "./http-worker.js";

const optionsSchema = z
  .object({
    language: z.string().min(2).max(16).default("en"),
    prompt: z.string().max(200).optional(),
  })
  .strict();
export function createAutoAltTextPlugin(
  worker: HttpWorkerOptions,
): ImagePlugin<typeof optionsSchema> {
  return {
    name: "auto-alt-text",
    version: "1.0.0",
    optionsSchema,
    async run(input, options, ctx) {
      const result = z
        .object({ text: z.string().min(1).max(500) })
        .safeParse(
          await postJsonWorker(
            worker,
            "/api/alt-text",
            input,
            ctx.signal,
            options,
          ),
        );
      if (!result.success) throw new Error("Invalid alt-text worker response");
      const text = result.data.text
        .replace(/[\u0000-\u001f\u007f]/gu, " ")
        .trim();
      ctx.metadata.altText = text;
      return input;
    },
  };
}
