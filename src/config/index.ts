import { z } from "zod";
import { validateApiKeyDefinitions } from "../security/api-keys.js";

const namedSourceSchema = z
  .object({
    origin: z.string().url(),
    allowedHosts: z.array(z.string().regex(/^[a-z0-9.-]+$/iu)).min(1),
    headers: z.record(z.string().min(1), z.string().max(4096)).default({}),
  })
  .superRefine((source, context) => {
    try {
      const origin = new URL(source.origin);
      if (
        !["http:", "https:"].includes(origin.protocol) ||
        origin.username ||
        origin.password ||
        origin.search ||
        origin.hash
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["origin"],
          message: "Named source origins must be credential-free HTTP(S) URLs",
        });
      }
      if (
        !source.allowedHosts.some(
          (host) => host.toLowerCase() === origin.hostname.toLowerCase(),
        )
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["allowedHosts"],
          message: "allowedHosts must include the origin hostname",
        });
      }
    } catch {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["origin"],
        message: "Named source origin must be a valid URL",
      });
    }
    for (const [name, value] of Object.entries(source.headers)) {
      if (
        !["authorization", "x-api-key", "x-access-token"].includes(
          name.toLowerCase(),
        ) ||
        /[\r\n\0]/u.test(value)
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["headers", name],
          message:
            "Named source credentials may use authorization, x-api-key, or x-access-token without control characters",
        });
      }
    }
  });

const namedSourcesSchema = z
  .string()
  .default("{}")
  .transform((value, context) => {
    if (!value.trim()) return {};
    let decoded: unknown;
    try {
      decoded = JSON.parse(value);
    } catch {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "NAMED_SOURCES must be valid JSON",
      });
      return {};
    }
    const parsed = z
      .record(z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/u), namedSourceSchema)
      .safeParse(decoded);
    if (!parsed.success) {
      for (const issue of parsed.error.issues)
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: issue.path,
          message: issue.message,
        });
      return {};
    }
    return parsed.data;
  });

const optionalSecret = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().min(32).optional(),
);
const optionalValue = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().min(1).optional(),
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
    API_KEYS: z.string().default("").refine(validateApiKeyDefinitions, {
      message:
        "API_KEYS must contain SHA-256 digests with optional allowed scopes",
    }),
    API_RATE_LIMIT: z.coerce.number().int().positive().max(10_000).default(120),
    API_RATE_WINDOW_MS: z.coerce
      .number()
      .int()
      .positive()
      .max(3_600_000)
      .default(60_000),
    CORS_ORIGINS: z
      .string()
      .default("")
      .refine((value) => {
        if (!value.trim()) return true;
        return value.split(",").every((origin) => {
          try {
            const parsed = new URL(origin.trim());
            return (
              ["http:", "https:"].includes(parsed.protocol) &&
              parsed.origin === origin.trim() &&
              !parsed.username &&
              !parsed.password
            );
          } catch {
            return false;
          }
        });
      }, "CORS_ORIGINS must be a comma-separated list of exact HTTP(S) origins"),
    OTEL_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    OTEL_EXPORTER_OTLP_ENDPOINT: z
      .string()
      .url()
      .default("http://localhost:4318")
      .refine((value) => {
        try {
          const endpoint = new URL(value);
          return (
            ["http:", "https:"].includes(endpoint.protocol) &&
            !endpoint.username &&
            !endpoint.password
          );
        } catch {
          return false;
        }
      }, "OTEL_EXPORTER_OTLP_ENDPOINT must be an HTTP(S) URL without credentials"),
    ALLOWED_HOSTS: z.string().default(""),
    NAMED_SOURCES: namedSourcesSchema,
    SIGNING_SECRET: z.string().optional(),
    STORAGE_DRIVER: z.enum(["disk", "s3"]).default("disk"),
    CACHE_DIR: z.string().default("/tmp/image-craft-cache"),
    CACHE_MAX_SIZE_BYTES: z.coerce
      .number()
      .int()
      .positive()
      .default(536_870_912),
    CACHE_MAX_AGE_SECONDS: z.coerce.number().int().nonnegative().default(86400),
    S3_ENDPOINT: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.string().url().optional(),
    ),
    S3_REGION: z.string().min(1).default("us-east-1"),
    S3_BUCKET: optionalValue,
    S3_ACCESS_KEY_ID: optionalValue,
    S3_SECRET_ACCESS_KEY: optionalValue,
    S3_FORCE_PATH_STYLE: z
      .enum(["true", "false"])
      .default("true")
      .transform((value) => value === "true"),
    S3_PRESIGNED_UPLOAD_TTL_SECONDS: z.coerce
      .number()
      .int()
      .positive()
      .max(3600)
      .default(900),
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
      .default("http://rembg:8000")
      .refine((value) => {
        const url = new URL(value);
        return (
          ["http:", "https:"].includes(url.protocol) &&
          !url.username &&
          !url.password
        );
      }, "REMBG_URL must be an HTTP(S) URL without credentials"),
    UPSCALE_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    UPSCALE_URL: z
      .string()
      .url()
      .default("http://realesrgan:8000")
      .refine(
        isCredentialFreeHttpUrl,
        "UPSCALE_URL must be an HTTP(S) URL without credentials",
      ),
    AUTO_ALT_TEXT_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    AUTO_ALT_TEXT_URL: z
      .string()
      .url()
      .default("http://vision-worker:8000")
      .refine(
        isCredentialFreeHttpUrl,
        "AUTO_ALT_TEXT_URL must be an HTTP(S) URL without credentials",
      ),
    NSFW_CHECK_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    NSFW_CHECK_URL: z
      .string()
      .url()
      .default("http://nsfw-worker:8000")
      .refine(
        isCredentialFreeHttpUrl,
        "NSFW_CHECK_URL must be an HTTP(S) URL without credentials",
      ),
    AI_PLUGIN_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .positive()
      .max(300_000)
      .default(20_000),
  })
  .superRefine((settings, context) => {
    if (settings.AI_PLUGIN_TIMEOUT_MS > settings.REQUEST_TIMEOUT_MS)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["AI_PLUGIN_TIMEOUT_MS"],
        message: "AI_PLUGIN_TIMEOUT_MS cannot exceed REQUEST_TIMEOUT_MS",
      });
    if (settings.STORAGE_DRIVER === "s3" && !settings.S3_BUCKET)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["S3_BUCKET"],
        message: "S3_BUCKET is required when STORAGE_DRIVER=s3",
      });
    if (
      Boolean(settings.S3_ACCESS_KEY_ID) !==
      Boolean(settings.S3_SECRET_ACCESS_KEY)
    )
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["S3_SECRET_ACCESS_KEY"],
        message: "S3 access key ID and secret access key must be set together",
      });
    if (settings.S3_ENDPOINT && !isCredentialFreeHttpUrl(settings.S3_ENDPOINT))
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["S3_ENDPOINT"],
        message: "S3_ENDPOINT must use HTTP(S)",
      });
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

function isCredentialFreeHttpUrl(value: string): boolean {
  try {
    const endpoint = new URL(value);
    return (
      ["http:", "https:"].includes(endpoint.protocol) &&
      !endpoint.username &&
      !endpoint.password
    );
  } catch {
    return false;
  }
}
