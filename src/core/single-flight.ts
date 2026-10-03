export class SingleFlight<T> {
  private readonly pending = new Map<string, Promise<T>>();

  run(key: string, operation: () => Promise<T>): Promise<T> {
    const current = this.pending.get(key);
    if (current) return current;

    let pending: Promise<T>;
    pending = Promise.resolve()
      .then(operation)
      .finally(() => {
        if (this.pending.get(key) === pending) this.pending.delete(key);
      });
    this.pending.set(key, pending);
    return pending;
  }
}
