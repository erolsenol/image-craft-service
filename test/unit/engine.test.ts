import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { negotiateFormat, transformImage } from "../../src/core/engine.js";

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

  it("renders text watermarks", async () => {
    const input = await sharp({
      create: { width: 64, height: 48, channels: 3, background: "#808080" },
    })
      .png()
      .toBuffer();
    const result = await transformImage(
      input,
      [{ op: "watermark", text: "demo", opacity: 0.7 }],
      10_000,
      100,
    );
    const before = await sharp(input).raw().toBuffer();
    const after = await sharp(result.buffer).raw().toBuffer();
    expect(after.some((channel, index) => channel !== before[index])).toBe(
      true,
    );
  });

  it("rasterizes markup-like watermark text without returning SVG", async () => {
    const input = await sharp({
      create: { width: 64, height: 48, channels: 3, background: "#808080" },
    })
      .png()
      .toBuffer();
    const result = await transformImage(
      input,
      [{ op: "watermark", text: '<script>alert("x")</script>' }],
      10_000,
      100,
    );
    expect(result.contentType).toBe("image/jpeg");
    expect(result.buffer.subarray(0, 4).toString("ascii")).not.toContain(
      "<svg",
    );
    expect((await sharp(result.buffer).metadata()).format).toBe("jpeg");
  });

  it("rejects SVG disguised as an image watermark", async () => {
    const input = await sharp({
      create: { width: 16, height: 16, channels: 3, background: "#fff" },
    })
      .png()
      .toBuffer();
    const encodedSvg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg"/>',
    ).toString("base64url");
    await expect(
      transformImage(
        input,
        [{ op: "watermark", image: encodedSvg }],
        1000,
        100,
      ),
    ).rejects.toThrow("Image watermark must be a PNG");
  });

  it("auto-orients EXIF images before operations and strips metadata", async () => {
    const input = await sharp({
      create: { width: 12, height: 8, channels: 3, background: "#f00" },
    })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();
    const result = await transformImage(input, [], 1000, 100);
    const metadata = await sharp(result.buffer).metadata();
    expect(result.width).toBe(8);
    expect(result.height).toBe(12);
    expect(metadata.orientation).toBeUndefined();
    expect(metadata.exif).toBeUndefined();
  });

  it("prefers AVIF then WebP and falls back to the source format", () => {
    expect(negotiateFormat("image/avif,image/webp", "png")).toBe("avif");
    expect(negotiateFormat("image/webp", "png")).toBe("webp");
    expect(negotiateFormat("image/avif;q=0,image/webp;q=0", "png")).toBe("png");
    expect(negotiateFormat("*/*", "png")).toBe("avif");
  });

  it("preserves AVIF source format when auto negotiation falls back to original", async () => {
    const source = await sharp({
      create: { width: 6, height: 4, channels: 3, background: "#fa0" },
    })
      .avif()
      .toBuffer();
    const result = await transformImage(
      source,
      [{ op: "format", format: "auto" }],
      100,
      100,
      "image/jpeg",
    );
    expect(result.contentType).toBe("image/avif");
  });
});
