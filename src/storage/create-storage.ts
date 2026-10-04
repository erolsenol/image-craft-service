import type { AppConfig } from "../config/index.js";
import type { Storage } from "./storage.js";
import { DiskStorage } from "./disk-storage.js";
import { S3Storage } from "./s3-storage.js";

export function createStorage(config: AppConfig): Storage {
  return config.STORAGE_DRIVER === "s3"
    ? new S3Storage(config)
    : new DiskStorage(config.CACHE_DIR, config.CACHE_MAX_SIZE_BYTES);
}
