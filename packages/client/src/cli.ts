#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { basename, extname, join, parse, resolve } from "node:path";

interface Arguments {
  input: string;
  width: number | undefined;
  format: "jpeg" | "png" | "webp" | "avif" | undefined;
  output: string | undefined;
}

async function main(): Promise<void> {
  const parsed = parseArguments(process.argv.slice(2));
  const endpoint = (process.env.IMAGE_CRAFT_URL ?? "http://localhost:3000")
    .replace(/\/+$/u, "")
    .concat("/v1/transform");
  const headers = new Headers();
  if (process.env.IMAGE_CRAFT_API_KEY)
    headers.set("x-api-key", process.env.IMAGE_CRAFT_API_KEY);
  const input = await readFile(parsed.input);
  const form = new FormData();
  form.append(
    "file",
    new Blob([new Uint8Array(input)]),
    basename(parsed.input),
  );
  const operations: Record<string, string | number>[] = [];
  if (parsed.width !== undefined)
    operations.push({ op: "resize", width: parsed.width });
  if (parsed.format !== undefined)
    operations.push({ op: "format", format: parsed.format });
  form.append("ops", JSON.stringify(operations));
  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    body: form,
  });
  if (!response.ok) {
    const details = await response.text();
    throw new Error(`Transform failed (${response.status}): ${details}`);
  }
  const outputPath = resolve(
    parsed.output ?? defaultOutputPath(parsed.input, parsed.format),
  );
  await writeFile(outputPath, new Uint8Array(await response.arrayBuffer()));
  process.stdout.write(`${outputPath}\n`);
}

function parseArguments(args: string[]): Arguments {
  if (args[0] !== "transform" || !args[1]) {
    throw new Error(
      "Usage: image-craft transform <input> [--resize <width>] [--format jpeg|png|webp|avif] [--output <file>]",
    );
  }
  const parsed: Arguments = {
    input: args[1],
    format: undefined,
    width: undefined,
    output: undefined,
  };
  for (let index = 2; index < args.length; index += 1) {
    const option = args[index];
    const value = args[index + 1];
    if (!value) throw new Error(`Missing value for ${option}`);
    if (option === "--resize") {
      const width = Number(value);
      if (!Number.isSafeInteger(width) || width <= 0)
        throw new Error("--resize requires a positive integer");
      parsed.width = width;
    } else if (option === "--format") {
      if (!["jpeg", "png", "webp", "avif"].includes(value))
        throw new Error("--format must be jpeg, png, webp, or avif");
      parsed.format = value as Arguments["format"];
    } else if (option === "--output") parsed.output = value;
    else throw new Error(`Unknown option: ${option}`);
    index += 1;
  }
  return parsed;
}

function defaultOutputPath(input: string, format: Arguments["format"]): string {
  const extension = format
    ? `.${format === "jpeg" ? "jpg" : format}`
    : extname(input);
  const parsed = parse(input);
  return join(parsed.dir, `${parsed.name}.transformed${extension}`);
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : "Image transform failed"}\n`,
  );
  process.exitCode = 1;
});
