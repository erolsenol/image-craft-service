import sharp, { type Metadata } from "sharp";
import type { CoreOperation, Operation } from "../api/schemas/operations.js";
import { AppError } from "../core/errors.js";
import { transformImage, type TransformResult } from "../core/engine.js";
import { validateImage } from "../security/limits.js";
import type { ConcurrencyLimiter } from "../security/concurrency.js";
import type { PluginRegistry } from "./interface.js";

export async function runImageOperations(
  input: Buffer,
  operations: readonly Operation[],
  plugins: PluginRegistry,
  maxPixels: number,
  maxDimension: number,
  limiter?: ConcurrencyLimiter,
  accept?: string,
  observeOperation?: (operation: string, durationSeconds: number) => void,
  requestId = "unknown",
): Promise<TransformResult> {
  if (limiter)
    return limiter.run(() =>
      runImageOperationsUnbounded(
        input,
        operations,
        plugins,
        maxPixels,
        maxDimension,
        accept,
        observeOperation,
        requestId,
      ),
    );
  return runImageOperationsUnbounded(
    input,
    operations,
    plugins,
    maxPixels,
    maxDimension,
    accept,
    observeOperation,
    requestId,
  );
}

async function runImageOperationsUnbounded(
  input: Buffer,
  operations: readonly Operation[],
  plugins: PluginRegistry,
  maxPixels: number,
  maxDimension: number,
  accept?: string,
  observeOperation?: (operation: string, durationSeconds: number) => void,
  requestId = "unknown",
): Promise<TransformResult> {
  await validateImage(input, maxPixels);
  let buffer = input;
  let pluginResult: TransformResult | undefined;
  const pluginMetadata: Record<string, string | number | boolean> = {};
  let pending: CoreOperation[] = [];

  for (const operation of operations) {
    if (operation.op !== "plugin") {
      pending.push(operation);
      continue;
    }

    const plugin = plugins.get(operation.name);
    if (!plugin)
      throw new AppError(
        `Plugin "${operation.name}" is disabled or unavailable`,
        400,
      );

    if (pending.length > 0) {
      const prepared = await transformImage(
        buffer,
        [...pending, { op: "format", format: "png" }],
        maxPixels,
        maxDimension,
        undefined,
        observeOperation,
      );
      buffer = prepared.buffer;
      pending = [];
    }

    buffer = await plugin.run(buffer, operation.options, {
      requestId,
      metadata: pluginMetadata,
    });
    let contentType: string;
    let metadata: Metadata;
    try {
      contentType = await validateImage(buffer, maxPixels);
      metadata = await sharp(buffer, {
        limitInputPixels: maxPixels,
      }).metadata();
    } catch {
      throw new AppError("Plugin returned invalid image data", 503);
    }
    if (!metadata.width || !metadata.height)
      throw new AppError("Plugin returned invalid image data", 502);
    if (metadata.width > maxDimension || metadata.height > maxDimension)
      throw new AppError("Plugin output dimensions exceed limit", 413);
    pluginResult = {
      buffer,
      contentType,
      width: metadata.width,
      height: metadata.height,
      metadata: pluginMetadata,
    };
  }

  if (pending.length > 0 || !pluginResult) {
    const postPluginOperations =
      pluginResult && !pending.some((operation) => operation.op === "format")
        ? [...pending, { op: "format" as const, format: "png" as const }]
        : pending;
    const result = await transformImage(
      buffer,
      postPluginOperations,
      maxPixels,
      maxDimension,
      accept,
      observeOperation,
    );
    if (Object.keys(pluginMetadata).length > 0)
      result.metadata = pluginMetadata;
    return result;
  }
  return pluginResult;
}
