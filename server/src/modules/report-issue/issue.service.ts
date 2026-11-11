import { Injectable } from "@nestjs/common";
import { IssueDeleteResponseSchema, IssueDetailSchema, IssueListQuerySchema, IssueListResponseSchema, IssueUpdateBodySchema, z } from "@libiaolink/contracts";
import { AppError } from "../../common/errors/app-error.js";
import type { DbClient } from "../../db/db-client.js";
import { DatabaseService } from "../../db/database.service.js";
import { appendOutbox } from "../../db/outbox.js";
import { AuditService, diffRecords } from "../admin/index.js";
import { IssueRepository, type IssueEventInput, type IssueEventRow, type IssuePatch, type IssueRow } from "./issue.repository.js";
import { parseIssueFilter } from "./report-issue.rules.js";
import {
  assertPhotoFilesInProject,
  loadIssuePhotos,
  purgeIssues,
  purgeReportCascade,
  replaceIssuePhotos,
  type FilePhotoRefRow,
} from "./report-issue.links.js";

type IssueDeleteResponse = z.infer<typeof IssueDeleteResponseSchema>;
type IssueDetail = z.infer<typeof IssueDetailSchema>;
type IssueListQuery = z.infer<typeof IssueListQuerySchema>;
type IssueListResponse = z.infer<typeof IssueListResponseSchema>;
type IssueUpdateBody = z.infer<typeof IssueUpdateBodySchema>;

/** 问题快照（字段级留痕口径：描述 / 归类 / 状态 / 分派 / 解决方案可改）。 */
function issueSnapshot(row: IssueRow): Record<string, unknown> {
  return {
    title: row.title,
    categories: row.categories,
    state: row.state,
    taskId: row.taskId,
    sourceReportId: row.sourceReportId,
    ownerDepartment: row.ownerDepartment,
    ownerId: row.ownerId,
    solution: row.solution,
    closedAt: row.closedAt === null ? null : row.closedAt.toISOString(),
  };
}

/**
 * 问题用例（M6-02 / M6-03 · A3-10 ~ A3-13 / A3-16 · Push 215）。
 * 1) 三态（未解决 / 处理中 / 已完成）允许回退且留痕（A3-10）—— 不设流转白名单，只要求写事件；
 * 2) 每次写一条 issue_events：状态流转 / 解决方案 / 分派各自成行（A3-13 留痕，note 记本次备注）；描述 / 归类 / 附图不写事件（走审计）；
 * 3) 关闭 = state=done 且 closed_at / closed_by 同写；回退（done → 其它态）一并清空（ck_issues_closed_pairs）；
 * 4) 空更新（无任何字段变化）= 400，防刷留痕；乐观锁 version 冲突 409；归档项目 409 PROJECT_ARCHIVED；
 * 5) 附图（file_links(object_type=issue)）整体替换；删除为成对删除（删问题 = 连它来源的那篇日报及其全部问题）。
 * 权限：读 = issue.view；写 = issue.manage，且要求当前项目 accessLevel=edit。
 */
@Injectable()
export class IssueService {
  constructor(
    private readonly database: DatabaseService,
    private readonly issues: IssueRepository,
    private readonly audit: AuditService,
  ) {}

  /** GET /api/v1/projects/{id}/issues：状态 / 归类 / 任务 / 来源日报 + 关键字 + 分页，提出日期倒序。 */
  async list(projectId: string, query: IssueListQuery): Promise<IssueListResponse> {
    const filter = parseIssueFilter(query);
    const { rows, total } = await this.issues.list(projectId, filter, query.page, query.limit);
    const photos = await loadIssuePhotos(
      rows.map((row) => row.id),
      this.database.db,
    );
    return {
      items: rows.map((row) => this.toIssue(row, photos.get(row.id) ?? [])),
      page: query.page,
      limit: query.limit,
      total,
    };
  }

  /** 内部导出用：只读项目问题总数，不加载问题正文、负责人或附图。 */
  async countForExport(projectId: string): Promise<number> {
    return this.issues.countForExport(projectId);
  }

  /** 内部导出用：按页加载问题与附图，不重复查询 total。 */
  async listForExport(projectId: string, query: { page: number; limit: number }): Promise<IssueListResponse["items"]> {
    const filter = parseIssueFilter(query);
    const rows = await this.issues.listForExport(projectId, filter, query.page, query.limit);
    const photos = await loadIssuePhotos(rows.map((row) => row.id), this.database.db);
    return rows.map((row) => this.toIssue(row, photos.get(row.id) ?? []));
  }

  /** GET /api/v1/projects/{id}/issues/{issueId}：问题 + 处理过程留痕（时间正序）。 */
  async detail(projectId: string, issueId: string): Promise<IssueDetail> {
    const row = await this.requireIssue(projectId, issueId, this.database.db);
    const events = await this.issues.listEvents(issueId);
    const photos = await loadIssuePhotos([issueId], this.database.db);
    return { ...this.toIssue(row, photos.get(issueId) ?? []), events: events.map((event) => this.toEvent(event)) };
  }

  /** PATCH /api/v1/projects/{id}/issues/{issueId}：状态 / 描述 / 归类 / 解决方案 / 分派 / 附图，一次请求写一条事件。 */
  async update(projectId: string, issueId: string, body: IssueUpdateBody, actorId: string): Promise<IssueDetail> {
    await this.loadProjectForWrite(projectId);
    const at = new Date();
    if (body.photoFileIds !== undefined && body.photoFileIds.length > 0) {
      await assertPhotoFilesInProject(projectId, body.photoFileIds, this.database.db);
    }
    await this.database.db.transaction(async (tx) => {
      const before = await this.requireIssue(projectId, issueId, tx);
      const patch: IssuePatch = {};
      if (body.state !== undefined && body.state !== before.state) {
        patch.state = body.state;
        if (body.state === "done") {
          patch.closedBy = actorId;
          patch.closedAt = at;
        } else if (before.state === "done") {
          patch.closedBy = null;
          patch.closedAt = null;
        }
      }
      if (body.title !== undefined && body.title !== before.title) patch.title = body.title;
      if (body.categories !== undefined && JSON.stringify(body.categories) !== JSON.stringify(before.categories)) {
        patch.categories = [...body.categories];
      }
      if (body.solution !== undefined) patch.solution = body.solution;
      if (body.ownerDepartment !== undefined) patch.ownerDepartment = body.ownerDepartment;
      if (body.ownerId !== undefined) patch.ownerId = body.ownerId;
      const currentPhotos = body.photoFileIds === undefined ? [] : ((await loadIssuePhotos([issueId], tx)).get(issueId) ?? []);
      const photosChanged =
        body.photoFileIds !== undefined &&
        (body.photoFileIds.length !== currentPhotos.length || body.photoFileIds.some((fileId, index) => fileId !== currentPhotos[index]?.fileId));
      if (Object.keys(patch).length === 0 && !photosChanged) {
        throw new AppError("VALIDATION_FAILED", "问题更新至少需要一个实际变化（状态 / 描述 / 归类 / 解决方案 / 分派 / 附图）", [
          { code: "empty_update", message: "可改字段都为缺省值或与原值相同", path: "state" },
        ]);
      }
      const updated = await this.issues.updateWithVersion(issueId, body.version, patch, at, tx);
      if (!updated) {
        throw new AppError("VERSION_CONFLICT", "问题已被他人修改，请刷新后重试", [
          { code: "version_conflict", message: "期望 version = " + body.version, path: "version" },
        ]);
      }
      if (photosChanged) {
        await replaceIssuePhotos(issueId, body.photoFileIds ?? [], actorId, at, tx);
      }
      const after = await this.requireIssue(projectId, issueId, tx);
      const eventInputs: IssueEventInput[] = [];
      if (after.state !== before.state) {
        eventInputs.push({ issueId, eventType: "state_change", fromState: before.state, toState: after.state, note: body.note ?? null });
      }
      if (body.solution !== undefined && after.solution !== before.solution) {
        eventInputs.push({ issueId, eventType: "solution", fromState: null, toState: null, note: body.note ?? null });
      }
      const assignedChanged = after.ownerDepartment !== before.ownerDepartment || after.ownerId !== before.ownerId;
      if (assignedChanged) {
        eventInputs.push({ issueId, eventType: "assignment", fromState: null, toState: null, note: body.note ?? null });
      }
      for (const event of eventInputs) await this.issues.insertEvent(event, actorId, at, tx);
      await this.audit.record(tx, {
        actorId,
        action: after.state === "done" && before.state !== "done" ? "complete" : "update",
        objectType: "issue",
        objectId: issueId,
        projectId,
        summary: "更新问题：" + after.title,
        changes: diffRecords(issueSnapshot(before), issueSnapshot(after)),
        metadata: { events: eventInputs.length, fromState: before.state, toState: after.state },
      });
      await appendOutbox(tx, {
        topic: "issue.updated",
        dedupeKey: "issue.updated:" + issueId + ":" + after.version,
        payload: { projectId, issueId, state: after.state, actorId, at: at.toISOString() },
      });
    });
    return this.detail(projectId, issueId);
  }

  /** DELETE /api/v1/projects/{id}/issues/{issueId}：成对删除（有来源日报 = 连它来源的那篇日报及其全部问题）。 */
  async remove(projectId: string, issueId: string, actorId: string): Promise<IssueDeleteResponse> {
    await this.loadProjectForWrite(projectId);
    const at = new Date();
    let cascadedReportId: string | null = null;
    let cascadedIssueIds: string[] = [];
    await this.database.db.transaction(async (tx) => {
      const row = await this.requireIssue(projectId, issueId, tx);
      if (row.sourceReportId === null) {
        await purgeIssues([issueId], tx);
        await this.audit.record(tx, {
          actorId,
          action: "delete",
          objectType: "issue",
          objectId: issueId,
          projectId,
          summary: "删除问题：" + row.title,
          metadata: { sourceReportId: null },
        });
      } else {
        cascadedReportId = row.sourceReportId;
        const deletedIssueIds = await purgeReportCascade(row.sourceReportId, tx);
        cascadedIssueIds = deletedIssueIds.filter((id) => id !== issueId);
        for (const id of cascadedIssueIds) {
          await this.audit.record(tx, {
            actorId,
            action: "delete",
            objectType: "issue",
            objectId: id,
            projectId,
            summary: "连带删除日报派生问题",
            metadata: { sourceReportId: row.sourceReportId },
          });
        }
        await this.audit.record(tx, {
          actorId,
          action: "delete",
          objectType: "daily_report",
          objectId: row.sourceReportId,
          projectId,
          summary: "删除问题连带删除来源日报",
          metadata: { cascadedIssueIds },
        });
        await this.audit.record(tx, {
          actorId,
          action: "delete",
          objectType: "issue",
          objectId: issueId,
          projectId,
          summary: "删除问题：" + row.title,
          metadata: { cascadedReportId: row.sourceReportId },
        });
      }
      await appendOutbox(tx, {
        topic: "issue.deleted",
        dedupeKey: "issue.deleted:" + issueId,
        payload: { projectId, issueId, cascadedReportId, cascadedIssueIds, at: at.toISOString() },
      });
    });
    return { id: issueId, deleted: true, cascadedReportId, cascadedIssueIds };
  }

  private async requireIssue(projectId: string, issueId: string, client: DbClient): Promise<IssueRow> {
    const row = await this.issues.findById(projectId, issueId, client);
    if (row === null) throw new AppError("NOT_FOUND", "问题不存在：" + issueId);
    return row;
  }

  private toIssue(row: IssueRow, photos: FilePhotoRefRow[]): Omit<IssueDetail, "events"> {
    return {
      id: row.id,
      projectId: row.projectId,
      taskId: row.taskId,
      sourceReportId: row.sourceReportId,
      title: row.title,
      categories: row.categories as IssueDetail["categories"],
      state: row.state as IssueDetail["state"],
      reporterId: row.reporterId,
      reporterName: row.reporterName,
      ownerDepartment: row.ownerDepartment,
      ownerId: row.ownerId,
      ownerName: row.ownerName,
      raisedAt: row.raisedAt,
      solution: row.solution,
      photos,
      closedBy: row.closedBy,
      closedAt: row.closedAt === null ? null : row.closedAt.toISOString(),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      version: row.version,
    };
  }

  private toEvent(row: IssueEventRow): IssueDetail["events"][number] {
    return {
      id: row.id,
      issueId: row.issueId,
      eventType: row.eventType as IssueDetail["events"][number]["eventType"],
      fromState: row.fromState as IssueDetail["events"][number]["fromState"],
      toState: row.toState as IssueDetail["events"][number]["toState"],
      actorId: row.actorId,
      actorName: row.actorName,
      note: row.note,
      createdAt: row.createdAt.toISOString(),
    };
  }

  /** 问题写入口：归档项目一律 409 PROJECT_ARCHIVED（ADR-027）。 */
  private async loadProjectForWrite(projectId: string): Promise<void> {
    const project = await this.issues.findProject(projectId);
    if (project === null) throw new AppError("NOT_FOUND", "项目不存在或不可见");
    if (project.status === "archived") throw new AppError("PROJECT_ARCHIVED", "项目已归档，禁止处理问题");
  }
}
