import { createHash, timingSafeEqual } from "node:crypto";

export const API_SCOPES = [
  "transform",
  "metadata",
  "batch:read",
  "batch:write",
] as const;

export type ApiScope = (typeof API_SCOPES)[number];

export interface ApiPrincipal {
  id: string;
  scopes: readonly ApiScope[];
}

interface ApiKeyDefinition {
  digest: string;
  scopes: readonly ApiScope[];
}

const defaultScopes: readonly ApiScope[] = API_SCOPES;

export function parseApiKeyDefinitions(value: string): ApiKeyDefinition[] {
  if (!value.trim()) return [];
  return value.split(";").map((entry) => {
    const [rawDigest, rawScopes = ""] = entry.split("=", 2);
    const digest = rawDigest?.trim().toLowerCase() ?? "";
    if (!/^[a-f0-9]{64}$/u.test(digest))
      throw new Error("API_KEYS entries must start with a SHA-256 hex digest");
    const scopes = rawScopes
      ? rawScopes.split("+").map((scope) => scope.trim())
      : [...defaultScopes];
    if (
      scopes.length === 0 ||
      scopes.some(
        (scope): scope is string => !API_SCOPES.includes(scope as ApiScope),
      )
    )
      throw new Error("API_KEYS contains an unsupported scope");
    return {
      digest,
      scopes: scopes as ApiScope[],
    };
  });
}

export function validateApiKeyDefinitions(value: string): boolean {
  try {
    parseApiKeyDefinitions(value);
    return true;
  } catch {
    return false;
  }
}

export function hashApiKey(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function authenticateApiKey(
  providedKey: string | undefined,
  remoteAddress: string,
  configuredKeys: string,
): ApiPrincipal | undefined {
  const definitions = parseApiKeyDefinitions(configuredKeys);
  if (definitions.length === 0)
    return {
      id: hashApiKey(`ip:${remoteAddress}`),
      scopes: defaultScopes,
    };
  if (!providedKey || providedKey.length > 4096) return undefined;
  const candidate = Buffer.from(hashApiKey(providedKey), "hex");
  let matched: ApiKeyDefinition | undefined;
  for (const definition of definitions) {
    const matches = timingSafeEqual(
      candidate,
      Buffer.from(definition.digest, "hex"),
    );
    if (matches) matched = definition;
  }
  return matched ? { id: matched.digest, scopes: matched.scopes } : undefined;
}

export function resolveBatchClientId(
  providedKey: string | undefined,
  remoteAddress: string,
  configuredKeys: string,
): string | undefined {
  return authenticateApiKey(providedKey, remoteAddress, configuredKeys)?.id;
}

export function requiredApiScope(requestUrl: string): ApiScope {
  const pathname = requestUrl.split("?", 1)[0] ?? requestUrl;
  if (pathname === "/v1/metadata") return "metadata";
  if (pathname === "/v1/uploads" || pathname === "/v1/batch")
    return "batch:write";
  if (pathname.startsWith("/v1/jobs/")) return "batch:read";
  return "transform";
}
