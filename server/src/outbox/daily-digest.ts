import type {
  OutboxDailyDigest,
  OutboxDailyDigestFallback,
  OutboxDailyDigestRecovery,
  OutboxDailyDigestRepeatedIssue,
  OutboxRecoveryCode,
} from "./alert.js";

/**
 * 管理员日报领域计算（固定 08:00 · Asia/Shanghai）。
 *
 * 口径：
 * - 统计前一自然日 [windowFrom, windowTo)，按消息来源键去重；C5-04 :c504 副本归并到来源消息。
 * - 收件人未绑定企业微信 / 项目群未绑定 / 项目群机器人未激活是即时告警，整体不进入日报。
 * - 送达、待重试、最终失败取日报生成时的最新归档状态快照。
 * - 自动降级只展示已兜底的确定性失败；未知技术错误不伪装成“无需处理”。
 */
export const SHANGHAI_OFFSET_MS = 8 * 3_600_000;
export const DAY_MS = 86_400_000;
export const DAILY_DIGEST_GRACE_MS = 4 * 3_600_000;
export const DAILY_DIGEST_LATE_DELIVERY_MS = 5 * 60_000;
export const DAILY_DIGEST_HISTORY_DAYS = 7;

export const OUTBOX_DAILY_DIGEST_JOB_KIND = "outbox.alert-digest";
export const OUTBOX_DAILY_DIGEST_CRON = "0 8 * * *";
export const OUTBOX_DAILY_DIGEST_DEDUPE_KEY = "system:outbox-alert-digest";

export interface DailyDigestMessageRecord {
  id: number;
  sourceDedupeKey: string;
  channel: string;
  title: string | null;
  templateCode: string | null;
  lastState: string;
  lastError: string | null;
  sentAt: Date | null;
  createdAt: Date;
  metadata: Record<string, unknown>;
}

export interface DailyDigestAttemptRecord {
  messageId: number | null;
  state: string;
  error: string | null;
  createdAt: Date;
}

export interface DailyDigestPreviewDeadRecord {
  id: number;
  lastError: string | null;
  updatedAt: Date;
}

export interface DailyDigestSourceData {
  messages: DailyDigestMessageRecord[];
  attempts: DailyDigestAttemptRecord[];
  previewDeaths: DailyDigestPreviewDeadRecord[];
}

export interface BuildDailyDigestInput {
  reportAt: Date;
  generatedAt: Date;
  data: DailyDigestSourceData;
  recoveries?: OutboxDailyDigestRecovery[];
}

interface DigestWindow {
  from: Date;
  to: Date;
}

interface LogicalMessageGroup {
  key: string;
  rows: DailyDigestMessageRecord[];
  baseRows: DailyDigestMessageRecord[];
  copyRows: DailyDigestMessageRecord[];
  createdAt: Date;
  state: "delivered" | "retrying" | "failed";
  sentAt: Date | null;
  excluded: boolean;
}

interface IssueAccumulator {
  label: string;
  days: Set<string>;
  yesterdayCount: number;
  previousDayCount: number;
  affected: Set<string>;
  groups: Set<LogicalMessageGroup>;
  previewFailures: number;
}

/** 上海业务日 00:00 对应的 UTC 时刻（ADR-028：UTC+8，无夏令时）。 */
export function shanghaiDayStart(value: Date): Date {
  const shifted = new Date(value.getTime() + SHANGHAI_OFFSET_MS);
  return new Date(
    Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()) - SHANGHAI_OFFSET_MS,
  );
}

/** 指定触发时刻对应的昨日自然日窗口。 */
export function outboxDailyDigestWindow(reportAt: Date): DigestWindow {
  const to = shanghaiDayStart(reportAt);
  return { from: new Date(to.getTime() - DAY_MS), to };
}

/** 重复问题回看窗口：截至昨日共 7 个自然日（昨日及前 6 天）。 */
export function outboxDailyDigestHistoryFrom(windowFrom: Date): Date {
  return new Date(windowFrom.getTime() - (DAILY_DIGEST_HISTORY_DAYS - 1) * DAY_MS);
}

/**
 * 首次注册时的 run_at：当天 08:00。若在 08:00 后首次部署，任务立即到期并由处理器决定是否在 12:00 前补发；
 * 不把首次注册时间作为日报窗口，避免部署时刻改变统计区间。
 */
export function outboxDailyDigestRegistrationRunAt(now: Date): Date {
  return new Date(shanghaiDayStart(now).getTime() + 8 * 3_600_000);
}

export function shanghaiDateKey(value: Date): string {
  return new Date(value.getTime() + SHANGHAI_OFFSET_MS).toISOString().slice(0, 10);
}

export function formatShanghaiDate(value: Date): string {
  return shanghaiDateKey(value);
}

export function formatShanghaiDateTime(value: Date): string {
  const shifted = new Date(value.getTime() + SHANGHAI_OFFSET_MS);
  return shifted.toISOString().slice(0, 16).replace("T", " ");
}

export function formatDailyDigestRange(reportAt: Date): string {
  const window = outboxDailyDigestWindow(reportAt);
  return formatShanghaiDate(window.from) + " 00:00–24:00（北京时间）";
}

/** 即时告警的不可投递原因：不进入日报明细，也不计入日报通知总数。 */
export function isInstantOnlyDeliveryError(error: string | null | undefined): boolean {
  if (error === null || error === undefined) {
    return false;
  }
  return (
    error.includes("收件人未绑定企业微信") ||
    error.includes("项目群未绑定") ||
    error.includes("群未绑定") ||
    error.includes("机器人尚未激活") ||
    error.includes("机器人未激活")
  );
}

/** 构建日报。输入已按近 7 个自然日读取；本函数不触库、不取系统时间。 */
export function buildDailyDigest(input: BuildDailyDigestInput): OutboxDailyDigest {
  const window = outboxDailyDigestWindow(input.reportAt);
  const groups = groupLogicalMessages(input.data.messages);
  const deliveryGroups = groups.filter(
    (group) =>
      !group.excluded &&
      group.createdAt.getTime() >= window.from.getTime() &&
      group.createdAt.getTime() < window.to.getTime(),
  );

  const delivery = {
    total: deliveryGroups.length,
    delivered: 0,
    retrying: 0,
    failed: 0,
    lateDelivered: 0,
    maxLatencyMs: null as number | null,
  };
  for (const group of deliveryGroups) {
    delivery[group.state] += 1;
    if (group.state === "delivered" && group.sentAt !== null) {
      const latencyMs = Math.max(0, group.sentAt.getTime() - group.createdAt.getTime());
      if (latencyMs > DAILY_DIGEST_LATE_DELIVERY_MS) {
        delivery.lateDelivered += 1;
      }
      if (delivery.maxLatencyMs === null || latencyMs > delivery.maxLatencyMs) {
        delivery.maxLatencyMs = latencyMs;
      }
    }
  }

  const fallbackMap = new Map<string, OutboxDailyDigestFallback>();
  const addFallback = (label: string, detail: string): void => {
    const key = label + "\u0000" + detail;
    const existing = fallbackMap.get(key);
    if (existing === undefined) {
      fallbackMap.set(key, { label, detail, count: 1 });
    } else {
      existing.count += 1;
    }
  };

  for (const group of deliveryGroups) {
    if (group.copyRows.some((row) => row.lastState === "sent") && group.baseRows.some((row) => row.lastState === "dead")) {
      const originalError = group.baseRows.find((row) => row.lastState === "dead")?.lastError ?? null;
      const fallback = classifyNotifyFallback(originalError);
      addFallback(fallback.label, fallback.detail);
    }
  }

  const issues = collectRepeatedIssues(groups, input.data, window);
  for (const preview of input.data.previewDeaths) {
    if (preview.updatedAt.getTime() < window.from.getTime() || preview.updatedAt.getTime() >= window.to.getTime()) {
      continue;
    }
    const fallback = classifyPreviewFallback(preview.lastError);
    if (fallback !== null) {
      addFallback(fallback.label, fallback.detail);
    }
  }

  const automaticFallbacks = [...fallbackMap.values()]
    .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label, "zh-CN"))
    .slice(0, 6);

  const recoveryCounts = new Map<string, number>();
  for (const recovery of input.recoveries ?? []) {
    const recoveryAt = Date.parse(recovery.at);
    if (
      !Number.isFinite(recoveryAt) ||
      recoveryAt < window.from.getTime() ||
      recoveryAt >= window.to.getTime()
    ) {
      continue;
    }
    // 项目群不可投递 / 恢复属于即时告警闭环，不进入日报。
    if (recovery.code === "notify.project_group.recovered") {
      continue;
    }
    recoveryCounts.set(recovery.code, (recoveryCounts.get(recovery.code) ?? 0) + 1);
  }
  const byCode = [...recoveryCounts.entries()]
    .map(([code, count]) => ({ code: code as OutboxRecoveryCode, count }))
    .sort((left, right) => right.count - left.count || left.code.localeCompare(right.code));

  return {
    generatedAt: input.generatedAt.toISOString(),
    reportAt: input.reportAt.toISOString(),
    windowFrom: window.from.toISOString(),
    windowTo: window.to.toISOString(),
    delivery,
    automaticFallbacks,
    repeatedIssues: issues.slice(0, 5),
    recoveries: {
      total: byCode.reduce((sum, item) => sum + item.count, 0),
      byCode,
    },
  };
}

function groupLogicalMessages(messages: readonly DailyDigestMessageRecord[]): LogicalMessageGroup[] {
  const grouped = new Map<string, DailyDigestMessageRecord[]>();
  for (const message of messages) {
    const key = logicalMessageKey(message);
    const rows = grouped.get(key);
    if (rows === undefined) {
      grouped.set(key, [message]);
    } else {
      rows.push(message);
    }
  }

  const result: LogicalMessageGroup[] = [];
  for (const [key, rows] of grouped) {
    rows.sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime() || left.id - right.id);
    const copyRows = rows.filter(isC504Copy);
    const baseRows = rows.filter((row) => !isC504Copy(row));
    const basis = (baseRows.length > 0 ? baseRows : rows)[0]!;
    const sentRows = rows
      .filter((row) => row.lastState === "sent" && row.sentAt !== null)
      .sort((left, right) => left.sentAt!.getTime() - right.sentAt!.getTime());
    const state: LogicalMessageGroup["state"] =
      sentRows.length > 0
        ? "delivered"
        : rows.some((row) => row.lastState === "pending" || row.lastState === "failed" || row.lastState === "deferred")
          ? "retrying"
          : "failed";
    result.push({
      key,
      rows,
      baseRows,
      copyRows,
      createdAt: basis.createdAt,
      state,
      sentAt: sentRows[0]?.sentAt ?? null,
      excluded: rows.some((row) => isInstantOnlyDeliveryError(row.lastError)),
    });
  }
  return result.sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime() || left.key.localeCompare(right.key));
}

function logicalMessageKey(row: DailyDigestMessageRecord): string {
  const source = row.metadata["sourceDedupeKey"];
  if (isC504Copy(row) && typeof source === "string" && source.trim() !== "") {
    return source.trim();
  }
  return isC504Copy(row) ? row.sourceDedupeKey.slice(0, -5) : row.sourceDedupeKey;
}

function isC504Copy(row: DailyDigestMessageRecord): boolean {
  return row.metadata["c5_04"] === true || row.sourceDedupeKey.endsWith(":c504");
}

function collectRepeatedIssues(
  groups: readonly LogicalMessageGroup[],
  data: DailyDigestSourceData,
  window: DigestWindow,
): OutboxDailyDigestRepeatedIssue[] {
  const groupByMessageId = new Map<number, LogicalMessageGroup>();
  for (const group of groups) {
    for (const row of group.rows) {
      groupByMessageId.set(row.id, group);
    }
  }

  const yesterdayKey = shanghaiDateKey(window.from);
  const previousDayKey = shanghaiDateKey(new Date(window.from.getTime() - DAY_MS));
  const issues = new Map<string, IssueAccumulator>();

  const accumulatorOf = (label: string): IssueAccumulator => {
    const existing = issues.get(label);
    if (existing !== undefined) return existing;
    const created: IssueAccumulator = {
      label,
      days: new Set<string>(),
      yesterdayCount: 0,
      previousDayCount: 0,
      affected: new Set<string>(),
      groups: new Set<LogicalMessageGroup>(),
      previewFailures: 0,
    };
    issues.set(label, created);
    return created;
  };

  for (const attempt of data.attempts) {
    if (attempt.messageId === null) {
      continue;
    }
    const group = groupByMessageId.get(attempt.messageId);
    if (group === undefined || group.excluded) {
      continue;
    }
    const issue = classifyOperationalIssue(attempt.error, false);
    if (issue === null) {
      continue;
    }
    const accumulator = accumulatorOf(issue.label);
    const dayKey = shanghaiDateKey(attempt.createdAt);
    accumulator.days.add(dayKey);
    if (dayKey === yesterdayKey) accumulator.yesterdayCount += 1;
    if (dayKey === previousDayKey) accumulator.previousDayCount += 1;
    accumulator.affected.add(group.key);
    accumulator.groups.add(group);
  }

  for (const preview of data.previewDeaths) {
    if (classifyPreviewFallback(preview.lastError) !== null) {
      continue;
    }
    const issue = classifyOperationalIssue(preview.lastError, true);
    if (issue === null) {
      continue;
    }
    const accumulator = accumulatorOf(issue.label);
    const dayKey = shanghaiDateKey(preview.updatedAt);
    accumulator.days.add(dayKey);
    if (dayKey === yesterdayKey) accumulator.yesterdayCount += 1;
    if (dayKey === previousDayKey) accumulator.previousDayCount += 1;
    accumulator.previewFailures += 1;
    accumulator.affected.add("preview:" + String(preview.id));
  }

  return [...issues.values()]
    .filter((issue) => issue.days.size >= 2 || issue.yesterdayCount >= 2)
    .map((issue) => ({
      label: issue.label,
      yesterdayCount: issue.yesterdayCount,
      previousDayCount: issue.previousDayCount,
      consecutiveDays: consecutiveDaysEndingYesterday(issue.days, yesterdayKey),
      affectedMessages: issue.affected.size,
      outcome: issueOutcome(issue),
    }))
    .sort(
      (left, right) =>
        right.yesterdayCount - left.yesterdayCount ||
        right.consecutiveDays - left.consecutiveDays ||
        right.previousDayCount - left.previousDayCount ||
        left.label.localeCompare(right.label, "zh-CN"),
    );
}

function consecutiveDaysEndingYesterday(days: ReadonlySet<string>, yesterdayKey: string): number {
  let count = 0;
  let cursor = shanghaiDayStart(new Date(yesterdayKey + "T00:00:00Z"));
  while (days.has(shanghaiDateKey(cursor))) {
    count += 1;
    cursor = new Date(cursor.getTime() - DAY_MS);
  }
  return count;
}

function issueOutcome(issue: IssueAccumulator): OutboxDailyDigestRepeatedIssue["outcome"] {
  let outcome: OutboxDailyDigestRepeatedIssue["outcome"] = issue.previewFailures > 0 ? "failed" : "recovered";
  for (const group of issue.groups) {
    if (group.state === "failed") return "failed";
    if (group.state === "retrying") outcome = "retrying";
  }
  return outcome;
}

interface ErrorClass {
  label: string;
}

/** 重复问题的可读归类；unknown 技术错误不进入日报，避免把噪声当运营问题。 */
export function classifyOperationalIssue(error: string | null | undefined, preview: boolean): ErrorClass | null {
  if (error === null || error === undefined || error.trim() === "") {
    return null;
  }
  if (/限速|频率超限|errcode=45009|errcode=846607/i.test(error)) {
    return { label: "企业微信限速" };
  }
  if (/超时|timeout/i.test(error)) {
    return { label: preview ? "文件预览超时" : "消息发送超时" };
  }
  if (/长连接|未订阅|846609|连接.*(断开|失败|未就绪)|network/i.test(error)) {
    return { label: "企业微信连接暂不可用" };
  }
  if (/系统繁忙|errcode=-1/i.test(error)) {
    return { label: "企业微信服务繁忙" };
  }
  if (/存储|S3|对象存储/i.test(error)) {
    return { label: "文件存储读取异常" };
  }
  return null;
}

/** 已知确定性预览拒绝：已自动降级为“请下载查看”，无需管理员逐条处理。 */
export function classifyPreviewFallback(
  error: string | null | undefined,
): Pick<OutboxDailyDigestFallback, "label" | "detail"> | null {
  if (error === null || error === undefined || error.trim() === "") {
    return null;
  }
  if (/事件属性/i.test(error)) {
    return { label: "文件预览不支持", detail: "SVG 事件属性已拒绝，已提示下载查看" };
  }
  if (/structured 通道.*未启用/i.test(error)) {
    return { label: "文件预览不支持", detail: "结构化预览通道未启用，已提示下载查看" };
  }
  if (/不支持在线预览/i.test(error)) {
    return { label: "文件预览不支持", detail: "文件类型暂不支持在线预览，已提示下载查看" };
  }
  if (/只接受.*SVG/i.test(error)) {
    return { label: "文件预览不支持", detail: "图片预览源文件类型不受支持，已提示下载查看" };
  }
  if (/超过预览转换上限|超过预览上限|超过.*大小限制/i.test(error)) {
    return { label: "文件超过预览上限", detail: "已提示下载查看" };
  }
  if (/SHA-256|PNG|栅格化.*模式|Content-Type.*不是 image\/png|已拒绝/i.test(error)) {
    return { label: "文件预览安全检查未通过", detail: "预览产物安全校验未通过，已提示下载查看" };
  }
  return null;
}

function classifyNotifyFallback(error: string | null | undefined): Pick<OutboxDailyDigestFallback, "label" | "detail"> {
  if (error !== null && error !== undefined && /invalid action|载荷非法/i.test(error)) {
    return { label: "通知载荷被拒绝", detail: "已自动转为站内信" };
  }
  return { label: "企业微信未送达", detail: "已自动转为站内信" };
}
