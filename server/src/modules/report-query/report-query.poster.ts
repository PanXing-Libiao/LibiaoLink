import type {
  DailyReportDigestPosterData,
  DailyReportPosterData,
  DailyReportPosterPhoto,
} from "../notify/index.js";
import type { ReportDigestSnapshot } from "../report-issue/index.js";

export type ReportQueryPosterData =
  | { kind: "single"; data: DailyReportPosterData }
  | { kind: "digest"; data: DailyReportDigestPosterData };

function toPosterPhoto(photo: ReportDigestSnapshot["reports"][number]["photos"][number]): DailyReportPosterPhoto {
  return {
    fileId: photo.fileId,
    name: photo.name,
    objectKey: photo.objectKey,
    mime: photo.mime,
  };
}

/**
 * 单篇日报查询海报：仅当快照恰好包含 1 篇已提交日报时生成。
 *
 * 问题取查询日全量（手工 + 日报派生），是否发送问题图由查询编排层按主题与
 * `issue.view` 决定；未允许时直接不携带问题数据，本函数不触发额外查询。
 */
export function toSingleReportPosterData(
  snapshot: ReportDigestSnapshot,
  options: { includeIssues: boolean },
): DailyReportPosterData | null {
  if (snapshot.reports.length !== 1) return null;
  const report = snapshot.reports[0];
  if (report === undefined) return null;

  return {
    projectId: snapshot.project.id,
    projectCode: snapshot.project.code,
    projectName: snapshot.project.name,
    managers: [...snapshot.project.managers],
    reportId: report.id,
    reportDate: snapshot.date,
    state: report.state,
    authorName: report.authorName,
    headcount: report.headcount,
    doneWork: report.doneWork,
    plan: report.plan,
    stages: [...report.stageNames],
    submittedAt: report.submittedAt,
    photos: report.photos.map(toPosterPhoto),
    issues: options.includeIssues
      ? snapshot.issues.map((issue) => ({
          id: issue.id,
          title: issue.title,
          categories: [...issue.categories],
          ownerName: issue.ownerName,
          state: issue.state,
          solution: issue.solution,
          photos: issue.photos.map(toPosterPhoto),
        }))
      : [],
  };
}

/**
 * 查询海报快照：恰好 1 篇已提交日报继续走单篇复用路径；0 篇或 2 篇及以上
 * 走合集快照。0 篇且没有可发送问题时不生成海报。
 */
export function toReportQueryPosterData(
  snapshot: ReportDigestSnapshot,
  options: { includeIssues: boolean },
): ReportQueryPosterData | null {
  const issues = options.includeIssues ? snapshot.issues : [];
  if (snapshot.reports.length === 0 && issues.length === 0) return null;
  if (snapshot.reports.length === 1) {
    const data = toSingleReportPosterData(snapshot, options);
    return data === null ? null : { kind: "single", data };
  }

  return {
    kind: "digest",
    data: {
      projectId: snapshot.project.id,
      projectCode: snapshot.project.code,
      projectName: snapshot.project.name,
      managers: [...snapshot.project.managers],
      reportDate: snapshot.date,
      draftCount: snapshot.draftCount,
      reports: snapshot.reports.map((report) => ({
        reportId: report.id,
        authorName: report.authorName,
        submittedAt: report.submittedAt,
        state: report.state,
        headcount: report.headcount,
        stages: [...report.stageNames],
        doneWork: report.doneWork,
        plan: report.plan,
        photos: report.photos.map(toPosterPhoto),
      })),
      issues: issues.map((issue) => ({
        id: issue.id,
        title: issue.title,
        categories: [...issue.categories],
        ownerName: issue.ownerName,
        state: issue.state,
        solution: issue.solution,
        raisedAt: issue.raisedAt,
        sourceReport:
          issue.sourceReport === null
            ? null
            : {
                id: issue.sourceReport.id,
                authorName: issue.sourceReport.authorName,
                submittedAt: issue.sourceReport.submittedAt,
              },
        photos: issue.photos.map(toPosterPhoto),
      })),
    },
  };
}
