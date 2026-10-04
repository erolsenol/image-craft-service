import { spawnSync } from "node:child_process";

const prettierExtensions = new Set([
  ".cjs",
  ".css",
  ".html",
  ".js",
  ".json",
  ".jsx",
  ".md",
  ".mjs",
  ".ts",
  ".tsx",
  ".yaml",
  ".yml",
]);

export function classifyStagedPaths(paths) {
  const prettier = [];
  const eslint = [];

  for (const path of paths) {
    const extension = path.slice(path.lastIndexOf(".")).toLowerCase();
    if (prettierExtensions.has(extension)) prettier.push(path);
    if (extension === ".ts") eslint.push(path);
  }

  return { prettier, eslint };
}

export function parsePrePushRefs(input) {
  return input
    .split(/\r?\n/u)
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const [localRef, localSha, remoteRef, remoteSha] = line
        .trim()
        .split(/\s+/u);
      if (!localRef || !localSha || !remoteRef || !remoteSha) {
        throw new Error(`Invalid pre-push ref line: ${line}`);
      }
      return { localRef, localSha, remoteRef, remoteSha };
    });
}

export function validatePrePushState(refs, head, workingTreeStatus) {
  const changedRefs = refs.filter((ref) => !/^0+$/u.test(ref.localSha));
  if (changedRefs.length === 0) return false;
  if (changedRefs.some((ref) => ref.localSha !== head)) {
    throw new Error(
      "Push refs must point to the checked-out HEAD; push one ref at a time and retry.",
    );
  }
  if (workingTreeStatus.length > 0) {
    throw new Error(
      "Pre-push checks require a clean worktree so the tested files match the commit being pushed.",
    );
  }
  return true;
}

export function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed with exit code ${result.status}`,
    );
  }
}

export function runCapture(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed with exit code ${result.status}`,
    );
  }
  return result.stdout.trim();
}
