import { createHash, randomUUID } from "node:crypto";
import { Queue, Worker, type Job } from "bullmq";
import type { Readable } from "node:stream";
import { Redis } from "ioredis";
import type { FastifyBaseLogger } from "fastify";
import type { AppConfig } from "../config/index.js";
import type { Storage } from "../storage/storage.js";
import { processBatch, createZipStream } from "./batch-processor.js";
import type {
  BatchJobResult,
  BatchJobStatus,
  BatchQueue,
  BatchRequest,
} from "./types.js";
import { ConcurrencyLimiter } from "../security/concurrency.js";
import { sendSignedWebhook } from "../security/webhook.js";

const queueName = "image-craft-batch";
const admissionScript = `
local active = tonumber(redis.call('GET', KEYS[1]) or '0')
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', ARGV[1] - ARGV[2])
local rateCount = redis.call('ZCARD', KEYS[2])
if active >= tonumber(ARGV[3]) then return -1 end
if rateCount >= tonumber(ARGV[4]) then return -2 end
redis.call('INCR', KEYS[1])
redis.call('EXPIRE', KEYS[1], ARGV[5])
redis.call('ZADD', KEYS[2], ARGV[1], ARGV[6])
redis.call('PEXPIRE', KEYS[2], ARGV[2])
return 1
`;
const releaseScript = `
local reserved = redis.call('SET', KEYS[2], '1', 'NX', 'EX', ARGV[1])
if not reserved then return 0 end
local active = redis.call('DECR', KEYS[1])
if active <= 0 then redis.call('DEL', KEYS[1]) end
return active
`;

export class BatchAdmissionError extends Error {
  constructor(
    readonly code: "BATCH_API_KEY_CONCURRENCY" | "BATCH_API_KEY_RATE_LIMIT",
  ) {
    super(code);
  }
}

export class BullMqBatchQueue implements BatchQueue {
  private readonly connection: Redis;
  private readonly queue: Queue<BatchRequest, BatchJobResult>;
  private readonly worker: Worker<BatchRequest, BatchJobResult>;
  private readonly pendingFinishes = new Set<Promise<void>>();

  constructor(
    private readonly config: AppConfig,
    private readonly storage: Storage,
    private readonly logger?: FastifyBaseLogger,
    processingLimiter = new ConcurrencyLimiter(
      config.IMAGE_PROCESSING_CONCURRENCY,
    ),
  ) {
    this.connection = new Redis(config.REDIS_URL, {
      maxRetriesPerRequest: null,
    });
    this.connection.on("error", (error) =>
      logger?.error({ err: error }, "Redis connection error"),
    );
    this.queue = new Queue<BatchRequest, BatchJobResult>(queueName, {
      connection: this.connection,
      defaultJobOptions: {
        attempts: config.BATCH_JOB_ATTEMPTS,
        backoff: { type: "exponential", delay: config.BATCH_BACKOFF_DELAY_MS },
        removeOnComplete: {
          age: config.BATCH_RESULT_TTL_SECONDS,
          count: 500,
        },
        removeOnFail: { age: config.BATCH_RESULT_TTL_SECONDS, count: 500 },
      },
    });
    this.worker = new Worker<BatchRequest, BatchJobResult>(
      queueName,
      async (job) =>
        processBatch(
          job.data,
          job.id!,
          config,
          storage,
          (progress) => job.updateProgress(progress),
          processingLimiter,
        ),
      { connection: this.connection, concurrency: config.BATCH_CONCURRENCY },
    );
    this.worker.on("error", (error) =>
      logger?.error({ err: error }, "Batch worker error"),
    );
    this.worker.on("completed", (job, result) => {
      this.trackFinish(this.finishJob(job, "done", result));
    });
    this.worker.on("failed", (job) => {
      if (job) this.trackFinish(this.finishFailedJob(job));
    });
  }

  async enqueue(input: BatchRequest): Promise<string> {
    const id = randomUUID();
    const keys = this.admissionKeys(input.apiKeyId);
    const admission = Number(
      await this.connection.eval(
        admissionScript,
        2,
        keys.active,
        keys.rate,
        Date.now().toString(),
        this.config.BATCH_RATE_WINDOW_MS.toString(),
        this.config.BATCH_CONCURRENCY_PER_API_KEY.toString(),
        this.config.BATCH_RATE_LIMIT_PER_API_KEY.toString(),
        String(Math.max(this.config.BATCH_RESULT_TTL_SECONDS * 2, 300)),
        id,
      ),
    );
    if (admission === -1)
      throw new BatchAdmissionError("BATCH_API_KEY_CONCURRENCY");
    if (admission === -2)
      throw new BatchAdmissionError("BATCH_API_KEY_RATE_LIMIT");
    try {
      await this.queue.add("transform", input, { jobId: id });
      return id;
    } catch (error) {
      await this.releaseApiKeySlot(input.apiKeyId, id);
      throw error;
    }
  }

  async get(id: string, apiKeyId: string): Promise<BatchJobStatus | undefined> {
    const job = await this.queue.getJob(id);
    if (!job || job.data.apiKeyId !== apiKeyId) return undefined;
    const state = await job.getState();
    const progress = parseProgress(
      typeof job.progress === "boolean" ? String(job.progress) : job.progress,
      job.data.sources.length,
      job.returnvalue,
    );
    return {
      jobId: id,
      status:
        state === "active"
          ? "active"
          : state === "completed"
            ? "done"
            : state === "failed"
              ? "failed"
              : "queued",
      progress: progress.percentage,
      completedItems: progress.completedItems,
      totalItems: progress.totalItems,
      errors: progress.errors,
    };
  }

  async download(id: string, apiKeyId: string) {
    const job = await this.queue.getJob(id);
    if (
      !job ||
      job.data.apiKeyId !== apiKeyId ||
      (await job.getState()) !== "completed"
    )
      return undefined;
    const result = job.returnvalue;
    if (!result || !Array.isArray(result.files)) return undefined;
    const files: Array<{ name: string; stream: Readable }> = [];
    for (const file of result.files) {
      const stream = await this.storage.getStream(file.storageKey);
      if (!stream) {
        for (const opened of files) opened.stream.destroy();
        return undefined;
      }
      files.push({ name: file.name, stream });
    }
    return createZipStream(
      files,
      result.errors,
      this.config.BATCH_MAX_RESULT_BYTES,
    );
  }

  async close(): Promise<void> {
    await this.worker.close();
    await Promise.all(this.pendingFinishes);
    await this.queue.close();
    await this.connection.quit();
  }

  isReady(): boolean {
    return this.connection.status === "ready";
  }

  private admissionKeys(apiKeyId: string) {
    const prefix = `${queueName}:api-key:${apiKeyId}`;
    return { active: `${prefix}:active`, rate: `${prefix}:requests` };
  }

  private async finishFailedJob(
    job: Job<BatchRequest, BatchJobResult>,
  ): Promise<void> {
    if ((await job.getState()) !== "failed") return;
    await this.finishJob(job, "failed");
  }

  private async finishJob(
    job: Job<BatchRequest, BatchJobResult>,
    status: "done" | "failed",
    result?: BatchJobResult,
  ): Promise<void> {
    await this.releaseApiKeySlot(job.data.apiKeyId, job.id!);
    if (!job.data.webhookUrl) return;
    if (!this.config.WEBHOOK_SIGNING_SECRET) {
      this.logger?.error("Webhook signing secret is missing");
      return;
    }
    const payload = {
      jobId: job.id,
      status,
      progress: status === "done" ? 100 : 0,
      completedItems: result?.completedItems ?? 0,
      totalItems: result?.totalItems ?? job.data.sources.length,
      errors: result?.errors ?? [],
    };
    try {
      await sendSignedWebhook(
        job.data.webhookUrl,
        payload,
        this.config.WEBHOOK_SIGNING_SECRET,
        this.config.REQUEST_TIMEOUT_MS,
      );
    } catch (error) {
      this.logger?.error({ err: error, jobId: job.id }, "Batch webhook failed");
    }
  }

  private async releaseApiKeySlot(
    apiKeyId: string,
    jobId: string,
  ): Promise<void> {
    const keys = this.admissionKeys(apiKeyId);
    await this.connection.eval(
      releaseScript,
      2,
      keys.active,
      `${keys.active}:released:${jobId}`,
      String(Math.max(this.config.BATCH_RESULT_TTL_SECONDS * 2, 300)),
    );
  }

  private trackFinish(task: Promise<void>): void {
    this.pendingFinishes.add(task);
    void task
      .catch((error: unknown) =>
        this.logger?.error({ err: error }, "Batch completion handler failed"),
      )
      .finally(() => this.pendingFinishes.delete(task));
  }
}

function parseProgress(
  value: string | number | object,
  sourceCount: number,
  result: BatchJobResult | undefined,
): {
  percentage: number;
  completedItems: number;
  totalItems: number;
  errors: BatchJobResult["errors"];
} {
  if (typeof value === "object" && value !== null && "percentage" in value) {
    const progress = value as {
      percentage?: unknown;
      completedItems?: unknown;
      totalItems?: unknown;
      errors?: unknown;
    };
    return {
      percentage:
        typeof progress.percentage === "number" ? progress.percentage : 0,
      completedItems:
        typeof progress.completedItems === "number"
          ? progress.completedItems
          : 0,
      totalItems:
        typeof progress.totalItems === "number"
          ? progress.totalItems
          : sourceCount,
      errors: Array.isArray(progress.errors)
        ? (progress.errors as BatchJobResult["errors"])
        : [],
    };
  }
  return {
    percentage: typeof value === "number" ? value : 0,
    completedItems: result?.completedItems ?? 0,
    totalItems: result?.totalItems ?? sourceCount,
    errors: result?.errors ?? [],
  };
}

export function hashApiKey(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
