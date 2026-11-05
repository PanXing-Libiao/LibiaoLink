/**
 * SHA-256（小写十六进制）—— 文件分片直传的 contentHash 口径（契约 shared/src/modules/files.ts「Sha256」）。
 *
 * 两条路径、同一输出：
 * - 快路径：WebCrypto（crypto.subtle.digest）—— 仅安全源可用（https / localhost）；
 * - 回退：纯 JS —— 内网以 http 明文访问（如 10.1.7.169）属非安全源，crypto.subtle 为 undefined，
 *   不兜底会在取 contentHash 处抛错、上传表现为「点了没反应」（Push 258 续二 · 业务现场定位）。
 *
 * 大文件上传的整文件哈希由 sha256Blob / sha256.worker 在 Worker 内分块读取并增量计算：
 * 浏览器主线程只接收进度与最终摘要，不持有整份文件，也不在非安全源上被纯 JS 长任务冻结。
 *
 * 正确性：与 node:crypto 对拍过（空串 / abc / 55·56·64·65 字节边界 / 1MiB 随机，逐字节一致）。
 */

/** SHA-256 轮常量（FIPS 180-4）。 */
const ROUND_CONSTANTS = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const INITIAL_STATE = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);
const BLOCK_BYTES = 64;

/** 循环右移（32 位；符号位由调用处的 >>> 0 与位运算语义收口）。 */
function rotateRight(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits));
}

/** 压缩一个 64 字节块到状态。 */
function compress(state: Uint32Array, view: DataView, offset: number, words: Uint32Array): void {
  for (let index = 0; index < 16; index += 1) {
    words[index] = view.getUint32(offset + index * 4, false);
  }
  for (let index = 16; index < 64; index += 1) {
    const previous = words[index - 15]!;
    const recent = words[index - 2]!;
    const s0 = rotateRight(previous, 7) ^ rotateRight(previous, 18) ^ (previous >>> 3);
    const s1 = rotateRight(recent, 17) ^ rotateRight(recent, 19) ^ (recent >>> 10);
    words[index] = (words[index - 16]! + s0 + words[index - 7]! + s1) >>> 0;
  }
  let a = state[0]!;
  let b = state[1]!;
  let c = state[2]!;
  let d = state[3]!;
  let e = state[4]!;
  let f = state[5]!;
  let g = state[6]!;
  let h = state[7]!;
  for (let index = 0; index < 64; index += 1) {
    const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
    const choice = (e & f) ^ (~e & g);
    const temp1 = (h + sum1 + choice + ROUND_CONSTANTS[index]! + words[index]!) >>> 0;
    const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
    const majority = (a & b) ^ (a & c) ^ (b & c);
    const temp2 = (sum0 + majority) >>> 0;
    h = g;
    g = f;
    f = e;
    e = (d + temp1) >>> 0;
    d = c;
    c = b;
    b = a;
    a = (temp1 + temp2) >>> 0;
  }
  state[0] = (state[0]! + a) >>> 0;
  state[1] = (state[1]! + b) >>> 0;
  state[2] = (state[2]! + c) >>> 0;
  state[3] = (state[3]! + d) >>> 0;
  state[4] = (state[4]! + e) >>> 0;
  state[5] = (state[5]! + f) >>> 0;
  state[6] = (state[6]! + g) >>> 0;
  state[7] = (state[7]! + h) >>> 0;
}

/** 可分块更新的 SHA-256 累加器；读取大文件时不复制整份输入。 */
export class Sha256 {
  private readonly state = new Uint32Array(INITIAL_STATE);
  private readonly block = new Uint8Array(BLOCK_BYTES);
  private readonly blockView = new DataView(this.block.buffer);
  private readonly words = new Uint32Array(64);
  private blockLength = 0;
  private totalBytes = 0;
  private finished = false;

  update(bytes: Uint8Array): void {
    if (this.finished) throw new Error("SHA-256 已完成，不能再更新");
    if (bytes.byteLength === 0) return;
    this.totalBytes += bytes.byteLength;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let offset = 0;
    if (this.blockLength > 0) {
      const take = Math.min(BLOCK_BYTES - this.blockLength, bytes.byteLength);
      this.block.set(bytes.subarray(0, take), this.blockLength);
      this.blockLength += take;
      offset += take;
      if (this.blockLength === BLOCK_BYTES) {
        compress(this.state, this.blockView, 0, this.words);
        this.blockLength = 0;
      }
    }
    while (offset + BLOCK_BYTES <= bytes.byteLength) {
      compress(this.state, view, offset, this.words);
      offset += BLOCK_BYTES;
    }
    if (offset < bytes.byteLength) {
      this.block.set(bytes.subarray(offset), 0);
      this.blockLength = bytes.byteLength - offset;
    }
  }

  digest(): Uint8Array {
    if (this.finished) throw new Error("SHA-256 只能取一次摘要");
    this.finished = true;
    const finalLength = this.blockLength < 56 ? 64 : 128;
    const final = new Uint8Array(finalLength);
    final.set(this.block.subarray(0, this.blockLength));
    final[this.blockLength] = 0x80;
    const view = new DataView(final.buffer);
    view.setUint32(finalLength - 8, Math.floor(this.totalBytes / 0x20000000), false);
    view.setUint32(finalLength - 4, (this.totalBytes * 8) >>> 0, false);
    for (let offset = 0; offset < finalLength; offset += BLOCK_BYTES) {
      compress(this.state, view, offset, this.words);
    }
    const digest = new Uint8Array(32);
    const digestView = new DataView(digest.buffer);
    for (let index = 0; index < 8; index += 1) {
      digestView.setUint32(index * 4, this.state[index]!, false);
    }
    return digest;
  }
}

/** 整段字节的 SHA-256 摘要（32 字节；纯 JS 实现）。 */
export function sha256Digest(bytes: Uint8Array): Uint8Array {
  const hash = new Sha256();
  hash.update(bytes);
  return hash.digest();
}

/** 字节 → 小写十六进制。 */
export function toHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

/** 纯 JS SHA-256（小写十六进制）—— 非安全源回退路径。 */
export function sha256HexPure(bytes: Uint8Array): string {
  return toHex(sha256Digest(bytes));
}

/** 整段字节的 SHA-256（小写十六进制）：WebCrypto 可用走快路径，非安全源回退纯 JS（输出一致）。 */
export async function sha256Hex(buffer: ArrayBuffer): Promise<string> {
  const subtle = (globalThis.crypto as Crypto & { subtle?: SubtleCrypto }).subtle;
  if (subtle === undefined) {
    return sha256HexPure(new Uint8Array(buffer));
  }
  return toHex(new Uint8Array(await subtle.digest("SHA-256", buffer)));
}
