export type { paths, components, operations } from "./generated.js";

export type ImageFormat = "jpeg" | "png" | "webp" | "avif" | "auto";

export interface CraftClientOptions {
  readonly baseUrl: string;
}

export class ImageBuilder {
  private width: number | undefined;
  private height: number | undefined;
  private fit: "cover" | "contain" | "fill" | "inside" | "outside" | undefined;
  private outputFormat: ImageFormat | undefined;
  private quality: number | undefined;

  constructor(
    private readonly baseUrl: string,
    source: string,
  ) {
    this.source = normalizeSource(source);
  }

  readonly source: string;

  resize(
    width: number,
    height?: number,
    fit?: "cover" | "contain" | "fill" | "inside" | "outside",
  ): this {
    assertPositiveInteger(width, "width");
    if (height !== undefined) assertPositiveInteger(height, "height");
    this.width = width;
    this.height = height;
    this.fit = fit;
    return this;
  }

  format(format: ImageFormat, quality?: number): this {
    this.outputFormat = format;
    if (quality !== undefined) {
      if (!Number.isInteger(quality) || quality < 1 || quality > 100)
        throw new RangeError("quality must be an integer from 1 to 100");
    }
    this.quality = quality;
    return this;
  }

  url(): string {
    const operations = this.operationTokens();
    const source = encodeURIComponent(this.source);
    return `${this.baseUrl}/v1/img/${operations}/${source}`;
  }

  async signedUrl(
    secret: string,
    options: { expiresInSeconds?: number; expiresAt?: number } = {},
  ): Promise<string> {
    const expiry = resolveExpiry(options);
    const operationString = this.operationTokens();
    const signed = new URL(this.url());
    const prefix = "/v1/img/";
    const prefixIndex = signed.pathname.indexOf(prefix);
    const route = signed.pathname.slice(prefixIndex + prefix.length);
    const separator = route.indexOf("/");
    const rawSource = route.slice(separator + 1);
    const normalizedSource = new URL(decodeURIComponent(rawSource)).toString();
    const canonicalOperations = canonicalizeCompactOperations(operationString);
    const payload = `/v1/img/${canonicalOperations}/${normalizedSource}\n${expiry ?? ""}`;
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const signature = await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(payload),
    );
    const hex = Array.from(new Uint8Array(signature), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    signed.pathname = `${signed.pathname.slice(0, prefixIndex + prefix.length)}${hex}/${operationString}/${rawSource}`;
    if (expiry !== undefined)
      signed.searchParams.set("expires", String(expiry));
    signed.searchParams.delete("sig");
    return signed.toString();
  }

  private operationTokens(): string {
    const tokens: string[] = [];
    if (this.width !== undefined) tokens.push(`w_${this.width}`);
    if (this.height !== undefined) tokens.push(`h_${this.height}`);
    if (this.fit !== undefined) tokens.push(`fit_${this.fit}`);
    if (this.outputFormat !== undefined) tokens.push(`f_${this.outputFormat}`);
    if (this.quality !== undefined) tokens.push(`q_${this.quality}`);
    if (tokens.length === 0)
      throw new Error("At least one transform operation is required");
    return tokens.join(",");
  }
}

export class CraftClient {
  private readonly baseUrl: string;

  constructor(options: CraftClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/u, "");
    new URL(this.baseUrl);
  }

  image(source: string): ImageBuilder {
    return new ImageBuilder(this.baseUrl, source);
  }
}

export function createCraftClient(options: CraftClientOptions): CraftClient {
  return new CraftClient(options);
}

export const craft = createCraftClient({
  baseUrl:
    typeof process !== "undefined" && process.env.IMAGE_CRAFT_URL
      ? process.env.IMAGE_CRAFT_URL
      : "http://localhost:3000",
});

function resolveExpiry(options: {
  expiresInSeconds?: number;
  expiresAt?: number;
}): number | undefined {
  if (options.expiresInSeconds !== undefined && options.expiresAt !== undefined)
    throw new TypeError("Set expiresInSeconds or expiresAt, not both");
  if (options.expiresAt !== undefined) {
    if (!Number.isSafeInteger(options.expiresAt) || options.expiresAt <= 0)
      throw new RangeError("expiresAt must be a positive Unix timestamp");
    return options.expiresAt;
  }
  if (options.expiresInSeconds !== undefined) {
    if (
      !Number.isSafeInteger(options.expiresInSeconds) ||
      options.expiresInSeconds <= 0
    )
      throw new RangeError("expiresInSeconds must be a positive integer");
    return Math.floor(Date.now() / 1000) + options.expiresInSeconds;
  }
  return undefined;
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0)
    throw new RangeError(`${name} must be a positive integer`);
}

function normalizeSource(source: string): string {
  const url = new URL(source);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username.length > 0 ||
    url.password.length > 0
  )
    throw new TypeError("source must be a credential-free HTTP(S) URL");
  url.hash = "";
  return url.toString();
}

function canonicalizeCompactOperations(value: string): string {
  const category = (key: string): string => {
    if (["w", "h", "fit", "strategy", "fx", "fy"].includes(key))
      return "resize";
    if (["f", "q"].includes(key)) return "format";
    return key;
  };
  const groups = new Map<string, string[]>();
  const order: string[] = [];
  for (const token of value.split(",")) {
    const key = token.split("_", 1)[0] ?? token;
    const groupName = category(key);
    const group = groups.get(groupName);
    if (group) group.push(token);
    else {
      groups.set(groupName, [token]);
      order.push(groupName);
    }
  }
  return order.flatMap((name) => groups.get(name)!.sort()).join(",");
}
