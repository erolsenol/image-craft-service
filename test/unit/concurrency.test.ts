import { describe, expect, it } from "vitest";
import { ConcurrencyLimiter } from "../../src/security/concurrency.js";

describe("ConcurrencyLimiter", () => {
  it("keeps active operations within the configured limit", async () => {
    const limiter = new ConcurrencyLimiter(2);
    let active = 0;
    let maximumActive = 0;
    await Promise.all(
      Array.from({ length: 8 }, () =>
        limiter.run(async () => {
          active += 1;
          maximumActive = Math.max(maximumActive, active);
          await new Promise((resolve) => setTimeout(resolve, 5));
          active -= 1;
        }),
      ),
    );
    expect(maximumActive).toBe(2);
  });
});
