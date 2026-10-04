import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  classifyStagedPaths,
  parsePrePushRefs,
  validatePrePushState,
} from "./local-checks-utils.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

test("staged check file selection handles spaces and only supported types", () => {
  const files = classifyStagedPaths([
    "src/api/image route.ts",
    "docs/usage.md",
    "package.json",
    "assets/example.png",
    "packages/python/pyproject.toml",
  ]);

  assert.deepEqual(files, {
    prettier: ["src/api/image route.ts", "docs/usage.md", "package.json"],
    eslint: ["src/api/image route.ts"],
  });
});

test("pre-commit checker accepts formatted staged files and blocks format or lint errors", () => {
  const fixturePath = "scripts/__local hook fixture.ts";
  const indexDirectory = mkdtempSync(join(tmpdir(), "image-craft-test-index-"));
  const indexPath = join(indexDirectory, "index");
  const env = { ...process.env, GIT_INDEX_FILE: indexPath };
  const checkStagedPath = join(root, "scripts/check-staged.mjs");
  const updateIndex = () =>
    execFileSync("git", ["add", "--", fixturePath], { cwd: root, env });
  const check = () =>
    spawnSync(process.execPath, [checkStagedPath], {
      cwd: root,
      env,
      encoding: "utf8",
    });

  try {
    execFileSync("git", ["read-tree", "HEAD"], { cwd: root, env });

    writeFileSync(
      join(root, fixturePath),
      "export function stagedFixture(value: string): string {\n  return value;\n}\n",
    );
    updateIndex();
    const passing = check();
    assert.equal(passing.status, 0, passing.stderr);
    assert.match(
      passing.stdout,
      /Formatting is correct|All matched files use Prettier/u,
    );

    writeFileSync(
      join(root, fixturePath),
      "export const stagedFixture=(value:string)=>value\n",
    );
    updateIndex();
    const formatFailure = check();
    assert.equal(formatFailure.status, 1);

    writeFileSync(
      join(root, fixturePath),
      'export const stagedFixture: any = "value";\n',
    );
    updateIndex();
    const lintFailure = check();
    assert.equal(lintFailure.status, 1);
    assert.match(lintFailure.stdout + lintFailure.stderr, /no-explicit-any/u);
  } finally {
    rmSync(join(root, fixturePath), { force: true });
    rmSync(indexDirectory, { recursive: true, force: true });
  }
});

test("pre-push ref parsing reads branch and tag update lines", () => {
  assert.deepEqual(
    parsePrePushRefs(
      "refs/heads/development a1b2 refs/heads/development c3d4\nrefs/tags/v1.2.0 a1b2 refs/tags/v1.2.0 0000\n",
    ),
    [
      {
        localRef: "refs/heads/development",
        localSha: "a1b2",
        remoteRef: "refs/heads/development",
        remoteSha: "c3d4",
      },
      {
        localRef: "refs/tags/v1.2.0",
        localSha: "a1b2",
        remoteRef: "refs/tags/v1.2.0",
        remoteSha: "0000",
      },
    ],
  );
  assert.deepEqual(parsePrePushRefs(""), []);
  assert.throws(
    () => parsePrePushRefs("refs/heads/development a1b2"),
    /Invalid/u,
  );
});

test("pre-push validation requires tested refs to match a clean HEAD", () => {
  const matchingRef = {
    localRef: "refs/heads/development",
    localSha: "a1b2",
    remoteRef: "refs/heads/development",
    remoteSha: "c3d4",
  };

  assert.equal(validatePrePushState([matchingRef], "a1b2", ""), true);
  assert.throws(
    () => validatePrePushState([matchingRef], "different", ""),
    /checked-out HEAD/u,
  );
  assert.throws(
    () => validatePrePushState([matchingRef], "a1b2", " M README.md"),
    /clean worktree/u,
  );
  assert.equal(
    validatePrePushState(
      [{ ...matchingRef, localSha: "0000000000000000" }],
      "a1b2",
      "",
    ),
    false,
  );
});

test("pre-push hook blocks when the worktree contains uncommitted files", () => {
  const fixturePath = join(root, "scripts/__pre-push dirty fixture");
  const head = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  const result = (() => {
    try {
      writeFileSync(fixturePath, "dirty state\n");
      return spawnSync(
        process.execPath,
        [join(root, "scripts/check-push.mjs"), "--pre-push"],
        {
          cwd: root,
          env: process.env,
          input: `refs/heads/development ${head} refs/heads/development ${head}\n`,
          encoding: "utf8",
        },
      );
    } finally {
      rmSync(fixturePath, { force: true });
    }
  })();

  assert.equal(result.status, 1);
  assert.match(result.stderr, /clean worktree/u);
});
