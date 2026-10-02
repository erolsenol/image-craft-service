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

export function createTransformSignature(
  source: string | URL,
  ops: string,
  expires: string | undefined,
  secret: string,
): string {
  const normalizedSource = new URL(source).toString();
  const payload = `${normalizedSource}\n${ops}\n${expires ?? ""}`;
  return signPath(payload, secret);
}

export function verifyTransformSignature(
  source: string | URL,
  ops: string,
  expires: string | undefined,
  signature: string | undefined,
  secret: string | undefined,
  nowMilliseconds = Date.now(),
): boolean {
  if (!secret) return signature === undefined && expires === undefined;
  if (!signature || !/^[a-f0-9]{64}$/iu.test(signature)) return false;
  if (expires !== undefined) {
    if (!/^[0-9]+$/u.test(expires)) return false;
    const expirySeconds = Number(expires);
    if (
      !Number.isSafeInteger(expirySeconds) ||
      expirySeconds <= Math.floor(nowMilliseconds / 1000)
    )
      return false;
  }

  let expected: Buffer;
  try {
    expected = Buffer.from(
      createTransformSignature(source, ops, expires, secret),
      "hex",
    );
  } catch {
    return false;
  }
  const received = Buffer.from(signature, "hex");
  return (
    expected.length === received.length && timingSafeEqual(expected, received)
  );
}

export function signTransformUrl(
  input: string,
  secret: string,
  expires?: string,
): string {
  const url = new URL(input);
  const prefix = "/v1/img/";
  const transformPath = url.pathname.slice(
    url.pathname.indexOf(prefix) + prefix.length,
  );
  const separator = transformPath.indexOf("/");
  if (!url.pathname.includes(prefix) || separator < 1)
    throw new Error("URL must use the /v1/img/:ops/:source route");
  const ops = transformPath.slice(0, separator);
  const source = decodeURIComponent(transformPath.slice(separator + 1));
  const normalizedSource = new URL(source).toString();
  const expiry = expires ?? url.searchParams.get("expires") ?? undefined;
  url.searchParams.delete("sig");
  if (expiry === undefined) url.searchParams.delete("expires");
  else url.searchParams.set("expires", expiry);
  url.searchParams.set(
    "sig",
    createTransformSignature(normalizedSource, ops, expiry, secret),
  );
  return url.toString();
}
