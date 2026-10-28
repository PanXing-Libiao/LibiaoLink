import {
  DAILY_REPORT_STATES,
  DailyReportListQuerySchema,
  ISSUE_CATEGORIES,
  ISSUE_STATES,
  IssueListQuerySchema,
  z,
} from "@libiaolink/contracts";
import { AppError } from "../../common/errors/app-error.js";

/**
 * 日报 / 问题纯规则（M6-01 ~ M6-03 · A3）。
 * 口径来源：系统功能书.md A3-02（草稿 / 提交 / 补填 / 同日多条）、A3-04（提交校验）、A3-09（问题自动生成幂等）、
 * A3-10（三态与回退）、A3-11（归类十项多值）、A3-12（按归类自动分派责任部门）。
 * Push 215：A3-08 回写停用（progressMarker 删除）；A3-14 处理时限删除；归类单值 → 多值。
 */

export type DailyReportState = "draft" | "submitted" | "supplement";
export type DailyReportWriteState = "draft" | "submitted";

/** 归类 → 责任部门（A3-12 一期口径）：归类本身为部门名的直接照抄；原因类不自动落到具体部门（null = 待分派）。 */
const DEPARTMENT_BY_CATEGORY: Record<string, string> = {
  机械部: "机械部",
  采购部: "采购部",
  规划部: "规划部",
  项目部: "项目部",
};

/** 多值归类 → 责任部门（A3-12 一期口径）：取第一个能映射到部门的归类；一个都映射不上 = 待分派（null）。 */
export function departmentOfCategories(categories: readonly string[]): string | null {
  for (const category of categories) {
    const department = DEPARTMENT_BY_CATEGORY[category];
    if (department !== undefined) return department;
  }
  return null;
}

/** 写入状态 + 日期 → 落库状态（A3-02）：草稿恒 draft；提交当天 = submitted；提交过去日期 = supplement（补填）。 */
export function resolveReportState(writeState: DailyReportWriteState, reportDate: string, today: string): DailyReportState {
  if (writeState === "draft") return "draft";
  return reportDate < today ? "supplement" : "submitted";
}

/** A3-04 时间口径：只允许填报当天或补填过去日期，未来日期 400。 */
export function isFutureDate(reportDate: string, today: string): boolean {
  return reportDate > today;
}

/** A3-02 状态回退：已提交 / 补填行不允许退回草稿（一人一天一条的口径下，草稿态本身没有历史）。 */
export function assertReportStateWrite(current: string, next: DailyReportWriteState | undefined): void {
  if (next === "draft" && current !== "draft") {
    throw new AppError("VALIDATION_FAILED", "已提交的日报不允许退回草稿（A3-02）", [
      { code: "invalid_state", message: "当前状态：" + current, path: "state" },
    ]);
  }
}

/** 多值筛选（逗号分隔）→ 数组；空串 / 缺省 = null（不筛选）。 */
export function splitMulti(value: string | undefined): string[] | null {
  if (value === undefined) return null;
  const parts = value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return parts.length > 0 ? parts : null;
}

function assertEnum(values: string[] | null, allowed: readonly string[], label: string): string[] | null {
  if (values === null) return null;
  for (const value of values) {
    if (!allowed.includes(value)) {
      throw new AppError("VALIDATION_FAILED", label + " 取值非法：" + value, [
        { code: "invalid_enum", message: "允许值：" + allowed.join(" / "), path: label },
      ]);
    }
  }
  return values;
}

/** 日报列表筛选（A7-02 子集）：日期闭区间 + 状态 + 提交人；dateFrom > dateTo → 400。 */
export interface DailyReportFilter {
  dateFrom: string | null;
  dateTo: string | null;
  states: string[] | null;
  authorId: string | null;
}

export type DailyReportListQuery = z.infer<typeof DailyReportListQuerySchema>;
export type IssueListQuery = z.infer<typeof IssueListQuerySchema>;

export function parseReportFilter(query: DailyReportListQuery): DailyReportFilter {
  const dateFrom = query["filter[dateFrom]"] ?? null;
  const dateTo = query["filter[dateTo]"] ?? null;
  if (dateFrom !== null && dateTo !== null && dateFrom > dateTo) {
    throw new AppError("VALIDATION_FAILED", "日期区间非法：dateFrom 晚于 dateTo", [
      { code: "invalid_range", message: "要求 dateFrom <= dateTo", path: "filter[dateFrom]" },
    ]);
  }
  return {
    dateFrom,
    dateTo,
    states: assertEnum(splitMulti(query["filter[state]"]), DAILY_REPORT_STATES, "filter[state]"),
    authorId: query["filter[authorId]"] ?? null,
  };
}

/** 问题列表筛选（A3-16 问题追踪 / 问题看板同源）：状态 / 归类 / 任务 / 来源日报 + 关键字。 */
export interface IssueFilter {
  states: string[] | null;
  categories: string[] | null;
  taskId: string | null;
  reportId: string | null;
  keyword: string | null;
}

export function parseIssueFilter(query: IssueListQuery): IssueFilter {
  return {
    states: assertEnum(splitMulti(query["filter[state]"]), ISSUE_STATES, "filter[state]"),
    // 多值归类筛选：命中任一即入选（数组重叠 &&），单值输入等价于「包含该值」。
    categories: assertEnum(splitMulti(query["filter[category]"]), ISSUE_CATEGORIES, "filter[category]"),
    taskId: query["filter[taskId]"] ?? null,
    reportId: query["filter[reportId]"] ?? null,
    keyword: query.q === undefined || query.q.trim().length === 0 ? null : query.q.trim(),
  };
}

/**
 * 日报群同步正文：首行状态 + 次行纯文字 Markdown 链接（企业微信只显示链接文字，不显示 URL）。
 * 深链沿用前端 `projectFocusHref` 口径：必须带 `report` 参数才能在「日报记录」中定位到该条日报。
 */
export function buildDailyReportGroupBody(input: {
  publicBaseUrl: string;
  projectId: string;
  projectName: string;
  reportId: string;
  reportDate: string;
}): string {
  const base = input.publicBaseUrl.trim().replace(/\/+$/u, "");
  if (base === "") throw new Error("PUBLIC_APP_BASE_URL 不能为空");
  const label = (input.projectName.replace(/\s+/gu, " ").trim() + input.reportDate + "的日报记录")
    .replace(/\\/gu, "\\\\")
    .replace(/\[/gu, "\\[")
    .replace(/\]/gu, "\\]");
  const url =
    base +
    "/#/project/" +
    encodeURIComponent(input.projectId) +
    "?view=daily&report=" +
    encodeURIComponent(input.reportId);
  return "日报已送达\n[" + label + "](" + url + ")";
}

