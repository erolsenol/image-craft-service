import { z } from "zod";
import { AppError } from "../core/errors.js";

export interface PluginContext {
  readonly requestId: string;
  readonly signal: AbortSignal;
  readonly metadata: Record<string, string | number | boolean>;
}

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

export interface RuntimeImagePlugin {
  readonly name: string;
  readonly version: string;
  readonly timeoutMs: number;
  readonly maxBytes: number;
  run(
    input: Buffer,
    options: unknown,
    ctx: Omit<PluginContext, "signal"> & { signal?: AbortSignal },
  ): Promise<Buffer>;
}

export type PluginRegistry = ReadonlyMap<string, RuntimeImagePlugin>;

export function adaptPlugin<Schema extends z.ZodType>(
  plugin: ImagePlugin<Schema>,
  limits: { timeoutMs: number; maxBytes: number },
): RuntimeImagePlugin {
  if (!/^[a-z][a-z0-9-]{0,63}$/u.test(plugin.name))
    throw new Error("Plugin names must be lowercase kebab-case");
  if (!/^\d+\.\d+\.\d+$/u.test(plugin.version))
    throw new Error(`Plugin "${plugin.name}" must have a semver version`);

  return {
    name: plugin.name,
    version: plugin.version,
    ...limits,
    async run(input, options, context) {
      if (input.byteLength > limits.maxBytes)
        throw new AppError("Plugin input exceeds size limit", 413);
      const parsed = plugin.optionsSchema.safeParse(options ?? {});
      if (!parsed.success)
        throw new AppError(`Invalid options for plugin "${plugin.name}"`, 400);

      const controller = new AbortController();
      const abortFromCaller = () => controller.abort(context.signal?.reason);
      context.signal?.addEventListener("abort", abortFromCaller, {
        once: true,
      });
      const timer = setTimeout(
        () => controller.abort(new Error("Plugin timed out")),
        limits.timeoutMs,
      );
      if (context.signal?.aborted) controller.abort(context.signal.reason);
      let rejectAborted!: (reason: AppError) => void;
      const abortPromise = new Promise<never>((_, reject) => {
        rejectAborted = reject;
      });
      const rejectOnAbort = () =>
        rejectAborted(new AppError(`Plugin "${plugin.name}" timed out`, 503));
      controller.signal.addEventListener("abort", rejectOnAbort, {
        once: true,
      });
      if (controller.signal.aborted) rejectOnAbort();
      try {
        const result = await Promise.race([
          plugin.run(input, parsed.data, {
            requestId: context.requestId,
            signal: controller.signal,
            metadata: context.metadata,
          }),
          abortPromise,
        ]);
        if (!Buffer.isBuffer(result))
          throw new AppError("Plugin returned invalid data", 502);
        if (result.byteLength > limits.maxBytes)
          throw new AppError("Plugin output exceeds size limit", 413);
        return result;
      } catch (error) {
        if (error instanceof AppError) throw error;
        if (controller.signal.aborted)
          throw new AppError(`Plugin "${plugin.name}" timed out`, 503);
        throw new AppError(`Plugin "${plugin.name}" is unavailable`, 503);
      } finally {
        clearTimeout(timer);
        controller.signal.removeEventListener("abort", rejectOnAbort);
        context.signal?.removeEventListener("abort", abortFromCaller);
      }
    },
  };
}

export function registerPlugin(
  registry: Map<string, RuntimeImagePlugin>,
  plugin: RuntimeImagePlugin,
): void {
  if (!/^[a-z][a-z0-9-]{0,63}$/u.test(plugin.name))
    throw new Error("Plugin names must be lowercase kebab-case");
  if (!/^\d+\.\d+\.\d+$/u.test(plugin.version))
    throw new Error(`Plugin "${plugin.name}" must have a semver version`);
  if (
    !Number.isSafeInteger(plugin.timeoutMs) ||
    plugin.timeoutMs <= 0 ||
    !Number.isSafeInteger(plugin.maxBytes) ||
    plugin.maxBytes <= 0
  )
    throw new Error("Plugin timeout and byte limits must be positive integers");
  if (registry.has(plugin.name))
    throw new Error(`Plugin "${plugin.name}" is already registered`);
  registry.set(plugin.name, plugin);
}
