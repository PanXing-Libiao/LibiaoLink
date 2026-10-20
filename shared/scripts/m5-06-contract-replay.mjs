/*
 * M5-06 S8-4 契约回放（Push 266）：
 * A08 / 权限 / 审计枚举 + 规则管理 / 试运行 / 运行记录 / 发送记录 / 重发 schema + OpenAPI 九操作。
 * 运行：shared/ 下 node scripts/m5-06-contract-replay.mjs；退出码 0 = 全过。
 * 边界：纯契约回放，不连库、不启动 HTTP、不执行迁移或业务实现。
 */
import { readFileSync } from "node:fs";
import {
  AUTOMATION_RULE_CODES,
  NOTIFY_EXTERNAL_CHANNELS,
  AutomationRuleCodeSchema,
  AutomationRuleListResponseSchema,
  AutomationRulePatchBodySchema,
  AutomationRuleTestBodySchema,
  AutomationRuleTestResponseSchema,
  AutomationRuleViewSchema,
  AutomationRunListResponseSchema,
  AutomationRunSchema,
} from "../src/modules/automation.ts";
import {
  NotifyDeliveryAttemptSchema,
  NotifyDeliveryDetailSchema,
  NotifyDeliveryListResponseSchema,
  NotifyDeliveryMessageSchema,
  NotifyDeliveryResendBodySchema,
  NotifyDeliveryResendResponseSchema,
} from "../src/modules/notifications.ts";
import { AUDIT_OBJECT_TYPES } from "../src/modules/audits.ts";
import { PERMISSION_KEYS } from "../src/modules/permissions.ts";

const at = "2026-10-20T09:00:00.000Z";
const ruleId = "11111111-1111-4111-8111-111111111111";
const entityId = "22222222-2222-4222-8222-222222222222";
const recipientId = "33333333-3333-4333-8333-333333333333";

const action = {
  kind: "notify",
  channel: "wecom_aibot",
  recipient: "task.owner",
  template: "R02_AIBOT",
  groupBy: [],
};
const conditionEvaluation = {
  field: "task.status",
  op: "eq",
  expected: "done",
  actual: "done",
  passed: true,
};
const messageSnapshot = {
  recipient: "张三",
  channel: "wecom_aibot",
  template: "R02_AIBOT",
  dedupeKey: "R02:" + entityId + ":2026-10-20",
  title: "及时添加文件",
  body: "请为项目任务「样例任务」及时添加成果文件",
};
const ruleView = {
  id: ruleId,
  code: "R02",
  name: "任务完成及时添加文件",
  enabled: true,
  trigger: { kind: "event", topic: "task.completed", cron: null, window: null, baseField: null },
  conditions: [{ field: "task.status", op: "eq", value: "done" }],
  actions: [action],
  version: 3,
  builtIn: true,
  editableFields: ["enabled", "actions.channel", "actions.recipient"],
  lastRunAt: at,
  nextRunAt: null,
  scheduleJobStatus: null,
};
const testResponse = {
  businessDate: "2026-10-20",
  evaluatedCount: 1,
  matchedCount: 1,
  skippedCount: 0,
  truncated: false,
  messages: [
    {
      ...messageSnapshot,
      ruleCode: "R02",
      entityId,
      windowKey: "task.completed:" + entityId,
    },
  ],
  skipped: [
    {
      reason: "not_matched",
      ruleCode: "R03",
      entityId: null,
      windowKey: null,
      conditions: [{ ...conditionEvaluation, actual: "active", passed: false }],
    },
  ],
};
const run = {
  id: 7,
  ruleId,
  ruleCode: "R02",
  ruleVersion: 3,
  source: "event",
  topic: "task.completed",
  windowKey: "task.completed:" + entityId,
  entityType: "task",
  entityId,
  dedupeKey: "event:" + entityId + ":R02:" + entityId,
  status: "hit",
  skipReason: null,
  conditions: [conditionEvaluation],
  actions: [action],
  messages: [messageSnapshot],
  error: null,
  createdAt: at,
};
const deliveryMessage = {
  id: 42,
  sourceDedupeKey: "R02:" + entityId + ":2026-10-20",
  topic: "notify.message",
  channel: "wecom_aibot",
  recipientId,
  recipientLabel: "张*（***2222）",
  title: "及时添加文件",
  body: "请为项目任务「样例任务」及时添加成果文件",
  templateCode: "R02_AIBOT",
  ruleCode: "R02",
  refType: "task",
  refId: entityId,
  resendOfMessageId: null,
  lastState: "dead",
  attemptCount: 3,
  lastError: "企微接口失败（errcode=93001：群已移出）",
  sentAt: null,
  createdAt: at,
  updatedAt: at,
};
const deliveryAttempt = {
  id: 9,
  messageId: 42,
  channel: "wecom_aibot",
  targetMasked: "***2222",
  state: "dead",
  attempts: 3,
  error: "企微接口失败（errcode=93001：群已移出）",
  sentAt: null,
  createdAt: at,
};

let pass = 0;
let total = 0;

function check(name, ok, detail = "") {
  total += 1;
  if (ok) pass += 1;
  console.log((ok ? "PASS" : "FAIL") + " | " + name + (detail ? " | " + detail : ""));
}

function schemaCases(label, schema, cases) {
  for (const [name, value, expectOk] of cases) {
    const parsed = schema.safeParse(value);
    const detail = parsed.success
      ? "接受"
      : "拒绝（" + parsed.error.issues.map((issue) => (issue.path.join(".") || "(root)") + " " + issue.code).join("; ") + "）";
    check(label + " · " + name, parsed.success === expectOk, "期望" + (expectOk ? "接受" : "拒绝") + " → 实际" + detail);
  }
}

schemaCases("规则管理", AutomationRuleViewSchema, [
  ["R02 详情可解析", ruleView, true],
  ["A03 已退役，不得作为规则码", { ...ruleView, code: "A03" }, false],
  ["缺 editableFields", { ...ruleView, editableFields: undefined }, false],
  ["调度 job 状态白名单外", { ...ruleView, scheduleJobStatus: "running" }, false],
]);
schemaCases("规则列表", AutomationRuleListResponseSchema, [
  ["含停用规则与 A08", { items: [ruleView, { ...ruleView, id: entityId, code: "A08", enabled: false }] }, true],
  ["超过 100 条", { items: Array.from({ length: 101 }, () => ruleView) }, false],
]);
schemaCases("规则保存", AutomationRulePatchBodySchema, [
  ["只改启停", { version: 3, enabled: false }, true],
  ["只改动作渠道 / 收件人", { version: 3, actions: [{ ...action, channel: "wecom_group", recipient: "project.group" }] }, true],
  ["空更新", { version: 3 }, false],
  ["缺 version", { enabled: false }, false],
  ["动作数组为空", { version: 3, actions: [] }, false],
  ["夹带只读规则码", { version: 3, code: "R01" }, false],
]);
schemaCases("试运行请求", AutomationRuleTestBodySchema, [
  ["空对象 = 今天 / 调度型主体池", {}, true],
  ["指定业务日与实体", { businessDate: "2026-10-20", entityId }, true],
  ["业务日格式非法", { businessDate: "2026/10/20" }, false],
]);
schemaCases("试运行响应", AutomationRuleTestResponseSchema, [
  ["命中 + 跳过明细", testResponse, true],
  ["缺 truncated", { ...testResponse, truncated: undefined }, false],
  ["跳过原因白名单外", { ...testResponse, skipped: [{ ...testResponse.skipped[0], reason: "unknown" }] }, false],
]);
schemaCases("运行记录", AutomationRunSchema, [
  ["事件命中记录", run, true],
  ["调度记录 topic 为 null", { ...run, source: "schedule", topic: null, windowKey: "2026-W43" }, true],
  ["状态白名单外", { ...run, status: "success" }, false],
]);
schemaCases("运行列表", AutomationRunListResponseSchema, [
  ["分页记录", { items: [run], page: 1, limit: 50, total: 1 }, true],
  ["缺 total", { items: [run], page: 1, limit: 50 }, false],
]);
schemaCases("发送消息", NotifyDeliveryMessageSchema, [
  ["死信消息", deliveryMessage, true],
  ["pending 消息", { ...deliveryMessage, lastState: "pending", attemptCount: 0, sentAt: null }, true],
  ["状态白名单外", { ...deliveryMessage, lastState: "processing" }, false],
]);
schemaCases("发送尝试", NotifyDeliveryAttemptSchema, [
  ["外部渠道尝试", deliveryAttempt, true],
  ["inbox 不产生外部尝试", { ...deliveryAttempt, channel: "inbox" }, false],
  ["尝试状态不得为 pending", { ...deliveryAttempt, state: "pending" }, false],
]);
schemaCases("发送列表 / 详情", NotifyDeliveryListResponseSchema, [
  ["消息级分页", { items: [deliveryMessage], page: 1, limit: 50, total: 1 }, true],
], );
schemaCases("发送详情", NotifyDeliveryDetailSchema, [
  ["消息 + 全部尝试", { ...deliveryMessage, attempts: [deliveryAttempt] }, true],
  ["缺 attempts", deliveryMessage, false],
]);
schemaCases("重发请求", NotifyDeliveryResendBodySchema, [
  ["空对象", {}, true],
  ["夹带正文", { body: "改写正文" }, false],
  ["夹带收件人", { recipientId }, false],
  ["夹带渠道", { channel: "wecom_group" }, false],
]);
schemaCases("重发响应", NotifyDeliveryResendResponseSchema, [
  ["新 pending 消息", { message: { ...deliveryMessage, id: 43, lastState: "pending", attemptCount: 0, resendOfMessageId: 42 } }, true],
]);

check("A08 入规则枚举", AUTOMATION_RULE_CODES.includes("A08"));
check("A03 不入规则枚举", !AUTOMATION_RULE_CODES.includes("A03"));
check("规则枚举无重复", new Set(AUTOMATION_RULE_CODES).size === AUTOMATION_RULE_CODES.length);
check(
  "权限键共 36 项且无重复",
  PERMISSION_KEYS.length === 36 && new Set(PERMISSION_KEYS).size === PERMISSION_KEYS.length,
  "实际 " + PERMISSION_KEYS.length + " 项",
);
check(
  "四个 M5-06 权限键齐备",
  ["automation.view", "automation.manage", "notify.record.view", "notify.resend"].every((key) => PERMISSION_KEYS.includes(key)),
);
check(
  "审计对象含 automation_rule / notify_delivery",
  ["automation_rule", "notify_delivery"].every((value) => AUDIT_OBJECT_TYPES.includes(value)),
);
check(
  "外部渠道不含 inbox",
  NOTIFY_EXTERNAL_CHANNELS.every((channel) => channel !== "inbox") && NOTIFY_EXTERNAL_CHANNELS.includes("email"),
);

const openapi = JSON.parse(readFileSync(new URL("../generated/openapi.json", import.meta.url), "utf8"));
const operations = [
  ["/api/v1/automation/rules", "get"],
  ["/api/v1/automation/rules/{code}", "get"],
  ["/api/v1/automation/rules/{code}", "patch"],
  ["/api/v1/automation/rules/{code}/test", "post"],
  ["/api/v1/automation/runs", "get"],
  ["/api/v1/automation/runs/{id}", "get"],
  ["/api/v1/notifications/deliveries", "get"],
  ["/api/v1/notifications/deliveries/{id}", "get"],
  ["/api/v1/notifications/deliveries/{id}/resend", "post"],
];
for (const [path, method] of operations) {
  const operation = openapi.paths[path]?.[method];
  check("OpenAPI " + method.toUpperCase() + " " + path, Boolean(operation));
  if (operation) {
    check("  ↳ 401 / 403 拒绝路径", Boolean(operation.responses["401"]) && Boolean(operation.responses["403"]));
  }
}

const ruleCodeEnum = openapi.components.schemas.AutomationRuleCode.enum;
check("OpenAPI 规则枚举含 A08 / 不含 A03", ruleCodeEnum.includes("A08") && !ruleCodeEnum.includes("A03"));
const externalEnum = openapi.components.schemas.NotifyExternalChannel.enum;
check("OpenAPI 外部渠道不含 inbox", !externalEnum.includes("inbox"));
const patchBody = openapi.components.schemas.AutomationRulePatchBody;
check("OpenAPI 规则保存体 additionalProperties=false", patchBody.additionalProperties === false);
const resendBody = openapi.components.schemas.NotifyDeliveryResendBody;
check("OpenAPI 重发体 additionalProperties=false", resendBody.additionalProperties === false);

function componentProperty(schemaName, propertyName) {
  const definition = openapi.components.schemas[schemaName];
  const candidates = [definition, ...(definition?.allOf || [])];
  for (const candidate of candidates) {
    if (candidate?.properties?.[propertyName]) return candidate.properties[propertyName];
  }
  return undefined;
}

function isNullableRef(schemaName, propertyName, refName) {
  const property = componentProperty(schemaName, propertyName);
  return (
    Array.isArray(property?.anyOf) &&
    property.anyOf.some((item) => item?.$ref === "#/components/schemas/" + refName) &&
    property.anyOf.some((item) => item?.type === "null")
  );
}

const nullableRefs = [
  ["AutomationRuleView", "lastRunAt", "DateTime"],
  ["AutomationRuleView", "nextRunAt", "DateTime"],
  ["AutomationRuleView", "scheduleJobStatus", "AutomationScheduleJobStatus"],
  ["AutomationRun", "ruleId", "Uuid"],
  ["AutomationRun", "topic", "RuleEventTopic"],
  ["AutomationRun", "skipReason", "AutomationRunSkipReason"],
  ["NotifyDeliveryMessage", "recipientId", "Uuid"],
  ["NotifyDeliveryMessage", "sentAt", "DateTime"],
  ["NotifyDeliveryAttempt", "sentAt", "DateTime"],
];
for (const [schemaName, propertyName, refName] of nullableRefs) {
  check("OpenAPI " + schemaName + "." + propertyName + " 可空", isNullableRef(schemaName, propertyName, refName));
}

const resendOperation = openapi.paths["/api/v1/notifications/deliveries/{id}/resend"].post;
const idempotencyHeader = (resendOperation.parameters || []).find((parameter) => parameter.name === "Idempotency-Key");
check("OpenAPI 重发要求 Idempotency-Key", idempotencyHeader?.in === "header" && idempotencyHeader?.required === true);

const pathKeys = Object.keys(openapi.paths);
check(
  "OpenAPI deliveries 静态段声明在 notifications/{id} 之前",
  pathKeys.indexOf("/api/v1/notifications/deliveries") < pathKeys.indexOf("/api/v1/notifications/{id}"),
);

let operationCount = 0;
for (const path of pathKeys) {
  operationCount += Object.keys(openapi.paths[path]).filter((key) => ["get", "post", "patch", "put", "delete", "options", "head"].includes(key)).length;
}
console.log(
  "OpenAPI 计数：paths=" + pathKeys.length + "，operations=" + operationCount + "，schemas=" + Object.keys(openapi.components.schemas).length,
);
console.log("共 " + total + " 组，PASS " + pass + " / FAIL " + (total - pass));
if (pass !== total) process.exit(1);
