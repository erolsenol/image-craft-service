import { describe, expect, it } from "vitest";
import { expirationFromTtl } from "../../src/storage/expiration.js";

describe("storage expiration calculation", () => {
  it("supports zero and fractional TTLs", () => {
    expect(expirationFromTtl(0, 1000)).toBe(1000);
    expect(expirationFromTtl(0.5, 1000)).toBe(1500);
  });
  it.each([-1, Infinity, Number.NaN, Number.MAX_VALUE])(
    "rejects invalid TTL %s",
    (ttl) => {
      expect(() => expirationFromTtl(ttl)).toThrow();
    },
  );
});
