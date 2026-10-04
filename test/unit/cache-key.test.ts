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

  it("includes output format and canonicalizes nested object keys", () => {
    const first = [
      { op: "plugin", name: "p", options: { a: 1, b: 2 } },
    ] as const;
    const second = [
      { op: "plugin", name: "p", options: { b: 2, a: 1 } },
    ] as const;
    const source = "https://example.com/a.jpg";

    expect(createCacheKey(source, first)).toBe(createCacheKey(source, second));
    expect(createCacheKey(source, first, "png")).not.toBe(
      createCacheKey(source, first, "jpeg"),
    );
  });

  it("separates source aliases when their credential scopes differ", () => {
    const ops = [{ op: "resize", width: 400 }] as const;
    const source = "https://cdn.example.com/assets/a.jpg";
    expect(createCacheKey(source, ops, "jpeg", "alias-and-key-one")).not.toBe(
      createCacheKey(source, ops, "jpeg", "alias-and-key-two"),
    );
  });

  it("ignores fragments because they are not sent with remote requests", () => {
    const ops = [{ op: "resize", width: 400 }] as const;
    expect(createCacheKey("https://example.com/a.jpg#first", ops)).toBe(
      createCacheKey("https://example.com/a.jpg#second", ops),
    );
  });
});
