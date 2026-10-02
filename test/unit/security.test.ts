import { describe, expect, it } from "vitest";
import {
  fetchRemoteImage,
  isPublicIp,
  resolvePublicAddresses,
} from "../../src/security/ssrf.js";
import {
  createTransformSignature,
  signPath,
  signTransformUrl,
  verifySignature,
  verifyTransformSignature,
} from "../../src/security/signing.js";

describe("SSRF IP filtering", () => {
  it.each([
    "127.0.0.1",
    "10.1.2.3",
    "172.16.4.5",
    "172.31.255.255",
    "192.168.1.2",
    "169.254.169.254",
    "::1",
    "fc00::1",
    "fe80::1",
    "::ffff:127.0.0.1",
    "192.0.0.1",
    "192.88.99.1",
    "2001:db8::1",
    "2001::1",
    "2002::1",
    "64:ff9b::a00:1",
  ])("blocks %s", (ip) => expect(isPublicIp(ip)).toBe(false));
  it.each(["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"])(
    "allows public address %s",
    (ip) => expect(isPublicIp(ip)).toBe(true),
  );
});

describe("SSRF DNS and redirect checks", () => {
  it("rejects a hostname when any DNS answer is non-public", async () => {
    await expect(
      resolvePublicAddresses("mixed.example", async () => [
        "8.8.8.8",
        "10.0.0.1",
      ]),
    ).rejects.toThrow("Remote host is not allowed");
  });

  it("validates a redirect target before connecting to it", async () => {
    const requested: string[] = [];
    await expect(
      fetchRemoteImage(
        "https://public.example/image.jpg",
        { allowedHosts: [], timeoutMs: 1000, maxBytes: 1000 },
        {
          resolveAddresses: async (hostname) =>
            hostname === "public.example" ? ["8.8.8.8"] : ["127.0.0.1"],
          requestPinned: async (url) => {
            requested.push(url.hostname);
            return {
              statusCode: 302,
              headers: { location: "http://private.example/image.jpg" },
              body: Buffer.alloc(0),
            };
          },
        },
      ),
    ).rejects.toThrow("Remote host is not allowed");
    expect(requested).toEqual(["public.example"]);
  });

  it("re-resolves and blocks a same-host DNS rebinding redirect", async () => {
    let resolutions = 0;
    const requested: string[] = [];
    await expect(
      fetchRemoteImage(
        "https://rebound.example/image.jpg",
        { allowedHosts: [], timeoutMs: 1000, maxBytes: 1000 },
        {
          resolveAddresses: async () => {
            resolutions += 1;
            return resolutions === 1 ? ["8.8.8.8"] : ["10.0.0.2"];
          },
          requestPinned: async (url) => {
            requested.push(url.hostname);
            return {
              statusCode: 302,
              headers: { location: "/redirected.jpg" },
              body: Buffer.alloc(0),
            };
          },
        },
      ),
    ).rejects.toThrow("Remote host is not allowed");
    expect(resolutions).toBe(2);
    expect(requested).toEqual(["rebound.example"]);
  });
});

describe("signed URLs", () => {
  it("verifies a signature and rejects tampering", () => {
    const signature = signPath(
      "w_400,f_webp/https://example.com/a.jpg",
      "test-secret",
    );
    expect(
      verifySignature(
        "w_400,f_webp/https://example.com/a.jpg",
        signature,
        "test-secret",
      ),
    ).toBe(true);
    expect(verifySignature("other", signature, "test-secret")).toBe(false);
    expect(verifySignature("path", undefined, "test-secret")).toBe(false);
  });

  it("signs transform URLs with an optional expiry and validates the signature", () => {
    const url = signTransformUrl(
      "https://images.example/v1/img/w_400,f_webp/https://source.example/a.jpg",
      "test-secret",
      "2000000000",
    );
    const signed = new URL(url);
    const signature = signed.searchParams.get("sig") ?? undefined;
    expect(signature).toBeDefined();
    expect(
      verifyTransformSignature(
        "https://source.example/a.jpg",
        "w_400,f_webp",
        "2000000000",
        signature,
        "test-secret",
        1_900_000_000_000,
      ),
    ).toBe(true);
  });

  it("rejects tampered URLs and expired signatures", () => {
    const signature = createTransformSignature(
      "https://source.example/a.jpg",
      "w_400",
      "1000",
      "test-secret",
    );
    expect(
      verifyTransformSignature(
        "https://source.example/a.jpg",
        "w_800",
        "1000",
        signature,
        "test-secret",
        1_000_000,
      ),
    ).toBe(false);
    expect(
      verifyTransformSignature(
        "https://source.example/a.jpg",
        "w_400",
        "1000",
        signature,
        "test-secret",
        1_001_000,
      ),
    ).toBe(false);
  });

  it("allows unsigned requests only when signing is disabled", () => {
    expect(
      verifyTransformSignature(
        "https://source.example/a.jpg",
        "w_400",
        undefined,
        undefined,
        undefined,
      ),
    ).toBe(true);
    expect(
      verifyTransformSignature(
        "https://source.example/a.jpg",
        "w_400",
        "1000",
        undefined,
        undefined,
      ),
    ).toBe(false);
  });
});
