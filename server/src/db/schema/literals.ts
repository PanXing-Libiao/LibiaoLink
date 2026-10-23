/** 固定的 SQL 字面量工具：仅用于把本文件的稳定枚举写进 CHECK 定义（避免在 schema 里散落引号）。 */
export function sqlValueList(values: readonly string[]): string {
  const quote = String.fromCharCode(39);
  return "(" + values.map((value) => quote + value + quote).join(", ") + ")";
}

/** 日报状态（daily_reports.state · A3-02）：草稿 / 已提交 / 补填（对过去日期首次提交）。 */
export const DAILY_REPORT_STATE_KEYS = ["draft", "submitted", "supplement"] as const;

/** 问题三态（issues.state · A3-10 · Push 215）：未解决 / 处理中 / 已完成；允许回退且留痕（「未分组」并入「未解决」）。 */
export const ISSUE_STATE_KEYS = ["open", "in_progress", "done"] as const;

/** 问题归类（issues.categories · A3-11 · C9 字典十项 · Push 215 多值）：一期为契约固定枚举，字典可维护随后（差异登记）。 */
export const ISSUE_CATEGORY_KEYS = [
  "机械部",
  "采购部",
  "规划部",
  "项目部",
  "物流原因",
  "供应商原因",
  "客户原因",
  "客观原因",
  "生产原因",
  "其它原因",
] as const;

/** 问题事件类型（issue_events.event_type · A3-13）：创建 / 状态流转 / 解决方案 / 分派。 */
export const ISSUE_EVENT_TYPE_KEYS = ["created", "state_change", "solution", "assignment"] as const;

export const STAGE_KEYS = [
  "presale",
  "design",
  "purchase",
  "assembly",
  "install",
  "deploy",
  "trial",
  "production",
  "acceptance",
] as const;

/** 项目内角色（project_members.role_in_project，v0.3 §3.3）：与全局角色（roles）相互独立，名册内既可见性也认角色。 */
export const PROJECT_MEMBER_ROLES = [
  "project_manager",
  "project_member",
] as const;

/** 角色数据范围（roles.data_scope，v0.2 §4.1）：由宽到窄，多角色取并集。 */
export const DATA_SCOPE_KEYS = [
  "all",
  "managed_projects",
  "involved_projects",
  "own_stakeholders",
  "granted",
] as const;

/**
 * 审计动作（audit_logs.action，h7 · C7 + M4-05）：新增 / 修改 / 删除 / 进度 / 完成 / 推进 / 回退 / 归档 / 访问 / 预览查看 / 离线下载 / 越权拒绝。
 * 2026-10-23：项目访问与登录成功记 visit；实际送达的就绪预览恢复写 preview。
 * 与 shared/src/modules/audits.ts 的 AUDIT_ACTIONS 同序同值 —— 一致性由 test/schema-literals-parity.test.ts 守护
 * （check:db-schema 只比 CHECK 约束名、不比取值）；preview（D2-07）与 download（Push 160 定案 · A4-10）随 M4-05 一次补齐；archive（M7-04 · ADR-027 归档）随 0036 补齐；visit 随 0066 补齐。
 */
export const AUDIT_ACTION_KEYS = [
  "create",
  "update",
  "delete",
  "progress",
  "complete",
  "advance",
  "rollback",
  "archive",
  "visit",
  "preview",
  "download",
  "deny",
] as const;

/** 审计结果（audit_logs.result）：成功 / 越权拒绝 / 执行失败。 */
export const AUDIT_RESULT_KEYS = ["succeeded", "denied", "failed"] as const;

/** 审计入口（audit_logs.entry）：页面 / API / 系统任务 / 批量。 */
export const AUDIT_ENTRY_KEYS = ["api", "page", "system", "batch"] as const;

/** 预览渲染通道（preview_artifacts.target，M4-05 · ADR-007）：与契约 PREVIEW_TARGETS 同序同值。 */
export const PREVIEW_TARGET_KEYS = ["pdf", "image", "structured"] as const;

/**
 * 预览产物状态（preview_artifacts.status，M4-05 · D2-05）：与契约 PREVIEW_STATUSES 同值 ——
 * 库侧 not_ready = 已请求未就绪（生成任务由 outbox 重试兜底），读面原样下发，不做值映射。
 */
export const PREVIEW_STATUS_KEYS = ["ready", "not_ready", "failed"] as const;

/** 工作日历例外类型（calendar_days.day_type，h8 · D5-01）：holiday 放假 / makeup_workday 调休上班。 */
export const CALENDAR_DAY_TYPE_KEYS = ["holiday", "makeup_workday"] as const;

/** 顺延方向（calendar_settings.shift_direction，h8 · D5-02）：forward 顺延到之后 / backward 提前到之前最近工作日。 */
export const CALENDAR_SHIFT_DIRECTION_KEYS = ["forward", "backward"] as const;

/** 十类成果文件字典（C9 / v0.2 §2.5）：与 shared/src/common/dicts.ts 的 DOC_TYPES 同序同值，tasks.deliverable_types 的 CHECK 与迁移 0018 引用。 */
export const DOC_TYPE_KEYS = [
  "CAD图纸",
  "技术协议",
  "合同",
  "评审单",
  "设备清单",
  "物料总清单",
  "发货装箱单",
  "到货单",
  "安装完成证明",
  "验收单",
] as const;

/** 公司分类（stakeholders.company_type，A5-02 / C9）：立镖机器人 / 供应商 / 总包单位 / 客户。 */
export const STAKEHOLDER_COMPANY_TYPE_KEYS = ["libiao", "supplier", "general_contractor", "customer"] as const;

/** 视图范围（project_views.scope，M2-06 · A1-03）：与契约 VIEW_SCOPES 同序同值（parity 测试守护）。 */
export const VIEW_SCOPE_KEYS = ['personal', 'public'] as const;

/** 关注对象类型（follows.object_type，M2-06 · A1-15）：与契约 FOLLOW_OBJECT_TYPES 同序同值。 */
export const FOLLOW_OBJECT_TYPE_KEYS = ['project', 'task'] as const;

/** 通知类型（notifications.type，S7-4 · j1 / C5-02）：与契约 NOTIFICATION_TYPES 同序同值。 */
export const NOTIFICATION_TYPE_KEYS = ["reminder", "approval", "broadcast", "system"] as const;

/** 通知状态（notifications.status，S7-4 · C5-01）：与契约 NOTIFICATION_STATUSES 同序同值。 */
export const NOTIFICATION_STATUS_KEYS = ["unread", "read", "handled"] as const;

/** 数组字面量（CHECK 用：`<@ array[… ]::text[]`）；sqlValueList 只服务 `in (…)`。 */
export function sqlArrayLiteral(values: readonly string[]): string {
  const quote = String.fromCharCode(39);
  return "array[" + values.map((value) => quote + value + quote).join(", ") + "]::text[]";
}
