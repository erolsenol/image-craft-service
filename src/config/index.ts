import { z } from "zod";

const optionalSecret = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().min(32).optional(),
);

export const envSchema = z
  .object({
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("production"),
    HOST: z.string().default("0.0.0.0"),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    MAX_UPLOAD_BYTES: z.coerce
      .number()
      .int()
      .positive()
      .max(128 * 1024 * 1024)
      .default(20 * 1024 * 1024),
    MAX_INPUT_PIXELS: z.coerce
      .number()
      .int()
      .positive()
      .max(100_000_000)
      .default(40_000_000),
    MAX_OUTPUT_DIMENSION: z.coerce
      .number()
      .int()
      .positive()
      .max(8192)
      .default(4096),
    REQUEST_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .positive()
      .max(300_000)
      .default(30_000),
    CONCURRENCY_LIMIT: z.coerce.number().int().positive().max(16).default(8),
    REMOTE_TRANSFORM_RATE_LIMIT: z.coerce
      .number()
      .int()
      .positive()
      .max(10_000)
      .default(60),
    REMOTE_TRANSFORM_RATE_WINDOW_MS: z.coerce
      .number()
      .int()
      .positive()
      .max(3_600_000)
      .default(60_000),
    IMAGE_PROCESSING_CONCURRENCY: z.coerce
      .number()
      .int()
      .positive()
      .max(4)
      .default(2),
    MAX_OPS_CHAIN: z.coerce.number().int().positive().max(50).default(20),
    API_KEYS: z.string().default(""),
    ALLOWED_HOSTS: z.string().default(""),
    SIGNING_SECRET: z.string().optional(),
    CACHE_DIR: z.string().default("/tmp/image-craft-cache"),
    CACHE_MAX_SIZE_BYTES: z.coerce
      .number()
      .int()
      .positive()
      .default(536_870_912),
    CACHE_MAX_AGE_SECONDS: z.coerce.number().int().nonnegative().default(86400),
    QUEUE_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    REDIS_URL: z.string().url().default("redis://127.0.0.1:6379"),
    BATCH_MAX_ITEMS: z.coerce.number().int().positive().max(100).default(100),
    BATCH_CONCURRENCY: z.coerce.number().int().positive().max(4).default(1),
    BATCH_CONCURRENCY_PER_API_KEY: z.coerce
      .number()
      .int()
      .positive()
      .max(100)
      .default(2),
    BATCH_RATE_LIMIT_PER_API_KEY: z.coerce
      .number()
      .int()
      .positive()
      .max(10_000)
      .default(10),
    BATCH_RATE_WINDOW_MS: z.coerce
      .number()
      .int()
      .positive()
      .max(3_600_000)
      .default(60_000),
    BATCH_JOB_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
    BATCH_BACKOFF_DELAY_MS: z.coerce
      .number()
      .int()
      .positive()
      .max(300_000)
      .default(1_000),
    BATCH_MAX_RESULT_BYTES: z.coerce
      .number()
      .int()
      .positive()
      .max(128 * 1024 * 1024)
      .default(128 * 1024 * 1024),
    BATCH_RESULT_TTL_SECONDS: z.coerce.number().int().positive().default(86400),
    WEBHOOK_SIGNING_SECRET: optionalSecret,
    REMOVE_BACKGROUND_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    REMBG_URL: z
      .string()
      .url()
      .default("http://rembg:7000")
      .refine((value) => {
        const url = new URL(value);
        return (
          ["http:", "https:"].includes(url.protocol) &&
          !url.username &&
          !url.password
        );
      }, "REMBG_URL must be an HTTP(S) URL without credentials"),
  })
  .superRefine((settings, context) => {
    if (
      settings.MAX_UPLOAD_BYTES * settings.CONCURRENCY_LIMIT >
      256 * 1024 * 1024
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["CONCURRENCY_LIMIT"],
        message:
          "MAX_UPLOAD_BYTES times CONCURRENCY_LIMIT must not exceed 256 MiB",
      });
    }
    if (
      Math.max(
        settings.MAX_INPUT_PIXELS,
        settings.MAX_OUTPUT_DIMENSION * settings.MAX_OUTPUT_DIMENSION,
      ) *
        settings.IMAGE_PROCESSING_CONCURRENCY >
      80_000_000
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["IMAGE_PROCESSING_CONCURRENCY"],
        message:
          "Input/output pixel budget times IMAGE_PROCESSING_CONCURRENCY must not exceed 80 million pixels",
      });
    }
    if (
      settings.BATCH_MAX_RESULT_BYTES * settings.BATCH_CONCURRENCY >
      128 * 1024 * 1024
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["BATCH_CONCURRENCY"],
        message:
          "BATCH_MAX_RESULT_BYTES times BATCH_CONCURRENCY must not exceed 128 MiB",
      });
    }
  });

export const config = envSchema.parse(process.env);
export type AppConfig = typeof config;
export const allowedHosts = config.ALLOWED_HOSTS.split(",")
  .map((host) => host.trim().toLowerCase())
  .filter(Boolean);
