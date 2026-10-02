import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";
import { adaptPlugin } from "../../src/plugins/interface.js";
import { createRemoveBackgroundPlugin } from "../../src/plugins/remove-background.js";
import { runImageOperations } from "../../src/plugins/run-operations.js";

afterEach(() => vi.unstubAllGlobals());

describe("image plugins", () => {
  it("validates plugin options before running", async () => {
    const run = vi.fn(async (buffer: Buffer) => buffer);
    const plugin = adaptPlugin({
      name: "example",
      schema: (await import("zod")).z.object({
        amount: (await import("zod")).z.number(),
      }),
      run,
    });
    await expect(
      plugin.run(Buffer.from("x"), { amount: "bad" }),
    ).rejects.toThrow("Invalid options");
    expect(run).not.toHaveBeenCalled();
  });

  it("posts multipart image bytes to the rembg worker", async () => {
    const image = await sharp({
      create: { width: 2, height: 2, channels: 3, background: "red" },
    })
      .png()
      .toBuffer();
    const fetchMock = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) => {
        expect(String(_url)).toBe("http://rembg:7000/api/remove");
        expect(init?.method).toBe("POST");
        expect(init?.body).toBeInstanceOf(FormData);
        return new Response(image, { status: 200 });
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const plugin = createRemoveBackgroundPlugin({
      workerUrl: "http://rembg:7000/",
      timeoutMs: 1000,
      maxOutputBytes: 1024 * 1024,
    });
    await expect(plugin.run(image, {})).resolves.toEqual(image);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("rejects worker errors and oversized output", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("failed", { status: 500 })),
    );
    const plugin = createRemoveBackgroundPlugin({
      workerUrl: "http://rembg:7000",
      timeoutMs: 1000,
      maxOutputBytes: 2,
    });
    await expect(plugin.run(Buffer.from("x"), {})).rejects.toThrow(
      "Background removal failed",
    );

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(Buffer.from("large"))),
    );
    await expect(plugin.run(Buffer.from("x"), {})).rejects.toThrow(
      "Plugin output exceeds size limit",
    );
  });

  it("preserves operation order and validates plugin image output", async () => {
    const input = await sharp({
      create: { width: 4, height: 3, channels: 3, background: "blue" },
    })
      .jpeg()
      .toBuffer();
    const transparentPng = await sharp({
      create: {
        width: 4,
        height: 3,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      },
    })
      .png()
      .toBuffer();
    const result = await runImageOperations(
      input,
      [
        { op: "resize", width: 2 },
        { op: "plugin", name: "remove-background", options: {} },
        { op: "resize", width: 1 },
      ],
      new Map([
        [
          "remove-background",
          {
            name: "remove-background",
            async run() {
              return transparentPng;
            },
          },
        ],
      ]),
      100,
      10,
    );
    const metadata = await sharp(result.buffer).metadata();
    expect(result.contentType).toBe("image/png");
    expect(metadata.width).toBe(1);
    expect(metadata.hasAlpha).toBe(true);
  });
});
