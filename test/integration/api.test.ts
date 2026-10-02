import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/api/app.js";
import type { AppConfig } from "../../src/config/index.js";
import { createCacheKey } from "../../src/storage/cache-key.js";
import type { Storage } from "../../src/storage/storage.js";
import type { PluginRegistry } from "../../src/plugins/interface.js";
import type {
  BatchJobStatus,
  BatchQueue,
  BatchRequest,
} from "../../src/jobs/types.js";

const testConfig: AppConfig = {
  NODE_ENV: "test",
  HOST: "127.0.0.1",
  PORT: 3000,
  MAX_UPLOAD_BYTES: 1024 * 1024,
  MAX_INPUT_PIXELS: 100_000,
  MAX_OUTPUT_DIMENSION: 1000,
  REQUEST_TIMEOUT_MS: 2000,
  CONCURRENCY_LIMIT: 10,
  IMAGE_PROCESSING_CONCURRENCY: 2,
  ALLOWED_HOSTS: "",
  SIGNING_SECRET: undefined,
  CACHE_DIR: "/tmp/image-craft-test-cache",
  CACHE_MAX_AGE_SECONDS: 60,
  CACHE_MAX_SIZE_BYTES: 1024 * 1024,
  QUEUE_ENABLED: false,
  REDIS_URL: "redis://127.0.0.1:6379",
  BATCH_MAX_ITEMS: 3,
  BATCH_CONCURRENCY: 1,
  BATCH_MAX_RESULT_BYTES: 1024 * 1024,
  BATCH_RESULT_TTL_SECONDS: 3600,
  REMOVE_BACKGROUND_ENABLED: false,
  REMBG_URL: "http://127.0.0.1:7000",
};
function multipart(
  image: Buffer,
  fields: Record<string, string> = {},
): { payload: Buffer; contentType: string } {
  const boundary = "test-boundary";
  const chunks: Buffer[] = [];
  for (const [name, value] of Object.entries(fields))
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
      ),
    );
  chunks.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="fixture.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`,
    ),
    image,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  );
  return {
    payload: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

class MemoryBatchQueue implements BatchQueue {
  readonly input: BatchRequest[] = [];
  current: BatchJobStatus | undefined;
  async enqueue(input: BatchRequest): Promise<string> {
    this.input.push(input);
    this.current = { id: "job-123", state: "waiting", progress: 0 };
    return "job-123";
  }
  async get(id: string): Promise<BatchJobStatus | undefined> {
    return this.current?.id === id ? this.current : undefined;
  }
  isReady(): boolean {
    return true;
  }
  async close(): Promise<void> {}
}

class UnavailableBatchQueue extends MemoryBatchQueue {
  isReady(): boolean {
    return false;
  }
}

class HostileStatusQueue extends MemoryBatchQueue {
  async get(): Promise<BatchJobStatus> {
    return {
      id: 'evil"\r\nX-Injected: yes',
      state: "completed",
      progress: 100,
    };
  }
}

class MemoryStorage implements Storage {
  readonly values = new Map<string, Buffer>();
  async get(key: string): Promise<Buffer | undefined> {
    return this.values.get(key);
  }
  async set(key: string, value: Buffer, ttlSeconds: number): Promise<void> {
    void ttlSeconds;
    this.values.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }
}

describe("HTTP API", () => {
  const storage = new MemoryStorage();
  const app = createApp(
    testConfig,
    storage,
    undefined,
    new Map([
      [
        "test-pass-through",
        {
          name: "test-pass-through",
          async run(buffer) {
            return buffer;
          },
        },
      ],
    ]) satisfies PluginRegistry,
  );
  let image: Buffer;
  beforeAll(async () => {
    image = await sharp({
      create: { width: 8, height: 5, channels: 3, background: "#00f" },
    })
      .jpeg()
      .toBuffer();
    await (await app).ready();
  });
  afterAll(async () => {
    await (await app).close();
  });
  it("serves health, readiness and generated docs", async () => {
    const server = await app;
    expect((await server.inject("/health")).statusCode).toBe(200);
    expect((await server.inject("/ready")).statusCode).toBe(200);
    const docs = await server.inject("/docs/json");
    expect(docs.statusCode).toBe(200);
    expect((await server.inject("/docs")).statusCode).toBe(200);
    expect(docs.json().paths).toHaveProperty("/v1/transform");
    expect(docs.json().paths).toHaveProperty("/v1/metadata");
    expect(docs.json().paths).toHaveProperty("/v1/batch");
    expect(docs.json().paths).toHaveProperty("/v1/jobs/{id}");
  });

  it("queues batch jobs and downloads the completed ZIP", async () => {
    const batchQueue = new MemoryBatchQueue();
    const batchStorage = new MemoryStorage();
    const queueConfig = { ...testConfig, QUEUE_ENABLED: true };
    const server = await createApp(queueConfig, batchStorage, batchQueue);
    await server.ready();
    const queued = await server.inject({
      method: "POST",
      url: "/v1/batch",
      payload: {
        sources: ["https://example.com/a.jpg", "https://example.com/b.png"],
        ops: [{ op: "resize", width: 100 }],
      },
    });
    expect(queued.statusCode).toBe(202);
    expect(queued.json()).toMatchObject({
      id: "job-123",
      status: "waiting",
      statusUrl: "/v1/jobs/job-123",
    });
    expect(batchQueue.input[0]?.sources).toHaveLength(2);

    const waiting = await server.inject("/v1/jobs/job-123");
    expect(waiting.json()).toMatchObject({ state: "waiting", progress: 0 });
    const archive = Buffer.from("PK-test-zip");
    batchStorage.values.set("batch-result:job-123", archive);
    batchQueue.current = { id: "job-123", state: "completed", progress: 100 };
    const completed = await server.inject("/v1/jobs/job-123");
    expect(completed.statusCode).toBe(200);
    expect(completed.headers["content-type"]).toContain("application/zip");
    expect(completed.headers["content-disposition"]).toContain("attachment");
    expect(completed.rawPayload).toEqual(archive);
    await server.close();
  });

  it("uses a fixed safe download filename for untrusted job status IDs", async () => {
    const batchStorage = new MemoryStorage();
    batchStorage.values.set(
      'batch-result:evil"\r\nX-Injected: yes',
      Buffer.from("zip"),
    );
    const server = await createApp(
      testConfig,
      batchStorage,
      new HostileStatusQueue(),
    );
    await server.ready();
    const response = await server.inject("/v1/jobs/request-id");
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-disposition"]).toBe(
      'attachment; filename="image-craft-result.zip"',
    );
    expect(response.headers["x-injected"]).toBeUndefined();
    await server.close();
  });

  it("runs an enabled plugin operation through multipart transform", async () => {
    const server = await app;
    const form = multipart(image, {
      ops: '[{"op":"plugin","name":"test-pass-through","options":{}}]',
    });
    const response = await server.inject({
      method: "POST",
      url: "/v1/transform",
      headers: { "content-type": form.contentType },
      payload: form.payload,
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("image/jpeg");
  });

  it("keeps batch endpoints disabled unless a queue is configured", async () => {
    const server = await app;
    const response = await server.inject({
      method: "POST",
      url: "/v1/batch",
      payload: {
        sources: ["https://example.com/a.jpg"],
        ops: [],
      },
    });
    expect(response.statusCode).toBe(503);
  });

  it("rejects queue requests while Redis is unavailable", async () => {
    const queue = new UnavailableBatchQueue();
    const server = await createApp(testConfig, storage, queue);
    await server.ready();
    const response = await server.inject({
      method: "POST",
      url: "/v1/batch",
      payload: { sources: ["https://example.com/a.jpg"], ops: [] },
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: "Batch queue is unavailable" });
    await server.close();
  });

  it("rejects invalid batch URLs and operation chains", async () => {
    const queue = new MemoryBatchQueue();
    const server = await createApp(
      { ...testConfig, QUEUE_ENABLED: true },
      storage,
      queue,
    );
    await server.ready();
    const response = await server.inject({
      method: "POST",
      url: "/v1/batch",
      payload: {
        sources: ["file:///etc/passwd"],
        ops: [{ op: "resize" }],
      },
    });
    expect(response.statusCode).toBe(400);
    expect(queue.input).toHaveLength(0);
    await server.close();
  });
  it("transforms multipart uploads", async () => {
    const server = await app;
    const form = multipart(image, {
      ops: JSON.stringify([
        { op: "resize", width: 4 },
        { op: "format", format: "webp" },
      ]),
    });
    const response = await server.inject({
      method: "POST",
      url: "/v1/transform",
      headers: { "content-type": form.contentType },
      payload: form.payload,
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("image/webp");
    expect((await sharp(response.rawPayload).metadata()).width).toBe(4);
  });
  it("blocks loopback remote image URLs", async () => {
    const server = await app;
    const response = await server.inject(
      "/v1/img/w_2/https://127.0.0.1/private.jpg",
    );
    expect(response.statusCode).toBe(403);
    expect(response.headers["x-cache"]).toBe("MISS");
    expect(response.body).not.toContain("stack");
  });

  it("returns a cache hit for a stored remote transform", async () => {
    const server = await app;
    const source = new URL("https://example.com/photo.jpg");
    const ops = [
      { op: "resize", width: 4 },
      { op: "format", format: "webp" },
    ] as const;
    const cachedImage = await sharp(image).resize(4).webp().toBuffer();
    storage.values.set(createCacheKey(source, ops), cachedImage);

    const response = await server.inject(
      "/v1/img/w_4,f_webp/https://example.com/photo.jpg",
    );
    expect(response.statusCode).toBe(200);
    expect(response.headers["x-cache"]).toBe("HIT");
    expect(response.headers["content-type"]).toContain("image/webp");
    expect(response.rawPayload).toEqual(cachedImage);
  });

  it("returns metadata and rejects non-images", async () => {
    const server = await app;
    const form = multipart(image);
    const response = await server.inject({
      method: "POST",
      url: "/v1/metadata",
      headers: { "content-type": form.contentType },
      payload: form.payload,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      width: 8,
      height: 5,
      format: "jpeg",
    });
    const invalid = multipart(Buffer.from("not an image"));
    const rejected = await server.inject({
      method: "POST",
      url: "/v1/metadata",
      headers: { "content-type": invalid.contentType },
      payload: invalid.payload,
    });
    expect(rejected.statusCode).toBe(415);
    expect(rejected.body).not.toContain("node_modules");
  });
});
