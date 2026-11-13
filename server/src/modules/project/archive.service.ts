import { Injectable } from "@nestjs/common";
import { ProjectArchiveViewSchema, z } from "@libiaolink/contracts";
import type { StageKey } from "@libiaolink/contracts";
import { AppError } from "../../common/errors/app-error.js";
import { DatabaseService } from "../../db/database.service.js";
import type { DbClient } from "../../db/db-client.js";
import { AuditService } from "../admin/index.js";
import { ArchiveRepository, type ArchiveViewRow } from "./archive.repository.js";
import { FlowService } from "./flow.service.js";
import { ProjectRepository } from "./project.repository.js";
import type { ProjectStageRow } from "./flow.repository.js";

export type ProjectArchiveView = z.infer<typeof ProjectArchiveViewSchema>;

export type ArchiveRequestBody = { version: number; confirm: boolean };

/** 行 → 契约视图（归档清单读面 / 归档成功返回同形）。 */
export function toArchiveView(row: ArchiveViewRow): ProjectArchiveView {
  return {
    id: row.archive.id,
    projectId: row.archive.projectId,
    archivedAt: row.archive.archivedAt.toISOString(),
    archivedBy: row.archive.archivedBy,
    archivedByName: row.archivedByName,
    snapshot: row.archive.snapshot as ProjectArchiveView["snapshot"],
    acknowledgedMissing: row.archive.acknowledgedMissing as ProjectArchiveView["acknowledgedMissing"],
  };
}

/**
 * 归档用例（M7-04 · ADR-027 · C4-02 / C4-03）：任务全部完成 → 冻结状态位 + 引用式清单 + 只读保护。
 * 口径：
 *   1. 硬前置：项目内未删除任务全部 done；有未完成任务 409 ARCHIVE_NOT_READY（不可确认越过）。
 *      文件是否定档、节点必交成果是否齐全均不再阻断归档（2026-11-12 业务口径）。
 *   2. 归档事务（全部同事务）：锁项目行 → 乐观锁 version 判定 → 校验任务完成 → 置 status = archived + archived_at / archived_by →
 *      生成 project_archives 清单 → 撤销进行中的上传会话 → 审计 action = archive；不删数据、不改阶段。
 *   3. 权限：仅最终项目编辑者（管理员、所管本项目的项目经理或规则 edit）；记录级可见性由 ProjectAccessGuard 先行（404 语义）。
 */
@Injectable()
export class ArchiveService {
  constructor(
    private readonly database: DatabaseService,
    private readonly archive: ArchiveRepository,
    private readonly projects: ProjectRepository,
    private readonly flow: FlowService,
    private readonly audit: AuditService,
  ) {}

  /**
   * POST /projects/{id}/archive：任务全部完成即置位 + 清单。
   * confirm 保留为旧契约兼容字段；当前口径不存在可确认越过的缺项，值会被忽略。
   */
  async archiveProject(projectId: string, body: ArchiveRequestBody, actorId: string): Promise<ProjectArchiveView> {
    const view = await this.projects.findViewById(projectId);
    if (view === null) throw new AppError("NOT_FOUND", "项目不存在或不可见");
    if (view.project.status === "archived") throw new AppError("PROJECT_ARCHIVED", "项目已归档");
    await this.flow.assertProjectEditor(projectId, actorId, "项目归档");
    const at = new Date();
    await this.database.db.transaction(async (tx) => {
      const locked = await this.archive.lockProjectRow(tx, projectId);
      if (locked === null || locked.deletedAt !== null) throw new AppError("NOT_FOUND", "项目不存在或不可见");
      if (locked.status === "archived") throw new AppError("PROJECT_ARCHIVED", "项目已归档");
      if (locked.version !== body.version) throw new AppError("VERSION_CONFLICT", "项目已被他人更新，请刷新后重试");
      const unfinished = await this.archive.listUnfinishedTasks(tx, projectId);
      if (unfinished.length > 0) {
        throw new AppError(
          "ARCHIVE_NOT_READY",
          "项目任务未全部完成，不能归档（还有 " + unfinished.length + " 项）",
          unfinished.map((task) => ({
            code: "task_not_done",
            message: "任务未完成：" + task.title + "（状态 " + task.status + (task.stageKey === null ? "，未分组" : "，阶段 " + task.stageKey) + "）",
            path: "missing",
            meta: { taskId: task.id, title: task.title, stageKey: task.stageKey, status: task.status },
          })),
        );
      }
      const stage = await this.archive.findStage(tx, projectId, locked.stageKey);
      if (stage === null) throw new AppError("INTERNAL", "项目阶段快照缺失，无法归档");
      const updated = await this.archive.updateProjectArchived(tx, projectId, at, actorId, body.version);
      if (updated === null) throw new AppError("VERSION_CONFLICT", "项目已被他人更新，请刷新后重试");
      const snapshot = await this.buildSnapshot(tx, projectId, stage);
      const record = await this.archive.insertArchive(tx, {
        projectId,
        archivedAt: at,
        archivedBy: actorId,
        snapshot,
        acknowledgedMissing: [],
      });
      await this.archive.abortActiveUploadSessions(tx, projectId, at);
      await this.audit.record(tx, {
        actorId,
        action: "archive",
        objectType: "project",
        objectId: projectId,
        projectId,
        summary: "归档项目：" + locked.code + "（" + locked.name + "）",
        changes: [{ field: "status", from: locked.status, to: "archived" }],
        metadata: { archiveId: record.id },
      });
    });
    const record = await this.archive.findArchive(this.database.db, projectId);
    if (record === null) throw new AppError("INTERNAL", "归档记录写入后读取失败");
    return toArchiveView(record);
  }

  /** GET /projects/{id}/archive：归档清单读面（未归档 404）。 */
  async getArchive(projectId: string): Promise<ProjectArchiveView> {
    const view = await this.projects.findViewById(projectId);
    if (view === null) throw new AppError("NOT_FOUND", "项目不存在或不可见");
    const record = await this.archive.findArchive(this.database.db, projectId);
    if (record === null) throw new AppError("NOT_FOUND", "项目尚无归档记录（未归档）");
    return toArchiveView(record);
  }

  /** 清单快照（引用式）：任务数与状态分布 / 阶段状态 / 文件清单含版本 / 变更 / 日报 / 问题。 */
  private async buildSnapshot(client: DbClient, projectId: string, stage: ProjectStageRow): Promise<ProjectArchiveView["snapshot"]> {
    const taskCounts = await this.archive.countTasksByStatus(client, projectId);
    const fileRows = await this.archive.listFileSnapshotRows(client, projectId);
    const changeRows = await this.archive.listChanges(client, projectId);
    const reportCounts = await this.archive.countReportsByState(client, projectId);
    const issueCounts = await this.archive.countIssuesByState(client, projectId);
    const countOf = (source: Record<string, number>, key: string): number => Number(source[key] ?? 0);
    const sum = (source: Record<string, number>, keys: readonly string[]): number => keys.reduce((total, key) => total + countOf(source, key), 0);
    const taskKeys = ["pending", "active", "done"] as const;
    const reportKeys = ["draft", "submitted", "supplement"] as const;
    const issueKeys = ["open", "in_progress", "done"] as const;
    return {
      stage: {
        stageKey: stage.stageKey as StageKey,
        status: stage.status,
        advancedAt: stage.advancedAt === null ? null : stage.advancedAt.toISOString(),
      },
      tasks: {
        total: sum(taskCounts, taskKeys),
        byStatus: { pending: countOf(taskCounts, "pending"), active: countOf(taskCounts, "active"), done: countOf(taskCounts, "done") },
      },
      files: {
        total: fileRows.length,
        items: fileRows.map((row) => ({
          id: row.id,
          name: row.name,
          docType: row.docType,
          status: row.status,
          nodeId: row.nodeId,
          versionCount: row.versionCount,
          latestSeq: row.latestSeq,
          latestUploadedAt: row.latestUploadedAt === null ? null : new Date(row.latestUploadedAt).toISOString(),
        })),
      },
      changes: {
        total: changeRows.length,
        items: changeRows.map((row) => ({
          id: row.id,
          reason: row.reason,
          stageKey: row.stageKey as StageKey | null,
          appliedAt: row.appliedAt.toISOString(),
        })),
      },
      reports: {
        total: sum(reportCounts, reportKeys),
        byState: { draft: countOf(reportCounts, "draft"), submitted: countOf(reportCounts, "submitted"), supplement: countOf(reportCounts, "supplement") },
      },
      issues: {
        total: sum(issueCounts, issueKeys),
        byState: {
          open: countOf(issueCounts, "open"),
          in_progress: countOf(issueCounts, "in_progress"),
          done: countOf(issueCounts, "done"),
        },
      },
    };
  }
}
