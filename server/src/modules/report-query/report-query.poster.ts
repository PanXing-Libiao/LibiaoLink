import type { DailyReportPosterData } from "../notify/index.js";
import type { ReportDigestSnapshot } from "../report-issue/index.js";

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
    photos: report.photos.map((photo) => ({
      fileId: photo.fileId,
      name: photo.name,
      objectKey: photo.objectKey,
      mime: photo.mime,
    })),
    issues: options.includeIssues
      ? snapshot.issues.map((issue) => ({
          id: issue.id,
          title: issue.title,
          categories: [...issue.categories],
          ownerName: issue.ownerName,
          state: issue.state,
          solution: issue.solution,
          photos: issue.photos.map((photo) => ({
            fileId: photo.fileId,
            name: photo.name,
            objectKey: photo.objectKey,
            mime: photo.mime,
          })),
        }))
      : [],
  };
}
