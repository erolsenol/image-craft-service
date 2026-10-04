import { createHmac, timingSafeEqual } from "node:crypto";

export interface TransformSigningOptions {
  readonly previousSecret?: string;
  readonly required?: boolean;
  readonly nowMilliseconds?: number;
  readonly frame?: string;
}

export function signPath(path: string, secret: string): string {
  return createHmac("sha256", secret).update(path).digest("hex");
}

export function verifySignature(
  path: string,
  signature: string | undefined,
  secret: string | undefined,
): boolean {
  if (!secret) return true;
  return constantTimeSignatureMatch(path, signature, [secret]);
}

export function createTransformSignature(
  source: string | URL,
  ops: string,
  expires: string | undefined,
  secret: string,
  frame?: string,
): string {
  const normalizedSource = new URL(source).toString();
  return signPath(
    transformPayload(normalizedSource, ops, expires, frame),
    secret,
  );
}

export function verifyTransformSignature(
  source: string | URL,
  ops: string,
  expires: string | undefined,
  signature: string | undefined,
  secret: string | undefined,
  optionsOrNow: TransformSigningOptions | number = {},
): boolean {
  const options =
    typeof optionsOrNow === "number"
      ? { nowMilliseconds: optionsOrNow }
      : optionsOrNow;
  const secrets = [secret, options.previousSecret].filter(
    (value): value is string => Boolean(value),
  );

  if (!signature)
    return secrets.length === 0 && !options.required && expires === undefined;
  if (secrets.length === 0 || !/^[a-f0-9]{64}$/iu.test(signature)) return false;
  if (expires !== undefined) {
    if (!/^[0-9]+$/u.test(expires)) return false;
    const expirySeconds = Number(expires);
    if (
      !Number.isSafeInteger(expirySeconds) ||
      expirySeconds <=
        Math.floor((options.nowMilliseconds ?? Date.now()) / 1000)
    )
      return false;
  }

  let payload: string;
  try {
    payload = transformPayload(
      new URL(source).toString(),
      ops,
      expires,
      options.frame,
    );
  } catch {
    return false;
  }
  const received = Buffer.from(signature, "hex");
  let matched = false;
  for (const candidate of secrets) {
    const expected = Buffer.from(signPath(payload, candidate), "hex");
    const equal =
      expected.length === received.length &&
      timingSafeEqual(expected, received);
    matched = equal || matched;
  }
  return matched;
}

export function signTransformUrl(
  input: string,
  secret: string,
  expires?: string,
): string {
  const url = new URL(input);
  const prefix = "/v1/img/";
  const prefixIndex = url.pathname.indexOf(prefix);
  if (prefixIndex < 0)
    throw new Error("URL must use the /v1/img/<ops>/<source> route");

  const route = url.pathname.slice(prefixIndex + prefix.length);
  const firstSeparator = route.indexOf("/");
  if (firstSeparator < 1)
    throw new Error("URL must use the /v1/img/<ops>/<source> route");

  const firstSegment = route.slice(0, firstSeparator);
  const isAlreadySigned = /^[a-f0-9]{64}$/iu.test(firstSegment);
  const remainingRoute = isAlreadySigned
    ? route.slice(firstSeparator + 1)
    : route;
  const separator = remainingRoute.indexOf("/");
  if (separator < 1)
    throw new Error("URL must use the /v1/img/<ops>/<source> route");

  const ops = remainingRoute.slice(0, separator);
  const rawSource = remainingRoute.slice(separator + 1);
  let source: string;
  try {
    source = decodeURIComponent(rawSource);
  } catch {
    throw new Error("URL contains an invalid source encoding");
  }
  const normalizedSource = new URL(source).toString();
  const expiry = expires ?? url.searchParams.get("expires") ?? undefined;
  const signature = createTransformSignature(
    normalizedSource,
    ops,
    expiry,
    secret,
    url.searchParams.get("frame") ?? undefined,
  );
  url.pathname = `${url.pathname.slice(0, prefixIndex + prefix.length)}${signature}/${ops}/${rawSource}`;
  url.searchParams.delete("sig");
  if (expiry === undefined) url.searchParams.delete("expires");
  else url.searchParams.set("expires", expiry);
  return url.toString();
}

export function canonicalizeOps(ops: string): string {
  const parameters = ops
    .split(",")
    .map((parameter) => parameter.trim())
    .filter(Boolean);
  const seenKeys = new Set<string>();
  const groups = new Map<string, string[]>();
  const categoryOrder: string[] = [];
  for (const parameter of parameters) {
    const separator = parameter.indexOf("_");
    const key = separator < 0 ? parameter : parameter.slice(0, separator);
    if (seenKeys.has(key)) return parameters.join(",");
    seenKeys.add(key);
    const category = operationCategory(key);
    const group = groups.get(category);
    if (group) group.push(parameter);
    else {
      groups.set(category, [parameter]);
      categoryOrder.push(category);
    }
  }
  return categoryOrder
    .flatMap((category) => groups.get(category)!.sort())
    .join(",");
}

function operationCategory(key: string): string {
  if (["w", "h", "fit", "strategy", "fx", "fy"].includes(key)) return "resize";
  if (["l", "t", "cw", "ch", "cstrategy", "cfx", "cfy"].includes(key))
    return "crop";
  if (key === "rot") return "rotate";
  if (key === "blur") return "blur";
  if (key === "sharp") return "sharpen";
  if (key === "gray") return "grayscale";
  if (["wm", "wmimg", "grav", "pos", "wmop"].includes(key)) return "watermark";
  if (["f", "q"].includes(key)) return "format";
  if (["padtop", "padright", "padbottom", "padleft", "bg"].includes(key))
    return "padding";
  if (key === "flip") return "flip";
  if (key === "flop") return "flop";
  if (key === "tint") return "tint";
  if (["bright", "contrast", "sat"].includes(key)) return "adjust";
  if (key === "radius") return "roundedCorners";
  return `unknown:${key}`;
}

function transformPayload(
  normalizedSource: string,
  ops: string,
  expires: string | undefined,
  frame?: string,
): string {
  return `/v1/img/${canonicalizeOps(ops)}/${normalizedSource}\n${expires ?? ""}${frame === undefined ? "" : `\nframe=${frame}`}`;
}

function constantTimeSignatureMatch(
  payload: string,
  signature: string | undefined,
  secrets: readonly string[],
): boolean {
  if (!signature || !/^[a-f0-9]{64}$/iu.test(signature)) return false;
  const received = Buffer.from(signature, "hex");
  let matched = false;
  for (const secret of secrets) {
    const expected = Buffer.from(signPath(payload, secret), "hex");
    const equal =
      expected.length === received.length &&
      timingSafeEqual(expected, received);
    matched = equal || matched;
  }
  return matched;
}
