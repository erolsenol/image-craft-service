import { describe, expect, it } from "vitest";
import {
  operationSchema,
  operationsSchema,
} from "../../src/api/schemas/operations.js";

describe("operation validation", () => {
  it.each([
    { op: "resize", width: 32, strategy: "attention" },
    { op: "resize", width: 32, fx: 0.25, fy: 0.75 },
    { op: "crop", width: 10, height: 10, fx: 0.5, fy: 0.5 },
    { op: "padding", top: 2, background: "#ffffff" },
    { op: "flip" },
    { op: "flop" },
    { op: "tint", color: "#12ab34" },
    { op: "adjust", brightness: 1.2, contrast: 0.2, saturation: 0.8 },
    { op: "watermark", image: "aGVsbG8", position: "southeast", opacity: 0.5 },
    { op: "roundedCorners", radius: 12 },
    { op: "format", format: "auto" },
  ])("accepts %o", (operation) => {
    expect(operationSchema.safeParse(operation).success).toBe(true);
  });

  it("rejects unknown operation names and unknown fields", () => {
    expect(operationSchema.safeParse({ op: "unknown" }).success).toBe(false);
    expect(
      operationSchema.safeParse({ op: "flip", direction: "diagonal" }).success,
    ).toBe(false);
  });

  it("requires focal points in pairs and bounds operation chains", () => {
    expect(
      operationSchema.safeParse({ op: "resize", width: 4, fx: 0.2 }).success,
    ).toBe(false);
    expect(
      operationsSchema.safeParse(
        Array.from({ length: 51 }, () => ({ op: "flip" })),
      ).success,
    ).toBe(false);
  });
});
