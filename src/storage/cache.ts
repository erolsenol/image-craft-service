export interface CacheAdapter {
  get(key: string): Promise<Buffer | undefined>;
  set(key: string, value: Buffer): Promise<void>;
}
