import { createHash } from "node:crypto";
import { Readable, Transform } from "node:stream";

export const CAD_MANIFEST_LIMIT = 64 * 1024 * 1024;
export const CAD_BUFFER_LIMIT = 256 * 1024 * 1024;
export const CAD_ARTIFACT_LIMIT = 512 * 1024 * 1024;
class CadIntegrityError extends Error {}

/** Validate while streaming. A corrupt object is never marked completed or accepted by the viewer. */
export function checkedCadStream(source: Readable, expectedBytes: number, sha256: string, failed?: () => void): Readable {
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0 || expectedBytes > CAD_BUFFER_LIMIT) {
    source.destroy(); throw new Error("CAD resource size exceeds budget");
  }
  let count = 0;
  const hash = createHash("sha256");
  const checked = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      count += chunk.byteLength;
      if (count > expectedBytes) { done(new CadIntegrityError("CAD resource exceeds declared size")); return; }
      hash.update(chunk); done(null, chunk);
    },
    flush(done) {
      done(count === expectedBytes && hash.digest("hex") === sha256 ? null : new CadIntegrityError("CAD resource integrity mismatch"));
    },
  });
  const timer = setTimeout(() => checked.destroy(new Error("CAD resource deadline exceeded")), 90_000);
  timer.unref();
  checked.once("error", (error) => { if (error instanceof CadIntegrityError) failed?.(); });
  checked.once("close", () => { clearTimeout(timer); source.destroy(); });
  source.once("error", (error) => checked.destroy(error));
  return source.pipe(checked);
}

export async function readCadManifest(source: Readable, declaredBytes: number): Promise<Buffer> {
  if (declaredBytes <= 0 || declaredBytes > CAD_MANIFEST_LIMIT) { source.destroy(); throw new Error("CAD manifest exceeds budget"); }
  const chunks: Buffer[] = []; let count = 0;
  try {
    for await (const chunk of source) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      count += bytes.byteLength;
      if (count > declaredBytes) throw new Error("CAD manifest exceeds declared size");
      chunks.push(bytes);
    }
    if (count !== declaredBytes) throw new Error("CAD manifest incomplete");
    return Buffer.concat(chunks);
  } finally { source.destroy(); }
}
