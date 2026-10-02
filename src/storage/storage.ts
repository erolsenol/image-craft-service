export interface StorageStats {
  entries: number;
  sizeBytes: number;
  maxSizeBytes: number;
}

export interface Storage {
  get(key: string): Promise<Buffer | undefined>;
  getStream(key: string): Promise<Readable | undefined>;
  set(key: string, value: Buffer, ttlSeconds: number): Promise<void>;
  delete(key: string): Promise<void>;
  stats(): Promise<StorageStats>;
  close?(): Promise<void>;
}
import type { Readable } from "node:stream";
