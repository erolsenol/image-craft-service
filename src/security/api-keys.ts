import { createHash, timingSafeEqual } from "node:crypto";

export function resolveBatchClientId(
  providedKey: string | undefined,
  remoteAddress: string,
  configuredKeys: string,
): string | undefined {
  const keys = configuredKeys
    .split(",")
    .map((key) => key.trim())
    .filter(Boolean);
  if (keys.length === 0) return hashValue(`ip:${remoteAddress}`);
  if (!providedKey) return undefined;
  const candidate = hashValue(providedKey);
  const candidateDigest = Buffer.from(candidate, "hex");
  let valid = false;
  for (const key of keys) {
    const matches = timingSafeEqual(
      candidateDigest,
      Buffer.from(hashValue(key), "hex"),
    );
    valid = matches || valid;
  }
  return valid ? candidate : undefined;
}

function hashValue(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
