import { randomUUID } from "node:crypto";
import { Queue, Worker } from "bullmq";
import { Redis } from "ioredis";
import type { FastifyBaseLogger } from "fastify";
import type { AppConfig } from "../config/index.js";
import type { Storage } from "../storage/storage.js";
import { processBatch } from "./batch-processor.js";
import type { BatchJobStatus, BatchQueue, BatchRequest } from "./types.js";

const queueName = "image-craft-batch";

export class BullMqBatchQueue implements BatchQueue {
  private readonly connection: Redis;
  private readonly queue: Queue<BatchRequest>;
  private readonly worker: Worker<BatchRequest>;

  constructor(config: AppConfig, storage: Storage, logger?: FastifyBaseLogger) {
    this.connection = new Redis(config.REDIS_URL, {
      maxRetriesPerRequest: null,
    });
    this.connection.on("error", (error) =>
      logger?.error({ err: error }, "Redis connection error"),
    );
    this.queue = new Queue<BatchRequest>(queueName, {
      connection: this.connection,
      defaultJobOptions: {
        attempts: 1,
        removeOnComplete: {
          age: config.BATCH_RESULT_TTL_SECONDS,
          count: 500,
        },
        removeOnFail: { age: 604_800, count: 500 },
      },
    });
    this.worker = new Worker<BatchRequest>(
      queueName,
      async (job) =>
        processBatch(job.data, job.id!, config, storage, (progress) =>
          job.updateProgress(progress),
        ),
      { connection: this.connection, concurrency: config.BATCH_CONCURRENCY },
    );
    this.worker.on("error", (error) =>
      logger?.error({ err: error }, "Batch worker error"),
    );
  }

  async enqueue(input: BatchRequest): Promise<string> {
    const id = randomUUID();
    await this.queue.add("transform", input, { jobId: id });
    return id;
  }

  async get(id: string): Promise<BatchJobStatus | undefined> {
    const job = await this.queue.getJob(id);
    if (!job) return undefined;
    const state = await job.getState();
    const supportedState = [
      "waiting",
      "delayed",
      "active",
      "completed",
      "failed",
    ].includes(state)
      ? (state as BatchJobStatus["state"])
      : "unknown";
    return {
      id,
      state: supportedState,
      progress: typeof job.progress === "number" ? job.progress : 0,
    };
  }

  async close(): Promise<void> {
    await Promise.all([this.worker.close(), this.queue.close()]);
    await this.connection.quit();
  }

  isReady(): boolean {
    return this.connection.status === "ready";
  }
}
