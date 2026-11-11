/** 日报群同步海报的数据与字体覆盖口径（notify 平台只消费快照，不反向依赖 report-issue 领域）。 */

export interface DailyReportPosterPhoto {
  fileId: string;
  name: string;
  objectKey: string | null;
  mime: string | null;
}

export interface DailyReportPosterIssue {
  id: string;
  title: string;
  categories: string[];
  ownerName: string | null;
  state: string;
  solution: string | null;
  photos: DailyReportPosterPhoto[];
}

/** 日报合集只读快照；每篇日报最多取首张附件进入缩略图预算。 */
export interface DailyReportDigestReport {
  reportId: string;
  authorName: string | null;
  submittedAt: string | null;
  state: "submitted" | "supplement";
  headcount: number | null;
  stages: string[];
  doneWork: string;
  plan: string | null;
  photos: DailyReportPosterPhoto[];
}

/** 问题合集来源日报摘要；手工登记问题为 null。 */
export interface DailyReportDigestSourceReport {
  id: string;
  authorName: string | null;
  submittedAt: string | null;
}

/** 查询日问题合集快照；每个问题最多取首张附件进入缩略图预算。 */
export interface DailyReportDigestIssue {
  id: string;
  title: string;
  categories: string[];
  ownerName: string | null;
  state: string;
  solution: string | null;
  raisedAt: string;
  sourceReport: DailyReportDigestSourceReport | null;
  photos: DailyReportPosterPhoto[];
}

/** 多篇日报或 0 篇日报时的问题合集输入；草稿只计数，不进入数组。 */
export interface DailyReportDigestPosterData {
  projectId: string;
  projectCode: string;
  projectName: string;
  managers: string[];
  reportDate: string;
  draftCount: number;
  reports: DailyReportDigestReport[];
  issues: DailyReportDigestIssue[];
}

/** 群海报渲染所需的完整快照；图片字节由 service 按 objectKey 读取后另行传入。 */
export interface DailyReportPosterData {
  projectId: string;
  projectCode: string;
  projectName: string;
  managers: string[];
  reportId: string;
  reportDate: string;
  state: string;
  authorName: string | null;
  headcount: number | null;
  doneWork: string;
  plan: string | null;
  stages: string[];
  submittedAt: string | null;
  photos: DailyReportPosterPhoto[];
  issues: DailyReportPosterIssue[];
}

export interface DailyReportPosterFontPaths {
  regular?: string;
  bold?: string;
}
