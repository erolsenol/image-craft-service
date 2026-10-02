import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { validateImage } from "../../src/security/limits.js";

describe("image decompression limits", () => {
  it("rejects decoded images above the configured pixel budget", async () => {
    const image = await sharp({
      create: { width: 20, height: 20, channels: 3, background: "red" },
    })
      .png()
      .toBuffer();
    await expect(validateImage(image, 100)).rejects.toThrow(
      "Image exceeds pixel limit",
    );
  });
});
