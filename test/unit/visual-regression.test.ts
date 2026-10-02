import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import sharp from "sharp";
import { beforeAll, describe, expect, it } from "vitest";
import type { CoreOperation } from "../../src/api/schemas/operations.js";
import { transformImage } from "../../src/core/engine.js";

const cases: Array<{
  name: string;
  operation: CoreOperation;
  accept?: string;
}> = [
  { name: "resize", operation: { op: "resize", width: 16, height: 12 } },
  {
    name: "smart-attention",
    operation: { op: "resize", width: 16, height: 16, strategy: "attention" },
  },
  {
    name: "smart-entropy",
    operation: { op: "resize", width: 16, height: 16, strategy: "entropy" },
  },
  {
    name: "crop",
    operation: { op: "crop", left: 4, top: 2, width: 16, height: 12 },
  },
  {
    name: "focal-crop",
    operation: {
      op: "crop",
      left: 0,
      top: 0,
      width: 16,
      height: 12,
      fx: 0.8,
      fy: 0.2,
    },
  },
  { name: "rotate", operation: { op: "rotate", angle: 90 } },
  { name: "blur", operation: { op: "blur", sigma: 1.2 } },
  { name: "sharpen", operation: { op: "sharpen", sigma: 1.4 } },
  { name: "grayscale", operation: { op: "grayscale" } },
  {
    name: "watermark",
    operation: { op: "watermark", image: "", gravity: "center", opacity: 0.5 },
  },
  {
    name: "format-webp",
    operation: { op: "format", format: "webp", quality: 80 },
  },
  {
    name: "format-auto",
    operation: { op: "format", format: "auto" },
    accept: "image/avif,image/webp",
  },
  {
    name: "padding",
    operation: {
      op: "padding",
      top: 2,
      right: 3,
      bottom: 4,
      left: 1,
      background: "#ffcc00",
    },
  },
  { name: "flip", operation: { op: "flip" } },
  { name: "flop", operation: { op: "flop" } },
  { name: "tint", operation: { op: "tint", color: "#ff8800" } },
  { name: "brightness", operation: { op: "adjust", brightness: 1.2 } },
  { name: "contrast", operation: { op: "adjust", contrast: 0.2 } },
  { name: "saturation", operation: { op: "adjust", saturation: 1.5 } },
  { name: "rounded-corners", operation: { op: "roundedCorners", radius: 6 } },
];

const goldenDirectory = join(process.cwd(), "test/fixtures/golden");
let input: Buffer;
let watermark: Buffer;

beforeAll(async () => {
  const pixels = Buffer.alloc(24 * 18 * 3);
  for (let y = 0; y < 18; y += 1) {
    for (let x = 0; x < 24; x += 1) {
      const offset = (y * 24 + x) * 3;
      pixels[offset] = (x * 11 + y * 3) % 256;
      pixels[offset + 1] = (y * 13 + x * 2) % 256;
      pixels[offset + 2] = ((x + y) * 9) % 256;
    }
  }
  input = await sharp(pixels, { raw: { width: 24, height: 18, channels: 3 } })
    .png()
    .toBuffer();
  watermark = await sharp({
    create: { width: 4, height: 4, channels: 4, background: "#ffffff" },
  })
    .png()
    .toBuffer();
  cases.find(({ name }) => name === "watermark")!.operation = {
    op: "watermark",
    image: watermark.toString("base64url"),
    gravity: "center",
    opacity: 0.5,
  };
});

describe("visual regression for image operations", () => {
  it.each(cases)(
    "matches the $name golden image",
    async ({ name, operation, accept }) => {
      const result = await transformImage(
        input,
        [operation],
        10_000,
        100,
        accept,
      );
      const actual = await comparisonPng(result.buffer);
      const path = join(goldenDirectory, `${name}.png`);
      if (process.env.UPDATE_GOLDENS === "1") {
        await mkdir(goldenDirectory, { recursive: true });
        await writeFile(path, actual);
      }
      const expected = PNG.sync.read(await readFile(path));
      const received = PNG.sync.read(actual);
      expect(received.width).toBe(expected.width);
      expect(received.height).toBe(expected.height);
      const diff = new PNG({ width: expected.width, height: expected.height });
      const mismatched = pixelmatch(
        expected.data,
        received.data,
        diff.data,
        expected.width,
        expected.height,
        {
          threshold: 0.08,
          includeAA: false,
        },
      );
      expect(
        mismatched / (expected.width * expected.height),
      ).toBeLessThanOrEqual(0.01);
    },
  );
});

async function comparisonPng(image: Buffer): Promise<Buffer> {
  return sharp(image)
    .resize(48, 48, {
      fit: "contain",
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .ensureAlpha()
    .png()
    .toBuffer();
}
