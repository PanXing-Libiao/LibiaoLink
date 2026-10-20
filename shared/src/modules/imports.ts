import { z } from "../zod.ts";
import { DateTimeSchema, UuidSchema } from "../common/conventions.ts";

/**
 * 导入表导入（直连 API 导入 · 业务口径 2026-10-14；前端 Push 316 已接线，服务端本次落地）：
 * - POST /api/v1/project-imports/preview：multipart/form-data（字段 file，.xlsx / .xlsm，≤ 256 MB）
 *   解析导入表 + 口径校验，不写库；返回预览票据（previewId + 有效期）。
 * - POST /api/v1/project-imports/commit：JSON（previewId + 落位确认）→ 单事务建项目并写入全量数据。
 * 已固化口径：完成日期未填 = 不算完成（进度按进行中封顶 75%）；进度五档（0 / 0.25 / 0.5 / 0.75 / 1）；
 * 日期笔误（完成早于开始）照原值导入 + 提醒；任务节点无对应按文件原名导入（阶段外 = 临时任务）；
 * 变更阶段映射：实施 → install、发货 → assembly；账号 = 拼音登录名 + 中文名（测试账号加 -test）显示名；
 * 微盘 / 本地路径文件出「需手动导入」清单（表内嵌图随导入挂日报）；干系人（Push 324）：「干系人」表随导入落台账
 * *（stakeholders + project_stakeholders）—— 导入表含该表直接解析；
 * 公司分类按源表自由写法映射四类（立镖 / 供应商 / 总包单位 / 客户），「填写者」匹配库内账号 = 录入人（匹配不到留空 + 提醒），
 * 「提交时间」→ created_at；两处都没找到「干系人」表 = 本次不导入干系人（info 提醒）。
 * Push 319 追订：变更表「关联」列命中任务描述 → 任务「变更关联」（change_refs）回写；导入的变更没有变更后文件
 *（源文件在微盘）→ 变更读面 fileId / versionId 为空（前端标「变更后文件待补」）；未解决问题（源表没有处理人字段）
 * 默认处理人 = 项目经理（工作台「待我处理」可见）；自动建号仅测试环境需要（正式环境用户目录完整、无需建号）。
 */

/** 导入表导入单文件上限（前端先挡一道，服务端复检同值）。 */
export const IMPORT_MAX_FILE_BYTES = 256 * 1024 * 1024;
/** 预览票据有效期（分钟）：超时提交返回 410 IMPORT_PREVIEW_EXPIRED。 */
export const IMPORT_PREVIEW_TTL_MINUTES = 30;
/** 允许的扩展名（.xls 旧格式不支持，需另存为 .xlsx）。 */
export const IMPORT_ALLOWED_EXTENSIONS = [".xlsx", ".xlsm"] as const;

export const IMPORT_ISSUE_LEVELS = ["error", "warning", "info"] as const;
export const ImportIssueLevelSchema = z.enum(IMPORT_ISSUE_LEVELS).openapi("ImportIssueLevel", {
  description: "提醒等级：error = 阻断（处理完才能导入）/ warning = 照原值导入只提示 / info = 口径说明",
});
export type ImportIssueLevel = z.infer<typeof ImportIssueLevelSchema>;

/** 一条导入提醒（解析与提交共用同一形状；message 由服务端按 Accept-Language 渲染）。 */
export const ImportIssueSchema = z
  .object({
    level: ImportIssueLevelSchema,
    code: z
      .string()
      .min(1)
      .max(60)
      .openapi({ description: "提醒代码（DATE_ORDER / DONE_NO_DATE / PROGRESS_BINNED / MANAGER_FILLED / ACCOUNT_MISSING 等）" }),
    message: z.string().min(1).max(500).openapi({ description: "提醒文案（服务端按 Accept-Language 出中 / 英）" }),
    row: z.number().int().min(1).nullable().openapi({ description: "源表行号（行级提醒才有；null = 全局提醒）" }),
    subject: z.string().max(200).nullable().openapi({ description: "关联对象名（任务名 / 文件名等；可空）" }),
  })
  .openapi("ImportIssue", { description: "导入提醒（level 三档 + 代码 + 文案 + 行号 / 对象名）" });
export type ImportIssue = z.infer<typeof ImportIssueSchema>;

/** 账号落位：isNew = 系统里还没有（测试环境需先在账号体系建号并登录一次；正式环境用户目录完整、不会出现）；false = 已存在，导入时直接挂项目经理 / 负责人。 */
export const ImportAccountSchema = z
  .object({
    name: z.string().min(1).max(80).openapi({ description: "源表姓名（去括注）" }),
    username: z.string().min(1).max(80).openapi({ description: "登录名（拼音全拼；人员注册表口径）" }),
    displayName: z.string().min(1).max(80).openapi({ description: "显示名（测试账号 = 中文名 + -test；既有账号保持原名）" }),
    isNew: z.boolean().openapi({ description: "true = 本次需新建（面板展示「新建」徽标）" }),
  })
  .openapi("ImportAccount", { description: "导入涉及的人员账号（只报告，不在导入里创建账号 —— 缺号仅测试环境需预建；正式环境用户目录完整）" });
export type ImportAccount = z.infer<typeof ImportAccountSchema>;

/** 需手动导入的文件（导入表只写了文件名 / 微盘路径，源文件抓不到）：面板可就地选文件，确认导入后一并上传。 */
export const ImportManualFileKindSchema = z
  .enum(["task", "change_after"])
  .openapi("ImportManualFileKind", {
    description: "手动文件落位：task = 任务表「文件」列（自动挂对应任务）；change_after = 变更表「变更后文件」（有关联任务时同时挂任务）",
  });
export type ImportManualFileKind = z.infer<typeof ImportManualFileKindSchema>;

export const ImportManualImageSchema = z
  .object({
    id: z.string().min(1).max(60).openapi({ description: "稳定标识（manual-<序号>；提交结果据此回传任务 / 变更目标）" }),
    kind: ImportManualFileKindSchema,
    task: z.string().max(200).nullable().openapi({ description: "关联任务 / 变更行（可空）" }),
    name: z.string().min(1).max(300).openapi({ description: "文件名 / 路径（源表原文）" }),
    reason: z.string().min(1).max(200).openapi({ description: "原因（微盘 / 本地路径，需手动上传）" }),
  })
  .openapi("ImportManualImage", { description: "需手动导入的图片 / 文件清单（面板可就地选文件，确认导入后一并上传）" });
export type ImportManualImage = z.infer<typeof ImportManualImageSchema>;

/** 任务节点匹配：matched = 节点库已有（逐字一致）；未匹配按文件原名导入，勾选后补进节点库。 */
export const ImportTaskNodeSchema = z
  .object({
    name: z.string().min(1).max(200).openapi({ description: "节点名（源表原文 / 节点库标题）" }),
    nameEn: z
      .string()
      .max(200)
      .nullable()
      .openapi({ description: "节点英文名（源表英文列 / 节点库 title_en）；源表没英文 = null（面板标「英文名待补」）" }),
    matched: z.boolean().openapi({ description: "是否已在任务节点库（规范化逐字一致）" }),
    inStageScope: z.boolean().openapi({ description: "是否落在阶段范围内（false = 临时任务，不补节点库）" }),
    taskCount: z.number().int().min(0).openapi({ description: "关联任务条数" }),
  })
  .openapi("ImportTaskNode", { description: "任务节点匹配行（预览左栏「任务节点未匹配」清单）" });
export type ImportTaskNode = z.infer<typeof ImportTaskNodeSchema>;

export const ImportFileMetaSchema = z
  .object({
    name: z.string().min(1).max(255).openapi({ description: "上传文件名（原样回显）" }),
    size: z.number().int().min(0).openapi({ description: "文件大小（字节）" }),
  })
  .openapi("ImportFileMeta", { description: "上传文件元信息" });
export type ImportFileMeta = z.infer<typeof ImportFileMetaSchema>;

export const ImportPreviewCountsSchema = z
  .object({
    tasks: z.number().int().min(0),
    reports: z.number().int().min(0),
    changes: z.number().int().min(0),
    changesLinked: z.number().int().min(0).openapi({ description: "变更已关联任务数（「关联」列命中任务描述；其余只存变更记录）" }),
    stakeholders: z
      .number()
      .int()
      .min(0)
      .openapi({ description: "干系人条数（导入表「干系人」表；落 stakeholders + project_stakeholders）" }),
    images: z.number().int().min(0).openapi({ description: "表内嵌图总数（提交时一并入文件库并挂日报）" }),
    imagesManual: z.number().int().min(0),
    accountsNew: z.number().int().min(0),
    nodesNew: z.number().int().min(0),
  })
  .openapi("ImportPreviewCounts", { description: "将写入条数（预览）" });
export type ImportPreviewCounts = z.infer<typeof ImportPreviewCountsSchema>;

export const ImportResultCountsSchema = z
  .object({
    tasks: z.number().int().min(0),
    reports: z.number().int().min(0),
    changes: z.number().int().min(0),
    changesLinked: z.number().int().min(0).openapi({ description: "变更已关联任务数（「关联」列命中任务描述；其余只存变更记录）" }),
    stakeholders: z.number().int().min(0).openapi({ description: "干系人条数（导入表「干系人」表；落 stakeholders + project_stakeholders）" }),
    images: z.number().int().min(0),
    accountsCreated: z.number().int().min(0).openapi({ description: "本次落位账号数（信息性：账号由 SSO 登录创建，这里指识别到的账号数）" }),
    nodesAdded: z.number().int().min(0),
  })
  .openapi("ImportResultCounts", { description: "实际写入条数（完成页复述）" });
export type ImportResultCounts = z.infer<typeof ImportResultCountsSchema>;

export const ImportProjectPlacementSchema = z
  .object({
    code: z.string().min(1).max(64).openapi({ description: "项目编号（源表文件名 [编号] 段；只读回显）" }),
    name: z.string().min(1).max(200).openapi({ description: "项目名（默认取源表名，导入后可改）" }),
    region: z.string().max(64).nullable().openapi({ description: "识别出的地区（标准国家名）；识别不出 = null（面板强制用户选）" }),
    projectType: z.string().max(64).nullable().openapi({ description: "识别出的项目类型（字典码：AIRROB → 飞箱）；识别不出 = null（可留空）" }),
    managerNames: z.array(z.string().max(80)).max(20).openapi({ description: "源表项目经理原文（按全表多数口径补）" }),
  })
  .openapi("ImportProjectPlacement", { description: "项目落位（面板左栏「项目落位」块）" });
export type ImportProjectPlacement = z.infer<typeof ImportProjectPlacementSchema>;

/** 解析预览（不写库）：落位建议 + 各域条数 + 三份清单 + 提醒清单。 */
export const ProjectImportPreviewSchema = z
  .object({
    previewId: UuidSchema.openapi({ description: "预览票据（commit 时原样回传）" }),
    expiresAt: DateTimeSchema.openapi({ description: "票据过期时间（超时 410 IMPORT_PREVIEW_EXPIRED）" }),
    file: ImportFileMetaSchema,
    project: ImportProjectPlacementSchema,
    counts: ImportPreviewCountsSchema,
    accounts: z.array(ImportAccountSchema).max(300),
    imagesManual: z.array(ImportManualImageSchema).max(2000),
    nodes: z.array(ImportTaskNodeSchema).max(2000),
    issues: z.array(ImportIssueSchema).max(5000),
  })
  .openapi("ProjectImportPreview", { description: "导入表导入预览报告（解析不写库；确认后才写入）" });
export type ProjectImportPreview = z.infer<typeof ProjectImportPreviewSchema>;

/** 确认导入入参：落位确认（地区必填）+ 节点补库开关。 */
export const ProjectImportCommitBodySchema = z
  .object({
    previewId: UuidSchema,
    region: z.string().min(1).max(64).openapi({ description: "项目地区（region 字典的码 / 标准国家名；必填）" }),
    projectType: z
      .string()
      .max(64)
      .default("")
      .openapi({ description: "项目类型（projectType 字典的码）；空串 = 未指定（解析按源表关键字给默认，如 AIRROB → 飞箱）" }),
    addMissingNodes: z
      .boolean()
      .default(true)
      .openapi({ description: "是否把未匹配的任务节点补进节点库（只有落在阶段范围内的会补；阶段外按临时任务）" }),
  })
  .openapi("ProjectImportCommitBody", { description: "确认导入（落位确认 + 节点补库开关）" });
export type ProjectImportCommitBody = z.infer<typeof ProjectImportCommitBodySchema>;
export type ProjectImportCommitBodyInput = z.input<typeof ProjectImportCommitBodySchema>;

/** 手动附件回挂变更：前端直传完成后，把文件版本挂到导入变更（变更详情随即可预览 / 下载）。 */
export const ProjectImportManualAttachBodySchema = z
  .object({
    changeId: UuidSchema,
    fileId: UuidSchema,
  })
  .openapi("ProjectImportManualAttachBody", { description: "导入补充附件挂接变更（changeId + 已上传 fileId）" });
export type ProjectImportManualAttachBody = z.infer<typeof ProjectImportManualAttachBodySchema>;

/** 手动文件提交目标：id 对应预览 imagesManual[].id；taskId / changeId 由提交时已写入库的记录回传。 */
export const ImportManualTargetSchema = z
  .object({
    id: z.string().min(1).max(60),
    taskId: UuidSchema.nullable(),
    changeId: UuidSchema.nullable(),
  })
  .openapi("ImportManualTarget", { description: "手动文件落位目标（任务 / 变更；均可空）" });
export type ImportManualTarget = z.infer<typeof ImportManualTargetSchema>;

/** 导入结果（完成页展示 + 提醒复述）。 */
export const ProjectImportResultSchema = z
  .object({
    projectId: UuidSchema,
    code: z.string().min(1).max(64),
    name: z.string().min(1).max(200),
    counts: ImportResultCountsSchema,
    manualTargets: z
      .array(ImportManualTargetSchema)
      .max(2000)
      .default([])
      .openapi({ description: "手动文件落位目标（与预览 imagesManual 同序；前端据此在导入后一并上传）" }),
    issues: z.array(ImportIssueSchema).max(5000).openapi({ description: "完成后复述的提醒清单（照原值导入项与人工待办）" }),
  })
  .openapi("ProjectImportResult", { description: "导入表导入结果（项目已创建 + 各域条数 + 提醒复述）" });
export type ProjectImportResult = z.infer<typeof ProjectImportResultSchema>;
