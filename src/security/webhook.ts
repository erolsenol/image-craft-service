import { createHmac } from "node:crypto";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import ipaddr from "ipaddr.js";
import { AppError } from "../core/errors.js";
import { isPublicIp, resolvePublicAddresses } from "./ssrf.js";

export interface WebhookDependencies {
  resolveAddresses?: (hostname: string) => Promise<string[]>;
  requestPinned?: (
    url: URL,
    address: string,
    body: string,
    signature: string,
    timestamp: string,
    timeoutMs: number,
  ) => Promise<number>;
}

export async function assertPublicWebhookUrl(
  input: string,
  resolveAddresses: (hostname: string) => Promise<string[]> = (hostname) =>
    resolvePublicAddresses(hostname),
): Promise<URL> {
  const { url } = await resolveWebhookTarget(input, resolveAddresses);
  return url;
}

async function resolveWebhookTarget(
  input: string,
  resolveAddresses: (hostname: string) => Promise<string[]> = (hostname) =>
    resolvePublicAddresses(hostname),
): Promise<{ url: URL; addresses: string[] }> {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new AppError("Webhook URL is invalid", 400);
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  ) {
    throw new AppError("Webhook URL is not allowed", 400);
  }
  const addresses = await resolveAddresses(url.hostname);
  if (
    addresses.length === 0 ||
    addresses.some((address) => !isPublicIp(address))
  )
    throw new AppError("Webhook host is not allowed", 403);
  return { url, addresses };
}

export async function sendSignedWebhook(
  input: string,
  payload: unknown,
  secret: string,
  timeoutMs: number,
  dependencies: WebhookDependencies = {},
): Promise<void> {
  const { url, addresses } = await resolveWebhookTarget(
    input,
    dependencies.resolveAddresses,
  );
  const body = JSON.stringify(payload);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = createHmac("sha256", secret)
    .update(`${timestamp}.${body}`)
    .digest("hex");
  const statusCode = await (dependencies.requestPinned ?? requestPinned)(
    url,
    addresses[0]!,
    body,
    signature,
    timestamp,
    timeoutMs,
  );
  if (statusCode >= 300 && statusCode < 400)
    throw new AppError("Webhook redirects are not allowed", 502);
  if (statusCode < 200 || statusCode >= 300)
    throw new AppError("Webhook request failed", 502);
}

function requestPinned(
  url: URL,
  address: string,
  body: string,
  signature: string,
  timestamp: string,
  timeoutMs: number,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const requestFn = url.protocol === "https:" ? httpsRequest : httpRequest;
    const request = requestFn(
      url,
      {
        method: "POST",
        timeout: timeoutMs,
        lookup: (_hostname, _options, callback) =>
          callback(
            null,
            address,
            ipaddr.parse(address).kind() === "ipv4" ? 4 : 6,
          ),
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
          "x-image-craft-timestamp": timestamp,
          "x-image-craft-signature": `sha256=${signature}`,
        },
      },
      (response) => {
        response.resume();
        response.on("end", () => resolve(response.statusCode ?? 0));
        response.on("error", reject);
      },
    );
    const timer = setTimeout(
      () => request.destroy(new AppError("Webhook timed out", 504)),
      timeoutMs,
    );
    timer.unref();
    request.on("close", () => clearTimeout(timer));
    request.on("timeout", () =>
      request.destroy(new AppError("Webhook timed out", 504)),
    );
    request.on("error", reject);
    request.end(body);
  });
}
