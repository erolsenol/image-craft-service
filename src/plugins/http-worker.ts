import { AppError } from "../core/errors.js";

export interface HttpWorkerOptions {
  readonly workerUrl: string;
  readonly timeoutMs: number;
  readonly maxBytes: number;
}

export async function postWorker(
  options: HttpWorkerOptions,
  path: string,
  body: BodyInit,
  headers: HeadersInit,
  signal: AbortSignal,
): Promise<Response> {
  const base = options.workerUrl.replace(/\/+$/u, "");
  try {
    const health = await fetch(`${base}/health`, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(options.timeoutMs)]),
    });
    await health.body?.cancel();
    if (!health.ok) throw new Error("Worker health check failed");
    const response = await fetch(`${base}${path}`, {
      method: "POST",
      body,
      headers,
      signal: AbortSignal.any([signal, AbortSignal.timeout(options.timeoutMs)]),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error("Worker request failed");
    }
    return response;
  } catch {
    throw new AppError("AI worker is unavailable", 503);
  }
}

export async function readWorkerBytes(
  response: Response,
  maxBytes: number,
): Promise<Buffer> {
  if (!response.body)
    throw new AppError("AI worker returned an empty response", 503);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) {
        await reader.cancel();
        throw new AppError("AI worker response exceeds size limit", 413);
      }
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("AI worker response was interrupted", 503);
  }
  return Buffer.concat(chunks, length);
}

export async function postJsonWorker(
  options: HttpWorkerOptions,
  path: string,
  image: Buffer,
  signal: AbortSignal,
  pluginOptions: Record<string, unknown> = {},
): Promise<unknown> {
  const body = JSON.stringify({
    image: image.toString("base64"),
    options: pluginOptions,
  });
  const response = await postWorker(
    options,
    path,
    body,
    { "content-type": "application/json" },
    signal,
  );
  const bytes = await readWorkerBytes(response, options.maxBytes);
  try {
    return JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    throw new AppError("AI worker returned invalid JSON", 503);
  }
}
