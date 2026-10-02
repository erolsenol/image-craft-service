import type { Operation } from "../api/schemas/operations.js";

export interface BatchRequest {
  sources: string[];
  ops: Operation[];
}

export type BatchJobState =
  "waiting" | "delayed" | "active" | "completed" | "failed" | "unknown";

export interface BatchJobStatus {
  id: string;
  state: BatchJobState;
  progress: number;
}

export interface BatchQueue {
  enqueue(input: BatchRequest): Promise<string>;
  get(id: string): Promise<BatchJobStatus | undefined>;
  isReady(): boolean;
  close(): Promise<void>;
}
