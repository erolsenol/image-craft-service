import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";
import { envSchema } from "../../src/config/index.js";
import { createAutoAltTextPlugin } from "../../src/plugins/auto-alt-text.js";
import {
  adaptPlugin,
  registerPlugin,
  type PluginContext,
} from "../../src/plugins/interface.js";
import { createNsfwCheckPlugin } from "../../src/plugins/nsfw-check.js";
import { createPluginRegistry } from "../../src/plugins/registry.js";
import { createRemoveBackgroundPlugin } from "../../src/plugins/remove-background.js";
import { runImageOperations } from "../../src/plugins/run-operations.js";
import { createUpscalePlugin } from "../../src/plugins/upscale.js";

afterEach(() => vi.unstubAllGlobals());

const worker = {
  workerUrl: "http://worker:8000",
  timeoutMs: 50,
  maxBytes: 1024 * 1024,
};

async function imageFixture(): Promise<Buffer> {
  return sharp({
    create: { width: 2, height: 2, channels: 3, background: "red" },
  })
    .png()
    .toBuffer();
}

function workerFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
) {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string | URL | Request, init?: RequestInit) =>
      handler(String(url), init),
    ),
  );
}

describe("AI plugin contract", () => {
  it("keeps every AI plugin disabled by default", () => {
    const registry = createPluginRegistry(envSchema.parse({}));
    expect(registry.size).toBe(0);
  });

  it("registers only the individually enabled plugins", () => {
    const config = envSchema.parse({
      UPSCALE_ENABLED: "true",
      AUTO_ALT_TEXT_ENABLED: "true",
    });
    const registry = createPluginRegistry(config);
    expect([...registry.keys()]).toEqual(["upscale", "auto-alt-text"]);
  });

  it("validates options before calling a versioned plugin", async () => {
    const run = vi.fn(async (buffer: Buffer) => buffer);
    const plugin = adaptPlugin(
      {
        name: "fixture",
        version: "1.0.0",
        optionsSchema: (await import("zod")).z.object({
          amount: (await import("zod")).z.number(),
        }),
        run,
      },
      { timeoutMs: 100, maxBytes: 1024 },
    );
    await expect(
      plugin.run(
        Buffer.from("x"),
        { amount: "bad" },
        {
          requestId: "test",
          metadata: {},
        },
      ),
    ).rejects.toThrow("Invalid options");
    expect(run).not.toHaveBeenCalled();
    expect(plugin.version).toBe("1.0.0");
  });

  it("rejects duplicate plugin registrations", () => {
    const registry = new Map<
      string,
      import("../../src/plugins/interface.js").RuntimeImagePlugin
    >();
    const plugin = {
      name: "fixture",
      version: "1.0.0",
      timeoutMs: 10,
      maxBytes: 10,
      run: vi.fn(),
    };
    registerPlugin(registry, plugin);
    expect(() => registerPlugin(registry, plugin)).toThrow(
      "already registered",
    );
    expect(() =>
      registerPlugin(registry, { ...plugin, version: "bad-version" }),
    ).toThrow("semver");
  });

  it("posts image bytes to the rembg worker after checking health", async () => {
    const image = await imageFixture();
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/health")) return new Response(null, { status: 200 });
      expect(url).toBe("http://worker:8000/api/remove");
      expect(init?.method).toBe("POST");
      expect(init?.body).toBeInstanceOf(FormData);
      return new Response(new Uint8Array(image), { status: 200 });
    });
    workerFetch(fetchMock);
    const plugin = createRemoveBackgroundPlugin(worker);
    const ctx = {
      requestId: "req-1",
      signal: new AbortController().signal,
      metadata: {},
    };
    await expect(plugin.run(image, {}, ctx)).resolves.toEqual(image);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("sends upscale parameters to its separate worker", async () => {
    const image = await imageFixture();
    workerFetch(async (url, init) => {
      if (url.endsWith("/health")) return new Response(null);
      const form = init?.body as FormData;
      expect(url).toBe("http://worker:8000/api/upscale");
      expect(form.get("scale")).toBe("4");
      return new Response(new Uint8Array(image));
    });
    await expect(
      createUpscalePlugin(worker).run(
        image,
        { scale: 4 },
        {
          requestId: "req-2",
          signal: new AbortController().signal,
          metadata: {},
        },
      ),
    ).resolves.toEqual(image);
  });

  it("returns generated alt text in request metadata", async () => {
    const image = await imageFixture();
    workerFetch(async (url) =>
      url.endsWith("/health")
        ? new Response(null)
        : new Response(JSON.stringify({ text: "A red square\r\n" })),
    );
    const metadata: PluginContext["metadata"] = {};
    await expect(
      createAutoAltTextPlugin(worker).run(
        image,
        { language: "en" },
        {
          requestId: "req-3",
          signal: new AbortController().signal,
          metadata,
        },
      ),
    ).resolves.toEqual(image);
    expect(metadata.altText).toBe("A red square");
  });

  it("returns the NSFW score and can block above threshold", async () => {
    const image = await imageFixture();
    workerFetch(async (url) =>
      url.endsWith("/health")
        ? new Response(null)
        : new Response(JSON.stringify({ score: 0.91 })),
    );
    const plugin = createNsfwCheckPlugin(worker);
    const metadata: PluginContext["metadata"] = {};
    await expect(
      plugin.run(
        image,
        { threshold: 0.8, blockAbove: false },
        {
          requestId: "req-4",
          signal: new AbortController().signal,
          metadata,
        },
      ),
    ).resolves.toEqual(image);
    expect(metadata.nsfwScore).toBe(0.91);
    await expect(
      plugin.run(
        image,
        { threshold: 0.8, blockAbove: true },
        {
          requestId: "req-4",
          signal: new AbortController().signal,
          metadata: {},
        },
      ),
    ).rejects.toMatchObject({ statusCode: 422 });
  });

  it("returns 503 for an unhealthy worker and enforces plugin timeouts", async () => {
    const image = await imageFixture();
    workerFetch(async () => new Response("offline", { status: 503 }));
    await expect(
      createRemoveBackgroundPlugin(worker).run(
        image,
        {},
        {
          requestId: "req-5",
          signal: new AbortController().signal,
          metadata: {},
        },
      ),
    ).rejects.toMatchObject({ statusCode: 503 });

    const never = new Promise<Buffer>(() => undefined);
    const plugin = adaptPlugin(
      {
        name: "slow-plugin",
        version: "1.0.0",
        optionsSchema: (await import("zod")).z.object({}),
        run: async () => never,
      },
      { timeoutMs: 5, maxBytes: 100 },
    );
    await expect(
      plugin.run(image, {}, { requestId: "req-6", metadata: {} }),
    ).rejects.toMatchObject({ statusCode: 503 });
  });

  it("caps worker response size", async () => {
    workerFetch(async (url) =>
      url.endsWith("/health")
        ? new Response(null)
        : new Response(new Uint8Array(Buffer.alloc(64))),
    );
    await expect(
      createRemoveBackgroundPlugin({ ...worker, maxBytes: 16 }).run(
        await imageFixture(),
        {},
        {
          requestId: "req-7",
          signal: new AbortController().signal,
          metadata: {},
        },
      ),
    ).rejects.toThrow("exceeds size limit");
  });

  it("rejects oversized plugin input before contacting a worker", async () => {
    const run = vi.fn(async (buffer: Buffer) => buffer);
    const plugin = adaptPlugin(
      {
        name: "bounded-plugin",
        version: "1.0.0",
        optionsSchema: (await import("zod")).z.object({}),
        run,
      },
      { timeoutMs: 50, maxBytes: 2 },
    );
    await expect(
      plugin.run(
        Buffer.from("too large"),
        {},
        {
          requestId: "req-8",
          metadata: {},
        },
      ),
    ).rejects.toMatchObject({ statusCode: 413 });
    expect(run).not.toHaveBeenCalled();
  });

  it("maps malformed worker image output to a safe 503", async () => {
    const image = await imageFixture();
    const runtime = {
      name: "invalid-worker",
      version: "1.0.0",
      timeoutMs: 50,
      maxBytes: 1024,
      async run() {
        return Buffer.from("not an image");
      },
    };
    await expect(
      runImageOperations(
        image,
        [{ op: "plugin", name: "invalid-worker", options: {} }],
        new Map([[runtime.name, runtime]]),
        100,
        16,
      ),
    ).rejects.toMatchObject({ statusCode: 503 });
  });
});
