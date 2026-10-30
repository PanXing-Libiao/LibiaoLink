import { z } from "../zod.ts";
import { DateOnlySchema, DateTimeSchema, PageQuerySchema, UuidSchema, VersionSchema } from "../common/conventions.ts";
import { StageKeySchema } from "../common/dicts.ts";
import { IssueCategoryListSchema, IssueCategorySchema } from "./issues.ts";
import { CalendarDayKindSchema } from "./calendar.ts";
import { FilePhotoRefSchema } from "./files.ts";
import { ProjectMemberRoleSchema } from "./projects.ts";

/**
 * 日报契约（M6-01 / M6-02 · A3-01 / A3-02 / A3-03 / A3-04 / A3-08 / A3-09）。
 * 口径来源：系统功能书.md A3「日报与问题跟踪」；前端功能需求.md §3.8 A21（接口提案）；
 * 技术设计v0.2 §2.2 / §11.1；技术设计v0.3 §3.7（M6-01 / M6-02）。表口径见 database/migrations/0023_daily_reports_issues.sql（本批修订见 0041）。
 * Push 215（业务口径 2026-09-28 / 29 · 代做 wmj 线，请 wmj 复核）：① 一人一项目一天一条 → 同人同项目同日可多条（uq 唯一约束与
 * 409 REPORT_ALREADY_EXISTS 随批删除）；② 关联任务 taskIds / taskTitles → 关联阶段 stageKeys / stageNames（Push 198「关联任务改关联阶段」
 * 口径落地，A3-08 回写停用）；③ 问题归类单值 issueCategory → 多值 issueCategories（「现场发现问题」非空 ≥1 项）；
 * ④ 现场工作附图 / 当前问题附图落 file_links(object_type=report, kind=onsite|issue)：提交生成问题时问题图转挂到问题
 * （file_links(object_type=issue)），问题侧可独立增删；⑤ 处理时限 due_at 删除（A3-14 / 规则 A03 / ADR-026 随批下线）；
 * ⑥ 新增 DELETE 成对删除（删日报 = 连其全部问题）。
 * 一期口径（差异登记）：补填 = 对过去日期首次提交；不做版本历史（「补填保留原始提交记录」以状态 + 提交时间表达，随迭代再评估）。
 * Push 243（业务口径 2026-10-08 · 代做 wmj 线，请 wmj 复核）：① 新增**内联问题清单** `issues`（`ReportIssueDraft` 1~N 条）—— 一次填报可带多条问题（一天可有多个类型的问题，
 * 提交后逐条生成独立问题记录，便于追溯）；与旧单问题字段（foundIssue / issueCategories / suggestion / issuePhotoFileIds）互斥（二选一）；
 * ② 「问题处理人 / 责任人」= `ownerId`（显式给出落责任人；缺省仍按归类自动分派责任部门，A3-12）。
 */

/** 日报状态（A3-02）：draft / submitted / supplement。 */
export const DAILY_REPORT_STATES = ["draft", "submitted", "supplement"] as const;

export const DailyReportStateSchema = z.enum(DAILY_REPORT_STATES).openapi("DailyReportState", {
  description: "日报状态（A3-02）：draft 草稿 / submitted 已提交 / supplement 补填（对过去日期首次提交）",
});

/** 日报写入状态（提交 / 暂存）：补填状态由服务端按日期推导，不接受客户端直接指定。 */
export const DailyReportWriteStateSchema = z.enum(["draft", "submitted"]).openapi("DailyReportWriteState", {
  description: "日报写入状态（A3-02）：draft 暂存草稿 / submitted 提交（对过去日期提交 = 服务端自动标记 supplement）",
});

/** 一条日报（A3-01 表单字段 + 系统字段）。 */
export const DailyReportSchema = z
  .object({
    id: UuidSchema,
    projectId: UuidSchema,
    authorId: UuidSchema,
    authorName: z.string().nullable().openapi({ description: "提交人显示名（A3-01 系统字段）" }),
    date: DateOnlySchema.openapi({ description: "填报日期（A3-01「时间」）" }),
    state: DailyReportStateSchema,
    headcount: z.number().int().min(0).nullable().openapi({ description: "今日施工人数（A3-03 默认带上次填报值，可修改）" }),
    doneWork: z.string().openapi({ description: "当日完成工作（A3-04 必填；原「回写关联任务进展」（A3-08）随关联单位改阶段停用 —— Push 215）" }),
    plan: z.string().nullable().openapi({ description: "明日计划" }),
    foundIssue: z.string().nullable().openapi({ description: "现场发现问题（非空 → 提交时自动生成问题，A3-09 幂等）" }),
    issueCategories: z.array(IssueCategorySchema).openapi({ description: "问题归类（多值，C9 十项；「现场发现问题」非空时 ≥1 项，A3-04）" }),
    suggestion: z.string().nullable().openapi({ description: "解决方案或建议" }),
    stageKeys: z.array(StageKeySchema).max(9).openapi({ description: "关联阶段（A3-03 多选，九阶段字典；原「关联任务」Push 198 改口径，A3-08 回写停用）" }),
    stageNames: z.array(z.string()).openapi({ description: "关联阶段名（与 stageKeys 同下标，查 STAGE_NAMES 展示）" }),
    photos: z.array(FilePhotoRefSchema).openapi({ description: "现场工作附图（file_links(object_type=report, kind=onsite)）；可增删" }),
    issuePhotos: z.array(FilePhotoRefSchema).openapi({ description: "当前问题附图（file_links(object_type=report, kind=issue)）；提交生成问题时转挂到问题（file_links(object_type=issue)），转挂后此处为空" }),
    submittedAt: DateTimeSchema.nullable().openapi({ description: "提交时间（草稿为空）" }),
    createdAt: DateTimeSchema,
    updatedAt: DateTimeSchema,
    version: VersionSchema,
  })
  .openapi("DailyReport", { description: "一条日报（A3-01 全字段 + 系统字段）" });

export type DailyReport = z.infer<typeof DailyReportSchema>;

/** 日报内联问题草稿（Push 243 · 业务口径「日报填写问题时新增 添加问题按钮 … 提交后各自独立便于追溯」+「新加可以选择 问题处理人/责任人」）：
 *  一次填报可携带多条问题（1~N），提交时逐条生成独立问题记录 —— 各自归类 / 处理人 / 解决方案 / 附图。
 *  `ownerId` 缺省（undefined / null）= 按归类自动分派责任部门（A3-12）；显式给出 = 直接落该责任人为处理人。 */
export const ReportIssueDraftSchema = z
  .object({
    title: z.string().min(1).max(2000).openapi({ description: "问题描述（原文；问题记录标题超 500 字截短落库）" }),
    categories: IssueCategoryListSchema.openapi({ description: "问题归类（多值 ≥1 项；C9 十项）" }),
    ownerId: UuidSchema.nullable().optional().openapi({ description: "问题处理人 / 责任人（缺省 / null = 按归类自动分派责任部门）" }),
    solution: z.string().min(1).max(2000).optional().openapi({ description: "解决方案或建议（落问题的 solution）" }),
    photoFileIds: z.array(UuidSchema).max(30).optional().openapi({ description: "该问题附图（文件 id；提交时直接挂到生成的问题）" }),
  })
  .openapi("ReportIssueDraft", { description: "日报内联问题草稿（一次填报 1~N 条；提交时逐条生成问题记录）" });

export type ReportIssueDraft = z.infer<typeof ReportIssueDraftSchema>;

/** 旧单问题字段是否携带内容（Push 243 · issues 二选一的判定基准）：null / 空数组 / 空串 / 全空白都算未携带 —— 「清空旧字段」的正常写法不该被判成二选一冲突。 */
function legacyIssueInputUsed(value: {
  foundIssue?: string | null;
  issueCategories?: readonly string[] | null;
  suggestion?: string | null;
  issuePhotoFileIds?: readonly string[];
}): boolean {
  return (
    (value.foundIssue ?? "").trim() !== "" ||
    (value.issueCategories ?? []).length > 0 ||
    (value.suggestion ?? "").trim() !== "" ||
    (value.issuePhotoFileIds ?? []).length > 0
  );
}

/** 新报一天的日报（A3-01 / A3-02 · Push 215：同人同项目同日可多条 —— 原「一人一天一条」唯一约束与 409 已删除，同日多条按创建时间区分）。 */
export const DailyReportCreateBodySchema = z
  .object({
    date: DateOnlySchema.openapi({ description: "填报日期（当天或过去日期 = 补填；未来日期 400）" }),
    state: DailyReportWriteStateSchema.default("submitted").openapi({ description: "draft 暂存 / submitted 提交（缺省 submitted）" }),
    headcount: z.number().int().min(0).max(100000).optional().openapi({ description: "今日施工人数（缺省为空）" }),
    doneWork: z.string().min(1).max(2000).openapi({ description: "当日完成工作（A3-04 必填）" }),
    plan: z.string().min(1).max(2000).optional().openapi({ description: "明日计划" }),
    foundIssue: z.string().min(1).max(2000).optional().openapi({ description: "现场发现问题（非空时问题归类必填；提交时自动生成问题，A3-09）" }),
    issueCategories: z.array(IssueCategorySchema).min(1).max(10).optional().openapi({ description: "问题归类（多值，C9 十项；「现场发现问题」非空时必填 ≥1 项）" }),
    suggestion: z.string().min(1).max(2000).optional().openapi({ description: "解决方案或建议" }),
    stageKeys: z.array(StageKeySchema).max(9).optional().openapi({ description: "关联阶段（A3-03 多选，九阶段字典；须为合法阶段键）" }),
    photoFileIds: z.array(UuidSchema).max(30).optional().openapi({ description: "现场工作附图（文件 id 整体替换；须为本项目已上传文件，上限 30 张）" }),
    issuePhotoFileIds: z.array(UuidSchema).max(30).optional().openapi({ description: "当前问题附图（文件 id 整体替换；提交生成问题时转挂到问题）" }),
    issues: z.array(ReportIssueDraftSchema).min(1).max(50).optional().openapi({ description: "内联问题清单（1~N 条；与 foundIssue / issueCategories / suggestion / issuePhotoFileIds 互斥 —— 二选一）" }),
  })
  .superRefine((value, ctx) => {
    // Push 243：新口径（issues 非空）与旧单问题字段**按内容**互斥 —— 显式 null / 空数组（清空旧字段的正常写法）不算旧字段内容。
    if (value.issues !== undefined && value.issues.length > 0) {
      if (legacyIssueInputUsed(value)) {
        ctx.addIssue({ code: "custom", message: "issues 与 foundIssue / issueCategories / suggestion / issuePhotoFileIds 互斥（新口径用 issues）", path: ["issues"] });
      }
      return;
    }
    if (value.foundIssue !== undefined && value.foundIssue.trim().length > 0 && (value.issueCategories === undefined || value.issueCategories.length === 0)) {
      ctx.addIssue({ code: "custom", message: "「现场发现问题」非空时问题归类必填（A3-04）", path: ["issueCategories"] });
    }
  })
  .openapi("DailyReportCreateBody", { description: "新报一天日报（草稿 / 提交）；补填由服务端按日期推导" });

export type DailyReportCreateBody = z.infer<typeof DailyReportCreateBodySchema>;

/** 编辑已存在的日报行（草稿继续编辑 / 已提交修改 / 提交草稿）：乐观锁 version。date 不可改（填报日期不变）。 */
export const DailyReportUpdateBodySchema = z
  .object({
    version: VersionSchema,
    state: DailyReportWriteStateSchema.optional().openapi({ description: "draft → submitted = 提交草稿（已提交行不允许退回草稿）" }),
    headcount: z.number().int().min(0).max(100000).nullable().optional().openapi({ description: "今日施工人数（null = 清空）" }),
    doneWork: z.string().min(1).max(2000).optional(),
    plan: z.string().min(1).max(2000).nullable().optional().openapi({ description: "明日计划（null = 清空）" }),
    foundIssue: z.string().min(1).max(2000).nullable().optional().openapi({ description: "现场发现问题（null = 清空；已生成问题不随清空撤回）" }),
    issueCategories: z.array(IssueCategorySchema).max(10).nullable().optional().openapi({ description: "问题归类整体替换（多值；null / 空数组 = 清空 —— 「现场发现问题」非空时不可清空）" }),
    suggestion: z.string().min(1).max(2000).nullable().optional(),
    stageKeys: z.array(StageKeySchema).max(9).optional().openapi({ description: "关联阶段整体替换（缺省 = 不改）" }),
    photoFileIds: z.array(UuidSchema).max(30).optional().openapi({ description: "现场工作附图整体替换（缺省 = 不改；空数组 = 清空）" }),
    issuePhotoFileIds: z.array(UuidSchema).max(30).optional().openapi({ description: "当前问题附图整体替换（缺省 = 不改；空数组 = 清空）；该日报已生成问题时转挂目标 = 该问题" }),
    issues: z.array(ReportIssueDraftSchema).max(50).optional().openapi({ description: "内联问题清单整体替换（草稿 → 提交时逐条生成问题；空数组 = 清空；非空时与 foundIssue / issueCategories / suggestion / issuePhotoFileIds 互斥）" }),
  })
  .superRefine((value, ctx) => {
    // Push 243：同 create —— issues 非空时与旧单问题字段（按内容）互斥；issues = [] 是「清空清单」的正常写法。
    if (value.issues !== undefined && value.issues.length > 0) {
      if (legacyIssueInputUsed(value)) {
        ctx.addIssue({ code: "custom", message: "issues 与 foundIssue / issueCategories / suggestion / issuePhotoFileIds 互斥（新口径用 issues）", path: ["issues"] });
      }
      return;
    }
    if (value.foundIssue !== undefined && value.foundIssue !== null && value.foundIssue.trim().length > 0 && (value.issueCategories === undefined || value.issueCategories === null || value.issueCategories.length === 0)) {
      ctx.addIssue({ code: "custom", message: "「现场发现问题」非空时问题归类必填（A3-04）", path: ["issueCategories"] });
    }
  })
  .openapi("DailyReportUpdateBody", { description: "编辑日报（乐观锁 version；date 不可改）" });

export type DailyReportUpdateBody = z.infer<typeof DailyReportUpdateBodySchema>;

/** 日报删除响应（业务口径 2026-09-28「任意删除谁都会导致双方都删除，因为他们本质是同一个日报」· Push 213）：删日报 = 连它派生的全部问题。 */
export const DailyReportDeleteResponseSchema = z
  .object({
    id: UuidSchema,
    deleted: z.literal(true),
    cascadedIssueIds: z.array(UuidSchema).openapi({ description: "连带删除的问题（删日报 = 连它派生的全部问题）" }),
  })
  .openapi("DailyReportDeleteResponse", { description: "日报删除（成对删除派生问题）" });

/** 日报列表查询（A21）：按日期区间 / 状态 / 提交人筛选 + 分页；默认按日期倒序。 */
export const DailyReportListQuerySchema = z
  .object({
    "filter[dateFrom]": DateOnlySchema.optional().openapi({ description: "日期下界（含）" }),
    "filter[dateTo]": DateOnlySchema.optional().openapi({ description: "日期上界（含）" }),
    "filter[state]": z.string().optional().openapi({ description: "状态多值逗号分隔：draft / submitted / supplement" }),
    "filter[authorId]": UuidSchema.optional().openapi({ description: "提交人" }),
    page: PageQuerySchema.shape.page,
    limit: PageQuerySchema.shape.limit,
  })
  .openapi("DailyReportListQuery", { description: "日报列表查询（日期区间 / 状态 / 提交人 + 分页；日期倒序）" });

export const DailyReportListResponseSchema = z
  .object({
    items: z.array(DailyReportSchema),
    page: z.number().int().min(1),
    limit: z.number().int().min(1),
    total: z.number().int().min(0),
  })
  .openapi("DailyReportListResponse", { description: "日报列表（项目内成员可见）" });

/** 日报同步到项目群（2026-10-27 / 2026-10-28 修订）：PM 确认后落 outbox notify.group；文字先发「日报已送达」及具体日报纯文字深链，worker 再追加动态海报。 */
export const DailyReportGroupSyncResponseSchema = z
  .object({
    reportId: UuidSchema,
    version: VersionSchema.openapi({ description: "发起同步时的日报版本；同版本重复点击由 outbox dedupeKey 幂等收口" }),
    queued: z.literal(true).openapi({ description: "已受理并写入 outbox；最终送达状态以通知投递记录为准" }),
    message: z.string().openapi({ example: "已提交同步", description: "面向用户的受理提示（不宣称已送达）" }),
  })
  .openapi("DailyReportGroupSyncResponse", { description: "日报同步项目群受理结果（机器人文字 + 海报由 worker 异步发送）" });

/** 日报当日查询（A7-01 汇总 / A7-05 应填未填共用）：日期缺省 = 今天（Asia/Shanghai）；未来日期 400（与 A3-04 同口径）。 */
export const DailyReportDayQuerySchema = z
  .object({
    date: DateOnlySchema.optional().openapi({ description: "业务日期 YYYY-MM-DD；缺省 = 今天（Asia/Shanghai）；未来日期 400" }),
  })
  .openapi("DailyReportDayQuery", { description: "日报当日视图查询（汇总 / 应填未填共用；缺省今天）" });

export type DailyReportDayQuery = z.infer<typeof DailyReportDayQuerySchema>;

/** 名册成员当日填报状态（A7-05 一行）：名册是应填范围，state 为 null = 当日未填报。 */
export const DailyReportRosterEntrySchema = z
  .object({
    userId: UuidSchema,
    username: z.string().nullable().openapi({ description: "登录名 / 工号" }),
    displayName: z.string().nullable().openapi({ description: "显示名" }),
    roleInProject: ProjectMemberRoleSchema,
    reportId: UuidSchema.nullable().openapi({ description: "当日日报 id（同日多条：有已提交取已提交，否则取一条草稿）；未填报为 null" }),
    state: DailyReportStateSchema.nullable().openapi({ description: "当日日报状态；null = 未填报（draft 草稿未提交，仍计「应填未填」；同日多条取提交优先）" }),
    submittedAt: DateTimeSchema.nullable().openapi({ description: "提交时间（草稿 / 未填报为 null）" }),
    reminderSentAt: DateTimeSchema.nullable().openapi({
      description:
        "当日 A01 漏填提醒成功发送时刻（站内信 / 企微单聊任一成功即非空；null = 未提醒或全部失败；A7-05 已提醒标记 · M5-06-3）",
    }),
  })
  .openapi("DailyReportRosterEntry", { description: "名册成员当日填报状态（A7-05 应填未填的一行）" });

/** 应填未填清单（A7-05）：项目名册 × 工作日历 × 当日未提交 —— 非工作日整列为空；`reminderSentAt` 回读发送归档（M5-06-3）。 */
export const DailyReportMissingResponseSchema = z
  .object({
    date: DateOnlySchema,
    isWorkday: z.boolean().openapi({ description: "当日是否工作日（日历例外优先，D5-03 同口径）" }),
    dayKind: CalendarDayKindSchema,
    dayName: z.string().nullable().openapi({ description: "日历例外名称（如「国庆节」）；无例外为 null" }),
    memberCount: z.number().int().min(0).openapi({ description: "项目名册人数" }),
    submittedCount: z.number().int().min(0).openapi({ description: "当日已提交（submitted / supplement）人数" }),
    draftCount: z.number().int().min(0).openapi({ description: "仅有草稿（未提交）的人数" }),
    missingCount: z.number().int().min(0).openapi({ description: "应填未填人数（非工作日为 0）" }),
    members: z.array(DailyReportRosterEntrySchema).openapi({ description: "项目名册全员（按名册顺序）" }),
    missingUserIds: z.array(UuidSchema).openapi({ description: "应填未填人 id（非工作日为空数组；顺序同名册）" }),
  })
  .openapi("DailyReportMissing", { description: "当日应填未填清单（A7-05：项目成员 × 工作日历 × 当日未提交）" });

/** 当日日报汇总（A7-01）：替代人工「填写后添加到日报」—— 按项目 × 日期聚合已提交条目；A02 每日 19:00 群推送的正文数据面。 */
export const DailyReportSummaryResponseSchema = z
  .object({
    date: DateOnlySchema,
    isWorkday: z.boolean(),
    dayKind: CalendarDayKindSchema,
    dayName: z.string().nullable(),
    entryCount: z.number().int().min(0).openapi({ description: "已提交（submitted / supplement）条目数" }),
    draftCount: z.number().int().min(0).openapi({ description: "草稿条目数（不计入汇总正文）" }),
    headcountTotal: z.number().int().min(0).openapi({ description: "今日施工人数合计（未填按 0 计）" }),
    issueCount: z.number().int().min(0).openapi({ description: "「现场发现问题」非空的条目数" }),
    entries: z.array(DailyReportSchema).openapi({ description: "已提交条目（提交时间升序，同刻按创建时间、作者 id 兜底；同日多条逐条列出）" }),
  })
  .openapi("DailyReportSummary", { description: "当日日报汇总（A7-01）" });

