export class SingleFlight<T> {
  private readonly pending = new Map<string, Promise<T>>();

  async run(key: string, operation: () => Promise<T>): Promise<T> {
    const current = this.pending.get(key);
    if (current) return current;

    const pending = operation();
    this.pending.set(key, pending);
    try {
      return await pending;
    } finally {
      if (this.pending.get(key) === pending) this.pending.delete(key);
    }
  }
}
