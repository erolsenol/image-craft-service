import { describe, expect, it } from "vitest";
import { createZip } from "../../src/jobs/batch-processor.js";

describe("createZip", () => {
  it("creates a ZIP archive containing the supplied files", async () => {
    const archive = await createZip([
      { name: "image-001.jpg", buffer: Buffer.from("first image") },
      { name: "image-002.png", buffer: Buffer.from("second image") },
    ]);
    expect(archive.subarray(0, 4)).toEqual(
      Buffer.from([0x50, 0x4b, 0x03, 0x04]),
    );
    expect(archive.includes(Buffer.from("image-001.jpg"))).toBe(true);
    expect(archive.includes(Buffer.from("image-002.png"))).toBe(true);
  });

  it("rejects archives that exceed the configured byte limit", async () => {
    await expect(
      createZip([{ name: "large.bin", buffer: Buffer.alloc(100) }], 20),
    ).rejects.toThrow("Batch archive exceeds configured size limit");
  });
});
