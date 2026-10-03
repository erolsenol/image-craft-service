import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryStorage } from "../../src/storage/memory.js";

const meta = {
  contentType: "image/webp",
  createdAt: 1_000,
  etag: '"abc123"',
};

afterEach(() => {
  vi.useRealTimers();
});

describe("MemoryStorage", () => {
  it("expires an item when its TTL elapses", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const storage = new MemoryStorage();

    await storage.set("image", Buffer.from("encoded"), meta, 5);
    await expect(storage.get("image")).resolves.toEqual({
      data: Buffer.from("encoded"),
      meta: {
        ...meta,
        expiresAt: Date.now() + 5_000,
      },
    });

    vi.advanceTimersByTime(5_000);

    await expect(storage.get("image")).resolves.toBeNull();
    await expect(storage.stats()).resolves.toEqual({ items: 0, bytes: 0 });
  });

  it("expires entries from metadata when no TTL argument is supplied", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const storage = new MemoryStorage();

    await storage.set("image", Buffer.from("encoded"), {
      ...meta,
      expiresAt: Date.now() + 1_000,
    });
    vi.advanceTimersByTime(1_000);

    await expect(storage.get("image")).resolves.toBeNull();
  });
});
