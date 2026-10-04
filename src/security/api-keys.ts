import { createHash, timingSafeEqual } from "node:crypto";

export const API_SCOPES = [
  "transform",
  "metadata",
  "batch:read",
  "batch:write",
  "admin",
] as const;

export type ApiScope = (typeof API_SCOPES)[number];

export interface ApiPrincipal {
  id: string;
  scopes: readonly ApiScope[];
  tenantId?: string;
}

interface ApiKeyDefinition {
  digest: string;
  scopes: readonly ApiScope[];
  tenantId?: string;
}

const defaultScopes: readonly ApiScope[] = [
  "transform",
  "metadata",
  "batch:read",
  "batch:write",
];

export function parseApiKeyDefinitions(value: string): ApiKeyDefinition[] {
  if (!value.trim()) return [];
  return value.split(";").map((entry) => {
    const [rawDigest, rawScopes = ""] = entry.split("=", 2);
    const digest = rawDigest?.trim().toLowerCase() ?? "";
    if (!/^[a-f0-9]{64}$/u.test(digest))
      throw new Error("API_KEYS entries must start with a SHA-256 hex digest");
    const assigned = rawScopes
      ? rawScopes.split("+").map((scope) => scope.trim())
      : [...defaultScopes];
    const tenants = assigned.filter((scope) => scope.startsWith("tenant:"));
    const tenantId = tenants[0]?.slice("tenant:".length);
    const scopes = assigned.filter((scope) => !scope.startsWith("tenant:"));
    const effectiveScopes =
      scopes.length === 0 && tenantId ? [...defaultScopes] : scopes;
    if (
      effectiveScopes.length === 0 ||
      tenants.length > 1 ||
      (tenantId !== undefined && !/^[a-z][a-z0-9_-]{0,62}$/u.test(tenantId)) ||
      scopes.some(
        (scope): scope is string => !API_SCOPES.includes(scope as ApiScope),
      )
    )
      throw new Error("API_KEYS contains an unsupported scope");
    return {
      digest,
      scopes: effectiveScopes as ApiScope[],
      ...(tenantId ? { tenantId } : {}),
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
  return matched
    ? {
        id: matched.digest,
        scopes: matched.scopes,
        ...(matched.tenantId ? { tenantId: matched.tenantId } : {}),
      }
    : undefined;
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
  if (pathname.startsWith("/v1/admin/")) return "admin";
  if (pathname === "/v1/metadata") return "metadata";
  if (pathname === "/v1/uploads" || pathname === "/v1/batch")
    return "batch:write";
  if (pathname.startsWith("/v1/jobs/")) return "batch:read";
  return "transform";
}
