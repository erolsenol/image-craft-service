import { AppError } from "../core/errors.js";
import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { IncomingHttpHeaders } from "node:http";
import ipaddr from "ipaddr.js";

export function isPublicIp(address: string): boolean {
  if (!ipaddr.isValid(address)) return false;
  const ip = ipaddr.parse(address);
  const normalized =
    ip.kind() === "ipv6" &&
    ip instanceof ipaddr.IPv6 &&
    ip.isIPv4MappedAddress()
      ? ip.toIPv4Address()
      : ip;
  return normalized.range() === "unicast";
}

export async function resolvePublicAddresses(
  hostname: string,
  resolver: (hostname: string) => Promise<string[]> = lookupAddresses,
): Promise<string[]> {
  if (
    hostname.toLowerCase() === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local")
  ) {
    throw new AppError("Remote host is not allowed", 403);
  }
  const addresses = await resolver(hostname);
  if (
    addresses.length === 0 ||
    addresses.some((address) => !isPublicIp(address))
  ) {
    throw new AppError("Remote host is not allowed", 403);
  }
  return addresses;
}

async function lookupAddresses(hostname: string): Promise<string[]> {
  const records = await lookup(hostname, { all: true, verbatim: true });
  return records.map(({ address }) => address);
}

export interface PinnedResponse {
  statusCode: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

export interface RemoteFetchDependencies {
  resolveAddresses?: (hostname: string) => Promise<string[]>;
  requestPinned?: (
    url: URL,
    address: string,
    timeoutMs: number,
    maxBytes: number,
    headers?: Readonly<Record<string, string>>,
  ) => Promise<PinnedResponse>;
}

export interface RemoteResponse {
  body: Buffer;
  contentType: string | undefined;
}

export async function fetchRemoteImage(
  input: string,
  options: {
    allowedHosts: readonly string[];
    timeoutMs: number;
    maxBytes: number;
    headers?: Readonly<Record<string, string>>;
    credentialOrigin?: string;
  },
  dependencies: RemoteFetchDependencies = {},
): Promise<RemoteResponse> {
  let current = new URL(input);
  const deadline = Date.now() + options.timeoutMs;
  for (let redirect = 0; redirect <= 5; redirect += 1) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) throw new AppError("Remote request timed out", 504);
    if (
      !["http:", "https:"].includes(current.protocol) ||
      current.username ||
      current.password
    ) {
      throw new AppError("Remote URL is not allowed", 400);
    }
    const hostname = current.hostname.toLowerCase();
    if (
      options.allowedHosts.length > 0 &&
      !options.allowedHosts.some(
        (host) => hostname === host || hostname.endsWith(`.${host}`),
      )
    ) {
      throw new AppError("Remote host is not allowed", 403);
    }
    const resolvedAddresses = dependencies.resolveAddresses
      ? resolvePublicAddresses(hostname, dependencies.resolveAddresses)
      : resolvePublicAddresses(hostname);
    const addresses = await withTimeout(resolvedAddresses, remainingMs);
    let result: PinnedResponse;
    try {
      result = await (dependencies.requestPinned ?? requestPinned)(
        current,
        addresses[0]!,
        remainingMs,
        options.maxBytes,
        current.origin === options.credentialOrigin
          ? options.headers
          : undefined,
      );
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError("Remote image request failed", 502);
    }
    if (
      result.statusCode >= 300 &&
      result.statusCode < 400 &&
      result.headers.location
    ) {
      if (redirect === 5) throw new AppError("Too many redirects", 400);
      current = new URL(result.headers.location, current);
      continue;
    }
    if (result.statusCode < 200 || result.statusCode >= 300)
      throw new AppError("Remote image request failed", 502);
    return { body: result.body, contentType: result.headers["content-type"] };
  }
  throw new AppError("Too many redirects", 400);
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new AppError("Remote request timed out", 504)),
      timeoutMs,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function requestPinned(
  url: URL,
  address: string,
  timeoutMs: number,
  maxBytes: number,
  additionalHeaders?: Readonly<Record<string, string>>,
): Promise<PinnedResponse> {
  return new Promise((resolve, reject) => {
    const requestFn = url.protocol === "https:" ? httpsRequest : httpRequest;
    const request = requestFn(
      url,
      {
        timeout: timeoutMs,
        lookup: (_hostname, _options, callback) =>
          callback(
            null,
            address,
            ipaddr.parse(address).kind() === "ipv4" ? 4 : 6,
          ),
        headers: {
          accept: "image/*",
          "user-agent": "image-craft-service/0.7.0",
          ...additionalHeaders,
        },
      },
      (response) => {
        if (
          response.statusCode &&
          response.statusCode >= 300 &&
          response.statusCode < 400
        ) {
          response.destroy();
          resolve({
            statusCode: response.statusCode,
            headers: response.headers,
            body: Buffer.alloc(0),
          });
          return;
        }
        const chunks: Buffer[] = [];
        let total = 0;
        response.on("data", (chunk: Buffer) => {
          total += chunk.length;
          if (total > maxBytes) {
            request.destroy(
              new AppError("Remote image exceeds size limit", 413),
            );
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () =>
          resolve({
            statusCode: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks),
          }),
        );
        response.on("error", reject);
      },
    );
    const hardTimeout = setTimeout(
      () => request.destroy(new AppError("Remote request timed out", 504)),
      timeoutMs,
    );
    hardTimeout.unref();
    request.on("close", () => clearTimeout(hardTimeout));
    request.on("timeout", () =>
      request.destroy(new AppError("Remote request timed out", 504)),
    );
    request.on("error", reject);
    request.end();
  });
}
