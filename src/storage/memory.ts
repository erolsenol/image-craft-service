import type { CacheMeta, Storage } from "./types.js";

interface Entry {
  data: Buffer;
  meta: CacheMeta;
}

/** In-memory storage for unit tests; production code should use a persistent adapter. */
export class MemoryStorage implements Storage {
  private readonly entries = new Map<string, Entry>();

  async get(key: string): Promise<{ data: Buffer; meta: CacheMeta } | null> {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (
      entry.meta.expiresAt !== undefined &&
      entry.meta.expiresAt <= Date.now()
    ) {
      this.entries.delete(key);
      return null;
    }

    return { data: Buffer.from(entry.data), meta: { ...entry.meta } };
  }

  async set(
    key: string,
    data: Buffer,
    meta: CacheMeta,
    ttlSeconds?: number,
  ): Promise<void> {
    if (
      ttlSeconds !== undefined &&
      (!Number.isFinite(ttlSeconds) || ttlSeconds < 0)
    ) {
      throw new Error("ttlSeconds must be a non-negative number");
    }

    const expiresAt =
      ttlSeconds === undefined
        ? meta.expiresAt
        : Date.now() + ttlSeconds * 1000;
    if (expiresAt !== undefined && expiresAt <= Date.now()) {
      this.entries.delete(key);
      return;
    }

    this.entries.set(key, {
      data: Buffer.from(data),
      meta: expiresAt === undefined ? { ...meta } : { ...meta, expiresAt },
    });
  }

  async delete(key: string): Promise<void> {
    this.entries.delete(key);
  }

  async stats(): Promise<{ items: number; bytes: number }> {
    this.removeExpiredEntries();
    let bytes = 0;
    for (const entry of this.entries.values()) bytes += entry.data.byteLength;
    return { items: this.entries.size, bytes };
  }

  private removeExpiredEntries(): void {
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (entry.meta.expiresAt !== undefined && entry.meta.expiresAt <= now) {
        this.entries.delete(key);
      }
    }
  }
}
