import { z } from "../zod.ts";

/**
 * 自动化与通知中心（automation 模块）契约 —— 规则模型 / 触发 / 条件 / 动作 / 投递与运行枚举（M5-01 切片）。
 * 口径来源：系统功能书 C2-01 ~ C2-12、技术设计v0.2 §6.1（规则模型：参数化 + 启停，不做可视化编排）/
 *   §6.2（执行保证：幂等执行键 / 调度 / 投递 / 合并免打扰 / 留痕 / 可测试）、
 *   docs/rules/R01-R07-内置规则文案.md（R 系列逐字文案基准）、
 *   docs/rules/A01-A03-A14-扩展规则文案.md（A 系列建议稿 + 待确认清单；A03 随处理时限删除下线 · Push 215）、ADR-028（时区固定 Asia/Shanghai）。
 * 边界：本切片交付「规则模型 + 求值口径 + 回放基准」；规则管理端点（M5-06）、调度 / 补发（M5-02）、
 *   企微与站内信投递（M5-03 / M5-04）由 lan 线接手 —— 端点入契约时以本文件枚举与 schema 为准扩 paths。
 */

/** 规则编码：七条内置（R01~R07）+ A 系列一期三条（A01 应填未填 / A02 日报汇总 / A14 自定义待办）；A03 问题 SLA 升级随处理时限（due_at）删除下线（Push 215）。 */
export const AUTOMATION_RULE_CODES = [
  "R01",
  "R02",
  "R03",
  "R04",
  "R05",
  "R06",
  "R07",
  "A01",
  "A02",
  "A14",
] as const;
export const AutomationRuleCodeSchema = z.enum(AUTOMATION_RULE_CODES).openapi("AutomationRuleCode", {
  description:
    "规则编码：R01~R07 为内置规则（逐字文案基准见 docs/rules/R01-R07-内置规则文案.md）；A01 日报应填未填 / A02 每日 19:00 日报汇总 / A14 自定义待办提醒（一期三条；A03 问题 SLA 随处理时限删除下线 · Push 215）",
});
export type AutomationRuleCode = z.infer<typeof AutomationRuleCodeSchema>;

/** 触发方式：event 事件型（业务事务同事务写 outbox，worker 消费）/ schedule 调度型（cron + 窗口，可补发）。 */
export const RULE_TRIGGER_KINDS = ["event", "schedule"] as const;
export const RuleTriggerKindSchema = z.enum(RULE_TRIGGER_KINDS).openapi("RuleTriggerKind", {
  description: "触发方式：event 事件型（outbox 主题见 RuleEventTopic）/ schedule 调度型（cron 五段 + 窗口）",
});
export type RuleTriggerKind = z.infer<typeof RuleTriggerKindSchema>;

/** 事件型触发可用的 outbox 主题（业务事务同事务写入；新增主题需同步扩本枚举与引擎事件分派）。 */
export const RULE_EVENT_TOPICS = [
  "task.completed",
  "task.updated",
  "task.progress_changed",
  "change.applied",
  "node.completed",
  "stage.advanced",
  "report.submitted",
  "issue.updated",
] as const;
export const RuleEventTopicSchema = z.enum(RULE_EVENT_TOPICS).openapi("RuleEventTopic", {
  description:
    "事件型触发的 outbox 主题：task.completed 任务完成 / task.updated 任务更新 / task.progress_changed 进度变化 / change.applied 变更生效 / node.completed 节点完成 / stage.advanced 大阶段完成 / report.submitted 日报提交 / issue.updated 问题更新",
});
export type RuleEventTopic = z.infer<typeof RuleEventTopicSchema>;

/** 调度窗口：以规则声明的基准日期字段（如任务预计完成日期 / 开始日期）偏移求触发日，窗口键用于幂等。 */
export const RULE_SCHEDULE_WINDOWS = ["T_MINUS_1", "SAME_DAY", "T_PLUS_1", "T_PLUS_3", "WEEKLY"] as const;
export const RuleScheduleWindowSchema = z.enum(RULE_SCHEDULE_WINDOWS).openapi("RuleScheduleWindow", {
  description:
    "调度窗口：T_MINUS_1 基准日前 1 天（R03）/ SAME_DAY 基准日当天（R04 / A01 / A02 / A14）/ T_PLUS_1 基准日后 1 天（R05）/ T_PLUS_3 基准日后 3 天（窗口能力保留；A03 随处理时限删除下线 · Push 215）/ WEEKLY 周窗口（R07，键 = ISO 周）",
});
export type RuleScheduleWindow = z.infer<typeof RuleScheduleWindowSchema>;

/** 条件操作符白名单（引擎只认这一组；新增操作符 = 改契约 + 改求值器 + 补金标）。 */
export const RULE_CONDITION_OPERATORS = [
  "eq",
  "ne",
  "in",
  "notIn",
  "isNull",
  "notNull",
  "gt",
  "gte",
  "lt",
  "lte",
  "eqOffsetDays",
  "containsAny",
  "notEmpty",
] as const;
export const RuleConditionOperatorSchema = z.enum(RULE_CONDITION_OPERATORS).openapi("RuleConditionOperator", {
  description:
    "条件操作符白名单：eq / ne 等值、in / notIn 集合、isNull / notNull 空值、gt / gte / lt / lte 大小、eqOffsetDays 日期与业务日相差 N 天（基准日 = 求值上下文的业务日）、containsAny 数组命中任一（R01 多值口径）、notEmpty 非空（字符串 / 数组）",
});
export type RuleConditionOperator = z.infer<typeof RuleConditionOperatorSchema>;

/** 动作类型：notify 渠道消息（企微 / 邮件）/ notification 站内信（合并免打扰与每日上限由投递层执行）。 */
export const RULE_ACTION_KINDS = ["notify", "notification"] as const;
export const RuleActionKindSchema = z.enum(RULE_ACTION_KINDS).openapi("RuleActionKind", {
  description: "动作类型：notify 渠道消息（channel 指定渠道）/ notification 站内信（C2-11 渠道矩阵一期四渠道）",
});
export type RuleActionKind = z.infer<typeof RuleActionKindSchema>;

/** 投递渠道（C2-11）：企微智能机器人（单聊 · M5-03-5）/ 企微应用消息（备用）/ 企微群机器人 / 站内信 / 邮件基础可用；短信 / 钉钉 / 飞书 / Webhook 预留（接入时扩值）。 */
export const NOTIFY_CHANNELS = ["wecom_app", "wecom_aibot", "wecom_group", "inbox", "email"] as const;
export const NotifyChannelSchema = z.enum(NOTIFY_CHANNELS).openapi("NotifyChannel", {
  description: "投递渠道：wecom_app 企微应用消息（备用通道）/ wecom_aibot 企微智能机器人（单聊单发）/ wecom_group 企微群机器人（群播报 · 会话双窗口限速）/ inbox 站内信 / email 邮件（基础可用）",
});
export type NotifyChannel = z.infer<typeof NotifyChannelSchema>;

/** 收件人口径：变量由规则声明，接收人由业务数据解析（负责人为空时回退项目经理，见 R02 补充设计）。 */
export const RULE_RECIPIENTS = [
  "task.owner",
  "task.owner_or_project_manager",
  "project.manager",
  "project.group",
  "rule.members",
  "report.member",
] as const;
export const RuleRecipientSchema = z.enum(RULE_RECIPIENTS).openapi("RuleRecipient", {
  description:
    "收件人口径：task.owner 任务负责人（多人时逐位）/ task.owner_or_project_manager 负责人为空回退项目经理 / project.manager 项目经理（任务主体解析）/ project.group 项目群（R04 / R06 / A02 / A08）/ rule.members 规则显式成员（A14 自定义待办）/ report.member 日报名册成员（A01 应填未填）；issue.owner 随 A03 处理时限删除下线（Push 215）",
});
export type RuleRecipient = z.infer<typeof RuleRecipientSchema>;

/** 运行状态（automation_runs）：hit 命中 / skipped 未命中或被幂等挡下 / failed 动作失败（C2-12 规则可解释）。 */
export const AUTOMATION_RUN_STATUSES = ["hit", "skipped", "failed"] as const;
export const AutomationRunStatusSchema = z.enum(AUTOMATION_RUN_STATUSES).openapi("AutomationRunStatus", {
  description: "规则运行状态：hit 命中 / skipped 未命中或被幂等挡下 / failed 动作失败",
});
export type AutomationRunStatus = z.infer<typeof AutomationRunStatusSchema>;

/** 触发定义（C2-01）：event 型填 topic；schedule 型填 cron（五段）+ 窗口（+ 窗口基准字段）。 */
export const AutomationTriggerSchema = z
  .object({
    kind: RuleTriggerKindSchema,
    topic: RuleEventTopicSchema.nullable()
      .optional()
      .openapi({ description: "event 型必填：outbox 主题（与业务事务同事务写入）" }),
    cron: z.string().nullable().optional().openapi({ example: "0 8 * * *", description: "schedule 型必填：五段 cron（Asia/Shanghai，ADR-028）" }),
    window: RuleScheduleWindowSchema.nullable().optional().openapi({ description: "schedule 型必填：触发窗口（幂等窗口键随窗口求值）" }),
    baseField: z.string().nullable().optional().openapi({ example: "task.planned_end", description: "窗口基准字段（T±N / 当天用；WEEKLY 可空）" }),
  })
  .openapi("AutomationTrigger", {
    description: "触发定义：event 事件型（topic）/ schedule 调度型（cron + window，基准字段 baseField 求 T-N / T+N / 当天）",
  });
export type AutomationTrigger = z.infer<typeof AutomationTriggerSchema>;

/** 条件（C2-01）：field 取值口径 = 求值上下文暴露的实体字段（如 task.status / task.planned_end / task.deliverable_types）。 */
export const AutomationConditionSchema = z
  .object({
    field: z.string().min(1).max(64).openapi({ example: "task.status", description: "实体字段名（点分命名空间，由回放 / 求值上下文提供）" }),
    op: RuleConditionOperatorSchema,
    value: z
      .union([z.string(), z.number(), z.boolean(), z.array(z.string()), z.array(z.number()), z.null()])
      .optional()
      .openapi({ description: "比较值（in / notIn / containsAny 用数组；isNull / notNull / notEmpty 省略）" }),
  })
  .openapi("AutomationCondition", { description: "规则条件（白名单操作符；全部条件与运算 = 命中）" });
export type AutomationCondition = z.infer<typeof AutomationConditionSchema>;

/** 动作（C2-01）：渠道消息 / 站内信；groupBy = 合并维度（同一维度值合并为一条，R07 按负责人合并）。 */
export const AutomationActionSchema = z
  .object({
    kind: RuleActionKindSchema,
    channel: NotifyChannelSchema.nullable().optional().openapi({ description: "notify 型必填：投递渠道" }),
    recipient: z.union([RuleRecipientSchema, z.array(RuleRecipientSchema)]).openapi({ description: "收件人口径（多个 = 逐个解析，均落发送记录）" }),
    template: z.string().min(1).max(64).openapi({ example: "R04_GROUP", description: "消息模板码（逐字文案见 docs/rules/R01-R07-内置规则文案.md）" }),
    groupBy: z.array(z.string()).max(3).optional().openapi({ description: "合并维度字段（可选；同一维度值合并为一条消息）" }),
  })
  .openapi("AutomationAction", { description: "规则动作：notify 渠道消息（企微 / 邮件）/ notification 站内信" });
export type AutomationAction = z.infer<typeof AutomationActionSchema>;

/** 规则文档（C2-01：参数化 + 启停；不做可视化编排）。 */
export const AutomationRuleSchema = z
  .object({
    code: z.string().min(2).max(32).openapi({ example: "R03", description: "规则编码（内置 R01~R07 / A01 / A02 / A08 / A14；自定义规则自定码）" }),
    name: z.string().min(1).max(80).openapi({ example: "任务即将延期提醒" }),
    enabled: z.boolean().openapi({ description: "启停开关（C2-01 / C2-02：内置规则亦可启停）" }),
    trigger: AutomationTriggerSchema,
    conditions: z.array(AutomationConditionSchema).max(20).openapi({ description: "条件（与运算；空数组 = 恒命中）" }),
    actions: z.array(AutomationActionSchema).min(1).max(10).openapi({ description: "动作（按数组顺序执行）" }),
    version: z.number().int().min(1).openapi({ description: "规则版本号（每次保存 +1；随幂等执行键参与去重口径）" }),
  })
  .openapi("AutomationRule", { description: "自动化规则文档（参数化 + 启停，不做可视化编排；技术设计v0.2 §6.1）" });
export type AutomationRule = z.infer<typeof AutomationRuleSchema>;

/** 消息模板（C2-04）：title 可为空（投递仅正文）；body 为逐字文案，变量占位符保持 {字段} 原文格式。 */
export const AutomationMessageTemplateSchema = z
  .object({
    code: z.string().min(1).max(64),
    title: z.string().nullable().openapi({ example: "及时添加文件", description: "消息标题（null = 无标题，投递仅正文）" }),
    body: z.string().min(1).openapi({ example: "项目：**{项目}**\n{完成人}已点击完成任务，请为项目任务「**{任务描述}**」及时添加成果文件" }),
  })
  .openapi("AutomationMessageTemplate", { description: "消息模板（逐字基准：标题与内容不得改字，变量占位符保持 {字段} 原文格式）" });
export type AutomationMessageTemplate = z.infer<typeof AutomationMessageTemplateSchema>;
