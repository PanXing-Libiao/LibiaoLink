import { extensionOf } from "../../storage/index.js";
import { CAD_EXTENSIONS, canonicalMimeForExtension, isRasterImageFile, isSvgFile, normalizeMime } from "./file-mime.js";
import type { PreviewTarget } from "./preview.job.js";

export { isRasterImageFile, isSvgFile };

/**
 * 预览通道判定（S3 起两段口径 · S6-前置 起收敛：图片直签 + 查看器通道 · ADR-030 / S8-2 定案 / 计划 D6）。
 *
 * - **安全位图直签**（`isRasterImageFile`）：仅扩展名与规范 MIME 精确一致时签原对象；不投转换任务。
 * - **SVG 产物通道**（`previewTargetsFor`）：SVG 只投 `target=image`，浏览器最终只能拿到 PNG 产物。
 * - **查看器通道**（`viewerChannelFor`）：Office（含宏变体 docm / xlsm / pptm）+ 文本族（txt / csv）
 *   + PDF（2026-10-08 业务口径「统一用onlyoffice」）→ ONLYOFFICE 文档大类（word / cell / slide / pdf）+
 *   文件类型（扩展名小写；无扩展名时按 MIME 反推）—— 查看器配置 `documentType` / `document.fileType` 的输入
 *   （S8-2 三补 1：文本族按 word / cell 映射）。
 *
 * H1 · S2 起图片不再看 `image/*` 前缀：只有精确位图组合允许原对象直签；SVG 只进 PNG 产物通道。
 * 判定优先级：SVG 产物通道 → 安全位图 → CAD → 查看器；判不出类型按确定性降级「请下载」。
 */

/**
 * CAD 三维族（ADR-031 · 2026-10-13）：前端浏览器直解析渲染 —— occt-import-js（OpenCASCADE WASM）
 * 读 STEP / IGES，three.js Loader 读 STL / 3MF / OBJ / glTF。与图片直签同口径：原对象短时签名直出
 * （不投转换任务、不落产物行）；dwg / dxf 不在此列 —— 二维走服务端转换管线（ADR-031 决策 1，
 * 随 M4-06 切片另行落地，届时恢复 previewTargetsFor 投递映射）。
 */
/** CAD 三维直签判定（ADR-031）：扩展名 ∈ CAD 三维族（MIME 常缺省、不可靠，仅按扩展名判）。 */
export function isCadFile(input: { fileName: string; mime: string | null }): boolean {
  const extension = extensionOf(input.fileName);
  return CAD_EXTENSIONS.has(extension);
}

/**
 * 投递通道映射：SVG 进入 `target=image` 的服务端栅格化通道（产物必须是 PNG）；其余保持空表。
 * 读取侧与定档预生成共用本函数，避免两端对 SVG 的投递口径漂移。
 */
export function previewTargetsFor(input: { fileName: string; mime: string | null }): readonly PreviewTarget[] {
  return isSvgFile(input) ? ["image"] : [];
}

/** 查看器通道输出：ONLYOFFICE documentType / document.fileType 的判定输入。 */
export interface ViewerChannel {
  documentType: "word" | "cell" | "slide" | "pdf";
  fileType: string;
}

/** 扩展名 → 查看器文档大类（文本族口径：txt / html / htm 按 word，csv 按 cell —— S8-2 三补 1）。 */
const VIEWER_EXTENSION_TYPES: Record<string, ViewerChannel> = {
  doc: { documentType: "word", fileType: "doc" },
  docx: { documentType: "word", fileType: "docx" },
  docm: { documentType: "word", fileType: "docm" },
  odt: { documentType: "word", fileType: "odt" },
  rtf: { documentType: "word", fileType: "rtf" },
  txt: { documentType: "word", fileType: "txt" },
  xls: { documentType: "cell", fileType: "xls" },
  xlsx: { documentType: "cell", fileType: "xlsx" },
  xlsm: { documentType: "cell", fileType: "xlsm" },
  ods: { documentType: "cell", fileType: "ods" },
  csv: { documentType: "cell", fileType: "csv" },
  ppt: { documentType: "slide", fileType: "ppt" },
  pptx: { documentType: "slide", fileType: "pptx" },
  pptm: { documentType: "slide", fileType: "pptm" },
  odp: { documentType: "slide", fileType: "odp" },
  // PDF（2026-10-08 业务口径「统一用onlyoffice」）：预览走查看器（documentType = pdf）。
  pdf: { documentType: "pdf", fileType: "pdf" },
};

/** MIME → 查看器通道（无扩展名 / 扩展名判不出时的反推；宏变体 MIME 以 DocServer 实际注册的小写形态比对）。 */
const VIEWER_MIME_TYPES: readonly { mime: string; channel: ViewerChannel }[] = [
  { mime: "application/msword", channel: { documentType: "word", fileType: "doc" } },
  {
    mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    channel: { documentType: "word", fileType: "docx" },
  },
  { mime: "application/vnd.ms-word.document.macroenabled.12", channel: { documentType: "word", fileType: "docm" } },
  { mime: "application/vnd.oasis.opendocument.text", channel: { documentType: "word", fileType: "odt" } },
  { mime: "application/rtf", channel: { documentType: "word", fileType: "rtf" } },
  { mime: "text/plain", channel: { documentType: "word", fileType: "txt" } },
  { mime: "application/vnd.ms-excel", channel: { documentType: "cell", fileType: "xls" } },
  {
    mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    channel: { documentType: "cell", fileType: "xlsx" },
  },
  { mime: "application/vnd.ms-excel.sheet.macroenabled.12", channel: { documentType: "cell", fileType: "xlsm" } },
  { mime: "application/vnd.oasis.opendocument.spreadsheet", channel: { documentType: "cell", fileType: "ods" } },
  { mime: "text/csv", channel: { documentType: "cell", fileType: "csv" } },
  { mime: "application/vnd.ms-powerpoint", channel: { documentType: "slide", fileType: "ppt" } },
  {
    mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    channel: { documentType: "slide", fileType: "pptx" },
  },
  {
    mime: "application/vnd.ms-powerpoint.presentation.macroenabled.12",
    channel: { documentType: "slide", fileType: "pptm" },
  },
  { mime: "application/vnd.oasis.opendocument.presentation", channel: { documentType: "slide", fileType: "odp" } },
  { mime: "application/pdf", channel: { documentType: "pdf", fileType: "pdf" } },
];

/**
 * 查看器通道判定（S3 · ADR-030；PDF 2026-10-08 并入）：Office / 文本族 / PDF → `{ documentType, fileType }`；
 * 其余 null（含图片 —— 先经 `previewTargetsFor` 走产物通道）。扩展名优先、MIME 兜底（与历史判定优先级一致）。
 */
export function viewerChannelFor(input: { fileName: string; mime: string | null }): ViewerChannel | null {
  const extension = extensionOf(input.fileName);
  const byExtension = VIEWER_EXTENSION_TYPES[extension];
  if (byExtension !== undefined) {
    const mime = normalizeMime(input.mime);
    const expected = canonicalMimeForExtension(input.fileName);
    return mime === null || mime === expected ? { ...byExtension } : null;
  }
  const mime = normalizeMime(input.mime);
  if (mime === null) {
    return null;
  }
  const byMime = VIEWER_MIME_TYPES.find((item) => item.mime === mime);
  return byMime === undefined ? null : { ...byMime.channel };
}
