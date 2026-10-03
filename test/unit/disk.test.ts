import { createHash } from "node:crypto";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DiskStorage } from "../../src/storage/disk.js";
import type { CacheMeta } from "../../src/storage/types.js";

let directory: string;
const directories: string[] = [];

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "image-craft-disk-cache-"));
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
  it("serializes concurrent writes to the same key without partial data", async () => {
    const storage = new DiskStorage(directory, 2_000_000);
    const values = Array.from({ length: 8 }, (_, index) =>
      Buffer.alloc(32_000, index + 1),
    );

    await Promise.all(
      values.map((data, index) =>
        storage.set("shared-key", data, metadata(`etag-${index}`)),
      ),
    );

    const entry = await storage.get("shared-key");
    expect(entry).not.toBeNull();
    expect(values).toContainEqual(entry?.data);
    expect(entry?.meta.etag).toMatch(/^etag-[0-7]$/u);
    await expect(storage.stats()).resolves.toMatchObject({ items: 1 });
    expect(await listFiles(directory)).toEqual([
      expect.stringMatching(/\.cache$/u),
    ]);
  });

  it("evicts the least recently accessed entry first", async () => {
    const data = Buffer.alloc(64, 9);
    const entryBytes =
      Buffer.byteLength(
        `${JSON.stringify({ meta: metadata('"fixed"'), dataBytes: data.byteLength, sha256: "0".repeat(64) })}\n`,
      ) + data.byteLength;
    const storage = new DiskStorage(directory, entryBytes * 2);

    await storage.set("old", data, metadata('"fixed"'));
    await storage.set("recent", data, metadata('"fixed"'));
    expect(await storage.get("old")).not.toBeNull();
    await storage.set("new", data, metadata('"fixed"'));

    await expect(storage.stats()).resolves.toMatchObject({ items: 2 });
    await expect(storage.get("old")).resolves.not.toBeNull();
    await expect(storage.get("recent")).resolves.toBeNull();
    await expect(storage.get("new")).resolves.not.toBeNull();
  });

  it("rebuilds its index after restart", async () => {
    const first = new DiskStorage(directory, 1024 * 1024);
    const data = Buffer.from("recoverable image bytes");
    await first.set("recover-me", data, metadata('"recoverable"'), 60);

    const restarted = new DiskStorage(directory, 1024 * 1024);
    await expect(restarted.get("recover-me")).resolves.toEqual({
      data,
      meta: { ...metadata('"recoverable"'), expiresAt: expect.any(Number) },
    });
    await expect(restarted.stats()).resolves.toMatchObject({ items: 1 });
  });

  it("ignores and deletes truncated and corrupted cache files during recovery", async () => {
    const storage = new DiskStorage(directory, 1024 * 1024);
    await storage.set(
      "truncated",
      Buffer.from("partial payload"),
      metadata('"partial"'),
    );
    await storage.set(
      "corrupt",
      Buffer.from("corrupt payload"),
      metadata('"corrupt"'),
    );
    await storage.set(
      "valid",
      Buffer.from("valid payload"),
      metadata('"valid"'),
    );

    const truncatedPath = pathFor(directory, "truncated");
    const corruptPath = pathFor(directory, "corrupt");
    const truncatedContents = await readFile(truncatedPath);
    await writeFile(truncatedPath, truncatedContents.subarray(0, -2));
    await writeFile(corruptPath, Buffer.from("not a cache record"));

    const recovered = new DiskStorage(directory, 1024 * 1024);
    await expect(recovered.get("truncated")).resolves.toBeNull();
    await expect(recovered.get("corrupt")).resolves.toBeNull();
    await expect(recovered.get("valid")).resolves.toMatchObject({
      data: Buffer.from("valid payload"),
    });
    await expect(recovered.stats()).resolves.toMatchObject({ items: 1 });
    await expect(stat(truncatedPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(corruptPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

function metadata(etag: string): CacheMeta {
  return { contentType: "image/webp", createdAt: 1, etag };
}

function pathFor(cacheDirectory: string, key: string): string {
  const hash = createHash("sha256").update(key).digest("hex");
  return join(
    cacheDirectory,
    hash.slice(0, 2),
    hash.slice(2, 4),
    `${hash}.cache`,
  );
}

async function listFiles(path: string): Promise<string[]> {
  const children = await readdir(path, { withFileTypes: true });
  const files = await Promise.all(
    children.map((child) => {
      const childPath = join(path, child.name);
      return child.isDirectory()
        ? listFiles(childPath)
        : Promise.resolve([childPath]);
    }),
  );
  return files.flat();
}
