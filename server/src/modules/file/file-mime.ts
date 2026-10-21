import { extensionOf } from "../../storage/index.js";

/**
 * 文件类型裁决（H1 · S2）：客户端 MIME 只作提示，扩展名是主键，文件头是服务端的最后一道校验。
 *
 * 这里只裁决“服务端声明什么类型”，不把声明当成安全证明：
 * - 只有精确位图（扩展名 + 规范 MIME + 文件头一致）才允许原对象内联直签；
 * - SVG / HTML / XML 等主动内容即使通过上传，也永远只能走产物或下载；
 * - 未知扩展名一律保存为 application/octet-stream，读面只能下载。
 */

export const OCTET_STREAM_MIME = "application/octet-stream";
export const SVG_MIME = "image/svg+xml";

export type FileContentKind = "raster" | "svg" | "cad" | "pdf" | "office" | "text" | "html" | "opaque";

type SignatureKind =
  | "png"
  | "jpeg"
  | "gif"
  | "webp"
  | "bmp"
  | "tiff"
  | "avif"
  | "svg"
  | "html"
  | "xml"
  | "pdf"
  | "zip"
  | "ole"
  | "rtf"
  | "glb"
  | "text"
  | "binary"
  | "empty";

interface KnownType {
  /** 规范 MIME（file_versions.mime 保存的值）。 */
  mime: string;
  kind: Exclude<FileContentKind, "cad" | "opaque">;
  /** 可接受的文件头族；无文件头的文本 / CAD 使用 text / binary。 */
  signatures: readonly SignatureKind[];
}

const RASTER_TYPES: Readonly<Record<string, KnownType>> = {
  png: { mime: "image/png", kind: "raster", signatures: ["png"] },
  jpg: { mime: "image/jpeg", kind: "raster", signatures: ["jpeg"] },
  jpeg: { mime: "image/jpeg", kind: "raster", signatures: ["jpeg"] },
  gif: { mime: "image/gif", kind: "raster", signatures: ["gif"] },
  webp: { mime: "image/webp", kind: "raster", signatures: ["webp"] },
  bmp: { mime: "image/bmp", kind: "raster", signatures: ["bmp"] },
  tif: { mime: "image/tiff", kind: "raster", signatures: ["tiff"] },
  tiff: { mime: "image/tiff", kind: "raster", signatures: ["tiff"] },
  avif: { mime: "image/avif", kind: "raster", signatures: ["avif"] },
};

const NON_RASTER_TYPES: Readonly<Record<string, KnownType>> = {
  svg: { mime: SVG_MIME, kind: "svg", signatures: ["svg"] },
  pdf: { mime: "application/pdf", kind: "pdf", signatures: ["pdf"] },
  doc: { mime: "application/msword", kind: "office", signatures: ["ole"] },
  docx: {
    mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    kind: "office",
    signatures: ["zip"],
  },
  docm: { mime: "application/vnd.ms-word.document.macroenabled.12", kind: "office", signatures: ["zip"] },
  odt: { mime: "application/vnd.oasis.opendocument.text", kind: "office", signatures: ["zip"] },
  rtf: { mime: "application/rtf", kind: "office", signatures: ["rtf", "text"] },
  txt: { mime: "text/plain", kind: "text", signatures: ["text", "html", "svg", "xml", "empty"] },
  html: { mime: "text/html", kind: "html", signatures: ["html", "text", "xml", "svg", "empty"] },
  htm: { mime: "text/html", kind: "html", signatures: ["html", "text", "xml", "svg", "empty"] },
  xls: { mime: "application/vnd.ms-excel", kind: "office", signatures: ["ole"] },
  xlsx: {
    mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    kind: "office",
    signatures: ["zip"],
  },
  xlsm: { mime: "application/vnd.ms-excel.sheet.macroenabled.12", kind: "office", signatures: ["zip"] },
  ods: { mime: "application/vnd.oasis.opendocument.spreadsheet", kind: "office", signatures: ["zip"] },
  csv: { mime: "text/csv", kind: "text", signatures: ["text", "html", "svg", "xml", "empty"] },
  ppt: { mime: "application/vnd.ms-powerpoint", kind: "office", signatures: ["ole"] },
  pptx: {
    mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    kind: "office",
    signatures: ["zip"],
  },
  pptm: { mime: "application/vnd.ms-powerpoint.presentation.macroenabled.12", kind: "office", signatures: ["zip"] },
  odp: { mime: "application/vnd.oasis.opendocument.presentation", kind: "office", signatures: ["zip"] },
};

const KNOWN_TYPES: Readonly<Record<string, KnownType>> = { ...RASTER_TYPES, ...NON_RASTER_TYPES };

/** CAD 三维族：MIME 常缺省 / 不可靠，按对象键扩展名识别；原对象永远以 octet-stream 投递。 */
const CAD_SIGNATURES: Readonly<Record<string, readonly SignatureKind[]>> = {
  step: ["text", "binary"],
  stp: ["text", "binary"],
  iges: ["text", "binary"],
  igs: ["text", "binary"],
  stl: ["text", "binary"],
  "3mf": ["zip"],
  obj: ["text"],
  gltf: ["text"],
  glb: ["glb"],
};

export const CAD_EXTENSIONS: ReadonlySet<string> = new Set(Object.keys(CAD_SIGNATURES));

const MIME_ALIASES: Readonly<Record<string, string>> = {
  "image/jpg": "image/jpeg",
  "image/x-png": "image/png",
  "image/tif": "image/tiff",
};

/** 去掉 MIME 参数 / 空白并转小写；非法头值返回 null（不把客户端字符串原样写进库或响应头）。 */
export function normalizeMime(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) {
    return null;
  }
  const base = raw.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (base === "" || base.length > 200 || !/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(base)) {
    return null;
  }
  return MIME_ALIASES[base] ?? base;
}

/** 按扩展名返回规范 MIME；未知 / 无扩展名返回 null（读面据此 fail closed）。 */
export function canonicalMimeForExtension(fileName: string): string | null {
  return KNOWN_TYPES[extensionOf(fileName)]?.mime ?? null;
}

export function kindForExtension(fileName: string): FileContentKind | null {
  const extension = extensionOf(fileName);
  if (CAD_EXTENSIONS.has(extension)) {
    return "cad";
  }
  return KNOWN_TYPES[extension]?.kind ?? null;
}

/** 扩展名 + 规范化 MIME 的精确组合：仅安全位图可进入原对象内联直签分支。 */
export function isRasterImageFile(input: { fileName: string; mime: string | null }): boolean {
  const known = KNOWN_TYPES[extensionOf(input.fileName)];
  return known?.kind === "raster" && normalizeMime(input.mime) === known.mime;
}

/**
 * SVG 只允许进入 PNG 产物通道。
 *
 * `.svg` + 缺失 / SVG 声明可作为存量兼容；若声明为其它已知 MIME 则视为冲突，读面按“只能下载”处理。
 * 没有扩展名时只接受规范 SVG MIME，避免 `foo` 只靠声明绕过扩展名规则。
 */
export function isSvgFile(input: { fileName: string; mime: string | null }): boolean {
  const extension = extensionOf(input.fileName);
  const mime = normalizeMime(input.mime);
  if (extension === "svg") {
    return mime === null || mime === SVG_MIME;
  }
  return extension === "bin" && mime === SVG_MIME;
}

export interface UploadTypeValidationInput {
  fileName: string;
  mime: string | null;
  /** 只读取对象前缀，不把大文件整块读入内存。 */
  bytes: Uint8Array;
}

export type UploadTypeValidation =
  | { ok: true; mime: string; kind: FileContentKind; extension: string }
  | {
      ok: false;
      code: "mime_mismatch" | "content_mismatch";
      message: string;
      extension: string;
      declaredMime: string | null;
      expectedMime: string | null;
    };

/**
 * 上传完成时的服务端裁决：
 * 1) 已知扩展名先与声明 MIME 比对；`application/octet-stream` / 缺失视为“未声明具体类型”；
 * 2) 再用文件头比对扩展名对应的类型族；
 * 3) 未知扩展名不信任声明，统一落 octet-stream，读面无内联入口。
 */
export function validateUploadFileType(input: UploadTypeValidationInput): UploadTypeValidation {
  const extension = extensionOf(input.fileName);
  const declared = normalizeMime(input.mime);
  const signature = detectSignature(input.bytes);
  const known = KNOWN_TYPES[extension];
  const cadSignatures = CAD_SIGNATURES[extension];

  if (known !== undefined) {
    if (declared !== null && declared !== OCTET_STREAM_MIME && declared !== known.mime) {
      return failure("mime_mismatch", "文件 MIME 与扩展名不一致，已拒绝完成上传", extension, declared, known.mime);
    }
    if (!known.signatures.includes(signature)) {
      return failure("content_mismatch", "文件内容与扩展名 / MIME 不一致，已拒绝完成上传", extension, declared, known.mime);
    }
    return { ok: true, mime: known.mime, kind: known.kind, extension };
  }

  if (cadSignatures !== undefined) {
    if (declared !== null && declared !== OCTET_STREAM_MIME && !isCadMime(declared)) {
      return failure("mime_mismatch", "CAD 文件 MIME 与扩展名不一致，已拒绝完成上传", extension, declared, OCTET_STREAM_MIME);
    }
    if (!cadSignatures.includes(signature)) {
      return failure("content_mismatch", "CAD 文件内容与扩展名不一致，已拒绝完成上传", extension, declared, OCTET_STREAM_MIME);
    }
    return { ok: true, mime: OCTET_STREAM_MIME, kind: "cad", extension };
  }

  // 未知扩展名：不采用客户端声明，保存为不透明文件；下载仍保留原字节与文件名。
  return { ok: true, mime: OCTET_STREAM_MIME, kind: "opaque", extension };
}

/** 受控 preview-content 响应类型：主动内容 / 未知类型只能 attachment + octet-stream。 */
export function safePreviewContentType(mime: string | null): { contentType: string; disposition: "inline" | "attachment" } {
  const normalized = normalizeMime(mime);
  if (normalized === null) {
    return { contentType: OCTET_STREAM_MIME, disposition: "attachment" };
  }
  const known = Object.values(KNOWN_TYPES).find((item) => item.mime === normalized);
  if (known !== undefined && known.kind !== "html" && known.kind !== "svg") {
    return { contentType: normalized, disposition: "inline" };
  }
  return { contentType: OCTET_STREAM_MIME, disposition: "attachment" };
}

function failure(
  code: "mime_mismatch" | "content_mismatch",
  message: string,
  extension: string,
  declaredMime: string | null,
  expectedMime: string | null,
): UploadTypeValidation {
  return { ok: false, code, message, extension, declaredMime, expectedMime };
}

function isCadMime(mime: string): boolean {
  return /^model\/[a-z0-9.+-]+$/.test(mime) || /^application\/(?:step|iges|sla|gltf\+json|gltf-binary)$/.test(mime);
}

function detectSignature(bytes: Uint8Array): SignatureKind {
  if (bytes.byteLength === 0) {
    return "empty";
  }
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return "png";
  }
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) {
    return "jpeg";
  }
  if (asciiAt(bytes, 0, 6) === "GIF87a" || asciiAt(bytes, 0, 6) === "GIF89a") {
    return "gif";
  }
  if (asciiAt(bytes, 0, 4) === "RIFF" && asciiAt(bytes, 8, 4) === "WEBP") {
    return "webp";
  }
  if (asciiAt(bytes, 0, 2) === "BM") {
    return "bmp";
  }
  if (asciiAt(bytes, 0, 4) === "II*\u0000" || asciiAt(bytes, 0, 4) === "MM\u0000*") {
    return "tiff";
  }
  if (asciiAt(bytes, 4, 4) === "ftyp" && (asciiAt(bytes, 8, 4) === "avif" || asciiAt(bytes, 8, 4) === "avis")) {
    return "avif";
  }
  if (asciiAt(bytes, 0, 4) === "glTF") {
    return "glb";
  }
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]) || startsWith(bytes, [0x50, 0x4b, 0x05, 0x06])) {
    return "zip";
  }
  if (startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) {
    return "ole";
  }
  if (asciiAt(bytes, 0, 5) === "%PDF-") {
    return "pdf";
  }

  const text = decodeTextPrefix(bytes);
  if (text === null) {
    return "binary";
  }
  const trimmed = text.replace(/^\uFEFF/, "").trimStart();
  const lower = trimmed.toLowerCase();
  if (lower.startsWith("{\\rtf")) {
    return "rtf";
  }
  const rootTag = markupRootTag(lower);
  if (rootTag === "svg") {
    return "svg";
  }
  if (rootTag === "html" || rootTag === "head" || rootTag === "body" || rootTag === "script") {
    return "html";
  }
  if (lower.startsWith("<?xml")) {
    return "xml";
  }
  return "text";
}

/** 跳过 BOM 后的 XML 声明 / 注释 / DOCTYPE，只取根标签名；避免内层 <script> / <svg> 抢先分类。 */
function markupRootTag(text: string): string | null {
  let rest = text.trimStart();
  for (let depth = 0; depth < 8; depth += 1) {
    if (rest.startsWith("<!--")) {
      const end = rest.indexOf("-->");
      if (end < 0) return null;
      rest = rest.slice(end + 3).trimStart();
      continue;
    }
    if (rest.startsWith("<?")) {
      const end = rest.indexOf("?>");
      if (end < 0) return null;
      rest = rest.slice(end + 2).trimStart();
      continue;
    }
    if (rest.toLowerCase().startsWith("<!doctype")) {
      const end = rest.indexOf(">");
      if (end < 0) return null;
      rest = rest.slice(end + 1).trimStart();
      continue;
    }
    break;
  }
  const match = /^<([a-z][a-z0-9:_-]*)(?:\s|\/?>)/i.exec(rest);
  return match?.[1]?.toLowerCase() ?? null;
}

/**
 * 前缀可能在 UTF-8 多字节字符中间截断。此时只回退最多 3 个尾部字节后重试；
 * 若非法字节位于前缀内部，仍返回 null，避免把二进制内容当成文本。
 */
function decodeTextPrefix(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    for (let trim = 1; trim <= 3 && trim < bytes.byteLength; trim += 1) {
      try {
        return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, bytes.byteLength - trim));
      } catch {
        // 继续回退；仅允许修复末尾被截断的多字节序列。
      }
    }
    return null;
  }
}

function startsWith(bytes: Uint8Array, expected: readonly number[]): boolean {
  if (bytes.byteLength < expected.length) {
    return false;
  }
  return expected.every((value, index) => bytes[index] === value);
}

function asciiAt(bytes: Uint8Array, offset: number, length: number): string {
  if (offset < 0 || length < 0 || offset + length > bytes.byteLength) {
    return "";
  }
  let value = "";
  for (let index = offset; index < offset + length; index += 1) {
    value += String.fromCharCode(bytes[index]!);
  }
  return value;
}
