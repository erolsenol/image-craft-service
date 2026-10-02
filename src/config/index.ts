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
  CACHE_MAX_AGE_SECONDS: z.coerce.number().int().nonnegative().default(86400),
});

export const config = envSchema.parse(process.env);
export type AppConfig = typeof config;
export const allowedHosts = config.ALLOWED_HOSTS.split(",")
  .map((host) => host.trim().toLowerCase())
  .filter(Boolean);
