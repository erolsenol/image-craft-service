import { config } from "../src/config/index.js";
import { signTransformUrl } from "../src/security/signing.js";

interface SignArguments {
  readonly ops: string;
  readonly source: string;
  readonly ttlSeconds?: number;
}

function parseArguments(args: readonly string[]): SignArguments {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index];
    if (!name || !["--ops", "--src", "--ttl"].includes(name))
      throw new Error(
        "Usage: npm run sign -- --ops <ops> --src <url> [--ttl 3600]",
      );
    if (values.has(name)) throw new Error(`Duplicate argument: ${name}`);
    const value = args[index + 1];
    if (!value || value.startsWith("--"))
      throw new Error(`Missing value for ${name}`);
    values.set(name, value);
    index += 1;
  }

  const ops = values.get("--ops");
  const source = values.get("--src");
  if (!ops || !source)
    throw new Error(
      "Usage: npm run sign -- --ops <ops> --src <url> [--ttl 3600]",
    );
  if (!/^[a-z0-9_-]+(?:,[a-z0-9_-]+)*$/iu.test(ops))
    throw new Error("--ops must be comma-separated compact operation tokens");

  let sourceUrl: URL;
  try {
    sourceUrl = new URL(source);
  } catch {
    throw new Error("--src must be a valid HTTP(S) URL");
  }
  if (
    !["http:", "https:"].includes(sourceUrl.protocol) ||
    sourceUrl.username ||
    sourceUrl.password
  )
    throw new Error("--src must be a credential-free HTTP(S) URL");

  const ttl = values.get("--ttl");
  if (ttl === undefined) return { ops, source: sourceUrl.toString() };
  const ttlSeconds = Number(ttl);
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds <= 0)
    throw new Error("--ttl must be a positive integer number of seconds");
  return { ops, source: sourceUrl.toString(), ttlSeconds };
}

try {
  if (!config.SIGNING_SECRET)
    throw new Error("SIGNING_SECRET must be set to create signed URLs");
  const args = parseArguments(process.argv.slice(2));
  const baseUrl = new URL(
    config.PUBLIC_BASE_URL ?? `http://localhost:${config.PORT}`,
  );
  const prefix = baseUrl.pathname.replace(/\/+$/u, "");
  baseUrl.pathname = `${prefix}/v1/img/${args.ops}/${encodeURIComponent(args.source)}`;
  const expires =
    args.ttlSeconds === undefined
      ? undefined
      : String(Math.floor(Date.now() / 1000) + args.ttlSeconds);
  console.log(
    signTransformUrl(baseUrl.toString(), config.SIGNING_SECRET, expires),
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : "Unable to sign URL");
  process.exitCode = 1;
}
