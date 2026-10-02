import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Readable } from "node:stream";
import type { AppConfig } from "../config/index.js";
import type { PresignedUploadStorage } from "./presigned-upload-storage.js";
import type { StorageStats } from "./storage.js";

export class S3Storage implements PresignedUploadStorage {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(config: AppConfig, client = createS3Client(config)) {
    if (!config.S3_BUCKET)
      throw new Error("S3_BUCKET is required for S3 storage");
    this.client = client;
    this.bucket = config.S3_BUCKET;
  }

  async get(key: string): Promise<Buffer | undefined> {
    let response;
    try {
      response = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
    if (!response.Body) return undefined;
    if (isExpired(response.Metadata?.expiresat)) {
      await this.delete(key);
      return undefined;
    }
    return Buffer.from(await response.Body.transformToByteArray());
  }

  async getStream(key: string): Promise<Readable | undefined> {
    let response;
    try {
      response = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
    if (!response.Body) return undefined;
    if (isExpired(response.Metadata?.expiresat)) {
      await response.Body.transformToWebStream().cancel();
      await this.delete(key);
      return undefined;
    }
    return Readable.from(response.Body as AsyncIterable<Uint8Array>);
  }

  async set(key: string, value: Buffer, ttlSeconds: number): Promise<void> {
    if (!Number.isFinite(ttlSeconds) || ttlSeconds < 0)
      throw new Error("ttlSeconds must be a non-negative number");
    if (ttlSeconds === 0) return this.delete(key);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: value,
        Metadata: { expiresat: String(Date.now() + ttlSeconds * 1000) },
      }),
    );
  }

  async delete(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
    );
  }

  async close(): Promise<void> {
    this.client.destroy();
  }

  async stats(): Promise<StorageStats> {
    let entries = 0;
    let sizeBytes = 0;
    let continuationToken: string | undefined;
    do {
      const page = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          ...(continuationToken
            ? { ContinuationToken: continuationToken }
            : {}),
        }),
      );
      for (const item of page.Contents ?? []) {
        entries += 1;
        sizeBytes += item.Size ?? 0;
      }
      continuationToken = page.IsTruncated
        ? page.NextContinuationToken
        : undefined;
    } while (continuationToken);
    return { entries, sizeBytes, maxSizeBytes: Number.MAX_SAFE_INTEGER };
  }

  async createPresignedUpload(
    key: string,
    contentType: string,
    contentLength: number,
    uploadExpiresInSeconds: number,
    objectTtlSeconds: number,
  ) {
    if (
      !Number.isFinite(uploadExpiresInSeconds) ||
      uploadExpiresInSeconds <= 0 ||
      uploadExpiresInSeconds > 3600 ||
      !Number.isFinite(objectTtlSeconds) ||
      objectTtlSeconds <= 0 ||
      !Number.isSafeInteger(contentLength) ||
      contentLength <= 0
    )
      throw new Error(
        "Presigned upload TTL must be between 1 and 3600 seconds",
      );
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ContentType: contentType,
      ContentLength: contentLength,
      Metadata: { expiresat: String(Date.now() + objectTtlSeconds * 1000) },
    });
    const url = await getSignedUrl(this.client, command, {
      expiresIn: uploadExpiresInSeconds,
      signableHeaders: new Set(["content-type"]),
      unhoistableHeaders: new Set(["x-amz-meta-expiresat"]),
    });
    return {
      url,
      headers: {
        "Content-Type": contentType,
        "x-amz-meta-expiresat": command.input.Metadata!.expiresat!,
      },
      expiresIn: uploadExpiresInSeconds,
    };
  }
}

export function createS3Client(config: AppConfig): S3Client {
  return new S3Client({
    region: config.S3_REGION,
    forcePathStyle: config.S3_FORCE_PATH_STYLE,
    ...(config.S3_ENDPOINT ? { endpoint: config.S3_ENDPOINT } : {}),
    ...(config.S3_ACCESS_KEY_ID && config.S3_SECRET_ACCESS_KEY
      ? {
          credentials: {
            accessKeyId: config.S3_ACCESS_KEY_ID,
            secretAccessKey: config.S3_SECRET_ACCESS_KEY,
          },
        }
      : {}),
  });
}

function isExpired(expiresAt: string | undefined): boolean {
  return expiresAt !== undefined && Number(expiresAt) <= Date.now();
}

function isNotFound(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  if ("name" in error && error.name === "NoSuchKey") return true;
  if (!("$metadata" in error)) return false;
  const metadata = Reflect.get(error, "$metadata");
  return (
    typeof metadata === "object" &&
    metadata !== null &&
    Reflect.get(metadata, "httpStatusCode") === 404
  );
}
