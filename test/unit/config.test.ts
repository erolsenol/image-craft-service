import { describe, expect, it } from "vitest";
import { envSchema } from "../../src/config/index.js";
import { hashApiKey } from "../../src/security/api-keys.js";

describe("security-related configuration bounds", () => {
  it("rejects request buffer budgets above 256 MiB", () => {
    expect(
      envSchema.safeParse({
        MAX_UPLOAD_BYTES: 20 * 1024 * 1024,
        CONCURRENCY_LIMIT: 16,
      }).success,
    ).toBe(false);
  });

  it("rejects pixel budgets above 80 million concurrent pixels", () => {
    expect(
      envSchema.safeParse({
        MAX_INPUT_PIXELS: 40_000_000,
        IMAGE_PROCESSING_CONCURRENCY: 3,
      }).success,
    ).toBe(false);
  });

  it("includes configured output dimensions in the concurrent pixel budget", () => {
    expect(
      envSchema.safeParse({
        MAX_OUTPUT_DIMENSION: 8192,
        IMAGE_PROCESSING_CONCURRENCY: 2,
      }).success,
    ).toBe(false);
  });

  it("rejects batch result memory budgets above 256 MiB", () => {
    expect(
      envSchema.safeParse({
        BATCH_MAX_RESULT_BYTES: 128 * 1024 * 1024,
        BATCH_CONCURRENCY: 3,
      }).success,
    ).toBe(false);
  });

  it("bounds configurable operation chain length", () => {
    expect(envSchema.safeParse({ MAX_OPS_CHAIN: 51 }).success).toBe(false);
    expect(envSchema.safeParse({ MAX_OPS_CHAIN: 32 }).success).toBe(true);
  });

  it("bounds sharp threads and libvips cache memory", () => {
    expect(envSchema.parse({}).SHARP_CONCURRENCY).toBe(2);
    expect(envSchema.parse({}).SHARP_CACHE_MEMORY_MB).toBe(32);
    expect(envSchema.safeParse({ SHARP_CONCURRENCY: 9 }).success).toBe(false);
    expect(envSchema.safeParse({ SHARP_CACHE_MEMORY_MB: 15 }).success).toBe(
      false,
    );
  });

  it("keeps AI plugin timeouts within the HTTP request timeout", () => {
    expect(
      envSchema.safeParse({
        REQUEST_TIMEOUT_MS: 1000,
        AI_PLUGIN_TIMEOUT_MS: 1001,
      }).success,
    ).toBe(false);
    expect(envSchema.safeParse({ AI_PLUGIN_TIMEOUT_MS: 20_000 }).success).toBe(
      true,
    );
  });

  it("accepts hashed API keys with optional known scopes", () => {
    expect(
      envSchema.safeParse({
        API_KEYS: `${hashApiKey("test-key")}=batch:read+batch:write`,
      }).success,
    ).toBe(true);
    expect(envSchema.safeParse({ API_KEYS: "plaintext-secret" }).success).toBe(
      false,
    );
    expect(
      envSchema.safeParse({ API_KEYS: `${hashApiKey("test-key")}=admin` })
        .success,
    ).toBe(false);
  });

  it("accepts exact CORS origins and rejects wildcard or path entries", () => {
    expect(
      envSchema.safeParse({
        CORS_ORIGINS: "https://app.example, http://localhost:5173",
      }).success,
    ).toBe(true);
    expect(envSchema.safeParse({ CORS_ORIGINS: "*" }).success).toBe(false);
    expect(
      envSchema.safeParse({ CORS_ORIGINS: "https://app.example/path" }).success,
    ).toBe(false);
  });

  it("keeps tracing disabled by default and validates the OTLP endpoint", () => {
    expect(envSchema.parse({}).OTEL_ENABLED).toBe(false);
    expect(
      envSchema.safeParse({
        OTEL_ENABLED: "true",
        OTEL_EXPORTER_OTLP_ENDPOINT: "http://otel-collector:4318",
      }).success,
    ).toBe(true);
    expect(
      envSchema.safeParse({ OTEL_EXPORTER_OTLP_ENDPOINT: "not-a-url" }).success,
    ).toBe(false);
    expect(
      envSchema.safeParse({
        OTEL_EXPORTER_OTLP_ENDPOINT: "ftp://collector.example:4318",
      }).success,
    ).toBe(false);
    expect(
      envSchema.safeParse({
        OTEL_EXPORTER_OTLP_ENDPOINT: "https://user:secret@collector.example",
      }).success,
    ).toBe(false);
  });

  it("validates S3 storage settings and credential pairs", () => {
    expect(envSchema.safeParse({ STORAGE_DRIVER: "s3" }).success).toBe(false);
    expect(
      envSchema.safeParse({
        STORAGE_DRIVER: "s3",
        S3_BUCKET: "image-cache",
        S3_ENDPOINT: "http://minio:9000",
        S3_ACCESS_KEY_ID: "local-access",
      }).success,
    ).toBe(false);
    expect(
      envSchema.safeParse({
        STORAGE_DRIVER: "s3",
        S3_BUCKET: "image-cache",
        S3_ENDPOINT: "http://user:secret@minio:9000",
      }).success,
    ).toBe(false);
    expect(
      envSchema.safeParse({
        STORAGE_DRIVER: "s3",
        S3_BUCKET: "image-cache",
        S3_ENDPOINT: "http://minio:9000",
        S3_ACCESS_KEY_ID: "local-access",
        S3_SECRET_ACCESS_KEY: "local-secret",
      }).success,
    ).toBe(true);
  });

  it("validates named source host allowlists and credential headers", () => {
    const valid = JSON.stringify({
      cdn: {
        origin: "https://cdn.example.com/assets/",
        allowedHosts: ["cdn.example.com"],
        headers: { authorization: "Bearer sample" },
      },
    });
    expect(envSchema.safeParse({ NAMED_SOURCES: valid }).success).toBe(true);
    expect(
      envSchema.safeParse({
        NAMED_SOURCES: JSON.stringify({
          cdn: {
            origin: "https://cdn.example.com",
            allowedHosts: ["other.example.com"],
          },
        }),
      }).success,
    ).toBe(false);
    expect(
      envSchema.safeParse({
        NAMED_SOURCES: JSON.stringify({
          cdn: {
            origin: "https://cdn.example.com",
            allowedHosts: ["cdn.example.com"],
            headers: { host: "attacker.example" },
          },
        }),
      }).success,
    ).toBe(false);
    expect(envSchema.safeParse({ NAMED_SOURCES: "not-json" }).success).toBe(
      false,
    );
    expect(
      envSchema.safeParse({
        NAMED_SOURCES: JSON.stringify({
          cdn: {
            origin: "https://cdn.example.com/assets/?token=x",
            allowedHosts: ["cdn.example.com"],
          },
        }),
      }).success,
    ).toBe(false);
  });

  it("accepts blank optional S3 values used by the Compose environment", () => {
    expect(
      envSchema.safeParse({
        S3_ENDPOINT: "",
        S3_BUCKET: "",
        S3_ACCESS_KEY_ID: "",
        S3_SECRET_ACCESS_KEY: "",
        NAMED_SOURCES: "",
      }).success,
    ).toBe(true);
  });
});
