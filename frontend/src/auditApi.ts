/**
 * 操作记录（C7 审计 · 管理员查询页 · 2026-10-08）读取面：GET /api/v1/audit-logs（仅 audit.view）。
 * 契约 shared/src/modules/audits.ts：occurredAt 降序（同毫秒按 id 降序）；筛选 = 关键字 q / 对象类型 / 对象 id / 操作人 /
 * 动作 / 结果 / 项目 / 时间区间（from / to 含端点）+ 分页（page / limit，上限 200）；除对象 id / 时间外均为**多选**
 * （2026-10-09 追订，逗号分隔、去重保序，服务端逐值校验白名单）。
 * 本页只读：越权尝试用 result=denied 筛出（C7-03）；写入（谁、何时、从什么改成什么）由服务端各业务用例同事务落库。
 */
import { apiRequest } from "./api";

/**
 * 审计动作（与契约 AUDIT_ACTIONS 同口径；中文标签见 AUDIT_ACTION_LABELS）。
 * preview（预览）自 2026-10-12 起停用：服务端不再写入、筛选下拉不再提供、库内存量行已清理（清理前已备份）—— 值保留：兼容历史导出数据与直链 ?action=preview 的解析 / 标签渲染。
 */
export const AUDIT_ACTIONS = ["create", "update", "delete", "progress", "complete", "advance", "rollback", "archive", "preview", "download", "deny"];
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/** 审计对象类型（与契约 AUDIT_OBJECT_TYPES 同口径）。 */
export const AUDIT_OBJECT_TYPES = ["project", "project_member", "task", "node", "stage", "dict_item", "blueprint", "calendar_day", "calendar_settings", "file", "change", "stakeholder", "daily_report", "issue", "task_node", "task_template", "user", "wecom_dm_binding"];
export type AuditObjectType = (typeof AUDIT_OBJECT_TYPES)[number];

/** 审计结果：成功 / 越权拒绝（C7-03）/ 失败（门禁拒绝等）。 */
export const AUDIT_RESULTS = ["succeeded", "denied", "failed"];
export type AuditResult = (typeof AUDIT_RESULTS)[number];

export const AUDIT_ACTION_LABELS: Record<string, string> = {
  create: "新增",
  update: "修改",
  delete: "删除",
  progress: "进度",
  complete: "完成",
  advance: "推进",
  rollback: "回退",
  archive: "归档",
  preview: "预览",
  download: "下载",
  deny: "越权拒绝",
};

export const AUDIT_OBJECT_TYPE_LABELS: Record<string, string> = {
  project: "项目",
  project_member: "项目名册",
  task: "任务",
  node: "节点",
  stage: "阶段",
  dict_item: "字典条目",
  blueprint: "蓝图",
  calendar_day: "工作日历",
  calendar_settings: "顺延配置",
  file: "文件",
  change: "变更记录",
  stakeholder: "干系人",
  daily_report: "日报",
  issue: "问题",
  task_node: "任务节点",
  task_template: "任务模板",
  user: "系统用户",
  wecom_dm_binding: "企微绑定验证",
};

export const AUDIT_RESULT_LABELS: Record<string, string> = {
  succeeded: "成功",
  denied: "越权拒绝",
  failed: "失败",
};

/** 枚举 → 中文标签：未知取值回落原文（服务端新增枚举属兼容变更，页面不空白）。 */
export function auditLabelOf(labels: Record<string, string>, key: string): string {
  return labels[key] ?? key;
}

/** 审计行（契约 AuditLog）：actorName 为写入时姓名快照（离职后仍可追溯）；changes 为字段级修改（无则 null）。 */
export type AuditLogItem = {
  id: number;
  occurredAt: string;
  actorId: string | null;
  actorName: string | null;
  action: string;
  objectType: string;
  objectId: string;
  projectId: string | null;
  result: string;
  entry: string;
  summary: string;
  changes: Array<{ field: string; from: unknown; to: unknown }> | null;
  metadata: Record<string, unknown>;
};

export type AuditLogListResult = { items: AuditLogItem[]; windowId?: number | null; page: number; limit: number; total: number };

/** 每页条数（契约 limit 上限 200；一期取 50，与表宽 / 摘要长度相称）。 */
export const AUDIT_PAGE_LIMIT = 50;

export type AuditApiQuery = {
  /** 关键字（Push 260 搜索，契约 q max(200)）：操作内容（摘要 / 变化明细）/ 操作人姓名快照；null = 不落参数。 */
  keyword: string | null;
  /** 以下五项 = 多选（2026-10-09 追订）：空数组 = 不落参数；多值以逗号分隔（契约同口径）。 */
  actorIds: string[];
  actions: string[];
  objectTypes: string[];
  results: string[];
  projectIds: string[];
  /** 时间下界（日，YYYY-MM-DD，Asia/Shanghai，含当日 00:00:00）。 */
  from: string | null;
  /** 时间上界（日，YYYY-MM-DD，Asia/Shanghai，含当日 23:59:59.999）。 */
  to: string | null;
  beforeId?: number;
  page: number;
};

/** 日 → ISO8601 起点（Asia/Shanghai；时区口径 ADR-028）。 */
export function auditDayStartIso(day: string): string {
  return new Date(day + "T00:00:00+08:00").toISOString();
}

/** 日 → ISO8601 终点（含端点：当日 23:59:59.999，Asia/Shanghai）。 */
export function auditDayEndIso(day: string): string {
  return new Date(day + "T23:59:59.999+08:00").toISOString();
}

/** 组装审计查询串（契约参数命名；空筛选不落参数）。 */
export function buildAuditApiQuery(query: AuditApiQuery): string {
  const parts: string[] = [];
  if (query.keyword !== null) {
    parts.push("q=" + encodeURIComponent(query.keyword));
  }
  if (query.objectTypes.length > 0) {
    parts.push("objectType=" + query.objectTypes.map((type) => encodeURIComponent(type)).join(","));
  }
  if (query.actorIds.length > 0) {
    parts.push("actorId=" + query.actorIds.map((id) => encodeURIComponent(id)).join(","));
  }
  if (query.actions.length > 0) {
    parts.push("action=" + query.actions.map((action) => encodeURIComponent(action)).join(","));
  }
  if (query.results.length > 0) {
    parts.push("result=" + query.results.map((result) => encodeURIComponent(result)).join(","));
  }
  if (query.projectIds.length > 0) {
    parts.push("projectId=" + query.projectIds.map((id) => encodeURIComponent(id)).join(","));
  }
  if (query.from !== null) {
    parts.push("from=" + encodeURIComponent(auditDayStartIso(query.from)));
  }
  if (query.to !== null) {
    parts.push("to=" + encodeURIComponent(auditDayEndIso(query.to)));
  }
  if (query.beforeId !== undefined) parts.push("beforeId=" + String(query.beforeId));
  parts.push("page=" + String(query.page));
  parts.push("limit=" + String(AUDIT_PAGE_LIMIT));
  return parts.join("&");
}

/** 审计列表（occurredAt 降序；无 audit.view → 403 FORBIDDEN）。 */
export function fetchAuditLogs(query: AuditApiQuery): Promise<AuditLogListResult> {
  return apiRequest<AuditLogListResult>("/api/v1/audit-logs?" + buildAuditApiQuery(query));
}
