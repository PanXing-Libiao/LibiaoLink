import { z } from "../zod.ts";
import { UuidSchema } from "../common/conventions.ts";
import { StageKeySchema, TaskDisplayStatusSchema } from "../common/dicts.ts";
import { IssueCategorySchema, IssueStateSchema } from "./issues.ts";

/**
 * 仪表盘聚合读面（B4 · M7-02）：服务端一次算好项目进度 / 任务状态 / 交付时间，
 * 前端不再逐项目拉任务后聚合；问题与词频图按视图懒加载对应聚合端点。
 *
 * 可见性口径与服务端 PermissionService.projectScope 一致：只统计当前会话可见、未进回收站的项目；
 * 任务只统计未软删行。归档项目仍按项目列表既有口径计入（与前端原逐项目聚合一致）。
 */

/** 项目进度：九阶段 + 未分组 × 五档；行顺序固定为契约 STAGE_KEYS 序，未分组只在有任务时落末行。 */
export const DashboardProgressRowSchema = z
  .object({
    key: z.union([StageKeySchema, z.literal("ungrouped")]).openapi({ description: "阶段 key；ungrouped = 临时任务（无阶段）" }),
    label: z.string().openapi({ description: "阶段中文展示名；ungrouped 行为空串，由前端 i18n 补文案" }),
    isUngrouped: z.boolean(),
    counts: z.array(z.number().int().min(0)).length(5).openapi({ description: "进度五档计数（0 / 0.25 / 0.5 / 0.75 / 1，与前端 DASHBOARD_BINS 同序）" }),
    total: z.number().int().min(0),
  })
  .openapi("DashboardProgressRow");

export const DashboardProgressSchema = z
  .object({
    rows: z.array(DashboardProgressRowSchema),
    totalTasks: z.number().int().min(0),
  })
  .openapi("DashboardProgress", { description: "阶段 × 进度五档分布（九阶段固定存在；未分组行按需出现）" });

/** 任务状态展示序：进行中 / 已完成 / 待开始 / 提前完成 / 已延期（0 条状态不下发）。 */
export const DASHBOARD_STATUS_ORDER = ["active", "done", "pending", "early_done", "overdue"] as const;

export const DashboardStatusSliceSchema = z
  .object({
    status: TaskDisplayStatusSchema,
    count: z.number().int().min(0),
  })
  .openapi("DashboardStatusSlice");

export const DashboardStatusSchema = z
  .object({
    slices: z.array(DashboardStatusSliceSchema),
    totalTasks: z.number().int().min(0),
  })
  .openapi("DashboardStatus", { description: "任务五态分布（只含 count > 0 的状态）" });

/** 交付结果展示序：按时交付 / 逾期已交付 / 逾期未交付。 */
export const DASHBOARD_DELIVERY_ORDER = ["on_time", "late_delivered", "late_pending"] as const;

export const DashboardDeliverySchema = z
  .object({
    counts: z.array(z.number().int().min(0)).length(3).openapi({ description: "三档计数，顺序 = 按时交付 / 逾期已交付 / 逾期未交付" }),
    total: z.number().int().min(0).openapi({ description: "已交付合计（三档之和，按时率分母）" }),
    onTimeRate: z.number().int().min(0).max(100).nullable().openapi({ description: "按时率百分比取整；分母 0 时为 null" }),
    pendingCount: z.number().int().min(0).openapi({ description: "未到交付节点任务数（进行中 / 待开始 / 完成但未判定）" }),
  })
  .openapi("DashboardDelivery");

export const DashboardTaskSummarySchema = z
  .object({
    progress: DashboardProgressSchema,
    status: DashboardStatusSchema,
    delivery: DashboardDeliverySchema,
  })
  .openapi("DashboardTaskSummary");

export const DashboardProjectProgressSchema = z
  .object({
    projectId: UuidSchema,
    projectName: z.string(),
    managerNames: z.array(z.string().nullable()).openapi({ description: "项目经理显示名（与 managerIds 同下标；取不到姓名该位为 null）" }),
    summary: DashboardTaskSummarySchema,
  })
  .openapi("DashboardProjectProgress");

export const DashboardProgressResponseSchema = z
  .object({
    all: DashboardTaskSummarySchema.openapi({ description: "全部可见项目合计" }),
    byProject: z.array(DashboardProjectProgressSchema).openapi({ description: "逐项目统计；顺序与项目列表默认排序一致（createdAt desc、seqNo asc）" }),
  })
  .openapi("DashboardProgressResponse", { description: "仪表盘任务聚合读面（项目进度 / 任务状态 / 交付时间）" });

export const DashboardIssueCountSchema = z
  .object({
    state: IssueStateSchema,
    category: IssueCategorySchema,
    count: z.number().int().min(0),
  })
  .openapi("DashboardIssueCount");

export const DashboardIssuesSchema = z
  .object({
    states: z.array(IssueStateSchema).openapi({ description: "有数据的问题状态（展示序：done / in_progress / open；0 条不出现）" }),
    categories: z.array(IssueCategorySchema).openapi({ description: "有数据的问题归类（契约 C9 原序；0 条不出现）" }),
    counts: z.array(DashboardIssueCountSchema).openapi({ description: "状态 × 归类计数；一条问题多归类时每个归类各计一次" }),
    totalIssues: z.number().int().min(0).openapi({ description: "问题总数（明细行数口径；与柱高合计可能不同）" }),
  })
  .openapi("DashboardIssues");

export const DashboardIssueProjectSchema = z
  .object({
    projectId: UuidSchema,
    issues: DashboardIssuesSchema,
  })
  .openapi("DashboardIssueProject");

export const DashboardIssuesResponseSchema = z
  .object({
    all: DashboardIssuesSchema,
    byProject: z.array(DashboardIssueProjectSchema).openapi({ description: "只含有问题记录的项目；没有问题的项目由前端补空统计" }),
  })
  .openapi("DashboardIssuesResponse", { description: "仪表盘问题分布聚合读面" });

export const DashboardWordSchema = z
  .object({
    word: z.string(),
    count: z.number().int().min(1),
  })
  .openapi("DashboardWord");

export const DashboardChangeWordsSchema = z
  .object({
    words: z.array(DashboardWordSchema).openapi({ description: "核心词频（count 降序、同频按词面排序）" }),
    totalChanges: z.number().int().min(0),
  })
  .openapi("DashboardChangeWords");

export const DashboardWordProjectSchema = z
  .object({
    projectId: UuidSchema,
    words: DashboardChangeWordsSchema,
  })
  .openapi("DashboardWordProject");

export const DashboardChangeWordsResponseSchema = z
  .object({
    all: DashboardChangeWordsSchema,
    byProject: z.array(DashboardWordProjectSchema).openapi({ description: "只含有变更记录的项目；没有变更的项目由前端补空统计" }),
  })
  .openapi("DashboardChangeWordsResponse", { description: "仪表盘变更原因核心词频聚合读面" });

export type DashboardProgress = z.infer<typeof DashboardProgressSchema>;
export type DashboardProgressRow = z.infer<typeof DashboardProgressRowSchema>;
export type DashboardStatus = z.infer<typeof DashboardStatusSchema>;
export type DashboardStatusSlice = z.infer<typeof DashboardStatusSliceSchema>;
export type DashboardDelivery = z.infer<typeof DashboardDeliverySchema>;
export type DashboardTaskSummary = z.infer<typeof DashboardTaskSummarySchema>;
export type DashboardProjectProgress = z.infer<typeof DashboardProjectProgressSchema>;
export type DashboardProgressResponse = z.infer<typeof DashboardProgressResponseSchema>;
export type DashboardIssues = z.infer<typeof DashboardIssuesSchema>;
export type DashboardIssueCount = z.infer<typeof DashboardIssueCountSchema>;
export type DashboardIssuesResponse = z.infer<typeof DashboardIssuesResponseSchema>;
export type DashboardChangeWords = z.infer<typeof DashboardChangeWordsSchema>;
export type DashboardChangeWordsResponse = z.infer<typeof DashboardChangeWordsResponseSchema>;
