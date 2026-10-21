import { SvgPolicyError } from "./svg-policy.mjs";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function reject(message) {
  throw new SvgPolicyError("PNG_INVALID", message);
}

export function inspectPng(input, expected, limits) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (bytes.byteLength > limits.maxOutputBytes) reject("PNG 产物超过安全上限，已拒绝");
  if (bytes.byteLength < 57 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) reject("PNG 魔数错误，已拒绝");
  if (bytes.readUInt32BE(8) !== 13 || bytes.toString("ascii", 12, 16) !== "IHDR") reject("PNG IHDR 缺失，已拒绝");
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  const bitDepth = bytes[24];
  const colorType = bytes[25];
  const compression = bytes[26];
  const filter = bytes[27];
  const interlace = bytes[28];
  if (bitDepth !== 8 || colorType !== 6 || compression !== 0 || filter !== 0 || interlace !== 0) {
    reject("PNG 编码格式不在允许矩阵内，已拒绝");
  }
  if (width === 0 || height === 0 || width > limits.maxLongEdge || height > limits.maxLongEdge) reject("PNG 尺寸超过安全上限，已拒绝");
  if (width * height > limits.maxPixels) reject("PNG 像素数超过安全上限，已拒绝");
  if (Math.abs(width - expected.outputWidth) > 1 || Math.abs(height - expected.outputHeight) > 1) {
    reject("PNG 尺寸与受控渲染尺寸不一致，已拒绝");
  }
  if (bytes.readUInt32BE(bytes.byteLength - 12) !== 0 || bytes.toString("ascii", bytes.byteLength - 8, bytes.byteLength - 4) !== "IEND") {
    reject("PNG IEND 缺失，已拒绝");
  }
  return { width, height, bytes: bytes.byteLength };
}