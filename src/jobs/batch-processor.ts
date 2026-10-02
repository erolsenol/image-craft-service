import { ZipArchive } from "archiver";
import { AppError } from "../core/errors.js";
import { runImageOperations } from "../plugins/run-operations.js";
import { createPluginRegistry } from "../plugins/registry.js";
import type { AppConfig } from "../config/index.js";
import { fetchRemoteImage } from "../security/ssrf.js";
import { validateImage } from "../security/limits.js";
import type { Storage } from "../storage/storage.js";
import type { BatchRequest } from "./types.js";

export async function processBatch(
  input: BatchRequest,
  jobId: string,
  config: AppConfig,
  storage: Storage,
  onProgress: (progress: number) => Promise<void>,
): Promise<void> {
  const outputs: Array<{ name: string; buffer: Buffer }> = [];
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
    await validateImage(remote.body, config.MAX_INPUT_PIXELS);
    const result = await runImageOperations(
      remote.body,
      input.ops,
      plugins,
      config.MAX_INPUT_PIXELS,
      config.MAX_OUTPUT_DIMENSION,
    );
    outputs.push({
      name: `image-${String(index + 1).padStart(3, "0")}.${extensionFor(result.contentType)}`,
      buffer: result.buffer,
    });
    await onProgress(Math.round(((index + 1) / input.sources.length) * 100));
  }

  const zip = await createZip(outputs);
  await storage.set(
    `batch-result:${jobId}`,
    zip,
    config.BATCH_RESULT_TTL_SECONDS,
  );
}

export async function createZip(
  files: ReadonlyArray<{ name: string; buffer: Buffer }>,
): Promise<Buffer> {
  const archive = new ZipArchive({ zlib: { level: 6 } });
  const chunks: Buffer[] = [];
  const completed = new Promise<Buffer>((resolve, reject) => {
    archive.on("data", (chunk: Buffer) => chunks.push(chunk));
    archive.on("error", reject);
    archive.on("end", () => resolve(Buffer.concat(chunks)));
  });
  for (const file of files) archive.append(file.buffer, { name: file.name });
  await archive.finalize();
  return completed;
}

function extensionFor(contentType: string): string {
  const extension = contentType.split("/")[1];
  if (!extension) throw new AppError("Unsupported output format", 500);
  return extension === "jpeg" ? "jpg" : extension;
}
