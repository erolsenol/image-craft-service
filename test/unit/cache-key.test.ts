import { describe, expect, it } from "vitest";
import { createCacheKey } from "../../src/storage/cache-key.js";

describe("createCacheKey", () => {
  it("hashes a canonical source URL and normalizes implicit operation defaults", () => {
    const omittedDefaults = [{ op: "resize", width: 400 }] as const;
    const explicitDefaults = [
      { op: "resize", width: 400, fit: "cover" },
    ] as const;
    expect(
      createCacheKey("https://EXAMPLE.com:443/a.jpg", omittedDefaults),
    ).toBe(createCacheKey("https://example.com/a.jpg", explicitDefaults));
    expect(
      createCacheKey("https://example.com/a.jpg", omittedDefaults),
    ).toMatch(/^[a-f0-9]{64}$/);
  });

  it("keeps different sources and operation order in separate entries", () => {
    const resize = { op: "resize", width: 400 } as const;
    const grayscale = { op: "grayscale" } as const;
    expect(createCacheKey("https://example.com/a.jpg", [resize])).not.toBe(
      createCacheKey("https://example.com/b.jpg", [resize]),
    );
    expect(
      createCacheKey("https://example.com/a.jpg", [resize, grayscale]),
    ).not.toBe(
      createCacheKey("https://example.com/a.jpg", [grayscale, resize]),
    );
  });
});
