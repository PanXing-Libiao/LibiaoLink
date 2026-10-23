/**
 * 对象键构造（ADR-006 工程要点 + 契约 FileVersion 描述）。
 *
 * 键形 = `projects/{projectId}/files/{fileId}/v{seq}/{contentHash}.{ext}`
 * - 版本、内容哈希都在键里：**定档不覆盖物理对象**，历史版本天然不可变；
 * - 原文件名（含中文）只进元数据，不进键（避免编码 / 超长 / 特殊字符问题）。
 *
 * 所有输入都来自服务端自身（不是客户端字符串拼接），但仍做严格校验：
 * 对象键是路径，任何未净化的片段都可能被解析成越权路径。
 */

const FALLBACK_EXTENSION = "bin";
const MAX_EXTENSION_LENGTH = 16;
const SHA256_HEX = /^[a-f0-9]{64}$/i;

/** 取扩展名：小写、仅 `[a-z0-9]`、最长 16；无 / 非法 / 过长一律回落 `bin`。 */
export function extensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  if (dot <= 0 || dot === fileName.length - 1) {
    return FALLBACK_EXTENSION;
  }
  const raw = fileName.slice(dot + 1).toLowerCase();
  if (raw.length > MAX_EXTENSION_LENGTH || !/^[a-z0-9]+$/.test(raw)) {
    return FALLBACK_EXTENSION;
  }
  return raw;
}

/** 主名（去扩展名；无扩展名 / 非法扩展名 = 原名）—— 版本态文件名拼接用。 */
function baseNameOf(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  return dot <= 0 ? fileName : fileName.slice(0, dot);
}

/**
 * 版本态展示 / 下载文件名（Push 256 · 业务口径「变更后文件的名字后后缀要用变更选择的」）：
 * 主名取当前文件名、扩展名取**版本对象键里的扩展名**（该版本落库时定下的真实扩展名）——
 * 变更更名（如 .xls → .pptx）后：新版本按新扩展名预览 / 下载；历史版本仍按各自旧扩展名
 * （视口通道判定同口径，见 preview-read.service），不会把历史的 xls 内容标成 pptx。
 * 对象键扩展名 = `bin`（原来就没有合法扩展名）→ 原样返回当前文件名。
 */
export function versionFileName(currentName: string, objectKey: string): string {
  const extension = extensionOf(objectKey);
  if (extension === FALLBACK_EXTENSION) {
    return currentName;
  }
  return baseNameOf(currentName) + "." + extension;
}

export interface ObjectKeyInput {
  projectId: string;
  fileId: string;
  /** 版本号（同一文件内递增，从 1 开始）。 */
  seq: number;
  /** 内容哈希（SHA-256 十六进制）；键里用哈希保证同版本不同内容不互相覆盖。 */
  contentHash: string;
  /** 原始文件名：只取扩展名。 */
  fileName: string;
}

export function buildObjectKey(input: ObjectKeyInput): string {
  if (!Number.isInteger(input.seq) || input.seq < 1) {
    throw new Error("对象键构造失败：seq 必须是 >= 1 的整数");
  }
  if (!SHA256_HEX.test(input.contentHash)) {
    throw new Error("对象键构造失败：contentHash 必须是 SHA-256 十六进制");
  }
  assertUuid(input.projectId, "projectId");
  assertUuid(input.fileId, "fileId");
  return `projects/${input.projectId}/files/${input.fileId}/v${input.seq}/${input.contentHash.toLowerCase()}.${extensionOf(input.fileName)}`;
}

export interface PreviewArtifactKeyInput {
  /** 服务端分配的文件版本 ID，隔离不同文档与历史版本。 */
  versionId: string;
  /** 该版本的内容哈希（SHA-256 十六进制），不跨版本复用。 */
  contentHash: string;
  /** 转换管线版本（`PREVIEW_PIPELINE_VERSION`，与镜像标签同值）：进键 = 换管线自动失效、旧产物不被读到。 */
  pipelineVersion: string;
  /** 渲染通道（契约 PreviewTarget）：同一内容可有多种产物，通道必须在键内。 */
  target: string;
}

/** 键片段白名单：字母 / 数字 / `.` `_` `-`（首字符必须是字母或数字，最长 64）—— 防路径注入。 */
const KEY_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * 预览产物键（ADR-007）：`previews/versions/{versionId}/{contentHash}/{pipelineVersion}/{target}`。
 *
 * 版本与管线 / 通道均进键：不同文件、版本或项目即使申报相同哈希，也不能共享对象。
 * 转换器不接触对象存储（字节流进 / 流出），键由本函数构造、由 worker 落 `preview_artifacts.object_key`。
 */
export function buildPreviewArtifactKey(input: PreviewArtifactKeyInput): string {
  assertUuid(input.versionId, "versionId");
  if (!SHA256_HEX.test(input.contentHash)) {
    throw new Error("预览产物键构造失败：contentHash 必须是 SHA-256 十六进制");
  }
  if (!KEY_SEGMENT.test(input.pipelineVersion)) {
    throw new Error("预览产物键构造失败：pipelineVersion 只允许字母 / 数字 / . _ -（最长 64）");
  }
  if (!KEY_SEGMENT.test(input.target)) {
    throw new Error("预览产物键构造失败：target 只允许字母 / 数字 / . _ -（最长 64）");
  }
  return `previews/versions/${input.versionId}/${input.contentHash.toLowerCase()}/${input.pipelineVersion}/${input.target}`;
}

/** 上传会话（未定版）的暂存键：同一文件可并发多个会话，按会话 id 隔离。 */
export function buildUploadStagingKey(input: { projectId: string; fileId: string; sessionId: string }): string {
  assertUuid(input.projectId, "projectId");
  assertUuid(input.fileId, "fileId");
  assertUuid(input.sessionId, "sessionId");
  return `projects/${input.projectId}/files/${input.fileId}/staging/${input.sessionId}`;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUuid(value: string, field: string): void {
  if (!UUID.test(value)) {
    throw new Error(`对象键构造失败：${field} 不是合法的 UUID`);
  }
}
