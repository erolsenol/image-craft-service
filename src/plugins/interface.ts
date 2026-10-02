import { z } from "zod";
import { AppError } from "../core/errors.js";

export interface ImagePlugin<Options = unknown> {
  readonly name: string;
  readonly schema: z.ZodType<Options>;
  run(buffer: Buffer, options: Options): Promise<Buffer>;
}

export interface RuntimeImagePlugin {
  readonly name: string;
  run(buffer: Buffer, options: unknown): Promise<Buffer>;
}

export type PluginRegistry = ReadonlyMap<string, RuntimeImagePlugin>;

export function adaptPlugin<Options>(
  plugin: ImagePlugin<Options>,
): RuntimeImagePlugin {
  return {
    name: plugin.name,
    async run(buffer, options) {
      const parsed = plugin.schema.safeParse(options ?? {});
      if (!parsed.success)
        throw new AppError(`Invalid options for plugin "${plugin.name}"`, 400);
      return plugin.run(buffer, parsed.data);
    },
  };
}
