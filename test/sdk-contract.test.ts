import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/api/app.js";
import {
  createTransformSignature,
  verifyTransformSignature,
} from "../src/security/signing.js";
import { createCraftClient } from "../packages/client/src/index.js";

describe("OpenAPI SDK contract", () => {
  const appPromise = createApp();
  let app: Awaited<typeof appPromise>;
  beforeAll(async () => {
    app = await appPromise;
    await app.ready();
  });
  afterAll(async () => app.close());

  it("keeps the checked-in specification aligned with the API routes", async () => {
    const checkedIn = JSON.parse(
      await readFile(resolve("openapi/openapi.json"), "utf8"),
    ) as unknown;
    const live = app.swagger();
    expect(live.info.version).toBe("1.1.0");
    expect(live.paths).toHaveProperty("/v1/img/{ops}/{*}");
    expect(live.paths).toHaveProperty("/v1/transform");
    expect(checkedIn).toEqual(live);
  });

  it("generates SDK route types and compact resize/format URLs", async () => {
    const generated = await readFile(
      resolve("packages/client/src/generated.ts"),
      "utf8",
    );
    expect(generated).toContain("/v1/img/{ops}/{*}");
    const pythonContract = await readFile(
      resolve("packages/python/image_craft_client/_openapi.py"),
      "utf8",
    );
    expect(pythonContract).toContain("OPENAPI_VERSION = '1.1.0'");
    expect(pythonContract).toContain(
      "REMOTE_IMAGE_ROUTE = '/v1/img/{ops}/{*}'",
    );
    const url = createCraftClient({ baseUrl: "https://images.example.com" })
      .image("https://example.com/photo.jpg")
      .resize(800)
      .format("webp")
      .url();
    expect(url).toBe(
      "https://images.example.com/v1/img/w_800,f_webp/https%3A%2F%2Fexample.com%2Fphoto.jpg",
    );
  });

  it("produces signatures accepted by the service verifier", async () => {
    const builder = createCraftClient({ baseUrl: "https://images.example.com" })
      .image("https://example.com/photo.jpg")
      .resize(800)
      .format("webp");
    const url = new URL(
      await builder.signedUrl("contract-secret", { expiresAt: 2_000_000_000 }),
    );
    const route = decodeURIComponent(url.pathname).split("/");
    const signature = route[3];
    const ops = route[4];
    const source = new URL(route.slice(5).join("/"));
    expect(signature).toBe(
      createTransformSignature(
        source,
        ops ?? "",
        url.searchParams.get("expires") ?? undefined,
        "contract-secret",
      ),
    );
    expect(
      verifyTransformSignature(
        source,
        ops ?? "",
        url.searchParams.get("expires") ?? undefined,
        signature,
        "contract-secret",
        1_900_000_000_000,
      ),
    ).toBe(true);

    expect(
      verifyTransformSignature(
        new URL("https://example.com/p.jpg"),
        "w_800",
        "2000000000",
        createTransformSignature(
          "https://example.com/p.jpg",
          "w_800",
          "2000000000",
          "secret",
        ),
        "secret",
        1_900_000_000_000,
      ),
    ).toBe(true);
  });
});
