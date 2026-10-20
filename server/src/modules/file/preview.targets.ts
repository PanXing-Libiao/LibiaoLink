import { extensionOf } from "../../storage/index.js";
import type { PreviewTarget } from "./preview.job.js";

/**
 * 预览通道判定（S3 起两段口径 · S6-前置 起收敛：图片直签 + 查看器通道 · ADR-030 / S8-2 定案 / 计划 D6）。
 *
 * - **图片直签**（S6-前置 · D6 · `isImageFile`）：图片预览不走产物通道 —— 读取侧对原对象短时签名直出
 *   （不投转换任务、不落产物行、不经 `deploy/preview`；字节 = 原对象；前端 `url` 通道与缩略图零改动）。
 * - **投递通道**（`previewTargetsFor`）：S6-前置 起**无投递**（常量空表）—— 图片改直签后转换管线归零消费者；
 *   `structured` 一期 501 不投（缓存键 / 枚举保留，随二期结构化渲染启用：届时在此恢复映射）。
 * - **查看器通道**（`viewerChannelFor`）：Office（含宏变体 docm / xlsm / pptm）+ 文本族（txt / csv / html / htm）
 *   + PDF（2026-10-08 业务口径「统一用onlyoffice」）→ ONLYOFFICE 文档大类（word / cell / slide / pdf）+
 *   文件类型（扩展名小写；无扩展名时按 MIME 反推）—— 查看器配置 `documentType` / `document.fileType` 的输入
 *   （S8-2 三补 1：文本族按 word / cell 映射）。
 *
 * ADR-035：读取侧先判 CAD 暂不可预览，防止误报的 MIME 进入图片/Office；其余仍按图片、查看器顺序判定。
 * 判不出类型不投 / 不落表，读取侧按确定性降级「请下载」。
 */

/** 图片族：浏览器直接渲染；矢量 SVG 也归 image 通道（ADR-007：枚举按渲染通道而非格式定义）。 */
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "bmp", "webp", "tif", "tiff", "svg"]);

/** 图片直签判定（S6-前置 · D6）：扩展名或 MIME ∈ 图片族 —— 读取侧据此走原对象短时签名。 */
export function isImageFile(input: { fileName: string; mime: string | null }): boolean {
  const extension = extensionOf(input.fileName);
  const mime = (input.mime ?? "").toLowerCase();
  return IMAGE_EXTENSIONS.has(extension) || mime.startsWith("image/");
}

/**
 * CAD 接入准备名单（ADR-035）：只用于暂不可预览提示，不是已支持格式清单。
 * 后续以独立工程能力矩阵接入模型资源；此处不得恢复原文件图片直签。
 */
const CAD_EXTENSIONS = new Set(["step", "stp", "iges", "igs", "stl", "3mf", "obj", "gltf", "glb", "easm", "dxf", "dwg"]);

/** 版本扩展名判定；MIME 不作为 CAD 支持或签名依据。 */
export function isCadPreviewPending(input: { fileName: string }): boolean {
  const extension = extensionOf(input.fileName);
  return CAD_EXTENSIONS.has(extension);
}

/**
 * 投递通道映射（M4-05c 定档预生成 / 读取侧补投的共用判定点）：S6-前置（D6）起常量空表 ——
 * 图片改原对象直签（见 `isImageFile`，不经转换）、其余走查看器通道，转换管线无投递；
 * `structured` 二期启用时在此恢复映射（契约 `PREVIEW_TARGETS` 枚举已预留）。
 */
export function previewTargetsFor(_input: { fileName: string; mime: string | null }): readonly PreviewTarget[] {
  return [];
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
  html: { documentType: "word", fileType: "html" },
  htm: { documentType: "word", fileType: "htm" },
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
  { mime: "text/html", channel: { documentType: "word", fileType: "html" } },
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
  const byExtension = VIEWER_EXTENSION_TYPES[extensionOf(input.fileName)];
  if (byExtension !== undefined) {
    return { ...byExtension };
  }
  const mime = (input.mime ?? "").toLowerCase();
  const byMime = VIEWER_MIME_TYPES.find((item) => item.mime === mime);
  return byMime === undefined ? null : { ...byMime.channel };
}
