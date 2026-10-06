export function expirationFromTtl(
  ttlSeconds: number,
  now = Date.now(),
): number {
  const expiration = now + ttlSeconds * 1000;
  if (
    !Number.isFinite(ttlSeconds) ||
    ttlSeconds < 0 ||
    !Number.isFinite(expiration) ||
    expiration > Number.MAX_SAFE_INTEGER
  ) {
    throw new Error(
      "ttlSeconds must produce a finite, safely representable expiration",
    );
  }
  return expiration;
}
