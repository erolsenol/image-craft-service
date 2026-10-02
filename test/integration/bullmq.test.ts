import sharp from "sharp";
import { arrayBuffer } from "node:stream/consumers";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { config as defaults, type AppConfig } from "../../src/config/index.js";
import { BullMqBatchQueue } from "../../src/jobs/bullmq-batch-queue.js";
import { DiskStorage } from "../../src/storage/disk-storage.js";
import type { BatchRequest } from "../../src/jobs/types.js";

const redisUrl = process.env.REDIS_TEST_URL;
const integration = redisUrl ? describe : describe.skip;

integration("BullMQ batch queue with Redis", () => {
  let directory: string;
  let storage: DiskStorage;
  let queue: BullMqBatchQueue | undefined;
  let testConfig: AppConfig;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "image-craft-bullmq-"));
    storage = new DiskStorage(directory, 32 * 1024 * 1024);
    testConfig = {
      ...defaults,
      NODE_ENV: "test",
      QUEUE_ENABLED: true,
      REDIS_URL: redisUrl!,
      BATCH_MAX_ITEMS: 100,
      BATCH_MAX_RESULT_BYTES: 16 * 1024 * 1024,
      BATCH_RESULT_TTL_SECONDS: 60,
      BATCH_RATE_LIMIT_PER_API_KEY: 10,
    };
    queue = new BullMqBatchQueue(testConfig, storage);
    await waitFor(() => queue?.isReady() ?? false);
  }, 10_000);

  afterAll(async () => {
    await queue?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it("processes 100 uploaded images with disk-backed results and a streamed ZIP", async () => {
    const fixture = await sharp({
      create: { width: 12, height: 8, channels: 3, background: "#336699" },
    })
      .png()
      .toBuffer();
    const fileId = "file_11111111-1111-4111-8111-111111111111";
    await storage.set(`batch-upload:${fileId}`, fixture, 60);
    await storage.set(
      `batch-upload-owner:${fileId}`,
      Buffer.from("test-api-key-hash"),
      60,
    );
    const request: BatchRequest = {
      sources: Array.from({ length: 100 }, () => fileId),
      ops: [],
      apiKeyId: "test-api-key-hash",
    };
    const jobId = await queue!.enqueue(request);
    await waitFor(
      async () =>
        (await queue!.get(jobId, request.apiKeyId))?.status === "done",
    );

    const status = await queue!.get(jobId, request.apiKeyId);
    expect(status).toMatchObject({
      jobId,
      status: "done",
      progress: 100,
      completedItems: 100,
      totalItems: 100,
      errors: [],
    });
    expect(await queue!.get(jobId, "another-key")).toBeUndefined();
    const stored = await storage.stats();
    expect(stored.entries).toBe(102);

    const archiveStream = await queue!.download(jobId, request.apiKeyId);
    expect(archiveStream).toBeDefined();
    const archive = Buffer.from(await arrayBuffer(archiveStream!));
    expect(archive.subarray(0, 4)).toEqual(
      Buffer.from([0x50, 0x4b, 0x03, 0x04]),
    );
    expect(archive.includes(Buffer.from("image-001.jpg"))).toBe(true);
    expect(archive.includes(Buffer.from("image-100.jpg"))).toBe(true);
    expect(archive.includes(Buffer.from("errors.json"))).toBe(true);
  }, 30_000);

  it("reports per-item errors without failing the rest of a batch", async () => {
    const fixture = await sharp({
      create: { width: 4, height: 4, channels: 3, background: "#fff" },
    })
      .png()
      .toBuffer();
    const availableFileId = "file_22222222-2222-4222-8222-222222222222";
    await storage.set(`batch-upload:${availableFileId}`, fixture, 60);
    await storage.set(
      `batch-upload-owner:${availableFileId}`,
      Buffer.from("test-api-key-hash-errors"),
      60,
    );
    const request: BatchRequest = {
      sources: [availableFileId, "file_33333333-3333-4333-8333-333333333333"],
      ops: [],
      apiKeyId: "test-api-key-hash-errors",
    };
    const jobId = await queue!.enqueue(request);
    await waitFor(
      async () =>
        (await queue!.get(jobId, request.apiKeyId))?.status === "done",
    );
    expect(await queue!.get(jobId, request.apiKeyId)).toMatchObject({
      status: "done",
      progress: 100,
      completedItems: 2,
      errors: [
        {
          index: 1,
          code: "ITEM_PROCESSING_FAILED",
          message: "This image could not be processed.",
        },
      ],
    });
  }, 10_000);
});

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
): Promise<void> {
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for BullMQ job state");
}
