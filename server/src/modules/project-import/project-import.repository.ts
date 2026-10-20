import { Injectable } from "@nestjs/common";
import { and, asc, eq, inArray, lte, sql } from "drizzle-orm";
import { DatabaseService } from "../../db/database.service.js";
import type { DbClient } from "../../db/db-client.js";
import { projectImportPreviews, type ProjectImportPreviewRow } from "../../db/schema/imports.js";
import { users } from "../../db/schema/identity.js";
import type { UserRow } from "../identity/index.js";
import { tasks } from "../../db/schema/tasks.js";
import { dailyReports, issues } from "../../db/schema/reports.js";
import { changeRequests } from "../../db/schema/change.js";
import { fileLinks, fileVersions, files } from "../../db/schema/files.js";
import { projects } from "../../db/schema/projects.js";
import { projectStakeholders, stakeholders } from "../../db/schema/stakeholders.js";

export type { ProjectImportPreviewRow };

/** 过期 pending 票据清扫：每轮最多处理条数（worker 周期任务，防止长事务 / 大结果集）。 */
export const IMPORT_PREVIEW_SWEEP_BATCH = 100;
/** 过期 pending 票据清扫周期（10 分钟）：启动即跑一次，随后周期重试。 */
export const IMPORT_PREVIEW_SWEEP_INTERVAL_MS = 10 * 60_000;

export interface PreviewInsertInput {
  id: string;
  fileName: string;
  fileSizeBytes: number;
  objectKey: string;
  payload: Record<string, unknown>;
  createdBy: string;
  expiresAt: Date;
}

export interface ImportTaskInsert {
  stageKey: string | null;
  taskNodeId: string | null;
  title: string;
  titleEn: string | null;
  ownerIds: string[];
  status: "pending" | "active" | "done";
  statusOverride: "overdue" | "early_done" | null;
  progress: number;
  plannedStart: string | null;
  plannedEnd: string | null;
  actualEnd: string | null;
  estimatedDays: number | null;
  headcount: number | null;
  deliverableTypes: string[];
  note: string | null;
  onTime: boolean | null;
  sortIndex: number;
}

export interface ImportReportInsert {
  authorId: string;
  reportDate: string;
  headcount: number | null;
  doneWork: string;
  plan: string | null;
  foundIssue: string | null;
  issueCategories: string[];
  suggestion: string | null;
}

export interface ImportReportIssueInsert {
  reportIndex: number;
  title: string;
  categories: string[];
  state: "open" | "in_progress" | "done";
  solution: string | null;
  reporterId: string;
  /** 处理人（Push 319）：源表没有处理人字段 —— 未解决（open / in_progress）默认 = 项目经理（服务层判定），已完成 = null。 */
  ownerId: string | null;
  raisedAt: string;
  ownerDepartment: string | null;
}

export interface ImportChangeInsert {
  stageKey: string | null;
  appliedAt: Date | null;
  reason: string;
  beforeSummary: string | null;
  afterSummary: string | null;
  /** 变更申请人（Push 347）：源表「变更申请人」命中账号；未命中 = 导入人（服务层算好，落库非空）。 */
  appliedBy: string;
  /** 填写者（Push 347）：源表「填写者」命中账号；未命中 / 缺列 = null（读面「填写者」回落申请人展示）。 */
  writerBy: string | null;
}

export interface ImportFileInsert {
  id: string;
  name: string;
  objectKey: string;
  sizeBytes: number;
  contentHash: string;
  mime: string | null;
  /** 挂接日报下标（与 insertReports 的返回同序）；变更前 / 变更后图 = null。 */
  reportIndex: number | null;
  /** 问题图且该日报生成了问题时 = 问题下标（与 insertReportIssues 的返回同序）：转挂问题侧（kind = 空串）。 */
  issueIndex: number | null;
  /** 变更表下标（变更前 / 变更后图；与 insertChangeRequests 的返回同序）：回填 change_requests 两列，不落 file_links。 */
  changeIndex: number | null;
  kind: "onsite" | "issue" | "change_before" | "change_after";
}

/** 干系人行（Push 324）：台账 stakeholders + 项目关联 project_stakeholders 同批写。 */
export interface ImportStakeholderInsert {
  name: string;
  companyType: string;
  company: string | null;
  title: string | null;
  phone: string | null;
  wechat: string | null;
  email: string | null;
  role: string | null;
  /** 录入人（源表「填写者」匹配库内账号；匹配不到 = null）。 */
  createdBy: string | null;
  /** 提交时间（源表「提交时间」；null = 用导入时间）。 */
  createdAt: Date | null;
}

/** 手动补充附件回挂变更的读面行（文件当前版本 + 归属）。 */
export interface ManualAttachFileRow {
  id: string;
  projectId: string;
  name: string;
  status: string;
  currentVersionId: string | null;
}

/** 手动补充附件回挂结果：attached = 本次挂上；already = 已挂同一变更；conflict = 变更已有其它版本 / 版本已挂其它变更；missing = 版本不存在；missing_change = 变更不存在。 */
export type ManualAttachOutcome = "attached" | "already" | "conflict" | "missing" | "missing_change";

/**
 * 导入表导入数据访问：预览票据（project_import_previews：插入 / 取回 / 状态机 / 过期清扫输入）+ 读面辅助（用户 / 节点库）+ 提交批量写入。
 * 写入方法全部接收调用方事务（tx），由服务层保证「建项目 + 全量数据」单事务。
 */
@Injectable()
export class ProjectImportRepository {
  constructor(private readonly database: DatabaseService) {}

  async insertPreview(input: PreviewInsertInput, at: Date, client: DbClient = this.database.db): Promise<ProjectImportPreviewRow> {
    const rows = await client
      .insert(projectImportPreviews)
      .values({
        id: input.id,
        fileName: input.fileName,
        fileSizeBytes: input.fileSizeBytes,
        objectKey: input.objectKey,
        payload: input.payload,
        status: "pending",
        createdBy: input.createdBy,
        createdAt: at,
        expiresAt: input.expiresAt,
      })
      .returning();
    const row = rows[0];
    if (row === undefined) throw new Error("project_import_previews insert 未返回记录");
    return row;
  }

  async findPreview(id: string): Promise<ProjectImportPreviewRow | null> {
    const rows = await this.database.db.select().from(projectImportPreviews).where(eq(projectImportPreviews.id, id)).limit(1);
    return rows[0] ?? null;
  }

  async markCommitted(id: string, projectId: string, at: Date, client: DbClient = this.database.db): Promise<void> {
    await client
      .update(projectImportPreviews)
      .set({ status: "committed", committedAt: at, committedProjectId: projectId })
      .where(eq(projectImportPreviews.id, id));
  }

  /** 过期未提交票据（worker 清理输入）：按到期时间升序限量，避免大结果集长占 worker。 */
  async listExpiredPreviews(now: Date, limit: number = IMPORT_PREVIEW_SWEEP_BATCH): Promise<ProjectImportPreviewRow[]> {
    return this.database.db
      .select()
      .from(projectImportPreviews)
      .where(and(eq(projectImportPreviews.status, "pending"), lte(projectImportPreviews.expiresAt, now)))
      .orderBy(asc(projectImportPreviews.expiresAt))
      .limit(limit);
  }

  /** 过期票据终态写入：仍限定 pending，防止清扫与提交并发时覆盖 committed。 */
  async markExpired(id: string): Promise<void> {
    await this.database.db
      .update(projectImportPreviews)
      .set({ status: "expired" })
      .where(and(eq(projectImportPreviews.id, id), eq(projectImportPreviews.status, "pending")));
  }

  /** 项目编号是否已占用（含未删行；硬删后释放 —— 与 projects_code_key 唯一约束同口径）。 */
  async projectCodeExists(code: string): Promise<boolean> {
    const rows = await this.database.db.select({ id: projects.id }).from(projects).where(eq(projects.code, code)).limit(1);
    return rows.length > 0;
  }

  async findUsersByUsernames(usernames: readonly string[]): Promise<UserRow[]> {
    if (usernames.length === 0) return [];
    return this.database.db.select().from(users).where(inArray(users.username, [...usernames]));
  }

  async findUsersByDisplayNames(names: readonly string[]): Promise<UserRow[]> {
    if (names.length === 0) return [];
    return this.database.db.select().from(users).where(inArray(users.displayName, [...names]));
  }

  async insertTasks(tx: DbClient, projectId: string, rows: ImportTaskInsert[], at: Date): Promise<string[]> {
    if (rows.length === 0) return [];
    const inserted = await tx
      .insert(tasks)
      .values(
        rows.map((row) => ({
          projectId,
          stageKey: row.stageKey,
          taskNodeId: row.taskNodeId,
          title: row.title,
          titleEn: row.titleEn,
          ownerIds: row.ownerIds,
          status: row.status,
          statusOverride: row.statusOverride,
          progress: String(row.progress),
          plannedStart: row.plannedStart,
          plannedEnd: row.plannedEnd,
          actualEnd: row.actualEnd,
          estimatedDays: row.estimatedDays,
          headcount: row.headcount,
          deliverableTypes: row.deliverableTypes,
          note: row.note,
          onTime: row.onTime,
          sortIndex: row.sortIndex,
          createdAt: at,
          updatedAt: at,
        })),
      )
      .returning({ id: tasks.id });
    return inserted.map((row) => row.id);
  }

  async insertReports(tx: DbClient, projectId: string, rows: ImportReportInsert[], at: Date): Promise<string[]> {
    if (rows.length === 0) return [];
    const inserted = await tx
      .insert(dailyReports)
      .values(
        rows.map((row) => ({
          projectId,
          authorId: row.authorId,
          reportDate: row.reportDate,
          state: "submitted",
          headcount: row.headcount,
          doneWork: row.doneWork,
          plan: row.plan,
          foundIssue: row.foundIssue,
          issueCategories: row.issueCategories,
          suggestion: row.suggestion,
          issueDrafts: [],
          stageKeys: [],
          submittedAt: at,
          createdAt: at,
          updatedAt: at,
          version: 1,
        })),
      )
      .returning({ id: dailyReports.id });
    return inserted.map((row) => row.id);
  }

  async insertReportIssues(
    tx: DbClient,
    projectId: string,
    reportIds: string[],
    rows: ImportReportIssueInsert[],
    at: Date,
  ): Promise<string[]> {
    if (rows.length === 0) return [];
    const values = rows.map((row) => {
      const reportId = reportIds[row.reportIndex];
      if (reportId === undefined) throw new Error("日报问题挂接失败：报告下标越界");
      const closed = row.state === "done";
      return {
        projectId,
        taskId: null,
        sourceReportId: reportId,
        title: row.title.length > 500 ? row.title.slice(0, 500) : row.title,
        categories: row.categories,
        state: row.state,
        reporterId: row.reporterId,
        ownerDepartment: row.ownerDepartment,
        ownerId: row.ownerId,
        raisedAt: row.raisedAt,
        solution: row.solution === null ? null : row.solution.length > 2000 ? row.solution.slice(0, 2000) : row.solution,
        closedAt: closed ? at : null,
        createdAt: at,
        updatedAt: at,
        version: 1,
      };
    });
    const inserted = await tx.insert(issues).values(values).returning({ id: issues.id });
    return inserted.map((row) => row.id);
  }

  async insertChangeRequests(tx: DbClient, projectId: string, rows: ImportChangeInsert[], at: Date): Promise<string[]> {
    if (rows.length === 0) return [];
    const inserted = await tx.insert(changeRequests).values(
      rows.map((row) => ({
        projectId,
        nodeId: null,
        stageKey: row.stageKey,
        reason: row.reason,
        beforeSummary: row.beforeSummary,
        afterSummary: row.afterSummary,
        status: "applied",
        appliedBy: row.appliedBy,
        writerBy: row.writerBy,
        appliedAt: row.appliedAt ?? at,
        createdAt: at,
      })),
    )
      .returning({ id: changeRequests.id });
    return inserted.map((row) => row.id);
  }

  /** 干系人入库（Push 324）：台账 + 项目关联同批写（导入单事务内）；返回干系人 id（与入参同序）。 */
  async insertStakeholders(
    tx: DbClient,
    projectId: string,
    rows: ImportStakeholderInsert[],
    actorId: string,
    at: Date,
  ): Promise<string[]> {
    if (rows.length === 0) return [];
    const inserted = await tx
      .insert(stakeholders)
      .values(
        rows.map((row) => ({
          name: row.name,
          companyType: row.companyType,
          company: row.company,
          title: row.title,
          phone: row.phone,
          wechat: row.wechat,
          email: row.email,
          role: row.role,
          createdBy: row.createdBy,
          createdAt: row.createdAt ?? at,
          updatedAt: row.createdAt ?? at,
        })),
      )
      .returning({ id: stakeholders.id });
    const ids = inserted.map((row) => row.id);
    await tx.insert(projectStakeholders).values(
      ids.map((stakeholderId) => ({ projectId, stakeholderId, linkedBy: actorId, linkedAt: at })),
    );
    return ids;
  }

  /** 变更关联回写（Push 319）：把「关联」列命中的变更挂到任务 change_refs（导入的新任务，直接置为本次列表）。 */
  async attachChangeRefs(tx: DbClient, updates: readonly { taskId: string; changeIds: readonly string[] }[]): Promise<void> {
    for (const update of updates) {
      if (update.changeIds.length === 0) continue;
      await tx.update(tasks).set({ changeRefs: [...update.changeIds] }).where(eq(tasks.id, update.taskId));
    }
  }

  /**
   * 文件入库（files + file_versions + file_links 挂接）：对象已在调用前上传，事务内只落元数据。
   * 挂接口径与日报模块一致：现场图挂日报（kind = onsite）；问题图随「日报已生成问题」转挂问题侧（object_type = issue、kind = 空串），
   * 未生成问题的日报问题图仍挂日报（kind = issue）；变更前 / 变更后附图（Push 349）不落 file_links，登记 files 后由 attachChangeSummaryImages 回填 change_requests 两列。
   */
  async insertFiles(
    tx: DbClient,
    projectId: string,
    reportIds: string[],
    issueIds: string[],
    rows: ImportFileInsert[],
    actorId: string,
    at: Date,
  ): Promise<void> {
    if (rows.length === 0) return;
    await tx.insert(files).values(
      rows.map((row) => ({
        id: row.id,
        projectId,
        nodeId: null,
        taskId: null,
        docType: null,
        name: row.name,
        status: "draft",
        version: 0,
        createdBy: actorId,
        createdAt: at,
        updatedAt: at,
      })),
    );
    await tx.insert(fileVersions).values(
      rows.map((row) => ({
        fileId: row.id,
        seq: 1,
        objectKey: row.objectKey,
        sizeBytes: row.sizeBytes,
        contentHash: row.contentHash,
        mime: row.mime,
        uploadedBy: actorId,
        uploadedAt: at,
      })),
    );
    const linkRows: { fileId: string; objectType: string; objectId: string; kind: string; createdBy: string; createdAt: Date }[] = [];
    for (const row of rows) {
      if (row.kind === "change_before" || row.kind === "change_after") continue;
      if (row.kind === "issue" && row.issueIndex !== null) {
        const issueId = issueIds[row.issueIndex];
        if (issueId === undefined) throw new Error("图片挂接失败：问题下标越界");
        linkRows.push({ fileId: row.id, objectType: "issue", objectId: issueId, kind: "", createdBy: actorId, createdAt: at });
        continue;
      }
      if (row.reportIndex === null) throw new Error("图片挂接失败：日报下标缺失");
      const reportId = reportIds[row.reportIndex];
      if (reportId === undefined) throw new Error("图片挂接失败：日报下标越界");
      linkRows.push({ fileId: row.id, objectType: "report", objectId: reportId, kind: row.kind, createdBy: actorId, createdAt: at });
    }
    if (linkRows.length > 0) {
      await tx.insert(fileLinks).values(linkRows);
    }
    for (const row of rows) {
      await tx
        .update(files)
        .set({ currentVersionId: sql`(select id from file_versions where file_id = ${row.id} and seq = 1)`, updatedAt: at })
        .where(eq(files.id, row.id));
    }
  }

  /** 手动补充附件：按 fileId 取文件归属与当前版本（服务层做项目 / 状态校验）。 */
  async findFileForManualAttach(fileId: string): Promise<ManualAttachFileRow | null> {
    const rows = await this.database.db
      .select({
        id: files.id,
        projectId: files.projectId,
        name: files.name,
        status: files.status,
        currentVersionId: files.currentVersionId,
      })
      .from(files)
      .where(eq(files.id, fileId))
      .limit(1);
    return rows[0] ?? null;
  }

  /** 变更所属项目（回挂前做归属校验；不存在 = null）。 */
  async findChangeProjectId(changeId: string): Promise<string | null> {
    const rows = await this.database.db
      .select({ projectId: changeRequests.projectId })
      .from(changeRequests)
      .where(eq(changeRequests.id, changeId))
      .limit(1);
    return rows[0]?.projectId ?? null;
  }

  /**
   * 手动补充附件回挂变更（同一事务）：file_versions.change_request_id = 本次变更 + 文件定档 + file_links(change)。
   * 一期「一变更一版本」：先锁变更行，再查该变更是否已有版本 —— 同文件重复调用 = 幂等 no-op；
   * 变更已有其它文件 = conflict；版本已挂其它变更 = conflict。
   */
  async attachChangeFile(
    tx: DbClient,
    input: { fileId: string; versionId: string; changeId: string; actorId: string; at: Date },
  ): Promise<ManualAttachOutcome> {
    const changes = await tx
      .select({ id: changeRequests.id })
      .from(changeRequests)
      .where(eq(changeRequests.id, input.changeId))
      .limit(1)
      .for("update");
    if (changes[0] === undefined) return "missing_change";
    const attached = await tx
      .select({ id: fileVersions.id })
      .from(fileVersions)
      .where(eq(fileVersions.changeRequestId, input.changeId))
      .limit(1);
    if (attached[0] !== undefined) {
      return attached[0].id === input.versionId ? "already" : "conflict";
    }
    const rows = await tx
      .select({ id: fileVersions.id, changeRequestId: fileVersions.changeRequestId })
      .from(fileVersions)
      .where(and(eq(fileVersions.id, input.versionId), eq(fileVersions.fileId, input.fileId)))
      .limit(1);
    const version = rows[0];
    if (version === undefined) return "missing";
    if (version.changeRequestId === input.changeId) return "already";
    if (version.changeRequestId !== null) return "conflict";
    await tx.update(fileVersions).set({ changeRequestId: input.changeId }).where(eq(fileVersions.id, input.versionId));
    await tx
      .update(files)
      .set({ status: "final", finalizedAt: input.at, finalizedBy: input.actorId, updatedAt: input.at })
      .where(eq(files.id, input.fileId));
    await tx
      .insert(fileLinks)
      .values({
        fileId: input.fileId,
        objectType: "change",
        objectId: input.changeId,
        kind: "",
        createdBy: input.actorId,
        createdAt: input.at,
      })
      .onConflictDoNothing();
    return "attached";
  }

  /** 变更附图回填（Push 349）：导入的变更前 / 变更后图（files.id 有序、≤ 30）→ change_requests 两列（同 0052 应用内口径：无 file_links、无外键）。 */
  async attachChangeSummaryImages(
    tx: DbClient,
    updates: readonly { changeId: string; beforeFileIds: readonly string[]; afterFileIds: readonly string[] }[],
  ): Promise<void> {
    for (const update of updates) {
      if (update.beforeFileIds.length === 0 && update.afterFileIds.length === 0) continue;
      await tx
        .update(changeRequests)
        .set({
          beforeSummaryFileIds: [...update.beforeFileIds].slice(0, 30),
          afterSummaryFileIds: [...update.afterFileIds].slice(0, 30),
        })
        .where(eq(changeRequests.id, update.changeId));
    }
  }
}
