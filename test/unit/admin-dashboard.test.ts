import { describe, expect, it } from "vitest";
import { AdminDashboardStats } from "../../src/observability/admin-dashboard.js";

describe("AdminDashboardStats", () => {
  it("strips credentials, query strings, and fragments from image sources", () => {
    const stats = new AdminDashboardStats();
    stats.recordImageRequest(
      "https://user:pass@example.com/image.webp?token=secret#part",
    );
    expect(stats.topImages()).toEqual([
      { source: "https://example.com/image.webp", count: 1 },
    ]);
  });

  it("keeps a bounded recent set of sources", () => {
    const stats = new AdminDashboardStats();
    for (let index = 0; index < 205; index += 1)
      stats.recordImageRequest(`https://example.com/${index}.jpg`);
    expect(stats.topImages(300)).toHaveLength(200);
    expect(
      stats.topImages(300).some((item) => item.source.endsWith("/0.jpg")),
    ).toBe(false);
  });
});
