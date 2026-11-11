import type { ProjectReferenceRow } from "../project/index.js";
import type { ReportDigestIssue, ReportDigestProject, ReportDigestReport } from "../report-issue/index.js";
import { applyMarkdownHardBreaks } from "../notify/index.js";
import type { ReportQueryTopic } from "./report-query.types.js";

/** 列表被字节预算截断时的提示；主深链在列表之前，始终保留。 */
export const REPORT_QUERY_LIST_TRUNCATION_SUFFIX = "\n\n…（更多日报请点击上方主深链查看）";

export const REPORT_QUERY_HELP = [
  "请按以下格式发送查询：",
  "查询 [项目] <项目编号或项目名称> [日期] [日报|问题|日报和问题]",
  "",
  "示例：",
  "查询 项目 PRJ-001 昨天日报和问题",
  '查询 "临港数据中心" 2026-11-10 日报',
  "查询 昨天问题",
  "",
  "日期支持：今天、昨天、前天、YYYY-MM-DD、YYYY/MM/DD、YYYY年M月D日。",
  "项目名称含空格时须使用引号；单聊必须指定项目，群聊可省略并使用群绑定项目。",
].join("\n");

export const REPORT_QUERY_PROJECT_UNAVAILABLE = "项目不存在或你无权查看。";
export const REPORT_QUERY_GROUP_PROJECT_ONLY = "本群仅支持查询已绑定项目。";
export const REPORT_QUERY_GROUP_NOT_BOUND = "本群尚未绑定项目，请到「企微绑定」页选择项目群完成绑定。";
export const REPORT_QUERY_ISSUE_UNAVAILABLE = "你无权查看该项目的问题。";
export const REPORT_QUERY_UNAVAILABLE = "查询暂时不可用，请稍后重试。";

/** 发送人未完成单聊绑定时的统一指引（单聊 / 群聊共用身份口径）。 */
export const REPORT_QUERY_DM_UNBOUND =
  "你尚未绑定 LibiaoLink 账号，请先在企业微信私聊机器人，按「设置 > 企微绑定」的提示完成绑定后再查询。";

/** 动态文本进入 Markdown 前统一压缩为单行并转义。 */
export function escapeReportQueryMarkdown(value: string): string {
  const singleLine = value.replace(/\s+/gu, " ").trim();
  return singleLine.replace(/\\/gu, "\\\\").replace(/([*_`\[\]])/gu, "\\$1");
}

function formatShanghaiTime(value: string | null): string {
  if (value === null) return "时间未知";
  const at = Date.parse(value);
  if (Number.isNaN(at)) return "时间未知";
  return new Date(at + 8 * 3_600_000).toISOString().slice(11, 16);
}

function baseUrl(value: string): string {
  return value.trim().replace(/\/+$/u, "");
}

function reportUrl(input: { publicBaseUrl: string; projectId: string; date: string; reportId: string }): string {
  return (
    baseUrl(input.publicBaseUrl) +
    "/#/project/" +
    encodeURIComponent(input.projectId) +
    "?view=daily&date=" +
    encodeURIComponent(input.date) +
    "&report=" +
    encodeURIComponent(input.reportId)
  );
}

function reportDayUrl(input: { publicBaseUrl: string; projectId: string; date: string }): string {
  return (
    baseUrl(input.publicBaseUrl) +
    "/#/project/" +
    encodeURIComponent(input.projectId) +
    "?view=daily&date=" +
    encodeURIComponent(input.date)
  );
}

function issueDayUrl(input: { publicBaseUrl: string; projectId: string; date: string }): string {
  return (
    baseUrl(input.publicBaseUrl) +
    "/#/project/" +
    encodeURIComponent(input.projectId) +
    "?view=daily&sub=issues&date=" +
    encodeURIComponent(input.date)
  );
}

/** 查询项目名称重名：只返回可见候选编号与名称，不返回业务数据。 */
export function buildAmbiguousProjectMessage(
  reference: string,
  candidates: readonly Pick<ProjectReferenceRow, "code" | "name">[],
): string {
  const shown = candidates.slice(0, 20);
  const lines = [
    "项目名称「" + escapeReportQueryMarkdown(reference) + "」匹配到 " + String(candidates.length) + " 个可见项目，请使用编号查询：",
    ...shown.map(
      (project, index) =>
        String(index + 1) +
        ". " +
        escapeReportQueryMarkdown(project.code) +
        "（" +
        escapeReportQueryMarkdown(project.name) +
        "）",
    ),
  ];
  if (candidates.length > shown.length) {
    lines.push("…另有 " + String(candidates.length - shown.length) + " 个项目，请登录系统查看。");
  }
  return lines.join("\n");
}

export interface ReportQueryTextInput {
  project: ReportDigestProject;
  date: string;
  reports: readonly ReportDigestReport[];
  draftCount: number;
  issues: readonly ReportDigestIssue[];
  topic: ReportQueryTopic;
  canViewIssues: boolean;
  publicBaseUrl: string;
  maxBytes: number;
}

function countLine(input: ReportQueryTextInput, includeReports: boolean, includeIssues: boolean): string {
  const segments: string[] = [];
  if (includeReports) {
    const supplements = input.reports.filter((report) => report.state === "supplement").length;
    let reports = "已提交日报 " + String(input.reports.length) + " 篇";
    if (supplements > 0) reports += "（其中补填 " + String(supplements) + " 篇）";
    reports += "，草稿 " + String(input.draftCount) + " 篇";
    segments.push(reports);
  }
  if (includeIssues) segments.push("问题 " + String(input.issues.length) + " 条");
  return segments.join("；");
}

function reportEntry(input: ReportQueryTextInput, report: ReportDigestReport, index: number): string {
  const details = [
    escapeReportQueryMarkdown(report.authorName ?? "未知填写者"),
    formatShanghaiTime(report.submittedAt),
    report.state === "supplement" ? "补填" : null,
  ].filter((value): value is string => value !== null);
  return (
    String(index + 1) +
    ". " +
    details.join(" · ") +
    " · [打开该篇日报](" +
    reportUrl({
      publicBaseUrl: input.publicBaseUrl,
      projectId: input.project.id,
      date: input.date,
      reportId: report.id,
    }) +
    ")"
  );
}

/**
 * 组装查询文字：项目、日期、数量与主深链优先；逐篇列表按 UTF-8 字节预算追加。
 * 无 issue.view 时调用方传 canViewIssues=false，本函数不输出任何问题信息。
 */
export function buildReportQueryText(input: ReportQueryTextInput): string {
  const includeReports = input.topic !== "issues";
  const includeIssues = input.topic !== "reports" && input.canViewIssues;
  const heading = [
    "**项目日报查询 · " + input.date + "**",
    "项目：" +
      escapeReportQueryMarkdown(input.project.name) +
      "（" +
      escapeReportQueryMarkdown(input.project.code) +
      "）",
    countLine(input, includeReports, includeIssues),
  ].join("\n");

  const links: string[] = [];
  if (includeReports) {
    const single = input.reports.length === 1 ? input.reports[0] : undefined;
    const href =
      single === undefined
        ? reportDayUrl({ publicBaseUrl: input.publicBaseUrl, projectId: input.project.id, date: input.date })
        : reportUrl({
            publicBaseUrl: input.publicBaseUrl,
            projectId: input.project.id,
            date: input.date,
            reportId: single.id,
          });
    links.push("[" + (single === undefined ? "查看当天全部日报" : "查看当天日报") + "](" + href + ")");
  }
  if (includeIssues) {
    links.push(
      "[查看当天问题](" +
        issueDayUrl({ publicBaseUrl: input.publicBaseUrl, projectId: input.project.id, date: input.date }) +
        ")",
    );
  }

  const empty: string[] = [];
  if (includeReports && input.reports.length === 0) empty.push("当天暂无已提交日报。");
  if (includeIssues && input.issues.length === 0) empty.push("当天暂无问题。");

  const entries = includeReports ? input.reports.map((report, index) => reportEntry(input, report, index)) : [];
  const render = (entryCount: number): string => {
    const sections = [heading, links.join("\n")];
    if (empty.length > 0) sections.push(empty.join(" "));
    if (entryCount > 0) sections.push(entries.slice(0, entryCount).join("\n"));
    if (entryCount < entries.length) sections.push(REPORT_QUERY_LIST_TRUNCATION_SUFFIX.trim());
    return applyMarkdownHardBreaks(sections.filter((section) => section !== "").join("\n\n"));
  };

  let rendered = render(0);
  for (let count = 1; count <= entries.length; count += 1) {
    const candidate = render(count);
    if (Buffer.byteLength(candidate, "utf8") > input.maxBytes) break;
    rendered = candidate;
  }
  return rendered;
}
