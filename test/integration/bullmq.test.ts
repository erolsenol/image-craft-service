import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { config as defaults, type AppConfig } from "../../src/config/index.js";
import { BullMqBatchQueue } from "../../src/jobs/bullmq-batch-queue.js";
import { DiskStorage } from "../../src/storage/disk-storage.js";

const redisUrl = process.env.REDIS_TEST_URL;
const integration = redisUrl ? describe : describe.skip;

integration("BullMQ batch queue with Redis", () => {
  let directory: string;
  let storage: DiskStorage;
  let queue: BullMqBatchQueue | undefined;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "image-craft-bullmq-"));
    storage = new DiskStorage(directory, 2 * 1024 * 1024);
    const testConfig: AppConfig = {
      ...defaults,
      NODE_ENV: "test",
      QUEUE_ENABLED: true,
      REDIS_URL: redisUrl!,
      BATCH_RESULT_TTL_SECONDS: 60,
    };
    queue = new BullMqBatchQueue(testConfig, storage);
    await waitFor(() => queue?.isReady() ?? false);
  }, 10_000);

  afterAll(async () => {
    await queue?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it("stores a ZIP result and exposes the completed job state", async () => {
    const id = await queue!.enqueue({ sources: [], ops: [] });
    await waitFor(async () => (await queue!.get(id))?.state === "completed");
    const result = await storage.get(`batch-result:${id}`);
    expect(result?.subarray(0, 4)).toEqual(
      Buffer.from([0x50, 0x4b, 0x05, 0x06]),
    );
    expect(await queue!.get(id)).toMatchObject({
      id,
      state: "completed",
      progress: 0,
    });
  }, 10_000);
});

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
): Promise<void> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for BullMQ job state");
}
