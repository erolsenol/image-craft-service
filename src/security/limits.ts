import { AppError } from "../core/errors.js";
import sharp from "sharp";

const allowedMimeTypes = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/avif",
  "image/gif",
  "image/tiff",
]);
export async function validateImage(
  buffer: Buffer,
  maxPixels: number,
): Promise<string> {
  const mime = sniffImageMime(buffer);
  if (!mime || !allowedMimeTypes.has(mime))
    throw new AppError("Unsupported image type", 415);
  const metadata = await sharp(buffer, {
    limitInputPixels: maxPixels,
    failOn: "error",
  }).metadata();
  if (
    !metadata.width ||
    !metadata.height ||
    metadata.width * metadata.height > maxPixels
  )
    throw new AppError("Image exceeds pixel limit", 413);
  return mime;
}

export function assertOutputDimensions(
  width: number | undefined,
  height: number | undefined,
  maxDimension: number,
): void {
  if (
    (width !== undefined && width > maxDimension) ||
    (height !== undefined && height > maxDimension)
  )
    throw new AppError("Output dimensions exceed limit", 413);
}

function sniffImageMime(buffer: Buffer): string | undefined {
  if (
    buffer.length >= 3 &&
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[2] === 0xff
  )
    return "image/jpeg";
  if (
    buffer.length >= 8 &&
    buffer
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  )
    return "image/png";
  if (
    buffer.length >= 6 &&
    ["GIF87a", "GIF89a"].includes(buffer.toString("ascii", 0, 6))
  )
    return "image/gif";
  if (
    buffer.length >= 12 &&
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WEBP"
  )
    return "image/webp";
  if (
    buffer.length >= 12 &&
    buffer.toString("ascii", 4, 8) === "ftyp" &&
    /^(avif|avis)$/.test(buffer.toString("ascii", 8, 12))
  )
    return "image/avif";
  if (
    buffer.length >= 4 &&
    (buffer.subarray(0, 4).equals(Buffer.from([0x49, 0x49, 0x2a, 0x00])) ||
      buffer.subarray(0, 4).equals(Buffer.from([0x4d, 0x4d, 0x00, 0x2a])))
  )
    return "image/tiff";
  return undefined;
}
