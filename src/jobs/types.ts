import type { Readable } from "node:stream";
import type { Operation } from "../api/schemas/operations.js";

export interface BatchRequest {
  sources: string[];
  ops: Operation[];
  apiKeyId: string;
  webhookUrl?: string;
}

export interface BatchItemError {
  index: number;
  code: string;
  message: string;
}

export interface BatchResultFile {
  storageKey: string;
  name: string;
}

export interface BatchProgress {
  percentage: number;
  completedItems: number;
  totalItems: number;
  errors: BatchItemError[];
}

export interface BatchJobResult {
  files: BatchResultFile[];
  errors: BatchItemError[];
  completedItems: number;
  totalItems: number;
}

export type BatchJobState = "queued" | "active" | "done" | "failed";

export interface BatchJobStatus {
  jobId: string;
  status: BatchJobState;
  progress: number;
  completedItems: number;
  totalItems: number;
  errors: BatchItemError[];
}

export interface BatchQueue {
  enqueue(input: BatchRequest): Promise<string>;
  get(id: string, apiKeyId: string): Promise<BatchJobStatus | undefined>;
  download(id: string, apiKeyId: string): Promise<Readable | undefined>;
  getQueueDepth?(): Promise<{
    waiting: number;
    active: number;
    delayed: number;
  }>;
  isReady(): boolean;
  close(): Promise<void>;
}
