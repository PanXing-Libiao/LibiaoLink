/**
 * 操作记录（C7 审计）· 可读化层（2026-10-09）。
 * 业务口径（px 2026-10-09）：「不要这种太机器的操作记录 要让人可以看懂的 那些路由还有具体的代码不要显示
 * 操作日志要详细到每一个动作 不能只是简单的修改了什么项目 最好是展示变化 修改前 修改后这样」。
 * 职责：把 audit_logs 的机器口径（camelCase 字段 / UUID / 枚举码 / ISO 时间 / API 路径 / 错误码）翻成中文页面口径 ——
 * 摘要成句、字段有中文名、取值有人话（人 / 项目等 id 解析成名字）、每条变化给「修改前 → 修改后」。
 * 只做展示层：数据面（GET /api/v1/audit-logs）与留痕内容零改动；未知字段 / 未知取值回落原文（不吞信息、不空白）。
 */
import { AUDIT_OBJECT_TYPE_LABELS, auditLabelOf, type AuditLogItem } from "./auditApi";
import { formatDateTime } from "./projectApi";

export type AuditFormatContext = {
  /** 目录（GET /api/v1/users）：users.id → 姓名。 */
  userNameById: Map<string, string>;
  /** 项目列表（GET /api/v1/projects）：projects.id → 项目编号。 */
  projectCodeById: Map<string, string>;
};

/** 变化明细的一行（渲染用）：字段中文名 + 修改前 / 修改后。 */
export type AuditChangeLine = {
  label: string;
  from: string;
  to: string;
  kind: "create" | "update" | "clear";
};

/** 变化明细最多展示的行数（超出以「等 N 项」收口，避免单行撑满整屏）。 */
export const AUDIT_CHANGE_LINE_LIMIT = 12;

/** 人（名字解析）字段：值为 users.id / users.id[]。 */
const PERSON_FIELDS = new Set([
  "managerIds",
  "ownerIds",
  "ownerId",
  "userId",
  "authorId",
  "reporterId",
  "updatedBy",
  "createdBy",
  "deletedBy",
  "finalizedBy",
]);

/** 内部 id / 机器字段：页面上不出（业务口径「那些路由还有具体的代码不要显示」）。 */
const HIDDEN_FIELDS = new Set(["metadata", "currentVersionId", "pendingVersion", "sourceReportId"]);

/** 通用字段中文名（按对象类型的特例见 OBJECT_FIELD_LABELS）。 */
const FIELD_LABELS: Record<string, string> = {
  actualEnd: "实际完成日期",
  categories: "类别",
  closedAt: "关闭时间",
  code: "编号",
  company: "公司",
  companyType: "公司类型",
  customer: "客户",
  deletedAt: "删除时间",
  deliverableTypes: "输出成果文件",
  description: "描述",
  doneWork: "今日完成",
  email: "邮箱",
  enabled: "启用状态",
  estimatedDays: "预计所需天数",
  finalizedAt: "定档时间",
  foundIssue: "发现的问题",
  headcount: "预计所需施工人数",
  issueCategories: "问题归类",
  kind: "类型",
  managerIds: "项目经理",
  name: "名称",
  nodes: "任务节点",
  note: "备注",
  ownerDepartment: "责任部门",
  ownerId: "负责人",
  ownerIds: "任务负责人",
  pendingChange: "变更内容",
  phone: "电话",
  plan: "计划",
  plannedEnd: "计划完成日期",
  plannedStart: "计划开始日期",
  priority: "紧急重要度",
  progress: "进度",
  projectType: "项目类型",
  raisedAt: "提出日期",
  region: "地区",
  remark: "备注",
  reportDate: "日报日期",
  role: "角色",
  roleInProject: "项目角色",
  seq: "序号",
  solution: "解决方案",
  sort: "排序",
  sortIndex: "排序",
  stageKey: "阶段",
  stageKeys: "关联阶段",
  state: "状态",
  status: "状态",
  statusOverride: "状态覆盖",
  suggestion: "解决方案或建议",
  title: "名称",
  titleEn: "英文名称",
  userId: "成员",
  version: "版本号",
  wechat: "微信",
};

/** 按对象类型的字段特例（同名字段在不同对象上叫法不同）。 */
const OBJECT_FIELD_LABELS: Record<string, Record<string, string>> = {
  project: { code: "项目编号", name: "项目名称", description: "项目描述", stageKey: "项目阶段" },
  project_member: { userId: "成员", roleInProject: "项目角色" },
  task: { title: "任务名称", stageKey: "所属阶段", ownerIds: "任务负责人" },
  task_node: { title: "节点名称", stageKey: "所属阶段", seq: "节点序号" },
  task_template: { name: "模板名称", nodes: "包含节点", stageKey: "所属阶段" },
  issue: { title: "问题标题", state: "问题状态", categories: "问题归类", ownerId: "问题处理人", suggestion: "解决方案或建议", closedAt: "关闭时间" },
  daily_report: { reportDate: "日报日期", state: "日报状态", doneWork: "今日完成", foundIssue: "发现的问题", stageKeys: "关联阶段", plan: "明日计划" },
  file: { name: "文件名", status: "状态", version: "版本号", pendingChange: "变更内容" },
  dict_item: { code: "条目代码", name: "条目名称", sort: "排序", enabled: "启用状态" },
  stakeholder: { name: "姓名", title: "职务", company: "公司", companyType: "公司类型" },
};

/** 阶段（九阶段板块）。 */
const STAGE_LABELS: Record<string, string> = {
  presale: "售前规划",
  design: "设计开发",
  purchase: "加工采购",
  assembly: "组装发货",
  install: "硬件实施",
  deploy: "软件部署",
  trial: "试运行",
  production: "生产阶段",
  acceptance: "验收",
};

/** 状态（文件生命周期 / 任务 / 项目 / 归档）。 */
const STATUS_LABELS: Record<string, string> = {
  draft: "草稿",
  pending: "待处理",
  active: "进行中",
  paused: "已暂停",
  final: "已定档",
  changed: "已变更",
  done: "已完成",
  archived: "已归档",
  recycled: "回收站",
};

/** 状态（日报 / 问题）。 */
const STATE_LABELS: Record<string, string> = {
  draft: "草稿",
  submitted: "已提交",
  open: "未解决",
  in_progress: "处理中",
  done: "已完成",
};

/** 四格进度档位。 */
const PROGRESS_LABELS: Record<string, string> = {
  "0": "未开始",
  "0.25": "刚开工",
  "0.5": "完成一半",
  "0.75": "快完成了",
  "1": "已完成",
};

/** 枚举取值中文名（按字段；未知取值回落原文）。 */
const VALUE_LABELS: Record<string, Record<string, string>> = {
  stageKey: STAGE_LABELS,
  stageKeys: STAGE_LABELS,
  status: STATUS_LABELS,
  state: STATE_LABELS,
  roleInProject: { project_member: "项目成员" },
  companyType: { customer: "客户" },
  kind: { onsite: "现场", issue: "问题", change: "变更" },
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const API_SUMMARY_RE = /^[A-Z]+\s+\/api\/\S+\s*(?:→|->)\s*([\s\S]*)$/;
const ERROR_CODE_RE = /^[A-Z][A-Z_]{2,}\s*[：:]\s*/;
const TRAILING_UUID_RE = /[：:]\s*[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\s*$/i;
const TRAILING_ERROR_CODE_RE = /\s*（[A-Z][A-Z_]{3,}）\s*$/;
const STATUS_PAREN_RE = /（状态\s*([a-z_]+)\s*(?:→|->)\s*([a-z_]+)）/g;

function fieldLabel(objectType: string, field: string): string {
  const special = OBJECT_FIELD_LABELS[objectType]?.[field];
  if (special !== undefined) {
    return special;
  }
  return FIELD_LABELS[field] ?? field;
}

/** uuid 取值 → 人话：人解析成姓名、项目解析成项目编号；其余内部 id 不展示（null = 整条不渲染）。 */
function resolveUuid(field: string, id: string, ctx: AuditFormatContext): string | null {
  if (PERSON_FIELDS.has(field)) {
    return ctx.userNameById.get(id) ?? "（未知成员）";
  }
  if (field === "projectId") {
    return ctx.projectCodeById.get(id) ?? null;
  }
  return null;
}

function formatScalar(field: string, value: unknown, ctx: AuditFormatContext): string | null {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "boolean") {
    if (field === "enabled") {
      return value ? "启用" : "停用";
    }
    return value ? "是" : "否";
  }
  if (typeof value === "number") {
    if (field === "progress") {
      return PROGRESS_LABELS[String(value)] ?? String(value);
    }
    return String(value);
  }
  if (typeof value === "string") {
    const text = value.trim();
    if (text === "") {
      return "（空）";
    }
    if (UUID_RE.test(text)) {
      return resolveUuid(field, text, ctx);
    }
    if (ISO_RE.test(text)) {
      return formatDateTime(text);
    }
    const label = VALUE_LABELS[field]?.[text];
    return label ?? text;
  }
  return null;
}

function formatValue(field: string, value: unknown, ctx: AuditFormatContext): string | null {
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return "（无）";
    }
    const parts: string[] = [];
    for (const item of value) {
      const text = formatScalar(field, item, ctx);
      if (text === null) {
        return null;
      }
      parts.push(text);
    }
    return parts.join("、");
  }
  return formatScalar(field, value, ctx);
}

/** 摘要成句：越权尝试把 API 路径 / 错误码换成「尝试越权访问 X：原因」；CSRF 凭证失配另作过期提示；结尾错误码一律去掉。 */
export function auditSummaryText(item: AuditLogItem): string {
  const raw = item.summary.trim();
  if (raw.includes("CSRF_FAILED") || raw.includes("CSRF 校验失败")) {
    return "页面凭证已过期，请刷新重试";
  }
  const api = API_SUMMARY_RE.exec(raw);
  if (api !== null) {
    let reason = api[1].trim().replace(ERROR_CODE_RE, "").replace(TRAILING_UUID_RE, "").trim();
    if (reason.indexOf("无权限") === 0) {
      reason = "没有该操作的权限";
    }
    const head = "尝试越权访问" + auditLabelOf(AUDIT_OBJECT_TYPE_LABELS, item.objectType);
    return reason === "" ? head : head + "：" + reason;
  }
  return raw
    .replace(TRAILING_ERROR_CODE_RE, "")
    .replace(STATUS_PAREN_RE, (_all, from: string, to: string) => "（状态 " + (STATUS_LABELS[from] ?? from) + " → " + (STATUS_LABELS[to] ?? to) + "）")
    .trim();
}

/** 对象列：中文类型名（项目类解析出项目编号；不再出对象 id）。 */
export function auditObjectText(item: AuditLogItem, ctx: AuditFormatContext): string {
  const label = auditLabelOf(AUDIT_OBJECT_TYPE_LABELS, item.objectType);
  if (item.objectType === "project") {
    const code = ctx.projectCodeById.get(item.objectId);
    if (code !== undefined) {
      return label + " · " + code;
    }
  }
  return label;
}

/** 变化明细 → 「字段：修改前 → 修改后」各行（内部 id / 无实际变化 / 空对空的行不渲染）。 */
export function auditChangeLines(item: AuditLogItem, ctx: AuditFormatContext): AuditChangeLine[] {
  const changes = item.changes ?? [];
  const lines: AuditChangeLine[] = [];
  for (const change of changes) {
    if (HIDDEN_FIELDS.has(change.field)) {
      continue;
    }
    const from = formatValue(change.field, change.from, ctx);
    const to = formatValue(change.field, change.to, ctx);
    if (from === null || to === null) {
      continue;
    }
    if (from === "" && to === "") {
      continue;
    }
    if (from === to) {
      continue;
    }
    lines.push({
      label: fieldLabel(item.objectType, change.field),
      from,
      to,
      kind: from === "" ? "create" : to === "" ? "clear" : "update",
    });
  }
  return lines;
}
