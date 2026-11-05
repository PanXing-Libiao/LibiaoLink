import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { buffer as collect } from "node:stream/consumers";
import { checkedCadStream } from "../src/modules/file/cad-archive.integrity.js";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("CAD resource stream idle deadline", () => {
  it("allows a large upload to keep running while bytes continue arriving", async () => {
    const chunks = Array.from({ length: 4 }, (_, index) => Buffer.from(String(index).repeat(16)));
    const body = Buffer.concat(chunks);
    const source = Readable.from((async function* () {
      for (const chunk of chunks) {
        yield chunk;
        await delay(20);
      }
    })());
    const checked = checkedCadStream(source, body.byteLength,
      createHash("sha256").update(body).digest("hex"), undefined, 40);

    await expect(collect(checked)).resolves.toEqual(body);
  });

  it("aborts a resource that stops delivering bytes", async () => {
    const source = new Readable({ read() {} });
    const body = Buffer.from("partial");
    const checked = checkedCadStream(source, body.byteLength,
      createHash("sha256").update(body).digest("hex"), undefined, 30);
    const result = collect(checked);
    source.push(body.subarray(0, 3));

    await expect(result).rejects.toThrow(/stalled/);
  });
});
