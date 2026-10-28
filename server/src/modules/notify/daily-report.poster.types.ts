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
