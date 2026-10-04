import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const configResult = spawnSync(
  "git",
  ["config", "--local", "--get", "core.hooksPath"],
  {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  },
);
if (configResult.error) throw configResult.error;
if (configResult.status !== 0 && configResult.status !== 1) {
  throw new Error(
    "Could not read the repository's core.hooksPath configuration.",
  );
}
const currentHooksPath = configResult.stdout.trim();

if (currentHooksPath && currentHooksPath !== ".githooks") {
  throw new Error(
    `core.hooksPath is already set to "${currentHooksPath}". Review that hook setup before replacing it.`,
  );
}

execFileSync("git", ["config", "--local", "core.hooksPath", ".githooks"], {
  cwd: root,
  stdio: "inherit",
});
console.log("Git hooks enabled from .githooks.");
