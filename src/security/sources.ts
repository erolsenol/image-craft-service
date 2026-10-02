import { createHash } from "node:crypto";
import { AppError } from "../core/errors.js";
import type { AppConfig } from "../config/index.js";

export interface ResolvedImageSource {
  url: URL;
  allowedHosts: readonly string[];
  headers?: Readonly<Record<string, string>>;
  credentialOrigin?: string;
  cacheScope?: string;
}

export function resolveImageSource(
  input: string,
  namedSources: AppConfig["NAMED_SOURCES"],
  fallbackAllowedHosts: readonly string[],
): ResolvedImageSource {
  if (input.length > 2048)
    throw new AppError("Remote source path is too long", 400);
  const separator = input.indexOf(":");
  const alias =
    separator > 0 && !/^https?:\/\//iu.test(input)
      ? input.slice(0, separator)
      : "";
  const namedSource = namedSources[alias];
  if (!namedSource) {
    let url: URL;
    try {
      url = new URL(input);
    } catch {
      throw new AppError("Invalid remote URL", 400);
    }
    return { url, allowedHosts: fallbackAllowedHosts };
  }

  const path = input.slice(separator + 1);
  let decodedPath = path;
  try {
    for (let iteration = 0; iteration < 4; iteration += 1) {
      const next = decodeURIComponent(decodedPath);
      if (next === decodedPath) break;
      decodedPath = next;
    }
  } catch {
    throw new AppError("Invalid named source path", 400);
  }
  if (
    !decodedPath ||
    /%[0-9a-f]{2}/iu.test(decodedPath) ||
    decodedPath.includes("\\") ||
    decodedPath
      .split("/")
      .some((segment) => segment === "." || segment === "..")
  ) {
    throw new AppError("Invalid named source path", 400);
  }

  const origin = new URL(namedSource.origin);
  if (!origin.pathname.endsWith("/")) origin.pathname += "/";
  const url = new URL(decodedPath.replace(/^\/+/, ""), origin);
  if (url.origin !== origin.origin || !url.pathname.startsWith(origin.pathname))
    throw new AppError("Named source path is not allowed", 400);

  const allowedHosts = namedSource.allowedHosts.map((host) =>
    host.toLowerCase(),
  );
  const headers = namedSource.headers;
  return {
    url,
    allowedHosts,
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
    ...(Object.keys(headers).length > 0
      ? { credentialOrigin: origin.origin }
      : {}),
    cacheScope: createHash("sha256")
      .update(
        `${alias}\n${JSON.stringify(
          Object.fromEntries(
            Object.entries(headers).sort(([a], [b]) => a.localeCompare(b)),
          ),
        )}`,
      )
      .digest("hex"),
  };
}
