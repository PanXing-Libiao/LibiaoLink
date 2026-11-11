import { Injectable } from "@nestjs/common";
import { STAGE_NAMES } from "@libiaolink/contracts";
import { AppError } from "../../common/errors/app-error.js";
import { DatabaseService } from "../../db/database.service.js";
import { IssueRepository, type IssueRow } from "./issue.repository.js";
import { ReportRepository, type DailyReportRow } from "./report.repository.js";
import {
  loadIssuePosterPhotos,
  loadReportPosterPhotos,
  type FilePosterPhotoRow,
} from "./report-issue.links.js";
import type { DailyReportState } from "./report-issue.rules.js";

type DigestReportState = Exclude<DailyReportState, "draft">;

/** 查询快照中的项目定位信息（不包含业务明细）。 */
export interface ReportDigestProject {
  id: string;
  code: string;
  name: string;
  managers: string[];
}

/** 查询海报附件元数据；objectKey 仅用于服务端读取对象，不进入文字或公开 API。 */
export type ReportDigestPhoto = FilePosterPhotoRow;

/** 已提交日报（submitted / supplement）；草稿不进入该结构。 */
export interface ReportDigestReport {
  id: string;
  authorId: string;
  authorName: string | null;
  submittedAt: string | null;
  state: DigestReportState;
  headcount: number | null;
  stageKeys: string[];
  stageNames: string[];
  doneWork: string;
  plan: string | null;
  photos: ReportDigestPhoto[];
}

/** 问题来源日报的只读摘要（手工问题为 null）。 */
export interface ReportDigestSourceReport {
  id: string;
  authorId: string;
  authorName: string | null;
  submittedAt: string | null;
}

/** 查询日问题（当前状态口径，不还原历史）。 */
export interface ReportDigestIssue {
  id: string;
  title: string;
  categories: string[];
  state: string;
  ownerDepartment: string | null;
  ownerId: string | null;
  ownerName: string | null;
  solution: string | null;
  raisedAt: string;
  sourceReportId: string | null;
  sourceReport: ReportDigestSourceReport | null;
  photos: ReportDigestPhoto[];
}

/** 一次查询的完整只读快照：文字与海报必须共用同一份实例。 */
export interface ReportDigestSnapshot {
  project: ReportDigestProject;
  date: string;
  reports: ReportDigestReport[];
  draftCount: number;
  issues: ReportDigestIssue[];
}

/** 提交时间 → 创建时间 → id；提交时间为空时排最后，保证同日多篇顺序稳定。 */
function bySubmittedAt(left: DailyReportRow, right: DailyReportRow): number {
  const leftAt = left.submittedAt === null ? Number.POSITIVE_INFINITY : left.submittedAt.getTime();
  const rightAt = right.submittedAt === null ? Number.POSITIVE_INFINITY : right.submittedAt.getTime();
  if (leftAt !== rightAt) return leftAt - rightAt;
  if (left.createdAt.getTime() !== right.createdAt.getTime()) return left.createdAt.getTime() - right.createdAt.getTime();
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

function isDigestReport(row: DailyReportRow): row is DailyReportRow & { state: DigestReportState } {
  return row.state === "submitted" || row.state === "supplement";
}

function toSourceReport(row: DailyReportRow): ReportDigestSourceReport {
  return {
    id: row.id,
    authorId: row.authorId,
    authorName: row.authorName,
    submittedAt: row.submittedAt === null ? null : row.submittedAt.toISOString(),
  };
}

/**
 * 企微机器人日报查询读面（S1）：项目 + 查询日的一份只读快照。
 * 日报仅返回 submitted / supplement，草稿只计数；问题按 raised_at 直比（手工 + 派生），
 * 附件元数据批量读取，不读取对象字节。权限判定由查询编排层在调用前完成。
 */
@Injectable()
export class ReportDigestService {
  constructor(
    private readonly database: DatabaseService,
    private readonly reports: ReportRepository,
    private readonly issues: IssueRepository,
  ) {}

  async getSnapshot(projectId: string, date: string): Promise<ReportDigestSnapshot> {
    return this.database.db.transaction(
      async (client) => {
        const project = await this.reports.findProject(projectId, client);
        if (project === null) {
          throw new AppError("NOT_FOUND", "项目不存在或不可见");
        }

        const rows = await this.reports.listByDate(projectId, date, client);
        const submittedRows = rows.filter(isDigestReport).sort(bySubmittedAt);
        const issues = await this.issues.listByRaisedDate(projectId, date, client);
        const managerNames = await this.reports.listDisplayNames(project.managerIds, client);

        const reportPhotos = await loadReportPosterPhotos(
          submittedRows.map((row) => row.id),
          client,
        );
        const issuePhotos = await loadIssuePosterPhotos(
          issues.map((issue) => issue.id),
          client,
        );

        const stageNameByKey = STAGE_NAMES as Record<string, string>;
        const reportById = new Map(submittedRows.map((row) => [row.id, row]));
        return {
          project: {
            id: project.id,
            code: project.code,
            name: project.name,
            managers: project.managerIds.map((id) => managerNames.get(id) ?? "").filter((name) => name !== ""),
          },
          date,
          reports: submittedRows.map((row) => ({
            id: row.id,
            authorId: row.authorId,
            authorName: row.authorName,
            submittedAt: row.submittedAt === null ? null : row.submittedAt.toISOString(),
            state: row.state,
            headcount: row.headcount,
            stageKeys: row.stageKeys,
            stageNames: row.stageKeys.map((key) => stageNameByKey[key] ?? key),
            doneWork: row.doneWork,
            plan: row.plan,
            photos: reportPhotos.get(row.id)?.onsite ?? [],
          })),
          draftCount: rows.length - submittedRows.length,
          issues: issues.map((issue) => this.toDigestIssue(issue, reportById, issuePhotos.get(issue.id) ?? [])),
        };
      },
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
  }

  private toDigestIssue(
    issue: IssueRow,
    reportById: ReadonlyMap<string, DailyReportRow>,
    photos: ReportDigestPhoto[],
  ): ReportDigestIssue {
    const sourceRow = issue.sourceReportId === null ? null : reportById.get(issue.sourceReportId) ?? null;
    return {
      id: issue.id,
      title: issue.title,
      categories: issue.categories,
      state: issue.state,
      ownerDepartment: issue.ownerDepartment,
      ownerId: issue.ownerId,
      ownerName: issue.ownerName,
      solution: issue.solution,
      raisedAt: issue.raisedAt,
      sourceReportId: issue.sourceReportId,
      sourceReport: sourceRow === null ? null : toSourceReport(sourceRow),
      photos,
    };
  }
}
