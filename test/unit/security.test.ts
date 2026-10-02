import { describe, expect, it } from "vitest";
import { isPublicIp } from "../../src/security/ssrf.js";
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
  ])("blocks %s", (ip) => expect(isPublicIp(ip)).toBe(false));
  it.each(["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"])(
    "allows public address %s",
    (ip) => expect(isPublicIp(ip)).toBe(true),
  );
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
