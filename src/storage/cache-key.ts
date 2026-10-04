import { createHash } from "node:crypto";
import type { Operation } from "../api/schemas/operations.js";

export function createCacheKey(
  source: string | URL,
  ops: readonly Operation[],
  outputFormat = getOutputFormat(ops),
  sourceScope = "",
  frame?: number,
): string {
  const sourceUrl = new URL(source);
  sourceUrl.hash = "";
  const canonicalSource = sourceUrl.toString();
  const normalizedOps = ops.map((operation) => {
    switch (operation.op) {
      case "resize":
        return { ...operation, fit: operation.fit ?? "cover" };
      case "sharpen":
        return { ...operation, sigma: operation.sigma ?? 1 };
      case "watermark":
        return {
          ...operation,
          gravity: operation.gravity ?? "southeast",
          opacity: operation.opacity ?? 1,
        };
      default:
        return { ...operation };
    }
  });
  const canonicalOps = JSON.stringify(sortObjectKeys(normalizedOps));
  const input = JSON.stringify({
    source: canonicalSource,
    sourceScope,
    ops: canonicalOps,
    outputFormat,
    ...(frame === undefined ? {} : { frame }),
  });
  return createHash("sha256").update(input).digest("hex");
}

export function getOutputFormat(ops: readonly Operation[]): string {
  return (
    [...ops].reverse().find((operation) => operation.op === "format")?.format ??
    "preserve"
  );
}

function sortObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortObjectKeys);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, sortObjectKeys(item)]),
  );
}
