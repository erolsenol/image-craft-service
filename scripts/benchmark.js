import http from "k6/http";
import { check } from "k6";

const target = __ENV.TARGET ?? "image-craft";
const format = __ENV.FORMAT ?? "resize";
const source = __ENV.SOURCE_URL;
const baseUrls = {
  "image-craft": __ENV.IMAGE_CRAFT_URL,
  imgproxy: __ENV.IMGPROXY_URL,
  thumbor: __ENV.THUMBOR_URL,
};
const base = baseUrls[target]?.replace(/\/$/u, "");

if (!source || !base) {
  throw new Error("Set SOURCE_URL and the selected target base URL");
}

function requestUrl() {
  const separator = source.includes("?") ? "&" : "?";
  const benchmarkSource = `${source}${separator}_bench=${__VU}-${__ITER}`;
  if (target === "image-craft") {
    const operations = format === "resize" ? "w_800" : `w_800,f_${format}`;
    const pathSource = benchmarkSource.replace("?", "%3F");
    return `${base}/v1/img/${operations}/${pathSource}`;
  }
  if (target === "imgproxy") {
    const operations = ["rs:fit:800:0"];
    if (format !== "resize") operations.push(`format:${format}`);
    return `${base}/insecure/${operations.join("/")}/plain/${encodeURIComponent(benchmarkSource)}`;
  }
  const filters = format === "resize" ? "" : `/filters:format(${format})`;
  return `${base}/unsafe/800x0${filters}/${encodeURIComponent(benchmarkSource)}`;
}

export const options = {
  vus: Number(__ENV.VUS ?? 1),
  duration: __ENV.DURATION ?? "30s",
  discardResponseBodies: true,
  tags: { target, format },
  thresholds: {
    checks: ["rate==1"],
    http_req_failed: ["rate<0.01"],
  },
};

export default function () {
  const response = http.get(requestUrl(), {
    tags: { name: `${target}-${format}` },
  });
  check(response, {
    "response status is 200": (result) => result.status === 200,
    "response is image content": (result) =>
      result.headers["Content-Type"]?.startsWith("image/") ?? false,
  });
}
