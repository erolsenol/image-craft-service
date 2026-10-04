import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  open,
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import type { Storage, StorageStats } from "./storage.js";

interface Entry {
  path: string;
  size: number;
  lastAccessedAt: number;
}

export class DiskStorage implements Storage {
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly directory: string,
    private readonly maxSizeBytes: number,
  ) {
    if (!Number.isSafeInteger(maxSizeBytes) || maxSizeBytes <= 0)
      throw new Error("maxSizeBytes must be a positive safe integer");
  }

  async get(key: string): Promise<Buffer | undefined> {
    const path = this.pathFor(key);
    let contents: Buffer;
    try {
      contents = await readFile(path);
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }

    const entry = decodeEntry(contents);
    if (!entry || entry.expiresAt <= Date.now()) {
      await this.delete(key);
      return undefined;
    }

    const now = new Date();
    try {
      await utimes(path, now, now);
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
    return entry.value;
  }

  async getStream(key: string) {
    const path = this.pathFor(key);
    let handle;
    try {
      handle = await open(path, "r");
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
    try {
      const prefix = Buffer.alloc(512);
      const { bytesRead } = await handle.read(prefix, 0, prefix.length, 0);
      const separator = prefix.subarray(0, bytesRead).indexOf(0x0a);
      if (separator < 0) {
        await this.delete(key);
        return undefined;
      }
      const metadata: unknown = JSON.parse(
        prefix.subarray(0, separator).toString("utf8"),
      );
      if (
        typeof metadata !== "object" ||
        metadata === null ||
        !("expiresAt" in metadata) ||
        typeof metadata.expiresAt !== "number" ||
        metadata.expiresAt <= Date.now()
      ) {
        await this.delete(key);
        return undefined;
      }
      const now = new Date();
      await utimes(path, now, now);
      return createReadStream(path, { start: separator + 1 });
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    } finally {
      await handle.close();
    }
  }

  async set(key: string, value: Buffer, ttlSeconds: number): Promise<void> {
    if (!Number.isFinite(ttlSeconds) || ttlSeconds < 0)
      throw new Error("ttlSeconds must be a non-negative number");
    await this.withMutation(async () => {
      const targetPath = this.pathFor(key);
      if (ttlSeconds === 0) {
        await removeIfPresent(targetPath);
        return;
      }

      const expiresAt = Date.now() + ttlSeconds * 1000;
      const fileContents = encodeEntry(value, expiresAt);
      if (fileContents.byteLength > this.maxSizeBytes) {
        await removeIfPresent(targetPath);
        return;
      }

      await mkdir(this.directory, { recursive: true });
      const temporaryPath = `${targetPath}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporaryPath, fileContents, {
          mode: 0o600,
          flag: "wx",
        });
        await rename(temporaryPath, targetPath);
      } catch (error) {
        await removeIfPresent(temporaryPath);
        throw error;
      }
      await this.evictExpiredAndOldest();
    });
  }

  async delete(key: string): Promise<void> {
    await this.withMutation(() => removeIfPresent(this.pathFor(key)));
  }

  async stats(): Promise<StorageStats> {
    let entries = 0;
    let sizeBytes = 0;
    let names: string[];
    try {
      names = await readdir(this.directory);
    } catch (error) {
      if (isNotFound(error))
        return { entries, sizeBytes, maxSizeBytes: this.maxSizeBytes };
      throw error;
    }

    for (const name of names) {
      if (!name.endsWith(".entry")) continue;
      const path = join(this.directory, name);
      try {
        const [contents, metadata] = await Promise.all([
          readFile(path),
          stat(path),
        ]);
        const entry = decodeEntry(contents);
        if (entry && entry.expiresAt > Date.now()) {
          entries += 1;
          sizeBytes += metadata.size;
        }
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
    }
    return { entries, sizeBytes, maxSizeBytes: this.maxSizeBytes };
  }

  private pathFor(key: string): string {
    const digest = createHash("sha256").update(key).digest("hex");
    return join(this.directory, `${digest}.entry`);
  }

  private async evictExpiredAndOldest(): Promise<void> {
    const names = await readdir(this.directory);
    const entries: Entry[] = [];
    let totalSize = 0;
    const now = Date.now();

    for (const name of names) {
      if (!name.endsWith(".entry")) continue;
      const path = join(this.directory, name);
      try {
        const [metadata, fileStat] = await Promise.all([
          readFile(path),
          stat(path),
        ]);
        const decoded = decodeEntry(metadata);
        if (!decoded || decoded.expiresAt <= now) {
          await removeIfPresent(path);
          continue;
        }
        entries.push({
          path,
          size: fileStat.size,
          lastAccessedAt: fileStat.mtimeMs,
        });
        totalSize += fileStat.size;
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
    }

    entries.sort((left, right) => left.lastAccessedAt - right.lastAccessedAt);
    for (const entry of entries) {
      if (totalSize <= this.maxSizeBytes) break;
      await removeIfPresent(entry.path);
      totalSize -= entry.size;
    }
  }

  private async withMutation<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.mutationQueue;
    let release!: () => void;
    this.mutationQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

function encodeEntry(value: Buffer, expiresAt: number): Buffer {
  return Buffer.concat([
    Buffer.from(`${JSON.stringify({ expiresAt })}\n`),
    value,
  ]);
}

function decodeEntry(
  contents: Buffer,
): { expiresAt: number; value: Buffer } | undefined {
  const separator = contents.indexOf(0x0a);
  if (separator < 0) return undefined;
  try {
    const metadata: unknown = JSON.parse(
      contents.subarray(0, separator).toString("utf8"),
    );
    if (
      typeof metadata !== "object" ||
      metadata === null ||
      !("expiresAt" in metadata) ||
      typeof metadata.expiresAt !== "number"
    )
      return undefined;
    return {
      expiresAt: metadata.expiresAt,
      value: contents.subarray(separator + 1),
    };
  } catch {
    return undefined;
  }
}

async function removeIfPresent(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
