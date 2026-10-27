import { z } from "../zod.ts";
import { DateOnlySchema, DateTimeSchema, UuidSchema, VersionSchema } from "../common/conventions.ts";
import { ProjectStatusSchema, StageKeySchema, StageStatusSchema } from "../common/dicts.ts";

/**
 * 项目总结（2026-10-27 · 项目空间卡片入口）。
 * 事实包（facts）由服务端脚本从任务 / 日报 / 问题 / 文件 / 变更 / 阶段读取并按固定规则判定；
 * 叙述（narrative）可交给 OpenAI 兼容通道润色，也可由规则模板直接生成。
 * AI 不得改事实、不得判断问题是否解决、不得编造统计数字；项目经理保存草稿并确认后才成为已确认总结。
 * 命名刻意避开既有的 ProjectSummarySchema（项目总览四格）与 GET /projects/{id}/summary。
 */

export const PROJECT_SUMMARY_STATUSES = ["draft", "confirmed", "superseded"] as const;
export const ProjectSummaryStatusSchema = z
  .enum(PROJECT_SUMMARY_STATUSES)
  .openapi("ProjectSummaryStatus", { description: "总结状态：draft 草稿 / confirmed 已确认 / superseded 被后续确认版本替代" });

export const PROJECT_SUMMARY_ISSUE_RESOLUTIONS = ["resolved", "unresolved", "needs_evidence"] as const;
export const ProjectSummaryIssueResolutionSchema = z
  .enum(PROJECT_SUMMARY_ISSUE_RESOLUTIONS)
  .openapi("ProjectSummaryIssueResolution", {
    description: "问题结论（脚本判定）：resolved 已完成且有解决方案与关闭记录 / unresolved 未解决或处理中 / needs_evidence 已完成但解决方案或关闭记录缺失",
  });

export const PROJECT_SUMMARY_TIMELINE_KINDS = ["project", "stage", "task", "report", "issue", "change", "file"] as const;
export const ProjectSummaryTimelineKindSchema = z
  .enum(PROJECT_SUMMARY_TIMELINE_KINDS)
  .openapi("ProjectSummaryTimelineKind", { description: "过程时间线事件类型" });

export const PROJECT_SUMMARY_GAP_KINDS = [
  "unresolved_issue",
  "issue_evidence",
  "overdue_task",
  "unassigned_task",
  "missing_deliverable",
  "status_mismatch",
  "stale_reports",
  "missing_baseline",
] as const;
export const ProjectSummaryGapKindSchema = z
  .enum(PROJECT_SUMMARY_GAP_KINDS)
  .openapi("ProjectSummaryGapKind", {
    description:
      "遗漏 / 待整改类型：unresolved_issue 未解决问题 / issue_evidence 关闭证据缺失 / overdue_task 逾期任务 / unassigned_task 未分配任务 / missing_deliverable 成果缺件 / status_mismatch 项目状态与事实不一致 / stale_reports 日报长期未更新 / missing_baseline 项目基础数据缺失",
  });

export const ProjectSummarySeveritySchema = z
  .enum(["high", "medium", "low"])
  .openapi("ProjectSummarySeverity", { description: "遗漏项风险级别（由固定规则给出）" });

/** AI / 模板生成的六段叙述。纯文本；不得复述或重算统计数字，必须服从 facts 中的脚本结论。 */
export const ProjectSummaryNarrativeSchema = z
  .object({
    overview: z.string().trim().min(1).max(4000).openapi({ description: "项目概况" }),
    process: z.string().trim().min(1).max(4000).openapi({ description: "项目全过程概述" }),
    issues: z.string().trim().min(1).max(4000).openapi({ description: "问题及处理情况概述" }),
    result: z.string().trim().min(1).max(4000).openapi({ description: "项目结果概述" }),
    handover: z.string().trim().min(1).max(4000).openapi({ description: "后续接手安排概述" }),
    risks: z.string().trim().min(1).max(4000).openapi({ description: "风险与建议概述" }),
  })
  .openapi("ProjectSummaryNarrative", { description: "项目总结六段叙述；不重复统计数字，项目经理可编辑后保存为草稿" });

export const ProjectSummaryProjectFactsSchema = z
  .object({
    id: UuidSchema,
    code: z.string(),
    name: z.string(),
    customer: z.string().nullable(),
    region: z.string(),
    projectType: z.string(),
    stageKey: StageKeySchema,
    stageName: z.string(),
    status: ProjectStatusSchema,
    statusName: z.string(),
    managerNames: z.array(z.string()).max(200),
    description: z.string().nullable(),
    createdAt: DateTimeSchema,
    archivedAt: DateTimeSchema.nullable(),
  })
  .openapi("ProjectSummaryProjectFacts", { description: "项目主数据快照（不含联系方式）" });

export const ProjectSummaryCountsSchema = z
  .object({
    tasksTotal: z.number().int().min(0),
    tasksDone: z.number().int().min(0),
    tasksActive: z.number().int().min(0),
    tasksPending: z.number().int().min(0),
    tasksOverdue: z.number().int().min(0),
    tasksUnassigned: z.number().int().min(0),
    reportsTotal: z.number().int().min(0),
    reportsDraft: z.number().int().min(0),
    reportsSubmitted: z.number().int().min(0),
    reportsSupplement: z.number().int().min(0),
    lastReportDate: DateOnlySchema.nullable(),
    issuesTotal: z.number().int().min(0),
    issuesResolved: z.number().int().min(0),
    issuesUnresolved: z.number().int().min(0),
    issuesInProgress: z.number().int().min(0),
    issuesClosedWithoutEvidence: z.number().int().min(0),
    filesTotal: z.number().int().min(0),
    filesDraft: z.number().int().min(0),
    filesFinal: z.number().int().min(0),
    filesChanged: z.number().int().min(0),
    filesArchived: z.number().int().min(0),
    changesTotal: z.number().int().min(0),
    deliverablesRequired: z.number().int().min(0),
    deliverablesFinalized: z.number().int().min(0),
    deliverablesMissing: z.number().int().min(0),
    stagesTotal: z.number().int().min(0),
    stagesDone: z.number().int().min(0),
    stagesActive: z.number().int().min(0),
  })
  .openapi("ProjectSummaryCounts", { description: "固定规则统计；AI 只读不得改写" });

export const ProjectSummaryStageFactSchema = z
  .object({
    stageKey: StageKeySchema,
    name: z.string(),
    seq: z.number().int().positive(),
    status: StageStatusSchema,
    nodeTotal: z.number().int().min(0),
    nodeDone: z.number().int().min(0),
    taskTotal: z.number().int().min(0),
    taskDone: z.number().int().min(0),
    plannedStart: DateOnlySchema.nullable(),
    plannedEnd: DateOnlySchema.nullable(),
    actualStart: DateOnlySchema.nullable(),
    actualEnd: DateOnlySchema.nullable(),
  })
  .openapi("ProjectSummaryStageFact", { description: "阶段推进快照" });

export const ProjectSummaryTimelineEventSchema = z
  .object({
    date: DateTimeSchema,
    kind: ProjectSummaryTimelineKindSchema,
    title: z.string().max(500),
    detail: z.string().max(2000),
    actorNames: z.array(z.string()).max(50),
  })
  .openapi("ProjectSummaryTimelineEvent", { description: "项目过程时间线（脚本按时间正序汇总）" });

export const ProjectSummaryIssueFactSchema = z
  .object({
    id: UuidSchema,
    title: z.string().max(500),
    state: z.enum(["open", "in_progress", "done"]),
    stateName: z.string(),
    categories: z.array(z.string()).max(20),
    raisedAt: DateOnlySchema,
    reporterName: z.string().nullable(),
    ownerName: z.string().nullable(),
    ownerDepartment: z.string().nullable(),
    solution: z.string().nullable(),
    closedAt: DateTimeSchema.nullable(),
    updatedAt: DateTimeSchema,
    resolution: ProjectSummaryIssueResolutionSchema,
    followUpOwner: z.string(),
  })
  .openapi("ProjectSummaryIssueFact", { description: "问题及脚本判定结论；followUpOwner = 责任人 → 责任部门 → 项目经理 → 项目部" });

export const ProjectSummaryGapSchema = z
  .object({
    id: z.string().max(200),
    kind: ProjectSummaryGapKindSchema,
    severity: ProjectSummarySeveritySchema,
    title: z.string().max(500),
    detail: z.string().max(2000),
    owner: z.string().max(200),
    action: z.string().max(2000),
  })
  .openapi("ProjectSummaryGap", { description: "遗漏 / 待整改项（固定规则生成，含建议接手人）" });

export const ProjectSummaryHandoverSchema = z
  .object({
    owner: z.string().max(200),
    items: z.array(z.string().max(2000)).max(100),
  })
  .openapi("ProjectSummaryHandover", { description: "按接手人分组的待办（由 gaps / 未解决问题按规则合并）" });

export const ProjectSummaryDataQualitySchema = z
  .object({
    severity: ProjectSummarySeveritySchema,
    message: z.string().max(2000),
  })
  .openapi("ProjectSummaryDataQuality", { description: "数据口径提醒；不改变业务状态" });

export const ProjectSummaryFactsSchema = z
  .object({
    generatedAt: DateTimeSchema,
    dataCutoff: DateTimeSchema,
    project: ProjectSummaryProjectFactsSchema,
    counts: ProjectSummaryCountsSchema,
    stages: z.array(ProjectSummaryStageFactSchema).max(50),
    timeline: z.array(ProjectSummaryTimelineEventSchema).max(200),
    issues: z.array(ProjectSummaryIssueFactSchema).max(500),
    gaps: z.array(ProjectSummaryGapSchema).max(500),
    handover: z.array(ProjectSummaryHandoverSchema).max(100),
    dataQuality: z.array(ProjectSummaryDataQualitySchema).max(50),
    evidence: z
      .object({
        tasks: z.number().int().min(0),
        reports: z.number().int().min(0),
        issues: z.number().int().min(0),
        files: z.number().int().min(0),
        changes: z.number().int().min(0),
        stages: z.number().int().min(0),
      })
      .openapi("ProjectSummaryEvidenceCounts", { description: "本次汇总读取的证据条数" }),
  })
  .openapi("ProjectSummaryFacts", { description: "脚本事实包；统计、问题结论、缺件和接手人全部在此定稿" });

export const ProjectSummaryViewSchema = z
  .object({
    id: UuidSchema,
    projectId: UuidSchema,
    dataCutoff: DateTimeSchema,
    status: ProjectSummaryStatusSchema,
    facts: ProjectSummaryFactsSchema,
    narrative: ProjectSummaryNarrativeSchema,
    engine: z.string().max(200).openapi({ description: "生成引擎：openai-compatible:<model> / rule-template" }),
    model: z.string().max(200).nullable(),
    promptVersion: z.string().max(100),
    fallbackReason: z.string().max(1000).nullable().openapi({ description: "AI 不可用或校验失败而回落规则模板的原因；成功 = null" }),
    generatedBy: UuidSchema,
    generatedByName: z.string().nullable(),
    generatedAt: DateTimeSchema,
    confirmedBy: UuidSchema.nullable(),
    confirmedByName: z.string().nullable(),
    confirmedAt: DateTimeSchema.nullable(),
    version: VersionSchema,
    createdAt: DateTimeSchema,
    updatedAt: DateTimeSchema,
    canEdit: z.boolean().openapi({ description: "当前访问者是否可保存 / 确认（项目经理或系统管理员，服务端裁决）" }),
  })
  .openapi("ProjectSummaryView", { description: "项目总结（事实包 + 叙述 + 生成 / 确认审计信息）" });

export const ProjectSummaryLatestResponseSchema = z
  .object({
    item: ProjectSummaryViewSchema.nullable(),
    canEdit: z.boolean().openapi({ description: "当前访问者是否有权生成 / 编辑总结；即使 item:null 也可据此显示生成入口" }),
  })
  .openapi("ProjectSummaryLatestResponse", { description: "最新项目总结：优先最近草稿（便于继续编辑），无草稿时取最新已确认版本；无记录 = item:null；canEdit 由服务端裁决" });

export const ProjectSummaryUpdateBodySchema = z
  .object({
    version: VersionSchema,
    narrative: ProjectSummaryNarrativeSchema,
  })
  .openapi("ProjectSummaryUpdateBody", { description: "保存叙述草稿；事实包不可修改，乐观锁 version 防止覆盖他人编辑" });

export const ProjectSummaryConfirmBodySchema = z
  .object({
    version: VersionSchema,
  })
  .openapi("ProjectSummaryConfirmBody", { description: "确认发布草稿；同项目上一版 confirmed 与其余草稿自动转 superseded" });

export type ProjectSummaryLatestResponse = z.infer<typeof ProjectSummaryLatestResponseSchema>;
export type ProjectSummaryTimelineEvent = z.infer<typeof ProjectSummaryTimelineEventSchema>;
export type ProjectSummaryNarrative = z.infer<typeof ProjectSummaryNarrativeSchema>;
export type ProjectSummaryView = z.infer<typeof ProjectSummaryViewSchema>;
export type ProjectSummaryFacts = z.infer<typeof ProjectSummaryFactsSchema>;
export type ProjectSummaryGap = z.infer<typeof ProjectSummaryGapSchema>;
export type ProjectSummaryIssueFact = z.infer<typeof ProjectSummaryIssueFactSchema>;
