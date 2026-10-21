import { createHash } from "node:crypto";

/**
 * H1 · S4：主栈对 SVG 栅格化结果的独立完整性校验。
 *
 * 转换器自身也会校验 PNG，但 worker 不能把转换器当成唯一安全边界：这里只认
 * 服务端固定上限内的 PNG 头，且源对象内容必须与版本行记录的 SHA-256 一致。
 */

export const SVG_PREVIEW_MAX_SOURCE_BYTES = 20 * 1024 * 1024;
export const SVG_PREVIEW_MAX_OUTPUT_BYTES = 20 * 1024 * 1024;
export const SVG_PREVIEW_MAX_LONG_EDGE = 4096;
export const SVG_PREVIEW_MAX_PIXELS = 16_777_216;

const PNG_SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MIN_PNG_BYTES = 45;

export interface PreviewPngInfo {
  width: number;
  height: number;
}

export type PreviewPngCheck =
  | { ok: true; info: PreviewPngInfo }
  | { ok: false; reason: string };

/** 源对象完整哈希（十六进制小写）：与 `file_versions.content_hash` 直接比对。 */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * PNG 产物最小可信形状：签名 + 首个 IHDR + 8-bit RGBA + 非隔行 + IEND。
 * 不在这里做完整解码；resvg 是唯一生成方，worker 只负责拒绝越界或伪装产物。
 */
export function inspectPreviewPng(bytes: Uint8Array): PreviewPngCheck {
  if (bytes.byteLength > SVG_PREVIEW_MAX_OUTPUT_BYTES) {
    return { ok: false, reason: "PNG 产物超过 20 MiB 安全上限，已拒绝" };
  }
  if (bytes.byteLength < MIN_PNG_BYTES) {
    return { ok: false, reason: "PNG 产物过短，已拒绝" };
  }
  for (let index = 0; index < PNG_SIGNATURE.byteLength; index += 1) {
    if (bytes[index] !== PNG_SIGNATURE[index]) {
      return { ok: false, reason: "PNG 魔数错误，已拒绝" };
    }
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(8) !== 13 || asciiAt(bytes, 12, 4) !== "IHDR") {
    return { ok: false, reason: "PNG IHDR 缺失，已拒绝" };
  }

  const width = view.getUint32(16);
  const height = view.getUint32(20);
  const bitDepth = bytes[24];
  const colorType = bytes[25];
  const compression = bytes[26];
  const filter = bytes[27];
  const interlace = bytes[28];
  if (bitDepth !== 8 || colorType !== 6 || compression !== 0 || filter !== 0 || interlace !== 0) {
    return { ok: false, reason: "PNG 编码格式不在允许矩阵内，已拒绝" };
  }
  if (width === 0 || height === 0 || width > SVG_PREVIEW_MAX_LONG_EDGE || height > SVG_PREVIEW_MAX_LONG_EDGE) {
    return { ok: false, reason: "PNG 尺寸超过 4096 px 安全上限，已拒绝" };
  }
  if (width * height > SVG_PREVIEW_MAX_PIXELS) {
    return { ok: false, reason: "PNG 像素数超过 16,777,216 安全上限，已拒绝" };
  }

  const iendOffset = bytes.byteLength - 12;
  if (view.getUint32(iendOffset) !== 0 || asciiAt(bytes, iendOffset + 4, 4) !== "IEND") {
    return { ok: false, reason: "PNG IEND 缺失，已拒绝" };
  }
  return { ok: true, info: { width, height } };
}

function asciiAt(bytes: Uint8Array, offset: number, length: number): string {
  let value = "";
  for (let index = 0; index < length; index += 1) {
    value += String.fromCharCode(bytes[offset + index] ?? 0);
  }
  return value;
}
