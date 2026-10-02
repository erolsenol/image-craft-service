import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("production"),
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  MAX_UPLOAD_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(20 * 1024 * 1024),
  MAX_INPUT_PIXELS: z.coerce.number().int().positive().default(40_000_000),
  MAX_OUTPUT_DIMENSION: z.coerce
    .number()
    .int()
    .positive()
    .max(16_384)
    .default(4096),
  REQUEST_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .positive()
    .max(300_000)
    .default(30_000),
  CONCURRENCY_LIMIT: z.coerce.number().int().positive().max(1000).default(8),
  ALLOWED_HOSTS: z.string().default(""),
  SIGNING_SECRET: z.string().optional(),
  CACHE_DIR: z.string().default("/tmp/image-craft-cache"),
  CACHE_MAX_SIZE_BYTES: z.coerce.number().int().positive().default(536_870_912),
  CACHE_MAX_AGE_SECONDS: z.coerce.number().int().nonnegative().default(86400),
  QUEUE_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  REDIS_URL: z.string().url().default("redis://127.0.0.1:6379"),
  BATCH_MAX_ITEMS: z.coerce.number().int().positive().max(100).default(20),
  BATCH_CONCURRENCY: z.coerce.number().int().positive().max(32).default(1),
  BATCH_RESULT_TTL_SECONDS: z.coerce.number().int().positive().default(86400),
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
});

export const config = envSchema.parse(process.env);
export type AppConfig = typeof config;
export const allowedHosts = config.ALLOWED_HOSTS.split(",")
  .map((host) => host.trim().toLowerCase())
  .filter(Boolean);
