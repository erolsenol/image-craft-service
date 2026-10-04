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

    const requests = Array.from({ length: 50 }, () =>
      flight.run("same", operation),
    );
    await Promise.resolve();
    expect(calls).toBe(1);
    release(42);
    await expect(Promise.all(requests)).resolves.toEqual(
      Array.from({ length: 50 }, () => 42),
    );
    await expect(flight.run("same", async () => 7)).resolves.toBe(7);
  });

  it("clears a rejected operation so later callers can retry", async () => {
    const flight = new SingleFlight<string>();
    const error = new Error("temporary failure");
    let calls = 0;
    const failedOperation = () => {
      calls += 1;
      return Promise.reject(error);
    };

    const first = flight.run("same", failedOperation);
    const second = flight.run("same", failedOperation);
    await expect(Promise.all([first, second])).rejects.toBe(error);
    expect(calls).toBe(1);

    await expect(
      flight.run("same", async () => {
        calls += 1;
        return "recovered";
      }),
    ).resolves.toBe("recovered");
    expect(calls).toBe(2);
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
