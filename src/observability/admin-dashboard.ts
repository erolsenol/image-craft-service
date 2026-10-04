export interface DashboardImageRequest {
  readonly source: string;
  readonly count: number;
}

/** Bounded, process-local counters; query strings may contain secrets and are omitted. */
export class AdminDashboardStats {
  private readonly imageRequests = new Map<string, number>();

  recordImageRequest(source: string): void {
    let displaySource: string;
    try {
      const url = new URL(source);
      url.username = "";
      url.password = "";
      url.search = "";
      url.hash = "";
      displaySource = url.toString();
    } catch {
      displaySource = source.split(/[?#]/u, 1)[0] ?? "unknown";
    }
    displaySource = displaySource.slice(0, 512);
    const count = this.imageRequests.get(displaySource) ?? 0;
    this.imageRequests.delete(displaySource);
    this.imageRequests.set(displaySource, count + 1);
    while (this.imageRequests.size > 200) {
      const oldest = this.imageRequests.keys().next().value as
        string | undefined;
      if (oldest === undefined) break;
      this.imageRequests.delete(oldest);
    }
  }

  topImages(limit = 10): DashboardImageRequest[] {
    return [...this.imageRequests]
      .map(([source, count]) => ({ source, count }))
      .sort((left, right) => right.count - left.count)
      .slice(0, limit);
  }
}
