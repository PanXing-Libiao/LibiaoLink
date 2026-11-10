import { Injectable } from "@nestjs/common";
import { ProjectArchiveViewSchema, z } from "@libiaolink/contracts";
import type { StageKey } from "@libiaolink/contracts";
import { AppError } from "../../common/errors/app-error.js";
import { DatabaseService } from "../../db/database.service.js";
import type { DbClient } from "../../db/db-client.js";
import { AuditService } from "../admin/index.js";
import { GateService } from "../node/index.js";
import { ArchiveRepository, type ArchiveViewRow } from "./archive.repository.js";
import { FlowService } from "./flow.service.js";
import { ProjectRepository } from "./project.repository.js";
import type { ProjectStageRow } from "./flow.repository.js";

export type ProjectArchiveView = z.infer<typeof ProjectArchiveViewSchema>;

export type ArchiveRequestBody = { version: number; confirm: boolean };

/** 归档缺项条目（契约 ProjectArchiveMissing 同形：422 details 与清单 acknowledgedMissing 共用）。 */
interface ArchiveMissingItem {
  code: "task_not_done" | "file_not_final" | "doc_missing";
  message: string;
  meta: Record<string, unknown>;
}

/** 门禁拒绝的内部信号（事务回滚后补写留痕，再转 422 契约错误；与阶段推进 GateRejectedSignal 同法）。 */
class ArchiveRejectedSignal extends Error {
  constructor(readonly appError: AppError) {
    super("archive_gate_rejected");
  }
}

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
 * 归档用例（M7-04 · ADR-027 · C4-02 / C4-03）：门禁（验收完成 + 成果文件齐全性检查）→ 冻结状态位 + 引用式清单 + 只读保护。
 * 口径：
 *   1. 硬前置：验收阶段（stage_key = acceptance）已完成（status = done）；未完成 409 ARCHIVE_NOT_READY（不可确认越过）。
 *   2. 缺项清单：未完成任务 / 未定档文件（draft）/ 必交成果缺件（A4-20 逐节点跑 GateService.evaluateNode）；
 *      首次归档 422 ARCHIVE_GATE_NOT_PASSED 返回明细，项目编辑者确认（confirm = true）后放行，缺项随清单 acknowledgedMissing 留痕。
 *   3. 归档事务（全部同事务）：锁项目行 → 乐观锁 version 判定 → 置 status = archived + archived_at / archived_by →
 *      生成 project_archives 清单 → 撤销进行中的上传会话 → 审计 action = archive；不删数据、不改阶段。
 *   4. 权限：仅最终项目编辑者（管理员或部门 / 个人规则 edit）；项目经理 / 成员 / 任务负责人关系本身不提升编辑权。记录级可见性由 ProjectAccessGuard 先行（404 语义）。
 */
@Injectable()
export class ArchiveService {
  constructor(
    private readonly database: DatabaseService,
    private readonly archive: ArchiveRepository,
    private readonly projects: ProjectRepository,
    private readonly flow: FlowService,
    private readonly gate: GateService,
    private readonly audit: AuditService,
  ) {}

  /** POST /projects/{id}/archive：门禁 + 置位 + 清单（缺项需 confirm=true 确认越过）。 */
  async archiveProject(projectId: string, body: ArchiveRequestBody, actorId: string): Promise<ProjectArchiveView> {
    const view = await this.projects.findViewById(projectId);
    if (view === null) throw new AppError("NOT_FOUND", "项目不存在或不可见");
    if (view.project.status === "archived") throw new AppError("PROJECT_ARCHIVED", "项目已归档");
    await this.flow.assertProjectEditor(projectId, actorId, "项目归档");
    const at = new Date();
    try {
      await this.database.db.transaction(async (tx) => {
        const locked = await this.archive.lockProjectRow(tx, projectId);
        if (locked === null || locked.deletedAt !== null) throw new AppError("NOT_FOUND", "项目不存在或不可见");
        if (locked.status === "archived") throw new AppError("PROJECT_ARCHIVED", "项目已归档");
        if (locked.version !== body.version) throw new AppError("VERSION_CONFLICT", "项目已被他人更新，请刷新后重试");
        const acceptance = await this.archive.findAcceptanceStage(tx, projectId);
        if (acceptance === null || acceptance.status !== "done") {
          throw new AppError("ARCHIVE_NOT_READY", "项目尚未完成验收（验收阶段未完成；ADR-027 前置条件）");
        }
        const missing = await this.collectMissing(tx, projectId);
        if (missing.length > 0 && body.confirm !== true) {
          throw new ArchiveRejectedSignal(
            new AppError(
              "ARCHIVE_GATE_NOT_PASSED",
              "归档门禁未通过（" + missing.length + " 项缺项）—— 确认后带 confirm=true 重试",
              missing.map((item) => ({ code: item.code, message: item.message, path: "missing", meta: { ...item.meta } })),
            ),
          );
        }
        const updated = await this.archive.updateProjectArchived(tx, projectId, at, actorId, body.version);
        if (updated === null) throw new AppError("VERSION_CONFLICT", "项目已被他人更新，请刷新后重试");
        const snapshot = await this.buildSnapshot(tx, projectId, acceptance);
        const record = await this.archive.insertArchive(tx, {
          projectId,
          archivedAt: at,
          archivedBy: actorId,
          snapshot,
          acknowledgedMissing: missing,
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
          metadata: { archiveId: record.id, missingCount: missing.length },
        });
      });
    } catch (error) {
      if (error instanceof ArchiveRejectedSignal) {
        await this.audit.record(this.database.db, {
          actorId,
          action: "archive",
          objectType: "project",
          objectId: projectId,
          projectId,
          result: "failed",
          summary: "归档被门禁拒绝：" + error.appError.message,
          metadata: { errorCode: error.appError.code, details: error.appError.details },
        });
        throw error.appError;
      }
      throw error;
    }
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

  /** 缺项清单：未完成任务 → 未定档文件 → 必交成果缺件（A4-20；顺序稳定，明细可入 422 details 与清单）。 */
  private async collectMissing(client: DbClient, projectId: string): Promise<ArchiveMissingItem[]> {
    const missing: ArchiveMissingItem[] = [];
    for (const task of await this.archive.listUnfinishedTasks(client, projectId)) {
      missing.push({
        code: "task_not_done",
        message: "任务未完成：" + task.title + "（状态 " + task.status + (task.stageKey === null ? "，未分组" : "，阶段 " + task.stageKey) + "）",
        meta: { taskId: task.id, title: task.title, stageKey: task.stageKey, status: task.status },
      });
    }
    for (const file of await this.archive.listDraftFiles(client, projectId)) {
      missing.push({
        code: "file_not_final",
        message: "文件未定档：" + file.name + "（状态 draft）",
        meta: { fileId: file.id, name: file.name, docType: file.docType, status: file.status },
      });
    }
    for (const node of await this.archive.listProjectNodes(client, projectId)) {
      const gate = await this.gate.evaluateNode(client, node.id);
      for (const item of gate.missing) {
        missing.push({
          code: "doc_missing",
          message: "必交成果缺件：" + node.name + "（" + node.nodeKey + "）/" + item.docType + "（需 " + item.required + " 份，现有 " + item.present + "）",
          meta: { nodeId: node.id, nodeKey: node.nodeKey, docType: item.docType, required: item.required, present: item.present },
        });
      }
    }
    return missing;
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
