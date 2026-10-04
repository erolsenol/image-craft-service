import { createHash } from "node:crypto";
import { z } from "zod";
import { operationSchema, type Operation } from "../api/schemas/operations.js";

const presetName = z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/u);
const tenantId = z.string().regex(/^[a-z][a-z0-9_-]{0,62}$/u);
const operationNames = [
  "resize",
  "crop",
  "rotate",
  "blur",
  "sharpen",
  "grayscale",
  "watermark",
  "format",
  "padding",
  "flip",
  "flop",
  "tint",
  "adjust",
  "roundedCorners",
  "plugin",
] as const;
const allowedOperationName = z
  .string()
  .refine(
    (value) =>
      value === "*" ||
      operationNames.includes(value as (typeof operationNames)[number]) ||
      /^plugin:[a-z][a-z0-9_-]{0,99}$/u.test(value),
  );

export const tenantPolicySchema = z
  .object({
    requestsPerDay: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER)
      .default(0),
    bytesPerDay: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER)
      .default(0),
    allowedSources: z.array(z.string().min(1).max(253)).max(500).default([]),
    allowedOps: z.array(allowedOperationName).max(50).default([]),
    presets: z
      .record(presetName, z.array(operationSchema).max(50))
      .refine((presets) => Object.keys(presets).length <= 100)
      .default({}),
  })
  .strict();

export const tenantsObjectSchema = z
  .record(tenantId, tenantPolicySchema)
  .refine((tenants) => Object.keys(tenants).length <= 1000);

export interface TenantPolicy {
  readonly requestsPerDay: number;
  readonly bytesPerDay: number;
  readonly allowedSources: readonly string[];
  readonly allowedOps: readonly string[];
  readonly presets: Readonly<Record<string, readonly Operation[]>>;
}

export type TenantPolicies = Readonly<Record<string, TenantPolicy>>;

export function parseTenantPolicies(value: string): TenantPolicies {
  let decoded: unknown;
  try {
    decoded = value.trim() ? JSON.parse(value) : {};
  } catch {
    throw new Error("TENANTS must contain valid JSON");
  }
  const parsed = tenantsObjectSchema.safeParse(decoded);
  if (!parsed.success)
    throw new Error("TENANTS contains an invalid tenant policy");
  return parsed.data;
}

export function getTenantSourceKey(source: string): string | undefined {
  const separator = source.indexOf(":");
  if (separator > 0 && !/^https?:\/\//iu.test(source))
    return source.slice(0, separator).toLowerCase();
  try {
    return new URL(source).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

export function tenantAllowsSource(
  policy: TenantPolicy,
  source: string,
): boolean {
  const sourceKey = getTenantSourceKey(source);
  return (
    sourceKey !== undefined &&
    policy.allowedSources.some((allowed) => {
      const value = allowed.toLowerCase();
      return value === "*" || (sourceKey !== undefined && value === sourceKey);
    })
  );
}

export function tenantAllowsOperations(
  policy: TenantPolicy,
  operations: readonly Operation[],
): boolean {
  if (policy.allowedOps.includes("*")) return true;
  if (policy.allowedOps.length === 0) return false;
  return operations.every((operation) => {
    if (operation.op === "plugin")
      return (
        policy.allowedOps.includes("plugin") ||
        policy.allowedOps.includes(`plugin:${operation.name}`)
      );
    return policy.allowedOps.includes(operation.op);
  });
}

export function namespaceTenantKey(
  tenant: string | undefined,
  key: string,
): string {
  if (!tenant) return key;
  return createHash("sha256")
    .update(`tenant-storage\n${tenant}\n${key}`)
    .digest("hex");
}

interface DailyUsage {
  day: string;
  requests: number;
  bytes: number;
}

export class TenantUsage {
  private readonly usage = new Map<string, DailyUsage>();

  constructor(
    private readonly policies: TenantPolicies,
    private readonly onRequest?: (tenant: string) => void,
    private readonly onBytes?: (tenant: string, bytes: number) => void,
  ) {}

  recordRequest(tenant: string): boolean {
    const usage = this.current(tenant);
    const limit = this.policies[tenant]?.requestsPerDay ?? 0;
    if (limit > 0 && usage.requests >= limit) return false;
    usage.requests += 1;
    this.onRequest?.(tenant);
    return true;
  }

  recordBytes(tenant: string, bytes: number): boolean {
    if (!Number.isSafeInteger(bytes) || bytes < 0) return false;
    const usage = this.current(tenant);
    const limit = this.policies[tenant]?.bytesPerDay ?? 0;
    const next = usage.bytes + bytes;
    if (!Number.isSafeInteger(next) || (limit > 0 && next > limit))
      return false;
    usage.bytes = next;
    this.onBytes?.(tenant, bytes);
    return true;
  }

  get(tenant: string): Readonly<DailyUsage> {
    const { day, requests, bytes } = this.current(tenant);
    return { day, requests, bytes };
  }

  private current(tenant: string): DailyUsage {
    const day = new Date().toISOString().slice(0, 10);
    let usage = this.usage.get(tenant);
    if (!usage || usage.day !== day) {
      usage = { day, requests: 0, bytes: 0 };
      this.usage.set(tenant, usage);
    }
    return usage;
  }
}
