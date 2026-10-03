export interface CacheMeta {
  contentType: string;
  createdAt: number;
  expiresAt?: number;
  etag: string;
}

export interface Storage {
  get(key: string): Promise<{ data: Buffer; meta: CacheMeta } | null>;
  set(
    key: string,
    data: Buffer,
    meta: CacheMeta,
    ttlSeconds?: number,
  ): Promise<void>;
  delete(key: string): Promise<void>;
  stats(): Promise<{ items: number; bytes: number }>;
}
