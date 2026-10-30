import { Injectable } from "@nestjs/common";
import type {
  Stakeholder,
  StakeholderCreateBody,
  StakeholderDeleteResponse,
  StakeholderListQuery,
  StakeholderListResponse,
  StakeholderUpdateBody,
} from "@libiaolink/contracts";
import { AppError } from "../../common/errors/app-error.js";
import { DatabaseService } from "../../db/database.service.js";
import type { DbClient } from "../../db/db-client.js";
import { AuditService, diffRecords } from "../admin/index.js";
import type { ActorAuthorization } from "../identity/index.js";
import { PermissionService, projectFields } from "../permission/index.js";
import { StakeholderRepository } from "./stakeholder.repository.js";
import type { StakeholderProjectRow, StakeholderRow } from "./stakeholder.repository.js";
import { buildStakeholderFilter, parseStakeholderSort, stakeholderVisibility } from "./stakeholder.rules.js";
import type { StakeholderVisibility } from "./stakeholder.rules.js";

/** 台账快照（字段级留痕口径：九个业务字段可改 —— role 为 Push 225 增列）。 */
function stakeholderSnapshot(row: StakeholderRow): Record<string, unknown> {
  return {
    name: row.name,
    companyType: row.companyType,
    company: row.company,
    title: row.title,
    phone: row.phone,
    wechat: row.wechat,
    email: row.email,
    remark: row.remark,
    role: row.role,
  };
}

/**
 * 干系人用例（j6 · S8·stakeholder）：台账 CRUD（A5-01）、项目关联（A5-03）、字段级脱敏（A5-07 / C3-08）。
 * 1) 记录级：可见集 = 「我录入的」∪「关联项目落在我的可见项目内」（stakeholder.rules.stakeholderVisibility）；
 *    不可见 / 已软删一律 404（防 IDOR），与项目域同一口径。
 * 2) 字段级：联系方式（phone / wechat / email）、company / title、remark 按 h6 字段策略表裁剪 —— **无权字段不返回**（不做打码）。
 *    页面出口即本层输出；导出 / 搜索 / 消息出口（lan 线）复用同一策略表，五出口同源（C3-08）。
 * 3) 写权限：stakeholder.manage 叠加目标项目 edit；有关联项目时逐个项目裁决，未关联任何项目时要求全部项目编辑。
 * 4) 留痕：建 / 改 / 删 / 关联 / 解除全部写审计（对象 = stakeholder；项目关联经 metadata.projectId 定位）。
 */
@Injectable()
export class StakeholderService {
  constructor(
    private readonly database: DatabaseService,
    private readonly stakeholders: StakeholderRepository,
    private readonly permission: PermissionService,
    private readonly audit: AuditService,
  ) {}

  /** GET /api/v1/stakeholders：按可见集裁剪的台账列表（含关联项目反查）。 */
  async list(query: StakeholderListQuery, actorId: string): Promise<StakeholderListResponse> {
    const authorization = await this.permission.getAuthorization(actorId);
    const visibility = stakeholderVisibility(authorization, await this.permission.projectScope(actorId));
    const filter = buildStakeholderFilter(query);
    const sort = parseStakeholderSort(query.sort);
    const { rows, total } = await this.stakeholders.list(filter, visibility, sort, query.page, query.limit);
    const links = await this.stakeholders.listProjects(rows.map((row) => row.id));
    return {
      items: rows.map((row) => this.toStakeholder(authorization, row, links)),
      page: query.page,
      limit: query.limit,
      total,
    };
  }

  /** GET /api/v1/stakeholders/{id}：不可见 / 已删除 404。 */
  async get(stakeholderId: string, actorId: string): Promise<Stakeholder> {
    const authorization = await this.permission.getAuthorization(actorId);
    const visibility = stakeholderVisibility(authorization, await this.permission.projectScope(actorId));
    const row = await this.requireVisible(stakeholderId, visibility, this.database.db);
    const links = await this.stakeholders.listProjects([row.id]);
    return this.toStakeholder(authorization, row, links);
  }

  /** POST /api/v1/stakeholders（stakeholder.manage）：目标项目均须可编辑；同事务写审计 create。 */
  async create(body: StakeholderCreateBody, actorId: string): Promise<Stakeholder> {
    const projectIds = [...new Set(body.projectIds ?? [])];
    await this.assertStakeholderWritable(
      actorId,
      projectIds,
      "新增干系人需要关联项目的编辑权限；未关联项目时需要全部项目编辑权限",
    );
    const at = new Date();
    let createdId = "";
    await this.database.db.transaction(async (tx) => {
      const row = await this.stakeholders.insert(
        {
          name: body.name,
          companyType: body.companyType,
          company: body.company ?? null,
          title: body.title ?? null,
          phone: body.phone ?? null,
          wechat: body.wechat ?? null,
          email: body.email ?? null,
          remark: body.remark ?? null,
          role: body.role ?? null,
        },
        actorId,
        at,
        tx,
      );
      createdId = row.id;
      for (const projectId of projectIds) {
        if (!(await this.stakeholders.projectExists(projectId, tx))) {
          throw new AppError("NOT_FOUND", "项目不存在或已删除：" + projectId);
        }
        await this.stakeholders.insertLink(row.id, projectId, actorId, at, tx);
      }
      await this.audit.record(tx, {
        actorId,
        action: "create",
        objectType: "stakeholder",
        objectId: row.id,
        summary: "新增干系人：" + row.name,
        changes: Object.entries(stakeholderSnapshot(row)).map(([field, value]) => ({ field, from: null, to: value })),
        metadata: { companyType: row.companyType, projectIds },
      });
    });
    return this.get(createdId, actorId);
  }

  /** PATCH /api/v1/stakeholders/{id}（stakeholder.manage）：全部关联项目均须可编辑；字段级留痕。 */
  async update(stakeholderId: string, body: StakeholderUpdateBody, actorId: string): Promise<Stakeholder> {
    const authorization = await this.permission.getAuthorization(actorId);
    const visibility = stakeholderVisibility(authorization, await this.permission.projectScope(actorId));
    const current = await this.requireVisible(stakeholderId, visibility, this.database.db);
    const linkedProjectIds = (await this.stakeholders.listProjects([current.id])).map((link) => link.projectId);
    await this.assertStakeholderWritable(
      actorId,
      linkedProjectIds,
      "更新干系人需要全部关联项目的编辑权限；未关联项目时需要全部项目编辑权限",
    );
    const at = new Date();
    await this.database.db.transaction(async (tx) => {
      const before = await this.requireVisible(stakeholderId, visibility, tx);
      const updated = await this.stakeholders.update(stakeholderId, body, at, tx);
      if (updated === null) throw new AppError("NOT_FOUND", "干系人不存在：" + stakeholderId);
      const changes = diffRecords(stakeholderSnapshot(before), stakeholderSnapshot(updated));
      await this.audit.record(tx, {
        actorId,
        action: "update",
        objectType: "stakeholder",
        objectId: stakeholderId,
        summary: "更新干系人：" + updated.name,
        changes: changes.length === 0 ? null : changes,
        metadata: { companyType: updated.companyType },
      });
    });
    return this.get(stakeholderId, actorId);
  }

  /** DELETE /api/v1/stakeholders/{id}（stakeholder.manage）：全部关联项目均须可编辑；软删后关联保留。 */
  async remove(stakeholderId: string, actorId: string): Promise<StakeholderDeleteResponse> {
    const authorization = await this.permission.getAuthorization(actorId);
    const visibility = stakeholderVisibility(authorization, await this.permission.projectScope(actorId));
    const current = await this.requireVisible(stakeholderId, visibility, this.database.db);
    const linkedProjectIds = (await this.stakeholders.listProjects([current.id])).map((link) => link.projectId);
    await this.assertStakeholderWritable(
      actorId,
      linkedProjectIds,
      "删除干系人需要全部关联项目的编辑权限；未关联项目时需要全部项目编辑权限",
    );
    const at = new Date();
    await this.database.db.transaction(async (tx) => {
      const before = await this.requireVisible(stakeholderId, visibility, tx);
      const deleted = await this.stakeholders.softDelete(stakeholderId, actorId, at, tx);
      if (!deleted) throw new AppError("NOT_FOUND", "干系人不存在：" + stakeholderId);
      await this.audit.record(tx, {
        actorId,
        action: "delete",
        objectType: "stakeholder",
        objectId: stakeholderId,
        summary: "删除干系人：" + before.name,
        changes: diffRecords(stakeholderSnapshot(before), null),
        metadata: { companyType: before.companyType, softDelete: true },
      });
    });
    return { id: stakeholderId, deleted: true };
  }

  /** POST /api/v1/stakeholders/{id}/projects（A5-03）：目标项目须可编辑；幂等关联（已关联不重复写审计）。 */
  async linkProject(stakeholderId: string, projectId: string, actorId: string): Promise<Stakeholder> {
    const authorization = await this.permission.getAuthorization(actorId);
    const visibility = stakeholderVisibility(authorization, await this.permission.projectScope(actorId));
    await this.requireVisible(stakeholderId, visibility, this.database.db);
    await this.assertStakeholderWritable(actorId, [projectId], "关联项目需要目标项目的编辑权限");
    const at = new Date();
    await this.database.db.transaction(async (tx) => {
      const row = await this.requireVisible(stakeholderId, visibility, tx);
      if (!(await this.stakeholders.projectExists(projectId, tx))) {
        throw new AppError("NOT_FOUND", "项目不存在或已删除：" + projectId);
      }
      const inserted = await this.stakeholders.insertLink(stakeholderId, projectId, actorId, at, tx);
      if (!inserted) return;
      await this.audit.record(tx, {
        actorId,
        action: "update",
        objectType: "stakeholder",
        objectId: stakeholderId,
        projectId,
        summary: "关联项目：" + row.name + " → " + projectId,
        changes: [{ field: "projects", from: null, to: projectId }],
        metadata: { projectId, link: "added" },
      });
    });
    return this.get(stakeholderId, actorId);
  }

  /** DELETE /api/v1/stakeholders/{id}/projects/{projectId}（A5-03）：目标项目须可编辑；未关联 404。 */
  async unlinkProject(stakeholderId: string, projectId: string, actorId: string): Promise<Stakeholder> {
    const authorization = await this.permission.getAuthorization(actorId);
    const visibility = stakeholderVisibility(authorization, await this.permission.projectScope(actorId));
    await this.requireVisible(stakeholderId, visibility, this.database.db);
    await this.assertStakeholderWritable(actorId, [projectId], "解除项目关联需要该项目的编辑权限");
    await this.database.db.transaction(async (tx) => {
      const row = await this.requireVisible(stakeholderId, visibility, tx);
      const removed = await this.stakeholders.deleteLink(stakeholderId, projectId, tx);
      if (!removed) throw new AppError("NOT_FOUND", "该干系人未关联此项目：" + projectId);
      await this.audit.record(tx, {
        actorId,
        action: "update",
        objectType: "stakeholder",
        objectId: stakeholderId,
        projectId,
        summary: "解除项目关联：" + row.name + " → " + projectId,
        changes: [{ field: "projects", from: projectId, to: null }],
        metadata: { projectId, link: "removed" },
      });
    });
    return this.get(stakeholderId, actorId);
  }

  /** 干系人写权限：有关联项目时逐个项目要求 edit；无关联项目时要求全部项目编辑 + stakeholder.manage。 */
  private async assertStakeholderWritable(actorId: string, projectIds: readonly string[], message: string): Promise<void> {
    const uniqueProjectIds = [...new Set(projectIds)];
    if (uniqueProjectIds.length === 0) {
      await this.permission.assertWritable(actorId, message);
      // 无项目上下文时项目级写键不会因 allEdit 自动放行；带上 edit 上下文复用同一角色能力位判定，
      // 部门条件已由 assertWritable 先限定为全部项目编辑。
      await this.permission.assertCan(
        actorId,
        "stakeholder.manage",
        { member: false, projectManager: false, groupAccessLevel: "edit" },
        message,
      );
      return;
    }
    for (const projectId of uniqueProjectIds) {
      const access = await this.permission.assertProjectVisible(actorId, projectId);
      await this.permission.assertCan(
        actorId,
        "stakeholder.manage",
        { member: access.member, projectManager: access.projectManager, groupAccessLevel: access.groupAccessLevel },
        message,
      );
    }
  }

  /** 记录级判定：不可见 / 不存在 / 已软删统一 404（不泄漏存在性）。 */
  private async requireVisible(stakeholderId: string, visibility: StakeholderVisibility, client: DbClient): Promise<StakeholderRow> {
    const row = await this.stakeholders.findById(stakeholderId, client);
    if (row === null) throw new AppError("NOT_FOUND", "干系人不存在：" + stakeholderId);
    if (visibility.kind === "all") return row;
    if (row.createdBy !== null && row.createdBy === visibility.ownId) return row;
    if (visibility.projectIds.length > 0) {
      const links = await this.stakeholders.listProjects([row.id], client);
      if (links.some((link) => visibility.projectIds.includes(link.projectId))) return row;
    }
    throw new AppError("NOT_FOUND", "干系人不存在：" + stakeholderId);
  }

  /**
   * 行 → 契约：先建全字段 DTO，再按字段策略表裁剪（无权键被移除）。
   * 必需键（id / name / companyType / createdBy / createdByName / projects / createdAt / updatedAt）均未登记在策略表，故裁剪不影响契约必填项。
   */
  private toStakeholder(authorization: ActorAuthorization, row: StakeholderRow, links: StakeholderProjectRow[]): Stakeholder {
    const dto: Stakeholder = {
      id: row.id,
      name: row.name,
      companyType: row.companyType as Stakeholder["companyType"],
      company: row.company,
      title: row.title,
      phone: row.phone,
      wechat: row.wechat,
      email: row.email,
      remark: row.remark,
      role: row.role,
      createdBy: row.createdBy,
      createdByName: row.createdByName,
      projects: links
        .filter((link) => link.stakeholderId === row.id)
        .map((link) => ({ id: link.projectId, code: link.code, name: link.name })),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
    return projectFields(authorization, "stakeholder", dto) as unknown as Stakeholder;
  }
}
