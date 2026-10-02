import { describe, expect, it } from "vitest";
import {
  authenticateApiKey,
  hashApiKey,
  parseApiKeyDefinitions,
  requiredApiScope,
} from "../../src/security/api-keys.js";

describe("API key security", () => {
  it("authenticates a raw key only against its configured digest", () => {
    const key = "high-entropy-client-token";
    const digest = hashApiKey(key);
    expect(authenticateApiKey(key, "192.0.2.4", digest)).toMatchObject({
      id: digest,
      scopes: ["transform", "metadata", "batch:read", "batch:write"],
    });
    expect(authenticateApiKey(digest, "192.0.2.4", digest)).toBeUndefined();
    expect(authenticateApiKey("wrong", "192.0.2.4", digest)).toBeUndefined();
  });

  it("supports only explicitly configured scopes and validates hashes", () => {
    const digest = hashApiKey("batch-reader-token");
    const definition = parseApiKeyDefinitions(`${digest}=batch:read`)[0];
    expect(definition?.scopes).toEqual(["batch:read"]);
    expect(
      authenticateApiKey(
        "batch-reader-token",
        "127.0.0.1",
        `${digest}=batch:read`,
      ),
    ).toMatchObject({
      id: digest,
      scopes: ["batch:read"],
    });
    expect(() => parseApiKeyDefinitions("raw-secret")).toThrow(
      "SHA-256 hex digest",
    );
    expect(() => parseApiKeyDefinitions(`${digest}=root`)).toThrow(
      "unsupported scope",
    );
  });

  it("maps API routes to narrow scopes", () => {
    expect(requiredApiScope("/v1/metadata")).toBe("metadata");
    expect(requiredApiScope("/v1/batch")).toBe("batch:write");
    expect(requiredApiScope("/v1/jobs/abc/download")).toBe("batch:read");
    expect(requiredApiScope("/v1/img/w_100/https://example.com/a.jpg")).toBe(
      "transform",
    );
  });
});
