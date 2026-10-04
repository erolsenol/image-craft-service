import sharp from "sharp";

export interface SmartQualityResult {
  readonly buffer: Buffer;
  readonly quality: number;
  readonly ssim: number;
  readonly thresholdMet: boolean;
}

const MAX_ENCODINGS = 5;
const MIN_QUALITY = 30;
const MAX_QUALITY = 95;

/** Binary searches quality using no more than five lossy encodes. */
export async function findSmartQuality(
  reference: { data: Buffer; width: number; height: number },
  encode: (quality: number) => Promise<Buffer>,
  threshold: number,
): Promise<SmartQualityResult> {
  const referencePixels = reference.data;
  let best: SmartQualityResult | undefined;
  let encodings = 0;

  const measure = async (quality: number): Promise<SmartQualityResult> => {
    const buffer = await encode(quality);
    const candidate = await comparisonPixels(
      buffer,
      reference.width,
      reference.height,
    );
    return {
      buffer,
      quality,
      ssim: calculateSsim(referencePixels, candidate),
      thresholdMet: false,
    };
  };

  // Establish a valid upper bound first, then spend the remaining budget narrowing it.
  const highest = await measure(MAX_QUALITY);
  encodings += 1;
  if (highest.ssim >= threshold) best = { ...highest, thresholdMet: true };

  let low = MIN_QUALITY;
  let high = MAX_QUALITY - 1;
  while (encodings < MAX_ENCODINGS && low <= high && best) {
    const quality = Math.ceil((low + high) / 2);
    const measured = await measure(quality);
    encodings += 1;
    if (measured.ssim >= threshold) {
      best = { ...measured, thresholdMet: true };
      high = quality - 1;
    } else {
      low = quality + 1;
    }
  }

  return best ?? highest;
}

export async function measureSsim(
  reference: { data: Buffer; width: number; height: number },
  candidate: Buffer,
): Promise<number> {
  return calculateSsim(
    reference.data,
    await comparisonPixels(candidate, reference.width, reference.height),
  );
}

async function comparisonPixels(
  input: Buffer,
  width: number,
  height: number,
): Promise<Buffer> {
  return sharp(input, { limitInputPixels: 100_000_000 })
    .resize(width, height, { fit: "fill" })
    .removeAlpha()
    .greyscale()
    .raw()
    .toBuffer();
}

// Mean luminance SSIM over the bounded comparison image; no extra image dependency is needed.
function calculateSsim(reference: Buffer, candidate: Buffer): number {
  if (reference.length !== candidate.length || reference.length === 0) return 0;
  const count = reference.length;
  let meanReference = 0;
  let meanCandidate = 0;
  for (let index = 0; index < count; index += 1) {
    meanReference += reference[index]!;
    meanCandidate += candidate[index]!;
  }
  meanReference /= count;
  meanCandidate /= count;
  let varianceReference = 0;
  let varianceCandidate = 0;
  let covariance = 0;
  for (let index = 0; index < count; index += 1) {
    const left = reference[index]! - meanReference;
    const right = candidate[index]! - meanCandidate;
    varianceReference += left * left;
    varianceCandidate += right * right;
    covariance += left * right;
  }
  const divisor = Math.max(1, count - 1);
  varianceReference /= divisor;
  varianceCandidate /= divisor;
  covariance /= divisor;
  const c1 = (0.01 * 255) ** 2;
  const c2 = (0.03 * 255) ** 2;
  return (
    ((2 * meanReference * meanCandidate + c1) * (2 * covariance + c2)) /
    ((meanReference ** 2 + meanCandidate ** 2 + c1) *
      (varianceReference + varianceCandidate + c2))
  );
}
