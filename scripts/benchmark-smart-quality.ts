import { readFile } from "node:fs/promises";
import sharp from "sharp";
import { transformImage } from "../src/core/engine.js";

const inputPath = process.argv[2];
const source = inputPath
  ? await readFile(inputPath)
  : await sharp({
      create: {
        width: 1600,
        height: 1200,
        channels: 3,
        background: { r: 55, g: 104, b: 163 },
      },
    })
      .png()
      .toBuffer();

console.log(
  `Input: ${inputPath ?? "generated 1600x1200 PNG"} (${source.length} bytes)`,
);
console.log("Format | quality | SSIM | output bytes | savings | elapsed ms");
for (const format of ["webp", "avif"] as const) {
  const started = performance.now();
  const result = await transformImage(
    source,
    [{ op: "format", format, quality: "smart" }],
    40_000_000,
    4096,
    undefined,
    undefined,
    { smartQualityThreshold: 0.98 },
  );
  const elapsed = (performance.now() - started).toFixed(1);
  const savings = ((1 - result.buffer.length / source.length) * 100).toFixed(1);
  console.log(
    `${format} | ${result.smartQuality?.quality} | ${result.smartQuality?.ssim.toFixed(4)} | ${result.buffer.length} | ${savings}% | ${elapsed}`,
  );
}
