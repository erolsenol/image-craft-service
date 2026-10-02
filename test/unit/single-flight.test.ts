import { describe, expect, it } from "vitest";
import { SingleFlight } from "../../src/core/single-flight.js";

describe("SingleFlight", () => {
  it("runs one operation for concurrent callers with the same key", async () => {
    const flight = new SingleFlight<number>();
    let calls = 0;
    let release!: (value: number) => void;
    const operation = () => {
      calls += 1;
      return new Promise<number>((resolve) => {
        release = resolve;
      });
    };

    const first = flight.run("same", operation);
    const second = flight.run("same", operation);
    expect(calls).toBe(1);
    release(42);
    await expect(Promise.all([first, second])).resolves.toEqual([42, 42]);
    await expect(flight.run("same", async () => 7)).resolves.toBe(7);
  });

  it("does not coalesce different keys", async () => {
    const flight = new SingleFlight<string>();
    const [first, second] = await Promise.all([
      flight.run("one", async () => "a"),
      flight.run("two", async () => "b"),
    ]);
    expect([first, second]).toEqual(["a", "b"]);
  });
});
