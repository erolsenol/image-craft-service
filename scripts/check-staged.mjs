import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { classifyStagedPaths, run } from "./local-checks-utils.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const staged = execFileSync(
  "git",
  ["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"],
  { cwd: root },
)
  .toString("utf8")
  .split("\0")
  .filter(Boolean);

if (staged.length === 0) {
  console.log("No staged files; commit checks skipped.");
  process.exit(0);
}

const files = classifyStagedPaths(staged);
const prettierCli = resolve(root, "node_modules/prettier/bin/prettier.cjs");
const eslintCli = resolve(root, "node_modules/eslint/bin/eslint.js");

if (files.prettier.length > 0) {
  if (!existsSync(prettierCli)) {
    throw new Error("Prettier is not installed. Run npm ci before committing.");
  }
  console.log(
    `Checking formatting for ${files.prettier.length} staged file(s)...`,
  );
  run(process.execPath, [prettierCli, "--check", "--", ...files.prettier], {
    cwd: root,
  });
} else {
  console.log("No staged Prettier-supported files.");
}

if (files.eslint.length > 0) {
  if (!existsSync(eslintCli)) {
    throw new Error("ESLint is not installed. Run npm ci before committing.");
  }
  console.log(`Linting ${files.eslint.length} staged TypeScript file(s)...`);
  run(process.execPath, [eslintCli, "--", ...files.eslint], { cwd: root });
} else {
  console.log("No staged TypeScript files for ESLint.");
}
