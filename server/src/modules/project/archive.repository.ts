import { Injectable } from "@nestjs/common";
import { and, asc, count, eq, inArray, isNotNull, isNull, ne, sql } from "drizzle-orm";
import { DatabaseService } from "../../db/database.service.js";
import type { DbClient } from "../../db/db-client.js";
import { changeRequests } from "../../db/schema/change.js";
import { files, fileVersions, uploadSessions } from "../../db/schema/files.js";
import { projectNodes } from "../../db/schema/flow.js";
import { users } from "../../db/schema/identity.js";
import { projectArchives, projects, projectStages } from "../../db/schema/projects.js";
import { dailyReports, issues } from "../../db/schema/reports.js";
import { tasks } from "../../db/schema/tasks.js";

export type ProjectArchiveRow = typeof projectArchives.$inferSelect;

/** 归档记录 + 操作人姓名（归档清单读面，M7-04 · ADR-027）。 */
export interface ArchiveViewRow {
  archive: ProjectArchiveRow;
  archivedByName: string | null;
}

/** 未完成任务行（门禁缺项：任务清单逐条）。 */
export interface ArchiveUnfinishedTaskRow {
  id: string;
  title: string;
  stageKey: string | null;
  status: string;
}

/** 未定档文件行（门禁缺项：文件清单逐条）。 */
export interface ArchiveDraftFileRow {
  id: string;
  name: string;
  docType: string | null;
  status: string;
}

/** 清单文件行（含版本统计）。 */
export interface ArchiveFileSnapshotRow {
  id: string;
  name: string;
  docType: string | null;
  status: string;
  nodeId: string | null;
  versionCount: number;
  latestSeq: number | null;
  latestUploadedAt: Date | null;
}

/** 清单变更行（C4-01：id 与原因摘要）。 */
export interface ArchiveChangeRow {
  id: string;
  reason: string;
  stageKey: string | null;
  appliedAt: Date;
}

/**
 * 归档数据访问（M7-04 · ADR-027）：项目行锁、验收阶段、门禁清单查询、清单快照聚合与 project_archives 读写收敛在本层。
 */
@Injectable()
export class ArchiveRepository {
  constructor(private readonly database: DatabaseService) {}

  /** 归档事务内锁项目行（SELECT ... FOR UPDATE）：版本判定与置位在同一锁内，防并发归档 / 并发编辑。 */
  async lockProjectRow(tx: DbClient, projectId: string) {
    const rows = await tx.select().from(projects).where(eq(projects.id, projectId)).for("update");
    return rows[0] ?? null;
  }

  /** 验收阶段行（硬前置：status 必须 done）。 */
  async findAcceptanceStage(client: DbClient, projectId: string) {
    const rows = await client
      .select()
      .from(projectStages)
      .where(and(eq(projectStages.projectId, projectId), eq(projectStages.stageKey, "acceptance")))
      .limit(1);
    return rows[0] ?? null;
  }

  /** 未完成任务（项目内、未软删、非 done；含未分组）—— 门禁缺项与确认留痕的来源。 */
  async listUnfinishedTasks(client: DbClient, projectId: string): Promise<ArchiveUnfinishedTaskRow[]> {
    return client
      .select({ id: tasks.id, title: tasks.title, stageKey: tasks.stageKey, status: tasks.status })
      .from(tasks)
      .where(and(eq(tasks.projectId, projectId), isNull(tasks.deletedAt), ne(tasks.status, "done")))
      .orderBy(asc(tasks.stageKey), asc(tasks.sortIndex), asc(tasks.id));
  }

  /** 未定档文件（status = draft）—— 门禁缺项。 */
  async listDraftFiles(client: DbClient, projectId: string): Promise<ArchiveDraftFileRow[]> {
    return client
      .select({ id: files.id, name: files.name, docType: files.docType, status: files.status })
      .from(files)
      .where(and(eq(files.projectId, projectId), eq(files.status, "draft"), isNotNull(files.currentVersionId)))
      .orderBy(asc(files.name), asc(files.id));
  }

  /** 项目全部在册节点（未软删）—— 成果文件齐全性检查（A4-20）逐节点跑 GateService。 */
  async listProjectNodes(client: DbClient, projectId: string) {
    return client
      .select({ id: projectNodes.id, nodeKey: projectNodes.nodeKey, name: projectNodes.name })
      .from(projectNodes)
      .where(and(eq(projectNodes.projectId, projectId), isNull(projectNodes.deletedAt)))
      .orderBy(asc(projectNodes.seq), asc(projectNodes.id));
  }

  /** 任务数按状态分组（清单：任务数与状态分布）。 */
  async countTasksByStatus(client: DbClient, projectId: string): Promise<Record<string, number>> {
    const rows = await client
      .select({ status: tasks.status, value: count() })
      .from(tasks)
      .where(and(eq(tasks.projectId, projectId), isNull(tasks.deletedAt)))
      .groupBy(tasks.status);
    const result: Record<string, number> = {};
    for (const row of rows) result[row.status] = Number(row.value);
    return result;
  }

  /** 文件清单（含版本：版本数 / 最新版本序号与上传时间）；回收站文件状态原样记（不复制业务数据）。 */
  async listFileSnapshotRows(client: DbClient, projectId: string): Promise<ArchiveFileSnapshotRow[]> {
    return client
      .select({
        id: files.id,
        name: files.name,
        docType: files.docType,
        status: files.status,
        nodeId: files.nodeId,
        versionCount: sql<number>`(select count(*)::int from ${fileVersions} where ${fileVersions.fileId} = ${files.id})`,
        latestSeq: sql<number | null>`(select max(${fileVersions.seq}) from ${fileVersions} where ${fileVersions.fileId} = ${files.id})`,
        latestUploadedAt: sql<Date | null>`(select max(${fileVersions.uploadedAt}) from ${fileVersions} where ${fileVersions.fileId} = ${files.id})`,
      })
      .from(files)
      .where(and(eq(files.projectId, projectId), isNotNull(files.currentVersionId)))
      .orderBy(asc(files.name), asc(files.id));
  }

  /** 变更记录（C4-01：完整变更历史的 id 与摘要）。 */
  async listChanges(client: DbClient, projectId: string): Promise<ArchiveChangeRow[]> {
    return client
      .select({ id: changeRequests.id, reason: changeRequests.reason, stageKey: changeRequests.stageKey, appliedAt: changeRequests.appliedAt })
      .from(changeRequests)
      .where(eq(changeRequests.projectId, projectId))
      .orderBy(asc(changeRequests.appliedAt), asc(changeRequests.id));
  }

  /** 日报数按状态分组。 */
  async countReportsByState(client: DbClient, projectId: string): Promise<Record<string, number>> {
    const rows = await client
      .select({ state: dailyReports.state, value: count() })
      .from(dailyReports)
      .where(eq(dailyReports.projectId, projectId))
      .groupBy(dailyReports.state);
    const result: Record<string, number> = {};
    for (const row of rows) result[row.state] = Number(row.value);
    return result;
  }

  /** 问题数按状态分组。 */
  async countIssuesByState(client: DbClient, projectId: string): Promise<Record<string, number>> {
    const rows = await client
      .select({ state: issues.state, value: count() })
      .from(issues)
      .where(eq(issues.projectId, projectId))
      .groupBy(issues.state);
    const result: Record<string, number> = {};
    for (const row of rows) result[row.state] = Number(row.value);
    return result;
  }

  /** 归档置位：status = archived + archived_at / archived_by + 版本前移（乐观锁在 WHERE 内；不匹配返回 null）。 */
  async updateProjectArchived(tx: DbClient, projectId: string, at: Date, actorId: string, expectedVersion: number) {
    const rows = await tx
      .update(projects)
      .set({ status: "archived", archivedAt: at, archivedBy: actorId, version: sql`${projects.version} + 1`, updatedAt: at })
      .where(and(eq(projects.id, projectId), eq(projects.version, expectedVersion), isNull(projects.deletedAt)))
      .returning();
    return rows[0] ?? null;
  }

  /** 写入归档清单（一项目一份：唯一约束兜底并发）。 */
  async insertArchive(
    tx: DbClient,
    input: { projectId: string; archivedAt: Date; archivedBy: string; snapshot: unknown; acknowledgedMissing: unknown },
  ): Promise<ProjectArchiveRow> {
    const rows = await tx
      .insert(projectArchives)
      .values({
        projectId: input.projectId,
        archivedAt: input.archivedAt,
        archivedBy: input.archivedBy,
        snapshot: input.snapshot,
        acknowledgedMissing: input.acknowledgedMissing,
      })
      .returning();
    const row = rows[0];
    if (row === undefined) throw new Error("project_archives insert 未返回记录");
    return row;
  }

  /** 撤销进行中的上传会话（ADR-027：归档同时中止；对象存储未完成分片由生命周期兜底清理）。 */
  async abortActiveUploadSessions(tx: DbClient, projectId: string, at: Date): Promise<number> {
    const fileIds = tx.select({ id: files.id }).from(files).where(eq(files.projectId, projectId));
    const rows = await tx
      .update(uploadSessions)
      .set({ status: "aborted", abortedAt: at, updatedAt: at })
      .where(and(eq(uploadSessions.status, "active"), inArray(uploadSessions.fileId, fileIds)))
      .returning({ id: uploadSessions.id });
    return rows.length;
  }

  /** 归档记录读面（含操作人姓名）。 */
  async findArchive(client: DbClient, projectId: string): Promise<ArchiveViewRow | null> {
    const rows = await client
      .select({ archive: projectArchives, archivedByName: users.displayName })
      .from(projectArchives)
      .leftJoin(users, eq(users.id, projectArchives.archivedBy))
      .where(eq(projectArchives.projectId, projectId))
      .limit(1);
    return rows[0] ?? null;
  }
}
