import { createHash, randomUUID } from "node:crypto";

export interface DistributedLockCommands {
  acquire(key: string, token: string, ttlMs: number): Promise<boolean>;
  extend(key: string, token: string, ttlMs: number): Promise<boolean>;
  release(key: string, token: string): Promise<void>;
}

export class DistributedCacheLock {
  constructor(
    private readonly commands: DistributedLockCommands,
    private readonly leaseMs: number,
    private readonly waitMs: number,
  ) {
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1)
      throw new Error("leaseMs must be a positive safe integer");
    if (!Number.isSafeInteger(waitMs) || waitMs < 1)
      throw new Error("waitMs must be a positive safe integer");
  }

  async run<T>(
    key: string,
    readCached: () => Promise<T | undefined>,
    operation: () => Promise<T>,
  ): Promise<T> {
    const lockKey = `image-craft:transform-lock:${createHash("sha256")
      .update(key)
      .digest("hex")}`;
    const token = randomUUID();
    const deadline = Date.now() + this.waitMs;
    let ownsLock = false;

    try {
      ownsLock = await this.commands.acquire(lockKey, token, this.leaseMs);
    } catch {
      return operation();
    }

    if (ownsLock) {
      return this.runAsOwner(lockKey, token, readCached, operation);
    }

    while (Date.now() < deadline) {
      const cached = await readCached();
      if (cached !== undefined) return cached;
      await delay(Math.min(50, Math.max(1, deadline - Date.now())));
      try {
        ownsLock = await this.commands.acquire(lockKey, token, this.leaseMs);
      } catch {
        return operation();
      }
      if (ownsLock) {
        return this.runAsOwner(lockKey, token, readCached, operation);
      }
    }

    return operation();
  }

  private async runAsOwner<T>(
    key: string,
    token: string,
    readCached: () => Promise<T | undefined>,
    operation: () => Promise<T>,
  ): Promise<T> {
    const renewal = setInterval(
      () => {
        void this.commands.extend(key, token, this.leaseMs).catch(() => false);
      },
      Math.max(100, Math.floor(this.leaseMs / 3)),
    );
    renewal.unref?.();
    try {
      const cached = await readCached();
      return cached === undefined ? await operation() : cached;
    } finally {
      clearInterval(renewal);
      await this.safeRelease(key, token);
    }
  }

  private async safeRelease(key: string, token: string): Promise<void> {
    try {
      await this.commands.release(key, token);
    } catch {
      // The lease expires automatically if Redis is unavailable during release.
    }
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
