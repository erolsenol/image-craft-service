import { AppError } from "../core/errors.js";
import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { IncomingHttpHeaders } from "node:http";
import ipaddr from "ipaddr.js";

const forbiddenRanges: Array<[string, number]> = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
  ["::", 128],
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
  ["2001:db8::", 32],
];

export function isPublicIp(address: string): boolean {
  if (!ipaddr.isValid(address)) return false;
  const ip = ipaddr.parse(address);
  const normalized =
    ip.kind() === "ipv6" &&
    ip instanceof ipaddr.IPv6 &&
    ip.isIPv4MappedAddress()
      ? ip.toIPv4Address()
      : ip;
  return !forbiddenRanges.some(([range, prefix]) => {
    const parsedRange = ipaddr.parse(range);
    return (
      normalized.kind() === parsedRange.kind() &&
      normalized.match(parsedRange, prefix)
    );
  });
}

export async function resolvePublicAddresses(
  hostname: string,
): Promise<string[]> {
  if (
    hostname.toLowerCase() === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local")
  ) {
    throw new AppError("Remote host is not allowed", 403);
  }
  const records = await lookup(hostname, { all: true, verbatim: true });
  if (
    records.length === 0 ||
    records.some(({ address }) => !isPublicIp(address))
  ) {
    throw new AppError("Remote host is not allowed", 403);
  }
  return records.map(({ address }) => address);
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
  },
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
    const addresses = await withTimeout(
      resolvePublicAddresses(hostname),
      remainingMs,
    );
    const result = await requestPinned(
      current,
      addresses[0]!,
      remainingMs,
      options.maxBytes,
    );
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
      () => reject(new Error("Remote request timed out")),
      timeoutMs,
    );
    promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

function requestPinned(
  url: URL,
  address: string,
  timeoutMs: number,
  maxBytes: number,
): Promise<{ statusCode: number; headers: IncomingHttpHeaders; body: Buffer }> {
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
          "user-agent": "image-craft-service/0.1.0",
        },
      },
      (response) => {
        if (
          response.statusCode &&
          response.statusCode >= 300 &&
          response.statusCode < 400
        ) {
          response.resume();
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
            request.destroy(new Error("Remote image exceeds size limit"));
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
      () => request.destroy(new Error("Remote request timed out")),
      timeoutMs,
    );
    hardTimeout.unref();
    request.on("close", () => clearTimeout(hardTimeout));
    request.on("timeout", () =>
      request.destroy(new Error("Remote request timed out")),
    );
    request.on("error", reject);
    request.end();
  });
}
