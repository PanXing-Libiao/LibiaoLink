import { Readable } from "node:stream";
import { buffer as collect } from "node:stream/consumers";
import { brotliDecompressSync, gunzipSync, zstdDecompressSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { CAD_PRECOMPRESSED_ENCODING, cadArchiveEncoder, cadContentEncoder, cadEncodingAccepted, cadPrecompressedObjectKey, preferredCadEncoding } from "../src/modules/file/cad-preview.compression.js";

describe("CAD preview transport encoding", () => {
  it("prefers the fastest accepted encoding when browser weights tie", () => {
    expect(preferredCadEncoding("gzip, deflate, br, zstd")).toBe("zstd");
    expect(preferredCadEncoding("gzip, deflate, br")).toBe("br");
  });
  it("keeps gzip compatibility and respects disabled or weighted encodings", () => {
    expect(preferredCadEncoding("gzip")).toBe("gzip");
    expect(preferredCadEncoding("zstd;q=0, br;q=0, gzip;q=0.5")).toBe("gzip");
    expect(preferredCadEncoding("zstd;q=0.2, br;q=0.8")).toBe("br");
    expect(preferredCadEncoding("identity")).toBeNull();
    expect(preferredCadEncoding("*;q=1, zstd;q=0")).toBe("br");
  });
  it("uses precompressed Brotli only when accepted without changing the live speed preference", () => {
    expect(CAD_PRECOMPRESSED_ENCODING).toBe("br");
    expect(cadEncodingAccepted("zstd, br, gzip", CAD_PRECOMPRESSED_ENCODING)).toBe(true);
    expect(cadEncodingAccepted("br;q=0, zstd, gzip", CAD_PRECOMPRESSED_ENCODING)).toBe(false);
    expect(cadEncodingAccepted("*;q=0.5, br;q=0", CAD_PRECOMPRESSED_ENCODING)).toBe(false);
    expect(preferredCadEncoding("zstd, br, gzip")).toBe("zstd");
    expect(cadPrecompressedObjectKey("prefix/manifest.json")).toBe("prefix/manifest.json.br");
  });
  it("round-trips geometry bytes through every selected encoder", async () => {
    const input = Buffer.from("cad-geometry-transport-fixture".repeat(128));
    const zstd = await collect(Readable.from([input]).pipe(cadContentEncoder("zstd")));
    const br = await collect(Readable.from([input]).pipe(cadContentEncoder("br", input.byteLength)));
    const gzip = await collect(Readable.from([input]).pipe(cadContentEncoder("gzip")));
    expect(zstdDecompressSync(zstd)).toEqual(input);
    expect(brotliDecompressSync(br)).toEqual(input);
    expect(gunzipSync(gzip)).toEqual(input);
  });
  it("round-trips the background archival encoder", async () => {
    const input = Buffer.from("cad-archive-payload".repeat(512));
    const compressed = await collect(Readable.from([input]).pipe(cadArchiveEncoder(input.byteLength)));
    expect(compressed.byteLength).toBeLessThan(input.byteLength);
    expect(brotliDecompressSync(compressed)).toEqual(input);
  });
});
