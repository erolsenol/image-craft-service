import { describe, expect, it } from "vitest";
import type { Operation } from "../../src/api/schemas/operations.js";
import { createCacheKey } from "../../src/core/cache-key.js";

describe("core cache key", () => {
  it("canonicalizes parameter order, defaults, hostnames, and fragments", () => {
    const firstOps = [
      { op: "resize", width: 400, fit: "cover" },
      { op: "format", format: "webp", quality: 80 },
      { op: "plugin", name: "sample", options: { z: 1, a: { y: 2, x: 3 } } },
    ] as unknown as Operation[];
    const equivalentOps = [
      { fit: "cover", width: 400, op: "resize" },
      { quality: 80, format: "avif", op: "format" },
      { options: { a: { x: 3, y: 2 }, z: 1 }, name: "sample", op: "plugin" },
    ] as unknown as Operation[];

    expect(
      createCacheKey(
        "https://EXAMPLE.com:443/image.jpg?b=2&a=1#first",
        firstOps,
        "WEBP",
      ),
    ).toBe(
      createCacheKey(
        "https://example.com/image.jpg?b=2&a=1#second",
        equivalentOps,
        "webp",
      ),
    );
  });

  it("keeps the source query order and operation chain order significant", () => {
    const resize: Operation = { op: "resize", width: 400 };
    const grayscale: Operation = { op: "grayscale" };
    const source = "https://example.com/image.jpg?a=1&b=2";

    expect(createCacheKey(source, [resize], "webp")).not.toBe(
      createCacheKey("https://example.com/image.jpg?b=2&a=1", [resize], "webp"),
    );
    expect(createCacheKey(source, [resize, grayscale], "webp")).not.toBe(
      createCacheKey(source, [grayscale, resize], "webp"),
    );
    expect(createCacheKey(source, [resize], "webp")).not.toBe(
      createCacheKey(source, [resize], "avif"),
    );
  });

  it("keeps extracted frames separate in the cache", () => {
    const source = "https://example.com/animation.gif";
    const operations: Operation[] = [{ op: "resize", width: 100 }];
    expect(createCacheKey(source, operations, "jpeg", "", 0)).not.toBe(
      createCacheKey(source, operations, "jpeg", "", 1),
    );
  });

  it("has no collisions across a deterministic corpus of 1000 request variations", () => {
    const keys = new Set<string>();

    for (let variation = 0; variation < 1_000; variation += 1) {
      const width = 240 + (variation % 17);
      const options = { z: variation, nested: { second: true, first: false } };
      const equivalentOptions = {
        nested: { first: false, second: true },
        z: variation,
      };
      const key = createCacheKey(
        `https://CDN.EXAMPLE.TEST:443/images/${variation}.jpg?key=${variation}&size=large#ignored`,
        [
          { op: "resize", width, fit: "cover" },
          { op: "format", format: "webp" },
          { op: "plugin", name: "fixture", options },
        ] as unknown as Operation[],
        "webp",
      );
      const equivalentKey = createCacheKey(
        `https://cdn.example.test/images/${variation}.jpg?key=${variation}&size=large`,
        [
          { fit: "cover", width, op: "resize" },
          { format: "avif", op: "format" },
          { options: equivalentOptions, name: "fixture", op: "plugin" },
        ] as unknown as Operation[],
        "WEBP",
      );

      expect(equivalentKey).toBe(key);
      keys.add(key);
    }

    expect(keys.size).toBe(1_000);
  });
});
