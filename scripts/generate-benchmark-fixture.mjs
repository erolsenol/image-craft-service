import { mkdir } from "node:fs/promises";
import sharp from "sharp";

const destination = "docs/benchmark-assets/benchmark.jpg";
await mkdir("docs/benchmark-assets", { recursive: true });
await sharp({
  create: {
    width: 2400,
    height: 1600,
    channels: 3,
    background: { r: 120, g: 80, b: 200 },
  },
})
  .jpeg({ quality: 90, chromaSubsampling: "4:4:4" })
  .toFile(destination);
console.log(`Generated ${destination}`);
