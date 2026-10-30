import { z } from "../zod.ts";
import { CadPreviewViewerSchema } from "./cad.ts";
import {
  DateTimeSchema,
  PageQuerySchema,
  SortQuerySchema,
  UuidSchema,
  VersionSchema,
  paginated,
} from "../common/conventions.ts";
import { ChangeStatusSchema, DocTypeSchema, FileStatusSchema, StageKeySchema } from "../common/dicts.ts";

/**
 * 文件与变更契约（v0.2 §5.1-5.3；系统功能书 A4-01~A4-18 / D2 的接口面）。
 * 生命周期：draft → final（定档锁版）→ changed（变更后）→ archived（归档只读）→ recycled（回收站，默认 30 天可恢复）。
 * 一期变更「申请即通过、所有人平权」：提交即生成变更记录与新版本；定档后修改必须走变更，不允许直接替换。
 */

export const Sha256Schema = z
  .string()
  .regex(/^[a-f0-9]{64}$/i)
  .openapi("Sha256", { description: "SHA-256 内容哈希（十六进制）；用于重复内容提示与变更前后留痕" });

/** 图片附件引用（file_links 读面 · Push 215）：日报现场图 / 问题图等贴图场景；预览地址按需走 /files/{fileId}/preview（短时签名，D2）。 */
export const FilePhotoRefSchema = z
  .object({
    fileId: UuidSchema,
    name: z.string().openapi({ description: "原文件名（缩略图角标 / 无障碍文案）" }),
  })
  .openapi("FilePhotoRef", { description: "图片附件引用（多态关联读面；不做匿名直链，预览经预览接口换短时签名）" });

export const UploadIntentSchema = z.enum(["version", "change"]).openapi("UploadIntent", {
  description:
    "上传意图：version = 新增/替换版本（仅 draft 文件）；change = 定档后变更（同一事务写 change_requests + 新版本 + 状态 changed）；**目标任务已定档（Task.finalizedAt 非空）时 version 意图一律 409 TASK_FINALIZED**（Push 249：任务定档后不支持任何修改，修改走变更）",
});

export const UploadSessionStatusSchema = z
  .enum(["active", "completed", "aborted", "expired"])
  .openapi("UploadSessionStatus", { description: "上传会话状态；active 可续传，completed/aborted/expired 不可再用" });

/** 文件版本（file_versions；版本链只追加、不覆盖；定档后新增版本必须携带 changeRequestId）。 */
export const FileVersionSchema = z
  .object({
    id: UuidSchema,
    fileId: UuidSchema,
    seq: z.number().int().positive().openapi({ description: "版本号（同一文件内递增，从 1 开始）" }),
    sizeBytes: z.number().int().min(0),
    contentHash: Sha256Schema,
    mime: z.string().nullable(),
    uploadedBy: UuidSchema,
    uploadedAt: DateTimeSchema,
    changeRequestId: UuidSchema.nullable().openapi({ description: "来源变更；普通版本（草稿期）为空" }),
  })
  .openapi("FileVersion", { description: "文件版本（v0.2 §5.1；对象键 = projects/{projectId}/files/{fileId}/v{seq}/{contentHash}.{ext}）" });

/** 文件（files；版本与状态由服务端维护，客户端不得直接改状态）。 */
export const FileSchema = z
  .object({
    id: UuidSchema,
    projectId: UuidSchema,
    nodeId: UuidSchema.nullable(),
    taskId: UuidSchema.nullable(),
    docType: DocTypeSchema.nullable().openapi({ description: "成果文件类型（十类字典）；普通附件为空" }),
    name: z.string().openapi({ example: "机械设计图纸-v2.docx", description: "原文件名（含中文，保留在元数据）" }),
    status: FileStatusSchema,
    currentVersionId: UuidSchema.nullable(),
    version: VersionSchema,
    createdBy: UuidSchema,
    createdAt: DateTimeSchema,
    updatedAt: DateTimeSchema,
    finalizedAt: DateTimeSchema.nullable().openapi({ description: "定档时间；未定档为空" }),
    finalizedBy: UuidSchema.nullable(),
    recycledAt: DateTimeSchema.nullable().openapi({ description: "进入回收站时间；恢复或彻底删除后清空 / 记录终止" }),
    recycledBy: UuidSchema.nullable(),
    recycledFromStatus: FileStatusSchema.nullable().openapi({ description: "进入回收站前的状态；恢复时回退到该状态" }),
  })
  .openapi("File", { description: "文件（v0.2 §5.2；定档后不可覆盖，修改必须走变更）" });

export const FileDetailSchema = FileSchema.extend({
  currentVersion: FileVersionSchema.nullable(),
}).openapi("FileDetail", { description: "文件详情（含当前版本；版本链走 /files/{id}/versions）" });

export const ChangeRequestSchema = z
  .object({
    id: UuidSchema,
    projectId: UuidSchema,
    nodeId: UuidSchema.nullable(),
    stageKey: StageKeySchema.nullable().openapi({ description: "变更阶段（九阶段字典）" }),
    reason: z.string().openapi({ description: "变更原因（必填）" }),
    beforeSummary: z.string().nullable().openapi({ description: "变更前摘要" }),
    afterSummary: z.string().nullable().openapi({ description: "变更后摘要" }),
    beforeSummaryFileIds: z.array(UuidSchema).openapi({ description: "变更前摘要附图（文件 id 有序；Push 314 变更前后可填图）" }),
    afterSummaryFileIds: z.array(UuidSchema).openapi({ description: "变更后摘要附图（文件 id 有序；Push 314 变更前后可填图）" }),
    status: ChangeStatusSchema,
    appliedBy: UuidSchema,
    writerBy: UuidSchema.nullable().openapi({ description: "变更记录「填写者」账号（Push 347 / 迁移 0054）：导入表导入按源表「填写者」列匹配命中；应用内提交 / 未命中 / 存量行 = null（前端「填写者」回落申请人展示）" }),
    appliedAt: DateTimeSchema,
    createdAt: DateTimeSchema,
    fileId: UuidSchema.nullable().openapi({ description: "变更文件（一期单文件一条变更；多文件 change_items 后续扩展）；Push 319：导入表导入变更暂无变更后文件（源文件在微盘，人工后补）= null" }),
    versionId: UuidSchema.nullable().openapi({ description: "变更后版本（file_versions.change_request_id 反查）；导入遗留变更 = null" }),
    versionSeq: z.number().int().positive().nullable().openapi({ description: "变更后版本号；导入遗留变更 = null" }),
  })
  .openapi("ChangeRequest", { description: "变更记录（v0.2 §5.3；一期申请即通过、全程留痕）" });

export const ChangeRequestDetailSchema = ChangeRequestSchema.extend({
  file: FileSchema.nullable(),
  version: FileVersionSchema.nullable(),
  filePreviousName: z
    .string()
    .nullable()
    .openapi({ description: "变更前文件名称（Push 256：本次变更同时更名 —— name/扩展名随变更文件替换时 = 更名前名称；未更名 = null）" }),
}).openapi("ChangeRequestDetail");

export const ChangeRequestListQuerySchema = z
  .object({
    "filter[stageKey]": z.string().optional().openapi({ description: "阶段（多值逗号分隔）" }),
    "filter[nodeId]": UuidSchema.optional(),
    "filter[fileId]": UuidSchema.optional(),
    "filter[appliedBy]": UuidSchema.optional(),
    "filter[projectId]": UuidSchema.optional(),
    q: z.string().optional().openapi({ description: "关键字（变更原因 / 变更前后摘要）" }),
    page: PageQuerySchema.shape.page,
    limit: PageQuerySchema.shape.limit,
    sort: SortQuerySchema.optional(),
  })
  .openapi("ChangeRequestListQuery");

export const ChangeRequestListResponseSchema = paginated(ChangeRequestSchema).openapi("ChangeRequestListResponse");

export const ChangeIntentBodySchema = z
  .object({
    reason: z.string().min(1).max(1000).openapi({ description: "变更原因（必填；无变更后文件不允许提交）" }),
    beforeSummary: z.string().max(2000).optional(),
    afterSummary: z.string().max(2000).optional(),
    beforeSummaryFileIds: z.array(UuidSchema).max(30).optional().openapi({ description: "变更前摘要附图（文件 id 有序，≤ 30；须为本项目未回收文件，否则 400 VALIDATION_FAILED）" }),
    afterSummaryFileIds: z.array(UuidSchema).max(30).optional().openapi({ description: "变更后摘要附图（文件 id 有序，≤ 30；同左口径）" }),
    stageKey: StageKeySchema.optional(),
  })
  .openapi("ChangeIntentBody", { description: "变更申请字段（随上传会话提交，完成上传时同事务生效）" });

const UploadCreateBaseSchema = z.object({
  projectId: UuidSchema,
  name: z.string().min(1).max(255).openapi({
    description: "文件名：fileId 省略（新建）= 新文件名；intent=version 且给出 fileId = 目标文件名称（须与现状一致，不一致 400）；intent=change = 变更后文件名称（Push 256：必填，可不同于目标文件名 —— 完成变更时文件更名为该名称，扩展名随之更新，预览 / 下载按新名称）",
  }),
  sizeBytes: z
    .number()
    .int()
    .min(0)
    .openapi({ description: "字节数；上限由服务端配置（UPLOAD_MAX_SIZE_MB），超出返回 400 VALIDATION_FAILED" }),
  mime: z.string().max(200).optional(),
  contentHash: Sha256Schema.optional().openapi({
    description: "客户端计算的内容哈希；附件上传（未给 taskId / nodeId / docType）命中同项目既有同内容附件时直接秒传复用（reused=true、upload=null，不建新文件 / 会话）；其余命中返回 duplicateHint（A4-04，提示后可确认继续）；complete 时必须回传",
  }),
  docType: DocTypeSchema.optional(),
  nodeId: UuidSchema.optional(),
  taskId: UuidSchema.optional(),
});

/**
 * 发起上传：version = 草稿期新增 / 替换版本（fileId 省略 = 新建文件，给出 = 对既有 draft 文件替换 / 追加版本）；
 * change = 定档后变更（fileId 与 change 均必填；A4-13 申请即通过，完成上传时同事务生效）。
 */
export const UploadCreateBodySchema = z
  .discriminatedUnion("intent", [
    UploadCreateBaseSchema.extend({
      intent: z.literal("version"),
      fileId: UuidSchema.optional().openapi({
        description: "目标文件（可选）：省略 = 新建文件；给出 = 对既有未定档（draft）文件替换 / 追加新版本（系统功能书 A2-10「未定档文件可直接替换」）。目标非 draft → 409 FILE_STATE_INVALID；不存在 / 无权 → 404；与 projectId 不一致 → 400；给出时名称与归属（name / docType / nodeId / taskId）以目标文件现状为准 —— 可省略，填写则须与目标文件一致（不一致 400）；duplicateHint 恒为空；**任务定档（Push 249）**：目标任务已定档（Task.finalizedAt 非空）时，intent=version 的挂接（新建 / 直接替换 / 追加版本）一律 409 TASK_FINALIZED",
      }),
    }),
    UploadCreateBaseSchema.extend({
      intent: z.literal("change"),
      fileId: UuidSchema.openapi({
        description: "变更目标文件（必填，A4-13）：须为已定档（final / changed）状态；非该状态 → 409 FILE_STATE_INVALID；不存在 / 无权 → 404；与 projectId 不一致 → 400；归属（docType / nodeId / taskId）以目标文件现状为准 —— 可省略，填写则须与目标文件一致（不一致 400）；**name = 变更后文件名称（Push 256）**：可与目标文件名不同（不一致不再 400）—— 完成变更时文件更名为该名称，扩展名随之更新，预览 / 下载按新名称；duplicateHint 恒为空",
      }),
      change: ChangeIntentBodySchema,
    }),
  ])
  .openapi("UploadCreateBody", { description: "发起上传（分片直传；返回预签名分片 URL 的获取入口）。intent=version：fileId 省略 = 新建文件、给出 = 对既有 draft 文件替换 / 追加版本；intent=change：fileId 必填 = 定档后变更（申请即通过，完成上传时同事务生效；name = 变更后文件名称 —— 完成时文件更名为该名称）" });

export const UploadSessionSchema = z
  .object({
    id: UuidSchema,
    fileId: UuidSchema,
    intent: UploadIntentSchema,
    partSizeBytes: z.number().int().positive(),
    totalParts: z.number().int().positive(),
    status: UploadSessionStatusSchema,
    createdAt: DateTimeSchema,
    expiresAt: DateTimeSchema,
  })
  .openapi("UploadSession", { description: "上传会话（服务端只登记元数据；分片状态以对象存储 ListParts 为准）" });

export const DuplicateHintSchema = z
  .object({
    fileId: UuidSchema,
    name: z.string(),
    sizeBytes: z.number().int().min(0),
    uploadedBy: UuidSchema,
    uploadedAt: DateTimeSchema,
  })
  .openapi("DuplicateHint", { description: "同内容哈希的既有文件提示（用户确认后可继续上传，不做强阻断）" });

export const UploadCreateResponseSchema = z
  .object({
    file: FileSchema,
    upload: UploadSessionSchema.nullable().openapi({
      description: "上传会话；附件域秒传复用命中时 = null（无需传分片，直接把 file.id 挂到日报 / 问题等对象）",
    }),
    reused: z.boolean().openapi({
      description: "是否复用了同项目既有的同内容附件（2026-10-12 口径）：true = 未新建文件、未建会话（file = 既有文件）；任务成果上传（带 taskId 等归属）恒 false",
    }),
    duplicateHint: DuplicateHintSchema.nullable(),
  })
  .openapi("UploadCreateResponse", { description: "发起上传结果：新建 / 追加版本返回上传会话；附件域命中同内容既有文件则秒传复用（reused=true、upload=null）" });

export const UploadPartsBodySchema = z
  .object({
    partNumbers: z.array(z.number().int().min(1).max(10000)).min(1).max(1000),
  })
  .openapi("UploadPartsBody", { description: "批量获取分片预签名 URL（首传与断点续传共用；续传前先查会话状态拿缺失分片）" });

export const UploadPartUrlSchema = z
  .object({
    partNumber: z.number().int().min(1).max(10000),
    url: z.string().openapi({ description: "预签名 PUT URL（浏览器直传对象存储，api 不代理大文件流量）" }),
    expiresAt: DateTimeSchema,
  })
  .openapi("UploadPartUrl");

export const UploadPartsResponseSchema = z
  .object({
    uploadId: UuidSchema,
    partSizeBytes: z.number().int().positive(),
    parts: z.array(UploadPartUrlSchema),
    expiresAt: DateTimeSchema,
  })
  .openapi("UploadPartsResponse");

export const UploadSessionViewSchema = UploadSessionSchema.extend({
  uploadedPartNumbers: z.array(z.number().int()).openapi({ description: "已上传分片（来自对象存储 ListParts）" }),
  missingPartNumbers: z.array(z.number().int()).openapi({ description: "缺失分片（断点续传只补这些）" }),
}).openapi("UploadSessionView");

export const UploadCompleteBodySchema = z
  .object({
    contentHash: Sha256Schema.openapi({ description: "完成时回传；与 init 提供值或服务端计算的实际字节 SHA-256 不一致返回 422 FILE_HASH_MISMATCH" }),
  })
  .openapi("UploadCompleteBody");

export const UploadAbortResponseSchema = z.object({ upload: UploadSessionSchema }).openapi("UploadAbortResponse");

export const UploadCompleteResponseSchema = z
  .object({
    file: FileSchema,
    version: FileVersionSchema,
    changeRequest: ChangeRequestSchema.nullable().openapi({ description: "intent=change 时的变更记录；version 意图为空" }),
  })
  .openapi("UploadCompleteResponse");

export const FileVersionListResponseSchema = z
  .object({
    items: z.array(FileVersionSchema),
    total: z.number().int().min(0),
  })
  .openapi("FileVersionListResponse");

export const FileFinalizeBodySchema = z.object({ version: VersionSchema }).openapi("FileFinalizeBody", {
  description: "定档（锁版）：至少存在 1 个版本；定档后不可覆盖或替换；**挂接任务的文件定档时，同事务把该任务一并定档**（Push 249：任务定档后不支持任何修改，见 Task.finalizedAt / 409 TASK_FINALIZED）",
});

export const FileRollbackBodySchema = z
  .object({
    toVersionId: UuidSchema.openapi({ description: "回溯目标版本" }),
    reason: z.string().min(1).max(1000).openapi({ description: "回溯原因（留痕；定档 / 已变更文件按变更流处理）" }),
    version: VersionSchema,
  })
  .openapi("FileRollbackBody", { description: "回溯生成新版本（不删除历史版本；定档后回溯走变更、申请即通过）" });

export const FileRollbackResponseSchema = z
  .object({
    file: FileSchema,
    version: FileVersionSchema,
    changeRequest: ChangeRequestSchema.nullable(),
  })
  .openapi("FileRollbackResponse");

export const FileRecycleBodySchema = z
  .object({
    version: VersionSchema,
    reason: z.string().max(1000).optional(),
  })
  .openapi("FileRecycleBody", { description: "移入回收站（任意状态可删；默认保留 30 天，可恢复）" });

export const FileRestoreBodySchema = z.object({ version: VersionSchema }).openapi("FileRestoreBody");

/** 文件改名（Push 226 续）：只改元数据 name（不动内容 / 版本链 / 定档状态）；乐观锁 version 必传。 */
export const FileRenameBodySchema = z
  .object({
    name: z.string().min(1).max(255).openapi({ example: "机械设计图纸-v3.docx", description: "新文件名（原文件名的元数据改名：不动内容 / 版本链 / 定档状态）" }),
    version: VersionSchema,
  })
  .openapi("FileRenameBody", { description: "文件改名（Push 226 续：文件名可修改；乐观锁 version 必传；回收站中的文件不可改名）" });

export const FilePurgeBodySchema = z
  .object({
    version: VersionSchema,
    reason: z.string().max(1000).optional(),
  })
  .openapi("FilePurgeBody", { description: "彻底删除（仅管理员；对象与元数据一并清理，操作留痕）" });

export const FilePurgeResponseSchema = z.object({ fileId: UuidSchema, purgedAt: DateTimeSchema }).openapi("FilePurgeResponse");

export const FileDownloadUrlResponseSchema = z
  .object({
    url: z.string().openapi({ description: "短时签名下载地址（写查看 / 下载审计；对象存储禁止匿名读取）" }),
    fileName: z.string(),
    sizeBytes: z.number().int().min(0),
    expiresAt: DateTimeSchema,
  })
  .openapi("FileDownloadUrlResponse");

/**
 * 预览目标（渲染通道口径 · wmj 评审定案 · PR #103）：按前端渲染方式定义，不按文件格式；格式差异由产物 MIME 表达。
 * 缓存键 = versionId + pipelineVersion + target；不同版本即使内容哈希相同也隔离（迁移 0067）。
 * pdf = PDF 直签通道（原件 application/pdf + inline 短时签名，前端 PDF.js 本地分页渲染；不创建 DocServer 会话；Office 改走查看器通道 viewer、不产转换产物；CAD 接入另见 ADR-035，不占既有图片/PDF 通道）；image = 图片查看器通道（图片直出、图片型兜底、含矢量 SVG 产物）；structured = 结构化表格渲染通道（一期未启用时 xlsx 走 pdf）。
 */
export const PREVIEW_TARGETS = ["pdf", "image", "structured"] as const;
export const PreviewTargetSchema = z.enum(PREVIEW_TARGETS).openapi("PreviewTarget", {
  description:
    "预览目标（渲染通道口径 · 转换产物通道）：pdf PDF 直签通道（原件 application/pdf + inline，前端 PDF.js 本地渲染；Office 改走查看器通道、不占 target；CAD 模型资源另按 ADR-035 接入，不占本通道） / image 图片查看器通道（图片直出、图片型兜底、含矢量 SVG 产物） / structured 结构化表格渲染通道（一期未启用时 xlsx 走 pdf 通道）；ONLYOFFICE 查看器通道不产生转换产物、不占用 target（见 FilePreviewResponse.viewer）",
});

/**
 * 预览状态（D2-05：未就绪与失败都是 200 语义，不是失败响应 —— 前端据此置占位 / 降级「请下载」）。
 * ready 时 url 必填；not_ready / failed 时 url 为空。
 */
export const PREVIEW_STATUSES = ["ready", "not_ready", "failed"] as const;
export const PreviewStatusSchema = z.enum(PREVIEW_STATUSES).openapi("PreviewStatus", {
  description:
    "预览状态：ready 产物就绪（附短时签名 URL）或 viewer 入口可用（CAD 的模型转换状态另由 CadJob 判定） / not_ready 尚未生成（产物通道幂等补投、按版本、管线版本和通道去重） / failed 转换失败（记原因并降级「请下载」）",
});

/** 预览查询参数（A4-06：任意历史版本可预览与下载；缺省 = 当前版本；不属于该文件 / 不存在 → 404）。 */
export const FilePreviewQuerySchema = z
  .object({
    versionId: UuidSchema.optional().openapi({ description: "指定历史版本（A4-06）；缺省 = 当前版本；不属于该文件 / 不存在 → 404" }),
    /**
     * 是否把本次送达计入预览审计。缺省 / false = 只取缩略图或预览签名，不写操作记录；
     * true = 用户已点开具体图片 / 文件，由前端显式请求一次预览并写一条 `action=preview`。
     */
    recordView: z.enum(["true", "false"]).optional().openapi({
      description: "是否记录用户实际查看（缺省 false）；缩略图挂载必须省略，点开具体预览时传 true",
    }),
  })
  .openapi("FilePreviewQuery");

/**
 * 在线查看器（ONLYOFFICE 查看通道 · S1 契约切片 · 安全定稿 §3.2）：ready 且走查看器通道时下发（无转换产物）。
 * docServerUrl + document（含 permissions）/ editorConfig + token 直接交给 DocServer 的 api.js 初始化 DocEditor（查看器行为面）；
 * Push 258 错层修正：permissions 嵌 document 下发 —— ONLYOFFICE api.js 只认 document.permissions（顶层会被忽略、按默认值渲染）。
 * download 保持可见（业务口径「原本的下载不要隐藏」）：图标原样保留，点击由浮层透明命中层接管 → 我方原文件下载链 + download 审计。
 * 安全语义在服务端受控端点（document.url 无存储凭证；鉴权 = DocServer outbox Bearer JWT，随 S3 落地）。
 */
export const PREVIEW_VIEWER_KINDS = ["onlyoffice", "cad"] as const;
export const PreviewViewerKindSchema = z.enum(PREVIEW_VIEWER_KINDS).openapi("PreviewViewerKind", {
  description: "在线查看器类型：onlyoffice 文档 / cad 独立 CAD 模型入口（当前 STEP）",
});

/**
 * 查看器权限段（行为面；Push 258 起 download=true —— 业务口径「原本的下载不要隐藏」，图标保持可见、点击由前端
 * 透明命中层接管 → 原文件下载链；R1 不变量在受控端点侧，不靠该字段）。
 * Push 258 错层修正：本段必须嵌在 document 内随 token 一并签发（ONLYOFFICE api.js 只认 document.permissions；
 * 发在顶层会被忽略、按默认值渲染）。签发侧（server）与组装侧（前端文档里）逐字一致，否则 DocServer 拒 -20。
 */
export const PreviewViewerPermissionsSchema = z
  .object({
    edit: z.boolean(),
    download: z.boolean(),
    print: z.boolean(),
    comment: z.boolean(),
    chat: z.boolean(),
    fillForms: z.boolean(),
    protect: z.boolean(),
  })
  .openapi("PreviewViewerPermissions");

/** 查看器文档段（DocEditor 配置的 document；url = 受控预览内容端点绝对 URL —— C1：同源生成、不信任 Host 头）。 */
export const PreviewViewerDocumentSchema = z
  .object({
    title: z.string().openapi({ description: "文档标题（展示用；取文件名）" }),
    url: z.string().openapi({ description: "受控预览内容端点绝对 URL（DocServer 视角；无存储凭证；浏览器直取 401、外网入口 404）" }),
    fileType: z.string().openapi({ description: "文件类型（扩展名小写，如 docx / xlsx / pptx）" }),
    key: z.string().openapi({ description: "文档 key（内容哈希派生：同内容同 key —— DocServer 侧会话与缓存复用；S3 起生效）" }),
    permissions: PreviewViewerPermissionsSchema.openapi({
      description: "查看器权限段（Push 258 起嵌 document —— ONLYOFFICE 只认该位置；download 保持可见、点击由前端命中层接管 → 原文件下载链）",
    }),
  })
  .openapi("PreviewViewerDocument");

/** 查看器编辑器配置段（固定只读：mode = view；D1：不做在线编辑）。 */
export const PreviewViewerEditorConfigSchema = z
  .object({
    mode: z.literal("view").openapi({ description: "固定 view（只读；与 permissions 行为面 + 服务端受控端点双重约束）" }),
    lang: z.string().openapi({ description: "界面语言（如 zh-CN）" }),
    user: z.object({ id: z.string(), name: z.string() }).openapi({ description: "会话标识（展示用；查看会话不落用户审计 —— 审计在签发查看器配置时点）" }),
  })
  .openapi("PreviewViewerEditorConfig");

/** 在线查看器配置（FilePreviewResponse.viewer；token = 对 documentType / document（含 permissions）/ editorConfig 逐字签发 + 服务端 iat / exp）。 */
export const OnlyOfficePreviewViewerSchema = z
  .object({
    kind: z.literal("onlyoffice"),
    docServerUrl: z.string().openapi({ description: "DocServer 基址（前端据此加载 /web-apps/apps/api/documents/api.js 初始化 DocEditor；服务端配置下发）" }),
    documentType: z.enum(["word", "cell", "slide"]).openapi("PreviewViewerDocumentType", {
      description: "文档大类（word 文档 / cell 表格 / slide 演示；PDF 不走 ONLYOFFICE，改由前端 PDF.js 本地渲染）",
    }),
    document: PreviewViewerDocumentSchema,
    editorConfig: PreviewViewerEditorConfigSchema,
    token: z.string().openapi({ description: "查看器 JWT（HS256；载荷 = documentType / document（含 permissions）/ editorConfig 逐字签发 + iat / exp；浏览器持有 —— 泄漏面仅只读会话，取原文件依赖服务端端点鉴权）" }),
  })
  .openapi("OnlyOfficePreviewViewer", {
    description: "在线查看器配置（ONLYOFFICE 查看通道；Office / 文本族专用，PDF 与图片走短时签名 URL）",
  });

export const PreviewViewerSchema = z.discriminatedUnion("kind", [OnlyOfficePreviewViewerSchema, CadPreviewViewerSchema])
  .openapi("PreviewViewer", { description: "只读查看入口；Office 与 CAD 按 kind 区分，CAD 转换进度独立显示。" });

/** 预览状态响应（GET /files/{id}/preview；D2-04 短时签名 + 禁止匿名读取、D2-05 失败降级、D2-06 缓存、D2-07 审计）。 */
export const FilePreviewResponseSchema = z
  .object({
    fileId: UuidSchema,
    versionId: UuidSchema.nullable().openapi({ description: "本次预览对应版本（查询参数指定时随指定，缺省 = 当前版本）；无版本为空" }),
    status: PreviewStatusSchema,
    target: PreviewTargetSchema.nullable().openapi({
      description: "已就绪转换产物的目标（渲染通道）；查看器通道 / 未就绪 / 失败为空 —— 查看器就绪以 viewer 判定",
    }),
    viewer: PreviewViewerSchema.nullable().openapi({
      description: "在线查看器配置（仅 ready 且走查看器通道时非空；与 url 互斥 —— 查看器通道无转换产物；S3 起签发）",
    }),
    url: z
      .string()
      .nullable()
      .openapi({ description: "短时签名预览地址（仅 ready；未就绪 / 失败为空；对象存储禁止匿名读取）" }),
    expiresAt: DateTimeSchema.nullable().openapi({ description: "签名到期时间；未就绪 / 失败为空" }),
    pipelineVersion: z
      .string()
      .nullable()
      .openapi({ description: "产物对应的转换管线版本（服务端配置下发，如 PREVIEW_PIPELINE_VERSION；客户端不解析，用于缓存失效 / 排障）；未生成过为空" }),
    reason: z
      .string()
      .max(500)
      .nullable()
      .openapi({ description: "失败原因（仅 failed，最长 500 字；D2-05 记录原因，不影响下载）" }),
    generatedAt: DateTimeSchema.nullable().openapi({ description: "产物生成时间（仅 ready；对齐 preview_artifacts.generated_at —— 查看时间在审计里）" }),
  })
  .openapi("FilePreviewResponse", {
    description: "文件预览状态与短时签名地址 / 查看器配置；产物通道 not_ready 时幂等补投，前端轮询至 ready / failed。ONLYOFFICE / CAD 查看入口为 ready + viewer 非空、url 为空；CAD 的完整模型就绪由独立 CadJob 判定。",
  });

export const FileListQuerySchema = z
  .object({
    "filter[nodeId]": UuidSchema.optional(),
    "filter[taskId]": UuidSchema.optional(),
    "filter[status]": z.string().optional().openapi({ description: "文件状态（多值逗号分隔）：draft / final / changed / archived / recycled" }),
    "filter[docType]": z.string().optional().openapi({ description: "成果文件类型（多值逗号分隔，取值见 DocType 字典）" }),
    "filter[uploadedBy]": UuidSchema.optional(),
    q: z.string().optional().openapi({ description: "关键字（文件名）" }),
    page: PageQuerySchema.shape.page,
    limit: PageQuerySchema.shape.limit,
    sort: SortQuerySchema.optional(),
  })
  .openapi("FileListQuery");

export const FileLibraryItemSchema = FileSchema.extend({
  createdByName: z.string().nullable().openapi({
    description:
      "上传人姓名（users.display_name）；停用 / 离职历史账号仍返回姓名；用户行不存在时为空，前端回退用户 id",
  }),
}).openapi("FileLibraryItem");

export const FileListResponseSchema = paginated(FileLibraryItemSchema).openapi("FileListResponse");
