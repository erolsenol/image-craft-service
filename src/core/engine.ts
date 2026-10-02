import { AppError } from "./errors.js";
import sharp, { type FitEnum, type Gravity } from "sharp";
import type { Operation } from "../api/schemas/operations.js";
import { assertOutputDimensions } from "../security/limits.js";

export interface TransformResult {
  buffer: Buffer;
  contentType: string;
  width: number;
  height: number;
}
const contentTypes = {
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  avif: "image/avif",
} as const;

export async function transformImage(
  input: Buffer,
  operations: readonly Operation[],
  maxPixels: number,
  maxDimension: number,
): Promise<TransformResult> {
  const initial = await sharp(input, {
    limitInputPixels: maxPixels,
    failOn: "error",
  }).metadata();
  if (
    !initial.width ||
    !initial.height ||
    initial.width * initial.height > maxPixels
  )
    throw new AppError("Image exceeds pixel limit", 413);
  const resizeOps = operations.filter((operation) => operation.op === "resize");
  for (const operation of resizeOps)
    assertOutputDimensions(operation.width, operation.height, maxDimension);
  const image = sharp(input, { limitInputPixels: maxPixels, failOn: "error" });
  let outputFormat: keyof typeof contentTypes = "jpeg";
  for (const operation of operations) {
    switch (operation.op) {
      case "resize":
        image.resize(operation.width, operation.height, {
          fit: (operation.fit ?? "cover") as keyof FitEnum,
        });
        break;
      case "crop":
        image.extract({
          left: operation.left,
          top: operation.top,
          width: operation.width,
          height: operation.height,
        });
        break;
      case "rotate":
        image.rotate(operation.angle);
        break;
      case "blur":
        image.blur(operation.sigma);
        break;
      case "sharpen":
        image.sharpen({ sigma: operation.sigma ?? 1 });
        break;
      case "grayscale":
        image.grayscale();
        break;
      case "watermark":
        image.composite([
          {
            input: watermarkSvg(operation.text),
            gravity: (operation.gravity ?? "southeast") as Gravity,
          },
        ]);
        break;
      case "format":
        outputFormat = operation.format;
        image.toFormat(
          operation.format,
          operation.quality === undefined ? {} : { quality: operation.quality },
        );
        break;
    }
  }
  const { data, info } = await image.toBuffer({ resolveWithObject: true });
  if (info.width > maxDimension || info.height > maxDimension)
    throw new AppError("Output dimensions exceed limit", 413);
  return {
    buffer: data,
    contentType: contentTypes[outputFormat],
    width: info.width,
    height: info.height,
  };
}

function watermarkSvg(text: string): Buffer {
  const escaped = text.replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&apos;",
      })[character]!,
  );
  return Buffer.from(
    `<svg width="1200" height="160"><text x="1180" y="120" text-anchor="end" font-family="sans-serif" font-size="64" fill="white" stroke="black" stroke-width="2">${escaped}</text></svg>`,
  );
}
