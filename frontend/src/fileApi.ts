import { RefreshQueue, liveReadPaused, subscribeLiveHints } from "./liveSync";
/**
 * 文件库客户端（Push 216 · 日报 / 问题附图上传与预览接线；Push 226 · 任务「文件」列 / 抽屉上传接线）。
 * Push 226 续：任务文件删除（recycleFile —— 先读 version 再移入回收站）与图片点击预览（isImageFileName + ensurePreviewUrl）。
 * Push 226 续二：文件改名（renameFile —— PATCH /files/{id}，先读 version 再写）与列表「文件」列
 *   显示文件名所需的项目文件名单（fetchTaskFiles —— 列表接口不带文件名，这里按项目一次拉全量，免 N+1；Push 246 起携 id 供「文件」列下拉预览 / 删除）。
 * Push 226 续三：PDF / Office / 文本点击预览（previewKindOf —— 与 server preview.targets.ts 同口径）。
 * ADR-035：CAD 接入准备期间仅识别文件类型以显示暂不可预览提示，原文件下载独立保留。
 * Push 226 续四：原文件下载（fetchDownloadUrl + triggerDownload —— 版本短时签名 attachment + 原文件名；
 *   与预览浮层区分：下载始终拿原文件、写 download 审计）。
 * Push 258 续：下载改「fetch 字节 → Blob objectURL 落盘」（download 属性精确落原名、不依赖对象存储的 Content-Disposition）。
 *   实测口径（Chrome 154）：http 内网源（10.1.7.169）下直链与 Blob **都会**被标「未确认 *.crdownload」等用户「保留」
 *   （判定看发起页面的源；同一 blob 流程在安全源 127.0.0.1 下干净落盘）—— 彻底无提示需站点做成安全源（https / 浏览器策略
 *   白名单），部署侧另行处理；应用侧保证「拿到的字节 = 原文件」。配套查看器「右上角下载 → 原文件」：document.permissions.download=true
 *   （图标保持可见）+ FilePreviewOverlay 原位透明命中层接管点击。
 * Push 258 续二：上传 contentHash 的 WebCrypto 取法补纯 JS 回退（sha256.ts）—— 内网 http 明文访问（10.1.7.169）属
 *   非安全源、crypto.subtle 为 undefined，取哈希抛错会让上传表现为「点了没反应」；回退输出与 WebCrypto 一致。
 * S4（ONLYOFFICE 查看器外壳 · 计划 S4 / R5）：Office / 文本族改走**查看器通道** —— ensurePreviewOutcome 按响应裁决
 *   （viewer 非空 = 查看器外壳；url 非空 = 产物浮层）；previewKindOf 增 "office"（名单与 server viewerChannelFor 对齐）。
 * 2026-10-08：PDF 曾并入查看器通道（业务口径「统一用onlyoffice」）。
 * 2026-10-28 移动端修订：PDF 改服务端直签 + 前端 PDF.js；viewer 非空仍按查看器裁决，url 非空按直签浮层裁决。
 * 2026-10-08 续：文件替换（replaceFileContent —— 业务口径「增加一个替换按钮 点击替换则选择新文件代替」）：
 *   未定档（draft）直替 = intent=version + fileId（版本链追加、名称 / 归属不变）；已定档 / 已变更 = intent=change
 *   + change.reason 必填（A4-13 申请即通过，完成上传时同事务生效）。
 *   Push 251 撤销：业务口径「取消这个替换按钮」→ UI 入口与替换流程整体撤除（本函数保留、未接线；服务端变更通道不动）。
 * 2026-10-08 续二（Push 249）：定档上传（uploadFile / uploadFiles / replaceFileContent 的 finalize 选项 + finalizeFile）——
 *   业务口径「添加和替换文件要提示是否为定档文件，若是则上传文件后该任务定档不支持任何修改」：传输完成即定档该文件
 *   （POST /files/{id}/finalize），挂接任务随文件定档一并锁定（服务端同事务）：此后任务写口一律 409 TASK_FINALIZED，修改走变更。
 * 2026-10-12（附件域秒传复用）：附件上传（未给 taskId / nodeId / docType）命中同项目同内容既有文件时，
 *   服务端直接返回既有文件（reused=true、upload=null，不建文件 / 会话）；uploadFile 命中即跳过传输、直接用
 *   既有 fileId —— 同一张图在日报 / 问题附图多处粘贴只沉淀一条文件库记录；同内容在途上传按
 *   （项目 + 哈希 + 任务）合并为一次链路。
 * 上传链路（D2 分片直传，契约 shared/src/modules/files.ts；参考实现 server/scripts/m4-upload-replay.mjs）：
 *   POST /api/v1/files/uploads（intent=version，contentHash = SHA-256）
 *   → POST /api/v1/files/{fileId}/uploads/{uploadId}/parts 取预签名分片 URL
 *   → 对预签名 URL **原样 PUT**（不带任何额外请求头，与浏览器直传同口径）
 *   → POST /api/v1/files/{fileId}/uploads/{uploadId}/complete { contentHash }
 * 预览：GET /api/v1/files/{fileId}/preview → ready 时短时签名 URL（模块级缓存 + 订阅，供附图懒取）。
 * Push 255（业务口径「文件显示 已变更 不如直接替换成变更后的啊… 变更记录也要显示 之前是什么文件 这次是什么文件… 文件可以预览在变更里面」）：
 *   变更记录行接版本链 —— fetchFileVersions（GET /files/{id}/versions）+ 版本态预览 / 下载
 *   （ensurePreviewOutcome(fileId, versionId?) / fetchDownloadUrl(fileId, versionId?)：A4-06 任意历史版本可预览与下载 * Push 261（业务口径「新增文件库 文件库里面分为 系统现有文件 回收站」）：文件库列表（fetchProjectFileLibrary —— 跨项目聚合的单项目读口，
 *   按项目分页取满；系统现有文件 = 四档在库状态、回收站 = filter[status]=recycled）与回收站两个写口（restoreFile / purgeFile）在此收口；
 *   页面见 frontend/src/FileLibraryPage.tsx。
 */
import { useEffect, useSyncExternalStore } from "react";
import { ApiError, apiRequest, apiSend, readAllPages } from "./api";
import { sha256Hex } from "./sha256";

type UploadCreateResponse = {
  file: { id: string; name: string };
  /** 上传会话；附件域秒传复用命中 = null（2026-10-12：同一内容的附图只沉淀一条文件记录，不再重复传输）。 */
  upload: { id: string; partSizeBytes: number; totalParts: number } | null;
  /** true = 未新建文件 / 未建会话，file = 复用的既有文件（仅附件域；任务成果上传恒 false）。 */
  reused: boolean;
};

type UploadPartsResponse = { parts: Array<{ partNumber: number; url: string }> };

type UploadCompleteResponse = { file: { id: string; name: string } };

/** ONLYOFFICE 查看器配置（契约 PreviewViewer 子集 · S4 直接组装 DocEditor 配置；token = documentType / document（含 permissions）/ editorConfig 逐字签发）。 */
export type OnlyOfficePreviewViewerConfig = {
  kind: "onlyoffice";
  docServerUrl: string;
  documentType: "word" | "cell" | "slide";
  document: {
    title: string;
    url: string;
    fileType: string;
    key: string;
    /** 查看器权限段（Push 258 错层修正起嵌 document —— ONLYOFFICE 只认该位置；download 保持可见 · 点击由浮层命中层接管 → 原文件）。 */
    permissions: { edit: boolean; download: boolean; print: boolean; comment: boolean; chat: boolean; fillForms: boolean; protect: boolean };
  };
  editorConfig: { mode: "view"; lang: string; user: { id: string; name: string } };
  token: string;
};

export type CadNameCodepage = "UTF8" | "GB";

export type CadPreviewViewerConfig = {
  kind: "cad";
  fileId: string;
  versionId: string;
  sourceSHA256: string;
  engineVersion: string;
};
export type PreviewViewerConfig = OnlyOfficePreviewViewerConfig | CadPreviewViewerConfig;

/** 预览状态响应（契约 FilePreviewResponse 子集）：ready 才有签名地址 / 查看器配置（两通道互斥）。 */
type FilePreviewResponse = {
  status: string;
  url: string | null;
  viewer: PreviewViewerConfig | null;
  reason: string | null;
};

/** 上传文件的可选关联（taskId 给出时文件挂到该任务；file_links 同事务建立）。 */
export type UploadFileOptions = {
  taskId?: string;
  /** 定档上传（Push 249 · 业务口径「若是则上传文件后该任务定档不支持任何修改」）：传输完成即对该文件定档
   *  （POST /files/{id}/finalize）—— 挂接任务随文件定档一并锁定（服务端同事务、幂等）。 */
  finalize?: boolean;
};

/**
 * 上传一个文件 / Blob 到站内文件库（M4-01 分片直传；任务成果文件与日报附图共用一条链路）。
 * name 单独传：剪贴板图片的 File 名与业务名不一致（见 uploadPhoto）；options.taskId 关联任务。返回新文件的 id。
 */
/** 单片上传最大尝试次数（含首次）：浏览器侧取消流 / 网络瞬断等单次失败重试后继续，不再整单报废。 */
const PART_UPLOAD_MAX_ATTEMPTS = 3;
/** 重试退避基数（毫秒）：第 N 次失败后等待 N × 该值再重试。 */
const PART_UPLOAD_RETRY_DELAY_MS = 500;

/** 分片签名接口路径（首传整批签 / 重试单签共用）。 */
function uploadPartsPath(fileId: string, uploadId: string): string {
  return "/api/v1/files/" + encodeURIComponent(fileId) + "/uploads/" + encodeURIComponent(uploadId) + "/parts";
}

/** 失败响应体摘要（MinIO 错误 XML / 网关页等）：压平空白并截断，仅用于错误文案。 */
async function readErrorSnippet(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text.replace(/\s+/g, " ").trim().slice(0, 140);
  } catch {
    return "";
  }
}

/** 单分片上传（带重试）：重试前重新签该分片（顺带规避签名过期）；全部尝试失败抛末次原因。 */
async function putPartWithRetry(
  fileId: string,
  uploadId: string,
  part: { partNumber: number; url: string },
  slice: ArrayBuffer,
): Promise<void> {
  let lastReason = "";
  for (let attempt = 1; attempt <= PART_UPLOAD_MAX_ATTEMPTS; attempt += 1) {
    let url = part.url;
    if (attempt > 1) {
      const refreshed = await apiSend<UploadPartsResponse>(uploadPartsPath(fileId, uploadId), "POST", {
        partNumbers: [part.partNumber],
      });
      const next = refreshed.parts.find((item) => item.partNumber === part.partNumber);
      if (next !== undefined) {
        url = next.url;
      }
    }
    try {
      const response = await fetch(url, {
        method: "PUT",
        headers: { "Content-Type": "application/octet-stream" },
        body: slice,
      });
      if (response.ok) {
        return;
      }
      const snippet = await readErrorSnippet(response);
      lastReason = "第 " + String(part.partNumber) + " 片，HTTP " + String(response.status) + (snippet === "" ? "" : "：" + snippet);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      lastReason = "第 " + String(part.partNumber) + " 片，请求中断：" + message;
    }
    if (attempt < PART_UPLOAD_MAX_ATTEMPTS) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, attempt * PART_UPLOAD_RETRY_DELAY_MS);
      });
    }
  }
  throw new Error("文件上传失败（" + lastReason + "；已尝试 " + String(PART_UPLOAD_MAX_ATTEMPTS) + " 次）");
}

/** 分片直传公共尾段（uploadFile / replaceFileContent 共用）：取分片签名 → 逐片代重试 PUT → complete。 */
async function transferChunks(
  fileId: string,
  upload: { id: string; partSizeBytes: number; totalParts: number },
  buffer: ArrayBuffer,
  contentHash: string,
): Promise<void> {
  const partNumbers: number[] = [];
  for (let index = 1; index <= upload.totalParts; index += 1) {
    partNumbers.push(index);
  }
  const signed = await apiSend<UploadPartsResponse>(
    uploadPartsPath(fileId, upload.id),
    "POST",
    { partNumbers },
  );
  for (const part of signed.parts) {
    const start = (part.partNumber - 1) * upload.partSizeBytes;
    const slice = buffer.slice(start, Math.min(start + upload.partSizeBytes, buffer.byteLength));
    await putPartWithRetry(fileId, upload.id, part, slice);
  }
  await apiSend<UploadCompleteResponse>(
    "/api/v1/files/" + encodeURIComponent(fileId) + "/uploads/" + encodeURIComponent(upload.id) + "/complete",
    "POST",
    { contentHash },
  );
}

/** 上传中途失败时尽力取消会话；页面刷新等来不及发请求的未完成会话由服务端读面隐藏并由过期清扫兜底。 */
async function abortCreatedUpload(fileId: string, uploadId: string): Promise<void> {
  try {
    await apiSend<unknown>("/api/v1/files/" + encodeURIComponent(fileId) + "/uploads/" + encodeURIComponent(uploadId) + "/abort", "POST");
  } catch {
    // 取消是失败后的收尾：不覆盖原始上传错误；已完成或已过期会话无需再次处理。
  }
}

/** 同内容在途上传合并表（key = 项目 + 哈希 + 任务）：连点 / 一次粘贴多份同一张图只发一次上传链路。 */
const inFlightUploads = new Map<string, Promise<string>>();

export async function uploadFile(projectId: string, file: Blob, name: string, options: UploadFileOptions = {}): Promise<string> {
  const buffer = await file.arrayBuffer();
  const contentHash = await sha256Hex(buffer);
  const key = projectId + "|" + contentHash + "|" + (options.taskId ?? "");
  const running = inFlightUploads.get(key);
  if (running !== undefined) {
    return running;
  }
  const pending = (async (): Promise<string> => {
    const created = await apiSend<UploadCreateResponse>("/api/v1/files/uploads", "POST", {
      projectId,
      name,
      sizeBytes: file.size,
      mime: file.type === "" ? undefined : file.type,
      contentHash,
      intent: "version",
      taskId: options.taskId,
    });
    // 附件域秒传复用（2026-10-12）：服务端不建文件 / 会话，直接用既有 file.id。
    if (created.reused || created.upload === null) {
      return created.file.id;
    }
    try {
      await transferChunks(created.file.id, created.upload, buffer, contentHash);
    } catch (error) {
      await abortCreatedUpload(created.file.id, created.upload.id);
      throw error;
    }
    if (options.finalize === true) {
      await finalizeFile(created.file.id);
    }
    return created.file.id;
  })();
  inFlightUploads.set(key, pending);
  try {
    return await pending;
  } finally {
    inFlightUploads.delete(key);
  }
}

/**
 * 替换文件内容（2026-10-08 · 业务口径「增加一个替换按钮 点击替换则选择新文件代替」）：
 * 未定档（draft）= 直接替换 —— intent=version + fileId（A2-10「未定档文件可直接替换」；版本链追加，
 * 名称 / 归属不变 —— 契约要求给出 fileId 时 name 与目标一致）；已定档 / 已变更（final / changed）= 走变更
 * （A4-13 申请即通过）—— intent=change + change.reason 必填，完成上传时同事务生效（文件状态 → changed）。
 * 替换完成后清一次该文件的预览签名缓存（旧版本 URL 作废）。
 * finalize（Push 249）= 未定档直替后定档（任务随定档锁定）；已定档 / 已变更走变更、不定档（change 路径下忽略）。
 * Push 251 撤销（业务口径「取消这个替换按钮」）：入口与流程已从 UI 撤除，本函数保留未接线（供后续需要时复用）。
 */
/**
 * 变更载荷（契约 ChangeIntentBody · A4-13 十三列字段面）：reason 必填（≤ 1000，承载「变更内容描述（+变更原因）」）；
 * 变更前 / 变更后摘要可空（各 ≤ 2000）；变更阶段可选（stageKey 缺省 = 服务端取文件节点所属阶段）。
 */
export type FileChangePayload = {
  reason: string;
  beforeSummary?: string;
  afterSummary?: string;
  /** Push 314（业务口径「这个变更要可以填图片」）：变更前 / 变更后摘要附图（files.id 有序，各 ≤ 30；须为本项目未回收文件）。 */
  beforeSummaryFileIds?: string[];
  afterSummaryFileIds?: string[];
  stageKey?: string;
};

/**
 * 变更申请（A4-13 一期「申请即通过」· 抽屉「变更申请」页）：目标文件须为已定档（final / changed）——
 * Push 254 续（业务口径 2026-10-08「不是已经定档了吗 为什么变更申请里面还是未定档」）：任务已定档时，其名下
 * draft 文件同视为「定档后的文件」（taskFinalized = true 放行；服务端同口径兜底）——
 * 提交 = `intent=change` 分片直传（沿用上传管道），完成上传时同事务生成变更记录 + 新版本挂 changeRequestId +
 * 文件状态改 changed + R01 回写任务「变更关联」；**无变更后文件不允许提交**（A4-13 提交校验，本函数 file 必传）。
 * 变更后清一次该文件的预览签名缓存（旧版本 URL 作废）。
 * Push 256（业务口径「变更后文件的名字后后缀要用变更选择的 不然都不能预览」）：`name` 传**变更后文件名**（含扩展名）
 * —— 服务端完成变更时把文件更名为该名称（对象键 / 预览通道随之用新扩展名；历史版本仍按各自旧扩展名预览）。
 */
export async function applyFileChange(projectId: string, target: TaskFileRef, file: File, change: FileChangePayload, taskFinalized = false): Promise<void> {
  const taskFinalizedDraft = taskFinalized && target.status === "draft";
  if (target.status !== "final" && target.status !== "changed" && !taskFinalizedDraft) {
    throw new Error("只有已定档文件可以发起变更");
  }
  const reason = change.reason.trim();
  if (reason === "") {
    throw new Error("请填写变更原因");
  }
  const before = change.beforeSummary === undefined ? "" : change.beforeSummary.trim();
  const after = change.afterSummary === undefined ? "" : change.afterSummary.trim();
  const buffer = await file.arrayBuffer();
  const contentHash = await sha256Hex(buffer);
  const created = await apiSend<UploadCreateResponse>("/api/v1/files/uploads", "POST", {
    projectId,
    name: file.name === "" ? target.name : file.name,
    sizeBytes: file.size,
    mime: file.type === "" ? undefined : file.type,
    contentHash,
    intent: "change",
    fileId: target.id,
    change: {
      reason,
      beforeSummary: before === "" ? undefined : before,
      afterSummary: after === "" ? undefined : after,
      beforeSummaryFileIds: change.beforeSummaryFileIds === undefined || change.beforeSummaryFileIds.length === 0 ? undefined : change.beforeSummaryFileIds,
      afterSummaryFileIds: change.afterSummaryFileIds === undefined || change.afterSummaryFileIds.length === 0 ? undefined : change.afterSummaryFileIds,
      stageKey: change.stageKey === undefined || change.stageKey === "" ? undefined : change.stageKey,
    },
  });
  if (created.upload === null) {
    throw new Error("上传会话创建失败，请重试");
  }
  await transferChunks(created.file.id, created.upload, buffer, contentHash);
  invalidatePreview(target.id);
}

/** 变更记录详情（契约 ChangeRequestDetail · M4-04 读面 A4-15）：变更本体 + 变更后文件 + 变更后版本（本文件只需用到的字段）；
 *  Push 319：导入表导入变更暂无变更后文件（源文件在微盘）→ fileId / versionId / versionSeq / file / version 可为 null。 */
export type ChangeRequestDetail = {
  id: string;
  projectId: string;
  nodeId: string | null;
  stageKey: string | null;
  reason: string;
  beforeSummary: string | null;
  afterSummary: string | null;
  /** Push 314：变更前 / 变更后摘要附图（files.id 有序；读面按 id 懒取预览签名）。 */
  beforeSummaryFileIds: string[];
  afterSummaryFileIds: string[];
  status: string;
  appliedBy: string;
  /** Push 347：导入表导入的「填写者」账号（源表「填写者」列命中）；应用内提交 / 未命中 = null（「填写者」回落申请人展示）。 */
  writerBy: string | null;
  appliedAt: string;
  /** Push 319：导入遗留变更（无变更后文件）= null（前端标「变更后文件待补」）。 */
  fileId: string | null;
  versionId: string | null;
  versionSeq: number | null;
  file: { id: string; name: string; docType: string | null; status: string } | null;
  version: { id: string; seq: number; sizeBytes: number; uploadedAt: string } | null;
  /** Push 256：本次变更同时更名时 = 更名前文件名称（变更记录「变更前」行显示）；未更名 = null。 */
  filePreviousName: string | null;
};

/**
 * 变更记录列表行（契约 ChangeRequest · M4-04 读面 A4-15）：GET /projects/{id}/change-requests 的一行
 * （变更本体 + 反查的文件 / 版本；导入遗留变更 fileId / versionId 为空、状态仍为 pending 体系外的原值）。
 * Push 353：仪表盘「词频图」取数（dashboardApi.ts 的 fetchDashboardChangeWords）与点词「数据详情」用它。
 */
export type ApiChangeRequest = {
  readonly id: string;
  readonly projectId: string;
  readonly nodeId: string | null;
  readonly stageKey: string | null;
  readonly reason: string;
  readonly beforeSummary: string | null;
  readonly afterSummary: string | null;
  readonly beforeSummaryFileIds: readonly string[];
  readonly afterSummaryFileIds: readonly string[];
  readonly status: string;
  readonly appliedBy: string;
  readonly writerBy: string | null;
  readonly appliedAt: string;
  readonly createdAt: string;
  readonly fileId: string | null;
  readonly versionId: string | null;
  readonly versionSeq: number | null;
};

/** 项目变更记录列表（M4-04 读面 · Push 353 仪表盘「词频图」取数）：GET /projects/{id}/change-requests 翻页取满。 */
export async function fetchProjectChanges(projectId: string): Promise<ApiChangeRequest[]> {
  const payload = await readAllPages<ApiChangeRequest>("/api/v1/projects/" + encodeURIComponent(projectId) + "/change-requests");
  return payload.items;
}

/** 变更详情（抽屉「变更记录」页按任务 changeLinks 逐条取全文；非成员 / 不存在统一 404）。 */
export function fetchChangeRequest(id: string): Promise<ChangeRequestDetail> {
  return apiRequest<ChangeRequestDetail>("/api/v1/change-requests/" + encodeURIComponent(id));
}

export async function replaceFileContent(projectId: string, target: TaskFileRef, file: File, reason: string | null, finalize = false): Promise<void> {
  const needsChange = target.status === "final" || target.status === "changed";
  const changeReason = reason === null ? "" : reason.trim();
  if (needsChange && changeReason === "") {
    throw new Error("已定档文件替换需填写变更原因");
  }
  const buffer = await file.arrayBuffer();
  const contentHash = await sha256Hex(buffer);
  const created = await apiSend<UploadCreateResponse>("/api/v1/files/uploads", "POST", {
    projectId,
    // Push 256：change 路径 name = 变更后文件名（完成时更名）；version 路径须与目标文件一致（直接替换 = 同一文件）
    name: needsChange ? (file.name === "" ? target.name : file.name) : target.name,
    sizeBytes: file.size,
    mime: file.type === "" ? undefined : file.type,
    contentHash,
    intent: needsChange ? "change" : "version",
    fileId: target.id,
    change: needsChange ? { reason: changeReason } : undefined,
  });
  if (created.upload === null) {
    throw new Error("上传会话创建失败，请重试");
  }
  await transferChunks(created.file.id, created.upload, buffer, contentHash);
  invalidatePreview(target.id);
  if (finalize && !needsChange) {
    await finalizeFile(target.id);
  }
}

/** 批量上传（任务「文件」列 / 抽屉共用）：逐份直传；每份完成回调一次（done = 已完成份数）。 */
export async function uploadFiles(
  projectId: string,
  files: readonly File[],
  options: UploadFileOptions & { onProgress?: (done: number, total: number) => void } = {},
): Promise<string[]> {
  const ids: string[] = [];
  for (const file of files) {
    ids.push(await uploadFile(projectId, file, file.name, options));
    options.onProgress?.(ids.length, files.length);
  }
  return ids;
}

/** 上传一张图片 / 文件（粘贴与选文件共用）：返回 file_links 用的文件 id。 */
export function uploadPhoto(projectId: string, blob: Blob, name: string): Promise<string> {
  return uploadFile(projectId, blob, name);
}

/** 图片扩展名判定（TaskFileBrief 不带 mime）：抽屉里只有图片给「点击预览」。（Push 226 续） */
const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg", ".avif"];
export function isImageFileName(name: string): boolean {
  const lower = name.toLowerCase();
  return IMAGE_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

/** PDF 查看器族（2026-10-28 移动端修订）：API 直签原件，前端 PDF.js 本地分页渲染；
 *  不再创建 ONLYOFFICE 文档会话，也不再依赖移动浏览器内置 PDF 插件。 */
const PDF_PREVIEW_EXTENSIONS = [".pdf"];

/** ONLYOFFICE 查看器族（S4 · 名单与 server preview.targets.ts 的 viewerChannelFor 对齐）：Office（含宏变体）
 *  + 文本族（txt / csv）。HTML / HTM 是主动内容，服务端已移出查看器通道，前端也不出预览入口。 */
const OFFICE_VIEWER_EXTENSIONS = [".doc", ".docx", ".docm", ".odt", ".rtf", ".txt", ".xls", ".xlsx", ".xlsm", ".ods", ".csv", ".ppt", ".pptx", ".pptm", ".odp"];

/** CAD 暂不可预览提示名单（ADR-035，与 server isCadPreviewPending 对齐）。仅分类，不声明解析支持。 */
const CAD_PREVIEW_EXTENSIONS = [".step", ".stp", ".iges", ".igs", ".stl", ".3mf", ".obj", ".gltf", ".glb", ".easm", ".dxf", ".dwg"];

/** 可视预览通道：image = 取签名字节后由 img 浮层渲染（40×40 缩略图仍直取签名）；pdf = PDF.js 本地分页渲染；
 *  office = ONLYOFFICE 查看器外壳（S4：api.js + DocEditor，超时 / 重试 / 降级「请下载」）；
 *  cad = 接入准备提示，不加载模型；判不出 = null（抽屉里没有预览入口，只有改名 / 删除）。 */
export type FilePreviewKind = "image" | "pdf" | "office" | "cad";
export function previewKindOf(name: string): FilePreviewKind | null {
  if (isImageFileName(name)) {
    return "image";
  }
  const lower = name.toLowerCase();
  if (PDF_PREVIEW_EXTENSIONS.some((extension) => lower.endsWith(extension))) {
    return "pdf";
  }
  if (OFFICE_VIEWER_EXTENSIONS.some((extension) => lower.endsWith(extension))) {
    return "office";
  }
  if (CAD_PREVIEW_EXTENSIONS.some((extension) => lower.endsWith(extension))) {
    return "cad";
  }
  return null;
}

/** 删除文件 = 移入回收站（M4-02；任意状态可删、默认保留 30 天可恢复）。
 *  recycle 体要求 version 作乐观锁，而任务详情随行的 TaskFileBrief 不带 version —— 先读一次文件详情。 */
export async function recycleFile(fileId: string): Promise<void> {
  const detail = await apiRequest<{ version: number }>("/api/v1/files/" + encodeURIComponent(fileId));
  await apiSend<{ file: { id: string } }>("/api/v1/files/" + encodeURIComponent(fileId) + "/recycle", "POST", { version: detail.version });
}

/** 文件改名（Push 226 续二 · 业务口径「名称要可以修改」）：PATCH /files/{id} —— 乐观锁 version 先读详情取回。 */
export async function renameFile(fileId: string, name: string): Promise<void> {
  const detail = await apiRequest<{ version: number }>("/api/v1/files/" + encodeURIComponent(fileId));
  await apiSend<{ id: string }>("/api/v1/files/" + encodeURIComponent(fileId), "PATCH", { name, version: detail.version });
}

/** 文件定档（Push 249 · 业务口径「添加和替换文件要提示是否为定档文件，若是则上传文件后该任务定档不支持任何修改」）：
 *  POST /files/{id}/finalize —— draft → final（锁版、至少 1 个版本）；挂接任务随文件定档一并定档（服务端同事务、幂等）：
 *  此后任务不支持任何修改（写口一律 409 TASK_FINALIZED），修改走变更（A4-13 申请即通过）。
 *  乐观锁 version 先读详情取回（同 recycle / rename 口径）。 */
export async function finalizeFile(fileId: string): Promise<void> {
  const detail = await apiRequest<{ version: number }>("/api/v1/files/" + encodeURIComponent(fileId));
  await apiSend<{ id: string }>("/api/v1/files/" + encodeURIComponent(fileId) + "/finalize", "POST", { version: detail.version });
}

/** 下载签名响应（契约 FileDownloadUrlResponse 子集）。 */
type FileDownloadUrlResponse = { url: string; fileName: string; sizeBytes: number; expiresAt: string };

/**
 * 取**原文件**的短时签名下载地址（Push 226 续四 · 业务口径「下载为什么都是pdf 你是不是签名调用错了」）：
 * `GET /files/{id}/versions/{versionId}/download-url`（版本必填 —— 缺省先读详情拿当前版本）。
 * Push 255：versionId 可选给出 —— 变更记录「变更前 / 变更后」直接下对应历史版本（A4-06），不再回落到当前版本。
 * 契约语义：签名带 `Content-Disposition: attachment` + 原文件名 → 浏览器落盘的是**原文件字节**
 * （与预览区分：S4 起 Office / 文本族走 ONLYOFFICE 查看器渲染 —— 下载始终拿原文件）；服务端写 download 审计、判 `file.download` 权限。
 */
export async function fetchDownloadUrl(fileId: string, versionId?: string): Promise<{ url: string; fileName: string }> {
  let target = versionId;
  if (target === undefined) {
    const detail = await apiRequest<{ currentVersion: { id: string } | null }>("/api/v1/files/" + encodeURIComponent(fileId));
    target = detail.currentVersion === null ? undefined : detail.currentVersion.id;
  }
  if (target === undefined) {
    throw new Error("文件还没有版本，暂时不能下载");
  }
  const signed = await apiRequest<FileDownloadUrlResponse>(
    "/api/v1/files/" + encodeURIComponent(fileId) + "/versions/" + encodeURIComponent(target) + "/download-url",
  );
  return { url: signed.url, fileName: signed.fileName };
}

/** 版本链摘要（Push 255 · 变更记录「变更前 / 变更后」行）：GET /files/{id}/versions —— 只追加的版本链按 seq 反查上一版。 */
export type FileVersionBrief = { id: string; seq: number; sizeBytes: number; uploadedAt: string };

/** 取文件版本链（只追加；变更记录用 seq = 变更版本号 - 1 反查「变更前」文件版本）。 */
export async function fetchFileVersions(fileId: string): Promise<FileVersionBrief[]> {
  const list = await apiRequest<{ items: Array<{ id: string; seq: number; sizeBytes: number; uploadedAt: string }>; total: number }>(
    "/api/v1/files/" + encodeURIComponent(fileId) + "/versions",
  );
  return list.items.map((item) => ({ id: item.id, seq: item.seq, sizeBytes: item.sizeBytes, uploadedAt: item.uploadedAt }));
}

/** 触发一次浏览器下载（Push 258 续）：先 fetch 成 Blob 再走 objectURL 落盘 —— download 属性必生效（原文件名精确落盘），
 *  不依赖对象存储的 Content-Disposition；注意：http 内网源下 Chrome 对**任何**下载（含 blob:）都会标「未确认 *.crdownload」
 *  等用户点「保留」（实测对照：安全源 127.0.0.1 干净落盘）—— 这一步是浏览器对非安全源的限制，站点升 https / 策略白名单后即消失。
 *  失败抛错，由调用方提示。 */
export async function triggerDownload(url: string, fileName: string): Promise<void> {
  const response = await fetch(url, { credentials: "omit" });
  if (response.ok !== true) {
    throw new Error("下载失败（HTTP " + String(response.status) + "），请稍后再试");
  }
  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = fileName;
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => {
    URL.revokeObjectURL(objectUrl);
  }, 10000);
}

/** 任务文件引用（Push 246；2026-10-08 携 status 供「替换」裁决）：任务列表「文件」列下拉与单元格展示共用 ——
 *  id 供预览 / 删除 / 替换，name 供展示，status（draft / final / changed / archived）= 替换走直替还是变更的分支依据。 */
export type TaskFileRef = { id: string; name: string; status: string };

/** 项目文件库名单（任务「文件」列下拉 / 单元格文件名用 · Push 246 起携 id）：按项目分页取满（契约 limit 上限 200、默认排除 recycled），
 *  返回 taskId → 文件引用数组（服务端默认序 = 最新在前）；列表接口不带文件名，逐行反查会 N+1，这里一次拉全量；
 *  Push 246 起带 id（下拉里点击文件名 = 预览、行尾「删除」= 移入回收站）；2026-10-08 起带 status（行尾「替换」按状态直替 / 走变更）。 */
export async function fetchTaskFiles(projectId: string): Promise<Map<string, TaskFileRef[]>> {
  const files = new Map<string, TaskFileRef[]>();
  for (let page = 1; page <= 100; page += 1) {
    const list = await apiRequest<{ items: Array<{ id: string; name: string; taskId: string | null; status: string }>; total: number }>(
      "/api/v1/projects/" + encodeURIComponent(projectId) + "/files?limit=200&page=" + String(page),
    );
    for (const file of list.items) {
      if (file.taskId === null) {
        continue;
      }
      const current = files.get(file.taskId);
      if (current === undefined) {
        files.set(file.taskId, [{ id: file.id, name: file.name, status: file.status }]);
      } else {
        current.push({ id: file.id, name: file.name, status: file.status });
      }
    }
    if (list.items.length === 0 || page * 200 >= list.total) {
      return files;
    }
  }
  throw new ApiError(413, "LIST_TOO_LARGE", "项目文件超过20,000份，请缩小读取范围后重试");
}

/** fileId → 已就绪的预览签名（无 = 还没取到 / 取不到）。 */
const previewUrls = new Map<string, string>();
const previewLoading = new Map<string, Promise<PreviewOpenOutcome>>();
const previewExpires = new Map<string, number>();
const stalePreviews = new Set<string>();
const activePhotos = new Map<string, number>();
let previewEpoch = 0;
const previewRefresh = new RefreshQueue(async () => {
  await Promise.all([...activePhotos.keys()].map((id) => ensurePreviewUrl(id)));
  return () => {};
}, liveReadPaused);
subscribeLiveHints((resources) => {
  if (!resources.includes("files")) return;
  previewEpoch += 1;
  for (const key of previewUrls.keys()) if (!key.includes("@")) stalePreviews.add(key);
  previewRefresh.request();
});
const previewListeners = new Set<() => void>();

function notifyPreview(): void {
  for (const listener of previewListeners) {
    listener();
  }
}

function subscribePreview(listener: () => void): () => void {
  previewListeners.add(listener);
  return () => {
    previewListeners.delete(listener);
  };
}

/** 预览缓存键（Push 255）：版本态预览按 fileId + versionId 分开缓存（缺省版本沿用 fileId —— 附图 / 缩略图口径不变）。 */
function previewCacheKey(fileId: string, versionId?: string): string {
  return versionId === undefined ? fileId : fileId + "@" + versionId;
}

/** 替换 / 内容更新后清掉该文件的预览签名缓存（缓存 URL 指着旧版本；Push 255：该文件的版本态键一并清）。 */
export function invalidatePreview(fileId: string): void {
  let removed = false;
  for (const key of [...previewUrls.keys()]) {
    if (key === fileId || key.startsWith(fileId + "@")) {
      stalePreviews.add(key);
      previewExpires.delete(key);
      removed = true;
    }
  }
  if (removed) {
    previewEpoch += 1;
    previewRefresh.request();
  }
}

/** 预览打开结果（S4 两通道裁决）：url = 产物通道短时签名；viewer = 查看器通道配置；unavailable = 未就绪超时 / 失败 / 异常。 */
export type PreviewOpenOutcome =
  | { kind: "url"; url: string }
  | { kind: "viewer"; viewer: PreviewViewerConfig }
  | { kind: "unavailable"; reason: string | null };

/** 取预览打开输入（带 URL 缓存 + 同文件并发去重；Push 255：versionId 可选 —— 变更记录按版本态取，缓存键分开）。
 *  就绪轮询预算 = 20 秒（Push 226 续：worker 的 outbox 领取间隔
 *  默认 5 秒 —— 首次预览「点开才排队转换」，6 秒窗口在真机上会偶发拿不到；failed 立即返回，不会白等；
 *  查看器通道（Office / 文本）就绪即签发、无需等待转换）。S4：外壳按响应裁决 viewer / url 两通道。 */
export function ensurePreviewOutcome(fileId: string, versionId?: string): Promise<PreviewOpenOutcome> {
  const key = previewCacheKey(fileId, versionId);
  const cached = previewUrls.get(key);
  if (cached !== undefined && !stalePreviews.has(key) && (previewExpires.get(key) ?? 0) > Date.now()) return Promise.resolve({ kind: "url", url: cached });
  const pending = previewLoading.get(key);
  if (pending !== undefined) return pending;
  const promise = readPreviewOutcome(fileId, versionId).finally(() => previewLoading.delete(key));
  previewLoading.set(key, promise);
  return promise;
}

/** 预览端点：`recordView` 只在用户真正点开某个图片 / 文件时追加；缩略图一律省略。 */
function previewRequestPath(fileId: string, versionId?: string, recordView = false): string {
  const params = new URLSearchParams();
  if (versionId !== undefined) {
    params.set("versionId", versionId);
  }
  if (recordView) {
    params.set("recordView", "true");
  }
  const query = params.toString();
  return "/api/v1/files/" + encodeURIComponent(fileId) + "/preview" + (query === "" ? "" : "?" + query);
}

async function readPreviewOutcome(fileId: string, versionId?: string): Promise<PreviewOpenOutcome> {
  const key = previewCacheKey(fileId, versionId);
  const epoch = previewEpoch;
  const endpoint = previewRequestPath(fileId, versionId);
  try {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const preview = await apiRequest<FilePreviewResponse>(endpoint);
      if (preview.status === "ready") {
        if (preview.viewer !== null) {
          return { kind: "viewer", viewer: preview.viewer };
        }
        if (preview.url !== null) {
          if (activePhotos.has(fileId) && typeof Image !== "undefined") {
            const loaded = await new Promise<boolean>((resolve) => { const picture = new Image(); const timer = window.setTimeout(() => resolve(false), 10000); picture.onload = () => { window.clearTimeout(timer); resolve(true); }; picture.onerror = () => { window.clearTimeout(timer); resolve(false); }; picture.src = preview.url ?? ""; });
            if (!loaded) return { kind: "unavailable", reason: null };
          }
          if (versionId !== undefined || epoch === previewEpoch) {
            previewUrls.set(key, preview.url);
            previewExpires.set(key, Date.now() + 4 * 60 * 1000);
            stalePreviews.delete(key);
            notifyPreview();
          } else previewRefresh.request();
          return { kind: "url", url: preview.url };
        }
        return { kind: "unavailable", reason: null };
      }
      if (preview.status === "failed") {
        return { kind: "unavailable", reason: preview.reason };
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return { kind: "unavailable", reason: null };
  } catch {
    return { kind: "unavailable", reason: null };
  } finally {
    // Shared pending reads are released by the public wrapper.
  }
}

/** 取预览签名（带缓存；缩略图专用 —— 不写预览审计）。查看器通道走 ensurePreviewOutcome。 */
export async function ensurePreviewUrl(fileId: string): Promise<string | null> {
  const outcome = await ensurePreviewOutcome(fileId);
  return outcome.kind === "url" ? outcome.url : null;
}

/** 用户真正点开具体预览后，显式补一次「查看」审计（同一文件 / 版本的并发请求合并）。
 *  不复用缩略图缓存：缓存命中时也要让服务端知道这一次是用户主动打开，而不是页面挂载时的批量签名。 */
const previewViewRecords = new Map<string, Promise<void>>();
export function recordPreviewView(fileId: string, versionId?: string): Promise<void> {
  if (fileId === "") {
    return Promise.resolve();
  }
  const key = previewCacheKey(fileId, versionId);
  const pending = previewViewRecords.get(key);
  if (pending !== undefined) {
    return pending;
  }
  const request = apiRequest<FilePreviewResponse>(previewRequestPath(fileId, versionId, true))
    .then(() => undefined, () => undefined)
    .finally(() => {
      previewViewRecords.delete(key);
    });
  previewViewRecords.set(key, request);
  return request;
}

/** 附图缩略图展示地址：本地 blob（会话内刚贴的图）优先，否则懒取服务端预览签名并订阅缓存变化。
 *  2026-10-27：缩略图只取签名、不写审计；`recordPreviewView` 在大图真正打开时补记一次。 */
export function usePhotoUrl(fileId: string, localUrl: string | null): string | null {
  const remote = useSyncExternalStore(subscribePreview, () => (fileId === "" ? null : previewUrls.get(fileId) ?? null));
  useEffect(() => {
    if (fileId !== "" && localUrl === null) {
      activePhotos.set(fileId, (activePhotos.get(fileId) ?? 0) + 1);
      void ensurePreviewUrl(fileId);
      const renewal = window.setInterval(() => { previewRefresh.request(); }, 60000);
      return () => { window.clearInterval(renewal); const count = (activePhotos.get(fileId) ?? 1) - 1; if (count === 0) activePhotos.delete(fileId); else activePhotos.set(fileId, count); };
    }
  }, [fileId, localUrl]);
  return localUrl ?? remote;
}

/**
 * 文件库列表项（M4-03 读面 FileSchema 子集；Push 261「文件库（系统现有文件 / 回收站）」）。
 * 列表项不带大小（大小在版本链上：FileVersionSchema.sizeBytes）—— 文件库不展示，预览 / 下载走各自入口。
 * 状态取值：draft（草稿）/ final（已定档）/ changed（已变更）/ archived（已归档）/ recycled（回收站）。
 */
export type FileLibraryItem = {
  id: string;
  projectId: string;
  taskId: string | null;
  docType: string | null;
  name: string;
  status: string;
  version: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  finalizedAt: string | null;
  recycledAt: string | null;
  recycledBy: string | null;
  recycledFromStatus: string | null;
};

/**
 * 文件库单项目查询（契约 FileListQuerySchema 子集）。
 * statuses 必给：系统现有文件栏 = 四档在库状态（draft / final / changed / archived；服务端缺省虽排除 recycled，
 * 但显式给全更不容易随口径漂移），回收站栏 = recycled（服务端显式 filter[status]=recycled 才返回回收站行）。
 */
export type FileLibraryQuery = {
  statuses: readonly string[];
  /** 文件名关键字（服务端 ILIKE 包含命中、大小写不敏感）；空 / 缺省 = 不落参数。 */
  keyword?: string;
  /** 成果文件类型（十类字典，中文值）；空 / 缺省 = 不落参数。 */
  docType?: string;
  /** 上传人（createdBy）；空 / 缺省 = 不落参数。 */
  uploadedBy?: string;
};

/** 单项目文件库一页的请求地址（契约参数命名：filter[...] 键名不编码、多值逗号分隔，与 projectApi.buildListQuery 同口径）。 */
function fileLibraryPageUrl(projectId: string, query: FileLibraryQuery, page: number): string {
  const parts = [
    "limit=200",
    "page=" + String(page),
    "filter[status]=" + query.statuses.map((status) => encodeURIComponent(status)).join(","),
  ];
  if (query.keyword !== undefined && query.keyword !== "") {
    parts.push("q=" + encodeURIComponent(query.keyword));
  }
  if (query.docType !== undefined && query.docType !== "") {
    parts.push("filter[docType]=" + encodeURIComponent(query.docType));
  }
  if (query.uploadedBy !== undefined && query.uploadedBy !== "") {
    parts.push("filter[uploadedBy]=" + encodeURIComponent(query.uploadedBy));
  }
  return "/api/v1/projects/" + encodeURIComponent(projectId) + "/files?" + parts.join("&");
}

/**
 * 单项目文件库全量（Push 261 · 文件库页跨项目聚合的口子）：按项目分页取满（limit 上限 200、最多100页，超过20,000份明确报错，
 * 与 fetchTaskFiles 同一分页口径）；返回项的服务端序 = 最新在前（默认 createdAt 降序、id 升序兜底）。
 * 单项目失败（非成员 404 / 网络抖动）向调用方抛 —— 由页面逐项目兜底跳过，不阻断整页（见 FileLibraryPage.tsx）。
 */
export async function fetchProjectFileLibrary(projectId: string, query: FileLibraryQuery): Promise<FileLibraryItem[]> {
  const items: FileLibraryItem[] = [];
  for (let page = 1; page <= 100; page += 1) {
    const list = await apiRequest<{ items: FileLibraryItem[]; total: number }>(fileLibraryPageUrl(projectId, query, page));
    items.push(...list.items);
    if (list.items.length === 0 || items.length >= list.total) {
      return items;
    }
  }
  throw new ApiError(413, "LIST_TOO_LARGE", "项目文件超过20,000份，请缩小筛选后重试");
}

/** 回收站恢复（Push 261 · 文件库「回收站」栏 · 任意账号）：POST /files/{id}/restore ——
 *  回退到进入回收站前的状态（recycledFromStatus，兜底 draft）；乐观锁 version 先读详情取回（同 recycle / rename / finalize 口径）。 */
export async function restoreFile(fileId: string): Promise<void> {
  const detail = await apiRequest<{ version: number }>("/api/v1/files/" + encodeURIComponent(fileId));
  await apiSend<{ id: string }>("/api/v1/files/" + encodeURIComponent(fileId) + "/restore", "POST", { version: detail.version });
}

/** 彻底删除（Push 261 · 文件库「回收站」栏 · 仅系统管理员 —— 服务端按 groupAccessAdmin 硬闸，A4-12）：
 *  POST /files/{id}/purge —— 对象与元数据一并清理、操作留痕；仅回收站中的文件可彻底删除；乐观锁 version 先读详情取回。 */
export async function purgeFile(fileId: string): Promise<void> {
  const detail = await apiRequest<{ version: number }>("/api/v1/files/" + encodeURIComponent(fileId));
  await apiSend<{ fileId: string }>("/api/v1/files/" + encodeURIComponent(fileId) + "/purge", "POST", { version: detail.version });
}
