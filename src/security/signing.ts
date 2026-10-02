import { createHmac, timingSafeEqual } from "node:crypto";
export function signPath(path: string, secret: string): string {
  return createHmac("sha256", secret).update(path).digest("hex");
}
export function verifySignature(
  path: string,
  signature: string | undefined,
  secret: string | undefined,
): boolean {
  if (!secret) return true;
  if (!signature || !/^[a-f0-9]{64}$/i.test(signature)) return false;
  const expected = Buffer.from(signPath(path, secret), "hex");
  const received = Buffer.from(signature, "hex");
  return (
    expected.length === received.length && timingSafeEqual(expected, received)
  );
}
