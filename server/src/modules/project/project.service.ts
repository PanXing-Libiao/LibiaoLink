import { Injectable, Logger } from "@nestjs/common";
import {
  ProjectFacetsSchema,
  ProjectListResponseSchema,
  ProjectPurgeResponseSchema,
  ProjectRecycleActionBodySchema,
  ProjectSchema,
  ProjectCreateBodySchema,
  ProjectUpdateBodySchema,
  z,
} from "@libiaolink/contracts";
import { AppError } from "../../common/errors/app-error.js";
import { DatabaseService } from "../../db/database.service.js";
import { appendOutbox } from "../../db/outbox.js";
import { AuditService, diffRecords } from "../admin/index.js";
import { PermissionService } from "../permission/index.js";
import type { ProjectScopeFilter } from "../permission/index.js";
import { ObjectStorage, toApiError } from "../../storage/index.js";
import { FlowService } from "./flow.service.js";
import {
  ProjectRepository,
  type ProjectInsertInput,
  type ProjectRow,
  type ProjectUpdateInput,
  type ProjectViewRow,
} from "./project.repository.js";
import { buildProjectFilter, parseProjectSort, type ProjectListQueryInput } from "./project.query.js";

export type ProjectView = z.infer<typeof ProjectSchema>;
export type ProjectListResult = z.infer<typeof ProjectListResponseSchema>;
export type ProjectFacetsResult = z.infer<typeof ProjectFacetsSchema>;
export type ProjectPurgeResult = z.infer<typeof ProjectPurgeResponseSchema>;

type ProjectCreateBody = z.infer<typeof ProjectCreateBodySchema>;
type ProjectUpdateBody = z.infer<typeof ProjectUpdateBodySchema>;
type ProjectRecycleActionBody = z.infer<typeof ProjectRecycleActionBodySchema>;

/** 创建时未指定阶段的兜底值：导入蓝图后会被前移到蓝图首个阶段（M2-02）。 */
const DEFAULT_STAGE_KEY = "presale";
const DAY_MS = 86_400_000;
/** 项目回收站保留期：移入后满 30 天由 worker 自动彻底删除（含聚合数据、文件与图片对象）。 */
export const PROJECT_RECYCLE_RETENTION_DAYS = 30;
/** 项目到期清理单批上限：每个项目含对象前缀清理，批更小以缩短单轮耗时。 */
export const PROJECT_RECYCLE_SWEEP_BATCH = 20;

/** 行 → 契约视图（camelCase 对齐；managerNames 随行下发，A2 / A22）。 */
export function toProjectView(view: ProjectViewRow): ProjectView {
  const row = view.project;
  return {
    id: row.id,
    code: row.code,
    seqNo: row.seqNo,
    name: row.name,
    customer: row.customer,
    region: row.region,
    projectType: row.projectType,
    managerIds: row.managerIds,
    managerNames: view.managerNames ?? row.managerIds.map(() => null),
    stageKey: row.stageKey as ProjectView["stageKey"],
    status: row.status as ProjectView["status"],
    description: row.description,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    archivedAt: row.archivedAt === null ? null : row.archivedAt.toISOString(),
    archivedBy: row.archivedBy,
    deletedAt: row.deletedAt === null ? null : row.deletedAt.toISOString(),
    deletedBy: row.deletedBy,
  };
}

/** 项目字段级留痕快照（C7-02；字段口径与契约一致，diff 由 AuditService 侧的 diffRecords 完成）。 */
function projectAuditSnapshot(row: ProjectRow): Record<string, unknown> {
  return {
    code: row.code,
    name: row.name,
    customer: row.customer,
    region: row.region,
    projectType: row.projectType,
    managerIds: row.managerIds,
    stageKey: row.stageKey,
    status: row.status,
    description: row.description,
  };
}

/** project 用例（M2-01 项目 CRUD + M2-04 首页列表 / facets）。 */
@Injectable()
export class ProjectService {
  private readonly logger = new Logger(ProjectService.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly projects: ProjectRepository,
    private readonly flow: FlowService,
    private readonly audit: AuditService,
    private readonly permission: PermissionService,
    private readonly storage: ObjectStorage,
  ) {}

  /** 列表（M2-04）：筛选 / 时间区间 / 排序与 facets 同口径；软删不可见（A5）+ 记录级可见集（h6）。 */
  async listProjects(query: ProjectListQueryInput, scope: ProjectScopeFilter): Promise<ProjectListResult> {
    const filter = buildProjectFilter(query);
    const sorts = parseProjectSort(query.sort);
    const { items, total } = await this.projects.listPage(filter, sorts, query.limit, (query.page - 1) * query.limit, scope);
    return { items: items.map(toProjectView), page: query.page, limit: query.limit, total };
  }

  /** 首页分类计数（M2-04 · A6）：五组固定返回，与列表同筛选口径。 */
  async getFacets(query: ProjectListQueryInput, scope: ProjectScopeFilter): Promise<ProjectFacetsResult> {
    const filter = buildProjectFilter(query);
    parseProjectSort(query.sort);
    return this.projects.facets(filter, scope);
  }

  async getProject(id: string): Promise<ProjectView> {
    const view = await this.projects.findViewById(id);
    if (view === null) {
      throw new AppError("NOT_FOUND", "项目不存在或不可见");
    }
    return toProjectView(view);
  }

  /**
   * 创建（M2-01 + M2-02 导入快照 · 单事务）：
   * 1) code 唯一由数据库唯一约束兜底（23505 → 409）、seq_no 由序列分配；
   * 2) 取该项目类型已发布蓝图（缺失回落 default 模板；可显式指定 blueprintVersion）→ 生成 stages / nodes / requirements；
   * 3) projects.stage_key 前移到蓝图首个阶段（或入参 stageKey 指定阶段）——任一步失败整体回滚。
   */
  async createProject(body: ProjectCreateBody, actorId: string): Promise<ProjectView> {
    const at = new Date();
    const input: ProjectInsertInput = {
      code: body.code,
      name: body.name,
      customer: body.customer ?? null,
      region: body.region,
      projectType: body.projectType,
      managerIds: body.managerIds,
      stageKey: body.stageKey ?? DEFAULT_STAGE_KEY,
      description: body.description ?? null,
    };
    const projectId = await this.database.db.transaction(async (tx) => {
      const row = await this.projects.insert(input, at, tx);
      const imported = await this.flow.importSnapshot(tx, {
        projectId: row.id,
        projectType: row.projectType,
        requestedStageKey: body.stageKey,
        requestedBlueprintVersion: body.blueprintVersion,
        at,
      });
      if (row.stageKey !== imported.activeStageKey) {
        await this.projects.setStageKey(row.id, imported.activeStageKey, at, tx);
      }
      await this.audit.record(tx, {
        actorId,
        action: "create",
        objectType: "project",
        objectId: row.id,
        projectId: row.id,
        summary: "创建项目：" + row.code + "（" + row.name + "）",
        changes: [
          { field: "code", from: null, to: row.code },
          { field: "name", from: null, to: row.name },
          { field: "customer", from: null, to: row.customer },
          { field: "region", from: null, to: row.region },
          { field: "projectType", from: null, to: row.projectType },
          { field: "managerIds", from: null, to: row.managerIds },
          { field: "stageKey", from: null, to: imported.activeStageKey },
        ],
      });
      return row.id;
    });
    const view = await this.projects.findViewById(projectId);
    if (view === null) throw new AppError("NOT_FOUND", "项目不存在或不可见");
    return toProjectView(view);
  }

  /** 更新（M2-01）：乐观锁（version 必须回传）；归档写保护（ADR-027）；code 变更同样校验唯一性；变更写审计（字段级）。 */
  async updateProject(id: string, body: ProjectUpdateBody, actorId: string): Promise<ProjectView> {
    const current = await this.projects.findViewById(id);
    if (current === null) {
      throw new AppError("NOT_FOUND", "项目不存在或不可见");
    }
    if (current.project.status === "archived") {
      throw new AppError("PROJECT_ARCHIVED", "项目已归档，禁止修改");
    }
    const patch: ProjectUpdateInput = {};
    if (body.code !== undefined) patch.code = body.code;
    if (body.name !== undefined) patch.name = body.name;
    if (body.customer !== undefined) patch.customer = body.customer;
    if (body.region !== undefined) patch.region = body.region;
    if (body.projectType !== undefined) patch.projectType = body.projectType;
    if (body.managerIds !== undefined) patch.managerIds = body.managerIds;
    if (body.stageKey !== undefined) patch.stageKey = body.stageKey;
    if (body.status !== undefined) patch.status = body.status;
    if (body.description !== undefined) patch.description = body.description;
    const at = new Date();
    const updated = await this.database.db.transaction(async (tx) => {
      const row = await this.projects.updateWithVersion(id, patch, body.version, at, tx);
      if (row === null) {
        const again = await this.projects.findViewById(id);
        if (again === null) {
          throw new AppError("NOT_FOUND", "项目不存在或不可见");
        }
        throw new AppError("VERSION_CONFLICT", "项目已被他人更新，请刷新后重试");
      }
      const changes = diffRecords(projectAuditSnapshot(current.project), projectAuditSnapshot(row));
      await this.audit.record(tx, {
        actorId,
        action: "update",
        objectType: "project",
        objectId: id,
        projectId: id,
        summary: "修改项目：" + row.code + "（" + row.name + "）",
        changes: changes.length > 0 ? changes : null,
      });
      if (body.status === "done" && current.project.status !== "done") {
        await appendOutbox(tx, {
          topic: "project.completed",
          dedupeKey: "project.completed:" + id + ":" + row.version,
          payload: {
            projectId: id,
            status: row.status,
            previousStatus: current.project.status,
            version: row.version,
            actorId,
            at: at.toISOString(),
          },
        });
      }
      return row;
    });
    const view = await this.projects.findViewById(id);
    return toProjectView(view ?? { project: updated, managerNames: current.managerNames });
  }

  /**
   * DELETE /projects/{id}：移入项目回收站（2026-10-19 口径）。
   * If-Match version 防误删；只写 deleted_at / deleted_by 并 version + 1，项目聚合数据与对象存储原样保留；
   * 归档项目仍禁删（ADR-027）；普通列表 / 详情 / facets 立即不可见，可从项目回收站恢复。
   */
  async deleteProject(id: string, version: number, actorId: string): Promise<ProjectView> {
    const current = await this.projects.findViewById(id);
    if (current === null) {
      throw new AppError("NOT_FOUND", "项目不存在或不可见");
    }
    if (current.project.status === "archived") {
      throw new AppError("PROJECT_ARCHIVED", "项目已归档，禁止删除");
    }
    const at = new Date();
    const recycled = await this.database.db.transaction(async (tx) => {
      const row = await this.projects.recycleWithVersion(id, version, at, actorId, tx);
      if (row === null) {
        const again = await this.projects.findRowById(id, tx);
        if (again === null || again.deletedAt !== null) {
          throw new AppError("NOT_FOUND", "项目不存在或已不在当前列表");
        }
        throw new AppError("VERSION_CONFLICT", "项目已被他人更新，请刷新后重试");
      }
      await this.audit.record(tx, {
        actorId,
        action: "delete",
        objectType: "project",
        objectId: id,
        projectId: id,
        summary: "移入项目回收站：" + row.code + "（" + row.name + "）",
        changes: [
          { field: "deletedAt", from: null, to: at.toISOString() },
          { field: "deletedBy", from: null, to: actorId },
        ],
        metadata: { recycled: true, previousStatus: current.project.status },
      });
      return row;
    });
    return toProjectView({ project: recycled, managerNames: current.managerNames });
  }

  /** POST /projects/{id}/restore：从项目回收站恢复；权限与可见性由 ProjectAccessGuard 判定。 */
  async restoreProject(id: string, body: ProjectRecycleActionBody, actorId: string): Promise<ProjectView> {
    const at = new Date();
    const restored = await this.database.db.transaction(async (tx) => {
      const locked = await this.projects.lockRowById(id, tx);
      if (locked === null) {
        throw new AppError("NOT_FOUND", "项目不存在或不可见");
      }
      const previousDeletedAt = locked.deletedAt;
      if (previousDeletedAt === null) {
        throw new AppError("VALIDATION_FAILED", "项目不在项目回收站，无需恢复");
      }
      if (locked.version !== body.version) {
        throw new AppError("VERSION_CONFLICT", "项目已被他人更新，请刷新后重试");
      }
      const row = await this.projects.restoreWithVersion(id, body.version, at, tx);
      if (row === null) {
        throw new AppError("VERSION_CONFLICT", "项目已被他人更新，请刷新后重试");
      }
      await this.audit.record(tx, {
        actorId,
        action: "update",
        objectType: "project",
        objectId: id,
        projectId: id,
        summary: "从项目回收站恢复：" + row.code + "（" + row.name + "）",
        changes: [{ field: "deletedAt", from: previousDeletedAt.toISOString(), to: null }],
        metadata: { restoredFrom: "project-recycle" },
      });
      return row;
    });
    const view = await this.projects.findViewById(id);
    return toProjectView(view ?? { project: restored, managerNames: null });
  }

  /** 项目彻底删除仅系统管理员（与文件彻底删除同一权限口径）。 */
  private async assertAdmin(actorId: string): Promise<void> {
    const permissions = await this.permission.permissionsOf(actorId);
    if (!permissions.roleCodes.includes("admin")) {
      throw new AppError("FORBIDDEN", "仅系统管理员可彻底删除项目");
    }
  }

  /**
   * POST /projects/{id}/purge：仅项目回收站中的项目可彻底删除。
   * 同事务内先按 projects/{id}/ 前缀清对象存储全部版本（项目图片 / 文件 / 暂存对象），
   * 再按外键顺序删项目聚合子表与项目行；存储失败整体回滚，项目留在回收站可重试。
   */
  async purgeProject(id: string, body: ProjectRecycleActionBody, actorId: string): Promise<ProjectPurgeResult> {
    await this.assertAdmin(actorId);
    const result = await this.purgeRecycledProject(
      id,
      { actorId, expectedVersion: body.version, reason: "管理员彻底删除" },
      new Date(),
    );
    if (result === null) {
      throw new AppError("NOT_FOUND", "项目不存在或不可见");
    }
    return result;
  }

  /**
   * 项目回收站到期清理（worker 每日调用）：移入回收站满 30 天的项目按批彻底删除。
   * 单个项目失败只告警，不阻断本轮其它项目；并发恢复 / 手动彻底删除在锁内复核后跳过。
   */
  async sweepExpiredRecycled(
    limit: number = PROJECT_RECYCLE_SWEEP_BATCH,
    now: Date = new Date(),
  ): Promise<{ scanned: number; purged: number }> {
    const cutoff = new Date(now.getTime() - PROJECT_RECYCLE_RETENTION_DAYS * DAY_MS);
    const rows = await this.projects.listExpiredRecycledProjects(cutoff, limit);
    let purged = 0;
    for (const row of rows) {
      try {
        const result = await this.purgeRecycledProject(
          row.id,
          {
            actorId: null,
            expectedVersion: row.version,
            dueBefore: cutoff,
            reason: "项目回收站到期自动清理",
          },
          now,
        );
        if (result !== null) purged += 1;
      } catch (error) {
        this.logger.warn(
          "项目回收站到期清理失败：" + row.id + " / " + (error instanceof Error ? error.message : String(error)),
        );
      }
    }
    return { scanned: rows.length, purged };
  }

  /**
   * 项目彻底删除公共链路（管理员手动 / worker 到期自动）：
   * 锁行后复核回收站、版本与到期时间，再清对象前缀、聚合子表和项目行；任一步失败整体回滚。
   * actorId = null 表示系统清理；快照过期 / 已恢复时静默跳过，不误删其它项目状态。
   */
  private async purgeRecycledProject(
    id: string,
    options: {
      actorId: string | null;
      expectedVersion?: number;
      dueBefore?: Date;
      reason: string;
    },
    at: Date,
  ): Promise<ProjectPurgeResult | null> {
    const system = options.actorId === null;
    return this.database.db.transaction(async (tx) => {
      const locked = await this.projects.lockRowById(id, tx);
      if (locked === null) {
        if (system) return null;
        throw new AppError("NOT_FOUND", "项目不存在或不可见");
      }
      if (options.expectedVersion !== undefined && locked.version !== options.expectedVersion) {
        if (system) return null;
        throw new AppError("VERSION_CONFLICT", "项目已被他人更新，请刷新后重试");
      }
      if (locked.deletedAt === null) {
        if (system) return null;
        throw new AppError("VALIDATION_FAILED", "仅项目回收站中的项目可彻底删除");
      }
      if (options.dueBefore !== undefined && locked.deletedAt.getTime() > options.dueBefore.getTime()) {
        return null;
      }
      let storageResult: { deletedVersions: number; deleteMarkers: number; deletedObjects: number };
      try {
        storageResult = await this.storage.purgePrefix("projects/" + id + "/");
      } catch (error) {
        throw toApiError(error);
      }
      const result = await this.projects.hardDeleteWithVersion(id, locked.version, tx);
      if (result === null) {
        throw new AppError("VERSION_CONFLICT", "项目已被他人更新，请刷新后重试");
      }
      const snapshot = projectAuditSnapshot(result.project);
      await this.audit.record(tx, {
        actorId: options.actorId,
        action: "delete",
        objectType: "project",
        objectId: id,
        projectId: id,
        summary:
          (system ? "项目回收站到期自动清理：" : "彻底删除项目：") +
          result.project.code +
          "（" +
          result.project.name +
          "）",
        changes: Object.keys(snapshot).map((field) => ({ field, from: snapshot[field], to: null })),
        metadata: {
          hardDelete: true,
          source: system ? "system" : "api",
          reason: options.reason,
          retentionDays: PROJECT_RECYCLE_RETENTION_DAYS,
          recycledAt: locked.deletedAt.toISOString(),
          children: result.children,
          objectStorage: storageResult,
        },
      });
      return { projectId: id, purgedAt: at.toISOString() };
    });
  }
}
