import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { utimes } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DiskStorage } from "../../src/storage/disk-storage.js";

let directory: string;
const directories: string[] = [];
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "image-craft-cache-"));
  directories.push(directory);
});
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("DiskStorage", () => {
  it("reports only unexpired entries and their size", async () => {
    const storage = new DiskStorage(directory, 1024);
    await storage.set("active", Buffer.from("image"), 60);
    await storage.set("expired", Buffer.from("old"), 0.01);
    await new Promise((resolve) => setTimeout(resolve, 30));

    await expect(storage.stats()).resolves.toEqual({
      entries: 1,
      sizeBytes: expect.any(Number),
      maxSizeBytes: 1024,
    });
  });

  it("stores entries and removes them on delete", async () => {
    const storage = new DiskStorage(directory, 1024);
    await storage.set("entry", Buffer.from("image"), 60);
    expect(await storage.get("entry")).toEqual(Buffer.from("image"));
    await storage.delete("entry");
    expect(await storage.get("entry")).toBeUndefined();
  });

  it("expires entries according to their TTL", async () => {
    const storage = new DiskStorage(directory, 1024);
    await storage.set("entry", Buffer.from("image"), 0.01);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(await storage.get("entry")).toBeUndefined();
    expect(await readdir(directory)).toEqual([]);
  });

  it("evicts the least recently used entry to stay within the byte limit", async () => {
    const storage = new DiskStorage(directory, 16_500);
    const value = Buffer.alloc(8_192, 1);
    await storage.set("old", value, 60);
    await storage.set("recent", value, 60);
    expect(await storage.get("old")).toEqual(value);
    const recentPath = join(
      directory,
      `${createHash("sha256").update("recent").digest("hex")}.entry`,
    );
    const oldDate = new Date("2000-01-01T00:00:00.000Z");
    await utimes(recentPath, oldDate, oldDate);
    await storage.set("new", value, 60);

    expect(await storage.get("old")).toEqual(value);
    expect(await storage.get("recent")).toBeUndefined();
    expect(await storage.get("new")).toEqual(value);
    const sizes = await Promise.all(
      (await readdir(directory)).map(
        async (name) => (await stat(join(directory, name))).size,
      ),
    );
    expect(sizes.reduce((total, size) => total + size, 0)).toBeLessThanOrEqual(
      16_500,
    );
  });

  it("does not cache an item larger than the configured limit", async () => {
    const storage = new DiskStorage(directory, 10);
    await storage.set("large", Buffer.alloc(11), 60);
    expect(await storage.get("large")).toBeUndefined();
    expect(await readdir(directory)).toEqual([]);
  });

  it("turns traversal-like keys into hashed filenames", async () => {
    const storage = new DiskStorage(directory, 1024);
    await storage.set(
      "../../outside/../../etc/passwd",
      Buffer.from("safe"),
      60,
    );
    expect(await storage.get("../../outside/../../etc/passwd")).toEqual(
      Buffer.from("safe"),
    );
    expect(await readdir(directory)).toEqual([
      expect.stringMatching(/^[a-f0-9]{64}\.entry$/u),
    ]);
  });
});
