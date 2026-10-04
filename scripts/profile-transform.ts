import sharp from "sharp";
import { transformImage } from "../src/core/engine.js";

const iterations = Number(process.env.PROFILE_ITERATIONS ?? 12);
const width = Number(process.env.PROFILE_WIDTH ?? 2400);
const height = Number(process.env.PROFILE_HEIGHT ?? 1600);
sharp.concurrency(Number(process.env.SHARP_CONCURRENCY ?? 2));
sharp.cache({
  memory: Number(process.env.SHARP_CACHE_MEMORY_MB ?? 32),
  files: 0,
  items: 100,
});
const input = await sharp({
  create: {
    width,
    height,
    channels: 3,
    background: { r: 120, g: 80, b: 200 },
  },
})
  .png()
  .toBuffer();

const measurements = [];
for (const format of ["webp", "avif"] as const) {
  const start = performance.now();
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    await transformImage(
      input,
      [
        { op: "resize", width: 800 },
        { op: "format", format, quality: 75 },
      ],
      40_000_000,
      4096,
    );
  }
  const elapsedMs = performance.now() - start;
  measurements.push({
    format,
    iterations,
    totalMs: Number(elapsedMs.toFixed(1)),
    perImageMs: Number((elapsedMs / iterations).toFixed(2)),
    processRssBytes: process.memoryUsage().rss,
  });
}

console.log(
  JSON.stringify(
    {
      node: process.version,
      sharp: sharp.versions.sharp,
      libvips: sharp.versions.vips,
      sharpConcurrency: sharp.concurrency(),
      sharpCache: sharp.cache(),
      input: { width, height, bytes: input.byteLength },
      measurements,
    },
    null,
    2,
  ),
);
