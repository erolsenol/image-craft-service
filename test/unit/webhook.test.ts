import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sendSignedWebhook } from "../../src/security/webhook.js";

describe("completion webhooks", () => {
  it("pins one validated public DNS answer and signs the request body", async () => {
    let resolutions = 0;
    let request:
      | { address: string; body: string; signature: string; timestamp: string }
      | undefined;
    const payload = { jobId: "job-1", status: "done" };
    const secret = "a-long-test-webhook-secret";
    await sendSignedWebhook(
      "https://hooks.example/callback",
      payload,
      secret,
      1000,
      {
        resolveAddresses: async () => {
          resolutions += 1;
          return ["8.8.8.8"];
        },
        requestPinned: async (url, address, body, signature, timestamp) => {
          request = { address, body, signature, timestamp };
          expect(url.hostname).toBe("hooks.example");
          return 204;
        },
      },
    );
    expect(resolutions).toBe(1);
    expect(request?.address).toBe("8.8.8.8");
    expect(request?.body).toBe(JSON.stringify(payload));
    expect(request?.signature).toBe(
      createHmac("sha256", secret)
        .update(`${request?.timestamp}.${JSON.stringify(payload)}`)
        .digest("hex"),
    );
  });

  it("rejects private DNS answers and redirect responses", async () => {
    await expect(
      sendSignedWebhook("https://hooks.example/callback", {}, "secret", 1000, {
        resolveAddresses: async () => ["127.0.0.1"],
        requestPinned: async () => 204,
      }),
    ).rejects.toThrow("Webhook host is not allowed");
    await expect(
      sendSignedWebhook("https://hooks.example/callback", {}, "secret", 1000, {
        resolveAddresses: async () => ["8.8.8.8"],
        requestPinned: async () => 302,
      }),
    ).rejects.toThrow("Webhook redirects are not allowed");
  });
});
