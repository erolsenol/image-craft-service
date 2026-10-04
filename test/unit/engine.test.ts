import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { negotiateFormat, transformImage } from "../../src/core/engine.js";

describe("transformImage", () => {
  async function animatedFixture(format: "gif" | "webp"): Promise<Buffer> {
    const width = 8;
    const pageHeight = 6;
    const pages = 3;
    const pixels = Buffer.alloc(width * pageHeight * pages * 4);
    const colors = [
      [255, 0, 0],
      [0, 255, 0],
      [0, 0, 255],
    ];
    for (let page = 0; page < pages; page += 1) {
      const color = colors[page]!;
      for (
        let offset = page * width * pageHeight * 4;
        offset < (page + 1) * width * pageHeight * 4;
        offset += 4
      ) {
        pixels[offset] = color[0]!;
        pixels[offset + 1] = color[1]!;
        pixels[offset + 2] = color[2]!;
        pixels[offset + 3] = 255;
      }
    }
    return sharp(pixels, {
      raw: { width, height: pageHeight * pages, channels: 4, pageHeight },
    })
      .toFormat(format, { loop: 0, delay: [100, 100, 100] })
      .toBuffer();
  }

  it.each(["gif", "webp"] as const)(
    "resizes animated %s while preserving all frames",
    async (format) => {
      const input = await animatedFixture(format);
      const result = await transformImage(
        input,
        [{ op: "resize", width: 4 }],
        10_000,
        100,
      );
      const metadata = await sharp(result.buffer, {
        animated: true,
      }).metadata();
      expect(metadata.format).toBe(format);
      expect(metadata.pages).toBe(3);
      expect(metadata.width).toBe(4);
      expect(metadata.pageHeight).toBe(3);
      expect(metadata.delay).toEqual([100, 100, 100]);
    },
  );

  it("converts animated GIF to animated WebP", async () => {
    const result = await transformImage(
      await animatedFixture("gif"),
      [{ op: "format", format: "webp" }],
      10_000,
      100,
    );
    const metadata = await sharp(result.buffer, { animated: true }).metadata();
    expect(result.contentType).toBe("image/webp");
    expect(metadata.format).toBe("webp");
    expect(metadata.pages).toBe(3);
  });

  it("extracts the requested frame as a still image", async () => {
    const result = await transformImage(
      await animatedFixture("gif"),
      [],
      10_000,
      100,
      undefined,
      undefined,
      { frame: 1, maxFrames: 3 },
    );
    const metadata = await sharp(result.buffer).metadata();
    const { data } = await sharp(result.buffer)
      .raw()
      .toBuffer({ resolveWithObject: true });
    expect(metadata.pages ?? 1).toBe(1);
    expect(data[1]).toBeGreaterThan(data[0]!);
  });

  it("enforces frame and total-pixel budgets", async () => {
    const input = await animatedFixture("gif");
    await expect(
      transformImage(input, [], 10_000, 100, undefined, undefined, {
        maxFrames: 2,
      }),
    ).rejects.toThrow("animation frame limit");
    await expect(transformImage(input, [], 100, 100)).rejects.toThrow(
      "pixel limit",
    );
  });

  it("rejects frame indices outside the animation", async () => {
    await expect(
      transformImage(
        await animatedFixture("gif"),
        [],
        10_000,
        100,
        undefined,
        undefined,
        { frame: 3 },
      ),
    ).rejects.toThrow("frame does not exist");
  });

  it("rejects animated AVIF output while allowing still extraction", async () => {
    await expect(
      transformImage(
        await animatedFixture("gif"),
        [{ op: "format", format: "avif" }],
        10_000,
        100,
      ),
    ).rejects.toThrow("Animated AVIF output is not supported");
  });

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

  it("chooses a smart WebP quality with at most five encodes", async () => {
    const source = await sharp({
      create: { width: 96, height: 64, channels: 3, background: "#4973a9" },
    })
      .png()
      .toBuffer();
    const result = await transformImage(
      source,
      [{ op: "format", format: "webp", quality: "smart" }],
      10_000,
      256,
      undefined,
      undefined,
      { smartQualityThreshold: 0.98 },
    );
    expect(result.contentType).toBe("image/webp");
    expect(result.smartQuality?.quality).toBeGreaterThanOrEqual(30);
    expect(result.smartQuality?.quality).toBeLessThanOrEqual(95);
    expect(result.smartQuality?.ssim).toBeGreaterThanOrEqual(0.98);
    expect(result.smartQuality?.thresholdMet).toBe(true);
  });
});
