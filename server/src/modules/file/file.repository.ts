import { Injectable } from "@nestjs/common";
import { and, asc, count, desc, eq, ilike, inArray, isNotNull, isNull, lt, lte, ne, notInArray, or, sql, type SQL } from "drizzle-orm";
import type { DbClient, DbTransaction } from "../../db/db-client.js";
import { DatabaseService } from "../../db/database.service.js";
import { changeRequests } from "../../db/schema/change.js";
import { fileLinks, files, fileVersions, uploadSessions } from "../../db/schema/files.js";
import { projectNodes } from "../../db/schema/flow.js";
import { projectStages, projects } from "../../db/schema/projects.js";
import { tasks } from "../../db/schema/tasks.js";
import type { ChangeRequestListFilter, ChangeRequestSort } from "./change.query.js";
import type { FileListFilter, FileListSort } from "./file.query.js";

/**
 * file 模块数据访问（M4-01 上传管道 · M4-02 版本 / 定档 / 回溯 / 回收站）。
 *
 * 事务约定（对齐 task 模块）：写路径由服务层开事务并把 `tx` 传进来（审计 / Outbox 同事务）；
 * 会话与文件行在关键路径用 `for update` 串行化（防并发 complete / abort / 首次取分片 URL 竞态）。
 * 分片状态**不落表**（2026-09-18 评审定案）：以对象存储 ListParts 为唯一真相，本层只登记会话元数据。
 */

/** 项目摘要（发起上传的前置校验：存在 / 未软删 / 未归档）。 */
export interface FileProjectBriefRow {
  id: string;
  status: string;
  deletedAt: Date | null;
}

/** 节点摘要（nodeId 归属校验：必须属于该项目且未删除）。 */
export interface FileNodeBriefRow {
  id: string;
  projectId: string;
  deletedAt: Date | null;
}

/** 任务摘要（taskId 归属校验 + 任务定档闸 · Push 249）。 */
export interface FileTaskBriefRow {
  id: string;
  projectId: string;
  /** 任务当前负责人：文件定档会联动任务定档，权限必须与任务定档入口同口径。 */
  ownerIds: string[];
  /** 任务定档时间（非空 = 已定档：直接修改一律 409 TASK_FINALIZED；修改走变更，A4-13）。 */
  finalizedAt: Date | null;
}

export type FileRow = typeof files.$inferSelect;
export type FileVersionRow = typeof fileVersions.$inferSelect;
export type UploadSessionRow = typeof uploadSessions.$inferSelect;
export type ChangeRequestRow = typeof changeRequests.$inferSelect;

/**
 * 变更记录读面行（M4-04 读面）：变更本体 + 由 `file_versions.change_request_id` 反查的变更后文件 / 版本。
 * Push 319：导入表导入的变更没有「变更后文件」（源文件在微盘，人工后补）→ 读面改左连接，fileId / versionId /
 * versionSeq 可为空；写入切片（一变更一版本）语义不变，行内为空 = 导入遗留数据。
 */
export interface ChangeRequestJoinedRow {
  id: string;
  projectId: string;
  nodeId: string | null;
  stageKey: string | null;
  reason: string;
  beforeSummary: string | null;
  afterSummary: string | null;
  status: string;
  /** Push 314：变更前 / 变更后摘要附图（files.id 有序；迁移 0050 —— 随变更申请提交，读面按 id 取预览签名）。 */
  beforeSummaryFileIds: string[];
  afterSummaryFileIds: string[];
  appliedBy: string;
  /** 变更「填写者」（Push 347 / 迁移 0054）：导入表导入命中源表「填写者」列账号；应用内提交 / 未命中 / 存量行 = null。 */
  writerBy: string | null;
  appliedAt: Date;
  createdAt: Date;
  /** 导入遗留变更（源文件在微盘，未挂版本）= null。 */
  fileId: string | null;
  versionId: string | null;
  versionSeq: number | null;
}

export interface FileInsertInput {
  projectId: string;
  nodeId: string | null;
  taskId: string | null;
  docType: string | null;
  name: string;
  /** 上传管道只创建 draft（定档 / 归档随 M4-02）。 */
  status: string;
  createdBy: string;
}

export interface FileVersionInsertInput {
  fileId: string;
  seq: number;
  /** 契约键（ADR-006：`…/v{seq}/{contentHash}.{ext}`，complete 时由暂存键复制而来）。 */
  objectKey: string;
  sizeBytes: number;
  contentHash: string;
  mime: string | null;
  uploadedBy: string;
  uploadedAt: Date;
  /** M4-04：变更流新版本挂接的变更申请（file_versions.change_request_id）；非变更流为空。 */
  changeRequestId?: string | null;
}

/** 变更申请写入（M4-04：一期申请即通过；id 由服务层预生成，供同事务回填版本 / 关联 / 任务）。 */
export interface ChangeRequestInsertInput {
  id: string;
  projectId: string;
  nodeId: string | null;
  stageKey: string | null;
  reason: string;
  beforeSummary: string | null;
  afterSummary: string | null;
  appliedBy: string;
  /** Push 314：变更前 / 变更后摘要附图（files.id 有序；迁移 0050）。 */
  beforeSummaryFileIds: string[];
  afterSummaryFileIds: string[];
  appliedAt: Date;
  createdAt: Date;
}

export interface UploadSessionInsertInput {
  /** 服务层预生成：对象键（暂存键）需要 sessionId，不能等数据库默认值。 */
  id: string;
  fileId: string;
  intent: string;
  /** 暂存键 `…/staging/{sessionId}`（ADR-006 定案：complete 复制到契约键后清理）。 */
  objectKey: string;
  partSizeBytes: number;
  totalParts: number;
  sizeBytes: number;
  contentHash: string | null;
  mime: string | null;
  /** intent=change 的变更申请（reason / beforeSummary / afterSummary / stageKey）；version 意图为空。 */
  changePayload: Record<string, unknown> | null;
  createdBy: string;
  createdAt: Date;
  expiresAt: Date;
}

export interface UploadSessionPatch {
  status?: string;
  storageUploadId?: string;
  updatedAt?: Date;
  completedAt?: Date;
  abortedAt?: Date;
}

/** 同内容哈希的既有文件提示（A4-04 秒传提示；不强阻断）。 */
export interface DuplicateFileRow {
  fileId: string;
  name: string;
  sizeBytes: number;
  uploadedBy: string;
  uploadedAt: Date;
}

/** complete 后的文件增量（乐观锁 version 由服务层换算）。 */
export interface FileCompletePatch {
  currentVersionId: string;
  version: number;
  /** M4-04：变更流完成时置 changed（final → changed）；非变更流不传。 */
  status?: string;
  /** Push 256：变更流采纳「变更后文件名称」（更名 + 扩展名随上传）；未更名不传。 */
  name?: string;
  updatedAt: Date;
}

/**
 * 文件状态流转 patch（M4-02：定档 / 回溯 / 回收 / 恢复 / 彻底删除）。
 * 成对字段（finalized_ 两列、recycled_ 三列 + purge_after）由服务层保证同写同清（库侧有 CHECK）。
 */
export interface FileStatePatch {
  name?: string;
  status?: string;
  currentVersionId?: string | null;
  version?: number;
  finalizedAt?: Date | null;
  finalizedBy?: string | null;
  recycledAt?: Date | null;
  recycledBy?: string | null;
  recycledFromStatus?: string | null;
  purgeAfter?: Date | null;
  updatedAt?: Date;
}

/** file_links 行（M4-03 多态关联：project / task / node / report / issue / change）。 */
export type FileLinkRow = typeof fileLinks.$inferSelect;

/** 关联写入（唯一 (file_id, object_type, object_id)：重复写幂等忽略）。 */
export interface FileLinkInsertInput {
  fileId: string;
  objectType: string;
  objectId: string;
  createdBy: string;
  createdAt: Date;
}

const EXPORT_ID_CHUNK_SIZE = 1000;

async function loadByIdChunks<TRow>(
  ids: readonly string[],
  load: (chunk: string[]) => Promise<TRow[]>,
): Promise<TRow[]> {
  const unique = [...new Set(ids)];
  const rows: TRow[] = [];
  for (let index = 0; index < unique.length; index += EXPORT_ID_CHUNK_SIZE) {
    rows.push(...(await load(unique.slice(index, index + EXPORT_ID_CHUNK_SIZE))));
  }
  return rows;
}

@Injectable()
export class FileRepository {
  constructor(private readonly database: DatabaseService) {}

  async findProjectBrief(projectId: string, client: DbClient = this.database.db): Promise<FileProjectBriefRow | null> {
    const rows = await client
      .select({ id: projects.id, status: projects.status, deletedAt: projects.deletedAt })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    return rows[0] ?? null;
  }

  async findNodeBrief(nodeId: string, client: DbClient = this.database.db): Promise<FileNodeBriefRow | null> {
    const rows = await client
      .select({ id: projectNodes.id, projectId: projectNodes.projectId, deletedAt: projectNodes.deletedAt })
      .from(projectNodes)
      .where(eq(projectNodes.id, nodeId))
      .limit(1);
    return rows[0] ?? null;
  }

  async findTaskBrief(taskId: string, client: DbClient = this.database.db): Promise<FileTaskBriefRow | null> {
    const rows = await client
      .select({ id: tasks.id, projectId: tasks.projectId, ownerIds: tasks.ownerIds, finalizedAt: tasks.finalizedAt })
      .from(tasks)
      .where(eq(tasks.id, taskId))
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * 任务定档置位（Push 249 · 迁移 0044）：任务尚未定档时置位 finalized_at / finalized_by 并递增乐观锁版本；
   * 已定档 / 任务不存在 → 返回 null（幂等 —— 多次文件定档只置位一次）。
   */
  async markTaskFinalized(taskId: string, at: Date, actorId: string, client: DbClient): Promise<string | null> {
    const rows = await client
      .update(tasks)
      .set({ finalizedAt: at, finalizedBy: actorId, version: sql`${tasks.version} + 1`, updatedAt: at })
      .where(and(eq(tasks.id, taskId), isNull(tasks.finalizedAt)))
      .returning({ id: tasks.id });
    return rows[0]?.id ?? null;
  }

  /**
   * 任务定档兜底（防绕过补漏）：撤销该任务名下文件「在途（active）」的 version 上传会话。
   * 只撤 version —— change 是 A4-13 唯一保留的修改通道；返回条数供任务审计 metadata 记录
   * （对象存储未完成分片由生命周期兜底清理，同归档口径 ADR-027）。
   */
  async abortActiveTaskUploadSessions(taskId: string, at: Date, client: DbClient): Promise<number> {
    const fileIds = client.select({ id: files.id }).from(files).where(eq(files.taskId, taskId));
    const rows = await client
      .update(uploadSessions)
      .set({ status: "aborted", abortedAt: at, updatedAt: at })
      .where(
        and(
          eq(uploadSessions.status, "active"),
          eq(uploadSessions.intent, "version"),
          inArray(uploadSessions.fileId, fileIds),
        ),
      )
      .returning({ id: uploadSessions.id });
    return rows.length;
  }

  async insertFile(input: FileInsertInput, client: DbClient): Promise<FileRow> {
    const rows = await client
      .insert(files)
      .values({
        projectId: input.projectId,
        nodeId: input.nodeId,
        taskId: input.taskId,
        docType: input.docType,
        name: input.name,
        status: input.status,
        createdBy: input.createdBy,
        version: 0,
      })
      .returning();
    return rows[0]!;
  }

  async findFileById(fileId: string, client: DbClient = this.database.db): Promise<FileRow | null> {
    const rows = await client.select().from(files).where(eq(files.id, fileId)).limit(1);
    return rows[0] ?? null;
  }
  /** Push 314：变更前 / 变更后摘要附图校验用（按 id 批量取 id / 项目 / 状态；归属与回收判定在服务层）。 */
  async listSummaryFileBriefs(ids: readonly string[], client: DbClient = this.database.db): Promise<Array<{ id: string; projectId: string; status: string }>> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) {
      return [];
    }
    return client
      .select({ id: files.id, projectId: files.projectId, status: files.status })
      .from(files)
      .where(inArray(files.id, unique));
  }

  /** 行锁：complete / 后续定档路径用（同一文件的版本号分配串行化）。 */
  async lockFile(tx: DbTransaction, fileId: string): Promise<FileRow | null> {
    const rows = await tx.select().from(files).where(eq(files.id, fileId)).limit(1).for("update");
    return rows[0] ?? null;
  }

  async updateFileOnComplete(fileId: string, patch: FileCompletePatch, client: DbClient): Promise<FileRow> {
    const rows = await client
      .update(files)
      .set({
        currentVersionId: patch.currentVersionId,
        version: patch.version,
        ...(patch.status === undefined ? {} : { status: patch.status }),
        ...(patch.name === undefined ? {} : { name: patch.name }),
        updatedAt: patch.updatedAt,
      })
      .where(eq(files.id, fileId))
      .returning();
    return rows[0]!;
  }

  async insertVersion(input: FileVersionInsertInput, client: DbClient): Promise<FileVersionRow> {
    const rows = await client
      .insert(fileVersions)
      .values({
        fileId: input.fileId,
        seq: input.seq,
        objectKey: input.objectKey,
        sizeBytes: input.sizeBytes,
        contentHash: input.contentHash,
        mime: input.mime,
        uploadedBy: input.uploadedBy,
        uploadedAt: input.uploadedAt,
        changeRequestId: input.changeRequestId ?? null,
      })
      .returning();
    return rows[0]!;
  }

  /** 下一个版本号（同一文件内递增，从 1 开始）；锁下调用保证不重号。 */
  async nextVersionSeq(fileId: string, client: DbClient = this.database.db): Promise<number> {
    const rows = await client
      .select({ nextSeq: sql<number>`coalesce(max(${fileVersions.seq}), 0) + 1` })
      .from(fileVersions)
      .where(eq(fileVersions.fileId, fileId));
    return Number(rows[0]?.nextSeq ?? 1);
  }

  async listVersions(fileId: string, client: DbClient = this.database.db): Promise<FileVersionRow[]> {
    return client.select().from(fileVersions).where(eq(fileVersions.fileId, fileId)).orderBy(asc(fileVersions.seq));
  }

  /** 变更申请写入（M4-04：一期申请即通过，status 恒 applied）。 */
  async insertChangeRequest(input: ChangeRequestInsertInput, client: DbClient): Promise<ChangeRequestRow> {
    const rows = await client
      .insert(changeRequests)
      .values({
        id: input.id,
        projectId: input.projectId,
        nodeId: input.nodeId,
        stageKey: input.stageKey,
        reason: input.reason,
        beforeSummary: input.beforeSummary,
        afterSummary: input.afterSummary,
        beforeSummaryFileIds: input.beforeSummaryFileIds,
        afterSummaryFileIds: input.afterSummaryFileIds,
        status: "applied",
        appliedBy: input.appliedBy,
        appliedAt: input.appliedAt,
        createdAt: input.createdAt,
      })
      .returning();
    return rows[0]!;
  }

  /** 节点的阶段 key（变更记录的默认「变更阶段」；节点不存在 / 无阶段为空）。 */
  async findNodeStageKey(nodeId: string, client: DbClient = this.database.db): Promise<string | null> {
    const rows = await client
      .select({ stageKey: projectStages.stageKey })
      .from(projectNodes)
      .innerJoin(projectStages, eq(projectNodes.stageId, projectStages.id))
      .where(eq(projectNodes.id, nodeId))
      .limit(1);
    return rows[0]?.stageKey ?? null;
  }

  /**
   * R01 变更自动关联：查找「变更文件成果类型 ∈ 任务输出成果文件」的任务。
   *
   * ADR-024 多值命中（**已随迁移 0018 / Push 143 同批落地**，PR #111 评审第 3 条）：`tasks.deliverable_types`
   * 为 `text[]`，「变更文件 doc_type 属于其中任一取值即命中」（数组包含查询，走 GIN `ix_tasks_deliverable_types`）；
   * 空数组（不要求输出成果文件）的任务不参与 —— 不再有单值等值（旧的 `tasks.deliverable` 已随 0018 drop）。
   */
  async listTaskIdsByDeliverable(projectId: string, deliverable: string, client: DbClient): Promise<string[]> {
    const rows = await client
      .select({ id: tasks.id })
      .from(tasks)
      .where(
        and(
          eq(tasks.projectId, projectId),
          sql`${tasks.deliverableTypes} @> array[${deliverable}]::text[]`,
        ),
      );
    return rows.map((row) => row.id);
  }

  /**
   * R01 回写：任务「变更关联」**追加 + 去重**（A1-07 / A4-13；迁移 0020 起 `tasks.change_refs` 为 uuid[]，可多条）——
   * 已关联过同一变更的任务原样保留（幂等、不重复），否则追加到数组末位（数组顺序 = 关联先后，末位 = 最近一次变更）。
   * 不递增任务乐观锁 version（变更关联不视为任务编辑）；返回实际回写的任务行数。
   */
  async appendTasksChangeRefs(taskIds: readonly string[], changeRequestId: string, client: DbClient): Promise<number> {
    if (taskIds.length === 0) return 0;
    const rows = await client
      .update(tasks)
      .set({
        changeRefs: sql`case
          when ${changeRequestId}::uuid = any(${tasks.changeRefs}) then ${tasks.changeRefs}
          else array_append(${tasks.changeRefs}, ${changeRequestId}::uuid)
        end`,
      })
      .where(inArray(tasks.id, [...taskIds]))
      .returning({ id: tasks.id });
    return rows.length;
  }

  async insertSession(input: UploadSessionInsertInput, client: DbClient): Promise<UploadSessionRow> {
    const rows = await client
      .insert(uploadSessions)
      .values({
        id: input.id,
        fileId: input.fileId,
        intent: input.intent,
        status: "active",
        objectKey: input.objectKey,
        partSizeBytes: input.partSizeBytes,
        totalParts: input.totalParts,
        sizeBytes: input.sizeBytes,
        contentHash: input.contentHash,
        mime: input.mime,
        changePayload: input.changePayload,
        createdBy: input.createdBy,
        createdAt: input.createdAt,
        updatedAt: input.createdAt,
        expiresAt: input.expiresAt,
      })
      .returning();
    return rows[0]!;
  }

  async findSessionById(sessionId: string, client: DbClient = this.database.db): Promise<UploadSessionRow | null> {
    const rows = await client.select().from(uploadSessions).where(eq(uploadSessions.id, sessionId)).limit(1);
    return rows[0] ?? null;
  }

  /** 行锁：complete / abort / 首次取分片 URL 的串行化入口。 */
  async lockSession(tx: DbTransaction, sessionId: string): Promise<UploadSessionRow | null> {
    const rows = await tx.select().from(uploadSessions).where(eq(uploadSessions.id, sessionId)).limit(1).for("update");
    return rows[0] ?? null;
  }

  async updateSession(sessionId: string, patch: UploadSessionPatch, client: DbClient): Promise<UploadSessionRow> {
    const rows = await client.update(uploadSessions).set(patch).where(eq(uploadSessions.id, sessionId)).returning();
    return rows[0]!;
  }

  /** 秒传提示：同项目、同内容哈希的最近一条版本（排除回收站与本次新建的文件）。 */
  async findDuplicateByHash(
    projectId: string,
    contentHash: string,
    excludeFileId: string,
    client: DbClient = this.database.db,
  ): Promise<DuplicateFileRow | null> {
    const rows = await client
      .select({
        fileId: files.id,
        name: files.name,
        sizeBytes: fileVersions.sizeBytes,
        uploadedBy: fileVersions.uploadedBy,
        uploadedAt: fileVersions.uploadedAt,
      })
      .from(fileVersions)
      .innerJoin(files, eq(fileVersions.fileId, files.id))
      .where(
        and(
          eq(files.projectId, projectId),
          eq(fileVersions.contentHash, contentHash),
          ne(files.status, "recycled"),
          ne(files.id, excludeFileId),
        ),
      )
      .orderBy(desc(fileVersions.uploadedAt))
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * 附件域秒传复用（2026-10-12）：同项目、同内容哈希、无任务 / 节点 / 类型归属（纯附图）的既有文件。
   * 命中 = 上传发起直接复用（不建新文件 / 会话）；只认完成版本（join file_versions），空 draft 与上传中的会话不参与。
   * 任务成果上传不查本口（文件按 files.task_id 单归属，跨任务复用会吞掉新任务的文件列）。
   */
  async findAttachmentDuplicateByHash(
    projectId: string,
    contentHash: string,
    client: DbClient = this.database.db,
  ): Promise<DuplicateFileRow | null> {
    const rows = await client
      .select({
        fileId: files.id,
        name: files.name,
        sizeBytes: fileVersions.sizeBytes,
        uploadedBy: fileVersions.uploadedBy,
        uploadedAt: fileVersions.uploadedAt,
      })
      .from(files)
      .innerJoin(fileVersions, eq(fileVersions.fileId, files.id))
      .where(
        and(
          eq(files.projectId, projectId),
          eq(fileVersions.contentHash, contentHash),
          ne(files.status, "recycled"),
          isNull(files.taskId),
          isNull(files.nodeId),
          isNull(files.docType),
        ),
      )
      .orderBy(desc(fileVersions.uploadedAt))
      .limit(1);
    return rows[0] ?? null;
  }

  /** 过期但状态仍为 active 的会话（worker 清理入口；带 projectId，按到期时间升序先进先出）。 */
  async listExpiredActiveSessions(
    now: Date,
    limit: number,
    client: DbClient = this.database.db,
  ): Promise<(UploadSessionRow & { projectId: string })[]> {
    const rows = await client
      .select({ session: uploadSessions, projectId: files.projectId })
      .from(uploadSessions)
      .innerJoin(files, eq(uploadSessions.fileId, files.id))
      .where(and(eq(uploadSessions.status, "active"), lt(uploadSessions.expiresAt, now)))
      .orderBy(asc(uploadSessions.expiresAt))
      .limit(limit);
    return rows.map((row) => ({ ...row.session, projectId: row.projectId }));
  }

  /** 未完成会话计数（回放 / 运维观测用）。 */
  async countActiveSessionsForFile(fileId: string, client: DbClient = this.database.db): Promise<number> {
    const rows = await client
      .select({ total: sql<number>`count(*)` })
      .from(uploadSessions)
      .where(and(eq(uploadSessions.fileId, fileId), eq(uploadSessions.status, "active"), isNull(uploadSessions.completedAt)));
    return Number(rows[0]?.total ?? 0);
  }

  /** 状态流转写入（调用方持锁：定档 / 回溯 / 回收 / 恢复 / 彻底删除）。 */
  async updateFileState(fileId: string, patch: FileStatePatch, client: DbClient): Promise<FileRow> {
    const rows = await client.update(files).set(patch).where(eq(files.id, fileId)).returning();
    return rows[0]!;
  }

  /** 项目导出用：按 id 批量取文件（不做项目过滤，调用方按 projectId 再裁）。 */
  async findFilesByIds(ids: readonly string[], client: DbClient = this.database.db): Promise<FileRow[]> {
    return loadByIdChunks<FileRow>(ids, (chunk) => client.select().from(files).where(inArray(files.id, chunk)));
  }

  /** 项目导出用：按 id 批量取版本（不暴露给 HTTP 层）。 */
  async findVersionsByIds(ids: readonly string[], client: DbClient = this.database.db): Promise<FileVersionRow[]> {
    return loadByIdChunks<FileVersionRow>(ids, (chunk) => client.select().from(fileVersions).where(inArray(fileVersions.id, chunk)));
  }

  /** 指定版本行（回溯目标 / 版本详情；带 fileId 限定防跨文件越权）。 */
  async findVersionById(
    fileId: string,
    versionId: string,
    client: DbClient = this.database.db,
  ): Promise<FileVersionRow | null> {
    const rows = await client
      .select()
      .from(fileVersions)
      .where(and(eq(fileVersions.fileId, fileId), eq(fileVersions.id, versionId)))
      .limit(1);
    return rows[0] ?? null;
  }

  /** 回收站到期文件（worker 清理入口；按到期时间升序先进先出）。 */
  async listExpiredRecycledFiles(
    now: Date,
    limit: number,
    client: DbClient = this.database.db,
  ): Promise<FileRow[]> {
    return client
      .select()
      .from(files)
      .where(and(eq(files.status, "recycled"), lte(files.purgeAfter, now)))
      .orderBy(asc(files.purgeAfter))
      .limit(limit);
  }

  /** 彻底删除元数据：先版本后文件（upload_sessions 由外键 cascade；调用方先清 current_version_id）。 */
  async deleteVersionsByFile(fileId: string, client: DbClient): Promise<number> {
    const rows = await client.delete(fileVersions).where(eq(fileVersions.fileId, fileId)).returning({ id: fileVersions.id });
    return rows.length;
  }

  async deleteFile(fileId: string, client: DbClient): Promise<void> {
    await client.delete(files).where(eq(files.id, fileId));
  }

  /**
   * 文件库列表（M4-03 · A4-01）：项目 + 多值筛选 + 关键字 + 白名单排序 + 分页；
   * `total` 与 items 同一 where（分页元数据一致）。默认排除 recycled（口径见 file.query.ts）。
   */
  async listProjectFiles(
    projectId: string,
    filter: FileListFilter,
    sorts: readonly FileListSort[],
    limit: number,
    offset: number,
    client: DbClient = this.database.db,
  ): Promise<{ items: FileRow[]; total: number }> {
    const where = and(...fileLibraryConditions(projectId, filter));
    const items = await client
      .select()
      .from(files)
      .where(where)
      .orderBy(...fileLibraryOrderBy(sorts))
      .limit(limit)
      .offset(offset);
    const totals = await client.select({ value: count() }).from(files).where(where);
    return { items, total: Number(totals[0]?.value ?? 0) };
  }

  /**
   * 变更记录列表（M4-04 读面 · A4-15）：项目 + 多值阶段 / 节点 / 变更文件 / 申请人筛选 + 关键字 + 白名单排序 + 分页；
   * `total` 与 items 走同一 where（分页元数据一致）。fileId / versionId / versionSeq 由 file_versions 反查
   * （migration 0021 的部分索引 ix_file_versions_change_request）；Push 319 起左连接（导入变更无版本 → 字段空）。
   */
  async listChangeRequests(
    projectId: string,
    filter: ChangeRequestListFilter,
    sorts: readonly ChangeRequestSort[],
    limit: number,
    offset: number,
    client: DbClient = this.database.db,
  ): Promise<{ items: ChangeRequestJoinedRow[]; total: number }> {
    const where = and(...changeRequestConditions(projectId, filter));
    const items = await client
      .select(CHANGE_REQUEST_SELECT)
      .from(changeRequests)
      .leftJoin(fileVersions, eq(fileVersions.changeRequestId, changeRequests.id))
      .where(where)
      .orderBy(...changeRequestOrderBy(sorts))
      .limit(limit)
      .offset(offset);
    const totals = await client
      .select({ value: count() })
      .from(changeRequests)
      .leftJoin(fileVersions, eq(fileVersions.changeRequestId, changeRequests.id))
      .where(where);
    return { items, total: Number(totals[0]?.value ?? 0) };
  }

  /** 变更记录单条（M4-04 读面 · 详情）：不存在 → null；可见性由服务层按 projectId 判定（不可见统一 404）。 */
  async findChangeRequestJoinedById(
    changeRequestId: string,
    client: DbClient = this.database.db,
  ): Promise<ChangeRequestJoinedRow | null> {
    const rows = await client
      .select(CHANGE_REQUEST_SELECT)
      .from(changeRequests)
      .leftJoin(fileVersions, eq(fileVersions.changeRequestId, changeRequests.id))
      .where(eq(changeRequests.id, changeRequestId))
      .limit(1);
    return rows[0] ?? null;
  }

  /** 文件 → 关联（双向跳转读面；供日报 / 问题 / 变更模块与内部核对使用）。 */
  async listFileLinks(fileId: string, client: DbClient = this.database.db): Promise<FileLinkRow[]> {
    return client
      .select()
      .from(fileLinks)
      .where(eq(fileLinks.fileId, fileId))
      .orderBy(asc(fileLinks.createdAt), asc(fileLinks.id));
  }

  /** 关联 → 文件（从任务 / 节点 / 日报 / 问题 / 变更侧反查 file_id）。 */
  async listFileIdsByObject(objectType: string, objectId: string, client: DbClient = this.database.db): Promise<string[]> {
    const rows = await client
      .select({ fileId: fileLinks.fileId })
      .from(fileLinks)
      .where(and(eq(fileLinks.objectType, objectType), eq(fileLinks.objectId, objectId)))
      .orderBy(asc(fileLinks.createdAt), asc(fileLinks.id));
    return rows.map((row) => row.fileId);
  }

  /** 幂等写关联（on conflict do nothing：同一 (file, object) 重复写不报错、不重复行）。 */
  async insertFileLinks(rows: readonly FileLinkInsertInput[], client: DbClient): Promise<void> {
    if (rows.length === 0) return;
    await client
      .insert(fileLinks)
      .values(
        rows.map((row) => ({
          fileId: row.fileId,
          objectType: row.objectType,
          objectId: row.objectId,
          createdBy: row.createdBy,
          createdAt: row.createdAt,
        })),
      )
      .onConflictDoNothing();
  }
}

/** 变更记录读面列（变更本体 + 反查的文件 / 版本；与 ChangeRequestJoinedRow 同形）。 */
const CHANGE_REQUEST_SELECT = {
  id: changeRequests.id,
  projectId: changeRequests.projectId,
  nodeId: changeRequests.nodeId,
  stageKey: changeRequests.stageKey,
  reason: changeRequests.reason,
  beforeSummary: changeRequests.beforeSummary,
  afterSummary: changeRequests.afterSummary,
  beforeSummaryFileIds: changeRequests.beforeSummaryFileIds,
  afterSummaryFileIds: changeRequests.afterSummaryFileIds,
  status: changeRequests.status,
  appliedBy: changeRequests.appliedBy,
  writerBy: changeRequests.writerBy,
  appliedAt: changeRequests.appliedAt,
  createdAt: changeRequests.createdAt,
  fileId: fileVersions.fileId,
  versionId: fileVersions.id,
  versionSeq: fileVersions.seq,
} as const;

/**
 * 变更记录列表条件（M4-04 读面）：项目内 + 阶段多值（OR）/ 节点 / 变更文件 / 申请人 + 关键字
 * （变更原因 + 变更前后摘要，ILIKE 转义同文件库口径）。
 */
function changeRequestConditions(projectId: string, filter: ChangeRequestListFilter): SQL[] {
  const conditions: SQL[] = [eq(changeRequests.projectId, projectId)];
  if (filter.stageKeys !== null) conditions.push(inArray(changeRequests.stageKey, filter.stageKeys));
  if (filter.nodeId !== null) conditions.push(eq(changeRequests.nodeId, filter.nodeId));
  if (filter.fileId !== null) conditions.push(eq(fileVersions.fileId, filter.fileId));
  if (filter.appliedBy !== null) conditions.push(eq(changeRequests.appliedBy, filter.appliedBy));
  if (filter.keyword !== null) {
    const pattern = "%" + escapeLikePattern(filter.keyword) + "%";
    conditions.push(
      or(
        ilike(changeRequests.reason, pattern),
        ilike(changeRequests.beforeSummary, pattern),
        ilike(changeRequests.afterSummary, pattern),
      )!,
    );
  }
  return conditions;
}

/** 变更记录排序映射（白名单与 change.query.ts 一致）+ 稳定 tie-breaker（id 全库唯一，分页不跳行）。 */
const CHANGE_REQUEST_SORT_COLUMNS = {
  appliedAt: changeRequests.appliedAt,
  createdAt: changeRequests.createdAt,
} as const;

function changeRequestOrderBy(sorts: readonly ChangeRequestSort[]): SQL[] {
  const clauses: SQL[] = sorts.map((sort) =>
    sort.direction === "desc"
      ? desc(CHANGE_REQUEST_SORT_COLUMNS[sort.field])
      : asc(CHANGE_REQUEST_SORT_COLUMNS[sort.field]),
  );
  if (sorts.length === 0) clauses.push(desc(changeRequests.createdAt));
  clauses.push(asc(changeRequests.id));
  return clauses;
}

/** 文件库列表条件（M4-03）：默认排除回收站（显式给出 statuses 时以给出为准）；未完成上传没有版本，不对外展示。 */
function fileLibraryConditions(projectId: string, filter: FileListFilter): SQL[] {
  const conditions: SQL[] = [eq(files.projectId, projectId), isNotNull(files.currentVersionId)];
  if (filter.nodeId !== null) conditions.push(eq(files.nodeId, filter.nodeId));
  if (filter.taskId !== null) conditions.push(eq(files.taskId, filter.taskId));
  if (filter.statuses !== null) conditions.push(inArray(files.status, filter.statuses));
  else conditions.push(notInArray(files.status, ["recycled"]));
  if (filter.docTypes !== null) conditions.push(inArray(files.docType, filter.docTypes));
  if (filter.uploadedBy !== null) conditions.push(eq(files.createdBy, filter.uploadedBy));
  if (filter.keyword !== null) {
    conditions.push(ilike(files.name, "%" + escapeLikePattern(filter.keyword) + "%"));
  }
  return conditions;
}

/** 排序映射（白名单与 file.query.ts 一致）+ 稳定 tie-breaker（id 全库唯一，分页不跳行）。 */
const FILE_SORT_COLUMNS = {
  createdAt: files.createdAt,
  updatedAt: files.updatedAt,
  finalizedAt: files.finalizedAt,
  name: files.name,
  status: files.status,
} as const;

function fileLibraryOrderBy(sorts: readonly FileListSort[]): SQL[] {
  const clauses: SQL[] = sorts.map((sort) =>
    sort.direction === "desc" ? desc(FILE_SORT_COLUMNS[sort.field]) : asc(FILE_SORT_COLUMNS[sort.field]),
  );
  if (sorts.length === 0) clauses.push(desc(files.createdAt));
  clauses.push(asc(files.id));
  return clauses;
}

/** LIKE 通配符转义（PG 默认转义符为反斜杠；避开字面反斜杠，用字符码构造）。 */
function escapeLikePattern(value: string): string {
  const backslash = String.fromCharCode(92);
  return value
    .split(backslash)
    .join(backslash + backslash)
    .split("%")
    .join(backslash + "%")
    .split("_")
    .join(backslash + "_");
}
