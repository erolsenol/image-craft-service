import { ZipArchive } from "archiver";
import { Transform, PassThrough } from "node:stream";
import type { Readable } from "node:stream";
import { AppError } from "../core/errors.js";
import { runImageOperations } from "../plugins/run-operations.js";
import { createPluginRegistry } from "../plugins/registry.js";
import type { AppConfig } from "../config/index.js";
import { fetchRemoteImage } from "../security/ssrf.js";
import type { Storage } from "../storage/storage.js";
import type {
  BatchJobResult,
  BatchProgress,
  BatchRequest,
  BatchResultFile,
} from "./types.js";
import { ConcurrencyLimiter } from "../security/concurrency.js";
import { validateImage } from "../security/limits.js";

export async function processBatch(
  input: BatchRequest,
  jobId: string,
  config: AppConfig,
  storage: Storage,
  onProgress: (progress: BatchProgress) => Promise<void>,
  processingLimiter = new ConcurrencyLimiter(
    config.IMAGE_PROCESSING_CONCURRENCY,
  ),
): Promise<BatchJobResult> {
  const files: BatchResultFile[] = [];
  const errors: BatchJobResult["errors"] = [];
  const plugins = createPluginRegistry(config);
  const allowedHosts = config.ALLOWED_HOSTS.split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
  let totalOutputBytes = 0;
  let completedItems = 0;

  for (const [index, source] of input.sources.entries()) {
    try {
      const sourceBuffer = source.startsWith("file_")
        ? await loadOwnedUpload(storage, source, input.apiKeyId)
        : (
            await fetchRemoteImage(source, {
              allowedHosts,
              timeoutMs: config.REQUEST_TIMEOUT_MS,
              maxBytes: config.MAX_UPLOAD_BYTES,
            })
          ).body;
      if (!sourceBuffer) throw new AppError("Uploaded source has expired", 404);
      await validateImage(sourceBuffer, config.MAX_INPUT_PIXELS);
      const result = await runImageOperations(
        sourceBuffer,
        input.ops,
        plugins,
        config.MAX_INPUT_PIXELS,
        config.MAX_OUTPUT_DIMENSION,
        processingLimiter,
      );
      if (
        totalOutputBytes + result.buffer.byteLength >
        config.BATCH_MAX_RESULT_BYTES
      )
        throw new AppError("Batch output exceeds configured size limit", 413);
      totalOutputBytes += result.buffer.byteLength;
      const name = `image-${String(index + 1).padStart(3, "0")}.${extensionFor(result.contentType)}`;
      const storageKey = `batch-result:${jobId}:${index}`;
      await storage.set(
        storageKey,
        result.buffer,
        config.BATCH_RESULT_TTL_SECONDS,
      );
      files.push({ storageKey, name });
    } catch {
      errors.push({
        index,
        code: "ITEM_PROCESSING_FAILED",
        message: "This image could not be processed.",
      });
    }
    completedItems += 1;
    await onProgress({
      percentage: Math.round((completedItems / input.sources.length) * 100),
      completedItems,
      totalItems: input.sources.length,
      errors: [...errors],
    });
  }

  return {
    files,
    errors,
    completedItems,
    totalItems: input.sources.length,
  };
}

async function loadOwnedUpload(
  storage: Storage,
  fileId: string,
  apiKeyId: string,
): Promise<Buffer | undefined> {
  const [owner, image] = await Promise.all([
    storage.get(`batch-upload-owner:${fileId}`),
    storage.get(`batch-upload:${fileId}`),
  ]);
  if (!owner || owner.toString("utf8") !== apiKeyId) return undefined;
  return image;
}

export function createZipStream(
  files: ReadonlyArray<{
    name: string;
    open: () => Promise<Readable | undefined>;
  }>,
  errors: unknown,
  maxBytes: number,
): Readable {
  const archive = new ZipArchive({ zlib: { level: 6 } });
  const output = new PassThrough();
  let totalBytes = 0;
  const outputLimit = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        callback(
          new AppError("Batch archive exceeds configured size limit", 413),
        );
        return;
      }
      callback(null, chunk);
    },
  });
  archive.on("error", (error: Error) => output.destroy(error));
  outputLimit.on("error", (error: Error) => {
    archive.abort();
    output.destroy(error);
  });
  archive.pipe(outputLimit).pipe(output);
  let nextFile = 0;
  let errorsAdded = false;
  let finalized = false;
  const appendNext = async () => {
    try {
      if (nextFile < files.length) {
        const file = files[nextFile++];
        const stream = await file!.open();
        if (!stream) throw new AppError("Batch result has expired", 410);
        stream.once("error", (error) => {
          archive.abort();
          output.destroy(error);
        });
        archive.append(stream, { name: file!.name });
        return;
      }
      if (!errorsAdded) {
        errorsAdded = true;
        archive.append(JSON.stringify(errors, null, 2), {
          name: "errors.json",
        });
        return;
      }
      if (finalized) return;
      finalized = true;
      await archive.finalize();
    } catch (error) {
      archive.abort();
      output.destroy(error instanceof Error ? error : new Error("ZIP failed"));
    }
  };
  archive.on("entry", () => void appendNext());
  void appendNext();
  return output;
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
