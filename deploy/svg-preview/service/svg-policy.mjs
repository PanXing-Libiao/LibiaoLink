import { SaxesParser } from "saxes";

export const DEFAULT_LIMITS = Object.freeze({
  maxSourceBytes: 20 * 1024 * 1024,
  maxOutputBytes: 20 * 1024 * 1024,
  minLongEdge: 1600,
  maxLongEdge: 4096,
  maxPixels: 16_777_216,
  maxAspectRatio: 16,
  maxNaturalEdge: 1_000_000,
  maxElements: 100_000,
});

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const XML_NAMESPACE = "http://www.w3.org/XML/1998/namespace";
const XMLNS_NAMESPACE = "http://www.w3.org/2000/xmlns/";
const PROHIBITED_ELEMENTS = new Set(["script", "foreignobject", "iframe", "object", "embed"]);
const ACTIVE_SCHEMES = ["java" + "script:", "vb" + "script:", "da" + "ta:"];
const ACTIVE_CSS_MARKERS = [["expression", "("].join(""), ["-moz", "-binding"].join(""), ["beha", "vior:"].join("")];
const EXTERNAL_CSS_MARKERS = [["image", "-set("].join(""), ["-webkit", "-image-set("].join(""), ["src", "("].join("")];

export class SvgPolicyError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SvgPolicyError";
    this.code = code;
  }
}

function reject(code, message) {
  throw new SvgPolicyError(code, message);
}

function assertSafeCss(value) {
  const lower = value.toLowerCase();
  if (value.includes("\\")) reject("SVG_CSS_ESCAPE", "SVG 样式包含转义序列，已拒绝");
  if (lower.includes("/*")) reject("SVG_CSS_COMMENT", "SVG 样式包含注释，已拒绝");
  if (lower.includes("@" + "import") || lower.includes("@" + "font-face")) {
    reject("SVG_ACTIVE_CSS", "SVG 样式包含外部资源，已拒绝");
  }
  if (ACTIVE_SCHEMES.some((scheme) => lower.includes(scheme)) || ACTIVE_CSS_MARKERS.some((marker) => lower.includes(marker))) {
    reject("SVG_ACTIVE_CSS", "SVG 样式包含主动内容，已拒绝");
  }
  if (EXTERNAL_CSS_MARKERS.some((marker) => lower.includes(marker))) {
    reject("SVG_EXTERNAL_RESOURCE", "SVG 样式包含外部资源，已拒绝");
  }
  let offset = 0;
  while (true) {
    const index = lower.indexOf("url(", offset);
    if (index < 0) return;
    let cursor = index + 4;
    while (cursor < value.length && /\s/.test(value[cursor])) cursor += 1;
    if (value[cursor] === '"' || value[cursor] === "'") cursor += 1;
    if (value[cursor] !== "#") reject("SVG_EXTERNAL_RESOURCE", "SVG 样式只能引用文档内资源，已拒绝");
    offset = cursor + 1;
  }
}

function assertInternalReference(value) {
  const reference = value.trim();
  if (!reference.startsWith("#") || reference.length < 2) {
    reject("SVG_EXTERNAL_RESOURCE", "SVG 只允许文档内 href 引用，已拒绝");
  }
}

function inspectAttribute(attribute) {
  if (attribute.uri === XMLNS_NAMESPACE || attribute.local === "xmlns") return;
  const local = attribute.local.toLowerCase();
  if (local.startsWith("on")) reject("SVG_EVENT_ATTRIBUTE", "SVG 事件属性已拒绝");
  if (attribute.uri === XML_NAMESPACE && local === "base") reject("SVG_EXTERNAL_RESOURCE", "SVG xml:base 已拒绝");
  if (local === "href") assertInternalReference(attribute.value);
  if (local === "src") reject("SVG_EXTERNAL_RESOURCE", "SVG src 属性已拒绝");
  assertSafeCss(attribute.value);
}

function readAttribute(attributes, name) {
  const wanted = name.toLowerCase();
  for (const attribute of Object.values(attributes)) {
    if (attribute.local.toLowerCase() === wanted) return attribute.value;
  }
  return null;
}

function parseLength(value) {
  if (typeof value !== "string") return null;
  const match = /^\s*([+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)\s*(px|pt|pc|mm|cm|in)?\s*$/i.exec(value);
  if (match === null) return null;
  const number = Number(match[1]);
  if (!Number.isFinite(number) || number <= 0) return null;
  const unit = (match[2] ?? "px").toLowerCase();
  return number * { px: 1, pt: 96 / 72, pc: 16, mm: 96 / 25.4, cm: 96 / 2.54, in: 96 }[unit];
}

function parseViewBox(value) {
  if (typeof value !== "string") return null;
  const parts = value.trim().split(/[\s,]+/).map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part))) return null;
  const width = parts[2];
  const height = parts[3];
  if (width <= 0 || height <= 0 || width > 1_000_000_000 || height > 1_000_000_000) return null;
  return { width, height };
}

function dimensionsFor(root, limits) {
  const width = parseLength(readAttribute(root.attributes, "width"));
  const height = parseLength(readAttribute(root.attributes, "height"));
  const viewBox = parseViewBox(readAttribute(root.attributes, "viewBox"));
  const natural = width !== null && height !== null ? { width, height } : viewBox;
  if (natural === null) reject("SVG_DIMENSION_UNKNOWN", "SVG 缺少可计算的宽高或 viewBox，已拒绝");
  const longEdge = Math.max(natural.width, natural.height);
  const shortEdge = Math.min(natural.width, natural.height);
  if (longEdge > limits.maxNaturalEdge) reject("SVG_DIMENSION_TOO_LARGE", "SVG 原始尺寸超过安全上限，已拒绝");
  if (longEdge / shortEdge > limits.maxAspectRatio) reject("SVG_ASPECT_RATIO", "SVG 长宽比超过安全上限，已拒绝");
  const targetLongEdge = Math.min(limits.maxLongEdge, Math.max(limits.minLongEdge, longEdge));
  const landscape = natural.width >= natural.height;
  const outputWidth = Math.max(1, Math.round(landscape ? targetLongEdge : (targetLongEdge * natural.width) / natural.height));
  const outputHeight = Math.max(1, Math.round(landscape ? (targetLongEdge * natural.height) / natural.width : targetLongEdge));
  if (outputWidth > limits.maxLongEdge || outputHeight > limits.maxLongEdge) reject("SVG_OUTPUT_TOO_LARGE", "SVG 输出尺寸超过安全上限，已拒绝");
  if (outputWidth * outputHeight > limits.maxPixels) reject("SVG_PIXEL_LIMIT", "SVG 输出像素数超过安全上限，已拒绝");
  return {
    naturalWidth: natural.width,
    naturalHeight: natural.height,
    outputWidth,
    outputHeight,
    fitTo: landscape ? { mode: "width", value: outputWidth } : { mode: "height", value: outputHeight },
  };
}

export function inspectSvg(input, overrides = {}) {
  const limits = { ...DEFAULT_LIMITS, ...overrides };
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (bytes.byteLength === 0) reject("SVG_EMPTY", "SVG 文件为空，已拒绝");
  if (bytes.byteLength > limits.maxSourceBytes) reject("SVG_SOURCE_TOO_LARGE", "SVG 源文件超过安全上限，已拒绝");
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\uFEFF/, "");
  } catch {
    reject("SVG_ENCODING", "SVG 不是合法 UTF-8，已拒绝");
  }
  if (text.includes("\0")) reject("SVG_INVALID_XML", "SVG 包含 NUL 字符，已拒绝");
  const lower = text.toLowerCase();
  if (/<!\s*(doctype|entity)\b/.test(lower)) reject("SVG_DTD_FORBIDDEN", "SVG 包含 DOCTYPE / ENTITY，已拒绝");
  if (/<\?\s*xml-stylesheet\b/.test(lower)) reject("SVG_EXTERNAL_RESOURCE", "SVG 外部样式指令已拒绝");
  let root = null;
  let elementCount = 0;
  let styleText = null;
  const stack = [];
  const parser = new SaxesParser({ xmlns: true });
  parser.on("opentag", (tag) => {
    elementCount += 1;
    if (elementCount > limits.maxElements) reject("SVG_ELEMENT_LIMIT", "SVG 元素数量超过安全上限，已拒绝");
    const local = tag.local.toLowerCase();
    if (root === null) {
      if (local !== "svg") reject("SVG_ROOT", "根元素必须是 svg，已拒绝");
      if (tag.uri !== "" && tag.uri !== SVG_NAMESPACE) reject("SVG_ROOT", "SVG 命名空间非法，已拒绝");
      root = tag;
    }
    if (PROHIBITED_ELEMENTS.has(local)) reject("SVG_ACTIVE_CONTENT", "SVG 主动内容或 foreignObject 已拒绝");
    if (styleText !== null) reject("SVG_INVALID_CSS", "SVG style 元素不得包含子元素，已拒绝");
    for (const attribute of Object.values(tag.attributes)) inspectAttribute(attribute);
    stack.push(local);
    if (local === "style") styleText = "";
  });
  parser.on("text", (value) => {
    if (styleText !== null) styleText += value;
  });
  parser.on("cdata", (value) => {
    if (styleText !== null) styleText += value;
  });
  parser.on("comment", () => {
    if (styleText !== null) reject("SVG_CSS_COMMENT", "SVG 样式包含 XML 注释，已拒绝");
  });
  parser.on("closetag", (tag) => {
    if (tag.local.toLowerCase() === "style") {
      assertSafeCss(styleText ?? "");
      styleText = null;
    }
    stack.pop();
  });
  parser.on("processinginstruction", () => reject("SVG_EXTERNAL_RESOURCE", "SVG 处理指令已拒绝"));
  parser.on("doctype", () => reject("SVG_DTD_FORBIDDEN", "SVG 包含 DOCTYPE，已拒绝"));
  try {
    parser.write(text).close();
  } catch (error) {
    if (error instanceof SvgPolicyError) throw error;
    reject("SVG_INVALID_XML", "SVG XML 解析失败，已拒绝");
  }
  if (root === null) reject("SVG_ROOT", "SVG 缺少根元素，已拒绝");
  return { text, limits, ...dimensionsFor(root, limits) };
}
