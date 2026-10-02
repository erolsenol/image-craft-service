import { describe, expect, it } from "vitest";
import { envSchema } from "../../src/config/index.js";

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
});
