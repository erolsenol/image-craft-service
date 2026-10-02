import { describe, expect, it } from "vitest";
import {
  fetchRemoteImage,
  isPublicIp,
  resolvePublicAddresses,
} from "../../src/security/ssrf.js";
import { signPath, verifySignature } from "../../src/security/signing.js";

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
});
