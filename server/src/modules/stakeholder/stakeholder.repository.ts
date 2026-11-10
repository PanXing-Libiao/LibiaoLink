import { Injectable } from "@nestjs/common";
import { and, asc, desc, eq, ilike, inArray, isNull, or, sql } from "drizzle-orm";
import { DatabaseService } from "../../db/database.service.js";
import type { DbClient } from "../../db/db-client.js";
import { users } from "../../db/schema/identity.js";
import { projects } from "../../db/schema/projects.js";
import { projectStakeholders, stakeholders } from "../../db/schema/stakeholders.js";
import type { StakeholderFilter, StakeholderSort, StakeholderVisibility } from "./stakeholder.rules.js";

/** 台账行（含录入人显示名；DTO 裁剪在服务层做）。 */
export interface StakeholderRow {
  id: string;
  name: string;
  companyType: string;
  company: string | null;
  title: string | null;
  phone: string | null;
  wechat: string | null;
  email: string | null;
  remark: string | null;
  /** 干系人角色（A5-01 · Push 225 增列）。 */
  role: string | null;
  createdBy: string | null;
  createdByName: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** 关联项目行（A5-03 反查）。 */
export interface StakeholderProjectRow {
  stakeholderId: string;
  projectId: string;
  code: string;
  name: string;
}

export interface StakeholderInsertInput {
  name: string;
  companyType: string;
  company: string | null;
  title: string | null;
  phone: string | null;
  wechat: string | null;
  email: string | null;
  remark: string | null;
  role: string | null;
}

export interface StakeholderUpdatePatch {
  name?: string | undefined;
  companyType?: string | undefined;
  company?: string | null | undefined;
  title?: string | null | undefined;
  phone?: string | null | undefined;
  wechat?: string | null | undefined;
  email?: string | null | undefined;
  remark?: string | null | undefined;
  role?: string | null | undefined;
}

const ROW_COLUMNS = {
  id: stakeholders.id,
  name: stakeholders.name,
  companyType: stakeholders.companyType,
  company: stakeholders.company,
  title: stakeholders.title,
  phone: stakeholders.phone,
  wechat: stakeholders.wechat,
  email: stakeholders.email,
  remark: stakeholders.remark,
  role: stakeholders.role,
  createdBy: stakeholders.createdBy,
  createdByName: users.displayName,
  createdAt: stakeholders.createdAt,
  updatedAt: stakeholders.updatedAt,
};

/**
 * 干系人数据访问（j6）：台账（软删）+ 项目关联。
 * 记录级可见集由 stakeholder.rules 解出后传入（本层不判权限）；列表与总数共用同一 where 构造器，禁止两套口径。
 */
@Injectable()
export class StakeholderRepository {
  constructor(private readonly database: DatabaseService) {}

  /** 列表（含总数）：分页 + 白名单排序。 */
  async list(
    filter: StakeholderFilter,
    visibility: StakeholderVisibility,
    sort: StakeholderSort[],
    page: number,
    limit: number,
    client: DbClient = this.database.db,
  ): Promise<{ rows: StakeholderRow[]; total: number }> {
    const where = this.buildWhere(filter, visibility);
    if (where === null) return { rows: [], total: 0 };
    const rows = await client
      .select(ROW_COLUMNS)
      .from(stakeholders)
      .leftJoin(users, eq(users.id, stakeholders.createdBy))
      .where(where)
      .orderBy(...this.orderBy(sort))
      .limit(limit)
      .offset((page - 1) * limit);
    const counted = await client
      .select({ total: sql<number>`count(*)::int` })
      .from(stakeholders)
      .where(where);
    return { rows: rows as StakeholderRow[], total: counted[0]?.total ?? 0 };
  }

  /** 导出专用行读取：保持可见集、筛选与排序口径，不重复查询 total。 */
  async listForExport(
    filter: StakeholderFilter,
    visibility: StakeholderVisibility,
    sort: StakeholderSort[],
    page: number,
    limit: number,
    client: DbClient = this.database.db,
  ): Promise<StakeholderRow[]> {
    const where = this.buildWhere(filter, visibility);
    if (where === null) return [];
    return client
      .select(ROW_COLUMNS)
      .from(stakeholders)
      .leftJoin(users, eq(users.id, stakeholders.createdBy))
      .where(where)
      .orderBy(...this.orderBy(sort))
      .limit(limit)
      .offset((page - 1) * limit) as Promise<StakeholderRow[]>;
  }

  /** 导出专用总数：与 listForExport 共用筛选与可见集。 */
  async countForExport(
    filter: StakeholderFilter,
    visibility: StakeholderVisibility,
    client: DbClient = this.database.db,
  ): Promise<number> {
    const where = this.buildWhere(filter, visibility);
    if (where === null) return 0;
    const counted = await client
      .select({ total: sql<number>`count(*)::int` })
      .from(stakeholders)
      .where(where);
    return counted[0]?.total ?? 0;
  }

  /** 详情（软删行视为不存在 → 404，防 IDOR）。 */
  async findById(stakeholderId: string, client: DbClient = this.database.db): Promise<StakeholderRow | null> {
    const rows = await client
      .select(ROW_COLUMNS)
      .from(stakeholders)
      .leftJoin(users, eq(users.id, stakeholders.createdBy))
      .where(and(eq(stakeholders.id, stakeholderId), isNull(stakeholders.deletedAt)))
      .limit(1);
    return (rows[0] ?? null) as StakeholderRow | null;
  }

  /** 新建台账（created_by = 录入人，A5-04）。 */
  async insert(input: StakeholderInsertInput, actorId: string, at: Date, client: DbClient): Promise<StakeholderRow> {
    const inserted = await client
      .insert(stakeholders)
      .values({
        name: input.name,
        companyType: input.companyType,
        company: input.company,
        title: input.title,
        phone: input.phone,
        wechat: input.wechat,
        email: input.email,
        remark: input.remark,
        role: input.role,
        createdBy: actorId,
        createdAt: at,
        updatedAt: at,
      })
      .returning({ id: stakeholders.id });
    const id = inserted[0]?.id;
    if (id === undefined) throw new Error("stakeholders insert 未返回 id");
    const row = await this.findById(id, client);
    if (row === null) throw new Error("stakeholders insert 后读回失败：" + id);
    return row;
  }

  /** 部分更新（只写传入键；无变更时仍刷新 updated_at 与 updated_by 语义由审计承担）。 */
  async update(stakeholderId: string, patch: StakeholderUpdatePatch, at: Date, client: DbClient): Promise<StakeholderRow | null> {
    const values: Record<string, unknown> = { updatedAt: at };
    for (const key of ["name", "companyType", "company", "title", "phone", "wechat", "email", "remark", "role"] as const) {
      const value = patch[key];
      if (value !== undefined) values[key] = value;
    }
    const updated = await client
      .update(stakeholders)
      .set(values)
      .where(and(eq(stakeholders.id, stakeholderId), isNull(stakeholders.deletedAt)))
      .returning({ id: stakeholders.id });
    return updated.length === 0 ? null : this.findById(stakeholderId, client);
  }

  /** 软删（0009 口径）：置 deleted_at / deleted_by；项目关联保留（历史可追溯）。 */
  async softDelete(stakeholderId: string, actorId: string, at: Date, client: DbClient): Promise<boolean> {
    const deleted = await client
      .update(stakeholders)
      .set({ deletedAt: at, deletedBy: actorId })
      .where(and(eq(stakeholders.id, stakeholderId), isNull(stakeholders.deletedAt)))
      .returning({ id: stakeholders.id });
    return deleted.length > 0;
  }

  /** 关联项目（A5-03）：批量取（列表一次 join，避免 N+1）。 */
  async listProjects(stakeholderIds: string[], client: DbClient = this.database.db): Promise<StakeholderProjectRow[]> {
    if (stakeholderIds.length === 0) return [];
    return (await client
      .select({
        stakeholderId: projectStakeholders.stakeholderId,
        projectId: projects.id,
        code: projects.code,
        name: projects.name,
      })
      .from(projectStakeholders)
      .innerJoin(projects, eq(projects.id, projectStakeholders.projectId))
      .where(and(inArray(projectStakeholders.stakeholderId, stakeholderIds), isNull(projects.deletedAt)))
      .orderBy(asc(projects.code))) as StakeholderProjectRow[];
  }

  /** 项目存在且未软删（关联前置校验）。 */
  async projectExists(projectId: string, client: DbClient = this.database.db): Promise<boolean> {
    const rows = await client
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.id, projectId), isNull(projects.deletedAt)))
      .limit(1);
    return rows.length > 0;
  }

  /** 关联写入：冲突（已关联）返回 false —— 幂等，不重复写审计。 */
  async insertLink(stakeholderId: string, projectId: string, actorId: string, at: Date, client: DbClient): Promise<boolean> {
    const inserted = await client
      .insert(projectStakeholders)
      .values({ stakeholderId, projectId, linkedBy: actorId, linkedAt: at })
      .onConflictDoNothing({ target: [projectStakeholders.projectId, projectStakeholders.stakeholderId] })
      .returning({ id: projectStakeholders.id });
    return inserted.length > 0;
  }

  /** 解除关联：未关联返回 false（调用方转 404）。 */
  async deleteLink(stakeholderId: string, projectId: string, client: DbClient): Promise<boolean> {
    const removed = await client
      .delete(projectStakeholders)
      .where(and(eq(projectStakeholders.stakeholderId, stakeholderId), eq(projectStakeholders.projectId, projectId)))
      .returning({ id: projectStakeholders.id });
    return removed.length > 0;
  }

  /**
   * 记录级 + 过滤条件（列表与总数共用）：软删恒排除。
   * restricted 下两个来源都没有 → 返回 null（空集，不查库）。
   */
  private buildWhere(filter: StakeholderFilter, visibility: StakeholderVisibility) {
    const conditions = [isNull(stakeholders.deletedAt)];
    if (visibility.kind === "restricted") {
      const parts = [];
      if (visibility.ownId !== null) parts.push(eq(stakeholders.createdBy, visibility.ownId));
      if (visibility.projectIds.length > 0) {
        parts.push(
          inArray(
            stakeholders.id,
            this.database.db
              .select({ id: projectStakeholders.stakeholderId })
              .from(projectStakeholders)
              .where(inArray(projectStakeholders.projectId, visibility.projectIds)),
          ),
        );
      }
      if (parts.length === 0) return null;
      conditions.push(or(...parts)!);
    }
    if (filter.keyword !== null) {
      const like = "%" + filter.keyword + "%";
      conditions.push(or(ilike(stakeholders.name, like), ilike(stakeholders.company, like), ilike(stakeholders.title, like))!);
    }
    if (filter.companyTypes !== null) conditions.push(inArray(stakeholders.companyType, filter.companyTypes));
    if (filter.projectId !== null) {
      conditions.push(
        inArray(
          stakeholders.id,
          this.database.db
            .select({ id: projectStakeholders.stakeholderId })
            .from(projectStakeholders)
            .where(eq(projectStakeholders.projectId, filter.projectId)),
        ),
      );
    }
    return and(...conditions);
  }

  private orderBy(sort: StakeholderSort[]) {
    return sort.map((item) => {
      const column = item.field === "name" ? stakeholders.name : item.field === "createdAt" ? stakeholders.createdAt : stakeholders.updatedAt;
      return item.direction === "asc" ? asc(column) : desc(column);
    });
  }
}
