import sharp from "sharp";
import { describe, expect, it } from "vitest";
import {
  assertDecodedPixelBudget,
  validateImage,
} from "../../src/security/limits.js";

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

  it("counts all decoded pages against the pixel budget", () => {
    expect(() => assertDecodedPixelBudget(100, 100, 11, 100_000)).toThrow(
      "Image exceeds pixel limit",
    );
    expect(() => assertDecodedPixelBudget(100, 100, 10, 100_000)).not.toThrow();
  });

  it("rejects SVG input instead of passing active vector markup to an image decoder", async () => {
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    );
    await expect(validateImage(svg, 100_000)).rejects.toThrow(
      "Unsupported image type",
    );
  });
});
