/** report-issue 模块唯一公开出口（跨模块只允许 import 本文件）。 */
export { ReportIssueModule } from "./report-issue.module.js";
export { ReportService } from "./report.service.js";
export { ReportSummaryService } from "./report-summary.service.js";
export { IssueService } from "./issue.service.js";
export { departmentOfCategories, resolveReportState } from "./report-issue.rules.js";
export { loadIssuePhotos } from "./report-issue.links.js";
export type { FilePhotoRefRow } from "./report-issue.links.js";
export type { DailyReportFilter, DailyReportListQuery, IssueFilter, IssueListQuery } from "./report-issue.rules.js";
export type { DailyReportPatch, DailyReportRow } from "./report.repository.js";
export type { IssueEventRow, IssuePatch, IssueRow } from "./issue.repository.js";
