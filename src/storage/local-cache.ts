import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import type { CacheAdapter } from "./cache.js";
export class LocalCache implements CacheAdapter {
  constructor(private readonly directory: string) {}
  private path(key: string): string {
    return join(this.directory, createHash("sha256").update(key).digest("hex"));
  }
  async get(key: string): Promise<Buffer | undefined> {
    try {
      return await readFile(this.path(key));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }
  async set(key: string, value: Buffer): Promise<void> {
    const path = this.path(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, value, { mode: 0o600 });
  }
}
