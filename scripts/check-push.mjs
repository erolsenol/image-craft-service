import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parsePrePushRefs,
  run,
  runCapture,
  validatePrePushState,
} from "./local-checks-utils.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const isPrePush = process.argv.includes("--pre-push");
const dockerEnvironment = prepareDockerEnvironment();

function prepareDockerEnvironment() {
  const configDirectory =
    process.env.DOCKER_CONFIG ?? join(homedir(), ".docker");
  const configFile = join(configDirectory, "config.json");
  if (!existsSync(configFile)) return { env: process.env, cleanup: () => {} };

  const config = JSON.parse(readFileSync(configFile, "utf8"));
  const helpers = [
    config.credsStore,
    ...Object.values(config.credHelpers ?? {}),
  ].filter((helper) => typeof helper === "string" && helper.length > 0);
  const missingHelper = helpers.find((helper) => {
    const result = spawnSync(`docker-credential-${helper}`, ["--version"], {
      stdio: "ignore",
    });
    return result.error?.code === "ENOENT";
  });

  if (!missingHelper) return { env: process.env, cleanup: () => {} };

  const temporaryConfig = mkdtempSync(
    join(tmpdir(), "image-craft-docker-config-"),
  );
  const fallbackConfig = {
    auths: {},
    ...(typeof config.currentContext === "string"
      ? { currentContext: config.currentContext }
      : {}),
  };
  writeFileSync(
    join(temporaryConfig, "config.json"),
    JSON.stringify(fallbackConfig),
  );
  const contexts = join(configDirectory, "contexts");
  if (existsSync(contexts)) {
    cpSync(contexts, join(temporaryConfig, "contexts"), { recursive: true });
  }

  console.warn(
    `Docker credential helper "${missingHelper}" is unavailable; using a temporary credential-free config for public image checks.`,
  );
  return {
    env: { ...process.env, DOCKER_CONFIG: temporaryConfig },
    cleanup: () => rmSync(temporaryConfig, { recursive: true, force: true }),
  };
}

function assertPrePushMatchesHead() {
  const refs = parsePrePushRefs(readFileSync(0, "utf8"));
  const head = runCapture("git", ["rev-parse", "HEAD"], { cwd: root });
  const status = runCapture(
    "git",
    ["status", "--porcelain", "--untracked-files=all"],
    {
      cwd: root,
    },
  );
  if (!validatePrePushState(refs, head, status)) {
    console.log("Push contains deletions only; quality checks skipped.");
    return false;
  }
  return true;
}

function checkSdkGeneration() {
  const generatedFiles = [
    "openapi/openapi.json",
    "packages/client/src/generated.ts",
    "packages/python/image_craft_client/_openapi.py",
  ];
  const original = generatedFiles.map((relativePath) => {
    const path = join(root, relativePath);
    return {
      path,
      bytes: readFileSync(path),
      mode: statSync(path).mode,
    };
  });
  let generationError;
  let staleFiles = [];

  try {
    run("npm", ["run", "sdk:generate"], { cwd: root });
    staleFiles = original
      .filter(({ path, bytes }) => !readFileSync(path).equals(bytes))
      .map(({ path }) => path.slice(root.length + 1));
  } catch (error) {
    generationError = error;
  } finally {
    for (const file of original) {
      writeFileSync(file.path, file.bytes, { mode: file.mode });
    }
  }

  if (generationError) throw generationError;
  if (staleFiles.length > 0) {
    throw new Error(
      `Generated SDK files are out of date: ${staleFiles.join(", ")}. Run npm run sdk:generate and review the changes.`,
    );
  }
  console.log("OpenAPI and generated SDK files are in sync.");
}

function dockerAvailable() {
  const result = spawnSync(
    "docker",
    ["info", "--format", "{{.ServerVersion}}"],
    {
      cwd: root,
      env: dockerEnvironment.env,
      encoding: "utf8",
      stdio: "ignore",
    },
  );
  return !result.error && result.status === 0;
}

function mappedPort(name, containerPort) {
  const output = runCapture("docker", ["port", name, `${containerPort}/tcp`], {
    cwd: root,
    env: dockerEnvironment.env,
  });
  const match = output.match(/(?:127\.0\.0\.1|0\.0\.0\.0):([0-9]+)/u);
  if (!match)
    throw new Error(`Could not determine mapped port for ${name}: ${output}`);
  return Number(match[1]);
}

async function waitForService(check, label) {
  let lastError;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      if (await check()) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  }
  throw new Error(`${label} did not become ready in 20 seconds`, {
    cause: lastError,
  });
}

async function startTestServices() {
  if (!dockerAvailable()) {
    console.warn(
      "Docker daemon is unavailable; Redis/MinIO integration tests and Docker image builds will be skipped.",
    );
    return { dockerAvailable: false, env: {}, cleanup: async () => {} };
  }

  const suffix = `${process.pid}-${Date.now()}`;
  const redisName = `image-craft-test-redis-${suffix}`;
  const minioName = `image-craft-test-minio-${suffix}`;
  const containers = [];
  const cleanup = async () => {
    for (const name of containers.reverse()) {
      spawnSync("docker", ["rm", "--force", name], {
        cwd: root,
        env: dockerEnvironment.env,
        stdio: "ignore",
      });
    }
  };

  try {
    runCapture(
      "docker",
      [
        "run",
        "--detach",
        "--rm",
        "--publish",
        "127.0.0.1::6379",
        "--name",
        redisName,
        "redis:7-alpine",
      ],
      { cwd: root, env: dockerEnvironment.env },
    );
    containers.push(redisName);
    runCapture(
      "docker",
      [
        "run",
        "--detach",
        "--rm",
        "--publish",
        "127.0.0.1::9000",
        "--env",
        "MINIO_ROOT_USER=minioadmin",
        "--env",
        "MINIO_ROOT_PASSWORD=minioadmin",
        "--name",
        minioName,
        "ghcr.io/coollabsio/minio:RELEASE.2025-04-22T22-12-26Z",
        "server",
        "/data",
      ],
      { cwd: root, env: dockerEnvironment.env },
    );
    containers.push(minioName);

    const redisPort = mappedPort(redisName, 6379);
    const minioPort = mappedPort(minioName, 9000);
    await waitForService(
      async () =>
        runCapture("docker", ["exec", redisName, "redis-cli", "ping"], {
          cwd: root,
          env: dockerEnvironment.env,
        }) === "PONG",
      "Redis",
    );
    await waitForService(async () => {
      const response = await fetch(
        `http://127.0.0.1:${minioPort}/minio/health/ready`,
        {
          signal: AbortSignal.timeout(1000),
        },
      );
      return response.ok;
    }, "MinIO");

    console.log("Redis and MinIO test services are ready.");
    return {
      dockerAvailable: true,
      env: {
        REDIS_TEST_URL: `redis://127.0.0.1:${redisPort}`,
        S3_TEST_ENDPOINT: `http://127.0.0.1:${minioPort}`,
        S3_TEST_REGION: "us-east-1",
        S3_TEST_ACCESS_KEY: "minioadmin",
        S3_TEST_SECRET_KEY: "minioadmin",
      },
      cleanup,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

function buildPythonPackage() {
  const python = process.env.PYTHON ?? "python3";
  const probe = spawnSync(python, ["-c", "import build"], {
    cwd: root,
    stdio: "ignore",
  });

  if (!probe.error && probe.status === 0) {
    run(python, ["-m", "build", "packages/python"], { cwd: root });
    return;
  }

  const environment = mkdtempSync(join(tmpdir(), "image-craft-python-build-"));
  try {
    const virtualenv = join(environment, "venv");
    run(python, ["-m", "venv", virtualenv], { cwd: root });
    const venvPython =
      process.platform === "win32"
        ? join(virtualenv, "Scripts", "python.exe")
        : join(virtualenv, "bin", "python");
    run(venvPython, ["-m", "pip", "install", "build"], { cwd: root });
    run(venvPython, ["-m", "build", "packages/python"], { cwd: root });
  } finally {
    rmSync(environment, { recursive: true, force: true });
  }
}

async function main() {
  if (isPrePush && !assertPrePushMatchesHead()) return;

  checkSdkGeneration();
  const services = await startTestServices();
  try {
    const commands = [
      ["npm", ["run", "test:local-checks"]],
      ["npm", ["run", "client:build"]],
      ["npm", ["run", "docs:build"]],
      ["npm", ["audit", "--audit-level=high"]],
      ["npm", ["run", "lint"]],
      ["npm", ["run", "typecheck"]],
      ["npm", ["run", "format:check"]],
      ["npm", ["test"]],
      [
        process.env.PYTHON ?? "python3",
        ["-m", "unittest", "discover", "-s", "packages/python/tests"],
      ],
      [
        process.env.PYTHON ?? "python3",
        ["-m", "unittest", "discover", "-s", "workers/pdf-rasterizer/tests"],
      ],
    ];
    for (const [command, args] of commands) {
      console.log(`\n> ${command} ${args.join(" ")}`);
      run(command, args, {
        cwd: root,
        env: { ...process.env, ...services.env },
      });
    }

    console.log("\n> Build Python SDK package");
    buildPythonPackage();

    if (services.dockerAvailable) {
      for (const [image, context] of [
        ["image-craft-service:local-check", "."],
        ["image-craft-ai-worker:local-check", "./workers/ai-http-worker"],
        ["image-craft-pdf-worker:local-check", "./workers/pdf-rasterizer"],
      ]) {
        console.log(`\n> docker build -t ${image} ${context}`);
        run("docker", ["build", "-t", image, context], {
          cwd: root,
          env: dockerEnvironment.env,
        });
      }
    }
    console.log("\nAll local push checks passed.");
  } finally {
    await services.cleanup();
  }
}

main()
  .catch((error) => {
    console.error(`\nLocal push checks failed: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(() => {
    dockerEnvironment.cleanup();
  });
