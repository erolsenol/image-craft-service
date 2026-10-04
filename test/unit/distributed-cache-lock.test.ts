import { describe, expect, it } from "vitest";
import {
  DistributedCacheLock,
  type DistributedLockCommands,
} from "../../src/core/distributed-cache-lock.js";

class SharedLocks implements DistributedLockCommands {
  private readonly locks = new Map<string, string>();

  async acquire(key: string, token: string): Promise<boolean> {
    if (this.locks.has(key)) return false;
    this.locks.set(key, token);
    return true;
  }

  async release(key: string, token: string): Promise<void> {
    if (this.locks.get(key) === token) this.locks.delete(key);
  }

  async extend(key: string, token: string): Promise<boolean> {
    return this.locks.get(key) === token;
  }
}

describe("DistributedCacheLock", () => {
  it("coalesces cache misses across lock instances", async () => {
    const redis = new SharedLocks();
    const nodeA = new DistributedCacheLock(redis, 1000, 1000);
    const nodeB = new DistributedCacheLock(redis, 1000, 1000);
    let cached: string | undefined;
    let transforms = 0;
    const operation = async () => {
      transforms += 1;
      await new Promise((resolve) => setTimeout(resolve, 80));
      cached = "finished";
      return cached;
    };
    const readCached = async () => cached;

    const values = await Promise.all([
      nodeA.run("same-transform", readCached, operation),
      nodeB.run("same-transform", readCached, operation),
    ]);

    expect(values).toEqual(["finished", "finished"]);
    expect(transforms).toBe(1);
  });

  it("fails open when Redis cannot acquire a lock", async () => {
    const unavailable: DistributedLockCommands = {
      acquire: async () => {
        throw new Error("Redis unavailable");
      },
      release: async () => undefined,
      extend: async () => false,
    };
    const lock = new DistributedCacheLock(unavailable, 100, 100);
    await expect(
      lock.run(
        "key",
        async () => undefined,
        async () => "transformed",
      ),
    ).resolves.toBe("transformed");
  });
});
