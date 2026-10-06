import { readFileSync } from "node:fs";
import sharp from "sharp";
import { Readable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/api/app.js";
import type { AppConfig } from "../../src/config/index.js";
import { createCacheKey } from "../../src/core/cache-key.js";
import type { Storage, StorageStats } from "../../src/storage/storage.js";
import type { PluginRegistry } from "../../src/plugins/interface.js";
import { AppError } from "../../src/core/errors.js";
import { signTransformUrl } from "../../src/security/signing.js";
import { hashApiKey } from "../../src/security/api-keys.js";
import type {
  BatchJobStatus,
  BatchQueue,
  BatchRequest,
} from "../../src/jobs/types.js";

const packageVersion = (
  JSON.parse(
    readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
  ) as { version: string }
).version;

const testConfig: AppConfig = {
  NODE_ENV: "test",
  HOST: "127.0.0.1",
  PORT: 3000,
  MAX_UPLOAD_BYTES: 1024 * 1024,
  MAX_INPUT_PIXELS: 100_000,
  MAX_ANIMATION_FRAMES: 10,
  SMART_QUALITY_SSIM_THRESHOLD: 0.98,
  PDF_ENABLED: false,
  PDF_RASTERIZER_URL: "http://pdf-worker:8000",
  PDF_MAX_DPI: 200,
  PDF_MAX_PAGES: 50,
  PDF_CPU_SECONDS: 5,
  PDF_MEMORY_MB: 512,
  PDF_WORKER_TIMEOUT_MS: 10_000,
  PDF_MAX_PIXELS: 20_000_000,
  MAX_OUTPUT_DIMENSION: 1000,
  REQUEST_TIMEOUT_MS: 2000,
  CONCURRENCY_LIMIT: 10,
  REMOTE_TRANSFORM_RATE_LIMIT: 60,
  REMOTE_TRANSFORM_RATE_WINDOW_MS: 60_000,
  API_RATE_LIMIT: 120,
  API_RATE_WINDOW_MS: 60_000,
  CORS_ORIGINS: "",
  OTEL_ENABLED: false,
  OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318",
  IMAGE_PROCESSING_CONCURRENCY: 2,
  SHARP_CONCURRENCY: 2,
  SHARP_CACHE_MEMORY_MB: 32,
  MAX_OPS_CHAIN: 20,
  API_KEYS: "",
  ADMIN_DASHBOARD_ENABLED: false,
  TENANTS: {},
  ALLOWED_HOSTS: "",
  NAMED_SOURCES: {},
  SIGNING_SECRET: undefined,
  SIGNING_SECRET_PREVIOUS: undefined,
  SIGNING_REQUIRED: false,
  STORAGE_DRIVER: "disk",
  CACHE_DIR: "/tmp/image-craft-test-cache",
  CACHE_ENABLED: true,
  CACHE_DISTRIBUTED_LOCK_ENABLED: false,
  CACHE_DISTRIBUTED_LOCK_TTL_MS: 10_000,
  CACHE_DISTRIBUTED_LOCK_WAIT_MS: 15_000,
  CACHE_MAX_AGE_SECONDS: 60,
  CACHE_MAX_SIZE_BYTES: 1024 * 1024,
  S3_ENDPOINT: undefined,
  S3_REGION: "us-east-1",
  S3_BUCKET: undefined,
  S3_ACCESS_KEY_ID: undefined,
  S3_SECRET_ACCESS_KEY: undefined,
  S3_FORCE_PATH_STYLE: true,
  S3_PRESIGNED_UPLOAD_TTL_SECONDS: 900,
  QUEUE_ENABLED: false,
  REDIS_URL: "redis://127.0.0.1:6379",
  BATCH_MAX_ITEMS: 100,
  BATCH_CONCURRENCY: 1,
  BATCH_CONCURRENCY_PER_API_KEY: 2,
  BATCH_RATE_LIMIT_PER_API_KEY: 10,
  BATCH_RATE_WINDOW_MS: 60_000,
  BATCH_JOB_ATTEMPTS: 3,
  BATCH_BACKOFF_DELAY_MS: 100,
  BATCH_MAX_RESULT_BYTES: 1024 * 1024,
  BATCH_RESULT_TTL_SECONDS: 3600,
  WEBHOOK_SIGNING_SECRET: undefined,
  REMOVE_BACKGROUND_ENABLED: false,
  REMBG_URL: "http://127.0.0.1:7000",
  UPSCALE_ENABLED: false,
  UPSCALE_URL: "http://127.0.0.1:8000",
  AUTO_ALT_TEXT_ENABLED: false,
  AUTO_ALT_TEXT_URL: "http://127.0.0.1:8000",
  NSFW_CHECK_ENABLED: false,
  NSFW_CHECK_URL: "http://127.0.0.1:8000",
  AI_PLUGIN_TIMEOUT_MS: 1000,
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
  owner: string | undefined;
  archive = Buffer.from("PK-test-zip");
  async enqueue(input: BatchRequest): Promise<string> {
    this.input.push(input);
    this.owner = input.apiKeyId;
    this.current = {
      jobId: "11111111-1111-4111-8111-111111111111",
      status: "queued",
      progress: 0,
      completedItems: 0,
      totalItems: input.sources.length,
      errors: [],
    };
    return this.current.jobId;
  }
  async get(id: string, apiKeyId: string): Promise<BatchJobStatus | undefined> {
    return this.current?.jobId === id && this.owner === apiKeyId
      ? this.current
      : undefined;
  }
  async download(id: string, apiKeyId: string) {
    return this.current?.jobId === id && this.owner === apiKeyId
      ? Readable.from(this.archive)
      : undefined;
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
      jobId: 'evil"\r\nX-Injected: yes',
      status: "done",
      progress: 100,
      completedItems: 1,
      totalItems: 1,
      errors: [],
    };
  }
  async download() {
    return Readable.from(Buffer.from("zip"));
  }
}

class MemoryStorage implements Storage {
  readonly values = new Map<string, Buffer>();
  async get(key: string): Promise<Buffer | undefined> {
    return this.values.get(key);
  }
  async getStream(key: string) {
    const value = await this.get(key);
    return value ? Readable.from(value) : undefined;
  }
  async set(key: string, value: Buffer, ttlSeconds: number): Promise<void> {
    void ttlSeconds;
    this.values.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }
  async stats(): Promise<StorageStats> {
    const values = [...this.values.values()];
    return {
      entries: values.length,
      sizeBytes: values.reduce((total, value) => total + value.byteLength, 0),
      maxSizeBytes: Number.MAX_SAFE_INTEGER,
    };
  }
}

class PresignedMemoryStorage extends MemoryStorage {
  async createPresignedUpload(
    key: string,
    contentType: string,
    contentLength: number,
    uploadExpiresInSeconds: number,
    objectTtlSeconds: number,
  ) {
    await this.set(
      `presigned:${key}`,
      Buffer.from(`${contentType}:${contentLength}`),
      objectTtlSeconds,
    );
    return {
      url: `https://storage.example/${encodeURIComponent(key)}`,
      headers: { "Content-Type": contentType },
      expiresIn: uploadExpiresInSeconds,
    };
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
          version: "1.0.0",
          timeoutMs: 1000,
          maxBytes: 1024 * 1024,
          async run(buffer, _options, context) {
            context.metadata.altText = "fixture image 雪";
            return buffer;
          },
        },
      ],
      [
        "test-worker-down",
        {
          name: "test-worker-down",
          version: "1.0.0",
          timeoutMs: 1000,
          maxBytes: 1024 * 1024,
          async run() {
            throw new AppError("AI worker is unavailable", 503);
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
    expect(docs.json().paths).toHaveProperty("/v1/jobs/{id}/download");
    expect(docs.json().paths).toHaveProperty("/v1/uploads");
    expect(
      docs.json().paths["/v1/uploads"].post.requestBody.content[
        "multipart/form-data"
      ].schema.properties.file.format,
    ).toBe("binary");
    expect(docs.json().paths).toHaveProperty("/v1/hash/{*}");
    expect(docs.json().paths).toHaveProperty("/v1/pdf/{*}");
    expect(docs.json().paths).toHaveProperty("/metrics");
    expect(docs.json().info.version).toBe(packageVersion);
    expect(docs.json().paths["/v1/img/{ops}/{*}"]?.get?.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "expires", in: "query" }),
        expect.objectContaining({ name: "if-none-match", in: "header" }),
      ]),
    );
  });

  it("exports request, operation, cache, in-flight, and error metrics", async () => {
    const metricsApp = await createApp(
      testConfig,
      new MemoryStorage(),
      undefined,
      undefined,
      {
        remoteImageFetcher: async () => ({
          body: image,
          contentType: "image/jpeg",
        }),
      },
    );
    await metricsApp.ready();
    const path = "/v1/img/w_4/https%3A%2F%2Fexample.com%2Fmetrics.jpg";
    expect((await metricsApp.inject(path)).statusCode).toBe(200);
    expect((await metricsApp.inject(path)).statusCode).toBe(200);
    const invalid = await metricsApp.inject(
      "/v1/img/w_-1/https%3A%2F%2Fexample.com%2Fmetrics.jpg",
    );
    expect(invalid.statusCode).toBe(400);

    const response = await metricsApp.inject("/metrics");
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/plain");
    expect(response.body).toContain("image_craft_http_requests_total");
    expect(response.body).toContain(
      "image_craft_http_request_duration_seconds",
    );
    expect(response.body).toContain(
      'image_craft_transform_operation_duration_seconds_count{operation="resize"} 1',
    );
    expect(response.body).toContain(
      'image_craft_cache_requests_total{result="hit"} 1',
    );
    expect(response.body).toContain(
      'image_craft_cache_requests_total{result="miss"} 1',
    );
    expect(response.body).toContain(
      'image_craft_errors_total{code="INVALID_URL_OPERATIONS"} 1',
    );
    expect(response.body).not.toContain("metrics.jpg");
    expect(response.body).not.toContain("example.com");
    expect(response.body).toContain(
      'image_craft_queue_depth{state="waiting"} 0',
    );
    expect(response.body).toContain("image_craft_transforms_in_flight 0");
    await metricsApp.close();
  });

  it("analyzes a remote source and reports the best supported format and savings", async () => {
    const analyzeApp = await createApp(
      testConfig,
      new MemoryStorage(),
      undefined,
      undefined,
      {
        remoteImageFetcher: async () => ({
          body: image,
          contentType: "image/jpeg",
        }),
      },
    );
    await analyzeApp.ready();
    const response = await analyzeApp.inject({
      method: "POST",
      url: "/v1/analyze",
      payload: { source: "https://example.com/analyze.jpg" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      format: expect.stringMatching(/^(webp|avif)$/),
      quality: expect.any(Number),
      ssim: expect.any(Number),
      thresholdMet: expect.any(Boolean),
      sourceBytes: image.length,
      expectedBytes: expect.any(Number),
      expectedSavingsBytes: expect.any(Number),
      expectedSavingsPercent: expect.any(Number),
    });
    const smartTransform = await analyzeApp.inject(
      "/v1/img/f_webp,q_smart/https%3A%2F%2Fexample.com%2Fanalyze.jpg",
    );
    expect(smartTransform.statusCode).toBe(200);
    expect(smartTransform.headers["content-type"]).toContain("image/webp");
    await analyzeApp.close();
  });

  it("negotiates f_auto from Accept and varies cache output by format", async () => {
    const autoApp = await createApp(
      { ...testConfig, CORS_ORIGINS: "https://client.example" },
      new MemoryStorage(),
      undefined,
      undefined,
      {
        remoteImageFetcher: async () => ({
          body: image,
          contentType: "image/jpeg",
        }),
      },
    );
    await autoApp.ready();
    const path = "/v1/img/f_auto/https%3A%2F%2Fexample.com%2Fauto.jpg";
    const avif = await autoApp.inject({
      url: path,
      headers: {
        accept: "image/avif,image/webp",
        origin: "https://client.example",
      },
    });
    const webp = await autoApp.inject({
      url: path,
      headers: { accept: "image/webp" },
    });
    const original = await autoApp.inject({
      url: path,
      headers: { accept: "image/jpeg" },
    });
    expect(avif.headers["content-type"]).toContain("image/avif");
    expect(webp.headers["content-type"]).toContain("image/webp");
    expect(original.headers["content-type"]).toContain("image/jpeg");
    expect(avif.headers.vary).toContain("Accept");
    expect(avif.headers.vary).toContain("Origin");
    expect(avif.headers["access-control-allow-origin"]).toBe(
      "https://client.example",
    );
    expect(webp.headers.vary).toContain("Accept");
    const upload = multipart(image, {
      ops: '[{"op":"format","format":"auto"}]',
    });
    const uploaded = await autoApp.inject({
      method: "POST",
      url: "/v1/transform",
      headers: {
        accept: "image/webp",
        "content-type": upload.contentType,
      },
      payload: upload.payload,
    });
    expect(uploaded.headers["content-type"]).toContain("image/webp");
    expect(uploaded.headers.vary).toContain("Accept");
    await autoApp.close();
  });

  it("extracts an animation frame from the URL endpoint", async () => {
    const width = 8;
    const pageHeight = 6;
    const pages = 3;
    const pixels = Buffer.alloc(width * pageHeight * pages * 4);
    for (let page = 0; page < pages; page += 1) {
      const color = [
        [255, 0, 0],
        [0, 255, 0],
        [0, 0, 255],
      ][page]!;
      for (
        let offset = page * width * pageHeight * 4;
        offset < (page + 1) * width * pageHeight * 4;
        offset += 4
      ) {
        pixels[offset] = color[0]!;
        pixels[offset + 1] = color[1]!;
        pixels[offset + 2] = color[2]!;
        pixels[offset + 3] = 255;
      }
    }
    const animation = await sharp(pixels, {
      raw: { width, height: pageHeight * pages, channels: 4, pageHeight },
    })
      .gif({ loop: 0, delay: [100, 100, 100] })
      .toBuffer();
    const frameApp = await createApp(
      testConfig,
      new MemoryStorage(),
      undefined,
      undefined,
      {
        remoteImageFetcher: async () => ({
          body: animation,
          contentType: "image/gif",
        }),
      },
    );
    await frameApp.ready();
    const response = await frameApp.inject(
      "/v1/img/w_4/https%3A%2F%2Fexample.com%2Fanimation.gif?frame=1",
    );
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("image/jpeg");
    expect((await sharp(response.rawPayload).metadata()).pages ?? 1).toBe(1);
    const missingFrame = await frameApp.inject(
      "/v1/img/w_4/https%3A%2F%2Fexample.com%2Fanimation.gif?frame=3",
    );
    expect(missingFrame.statusCode).toBe(400);
    await frameApp.close();

    const limitedFrameApp = await createApp(
      { ...testConfig, MAX_ANIMATION_FRAMES: 2 },
      new MemoryStorage(),
      undefined,
      undefined,
      {
        remoteImageFetcher: async () => ({
          body: animation,
          contentType: "image/gif",
        }),
      },
    );
    await limitedFrameApp.ready();
    const overLimit = await limitedFrameApp.inject(
      "/v1/img/w_4/https%3A%2F%2Fexample.com%2Fanimation.gif",
    );
    expect(overLimit.statusCode).toBe(413);
    await limitedFrameApp.close();
  });

  it("rasterizes remote PDF pages through the configured worker", async () => {
    const sourcePdf = Buffer.from("%PDF-1.4\nfixture bytes");
    const png = await sharp({
      create: { width: 2, height: 2, channels: 3, background: "#123456" },
    })
      .png()
      .toBuffer();
    const render = vi.fn(async () => png);
    const pdfApp = await createApp(
      { ...testConfig, PDF_ENABLED: true },
      new MemoryStorage(),
      undefined,
      undefined,
      {
        remoteImageFetcher: async () => ({
          body: sourcePdf,
          contentType: "application/pdf",
        }),
        pdfRasterizer: { render },
      },
    );
    await pdfApp.ready();
    const response = await pdfApp.inject(
      "/v1/pdf/https%3A%2F%2Fexample.com%2Fdocument.pdf?page=2&dpi=180",
    );
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("image/png");
    expect(response.rawPayload).toEqual(png);
    expect(render).toHaveBeenCalledWith(sourcePdf, { page: 2, dpi: 180 });

    const excessiveDpi = await pdfApp.inject(
      "/v1/pdf/https%3A%2F%2Fexample.com%2Fdocument.pdf?dpi=301",
    );
    expect(excessiveDpi.statusCode).toBe(400);
    await pdfApp.close();

    const disabledApp = await createApp(testConfig, new MemoryStorage());
    await disabledApp.ready();
    const disabled = await disabledApp.inject(
      "/v1/pdf/https%3A%2F%2Fexample.com%2Fdocument.pdf",
    );
    expect(disabled.statusCode).toBe(503);
    await disabledApp.close();
  });

  it("generates a BlurHash for an SSRF-checked remote image", async () => {
    const hashApp = await createApp(
      testConfig,
      new MemoryStorage(),
      undefined,
      undefined,
      {
        remoteImageFetcher: async () => ({
          body: image,
          contentType: "image/jpeg",
        }),
      },
    );
    await hashApp.ready();
    const result = await hashApp.inject(
      "/v1/hash/https%3A%2F%2Fexample.com%2Fhash.jpg",
    );
    expect(result.statusCode).toBe(200);
    expect(result.json()).toMatchObject({
      width: expect.any(Number),
      height: expect.any(Number),
      hash: expect.any(String),
    });
    await hashApp.close();
  });

  it("returns machine-readable errors for unknown operations and overlong chains", async () => {
    const server = await app;
    const invalid = multipart(image, { ops: '[{"op":"invented"}]' });
    const response = await server.inject({
      method: "POST",
      url: "/v1/transform",
      headers: { "content-type": invalid.contentType },
      payload: invalid.payload,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "INVALID_OPERATIONS" });

    const limitedApp = await createApp(
      { ...testConfig, MAX_OPS_CHAIN: 1 },
      new MemoryStorage(),
    );
    await limitedApp.ready();
    const tooLong = multipart(image, {
      ops: '[{"op":"grayscale"},{"op":"flip"}]',
    });
    const rejected = await limitedApp.inject({
      method: "POST",
      url: "/v1/transform",
      headers: { "content-type": tooLong.contentType },
      payload: tooLong.payload,
    });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json()).toMatchObject({ code: "OPS_CHAIN_TOO_LONG" });
    await limitedApp.close();
  });

  it("enforces operation-chain limits on batch requests", async () => {
    const queue = new MemoryBatchQueue();
    const batchApp = await createApp(
      { ...testConfig, QUEUE_ENABLED: true, MAX_OPS_CHAIN: 1 },
      new MemoryStorage(),
      queue,
    );
    await batchApp.ready();
    const response = await batchApp.inject({
      method: "POST",
      url: "/v1/batch",
      payload: {
        sources: ["https://example.com/image.jpg"],
        ops: [{ op: "flip" }, { op: "flop" }],
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "OPS_CHAIN_TOO_LONG" });
    expect(queue.input).toHaveLength(0);
    await batchApp.close();
  });

  it("rate limits remote transforms by client IP", async () => {
    const rateLimitedApp = await createApp(
      { ...testConfig, REMOTE_TRANSFORM_RATE_LIMIT: 1 },
      new MemoryStorage(),
      undefined,
      undefined,
      {
        remoteImageFetcher: async () => ({
          body: image,
          contentType: "image/jpeg",
        }),
      },
    );
    await rateLimitedApp.ready();
    const url = "/v1/img/f_webp/https%3A%2F%2Fexample.com%2Frate.jpg";
    expect((await rateLimitedApp.inject(url)).statusCode).toBe(200);
    const limited = await rateLimitedApp.inject(url);
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toEqual({ error: "Rate limit exceeded" });
    await rateLimitedApp.close();
  });

  it("queues batch jobs, reports progress, and downloads the completed ZIP", async () => {
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
    expect(queued.json()).toEqual({
      jobId: "11111111-1111-4111-8111-111111111111",
    });
    expect(batchQueue.input[0]?.sources).toHaveLength(2);

    const jobId = "11111111-1111-4111-8111-111111111111";
    const waiting = await server.inject(`/v1/jobs/${jobId}`);
    expect(waiting.json()).toMatchObject({ status: "queued", progress: 0 });
    batchQueue.current = {
      jobId,
      status: "done",
      progress: 100,
      completedItems: 2,
      totalItems: 2,
      errors: [],
    };
    const completedStatus = await server.inject(`/v1/jobs/${jobId}`);
    expect(completedStatus.json()).toMatchObject({
      status: "done",
      progress: 100,
    });
    const completed = await server.inject(`/v1/jobs/${jobId}/download`);
    expect(completed.statusCode).toBe(200);
    expect(completed.headers["content-type"]).toContain("application/zip");
    expect(completed.headers["content-disposition"]).toContain("attachment");
    expect(completed.rawPayload).toEqual(batchQueue.archive);
    await server.close();
  });

  it("uses a fixed safe download filename for untrusted job status IDs", async () => {
    const batchStorage = new MemoryStorage();
    const jobId = "11111111-1111-4111-8111-111111111111";
    const server = await createApp(
      testConfig,
      batchStorage,
      new HostileStatusQueue(),
    );
    await server.ready();
    const response = await server.inject(`/v1/jobs/${jobId}/download`);
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-disposition"]).toBe(
      'attachment; filename="image-craft-result.zip"',
    );
    expect(response.headers["x-injected"]).toBeUndefined();
    await server.close();
  });

  it("stores validated multipart batch uploads behind expiring file IDs", async () => {
    const queue = new MemoryBatchQueue();
    const batchStorage = new MemoryStorage();
    const server = await createApp(
      { ...testConfig, QUEUE_ENABLED: true },
      batchStorage,
      queue,
    );
    await server.ready();
    const form = multipart(image);
    const response = await server.inject({
      method: "POST",
      url: "/v1/uploads",
      headers: { "content-type": form.contentType },
      payload: form.payload,
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ expiresIn: 3600 });
    expect(response.json().fileId).toMatch(/^file_[0-9a-f-]{36}$/u);
    expect(
      batchStorage.values.get(`batch-upload:${response.json().fileId}`),
    ).toEqual(image);
    expect(
      batchStorage.values.get(`batch-upload-owner:${response.json().fileId}`),
    ).toBeDefined();
    await server.close();
  });

  it("returns presigned upload details when the storage adapter supports them", async () => {
    const storage = new PresignedMemoryStorage();
    const server = await createApp(
      { ...testConfig, QUEUE_ENABLED: true },
      storage,
      new MemoryBatchQueue(),
    );
    await server.ready();
    const response = await server.inject({
      method: "POST",
      url: "/v1/uploads",
      headers: { "content-type": "application/json" },
      payload: { contentType: "image/png", sizeBytes: image.byteLength },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      uploadUrl: expect.stringContaining("storage.example"),
      method: "PUT",
      expiresIn: testConfig.S3_PRESIGNED_UPLOAD_TTL_SECONDS,
      headers: { "Content-Type": "image/png" },
    });
    expect(
      storage.values
        .get(`batch-upload-owner:${response.json().fileId}`)
        ?.toString(),
    ).toBeDefined();
    const docs = await server.inject("/docs/json");
    expect(
      docs.json().paths["/v1/uploads"]?.post?.requestBody?.content,
    ).toHaveProperty("application/json");
    await server.close();
  });

  it("resolves named image source aliases and forwards credentials only through the configured source", async () => {
    let fetchedUrl = "";
    let fetchedOptions: Parameters<typeof fetch>[1] | undefined;
    const server = await createApp(
      {
        ...testConfig,
        NAMED_SOURCES: {
          cdn: {
            origin: "https://cdn.example.com/assets/",
            allowedHosts: ["cdn.example.com"],
            headers: { authorization: "Bearer named-source-token" },
          },
        },
      },
      new MemoryStorage(),
      undefined,
      undefined,
      {
        remoteImageFetcher: async (url, options) => {
          fetchedUrl = url;
          fetchedOptions = options as unknown as Parameters<typeof fetch>[1];
          return { body: image, contentType: "image/jpeg" };
        },
      },
    );
    await server.ready();
    const response = await server.inject("/v1/img/w_4/cdn:products/photo.jpg");
    expect(response.statusCode).toBe(200);
    expect(fetchedUrl).toBe(
      "https://cdn.example.com/assets/products/photo.jpg",
    );
    expect(fetchedOptions).toMatchObject({
      allowedHosts: ["cdn.example.com"],
      headers: { authorization: "Bearer named-source-token" },
      credentialOrigin: "https://cdn.example.com",
    });
    await server.close();
  });

  it("requires a configured API key and uses a constant client identifier", async () => {
    const queue = new MemoryBatchQueue();
    const server = await createApp(
      {
        ...testConfig,
        QUEUE_ENABLED: true,
        API_KEYS: `${hashApiKey("secret-one")}=batch:write+batch:read;${hashApiKey("secret-two")}`,
      },
      new MemoryStorage(),
      queue,
    );
    await server.ready();
    const payload = {
      sources: ["https://example.com/image.jpg"],
      ops: [],
    };
    expect(
      (await server.inject({ method: "POST", url: "/v1/batch", payload }))
        .statusCode,
    ).toBe(401);
    const queued = await server.inject({
      method: "POST",
      url: "/v1/batch",
      headers: { "x-api-key": "secret-one" },
      payload,
    });
    expect(queued.statusCode).toBe(202);
    expect(queue.input[0]?.apiKeyId).not.toContain("secret-one");
    await server.close();
  });

  it("enforces API scopes, per-key limits, strict CORS, and security headers", async () => {
    const secret = "scope-limited-key";
    const server = await createApp({
      ...testConfig,
      API_KEYS: `${hashApiKey(secret)}=metadata+transform`,
      CORS_ORIGINS: "https://client.example",
    });
    await server.ready();
    const headers = { "x-api-key": secret };
    const missingScope = await server.inject({
      method: "POST",
      url: "/v1/batch",
      headers,
      payload: { sources: ["https://example.com/a.png"], ops: [] },
    });
    expect(missingScope.statusCode).toBe(403);
    const missingAdminScope = await server.inject({
      url: "/v1/admin/tenants",
      headers,
    });
    expect(missingAdminScope.statusCode).toBe(403);
    expect(missingScope.headers["x-content-type-options"]).toBe("nosniff");
    expect(missingScope.headers["content-security-policy"]).toContain(
      "default-src 'none'",
    );

    const allowedCors = await server.inject({
      method: "GET",
      url: "/health",
      headers: { origin: "https://client.example" },
    });
    expect(allowedCors.headers["access-control-allow-origin"]).toBe(
      "https://client.example",
    );
    const deniedCors = await server.inject({
      method: "POST",
      url: "/v1/metadata",
      headers: { origin: "https://attacker.example", ...headers },
      payload: {},
    });
    expect(deniedCors.statusCode).toBe(403);

    const preflight = await server.inject({
      method: "OPTIONS",
      url: "/v1/transform",
      headers: {
        origin: "https://client.example",
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type,x-api-key,x-cache-key",
      },
    });
    expect(preflight.statusCode).toBe(204);
    const deniedHeader = await server.inject({
      method: "OPTIONS",
      url: "/v1/transform",
      headers: {
        origin: "https://client.example",
        "access-control-request-method": "POST",
        "access-control-request-headers": "x-evil",
      },
    });
    expect(deniedHeader.statusCode).toBe(403);

    await server.close();
  });

  it("serves the optional dashboard shell and protects live data with admin scope", async () => {
    const key = "dashboard-admin-key";
    const server = await createApp({
      ...testConfig,
      ADMIN_DASHBOARD_ENABLED: true,
      API_KEYS: `${hashApiKey(key)}=admin`,
    });
    await server.ready();
    expect((await server.inject({ url: "/admin" })).statusCode).toBe(200);
    expect(
      (await server.inject({ url: "/v1/admin/dashboard/data" })).statusCode,
    ).toBe(401);
    const data = await server.inject({
      url: "/v1/admin/dashboard/data",
      headers: { "x-api-key": key },
    });
    expect(data.statusCode).toBe(200);
    expect(data.json()).toMatchObject({
      cache: { entries: 0, hits: 0, misses: 0 },
      requests: { total: expect.any(Number), errorRate: expect.any(Number) },
      topImages: [],
      queue: { enabled: false },
      tenants: [],
    });
    await server.close();

    const disabled = await createApp(testConfig);
    const response = await disabled.inject({ url: "/admin" });
    expect(response.statusCode).toBe(404);
    await disabled.close();
  });

  it("applies tenant quotas, source and operation allowlists, presets, admin scope, and usage metrics", async () => {
    const secret = "acme-tenant-key";
    const tenantApp = await createApp(
      {
        ...testConfig,
        API_KEYS: `${hashApiKey(secret)}=tenant:acme+transform+admin`,
        TENANTS: {
          acme: {
            requestsPerDay: 4,
            bytesPerDay: 100_000,
            allowedSources: ["example.com"],
            allowedOps: ["resize", "format"],
            presets: {
              thumb: [
                { op: "resize", width: 8 },
                { op: "format", format: "webp" },
              ],
            },
          },
        },
      },
      new MemoryStorage(),
      undefined,
      undefined,
      {
        remoteImageFetcher: async () => ({
          body: image,
          contentType: "image/jpeg",
        }),
      },
    );
    await tenantApp.ready();
    const headers = { "x-api-key": secret };
    const preset = await tenantApp.inject({
      url: "/v1/img/p:thumb/https%3A%2F%2Fexample.com%2Ftenant.jpg",
      headers,
    });
    expect(preset.statusCode).toBe(200);
    expect(preset.headers["content-type"]).toContain("image/webp");
    expect(
      (
        await tenantApp.inject({
          url: "/v1/img/w_8/https%3A%2F%2Fother.example%2Ftenant.jpg",
          headers,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await tenantApp.inject({
          url: "/v1/img/gray_1/https%3A%2F%2Fexample.com%2Ftenant.jpg",
          headers,
        })
      ).statusCode,
    ).toBe(403);
    const usage = await tenantApp.inject({
      url: "/v1/admin/tenants/acme",
      headers,
    });
    expect(usage.statusCode).toBe(200);
    expect(usage.json().usage).toMatchObject({ requests: 4 });
    expect(
      (await tenantApp.inject({ url: "/v1/admin/tenants", headers }))
        .statusCode,
    ).toBe(429);
    expect((await tenantApp.inject("/metrics")).body).toContain(
      'image_craft_tenant_requests_total{tenant="acme"} 4',
    );
    await tenantApp.close();
  });

  it("rate limits API requests by the configured API key", async () => {
    const secret = "rate-limited-key";
    const otherSecret = "another-rate-limited-key";
    const server = await createApp({
      ...testConfig,
      API_KEYS: `${hashApiKey(secret)};${hashApiKey(otherSecret)}`,
      API_RATE_LIMIT: 1,
    });
    await server.ready();
    const headers = { "x-api-key": secret };
    const first = await server.inject({
      method: "POST",
      url: "/v1/metadata",
      headers,
      payload: {},
    });
    const second = await server.inject({
      method: "POST",
      url: "/v1/metadata",
      headers,
      payload: {},
    });
    const otherKey = await server.inject({
      method: "POST",
      url: "/v1/metadata",
      headers: { "x-api-key": otherSecret },
      payload: {},
    });
    expect(first.statusCode).toBe(406);
    expect(second.statusCode).toBe(429);
    expect(otherKey.statusCode).toBe(406);
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
    expect(response.headers["x-image-alt-text"]).toBe(
      "fixture%20image%20%E9%9B%AA",
    );
  });

  it("isolates an unavailable plugin to its request", async () => {
    const server = await app;
    const form = multipart(image, {
      ops: '[{"op":"plugin","name":"test-worker-down","options":{}}]',
    });
    const failed = await server.inject({
      method: "POST",
      url: "/v1/transform",
      headers: { "content-type": form.contentType },
      payload: form.payload,
    });
    expect(failed.statusCode).toBe(503);
    expect((await server.inject("/health")).statusCode).toBe(200);
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
  it("caches multipart uploads only with an explicit key and revalidates ETags", async () => {
    const uploadStorage = new MemoryStorage();
    const server = await createApp(testConfig, uploadStorage);
    await server.ready();
    const form = multipart(image, {
      ops: JSON.stringify([
        { op: "resize", width: 4 },
        { op: "format", format: "webp" },
      ]),
    });
    const request = {
      method: "POST" as const,
      url: "/v1/transform",
      headers: {
        "content-type": form.contentType,
        "x-cache-key": "product-card-1",
      },
      payload: form.payload,
    };
    const miss = await server.inject(request);
    expect(miss.statusCode).toBe(200);
    expect(miss.headers["x-cache"]).toBe("MISS");
    expect(miss.headers.etag).toBeDefined();
    expect(miss.headers["cache-control"]).toContain("max-age=60");
    expect(await uploadStorage.stats()).toMatchObject({ entries: 1 });

    const hit = await server.inject(request);
    expect(hit.statusCode).toBe(200);
    expect(hit.headers["x-cache"]).toBe("HIT");
    expect(hit.rawPayload).toEqual(miss.rawPayload);
    const revalidated = await server.inject({
      ...request,
      headers: { ...request.headers, "if-none-match": miss.headers.etag! },
    });
    expect(revalidated.statusCode).toBe(304);
    expect(revalidated.rawPayload).toHaveLength(0);
    expect(revalidated.headers["x-cache"]).toBe("HIT");
    await server.close();
  });
  it("disables cache reads and writes when CACHE_ENABLED is false", async () => {
    const disabledStorage = new MemoryStorage();
    let fetches = 0;
    const server = await createApp(
      { ...testConfig, CACHE_ENABLED: false },
      disabledStorage,
      undefined,
      undefined,
      {
        remoteImageFetcher: async () => {
          fetches += 1;
          return { body: image, contentType: "image/jpeg" };
        },
      },
    );
    await server.ready();
    const url = "/v1/img/w_4/https://example.com/cache-disabled.jpg";
    const first = await server.inject(url);
    const second = await server.inject(url);
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(first.headers["x-cache"]).toBe("MISS");
    expect(second.headers["x-cache"]).toBe("MISS");
    expect(first.headers.etag).toBeDefined();
    expect(fetches).toBe(2);
    expect(await disabledStorage.stats()).toMatchObject({ entries: 0 });
    await server.close();
  });
  it("blocks loopback remote image URLs", async () => {
    const server = await app;
    const response = await server.inject(
      "/v1/img/w_2/https://127.0.0.1/private.jpg",
    );
    expect(response.statusCode).toBe(403);
    expect(response.headers["x-cache"]).toBe("MISS");
    expect(response.body).not.toContain("stack");
    const hashResponse = await server.inject(
      "/v1/hash/http://127.0.0.1/private.jpg",
    );
    expect(hashResponse.statusCode).toBe(403);
    expect(hashResponse.body).not.toContain("stack");
  });

  it("returns a cache hit for a stored remote transform", async () => {
    const server = await app;
    const source = new URL("https://example.com/photo.jpg");
    const ops = [
      { op: "resize", width: 4 },
      { op: "format", format: "webp" },
    ] as const;
    const cachedImage = await sharp(image).resize(4).webp().toBuffer();
    storage.values.set(createCacheKey(source, ops, "webp"), cachedImage);

    const response = await server.inject(
      "/v1/img/w_4,f_webp/https://example.com/photo.jpg",
    );
    expect(response.statusCode).toBe(200);
    expect(response.headers["x-cache"]).toBe("HIT");
    expect(response.headers["content-type"]).toContain("image/webp");
    expect(response.headers.etag).toBeDefined();
    expect(response.headers["cache-control"]).toContain("max-age=60");
    expect(response.rawPayload).toEqual(cachedImage);
  });

  it("coalesces identical cache misses and serves ETag revalidation", async () => {
    const missStorage = new MemoryStorage();
    let fetches = 0;
    const remoteImageFetcher = async () => {
      fetches += 1;
      await new Promise((resolve) => setTimeout(resolve, 25));
      return { body: image, contentType: "image/jpeg" };
    };
    const server = await createApp(
      testConfig,
      missStorage,
      undefined,
      undefined,
      { remoteImageFetcher },
    );
    await server.ready();
    const url = "/v1/img/w_4/https://example.com/coalesced.jpg";
    const [first, second] = await Promise.all([
      server.inject(url),
      server.inject(url),
    ]);

    expect(fetches).toBe(1);
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(first.headers["x-cache"]).toBe("MISS");
    expect(second.headers["x-cache"]).toBe("MISS");
    expect(first.headers.etag).toBe(second.headers.etag);
    expect(await missStorage.stats()).toMatchObject({ entries: 1 });

    const revalidated = await server.inject({
      url,
      headers: { "if-none-match": first.headers.etag },
    });
    expect(revalidated.statusCode).toBe(304);
    expect(revalidated.headers["x-cache"]).toBe("HIT");
    expect(revalidated.headers.etag).toBe(first.headers.etag);
    expect(fetches).toBe(1);
    await server.close();
  });

  it("accepts signed URL requests and rejects tampering and expiry", async () => {
    const secret = "integration-test-secret";
    const server = await createApp(
      {
        ...testConfig,
        SIGNING_SECRET: "rotated-integration-secret",
        SIGNING_SECRET_PREVIOUS: secret,
      },
      new MemoryStorage(),
      undefined,
      undefined,
      {
        remoteImageFetcher: async () => ({
          body: image,
          contentType: "image/jpeg",
        }),
      },
    );
    await server.ready();
    const sourceUrl =
      "http://localhost/v1/img/w_4/https://example.com/signed.jpg";
    const futureExpiry = String(Math.floor(Date.now() / 1000) + 60);
    const signed = new URL(signTransformUrl(sourceUrl, secret, futureExpiry));
    const accepted = await server.inject(`${signed.pathname}${signed.search}`);
    expect(accepted.statusCode).toBe(200);

    const tampered = new URL(signed);
    tampered.pathname = tampered.pathname.replace("w_4", "w_5");
    expect(
      (await server.inject(`${tampered.pathname}${tampered.search}`))
        .statusCode,
    ).toBe(403);
    const tamperedSource = new URL(signed);
    tamperedSource.pathname = tamperedSource.pathname.replace(
      "example.com/signed.jpg",
      "example.com/other.jpg",
    );
    const rejectedSource = await server.inject(
      `${tamperedSource.pathname}${tamperedSource.search}`,
    );
    expect(rejectedSource.statusCode).toBe(403);
    expect(rejectedSource.json()).toEqual({
      error: "Invalid signature",
      code: "SIGNATURE_INVALID",
    });

    const expired = new URL(
      signTransformUrl(
        sourceUrl,
        secret,
        String(Math.floor(Date.now() / 1000) - 10),
      ),
    );
    const expiredResponse = await server.inject(
      `${expired.pathname}${expired.search}`,
    );
    expect(expiredResponse.statusCode).toBe(403);
    expect(expiredResponse.json()).toEqual(rejectedSource.json());
    await server.close();
  });

  it("rejects unsigned URL transforms when SIGNING_REQUIRED is enabled", async () => {
    const server = await createApp(
      { ...testConfig, SIGNING_REQUIRED: true },
      new MemoryStorage(),
      undefined,
      undefined,
      {
        remoteImageFetcher: async () => ({
          body: image,
          contentType: "image/jpeg",
        }),
      },
    );
    await server.ready();
    const response = await server.inject(
      "/v1/img/w_4/https://example.com/unsigned.jpg",
    );
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({
      error: "Invalid signature",
      code: "SIGNATURE_INVALID",
    });
    await server.close();
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
