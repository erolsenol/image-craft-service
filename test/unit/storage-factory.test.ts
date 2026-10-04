import { describe, expect, it } from "vitest";
import { config as defaults, type AppConfig } from "../../src/config/index.js";
import { createStorage } from "../../src/storage/create-storage.js";
import { DiskStorage } from "../../src/storage/disk-storage.js";
import { S3Storage } from "../../src/storage/s3-storage.js";

describe("configured storage adapter", () => {
  it("selects disk by default", () => {
    expect(createStorage(defaults)).toBeInstanceOf(DiskStorage);
  });

  it("switches cache and output storage to S3 from configuration", () => {
    const s3Config: AppConfig = {
      ...defaults,
      STORAGE_DRIVER: "s3",
      S3_BUCKET: "image-craft-test",
    };
    expect(createStorage(s3Config)).toBeInstanceOf(S3Storage);
  });

  it("presigns an exact-length PUT and supplies its required headers", async () => {
    const storage = new S3Storage({
      ...defaults,
      STORAGE_DRIVER: "s3",
      S3_ENDPOINT: "http://storage.example.test",
      S3_BUCKET: "image-craft",
      S3_ACCESS_KEY_ID: "test-access-key",
      S3_SECRET_ACCESS_KEY: "test-secret-key",
    });
    const upload = await storage.createPresignedUpload(
      "batch-upload:file_test",
      "image/png",
      1234,
      60,
      3600,
    );
    const url = new URL(upload.url);
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toContain(
      "content-length",
    );
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toContain(
      "content-type",
    );
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toContain(
      "x-amz-meta-expiresat",
    );
    expect(upload.headers).toMatchObject({
      "Content-Type": "image/png",
      "x-amz-meta-expiresat": expect.any(String),
    });
    expect(upload.expiresIn).toBe(60);
  });
});
