import { createHash, randomUUID } from "node:crypto";
import {
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
import type { CacheMeta, Storage } from "./types.js";

interface DiskRecord {
  meta: CacheMeta;
  dataBytes: number;
  sha256: string;
}

interface CacheEntry {
  path: string;
  sizeBytes: number;
  lastAccessedAt: number;
  expiresAt?: number;
}

interface DecodedEntry {
  data: Buffer;
  meta: CacheMeta;
}

export class DiskStorage implements Storage {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly keyLocks = new Map<string, Promise<void>>();
  private readonly ready: Promise<void>;
  private evictionTask: Promise<void> = Promise.resolve();
  private evictionError: unknown;
  private accessClock = Date.now();

  constructor(
    private readonly directory: string,
    private readonly maxBytes: number,
  ) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
      throw new Error("maxBytes must be a positive safe integer");
    }
    this.ready = this.rebuildIndex();
  }

  async get(key: string): Promise<{ data: Buffer; meta: CacheMeta } | null> {
    await this.ready;
    const hash = hashKey(key);
    return this.withKeyLock(hash, async () => {
      const entry = this.entries.get(hash);
      if (!entry) return null;

      let decoded: DecodedEntry;
      try {
        decoded = decodeFile(await readFile(entry.path));
      } catch {
        await this.removeEntry(hash, entry.path);
        return null;
      }

      if (
        decoded.meta.expiresAt !== undefined &&
        decoded.meta.expiresAt <= Date.now()
      ) {
        await this.removeEntry(hash, entry.path);
        return null;
      }

      const accessedAt = this.nextAccessTime();
      try {
        await utimes(entry.path, new Date(accessedAt), new Date(accessedAt));
      } catch (error) {
        if (isNotFound(error)) {
          this.entries.delete(hash);
          return null;
        }
        throw error;
      }
      entry.lastAccessedAt = accessedAt;
      return decoded;
    });
  }

  async set(
    key: string,
    data: Buffer,
    meta: CacheMeta,
    ttlSeconds?: number,
  ): Promise<void> {
    await this.ready;
    if (
      ttlSeconds !== undefined &&
      (!Number.isFinite(ttlSeconds) || ttlSeconds < 0)
    ) {
      throw new Error("ttlSeconds must be a non-negative number");
    }

    const hash = hashKey(key);
    await this.withKeyLock(hash, async () => {
      const expiresAt =
        ttlSeconds === undefined
          ? meta.expiresAt
          : Date.now() + ttlSeconds * 1000;
      if (expiresAt !== undefined && expiresAt <= Date.now()) {
        await this.removeEntry(hash);
        return;
      }

      const storedMeta =
        expiresAt === undefined ? { ...meta } : { ...meta, expiresAt };
      const body = Buffer.from(data);
      const record: DiskRecord = {
        meta: storedMeta,
        dataBytes: body.byteLength,
        sha256: createHash("sha256").update(body).digest("hex"),
      };
      const encoded = encodeFile(record, body);
      if (encoded.byteLength > this.maxBytes) {
        await this.removeEntry(hash);
        return;
      }

      const filePath = this.pathForHash(hash);
      const parent = join(this.directory, hash.slice(0, 2), hash.slice(2, 4));
      await mkdir(parent, { recursive: true });
      const temporaryPath = join(parent, `.${hash}.${randomUUID()}.tmp`);
      try {
        await writeFile(temporaryPath, encoded, { flag: "wx", mode: 0o600 });
        await rename(temporaryPath, filePath);
      } catch (error) {
        await unlinkIfPresent(temporaryPath);
        throw error;
      }

      const lastAccessedAt = this.nextAccessTime();
      await utimes(
        filePath,
        new Date(lastAccessedAt),
        new Date(lastAccessedAt),
      );
      this.entries.set(hash, {
        path: filePath,
        sizeBytes: encoded.byteLength,
        lastAccessedAt,
        ...(storedMeta.expiresAt === undefined
          ? {}
          : { expiresAt: storedMeta.expiresAt }),
      });
      this.scheduleEviction();
    });
  }

  async delete(key: string): Promise<void> {
    await this.ready;
    const hash = hashKey(key);
    await this.withKeyLock(hash, () => this.removeEntry(hash));
  }

  async stats(): Promise<{ items: number; bytes: number }> {
    await this.ready;
    await this.evictionTask;
    if (this.evictionError !== undefined) throw this.evictionError;
    this.removeExpiredFromIndex();
    let bytes = 0;
    for (const entry of this.entries.values()) bytes += entry.sizeBytes;
    return { items: this.entries.size, bytes };
  }

  private async rebuildIndex(): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const firstLevel = await readdir(this.directory, { withFileTypes: true });
    for (const first of firstLevel) {
      if (!first.isDirectory() || !/^[a-f0-9]{2}$/u.test(first.name)) continue;
      const firstPath = join(this.directory, first.name);
      const secondLevel = await readdir(firstPath, { withFileTypes: true });
      for (const second of secondLevel) {
        if (!second.isDirectory() || !/^[a-f0-9]{2}$/u.test(second.name))
          continue;
        const secondPath = join(firstPath, second.name);
        const files = await readdir(secondPath, { withFileTypes: true });
        for (const file of files) {
          const filePath = join(secondPath, file.name);
          if (!file.isFile() || !file.name.endsWith(".cache")) {
            if (file.isFile() && file.name.endsWith(".tmp")) {
              await unlinkIfPresent(filePath);
            }
            continue;
          }

          const hash = file.name.slice(0, -".cache".length);
          if (
            !/^[a-f0-9]{64}$/u.test(hash) ||
            hash.slice(0, 2) !== first.name ||
            hash.slice(2, 4) !== second.name
          ) {
            await unlinkIfPresent(filePath);
            continue;
          }

          try {
            const contents = await readFile(filePath);
            const decoded = decodeFile(contents);
            if (
              decoded.meta.expiresAt !== undefined &&
              decoded.meta.expiresAt <= Date.now()
            ) {
              await unlinkIfPresent(filePath);
              continue;
            }
            const fileStat = await stat(filePath);
            this.accessClock = Math.max(this.accessClock, fileStat.mtimeMs);
            this.entries.set(hash, {
              path: filePath,
              sizeBytes: fileStat.size,
              lastAccessedAt: fileStat.mtimeMs,
              ...(decoded.meta.expiresAt === undefined
                ? {}
                : { expiresAt: decoded.meta.expiresAt }),
            });
          } catch {
            await unlinkIfPresent(filePath);
          }
        }
      }
    }

    if (this.currentBytes() > this.maxBytes) this.scheduleEviction();
  }

  private scheduleEviction(): void {
    this.evictionTask = this.evictionTask
      .then(async () => {
        this.evictionError = undefined;
        await this.evictToLimit();
      })
      .catch((error: unknown) => {
        this.evictionError = error;
      });
  }

  private async evictToLimit(): Promise<void> {
    this.removeExpiredFromIndex();
    if (this.currentBytes() <= this.maxBytes) return;

    const oldestFirst = [...this.entries.entries()].sort(
      ([, left], [, right]) => left.lastAccessedAt - right.lastAccessedAt,
    );
    for (const [hash, entry] of oldestFirst) {
      if (this.currentBytes() <= this.maxBytes) break;
      await this.withKeyLock(hash, async () => {
        const current = this.entries.get(hash);
        if (
          !current ||
          current.lastAccessedAt !== entry.lastAccessedAt ||
          current.sizeBytes !== entry.sizeBytes
        ) {
          return;
        }
        await this.removeEntry(hash, current.path);
      });
    }
  }

  private async removeEntry(
    hash: string,
    expectedPath?: string,
  ): Promise<void> {
    const current = this.entries.get(hash);
    const filePath = expectedPath ?? current?.path ?? this.pathForHash(hash);
    await unlinkIfPresent(filePath);
    if (current?.path === filePath) this.entries.delete(hash);
  }

  private async withKeyLock<T>(
    hash: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.keyLocks.get(hash) ?? Promise.resolve();
    let release!: () => void;
    const lock = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.keyLocks.set(hash, lock);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.keyLocks.get(hash) === lock) this.keyLocks.delete(hash);
    }
  }

  private pathForHash(hash: string): string {
    return join(
      this.directory,
      hash.slice(0, 2),
      hash.slice(2, 4),
      `${hash}.cache`,
    );
  }

  private currentBytes(): number {
    let bytes = 0;
    for (const entry of this.entries.values()) bytes += entry.sizeBytes;
    return bytes;
  }

  private nextAccessTime(): number {
    this.accessClock = Math.max(Date.now(), this.accessClock + 1);
    return this.accessClock;
  }

  private removeExpiredFromIndex(): void {
    const now = Date.now();
    for (const [hash, entry] of this.entries) {
      if (entry.expiresAt !== undefined && entry.expiresAt <= now) {
        this.entries.delete(hash);
        void this.withKeyLock(hash, async () => {
          if (this.entries.has(hash)) return;
          await unlinkIfPresent(entry.path);
        }).catch((error: unknown) => {
          this.evictionError = error;
        });
      }
    }
  }
}

function encodeFile(record: DiskRecord, data: Buffer): Buffer {
  return Buffer.concat([Buffer.from(`${JSON.stringify(record)}\n`), data]);
}

function decodeFile(contents: Buffer): DecodedEntry {
  const separator = contents.indexOf(0x0a);
  if (separator < 0) throw new Error("Cache file header is incomplete");

  const value: unknown = JSON.parse(
    contents.subarray(0, separator).toString("utf8"),
  );
  if (typeof value !== "object" || value === null || !("meta" in value)) {
    throw new Error("Cache file header is invalid");
  }
  const record = value as Partial<DiskRecord>;
  const meta = record.meta;
  if (
    typeof meta !== "object" ||
    meta === null ||
    typeof meta.contentType !== "string" ||
    typeof meta.createdAt !== "number" ||
    !Number.isFinite(meta.createdAt) ||
    typeof meta.etag !== "string" ||
    (meta.expiresAt !== undefined &&
      (typeof meta.expiresAt !== "number" ||
        !Number.isFinite(meta.expiresAt))) ||
    !Number.isSafeInteger(record.dataBytes) ||
    (record.dataBytes as number) < 0 ||
    typeof record.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(record.sha256)
  ) {
    throw new Error("Cache file metadata is invalid");
  }

  const data = contents.subarray(separator + 1);
  if (
    data.byteLength !== record.dataBytes ||
    createHash("sha256").update(data).digest("hex") !== record.sha256
  ) {
    throw new Error("Cache file payload is corrupt");
  }
  return { data, meta: { ...meta } };
}

function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

async function unlinkIfPresent(path: string): Promise<void> {
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
