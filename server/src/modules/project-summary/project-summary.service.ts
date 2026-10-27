import { Injectable } from "@nestjs/common";
import {
  type ProjectSummaryLatestResponse,
  type ProjectSummaryNarrative,
  type ProjectSummaryView,
} from "@libiaolink/contracts";
import { AppError } from "../../common/errors/app-error.js";
import { DatabaseService } from "../../db/database.service.js";
import type { DbClient } from "../../db/db-client.js";
import { AuditService } from "../admin/index.js";
import { ChangeService, FileService } from "../file/index.js";
import { UserService } from "../identity/index.js";
import { PermissionService, type ProjectAccessContext } from "../permission/index.js";
import { FlowService, ProjectService } from "../project/index.js";
import { IssueService, ReportService } from "../report-issue/index.js";
import { TaskService } from "../task/index.js";
import { PROJECT_SUMMARY_PROMPT_VERSION, ProjectSummaryAiService } from "./project-summary.ai.js";
import {
  ProjectSummaryRepository,
  type ProjectSummaryRow,
} from "./project-summary.repository.js";
import {
  buildProjectSummaryFacts,
  type ProjectSummarySource,
  type SummaryFileInput,
  type SummaryTaskInput,
} from "./project-summary.rules.js";

const PAGE_SIZE = 200;
const MAX_PAGES = 100;
const GENERATE_COOLDOWN_MS = 15_000;

async function collectPages<T>(
  load: (page: number, limit: number) => Promise<{ items: T[]; total: number }>,
  section: string,
): Promise<T[]> {
  const rows: T[] = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const result = await load(page, PAGE_SIZE);
    rows.push(...result.items);
    if (result.items.length === 0 || rows.length >= result.total) return rows;
  }
  throw new AppError("VALIDATION_FAILED", section + "超过项目总结上限（" + String(MAX_PAGES * PAGE_SIZE) + " 条），请先清理或归档无关数据");
}

@Injectable()
export class ProjectSummaryService {
  constructor(
    private readonly database: DatabaseService,
    private readonly repository: ProjectSummaryRepository,
    private readonly ai: ProjectSummaryAiService,
    private readonly projects: ProjectService,
    private readonly flow: FlowService,
    private readonly tasks: TaskService,
    private readonly reports: ReportService,
    private readonly issues: IssueService,
    private readonly files: FileService,
    private readonly changes: ChangeService,
    private readonly users: UserService,
    private readonly permission: PermissionService,
    private readonly audit: AuditService,
  ) {}

  async latest(
    projectId: string,
    actorId: string,
    access: ProjectAccessContext,
  ): Promise<ProjectSummaryLatestResponse> {
    const row = await this.repository.findLatest(projectId);
    if (row === null) {
      return { item: null, canEdit: await this.canEdit(actorId, access) };
    }
    const item = await this.toView(row, actorId, access);
    return { item, canEdit: item.canEdit };
  }

  /** 生成新草稿：事实包先定稿，再让 AI 只写叙述；AI 任何异常都由 AI 服务回落规则模板。 */
  async generate(
    projectId: string,
    actorId: string,
    access: ProjectAccessContext,
  ): Promise<ProjectSummaryView> {
    await this.assertEditor(actorId, access);
    const now = new Date();
    const recent = await this.repository.findRecentGeneration(projectId, actorId, new Date(now.getTime() - GENERATE_COOLDOWN_MS));
    if (recent !== null) {
      const retryAt = new Date(recent.generatedAt.getTime() + GENERATE_COOLDOWN_MS).toISOString();
      throw new AppError("RATE_LIMITED", "项目总结生成过于频繁，请稍后重试", [
        { code: "rate_limited", message: "请稍后重试", path: "generatedAt", meta: { retryAt } },
      ]);
    }

    const project = await this.projects.getProject(projectId, actorId);
    const [stages, tasks, reports, issues, files, changes] = await Promise.all([
      this.flow.listStages(projectId),
      collectPages((page, limit) => this.tasks.list(projectId, { page, limit }), "任务"),
      collectPages((page, limit) => this.reports.list(projectId, { page, limit }), "日报"),
      collectPages((page, limit) => this.issues.list(projectId, { page, limit }), "问题"),
      collectPages((page, limit) => this.files.listProjectFiles(projectId, { page, limit }), "文件"),
      collectPages((page, limit) => this.changes.listProjectChanges(projectId, { page, limit, sort: "appliedAt:asc" }), "变更"),
    ]);

    const source: ProjectSummarySource = {
      project: {
        id: project.id,
        code: project.code,
        name: project.name,
        customer: project.customer,
        region: project.region,
        projectType: project.projectType,
        stageKey: project.stageKey,
        status: project.status,
        managerNames: project.managerNames,
        description: project.description,
        createdAt: project.createdAt,
        archivedAt: project.archivedAt,
      },
      stages: stages.stages.map((stage) => ({
        stageKey: stage.stageKey,
        name: stage.name,
        seq: stage.seq,
        status: stage.status,
        nodes: stage.nodes,
        tasks: stage.tasks,
        plannedStart: stage.plannedStart,
        plannedEnd: stage.plannedEnd,
        actualStart: stage.actualStart,
        actualEnd: stage.actualEnd,
        advancedAt: stage.advancedAt,
      })),
      tasks: tasks.map((task): SummaryTaskInput => ({
        id: task.id,
        title: task.title,
        ownerIds: task.ownerIds,
        ownerNames: task.ownerNames,
        status: task.status,
        displayStatus: task.displayStatus,
        progress: task.progress,
        plannedEnd: task.plannedEnd,
        actualEnd: task.actualEnd,
        deliverableTypes: task.deliverableTypes,
        updatedAt: task.updatedAt,
        createdAt: task.createdAt,
      })),
      reports,
      issues,
      files: files.map((file): SummaryFileInput => ({
        id: file.id,
        taskId: file.taskId,
        docType: file.docType,
        name: file.name,
        status: file.status,
        finalizedAt: file.finalizedAt,
        createdAt: file.createdAt,
      })),
      changes: changes.map((change) => ({
        id: change.id,
        reason: change.reason,
        beforeSummary: change.beforeSummary,
        afterSummary: change.afterSummary,
        stageKey: change.stageKey,
        appliedAt: change.appliedAt,
      })),
      now,
    };

    const facts = buildProjectSummaryFacts(source);
    const narrative = await this.ai.generate(facts);
    const row = await this.database.db.transaction(async (tx) => {
      const inserted = await this.repository.insert(
        {
          projectId,
          dataCutoff: new Date(facts.dataCutoff),
          facts,
          narrative: narrative.narrative,
          generatorEngine: narrative.engine,
          generatorModel: narrative.model,
          promptVersion: PROJECT_SUMMARY_PROMPT_VERSION,
          fallbackReason: narrative.fallbackReason,
          generatedBy: actorId,
          generatedAt: now,
        },
        tx,
      );
      await this.audit.record(tx, {
        actorId,
        action: "create",
        objectType: "project_summary",
        objectId: inserted.id,
        projectId,
        summary: "生成项目总结草稿：" + project.code + " " + project.name,
        metadata: {
          engine: narrative.engine,
          model: narrative.model,
          fallbackReason: narrative.fallbackReason,
          issues: facts.counts.issuesTotal,
          unresolvedIssues: facts.counts.issuesUnresolved,
          gaps: facts.gaps.length,
          deliverablesMissing: facts.counts.deliverablesMissing,
        },
      });
      return inserted;
    });
    return this.toView(row, actorId, access);
  }

  /** 保存叙述草稿：事实包只读；仅 draft 可编辑，乐观锁防覆盖。 */
  async update(
    projectId: string,
    summaryId: string,
    body: { version: number; narrative: ProjectSummaryNarrative },
    actorId: string,
    access: ProjectAccessContext,
  ): Promise<ProjectSummaryView> {
    await this.assertEditor(actorId, access);
    const previous = await this.requireSummary(projectId, summaryId);
    if (previous.status !== "draft") {
      throw new AppError("VERSION_CONFLICT", "已确认的项目总结不可编辑；如需修订，请重新生成草稿");
    }
    if (previous.version !== body.version) {
      throw new AppError("VERSION_CONFLICT", "项目总结已被他人更新，请刷新后重试");
    }
    const at = new Date();
    const changedFields = (Object.keys(body.narrative) as Array<keyof ProjectSummaryNarrative>).filter(
      (field) => previous.narrative[field] !== body.narrative[field],
    );
    const updated = await this.database.db.transaction(async (tx) => {
      const row = await this.repository.updateNarrative(projectId, summaryId, body.version, body.narrative, at, tx);
      if (row === null) return null;
      await this.audit.record(tx, {
        actorId,
        action: "update",
        objectType: "project_summary",
        objectId: summaryId,
        projectId,
        summary: "保存项目总结叙述草稿",
        changes: changedFields.map((field) => ({
          field: "narrative." + field,
          from: previous.narrative[field],
          to: body.narrative[field],
        })),
        metadata: { status: row.status, engine: row.generatorEngine, fields: changedFields },
      });
      return row;
    });
    if (updated !== null) return this.toView(updated, actorId, access);
    const current = await this.repository.findById(projectId, summaryId);
    if (current === null) throw new AppError("NOT_FOUND", "项目总结不存在");
    if (current.status !== "draft") throw new AppError("VERSION_CONFLICT", "已确认的项目总结不可编辑；如需修订，请重新生成草稿");
    throw new AppError("VERSION_CONFLICT", "项目总结已被他人更新，请刷新后重试");
  }

  /** 项目经理确认发布：目标草稿变 confirmed；旧 confirmed 与其余草稿转 superseded，审计同事务。 */
  async confirm(
    projectId: string,
    summaryId: string,
    expectedVersion: number,
    actorId: string,
    access: ProjectAccessContext,
  ): Promise<ProjectSummaryView> {
    await this.assertEditor(actorId, access);
    const at = new Date();
    const result = await this.repository.confirm(projectId, summaryId, expectedVersion, actorId, at, async (tx, row) => {
      await this.audit.record(tx, {
        actorId,
        action: "update",
        objectType: "project_summary",
        objectId: summaryId,
        projectId,
        summary: "确认项目总结：" + row.facts.project.code + " " + row.facts.project.name,
        metadata: {
          operation: "confirm",
          dataCutoff: row.dataCutoff.toISOString(),
          engine: row.generatorEngine,
          issuesUnresolved: row.facts.counts.issuesUnresolved,
          gaps: row.facts.gaps.length,
          deliverablesMissing: row.facts.counts.deliverablesMissing,
        },
      });
    });
    if (result.kind === "not_found") throw new AppError("NOT_FOUND", "项目总结不存在");
    if (result.kind === "version_conflict") throw new AppError("VERSION_CONFLICT", "项目总结已被他人更新，请刷新后重试");
    if (result.kind === "not_draft") throw new AppError("VERSION_CONFLICT", "只有草稿可以确认发布");
    return this.toView(result.row, actorId, access);
  }

  private async requireSummary(projectId: string, summaryId: string): Promise<ProjectSummaryRow> {
    const row = await this.repository.findById(projectId, summaryId);
    if (row === null) throw new AppError("NOT_FOUND", "项目总结不存在");
    return row;
  }

  private async assertEditor(actorId: string, access: ProjectAccessContext): Promise<void> {
    if (access.groupAccessLevel !== "edit") {
      throw new AppError("FORBIDDEN", "当前项目的部门权限为只读，不能生成或确认项目总结");
    }
    if (access.projectManager || (await this.permission.canManageGroupAccess(actorId))) return;
    throw new AppError("FORBIDDEN", "只有项目经理或系统管理员可以生成、编辑和确认项目总结");
  }

  private async toView(row: ProjectSummaryRow, actorId: string, access: ProjectAccessContext): Promise<ProjectSummaryView> {
    const [generatedByName, confirmedByName, canEdit] = await Promise.all([
      this.displayNameOf(row.generatedBy),
      row.confirmedBy === null ? Promise.resolve(null) : this.displayNameOf(row.confirmedBy),
      this.canEdit(actorId, access),
    ]);
    return {
      id: row.id,
      projectId: row.projectId,
      dataCutoff: row.dataCutoff.toISOString(),
      status: row.status as ProjectSummaryView["status"],
      facts: row.facts,
      narrative: row.narrative,
      engine: row.generatorEngine,
      model: row.generatorModel,
      promptVersion: row.promptVersion,
      fallbackReason: row.fallbackReason,
      generatedBy: row.generatedBy,
      generatedByName,
      generatedAt: row.generatedAt.toISOString(),
      confirmedBy: row.confirmedBy,
      confirmedByName,
      confirmedAt: row.confirmedAt === null ? null : row.confirmedAt.toISOString(),
      version: row.version,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      canEdit,
    };
  }

  private async canEdit(actorId: string, access: ProjectAccessContext): Promise<boolean> {
    if (access.groupAccessLevel !== "edit") return false;
    return access.projectManager || this.permission.canManageGroupAccess(actorId);
  }

  private async displayNameOf(userId: string): Promise<string | null> {
    try {
      return (await this.users.getUser(userId)).displayName;
    } catch {
      return null;
    }
  }
}
