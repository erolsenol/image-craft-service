import sharp from "sharp";

const baseUrl = process.argv[2] ?? "http://127.0.0.1:3000";
const requestCount = Number(process.argv[3] ?? 40);
const concurrency = 4;

if (
  !Number.isSafeInteger(requestCount) ||
  requestCount < 1 ||
  requestCount > 100
)
  throw new Error("Request count must be an integer between 1 and 100");

const fixture = await sharp({
  create: { width: 128, height: 96, channels: 3, background: "#3478c8" },
})
  .png()
  .toBuffer();

let nextIndex = 0;
let completed = 0;
let failed = 0;
const startedAt = performance.now();
await Promise.all(
  Array.from({ length: concurrency }, async () => {
    while (nextIndex < requestCount) {
      const index = nextIndex;
      nextIndex += 1;
      const form = new FormData();
      form.set(
        "file",
        new Blob([fixture], { type: "image/png" }),
        "fixture.png",
      );
      form.set(
        "ops",
        '[{"op":"resize","width":64,"height":48},{"op":"format","format":"webp"}]',
      );
      try {
        const response = await fetch(`${baseUrl}/v1/transform`, {
          method: "POST",
          body: form,
        });
        if (!response.ok) {
          failed += 1;
          console.error(
            `transform ${index + 1} failed with ${response.status}`,
          );
        } else {
          await response.arrayBuffer();
          completed += 1;
        }
      } catch (error) {
        failed += 1;
        console.error(`transform ${index + 1} failed: ${String(error)}`);
      }
    }
  }),
);
const elapsedSeconds = (performance.now() - startedAt) / 1000;
const metrics = await fetch(`${baseUrl}/metrics`).then((response) =>
  response.text(),
);
const samples = metrics
  .split("\n")
  .filter((line) =>
    /image_craft_(http_requests_total|http_request_duration_seconds_count|transform_operation_duration_seconds_count)/u.test(
      line,
    ),
  );

console.log(
  JSON.stringify(
    {
      requested: requestCount,
      completed,
      failed,
      elapsedSeconds: Number(elapsedSeconds.toFixed(2)),
      samples,
    },
    null,
    2,
  ),
);
if (failed > 0) process.exitCode = 1;
