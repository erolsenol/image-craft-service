import type { Storage } from "./storage.js";

export interface PresignedUpload {
  url: string;
  headers: Readonly<Record<string, string>>;
  expiresIn: number;
}

export interface PresignedUploadStorage extends Storage {
  createPresignedUpload(
    key: string,
    contentType: string,
    contentLength: number,
    uploadExpiresInSeconds: number,
    objectTtlSeconds: number,
  ): Promise<PresignedUpload>;
}

export function supportsPresignedUploads(
  storage: Storage,
): storage is PresignedUploadStorage {
  return "createPresignedUpload" in storage;
}
