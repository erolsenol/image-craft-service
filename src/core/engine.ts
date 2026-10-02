import { AppError } from "./errors.js";
import sharp, {
  type FitEnum,
  type FormatEnum,
  type Gravity,
  type OverlayOptions,
  type OutputInfo,
} from "sharp";
import type { CoreOperation } from "../api/schemas/operations.js";
import { assertOutputDimensions } from "../security/limits.js";
import { performance } from "node:perf_hooks";

export interface TransformResult {
  buffer: Buffer;
  contentType: string;
  width: number;
  height: number;
}

const contentTypes: Record<string, string> = {
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  avif: "image/avif",
  heif: "image/heif",
  gif: "image/gif",
  tiff: "image/tiff",
};

export async function transformImage(
  input: Buffer,
  operations: readonly CoreOperation[],
  maxPixels: number,
  maxDimension: number,
  accept?: string,
  observeOperation?: (operation: string, durationSeconds: number) => void,
): Promise<TransformResult> {
  const inputImage = sharp(input, {
    limitInputPixels: maxPixels,
    failOn: "error",
  });
  const initial = await inputImage.metadata();
  if (
    !initial.width ||
    !initial.height ||
    initial.width * initial.height > maxPixels
  )
    throw new AppError("Image exceeds pixel limit", 413);

  for (const operation of operations) {
    if (operation.op === "resize")
      assertOutputDimensions(operation.width, operation.height, maxDimension);
    if (operation.op === "crop")
      assertOutputDimensions(operation.width, operation.height, maxDimension);
    if (operation.op === "padding") {
      assertOutputDimensions(
        initial.width + operation.left + operation.right,
        initial.height + operation.top + operation.bottom,
        maxDimension,
      );
    }
  }

  const oriented = await inputImage.rotate().toBuffer();
  let image = sharp(oriented, { limitInputPixels: maxPixels, failOn: "error" });
  const hasAutoFormat = operations.some(
    (operation) => operation.op === "format" && operation.format === "auto",
  );
  const inputFormat =
    initial.format === "heif" && initial.compression === "av1"
      ? "avif"
      : (initial.format ?? "jpeg");
  let outputFormat: string = hasAutoFormat
    ? inputFormat in contentTypes
      ? inputFormat
      : "jpeg"
    : "jpeg";
  let outputQuality: number | undefined;
  let roundedRadius: number | undefined;
  for (const operation of operations) {
    const operationStarted = performance.now();
    try {
      switch (operation.op) {
        case "resize": {
          if (operation.fx !== undefined && operation.fy !== undefined) {
            const targetWidth = operation.width ?? initial.width;
            const targetHeight = operation.height ?? initial.height;
            const prior = await image
              .png()
              .toBuffer({ resolveWithObject: true });
            const crop = focalCrop(
              prior.info.width,
              prior.info.height,
              targetWidth,
              targetHeight,
              operation.fx,
              operation.fy,
            );
            image = sharp(prior.data)
              .extract(crop)
              .resize(targetWidth, targetHeight);
          } else {
            image.resize(operation.width, operation.height, {
              fit: (operation.fit ?? "cover") as keyof FitEnum,
              ...(operation.strategy ? { position: operation.strategy } : {}),
            });
          }
          break;
        }
        case "crop": {
          if (operation.strategy) {
            image.resize(operation.width, operation.height, {
              fit: "cover",
              position: operation.strategy,
            });
          } else if (operation.fx !== undefined && operation.fy !== undefined) {
            const prior = await image
              .png()
              .toBuffer({ resolveWithObject: true });
            const crop = focalCrop(
              prior.info.width,
              prior.info.height,
              operation.width,
              operation.height,
              operation.fx,
              operation.fy,
            );
            image = sharp(prior.data)
              .extract(crop)
              .resize(operation.width, operation.height);
          } else {
            image.extract({
              left: operation.left,
              top: operation.top,
              width: operation.width,
              height: operation.height,
            });
          }
          break;
        }
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
          if (operation.text !== undefined) {
            const prior = await image
              .png()
              .toBuffer({ resolveWithObject: true });
            image = sharp(prior.data).composite([
              {
                input: watermarkSvg(
                  operation.text,
                  operation.opacity ?? 1,
                  prior.info.width,
                  prior.info.height,
                  operation.position ?? operation.gravity ?? "southeast",
                ),
              },
            ]);
          } else {
            image.composite([
              await imageWatermark(
                operation.image!,
                operation.position ?? operation.gravity,
                operation.opacity,
              ),
            ]);
          }
          break;
        case "format":
          outputFormat =
            operation.format === "auto"
              ? negotiateFormat(accept, inputFormat)
              : operation.format;
          outputQuality = operation.quality;
          break;
        case "padding":
          image.extend({
            top: operation.top,
            right: operation.right,
            bottom: operation.bottom,
            left: operation.left,
            background: operation.background,
          });
          break;
        case "flip":
          image.flip();
          break;
        case "flop":
          image.flop();
          break;
        case "tint":
          image.tint(operation.color);
          break;
        case "adjust":
          image.modulate({
            ...(operation.brightness === undefined
              ? {}
              : { brightness: operation.brightness }),
            ...(operation.saturation === undefined
              ? {}
              : { saturation: operation.saturation }),
          });
          if (operation.contrast !== undefined) {
            const multiplier = operation.contrast + 1;
            image.linear(multiplier, 128 * (1 - multiplier));
          }
          break;
        case "roundedCorners":
          roundedRadius = operation.radius;
          break;
      }
    } finally {
      observeOperation?.(
        operation.op,
        (performance.now() - operationStarted) / 1000,
      );
    }
  }

  let { data, info } = await image.png().toBuffer({ resolveWithObject: true });
  if (roundedRadius !== undefined) {
    const mask = roundedCornersSvg(info.width, info.height, roundedRadius);
    data = await sharp(data)
      .composite([{ input: mask, blend: "dest-in" }])
      .png()
      .toBuffer();
  }
  if (info.width > maxDimension || info.height > maxDimension)
    throw new AppError("Output dimensions exceed limit", 413);
  const formatted = await sharp(data, { limitInputPixels: maxPixels })
    .toFormat(outputFormat as keyof FormatEnum, {
      ...(outputQuality === undefined ? {} : { quality: outputQuality }),
    })
    .toBuffer({ resolveWithObject: true });
  const actualFormat = formatted.info.format;
  const contentType = contentTypes[outputFormat] ?? contentTypes[actualFormat];
  if (!contentType) throw new AppError("Unsupported output format", 400);
  return {
    buffer: formatted.data,
    contentType,
    width: formatted.info.width,
    height: formatted.info.height,
  };
}

export function negotiateFormat(
  accept: string | undefined,
  original: string,
): string {
  const accepted = new Map<string, number>();
  for (const item of (accept ?? "").split(",")) {
    const [mediaType, ...parameters] = item.trim().toLowerCase().split(";");
    if (!mediaType) continue;
    const quality = parameters
      .map((parameter) => parameter.trim())
      .find((parameter) => parameter.startsWith("q="));
    const value = quality ? Number(quality.slice(2)) : 1;
    if (Number.isFinite(value) && value > 0) accepted.set(mediaType, value);
  }
  const wildcardQuality = accepted.get("image/*") ?? accepted.get("*/*") ?? 0;
  if ((accepted.get("image/avif") ?? wildcardQuality) > 0) return "avif";
  if ((accepted.get("image/webp") ?? wildcardQuality) > 0) return "webp";
  return original;
}

async function imageWatermark(
  encoded: string,
  gravity: string | undefined,
  opacity = 1,
): Promise<OverlayOptions> {
  const png = Buffer.from(encoded, "base64url");
  if (
    png.byteLength === 0 ||
    png.byteLength > 1024 * 1024 ||
    !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    throw new AppError("Image watermark must be a PNG under 1 MiB", 400);
  const watermark = sharp(png, {
    limitInputPixels: 4_000_000,
    failOn: "error",
  });
  let rawData: Buffer;
  let rawInfo: OutputInfo;
  try {
    const metadata = await watermark.metadata();
    if (
      !metadata.width ||
      !metadata.height ||
      metadata.width * metadata.height > 4_000_000
    )
      throw new AppError("Image watermark exceeds pixel limit", 400);
    const raw = await watermark
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    rawData = raw.data;
    rawInfo = raw.info;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("Invalid PNG image watermark", 400);
  }
  for (let index = 3; index < rawData.length; index += 4)
    rawData[index] = Math.round((rawData[index] ?? 0) * opacity);
  const overlay = await sharp(rawData, {
    raw: { width: rawInfo.width, height: rawInfo.height, channels: 4 },
  })
    .png()
    .toBuffer();
  return {
    input: overlay,
    gravity: (gravity ?? "southeast") as Gravity,
  };
}

function focalCrop(
  sourceWidth: number,
  sourceHeight: number,
  targetWidth: number,
  targetHeight: number,
  fx: number,
  fy: number,
): { left: number; top: number; width: number; height: number } {
  const targetRatio = targetWidth / targetHeight;
  const sourceRatio = sourceWidth / sourceHeight;
  const width =
    sourceRatio > targetRatio
      ? Math.max(1, Math.round(sourceHeight * targetRatio))
      : sourceWidth;
  const height =
    sourceRatio > targetRatio
      ? sourceHeight
      : Math.max(1, Math.round(sourceWidth / targetRatio));
  return {
    left: Math.min(
      sourceWidth - width,
      Math.max(0, Math.round(fx * sourceWidth - width / 2)),
    ),
    top: Math.min(
      sourceHeight - height,
      Math.max(0, Math.round(fy * sourceHeight - height / 2)),
    ),
    width,
    height,
  };
}

function watermarkSvg(
  text: string,
  opacity: number,
  width: number,
  height: number,
  gravity: string,
): Buffer {
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
  const horizontal =
    gravity.includes("west") || gravity === "west"
      ? { x: 4, anchor: "start" }
      : gravity.includes("east") || gravity === "east"
        ? { x: width - 4, anchor: "end" }
        : { x: Math.round(width / 2), anchor: "middle" };
  const y =
    gravity.startsWith("north") || gravity === "north"
      ? Math.min(height, 20)
      : gravity === "center"
        ? Math.round(height / 2)
        : Math.max(1, height - 4);
  const fontSize = Math.max(1, Math.min(20, Math.round(height * 0.35)));
  return Buffer.from(
    `<svg width="${width}" height="${height}"><text x="${horizontal.x}" y="${y}" text-anchor="${horizontal.anchor}" font-family="sans-serif" font-size="${fontSize}" fill="white" fill-opacity="${opacity}" stroke="black" stroke-width="1">${escaped}</text></svg>`,
  );
}

function roundedCornersSvg(
  width: number,
  height: number,
  radius: number,
): Buffer {
  const boundedRadius = Math.min(
    radius,
    Math.floor(Math.min(width, height) / 2),
  );
  return Buffer.from(
    `<svg width="${width}" height="${height}"><rect width="${width}" height="${height}" rx="${boundedRadius}" fill="white"/></svg>`,
  );
}
