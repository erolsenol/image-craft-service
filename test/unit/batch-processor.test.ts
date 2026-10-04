import { describe, expect, it } from "vitest";
import { arrayBuffer } from "node:stream/consumers";
import { Readable } from "node:stream";
import { createZip, createZipStream } from "../../src/jobs/batch-processor.js";

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

describe("createZipStream", () => {
  it("opens one result stream at a time", async () => {
    let active = 0;
    let peak = 0;
    const files = Array.from({ length: 100 }, (_, index) => ({
      name: `image-${index + 1}.jpg`,
      async open() {
        active += 1;
        peak = Math.max(peak, active);
        const stream = Readable.from(Buffer.from(`image-${index + 1}`));
        stream.once("end", () => {
          active -= 1;
        });
        return stream;
      },
    }));
    const archive = createZipStream(files, [], 1024 * 1024);
    const contents = Buffer.from(await arrayBuffer(archive));
    expect(peak).toBe(1);
    expect(contents.includes(Buffer.from("image-100.jpg"))).toBe(true);
    expect(contents.includes(Buffer.from("errors.json"))).toBe(true);
  });
});
