/**
 * 内置规则定义与逐字文案模板（M5-01 内核切片 + M5-05 余项 · A 系列 · Push 163）。
 * 逐字基准：docs/rules/R01-R07-内置规则文案.md（R01 ~ R07，需求说明书原文逐字）、
 *   docs/rules/A01-A03-A14-扩展规则文案.md（A01 / A02 / A14 —— 原文未给逐字文案：该文档为建议稿 + 待确认清单）。
 * 口径来源：系统功能书 C2-02 / C2-04 / C2-11 / A6-05 / A7-03 / A7-05、技术设计v0.2 §6.1、ADR-028（时区）。
 * 说明：R01 无通知动作（落点 = 变更生效事务内同事务回写 tasks.change_refs，见 M4-04），故不在引擎规则集内；
 *   其余规则为引擎可执行规则：R02 / R06 事件型（R02 主体 = 任务；R06 主体 = 项目），R03 / R04 / R05 / R07 任务调度型，
 *   A01 / A02 / A14 主体调度型（主体类型见 BUILTIN_RULE_SUBJECT_KINDS）；A03 随处理时限（due_at）删除下线（Push 215 / A3-14）。
 * 变更（M5-03-5 契约段 · 2026-10-14 · ADR-033）：R02 / R07 / A01 / A14 单聊动作渠道 `wecom_app` → `wecom_aibot`（自建应用保留备用 · 回退 = 渠道值回切）；产出接线已随 M5-03-5-4 落地（:aibot 幂等键后缀 + notify.message 消费分流）。
 */
import type { AutomationMessageTemplate, AutomationRule } from "@libiaolink/contracts";
import type { ReplaySubjectKind } from "./automation.rules.js";

/** R01 说明（非引擎规则：无消息文案）。 */
export const R01_NOTE =
  "R01 变更文件自动关联：无通知动作，落点 = 变更生效事务内同事务回写任务变更关联（M4-04 / Push 121）；金标 = 多值命中全部关联 + 重复变更不重复关联。";

/** 逐字文案模板（键 = 动作 template 码；同一文案多渠道各自一条，便于渠道差异化后续扩）。 */
export const BUILTIN_MESSAGE_TEMPLATES: readonly AutomationMessageTemplate[] = [
  {
    code: "R02_INBOX",
    title: "及时添加文件",
    body: "项目：**{项目}**\n{完成人}已点击完成任务，请为项目任务「**{任务描述}**」及时添加成果文件",
  },
  {
    code: "R02_WECOM",
    title: "及时添加文件",
    body: "项目：**{项目}**\n{完成人}已点击完成任务，请为项目任务「**{任务描述}**」及时添加成果文件",
  },
  {
    code: "R03_WECOM",
    title: "任务即将延期提醒",
    body: "项目：**{项目}**\nhello，{任务负责人}，你的任务「**{任务描述}**」还有1天就要截止了，快加加油，尽快追上进度吧！",
  },
  {
    code: "R04_GROUP",
    title: "有新任务已到启动时间",
    body: "项目：**{项目}**\n{任务负责人}你好呀，你的任务「**{任务描述}**」已到启动时间，快查看任务详情吧~今日工作加油",
  },
  {
    code: "R05_WECOM",
    title: "！任务超时提醒",
    body: "项目：**{项目}**\nhello，{任务负责人}，你的任务「**{任务描述}**」已经超时一天了，快加加油，尽快追上进度吧！",
  },
  {
    code: "R06_GROUP",
    title: "叮咚~喜报来啦！",
    body: "项目：**{项目}**\n项目已全部完成，验收交付完毕。大家一起为这份成果喝彩吧",
  },
  {
    code: "R07_APP",
    title: "重点任务提醒",
    body: "{任务负责人}，以下重点任务正在进行中：\n{任务详情}\n请关注并及时推进任务~",
  },
  {
    code: "R07_APP_MERGED",
    title: "重点任务提醒",
    body: "{任务负责人}，以下重点任务正在进行中：\n{任务清单}\n请关注并及时推进任务~",
  },
  {
    code: "A01_INBOX_MERGED",
    title: "请及时填写今日日报",
    body: "你今天还有日报未提交：{项目清单}请尽快填写，辛苦啦！",
  },
  {
    code: "A01_WECOM_MERGED",
    title: "请及时填写今日日报",
    body: "你今天还有日报未提交：{项目清单}请尽快填写，辛苦啦！",
  },
  {
    code: "A02_GROUP",
    title: "日报汇总 | {项目名}（{日期}）",
    body: "今日 {提交人数} 人已提交（应填 {应填人数} 人），发现问题 {问题数} 条。{汇总正文}",
  },
  {
    code: "A08_GROUP",
    title: "大阶段完成通知",
    body: "项目：**{项目}**\n{推进人}已完成大阶段「**{完成阶段}**」，当前项目阶段：**{下一阶段}**。",
  },
  {
    code: "A14_INBOX",
    title: "待办提醒：{待办标题}",
    body: "{提醒对象}，你的待办「{待办标题}」已到提醒时间。{待办内容}",
  },
  {
    code: "A14_APP",
    title: "待办提醒：{待办标题}",
    body: "{提醒对象}，你的待办「{待办标题}」已到提醒时间。{待办内容}",
  },
];
/** 引擎可执行的内置规则定义（R02 ~ R07 任务类；A01 / A02 / A14 / A08 主体类；A03 随处理时限删除下线 · Push 215）；当前仅启用 R02 / R03 / R05，其余 enabled = false（Push 373）。 */
export const BUILTIN_RULES: readonly AutomationRule[] = [
  {
    code: "R02",
    name: "成果文件自动化通知",
    enabled: true,
    trigger: { kind: "event", topic: "task.completed" },
    conditions: [
      { field: "task.deliverable_types", op: "notEmpty" },
      { field: "task.file_count", op: "eq", value: 0 },
    ],
    actions: [
      { kind: "notification", channel: "inbox", recipient: ["task.owner", "project.manager"], template: "R02_INBOX" },
      { kind: "notify", channel: "wecom_aibot", recipient: ["task.owner", "project.manager"], template: "R02_WECOM" },
    ],
    version: 1,
  },
  {
    code: "R03",
    name: "任务即将延期提醒",
    enabled: true,
    trigger: { kind: "schedule", cron: "0 8 * * *", window: "T_MINUS_1", baseField: "task.planned_end" },
    conditions: [{ field: "task.display_status", op: "notIn", value: ["done", "early_done"] }],
    actions: [{ kind: "notify", channel: "wecom_aibot", recipient: "task.owner", template: "R03_WECOM" }],
    version: 1,
  },
  {
    code: "R04",
    name: "任务启动提醒",
    enabled: false,
    trigger: { kind: "schedule", cron: "0 10 * * *", window: "SAME_DAY", baseField: "task.planned_start" },
    conditions: [
      { field: "task.display_status", op: "in", value: ["pending", "active"] },
      { field: "task.actual_start", op: "isNull" },
    ],
    actions: [{ kind: "notify", channel: "wecom_group", recipient: "project.group", template: "R04_GROUP" }],
    version: 1,
  },
  {
    code: "R05",
    name: "任务超时提醒",
    enabled: true,
    trigger: { kind: "schedule", cron: "0 8 * * *", window: "T_PLUS_1", baseField: "task.planned_end" },
    conditions: [{ field: "task.display_status", op: "notIn", value: ["done", "early_done"] }],
    actions: [{ kind: "notify", channel: "wecom_aibot", recipient: ["task.owner", "project.manager"], template: "R05_WECOM" }],
    version: 1,
  },
  {
    code: "R06",
    name: "项目完成喜报",
    enabled: false,
    trigger: { kind: "event", topic: "project.completed" },
    conditions: [{ field: "project.status", op: "eq", value: "done" }],
    actions: [{ kind: "notify", channel: "wecom_group", recipient: "project.group", template: "R06_GROUP" }],
    version: 1,
  },
  {
    code: "R07",
    name: "每周一提醒跟进重要 / 紧急任务",
    enabled: false,
    trigger: { kind: "schedule", cron: "30 9 * * 1", window: "WEEKLY" },
    conditions: [
      { field: "task.display_status", op: "eq", value: "active" },
      // 2026-09-24 定案三档「高 / 中 / 低」（迁移 0031）：R07 命中 = 高 + 中（排除低；等值原「非 不紧急不重要」· wmj 定案 · Push 171）。
      { field: "task.urgency", op: "in", value: ["高", "中"] },
    ],
    actions: [
      { kind: "notify", channel: "wecom_aibot", recipient: "task.owner", template: "R07_APP", groupBy: ["task.owner_id"] },
    ],
    version: 1,
  },
  {
    code: "A01",
    name: "日报应填未填提醒",
    enabled: false,
    trigger: { kind: "schedule", cron: "30 19 * * *", window: "SAME_DAY", baseField: "report.date" },
    conditions: [
      { field: "report.is_workday", op: "eq", value: true },
      { field: "report.submitted", op: "eq", value: false },
    ],
    actions: [
      { kind: "notification", channel: "inbox", recipient: "report.member", template: "A01_INBOX_MERGED", groupBy: ["report.user_id"] },
      { kind: "notify", channel: "wecom_aibot", recipient: "report.member", template: "A01_WECOM_MERGED", groupBy: ["report.user_id"] },
    ],
    version: 1,
  },
  {
    code: "A02",
    name: "日报每日汇总群播报",
    enabled: false,
    trigger: { kind: "schedule", cron: "0 19 * * *", window: "SAME_DAY", baseField: "report.date" },
    conditions: [{ field: "report.entry_count", op: "gt", value: 0 }],
    actions: [{ kind: "notify", channel: "wecom_group", recipient: "project.group", template: "A02_GROUP" }],
    version: 1,
  },
  {
    code: "A08",
    name: "大阶段完成播报",
    enabled: false,
    trigger: { kind: "event", topic: "stage.advanced" },
    conditions: [],
    actions: [{ kind: "notify", channel: "wecom_group", recipient: "project.group", template: "A08_GROUP" }],
    version: 1,
  },
  {
    code: "A14",
    name: "自定义待办提醒",
    enabled: false,
    trigger: { kind: "schedule", cron: "0 9 * * *", window: "SAME_DAY", baseField: "todo.remind_date" },
    conditions: [{ field: "todo.status", op: "ne", value: "done" }],
    actions: [
      { kind: "notification", channel: "inbox", recipient: "rule.members", template: "A14_INBOX" },
      { kind: "notify", channel: "wecom_aibot", recipient: "rule.members", template: "A14_APP" },
    ],
    version: 1,
  },
];

/** 规则码 → 回放主体类型（缺省 task）：A01 日报名册槽位 / A02 项目日报 / A14 待办 / A08 项目阶段（A03 问题随处理时限下线 · Push 215）。 */
export const BUILTIN_RULE_SUBJECT_KINDS: Readonly<Record<string, ReplaySubjectKind>> = {
  R02: "task",
  R03: "task",
  R04: "task",
  R05: "task",
  R06: "project",
  R07: "task",
  A01: "report_slot",
  A02: "project_day",
  A14: "todo",
  A08: "stage",
};

/** 规则码 → 主体类型（未登记的自定义规则按 task 处理 —— 保持 R 系列历史口径）。 */
export function subjectKindOf(ruleCode: string): ReplaySubjectKind {
  return BUILTIN_RULE_SUBJECT_KINDS[ruleCode] ?? "task";
}

/**
 * 模板变量取数口径（变量名 → 字段名候选链，取第一个非空）：
 *   - "@recipient" = 本次实际解析出的收件人名称（A14 的「提醒对象」）；
 *   - 其余 = 主体字段（点分命名空间，由唤醒层注入的实体快照提供）。
 * 候选链全空 = 渲染空串；模板里出现的变量名必须登记在此（见 test/automation-a-series.test.ts 的模板一致性用例）。
 */
export const SUBJECT_TEMPLATE_VARIABLES: Readonly<
  Record<ReplaySubjectKind, Readonly<Record<string, readonly string[]>>>
> = {
  task: {
    "任务描述": ["task.title"],
    "任务详情": ["task.brief"],
    "项目": ["project.label"],
    "完成人": ["task.completed_by_name"],
    "任务负责人": ["task.owner_name", "task.manager_name"],
  },
  project: {
    "项目": ["project.label"],
  },
  report_slot: {
    "项目名": ["project.name"],
  },
  project_day: {
    "项目名": ["project.name"],
    "日期": ["report.date"],
    "提交人数": ["report.entry_count"],
    "应填人数": ["report.headcount_total"],
    "问题数": ["report.issue_count"],
    "汇总正文": ["report.summary_text"],
  },
  todo: {
    "待办标题": ["todo.title"],
    "待办内容": ["todo.content"],
    "提醒对象": ["@recipient"],
  },
  stage: {
    "项目": ["project.label"],
    "完成阶段": ["stage.name"],
    "下一阶段": ["stage.next_name"],
    "推进人": ["stage.advanced_by_name"],
  },
};

/** 合并文案（groupBy 规则）：键 = rule|channel 优先、其次 rule 级。 */
export interface MergedTemplateSpec {
  template: string;
  listVariable: string;
  listField: string;
  /** 多条目连接符（缺省「、」；R07 用换行保持项目 / 任务分行）。 */
  separator?: string;
}

export const MERGED_TEMPLATE_SPECS: Readonly<Record<string, MergedTemplateSpec>> = {
  R07: { template: "R07_APP_MERGED", listVariable: "任务清单", listField: "task.brief", separator: "\n" },
  "A01|inbox": { template: "A01_INBOX_MERGED", listVariable: "项目清单", listField: "project.name" },
  "A01|wecom_app": { template: "A01_WECOM_MERGED", listVariable: "项目清单", listField: "project.name" },
  "A01|wecom_aibot": { template: "A01_WECOM_MERGED", listVariable: "项目清单", listField: "project.name" },
};

/** 合并文案查表：rule|channel 优先、回退 rule 级；无登记 = 不换文案（仅收件人粒度幂等）。 */
export function findMergedSpec(ruleCode: string, channel: string): MergedTemplateSpec | null {
  return MERGED_TEMPLATE_SPECS[ruleCode + "|" + channel] ?? MERGED_TEMPLATE_SPECS[ruleCode] ?? null;
}

/** 模板码 → 模板（未知模板码返回 null，由回放器登记为配置错误）。 */
export function findTemplate(code: string): AutomationMessageTemplate | null {
  return BUILTIN_MESSAGE_TEMPLATES.find((item) => item.code === code) ?? null;
}
