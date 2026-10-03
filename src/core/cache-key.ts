import { createHash } from "node:crypto";
import type { Operation } from "../api/schemas/operations.js";

export function createCacheKey(
  source: string | URL,
  ops: readonly Operation[],
  resolvedOutputFormat: string,
  sourceScope = "",
): string {
  const normalizedSource = normalizeSource(source);
  const canonicalOps = JSON.stringify(ops.map(normalizeOperation));
  const input = JSON.stringify([
    normalizedSource,
    sourceScope,
    canonicalOps,
    resolvedOutputFormat.toLowerCase(),
  ]);
  return createHash("sha256").update(input).digest("hex");
}

function normalizeSource(source: string | URL): string {
  const url = new URL(source);
  url.hostname = url.hostname.toLowerCase();
  url.hash = "";
  return url.toString();
}

function normalizeOperation(operation: Operation): unknown {
  const normalized = { ...operation } as Record<string, unknown>;

  switch (operation.op) {
    case "resize":
      removeDefault(normalized, "fit", "cover");
      break;
    case "crop":
      removeDefault(normalized, "left", 0);
      removeDefault(normalized, "top", 0);
      break;
    case "blur":
    case "sharpen":
      removeDefault(normalized, "sigma", 1);
      break;
    case "watermark": {
      const position = normalized.position;
      const gravity = normalized.gravity ?? position;
      delete normalized.position;
      delete normalized.gravity;
      if (gravity !== undefined && gravity !== "southeast") {
        normalized.gravity = gravity;
      }
      removeDefault(normalized, "opacity", 1);
      break;
    }
    case "format":
      // The concrete format is part of the key separately, after negotiation.
      delete normalized.format;
      break;
    case "padding":
      removeDefault(normalized, "top", 0);
      removeDefault(normalized, "right", 0);
      removeDefault(normalized, "bottom", 0);
      removeDefault(normalized, "left", 0);
      removeDefault(normalized, "background", "#00000000");
      if (typeof normalized.background === "string") {
        normalized.background = normalized.background.toLowerCase();
      }
      break;
    case "tint":
      normalized.color = operation.color.toLowerCase();
      break;
    case "adjust":
      removeDefault(normalized, "brightness", 1);
      removeDefault(normalized, "contrast", 0);
      removeDefault(normalized, "saturation", 1);
      break;
    default:
      break;
  }

  return sortObjectKeys(normalized);
}

function removeDefault(
  value: Record<string, unknown>,
  property: string,
  defaultValue: unknown,
): void {
  if (value[property] === defaultValue) delete value[property];
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
