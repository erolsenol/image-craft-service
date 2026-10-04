import { AppError } from "./errors.js";

export interface PdfRasterizer {
  render(
    pdf: Buffer,
    options: { readonly page: number; readonly dpi: number },
  ): Promise<Buffer>;
}

export interface HttpPdfRasterizerOptions {
  readonly workerUrl: string;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly fetch?: typeof fetch;
}

export function createHttpPdfRasterizer(
  options: HttpPdfRasterizerOptions,
): PdfRasterizer {
  const worker = new URL(options.workerUrl);
  if (
    !["http:", "https:"].includes(worker.protocol) ||
    worker.username ||
    worker.password
  )
    throw new Error("PDF rasterizer URL must be a credential-free HTTP(S) URL");
  const fetcher = options.fetch ?? fetch;
  const baseUrl = worker.toString().replace(/\/+$/u, "");
  let queue = Promise.resolve();

  const renderOne = async (
    pdf: Buffer,
    renderOptions: { readonly page: number; readonly dpi: number },
  ): Promise<Buffer> => {
    let health: Response;
    try {
      health = await fetcher(`${baseUrl}/health`, {
        signal: AbortSignal.timeout(options.timeoutMs),
      });
    } catch {
      throw new AppError("PDF rasterizer is unavailable", 503);
    }
    if (!health.ok) throw new AppError("PDF rasterizer is unavailable", 503);

    let response: Response;
    try {
      response = await fetcher(`${baseUrl}/render`, {
        method: "POST",
        headers: {
          "content-type": "application/pdf",
          "x-pdf-page": String(renderOptions.page),
          "x-pdf-dpi": String(renderOptions.dpi),
        },
        body: new Uint8Array(pdf),
        signal: AbortSignal.timeout(options.timeoutMs),
      });
    } catch {
      throw new AppError("PDF rasterizer is unavailable", 503);
    }
    if (!response.ok) {
      if (response.status === 400)
        throw new AppError("Invalid PDF or page selection", 400);
      if (response.status === 413)
        throw new AppError("PDF exceeds configured limits", 413);
      if (response.status === 415)
        throw new AppError("Input is not a PDF", 415);
      throw new AppError("PDF rasterizer failed", 503);
    }
    if (!response.body) throw new AppError("PDF rasterizer failed", 503);

    const chunks: Buffer[] = [];
    let totalBytes = 0;
    const reader = response.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        totalBytes += value.byteLength;
        if (totalBytes > options.maxOutputBytes) {
          await reader.cancel();
          throw new AppError("Rendered PDF page exceeds size limit", 413);
        }
        chunks.push(Buffer.from(value));
      }
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError("PDF rasterizer response was interrupted", 503);
    }
    const image = Buffer.concat(chunks, totalBytes);
    if (
      image.length < 8 ||
      !image
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    )
      throw new AppError("PDF rasterizer returned invalid image data", 503);
    return image;
  };

  return {
    render(pdf, renderOptions) {
      const task = queue.then(() => renderOne(pdf, renderOptions));
      queue = task.then(
        () => undefined,
        () => undefined,
      );
      return task;
    },
  };
}
