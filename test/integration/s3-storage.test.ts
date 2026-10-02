import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { config as defaults, type AppConfig } from "../../src/config/index.js";
import { S3Storage } from "../../src/storage/s3-storage.js";

const endpoint = process.env.S3_TEST_ENDPOINT;
const integration = endpoint ? describe : describe.skip;

integration("S3-compatible storage against MinIO", () => {
  const bucket = `image-craft-test-${randomUUID().slice(0, 8)}`;
  let client: S3Client;
  let storage: S3Storage;

  beforeAll(async () => {
    const config: AppConfig = {
      ...defaults,
      STORAGE_DRIVER: "s3",
      S3_ENDPOINT: endpoint!,
      S3_REGION: process.env.S3_TEST_REGION ?? "us-east-1",
      S3_BUCKET: bucket,
      S3_ACCESS_KEY_ID: process.env.S3_TEST_ACCESS_KEY ?? "minioadmin",
      S3_SECRET_ACCESS_KEY: process.env.S3_TEST_SECRET_KEY ?? "minioadmin",
      S3_FORCE_PATH_STYLE: true,
    };
    storage = new S3Storage(config);
    client = new S3Client({
      endpoint: endpoint!,
      region: config.S3_REGION,
      forcePathStyle: true,
      credentials: {
        accessKeyId: config.S3_ACCESS_KEY_ID!,
        secretAccessKey: config.S3_SECRET_ACCESS_KEY!,
      },
    });
    await retryCreateBucket();
  }, 20_000);

  afterAll(async () => {
    const objects = await client.send(
      new ListObjectsV2Command({ Bucket: bucket }),
    );
    if (objects.Contents?.length)
      await client.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: {
            Objects: objects.Contents.flatMap((object) =>
              object.Key ? [{ Key: object.Key }] : [],
            ),
          },
        }),
      );
    await client.send(new DeleteBucketCommand({ Bucket: bucket }));
    client.destroy();
  });

  it("stores, streams, expires and deletes TTL-bound objects", async () => {
    const value = Buffer.from("minio-backed-cache-value");
    await storage.set("cache:stable", value, 60);
    expect(await storage.get("cache:stable")).toEqual(value);
    const stream = await storage.getStream("cache:stable");
    expect(stream).toBeDefined();
    const chunks: Buffer[] = [];
    for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks)).toEqual(value);
    expect(await storage.stats()).toMatchObject({ entries: 1 });

    await storage.set("cache:expired", value, 0.03);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(await storage.get("cache:expired")).toBeUndefined();
    await storage.delete("cache:stable");
    expect(await storage.get("cache:stable")).toBeUndefined();
  });

  it("accepts a presigned upload and exposes it through Storage", async () => {
    const value = Buffer.from("signed-minio-upload");
    const upload = await storage.createPresignedUpload(
      "uploads/test-object",
      "image/png",
      value.byteLength,
      60,
      3600,
    );
    const response = await fetch(upload.url, {
      method: "PUT",
      headers: upload.headers,
      body: value,
    });
    expect(response.ok).toBe(true);
    expect(await storage.get("uploads/test-object")).toEqual(value);
  });

  async function retryCreateBucket(): Promise<void> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        await client.send(new CreateBucketCommand({ Bucket: bucket }));
        return;
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    throw lastError;
  }
});
