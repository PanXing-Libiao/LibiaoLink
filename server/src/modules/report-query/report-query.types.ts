/** 日报查询主题取值；集中定义，避免查询主题被误认作 outbox 主题字面量。 */
export const reportQueryTopics = {
  reports: "reports",
  issues: "issues",
  both: "both",
} as const;

/** 日报查询主题：日报、问题或两者。 */
export type ReportQueryTopic = (typeof reportQueryTopics)[keyof typeof reportQueryTopics];

/** 解析后的命令；项目为空仅允许群聊使用群绑定项目。 */
export interface ReportQueryCommand {
  projectReference: string | null;
  date: string;
  topic: ReportQueryTopic;
}

export type ReportQueryParseError =
  | "not_query"
  | "missing_project"
  | "unclosed_quote"
  | "invalid_date"
  | "future_date"
  | "unexpected_tail";

export type ReportQueryParseResult =
  | { ok: true; command: ReportQueryCommand }
  | { ok: false; reason: ReportQueryParseError };

export interface ReportQueryParseOptions {
  /** Asia/Shanghai 业务日 YYYY-MM-DD。 */
  today: string;
  /** 单聊必须显式指定项目；群聊可省略并使用群绑定项目。 */
  requireProject: boolean;
}
