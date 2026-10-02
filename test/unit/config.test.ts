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
});
