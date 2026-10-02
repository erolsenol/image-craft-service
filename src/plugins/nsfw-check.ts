import { z } from "zod";
import { AppError } from "../core/errors.js";
import type { ImagePlugin } from "./interface.js";
import { postJsonWorker, type HttpWorkerOptions } from "./http-worker.js";

const optionsSchema = z
  .object({
    threshold: z.number().min(0).max(1).default(0.85),
    blockAbove: z.boolean().default(false),
  })
  .strict();
export function createNsfwCheckPlugin(
  worker: HttpWorkerOptions,
): ImagePlugin<typeof optionsSchema> {
  return {
    name: "nsfw-check",
    version: "1.0.0",
    optionsSchema,
    async run(input, options, ctx) {
      const result = z
        .object({ score: z.number().min(0).max(1) })
        .safeParse(
          await postJsonWorker(worker, "/api/nsfw-check", input, ctx.signal),
        );
      if (!result.success) throw new Error("Invalid NSFW worker response");
      ctx.metadata.nsfwScore = result.data.score;
      if (options.blockAbove && result.data.score > options.threshold)
        throw new AppError("Image blocked by content policy", 422);
      return input;
    },
  };
}
