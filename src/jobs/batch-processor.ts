import { ZipArchive } from "archiver";
import { AppError } from "../core/errors.js";
import { runImageOperations } from "../plugins/run-operations.js";
import { createPluginRegistry } from "../plugins/registry.js";
import type { AppConfig } from "../config/index.js";
import { fetchRemoteImage } from "../security/ssrf.js";
import type { Storage } from "../storage/storage.js";
import type { BatchRequest } from "./types.js";
import { ConcurrencyLimiter } from "../security/concurrency.js";

export async function processBatch(
  input: BatchRequest,
  jobId: string,
  config: AppConfig,
  storage: Storage,
  onProgress: (progress: number) => Promise<void>,
  processingLimiter = new ConcurrencyLimiter(
    config.IMAGE_PROCESSING_CONCURRENCY,
  ),
): Promise<void> {
  const outputs: Array<{ name: string; buffer: Buffer }> = [];
  let totalOutputBytes = 0;
  const allowedHosts = config.ALLOWED_HOSTS.split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
  const plugins = createPluginRegistry(config);

  for (const [index, source] of input.sources.entries()) {
    const remote = await fetchRemoteImage(source, {
      allowedHosts,
      timeoutMs: config.REQUEST_TIMEOUT_MS,
      maxBytes: config.MAX_UPLOAD_BYTES,
    });
    const result = await runImageOperations(
      remote.body,
      input.ops,
      plugins,
      config.MAX_INPUT_PIXELS,
      config.MAX_OUTPUT_DIMENSION,
      processingLimiter,
    );
    totalOutputBytes += result.buffer.byteLength;
    if (totalOutputBytes > config.BATCH_MAX_RESULT_BYTES)
      throw new AppError("Batch output exceeds configured size limit", 413);
    outputs.push({
      name: `image-${String(index + 1).padStart(3, "0")}.${extensionFor(result.contentType)}`,
      buffer: result.buffer,
    });
    await onProgress(Math.round(((index + 1) / input.sources.length) * 100));
  }

  const zip = await createZip(outputs, config.BATCH_MAX_RESULT_BYTES);
  await storage.set(
    `batch-result:${jobId}`,
    zip,
    config.BATCH_RESULT_TTL_SECONDS,
  );
}

export async function createZip(
  files: ReadonlyArray<{ name: string; buffer: Buffer }>,
  maxBytes = 128 * 1024 * 1024,
): Promise<Buffer> {
  const archive = new ZipArchive({ zlib: { level: 6 } });
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  const completed = new Promise<Buffer>((resolve, reject) => {
    archive.on("data", (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        archive.abort();
        reject(
          new AppError("Batch archive exceeds configured size limit", 413),
        );
        return;
      }
      chunks.push(chunk);
    });
    archive.on("error", reject);
    archive.on("end", () => resolve(Buffer.concat(chunks)));
  });
  for (const file of files) archive.append(file.buffer, { name: file.name });
  const [result] = await Promise.all([completed, archive.finalize()]);
  return result;
}

function extensionFor(contentType: string): string {
  const extension = contentType.split("/")[1];
  if (!extension) throw new AppError("Unsupported output format", 500);
  return extension === "jpeg" ? "jpg" : extension;
}
