import { describe, expect, it } from "vitest";
import { envSchema } from "../../src/config/index.js";
import { resolveImageSource } from "../../src/security/sources.js";

const sources = envSchema.parse({
  NAMED_SOURCES: JSON.stringify({
    cdn: {
      origin: "https://cdn.example.com/assets/",
      allowedHosts: ["cdn.example.com", "images.example.com"],
      headers: { authorization: "Bearer test-token" },
    },
  }),
}).NAMED_SOURCES;

describe("named image sources", () => {
  it("resolves an alias under its configured origin with scoped credentials", () => {
    const result = resolveImageSource("cdn:products/photo.jpg", sources, []);
    expect(result.url.toString()).toBe(
      "https://cdn.example.com/assets/products/photo.jpg",
    );
    expect(result.allowedHosts).toEqual([
      "cdn.example.com",
      "images.example.com",
    ]);
    expect(result.headers).toEqual({ authorization: "Bearer test-token" });
    expect(result.credentialOrigin).toBe("https://cdn.example.com");
    expect(result.cacheScope).toMatch(/^[0-9a-f]{64}$/u);
  });

  it.each([
    "cdn:../private.jpg",
    "cdn:%2e%2e/private.jpg",
    "cdn:..%2fprivate.jpg",
    "cdn:%252e%252e/private.jpg",
    "cdn:",
  ])("rejects path traversal or an empty path: %s", (source) =>
    expect(() => resolveImageSource(source, sources, [])).toThrow(
      "Invalid named source path",
    ),
  );

  it("leaves ordinary URLs on the globally configured allowlist", () => {
    const result = resolveImageSource(
      "https://public.example/photo.jpg",
      sources,
      ["public.example"],
    );
    expect(result.url.toString()).toBe("https://public.example/photo.jpg");
    expect(result.allowedHosts).toEqual(["public.example"]);
    expect(result.headers).toBeUndefined();
  });
});
