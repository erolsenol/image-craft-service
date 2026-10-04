import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import prettier from "prettier";
import { createApp } from "../src/api/app.js";
import { config } from "../src/config/index.js";

const app = await createApp(config);
try {
  await app.ready();
  const output = resolve("openapi/openapi.json");
  await mkdir(resolve("openapi"), { recursive: true });
  const json = await prettier.format(JSON.stringify(app.swagger()), {
    parser: "json",
  });
  await writeFile(output, json);
  process.stdout.write(`Wrote ${output}\n`);
} finally {
  await app.close();
}
