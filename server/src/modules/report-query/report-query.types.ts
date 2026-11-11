/** 日报查询主题：日报、问题或两者。 */
export type ReportQueryTopic = "reports" | "issues" | "both";

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
