import { z } from "../zod.ts";

/**
 * 页面级 Excel 导出契约（日报记录 / 问题追踪 / 干系人）。
 *
 * 本功能只导出页面当前可见列，不提供扩展字段。Sheet 与列 key 是前后端共享白名单：
 * 请求体按 Sheet 绑定对应列枚举，未知列由契约拒绝；同一 Sheet / 同一列重复也在请求层拒绝。
 */
export const PAGE_EXPORT_SHEET_KEYS = ["reports", "issues", "stakeholders"] as const;

export const PageExportSheetKeySchema = z.enum(PAGE_EXPORT_SHEET_KEYS).openapi("PageExportSheetKey", {
  description: "页面导出 Sheet：reports = 日报记录 / issues = 问题追踪 / stakeholders = 干系人",
});

export const PAGE_EXPORT_SHEET_LABELS: Record<(typeof PAGE_EXPORT_SHEET_KEYS)[number], string> = {
  reports: "日报记录",
  issues: "问题追踪",
  stakeholders: "干系人",
};

export const PAGE_EXPORT_COLUMN_KEYS = {
  reports: ["date", "author", "stageNames", "doneWork", "plan", "photos"],
  issues: ["raisedAt", "title", "categories", "owner", "solution", "photos", "state"],
  stakeholders: ["name", "phone", "wechat", "email", "title", "company", "createdBy", "role"],
} as const;

export const PAGE_EXPORT_COLUMN_LABELS = {
  reports: {
    date: "时间",
    author: "填写者",
    stageNames: "关联阶段",
    doneWork: "当日完成工作",
    plan: "明日计划",
    photos: "现场工作附图",
  },
  issues: {
    raisedAt: "日期",
    title: "问题描述",
    categories: "问题归类",
    owner: "问题处理人 / 责任人",
    solution: "解决方案或建议",
    photos: "问题附图",
    state: "问题是否处理",
  },
  stakeholders: {
    name: "干系人姓名",
    phone: "电话 / WhatsApp",
    wechat: "微信",
    email: "邮箱 Email",
    title: "职务 / 责任板块",
    company: "所属公司",
    createdBy: "填写者",
    role: "干系人角色",
  },
} as const satisfies Record<(typeof PAGE_EXPORT_SHEET_KEYS)[number], Record<string, string>>;

export const ReportPageExportColumnSchema = z
  .enum(PAGE_EXPORT_COLUMN_KEYS.reports)
  .openapi("ReportPageExportColumn", { description: "日报记录导出列 key（仅页面当前可见列）" });

export const IssuePageExportColumnSchema = z
  .enum(PAGE_EXPORT_COLUMN_KEYS.issues)
  .openapi("IssuePageExportColumn", { description: "问题追踪导出列 key（仅页面当前可见列）" });

export const StakeholderPageExportColumnSchema = z
  .enum(PAGE_EXPORT_COLUMN_KEYS.stakeholders)
  .openapi("StakeholderPageExportColumn", { description: "干系人导出列 key（仅页面当前可见列）" });

const ReportPageExportSheetSchema = z
  .object({
    sheet: z.literal("reports"),
    columns: z.array(ReportPageExportColumnSchema).min(1).max(PAGE_EXPORT_COLUMN_KEYS.reports.length),
  })
  .strict();

const IssuePageExportSheetSchema = z
  .object({
    sheet: z.literal("issues"),
    columns: z.array(IssuePageExportColumnSchema).min(1).max(PAGE_EXPORT_COLUMN_KEYS.issues.length),
  })
  .strict();

const StakeholderPageExportSheetSchema = z
  .object({
    sheet: z.literal("stakeholders"),
    columns: z.array(StakeholderPageExportColumnSchema).min(1).max(PAGE_EXPORT_COLUMN_KEYS.stakeholders.length),
  })
  .strict();

export const PageExportSheetSelectionSchema = z
  .discriminatedUnion("sheet", [ReportPageExportSheetSchema, IssuePageExportSheetSchema, StakeholderPageExportSheetSchema])
  .openapi("PageExportSheetSelection", {
    description: "一个页面的导出列选择；columns 只选择字段，Excel 列序固定取系统目录，未知列 / 空列 / 重复列拒绝",
  });

const PAGE_EXPORT_SHEET_SET: ReadonlySet<string> = new Set(PAGE_EXPORT_SHEET_KEYS);

/** Sheet 最多 3 个；请求列只表达选择，导出列序固定取系统目录；重复 Sheet / 重复列在请求层直接 400。 */
export const PageExportSheetsSchema = z
  .array(PageExportSheetSelectionSchema)
  .min(1)
  .max(PAGE_EXPORT_SHEET_KEYS.length)
  .superRefine((sheets, context) => {
    const seenSheets = new Set<string>();
    for (let index = 0; index < sheets.length; index += 1) {
      const item = sheets[index];
      if (item === undefined) continue;
      if (!PAGE_EXPORT_SHEET_SET.has(item.sheet) || seenSheets.has(item.sheet)) {
        context.addIssue({ code: "custom", path: [index, "sheet"], message: "Sheet 不可重复" });
      }
      seenSheets.add(item.sheet);
      const seenColumns = new Set<string>();
      for (let columnIndex = 0; columnIndex < item.columns.length; columnIndex += 1) {
        const column = item.columns[columnIndex];
        if (column === undefined) continue;
        if (seenColumns.has(column)) {
          context.addIssue({ code: "custom", path: [index, "columns", columnIndex], message: "列不可重复" });
        }
        seenColumns.add(column);
      }
    }
  })
  .openapi("PageExportSheets", { description: "1～3 个页面的导出列选择（列序由系统目录固定；重复 Sheet / 重复列拒绝）" });

export const PageExportRequestSchema = z
  .object({
    origin: z
      .string()
      .trim()
      .max(2048)
      .optional()
      .openapi({ description: "当前站点 origin；用于把附图单元格链接到项目文件视图，服务端只接受 http(s) origin" }),
    sheets: PageExportSheetsSchema,
  })
  .strict()
  .openapi("PageExportRequest", { description: "页面级中文 Excel 导出请求（POST；只导出勾选页面的勾选列，列序固定）" });

/** Catalog 列项：allowed=false 时前端禁用勾选，POST 若携带该列由服务端 403。 */
export const PageExportCatalogColumnSchema = z
  .object({
    key: z.string().min(1).max(64),
    label: z.string().min(1).max(80),
    allowed: z.boolean(),
  })
  .openapi("PageExportCatalogColumn", { description: "可导出列（含当前账号字段权限）" });

export const PageExportPreviewCellSchema = z
  .union([z.string().max(500), z.number(), z.null()])
  .openapi("PageExportPreviewCell", { description: "导出预览单元格；长文本由服务端截断，附图显示为图片数量" });

export const PageExportPreviewRowSchema = z
  .record(z.string().min(1).max(64), PageExportPreviewCellSchema)
  .openapi("PageExportPreviewRow", { description: "一条中文页面导出预览行（键为列 key）" });

export const PageExportCatalogSheetSchema = z
  .object({
    key: PageExportSheetKeySchema,
    label: z.string().min(1).max(80),
    allowed: z.boolean().openapi({ description: "当前账号是否可读取该页面；false 时导出请求 403" }),
    rowCount: z.number().int().nonnegative().openapi({ description: "当前项目该页面的记录数（用于预计行数提示）" }),
    defaultColumns: z.array(z.string()).max(16).openapi({ description: "默认勾选列（已按当前账号列权限过滤）" }),
    columns: z.array(PageExportCatalogColumnSchema).max(16),
    previewRows: z.array(PageExportPreviewRowSchema).max(3).openapi({ description: "按当前账号列权限生成的中文预览行（最多 3 条）" }),
  })
  .openapi("PageExportCatalogSheet", { description: "一个可导出页面的目录项（含中文实时预览）" });

export const PageExportCatalogResponseSchema = z
  .object({ sheets: z.array(PageExportCatalogSheetSchema).max(PAGE_EXPORT_SHEET_KEYS.length) })
  .openapi("PageExportCatalogResponse", { description: "页面导出目录（按当前账号权限下发列可用性）" });

export const PAGE_EXPORT_PRESET_LIMIT = 20;
export const PAGE_EXPORT_PRESET_NAME_MAX = 20;
export const PAGE_EXPORT_PRESETS_REVISION_KEY = "pageExportPresets";

/** 导出方案按账号保存在 user_preferences.prefs.pageExportPresets，不绑定项目。 */
export const PageExportPresetSchema = z
  .object({
    id: z.string().trim().min(1).max(64).openapi({ description: "方案 id（前端生成，建议 pe- 前缀）" }),
    name: z.string().trim().min(1).max(PAGE_EXPORT_PRESET_NAME_MAX).openapi({ description: "方案名称（≤ 20 字）" }),
    sheets: PageExportSheetsSchema,
  })
  .openapi("PageExportPreset", { description: "页面导出方案（Sheet + 列选择；导出列顺序由系统目录固定）" });

export type PageExportSheetKey = z.infer<typeof PageExportSheetKeySchema>;
export type ReportPageExportColumn = z.infer<typeof ReportPageExportColumnSchema>;
export type IssuePageExportColumn = z.infer<typeof IssuePageExportColumnSchema>;
export type StakeholderPageExportColumn = z.infer<typeof StakeholderPageExportColumnSchema>;
export type PageExportSheetSelection = z.infer<typeof PageExportSheetSelectionSchema>;
export type PageExportRequest = z.infer<typeof PageExportRequestSchema>;
export type PageExportPreviewCell = z.infer<typeof PageExportPreviewCellSchema>
export type PageExportPreviewRow = z.infer<typeof PageExportPreviewRowSchema>
export type PageExportCatalogColumn = z.infer<typeof PageExportCatalogColumnSchema>;
export type PageExportCatalogSheet = z.infer<typeof PageExportCatalogSheetSchema>;
export type PageExportCatalogResponse = z.infer<typeof PageExportCatalogResponseSchema>;
export type PageExportPreset = z.infer<typeof PageExportPresetSchema>;
