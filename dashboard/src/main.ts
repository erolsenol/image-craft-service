interface DashboardPayload {
  updatedAt: string;
  cache: {
    entries: number;
    sizeBytes: number;
    maxSizeBytes: number;
    hits: number;
    misses: number;
    hitRatio: number;
  };
  requests: {
    total: number;
    errors: number;
    errorRate: number;
    byStatus: Array<{
      method?: string;
      route?: string;
      status?: string;
      count?: number;
    }>;
  };
  topImages: Array<{ source: string; count: number }>;
  queue: {
    enabled: boolean;
    available: boolean;
    depth: Record<string, number>;
  };
  tenants: Array<{
    id: string;
    requestsPerDay: number;
    bytesPerDay: number;
    usage: { requests: number; bytes: number };
  }>;
}

const form = document.querySelector<HTMLFormElement>("#auth-form")!;
const keyInput = document.querySelector<HTMLInputElement>("#api-key")!;
const message = document.querySelector<HTMLElement>("#message")!;
const updated = document.querySelector<HTMLElement>("#updated")!;
const disconnectButton =
  document.querySelector<HTMLButtonElement>("#disconnect")!;
let apiKey: string | undefined;
let timer: number | undefined;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let size = bytes / 1024;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(1)} ${units[unit]}`;
}

function renderTable(
  target: string,
  headers: string[],
  rows: string[][],
): void {
  const container = document.querySelector<HTMLElement>(target)!;
  if (rows.length === 0) {
    container.textContent = "No data yet.";
    container.className = "muted";
    return;
  }
  const table = document.createElement("table");
  const head = table.createTHead().insertRow();
  for (const label of headers) {
    const cell = document.createElement("th");
    cell.scope = "col";
    cell.textContent = label;
    head.append(cell);
  }
  const body = table.createTBody();
  for (const row of rows) {
    const tr = body.insertRow();
    for (const value of row) {
      const cell = tr.insertCell();
      cell.textContent = value;
    }
  }
  container.replaceChildren(table);
}

function card(label: string, value: string): HTMLElement {
  const element = document.createElement("div");
  element.className = "card";
  const title = document.createElement("span");
  title.textContent = label;
  const amount = document.createElement("strong");
  amount.textContent = value;
  element.append(title, amount);
  return element;
}

async function refresh(): Promise<void> {
  if (!apiKey) return;
  try {
    const response = await fetch("/v1/admin/dashboard/data", {
      headers: { "X-API-Key": apiKey },
      cache: "no-store",
    });
    if (!response.ok)
      throw new Error(
        response.status === 401 || response.status === 403
          ? "Key is invalid or lacks the admin scope."
          : `Dashboard request failed (${response.status}).`,
      );
    const data = (await response.json()) as DashboardPayload;
    document
      .querySelector("#overview")!
      .replaceChildren(
        card("Cache entries", data.cache.entries.toLocaleString()),
        card(
          "Cache size",
          `${formatBytes(data.cache.sizeBytes)} / ${formatBytes(data.cache.maxSizeBytes)}`,
        ),
        card("Cache hit ratio", `${(data.cache.hitRatio * 100).toFixed(1)}%`),
        card(
          "Requests / errors",
          `${data.requests.total.toLocaleString()} / ${data.requests.errors.toLocaleString()} (${(data.requests.errorRate * 100).toFixed(1)}%)`,
        ),
      );
    renderTable(
      "#images",
      ["Source", "Requests"],
      data.topImages.map((image) => [
        image.source,
        image.count.toLocaleString(),
      ]),
    );
    renderTable(
      "#errors",
      ["Method", "Route", "Status", "Count"],
      data.requests.byStatus.map((error) => [
        error.method ?? "",
        error.route ?? "",
        error.status ?? "",
        Number(error.count ?? 0).toLocaleString(),
      ]),
    );
    const queueState = data.queue.enabled
      ? data.queue.available
        ? "Available"
        : "Unavailable"
      : "Disabled";
    renderTable(
      "#queue",
      ["State", "Jobs"],
      [
        ["Status", queueState],
        ...Object.entries(data.queue.depth).map(([state, count]) => [
          state,
          count.toLocaleString(),
        ]),
      ],
    );
    renderTable(
      "#tenants",
      ["Tenant", "Requests", "Bytes", "Daily limits"],
      data.tenants.map((tenant) => [
        tenant.id,
        tenant.usage.requests.toLocaleString(),
        formatBytes(tenant.usage.bytes),
        `${tenant.requestsPerDay || "∞"} requests / ${tenant.bytesPerDay ? formatBytes(tenant.bytesPerDay) : "∞"}`,
      ]),
    );
    updated.textContent = `Updated ${new Date(data.updatedAt).toLocaleTimeString()}`;
    message.textContent = "Connected. Data refreshes automatically.";
  } catch (error) {
    message.textContent =
      error instanceof Error ? error.message : "Could not load dashboard data.";
    if (
      message.textContent.includes("invalid") ||
      message.textContent.includes("admin scope")
    )
      disconnect();
  }
}

function disconnect(): void {
  apiKey = undefined;
  if (timer !== undefined) window.clearInterval(timer);
  timer = undefined;
  keyInput.value = "";
  keyInput.disabled = false;
  disconnectButton.hidden = true;
  updated.textContent = "Not connected";
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  apiKey = keyInput.value;
  keyInput.disabled = true;
  disconnectButton.hidden = false;
  void refresh();
  timer = window.setInterval(() => void refresh(), 5000);
});
disconnectButton.addEventListener("click", disconnect);
