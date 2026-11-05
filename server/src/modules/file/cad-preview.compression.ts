import { constants, createBrotliCompress, createGzip, createZstdCompress } from "node:zlib";
import type { Transform } from "node:stream";

export type CadContentEncoding = "zstd" | "br" | "gzip" | null;
export type CadPrecompressedEncoding = "br";

const priority = { zstd: 3, br: 2, gzip: 1 } as const;
const LARGE_PAYLOAD = 16 * 1024 ** 2;
export const CAD_PRECOMPRESSED_ENCODING: CadPrecompressedEncoding = "br";
const PRECOMPRESSED_BROTLI_QUALITY = 7;
const PRECOMPRESSED_BROTLI_FAST_QUALITY = 1;

function acceptedWeights(header: string | undefined): Map<string, number> {
  const accepted = new Map<string, number>();
  for (const item of (header ?? "").split(",")) {
    const [namePart, ...params] = item.trim().toLowerCase().split(";");
    const name = namePart?.trim();
    if (name !== "zstd" && name !== "br" && name !== "gzip" && name !== "*") continue;
    let q = 1;
    for (const param of params) {
      const [key, value] = param.trim().split("=");
      if (key !== "q") continue;
      const parsed = Number.parseFloat(value ?? "");
      if (Number.isFinite(parsed)) q = Math.max(0, Math.min(1, parsed));
    }
    accepted.set(name, q);
  }
  return accepted;
}

export function cadEncodingAccepted(header: string | undefined, encoding: Exclude<CadContentEncoding, null>): boolean {
  const accepted = acceptedWeights(header);
  return (accepted.get(encoding) ?? accepted.get("*") ?? 0) > 0;
}

/** Honor Accept-Encoding weights, then prefer the fastest encoding on a tie. */
export function preferredCadEncoding(header: string | undefined): CadContentEncoding {
  const accepted = acceptedWeights(header);
  const wildcard = accepted.get("*") ?? 0;
  const candidates = (["zstd", "br", "gzip"] as const)
    .map((name) => ({ name, q: accepted.get(name) ?? wildcard }))
    .filter(({ q }) => q > 0)
    .sort((a, b) => b.q - a.q || priority[b.name] - priority[a.name]);
  return candidates[0]?.name ?? null;
}

/** Large CAD payloads prioritize CPU latency; Brotli keeps a stronger fallback for older browsers. */
export function cadContentEncoder(encoding: Exclude<CadContentEncoding, null>, inputBytes = 0): Transform {
  if (encoding === "zstd") {
    return createZstdCompress({ params: { [constants.ZSTD_c_compressionLevel]: 1 } });
  }
  if (encoding === "br") {
    return createBrotliCompress({ params: {
      [constants.BROTLI_PARAM_QUALITY]: inputBytes >= LARGE_PAYLOAD ? 1 : 5,
    } });
  }
  return createGzip({ level: 1 });
}

/** Background archival compression runs once, so it can spend more CPU to save transport bytes. */
export function cadArchiveEncoder(inputBytes = 0): Transform {
  const quality = inputBytes >= LARGE_PAYLOAD ? PRECOMPRESSED_BROTLI_FAST_QUALITY : PRECOMPRESSED_BROTLI_QUALITY;
  return createBrotliCompress({ params: { [constants.BROTLI_PARAM_QUALITY]: quality } });
}

export function cadPrecompressedObjectKey(objectKey: string): string {
  return objectKey + "." + CAD_PRECOMPRESSED_ENCODING;
}
