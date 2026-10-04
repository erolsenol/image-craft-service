import { describe, expect, it, vi } from "vitest";
import { createHttpPdfRasterizer } from "../../src/core/pdf-rasterizer.js";

const pdf = Buffer.from("%PDF-1.4 test");
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2]);

function rasterizer(fetcher: typeof fetch, maxOutputBytes = 1024) {
  return createHttpPdfRasterizer({
    workerUrl: "http://pdf-worker:8000/",
    timeoutMs: 1000,
    maxOutputBytes,
    fetch: fetcher,
  });
}

describe("HTTP PDF rasterizer client", () => {
  it("health-checks the worker and sends the requested page and DPI", async () => {
    const fetcher = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        void init;
        return String(input).endsWith("/health")
          ? new Response(null, { status: 204 })
          : new Response(png, {
              status: 200,
              headers: { "content-type": "image/png" },
            });
      },
    );
    const result = await rasterizer(fetcher).render(pdf, { page: 3, dpi: 180 });
    expect(result).toEqual(png);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[1]?.[1]).toMatchObject({
      method: "POST",
      headers: {
        "content-type": "application/pdf",
        "x-pdf-page": "3",
        "x-pdf-dpi": "180",
      },
    });
  });

  it("maps malformed and oversized worker responses to safe API errors", async () => {
    const malformed = rasterizer(async (input) =>
      String(input).endsWith("/health")
        ? new Response(null, { status: 204 })
        : new Response(null, { status: 400 }),
    );
    await expect(
      malformed.render(pdf, { page: 1, dpi: 150 }),
    ).rejects.toMatchObject({
      statusCode: 400,
    });

    const oversized = rasterizer(
      async (input) =>
        String(input).endsWith("/health")
          ? new Response(null, { status: 204 })
          : new Response(png, { status: 200 }),
      8,
    );
    await expect(
      oversized.render(pdf, { page: 1, dpi: 150 }),
    ).rejects.toMatchObject({
      statusCode: 413,
    });
  });

  it("returns 503 when the worker health check fails", async () => {
    const unavailable = rasterizer(
      async () => new Response(null, { status: 503 }),
    );
    await expect(
      unavailable.render(pdf, { page: 1, dpi: 150 }),
    ).rejects.toThrow("PDF rasterizer is unavailable");
  });

  it("serializes renders to match the worker's bounded process capacity", async () => {
    let activeRequests = 0;
    let maxActiveRequests = 0;
    const fetcher = async (input: RequestInfo | URL) => {
      activeRequests += 1;
      maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
      await new Promise((resolve) => setTimeout(resolve, 2));
      activeRequests -= 1;
      return String(input).endsWith("/health")
        ? new Response(null, { status: 204 })
        : new Response(png, { status: 200 });
    };
    const client = rasterizer(fetcher);
    await Promise.all([
      client.render(pdf, { page: 1, dpi: 150 }),
      client.render(pdf, { page: 2, dpi: 150 }),
    ]);
    expect(maxActiveRequests).toBe(1);
  });

  it("rejects a non-PNG worker response", async () => {
    const invalid = rasterizer(async (input) =>
      String(input).endsWith("/health")
        ? new Response(null, { status: 204 })
        : new Response("not png", { status: 200 }),
    );
    await expect(invalid.render(pdf, { page: 1, dpi: 150 })).rejects.toThrow(
      "invalid image data",
    );
  });
});
