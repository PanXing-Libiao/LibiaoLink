/**
 * 日报与问题接口封装（Push 216 · M6-01 ~ M6-03 前端接线）。
 * 契约 shared/src/modules/reports.ts / issues.ts（Push 215 修订批）；契约字段 → 界面模型（data/reports.ts）的映射只在本文件做。
 * - 列表：GET /api/v1/projects/{id}/reports｜/issues（一次取满 limit 200）
 * - 写：POST /api/v1/projects/{id}/reports（draft 暂存 / submitted 提交；补填由服务端按日期推导）
 *       PATCH /api/v1/projects/{id}/reports/{reportId}（乐观锁 version 必传）
 * - 问题：PATCH /api/v1/projects/{id}/issues/{issueId}（三态允许回退；行内编辑描述 / 归类 / 解决方案 / 附图）
 * - 成对删除：DELETE …/reports/{reportId}（连带派生问题）/ DELETE …/issues/{issueId}（有来源日报时连带）
 * 口径：同日多条（无唯一约束）；草稿写库；关联阶段走 stageKeys；归类多值；附图 = file_links 引用（fileId）。
 */
import { apiSend, readAllPages } from "./api";
import { stageNameOf } from "./taskApi";
import type { DailyReport, Issue, IssueState, ReportPhoto, ReportState } from "./data/reports";

/** 日报状态中文名（A3-02 · 契约值 → 展示）。 */
export const REPORT_STATE_NAMES: Record<ReportState, string> = {
  draft: "草稿",
  submitted: "已提交",
  supplement: "补填",
};

/** 问题三态中文名（A3-10 · 契约值 → 展示）。 */
export const ISSUE_STATE_NAMES: Record<IssueState, string> = {
  open: "未解决",
  in_progress: "处理中",
  done: "已完成",
};

/** 附图引用（契约 FilePhotoRef：file_links 读面）。 */
type ApiPhotoRef = { fileId: string; name: string };

/** 契约 DailyReport（本文件用到的字段；服务端可能多给，忽略即可）。 */
export type ApiDailyReport = {
  id: string;
  date: string;
  state: ReportState;
  headcount: number | null;
  doneWork: string;
  plan: string | null;
  foundIssue: string | null;
  issueCategories: string[];
  suggestion: string | null;
  stageKeys: string[];
  photos: ApiPhotoRef[];
  issuePhotos: ApiPhotoRef[];
  authorName: string | null;
  submittedAt: string | null;
  createdAt: string;
  version: number;
};

/** 契约 Issue（本文件用到的字段）。 */
export type ApiIssue = {
  id: string;
  title: string;
  categories: string[];
  state: IssueState;
  reporterName: string | null;
  /** 问题处理人 / 责任人（Push 243 起可在日报填写里选；未分派 = null / 空）。 */
  ownerId: string | null;
  ownerName: string | null;
  raisedAt: string;
  solution: string | null;
  photos: ApiPhotoRef[];
  sourceReportId: string | null;
  createdAt: string;
  version: number;
};

function photosOf(refs: readonly ApiPhotoRef[]): ReportPhoto[] {
  return refs.map((ref) => ({ fileId: ref.fileId, name: ref.name, url: null }));
}

/** 契约日报 → 界面模型：日期 / 阶段 / 空值口径在此收口。 */
export function toUiReport(api: ApiDailyReport): DailyReport {
  return {
    id: api.id,
    date: api.date,
    author: api.authorName ?? "—",
    submittedAt: api.submittedAt,
    state: api.state,
    headcount: api.headcount,
    doneWork: api.doneWork,
    plan: api.plan ?? "",
    foundIssue: api.foundIssue ?? "",
    issueCategories: [...api.issueCategories],
    suggestion: api.suggestion ?? "",
    stageNames: api.stageKeys.map(stageNameOf).filter((name) => name !== ""),
    photos: photosOf(api.photos),
    issuePhotos: photosOf(api.issuePhotos),
    version: api.version,
  };
}

/** 契约问题 → 界面模型。 */
export function toUiIssue(api: ApiIssue): Issue {
  return {
    id: api.id,
    title: api.title,
    state: api.state,
    categories: [...api.categories],
    reporter: api.reporterName ?? "—",
    ownerId: api.ownerId ?? "",
    owner: api.ownerName ?? "",
    raisedAt: api.raisedAt,
    solution: api.solution ?? "",
    photos: photosOf(api.photos),
    reportId: api.sourceReportId ?? "",
    version: api.version,
  };
}

/** 日报列表：日期倒序；同日多条按创建时间倒序（新的在前）。 */
export function fetchProjectReports(projectId: string): Promise<DailyReport[]> {
  return readAllPages<ApiDailyReport>(
    "/api/v1/projects/" + encodeURIComponent(projectId) + "/reports",
  ).then((response) =>
    response.items
      .slice()
      .sort((a, b) => (a.date === b.date ? b.createdAt.localeCompare(a.createdAt) : b.date.localeCompare(a.date)))
      .map(toUiReport),
  );
}

/** 问题列表：提出日期倒序；同日按创建时间倒序。 */
export function fetchProjectIssues(projectId: string): Promise<Issue[]> {
  return readAllPages<ApiIssue>(
    "/api/v1/projects/" + encodeURIComponent(projectId) + "/issues",
  ).then((response) =>
    response.items
      .slice()
      .sort((a, b) => (a.raisedAt === b.raisedAt ? b.createdAt.localeCompare(a.createdAt) : b.raisedAt.localeCompare(a.raisedAt)))
      .map(toUiIssue),
  );
}

/** 内联问题清单写体（Push 243）：title / categories 必填；ownerId 缺省 / null = 按归类自动分派责任部门；
 *  空 solution / photoFileIds **省字段**（契约不允许空串 / null —— 与 createBody 同一口径）。 */
export type ReportIssueWriteDraft = {
  title: string;
  categories: string[];
  ownerId?: string | null;
  solution?: string;
  photoFileIds?: string[];
};

/** 新报一天日报（草稿 / 提交）；补填由服务端按日期推导。 */
export type ReportWriteInput = {
  date: string;
  state?: "draft" | "submitted";
  headcount?: number | null;
  doneWork: string;
  plan?: string | null;
  foundIssue?: string | null;
  issueCategories?: string[] | null;
  suggestion?: string | null;
  stageKeys?: string[];
  photoFileIds?: string[];
  issuePhotoFileIds?: string[];
  /** 内联问题清单（Push 243）：一次填报 1~N 条问题，提交后逐条生成独立问题记录；与旧单问题字段互斥。 */
  issues?: ReportIssueWriteDraft[];
};

/** 编辑已存在的日报行（乐观锁 version 必传；date 不可改；字段可部分提交）。 */
export type ReportUpdateInput = Partial<Omit<ReportWriteInput, "date">> & { version: number };

export function createReport(projectId: string, body: ReportWriteInput): Promise<DailyReport> {
  return apiSend<ApiDailyReport>("/api/v1/projects/" + encodeURIComponent(projectId) + "/reports", "POST", body).then(toUiReport);
}

export function updateReport(projectId: string, reportId: string, body: ReportUpdateInput): Promise<DailyReport> {
  return apiSend<ApiDailyReport>(
    "/api/v1/projects/" + encodeURIComponent(projectId) + "/reports/" + encodeURIComponent(reportId),
    "PATCH",
    body,
  ).then(toUiReport);
}

/** 删除日报（成对删除：连带它派生的全部问题）。 */
export function deleteReport(projectId: string, reportId: string): Promise<{ id: string; cascadedIssueIds: string[] }> {
  return apiSend<{ id: string; deleted: true; cascadedIssueIds: string[] }>(
    "/api/v1/projects/" + encodeURIComponent(projectId) + "/reports/" + encodeURIComponent(reportId),
    "DELETE",
  );
}

/** 问题更新（状态流转 / 描述 / 归类 / 解决方案 / 附图；乐观锁 version 必传）。 */
export type IssueUpdateInput = {
  version: number;
  state?: IssueState;
  title?: string;
  categories?: string[];
  solution?: string | null;
  photoFileIds?: string[];
  /** 问题处理人 / 责任人（Push 244 起可编辑）：null = 回缺省（待分派 / 按归类分派责任部门）。 */
  ownerId?: string | null;
};

export function updateIssue(projectId: string, issueId: string, body: IssueUpdateInput): Promise<Issue> {
  return apiSend<ApiIssue>(
    "/api/v1/projects/" + encodeURIComponent(projectId) + "/issues/" + encodeURIComponent(issueId),
    "PATCH",
    body,
  ).then(toUiIssue);
}

/** 删除问题（成对删除：有来源日报时连它来源的那篇日报一起删）。 */
export function deleteIssue(
  projectId: string,
  issueId: string,
): Promise<{ id: string; cascadedReportId: string | null; cascadedIssueIds: string[] }> {
  return apiSend<{ id: string; deleted: true; cascadedReportId: string | null; cascadedIssueIds: string[] }>(
    "/api/v1/projects/" + encodeURIComponent(projectId) + "/issues/" + encodeURIComponent(issueId),
    "DELETE",
  );
}
