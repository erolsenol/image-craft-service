import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { transformImage } from "../../src/core/engine.js";

describe("transformImage", () => {
  it("resizes, converts and strips metadata by default", async () => {
    const input = await sharp({
      create: { width: 12, height: 8, channels: 3, background: "#f00" },
    })
      .png()
      .toBuffer();
    const result = await transformImage(
      input,
      [
        { op: "resize", width: 6 },
        { op: "format", format: "webp", quality: 75 },
      ],
      1000,
      100,
    );
    expect(result.contentType).toBe("image/webp");
    expect(result.width).toBe(6);
    expect((await sharp(result.buffer).metadata()).format).toBe("webp");
    expect((await sharp(result.buffer).metadata()).exif).toBeUndefined();
  });
  it("rejects oversized output dimensions", async () => {
    const input = await sharp({
      create: { width: 2, height: 2, channels: 3, background: "#fff" },
    })
      .png()
      .toBuffer();
    await expect(
      transformImage(input, [{ op: "resize", width: 20 }], 100, 10),
    ).rejects.toThrow("Output dimensions exceed limit");
  });
});
