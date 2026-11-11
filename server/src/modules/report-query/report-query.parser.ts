import {
  reportQueryTopics,
  type ReportQueryCommand,
  type ReportQueryParseOptions,
  type ReportQueryParseResult,
  type ReportQueryTopic,
} from "./report-query.types.js";

/** 命令关键词；查询候选 = 去除 @ 提及后的正文以“查询”开头。 */
const QUERY_KEYWORD = "查询";

/** 主题按最长优先匹配，避免“日报和问题”被识别成“日报”。 */
const TOPICS: ReadonlyArray<{ label: string; topic: ReportQueryTopic }> = [
  { label: "日报和问题", topic: reportQueryTopics.both },
  { label: "问题", topic: reportQueryTopics.issues },
  { label: "日报", topic: reportQueryTopics.reports },
];

/**
 * 去除回调正文开头的 @ 提及：支持 `<@...>` 与 `@LibiaoLink` 等 token。
 * 只去除开头连续提及；正文中其它位置保持不变。
 */
export function normalizeReportQueryText(text: string): string {
  let value = text.normalize("NFKC").replace(/\r\n?/gu, "\n").trim();
  for (;;) {
    const next = value.replace(/^(?:<@[^>]*>|@\S+)\s*/u, "");
    if (next === value) return value;
    value = next.trimStart();
  }
}

/** 是否为查询候选（不判断语法是否完整；语法错误也要由查询链路回复帮助）。 */
export function isReportQueryText(text: string | null | undefined): boolean {
  if (text === null || text === undefined) return false;
  return normalizeReportQueryText(text).startsWith(QUERY_KEYWORD);
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function isValidDate(year: number, month: number, day: number): boolean {
  if (year < 1000 || year > 9999 || month < 1 || month > 12 || day < 1 || day > 31) return false;
  const at = new Date(Date.UTC(year, month - 1, day));
  return at.getUTCFullYear() === year && at.getUTCMonth() === month - 1 && at.getUTCDate() === day;
}

function toIsoDate(year: number, month: number, day: number): string | null {
  if (!isValidDate(year, month, day)) return null;
  return String(year).padStart(4, "0") + "-" + pad2(month) + "-" + pad2(day);
}

function shiftIsoDate(date: string, days: number): string {
  const [yearText, monthText, dayText] = date.split("-");
  const at = new Date(Date.UTC(Number(yearText), Number(monthText) - 1, Number(dayText) + days));
  return at.toISOString().slice(0, 10);
}

interface ProjectToken {
  value: string;
  rest: string;
}

type ProjectTokenResult = { ok: true; token: ProjectToken } | { ok: false; reason: "unclosed_quote" | "missing_project" };

function readProjectToken(text: string): ProjectTokenResult {
  const input = text.trimStart();
  if (input === "") return { ok: false, reason: "missing_project" };
  const first = input[0];
  if (first === '"' || first === "“") {
    const close = first === "“" ? "”" : '"';
    const end = input.indexOf(close, 1);
    if (end < 0) return { ok: false, reason: "unclosed_quote" };
    const value = input.slice(1, end).trim();
    if (value === "") return { ok: false, reason: "missing_project" };
    return { ok: true, token: { value, rest: input.slice(end + 1).trimStart() } };
  }
  const matched = /^\S+/u.exec(input);
  if (matched === null) return { ok: false, reason: "missing_project" };
  return { ok: true, token: { value: matched[0], rest: input.slice(matched[0].length).trimStart() } };
}

function startsDateOrTopic(text: string): boolean {
  const input = text.trimStart();
  if (TOPICS.some(({ label }) => input === label)) return true;
  const relative = /^(?:今天|昨天|前天)/u.exec(input);
  const absolute = /^(?:\d{4}-\d{1,2}-\d{1,2}|\d{4}\/\d{1,2}\/\d{1,2}|\d{4}年\d{1,2}月\d{1,2}日)/u.exec(input);
  const matched = relative ?? absolute;
  if (matched === null) return false;
  const rest = input.slice(matched[0].length).trimStart();
  return rest === "" || TOPICS.some(({ label }) => rest === label);
}

interface DatePrefixResult {
  date: string;
  rest: string;
}

type DatePrefixParseResult =
  | { ok: true; value: DatePrefixResult }
  | { ok: false; reason: "invalid_date" | "future_date" };

function parseDatePrefix(text: string, today: string): DatePrefixParseResult {
  const input = text.trimStart();
  const relative: ReadonlyArray<{ label: string; days: number }> = [
    { label: "今天", days: 0 },
    { label: "昨天", days: -1 },
    { label: "前天", days: -2 },
  ];
  for (const item of relative) {
    if (input.startsWith(item.label)) {
      return {
        ok: true,
        value: { date: shiftIsoDate(today, item.days), rest: input.slice(item.label.length).trimStart() },
      };
    }
  }

  const patterns: ReadonlyArray<RegExp> = [
    /^(\d{4})-(\d{1,2})-(\d{1,2})/u,
    /^(\d{4})\/(\d{1,2})\/(\d{1,2})/u,
    /^(\d{4})年(\d{1,2})月(\d{1,2})日/u,
  ];
  for (const pattern of patterns) {
    const matched = pattern.exec(input);
    if (matched === null) continue;
    const year = Number(matched[1]);
    const month = Number(matched[2]);
    const day = Number(matched[3]);
    const date = toIsoDate(year, month, day);
    if (date === null) return { ok: false, reason: "invalid_date" };
    if (date > today) return { ok: false, reason: "future_date" };
    return { ok: true, value: { date, rest: input.slice(matched[0].length).trimStart() } };
  }
  return { ok: true, value: { date: today, rest: input } };
}

function parseTopic(text: string): { topic: ReportQueryTopic; rest: string } {
  const input = text.trim();
  if (input === "") return { topic: reportQueryTopics.both, rest: "" };
  for (const item of TOPICS) {
    if (input === item.label) return { topic: item.topic, rest: "" };
  }
  return { topic: reportQueryTopics.both, rest: input };
}

/**
 * 解析 `查询 [项目] <编号或名称> [日期] [日报|问题|日报和问题]`。
 * 日期固定按参数 today（Asia/Shanghai 业务日）解释；未来日期与非法日历日期拒绝。
 */
export function parseReportQuery(text: string, options: ReportQueryParseOptions): ReportQueryParseResult {
  const normalized = normalizeReportQueryText(text);
  if (!normalized.startsWith(QUERY_KEYWORD)) return { ok: false, reason: "not_query" };

  const remainder = normalized.slice(QUERY_KEYWORD.length).trim();
  let projectReference: string | null = null;
  let afterProject = remainder;

  if (/^项目(?:\s+|$)/u.test(remainder)) {
    const withoutMarker = remainder.replace(/^项目(?:\s+|$)/u, "").trimStart();
    const project = readProjectToken(withoutMarker);
    if (!project.ok) return { ok: false, reason: project.reason };
    projectReference = project.token.value;
    afterProject = project.token.rest;
  } else if (remainder !== "" && !startsDateOrTopic(remainder)) {
    const project = readProjectToken(remainder);
    if (!project.ok) return { ok: false, reason: project.reason };
    projectReference = project.token.value;
    afterProject = project.token.rest;
  }

  if (options.requireProject && projectReference === null) return { ok: false, reason: "missing_project" };

  const date = parseDatePrefix(afterProject, options.today);
  if (!date.ok) return date;
  const topic = parseTopic(date.value.rest);
  if (topic.rest !== "") return { ok: false, reason: "unexpected_tail" };

  const command: ReportQueryCommand = {
    projectReference,
    date: date.value.date,
    topic: topic.topic,
  };
  return { ok: true, command };
}
