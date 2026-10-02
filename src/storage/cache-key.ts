import { createHash } from "node:crypto";
import type { Operation } from "../api/schemas/operations.js";

export function createCacheKey(
  source: string | URL,
  ops: readonly Operation[],
): string {
  const canonicalSource = new URL(source).toString();
  const normalizedOps = ops.map((operation) => {
    switch (operation.op) {
      case "resize":
        return { ...operation, fit: operation.fit ?? "cover" };
      case "sharpen":
        return { ...operation, sigma: operation.sigma ?? 1 };
      case "watermark":
        return { ...operation, gravity: operation.gravity ?? "southeast" };
      default:
        return { ...operation };
    }
  });
  const input = JSON.stringify({ source: canonicalSource, ops: normalizedOps });
  return createHash("sha256").update(input).digest("hex");
}
