import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { findSmartQuality } from "../../src/core/smart-quality.js";

describe("smart quality search", () => {
  it("uses no more than five candidate encodes and meets the requested SSIM", async () => {
    const width = 96;
    const height = 64;
    const pixels = Buffer.alloc(width * height * 3);
    for (let index = 0; index < pixels.length; index += 3) {
      const x = (index / 3) % width;
      const y = Math.floor(index / 3 / width);
      pixels[index] = (x * 13 + y * 7) % 256;
      pixels[index + 1] = (x * 3 + y * 19) % 256;
      pixels[index + 2] = (x * 17 + y * 11) % 256;
    }
    const reference = await sharp(pixels, {
      raw: { width, height, channels: 3 },
    })
      .resize(128, 128, { fit: "inside", withoutEnlargement: true })
      .greyscale()
      .raw()
      .toBuffer({ resolveWithObject: true });
    let encodeCount = 0;
    const result = await findSmartQuality(
      {
        data: reference.data,
        width: reference.info.width,
        height: reference.info.height,
      },
      async (quality) => {
        encodeCount += 1;
        return sharp(pixels, { raw: { width, height, channels: 3 } })
          .webp({ quality })
          .toBuffer();
      },
      0.98,
    );
    expect(encodeCount).toBeLessThanOrEqual(5);
    expect(result.quality).toBeGreaterThanOrEqual(30);
    expect(result.thresholdMet).toBe(true);
    expect(result.ssim).toBeGreaterThanOrEqual(0.98);
  });
});
