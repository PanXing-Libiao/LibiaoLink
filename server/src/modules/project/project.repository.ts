import { Injectable } from "@nestjs/common";
import { and, asc, count, desc, eq, gte, ilike, inArray, isNotNull, isNull, lt, or, sql, type SQL } from "drizzle-orm";
import { AppError } from "../../common/errors/app-error.js";
import { DatabaseService } from "../../db/database.service.js";
import type { DbClient } from "../../db/db-client.js";
import { changeRequests } from "../../db/schema/change.js";
import { files, fileVersions } from "../../db/schema/files.js";
import { follows } from "../../db/schema/follows.js";
import { nodeRequirements, projectNodes } from "../../db/schema/flow.js";
import { users } from "../../db/schema/identity.js";
import { projectArchives, projectMembers, projects, projectStages } from "../../db/schema/projects.js";
import { dailyReports, issueEvents, issues } from "../../db/schema/reports.js";
import { projectStakeholders } from "../../db/schema/stakeholders.js";
import { taskEvents, tasks } from "../../db/schema/tasks.js";
import type { ProjectScopeFilter } from "../permission/index.js";
import type { ProjectFilter, ProjectSort } from "./project.query.js";

export type ProjectRow = typeof projects.$inferSelect;

/** 列表 / 详情视图行：项目字段 + managerNames（A2：随行下发，与 managerIds 同下标；停用 / 离职仍返回姓名，取不到为 null）。 */
export interface ProjectViewRow {
  project: ProjectRow;
  managerNames: (string | null)[] | null;
}

export interface ProjectInsertInput {
  /** 显式主键（导入表导入：图片对象键要含 projectId，须在事务前定下项目 id）；缺省 = 库内 defaultRandom()。 */
  id?: string;
  code: string;
  name: string;
  customer: string | null;
  region: string;
  projectType: string;
  managerIds: string[];
  stageKey: string;
  description: string | null;
}

export interface ProjectUpdateInput {
  code?: string;
  name?: string;
  customer?: string | null;
  region?: string;
  projectType?: string;
  managerIds?: string[];
  stageKey?: string;
  status?: string;
  description?: string | null;
}

export interface ProjectFacetsResult {
  total: number;
  region: Record<string, number>;
  projectType: Record<string, number>;
  managerId: Record<string, number>;
  stageKey: Record<string, number>;
  status: Record<string, number>;
}

/** 项目硬删结果：删除前快照（行）+ 连带清掉的子表行数（审计 metadata 留痕，A5 / C7-02）。 */
export interface ProjectHardDeleteResult {
  project: ProjectRow;
  children: ProjectChildrenCounts;
}

/** 项目聚合子表行数（项目硬删时连同清掉；键名 = 子表语义名，进审计 metadata）。 */
export interface ProjectChildrenCounts {
  tasks: number;
  nodes: number;
  stages: number;
  members: number;
  stakeholders: number;
  reports: number;
  issues: number;
  changeRequests: number;
  files: number;
}

/**
 * 项目经理姓名数组（A2 / A22 · Push 136）：与 manager_ids 同下标一一对应；
 * 展开数组按 ordinality left join users（缺失 / 停用用户该位为 null），顺序 = manager_ids 顺序。
 */
const MANAGER_NAMES_SQL = sql<(string | null)[] | null>`(
  select array_agg(u.display_name order by m.ord)
  from unnest(${projects.managerIds}) with ordinality as m(uid, ord)
  left join ${users} u on u.id = m.uid
)`;

const SORT_COLUMNS = {
  updatedAt: projects.updatedAt,
  createdAt: projects.createdAt,
  seqNo: projects.seqNo,
} as const;

/** project 数据访问（M2-01 / M2-04）：项目回收站（软删 / 恢复 / 彻底删除）、历史软删行过滤与 updated_at 触点（ADR-022）都收敛在本层。 */
@Injectable()
export class ProjectRepository {
  constructor(private readonly database: DatabaseService) {}

  async listPage(
    filter: ProjectFilter,
    sorts: readonly ProjectSort[],
    limit: number,
    offset: number,
    scope: ProjectScopeFilter,
  ): Promise<{ items: ProjectViewRow[]; total: number }> {
    if (scope.kind === "ids" && scope.ids.length === 0) {
      return { items: [], total: 0 };
    }
    const where = and(...projectConditions(filter, scope));
    const items = await this.database.db
      .select({ project: projects, managerNames: MANAGER_NAMES_SQL })
      .from(projects)
      .where(where)
      .orderBy(...projectOrderBy(sorts))
      .limit(limit)
      .offset(offset);
    const totals = await this.database.db.select({ value: count() }).from(projects).where(where);
    return { items, total: Number(totals[0]?.value ?? 0) };
  }

  async facets(filter: ProjectFilter, scope: ProjectScopeFilter): Promise<ProjectFacetsResult> {
    if (scope.kind === "ids" && scope.ids.length === 0) {
      return { total: 0, region: {}, projectType: {}, managerId: {}, stageKey: {}, status: {} };
    }
    const where = and(...projectConditions(filter, scope)) as SQL;
    const rows = await this.database.db
      .select({
        region: projects.region,
        projectType: projects.projectType,
        stageKey: projects.stageKey,
        status: projects.status,
        value: count(),
      })
      .from(projects)
      .where(where)
      .groupBy(projects.region, projects.projectType, projects.stageKey, projects.status);
    const facets: ProjectFacetsResult = { total: 0, region: {}, projectType: {}, managerId: {}, stageKey: {}, status: {} };
    for (const row of rows) {
      const value = Number(row.value);
      facets.total += value;
      bump(facets.region, row.region, value);
      bump(facets.projectType, row.projectType, value);
      bump(facets.stageKey, row.stageKey, value);
      bump(facets.status, row.status, value);
    }
    // 项目经理维度（A22 · Push 136）：数组展开后按人头聚合 —— 一个项目挂多位经理时每位各计一次。
    const managerRows = await this.database.db.execute<{ managerId: string; value: number }>(sql`
      select m.uid as "managerId", count(*)::int as value
      from projects
      cross join lateral unnest(${projects.managerIds}) as m(uid)
      where ${where}
      group by m.uid
    `);
    for (const row of managerRows.rows) {
      bump(facets.managerId, row.managerId, Number(row.value));
    }
    return facets;
  }

  async findViewById(id: string): Promise<ProjectViewRow | null> {
    const rows = await this.database.db
      .select({ project: projects, managerNames: MANAGER_NAMES_SQL })
      .from(projects)
      .where(and(eq(projects.id, id), isNull(projects.deletedAt)))
      .limit(1);
    return rows[0] ?? null;
  }

  async insert(input: ProjectInsertInput, at: Date, client: DbClient = this.database.db): Promise<ProjectRow> {
    try {
      const rows = await client
        .insert(projects)
        .values({
          ...(input.id === undefined ? {} : { id: input.id }),
          code: input.code,
          name: input.name,
          customer: input.customer,
          region: input.region,
          projectType: input.projectType,
          managerIds: input.managerIds,
          stageKey: input.stageKey,
          status: "active",
          description: input.description,
          createdAt: at,
          updatedAt: at,
        })
        .returning();
      const row = rows[0];
      if (row === undefined) {
        throw new Error("projects insert 未返回记录");
      }
      return row;
    } catch (error) {
      if (isUniqueViolation(error, "projects_code_key")) {
        throw new AppError("PROJECT_CODE_EXISTS", "项目编号已存在（含项目回收站中的项目）：" + input.code);
      }
      throw error;
    }
  }

  async updateWithVersion(
    id: string,
    patch: ProjectUpdateInput,
    expectedVersion: number,
    at: Date,
    client: DbClient = this.database.db,
  ): Promise<ProjectRow | null> {
    const set: Record<string, unknown> = { ...patch, version: sql`${projects.version} + 1`, updatedAt: at };
    try {
      const rows = await client
        .update(projects)
        .set(set)
        .where(and(eq(projects.id, id), eq(projects.version, expectedVersion), isNull(projects.deletedAt)))
        .returning();
      return rows[0] ?? null;
    } catch (error) {
      if (isUniqueViolation(error, "projects_code_key")) {
        throw new AppError("PROJECT_CODE_EXISTS", "项目编号已存在");
      }
      throw error;
    }
  }

  /** 事务内读项目行（归档写保护判定；不做软删过滤的调用方自行判断）。 */
  async findRowById(id: string, client: DbClient = this.database.db): Promise<ProjectRow | null> {
    const rows = await client.select().from(projects).where(eq(projects.id, id)).limit(1);
    return rows[0] ?? null;
  }

  /** 事务内锁项目行：恢复 / 彻底删除 / 回收并发判定共用，防「刚恢复又被清理」竞态。 */
  async lockRowById(id: string, client: DbClient = this.database.db): Promise<ProjectRow | null> {
    const rows = await client.select().from(projects).where(eq(projects.id, id)).limit(1).for("update");
    return rows[0] ?? null;
  }

  /** DELETE /projects/{id}：乐观锁下写 deleted_at / deleted_by，version + 1；不动物理数据。 */
  async recycleWithVersion(
    id: string,
    expectedVersion: number,
    at: Date,
    actorId: string,
    client: DbClient = this.database.db,
  ): Promise<ProjectRow | null> {
    const rows = await client
      .update(projects)
      .set({ deletedAt: at, deletedBy: actorId, version: sql`${projects.version} + 1`, updatedAt: at })
      .where(and(eq(projects.id, id), eq(projects.version, expectedVersion), isNull(projects.deletedAt)))
      .returning();
    return rows[0] ?? null;
  }

  /** POST /projects/{id}/restore：清 deleted_at / deleted_by，version + 1；仅回收站行可恢复。 */
  async restoreWithVersion(
    id: string,
    expectedVersion: number,
    at: Date,
    client: DbClient = this.database.db,
  ): Promise<ProjectRow | null> {
    const rows = await client
      .update(projects)
      .set({ deletedAt: null, deletedBy: null, version: sql`${projects.version} + 1`, updatedAt: at })
      .where(and(eq(projects.id, id), eq(projects.version, expectedVersion), isNotNull(projects.deletedAt)))
      .returning();
    return rows[0] ?? null;
  }

  /** 阶段推进 / 回退：projects.stage_key 前移 / 回移 + 同事务刷新 updated_at（ADR-022 / ADR-023）。 */
  async setStageKey(id: string, stageKey: string, at: Date, client: DbClient = this.database.db): Promise<void> {
    await client
      .update(projects)
      .set({ stageKey, updatedAt: at })
      .where(and(eq(projects.id, id), isNull(projects.deletedAt)));
  }

  /**
   * 彻底删除（仅项目回收站中的行）：同事务按外键依赖序清空项目聚合子表 → 删 projects 行；编号随行一起释放。
   * 调用方须先锁行并校验 version；对象存储的 `projects/{id}/` 前缀由 ProjectService 在同事务内清理。
   * 子表顺序（全部 NO ACTION 外键，顺序错会撞 FK）：
   *   issue_events → task_events → 置空 files.current_version_id（files ⇄ file_versions 循环外键，删版本行前必须解环）
   *   → file_versions → files → change_requests → issues → daily_reports
   *   → tasks → node_requirements → project_nodes → project_stages → project_archives → project_members → project_stakeholders
   *   → follows（M2-06 · 0037：多态 object_id 无外键，项目与其任务两族按关系键一并清掉）。
   * version 守卫落在最后一行 delete：不匹配返回 null（调用方抛 409，整事务回滚，子表一行不动）。
   */
  async hardDeleteWithVersion(
    id: string,
    expectedVersion: number,
    client: DbClient = this.database.db,
  ): Promise<ProjectHardDeleteResult | null> {
    const children = await this.countChildren(id, client);
    const issueIds = client.select({ id: issues.id }).from(issues).where(eq(issues.projectId, id));
    const taskIds = client.select({ id: tasks.id }).from(tasks).where(eq(tasks.projectId, id));
    const fileIds = client.select({ id: files.id }).from(files).where(eq(files.projectId, id));
    const nodeIds = client.select({ id: projectNodes.id }).from(projectNodes).where(eq(projectNodes.projectId, id));
    await client.delete(issueEvents).where(inArray(issueEvents.issueId, issueIds));
    await client.delete(taskEvents).where(inArray(taskEvents.taskId, taskIds));
    // 关注行清理（M2-06 · 0037 · A1-15）：项目关注 + 该项目下任务关注
    await client.delete(follows).where(and(eq(follows.objectType, "project"), eq(follows.objectId, id)));
    await client.delete(follows).where(and(eq(follows.objectType, "task"), inArray(follows.objectId, taskIds)));
    // files.current_version_id → file_versions.id 为 NO ACTION 外键：删版本行前先置空该列，否则撞 23503（fk_files_current_version）。
    await client.update(files).set({ currentVersionId: null }).where(eq(files.projectId, id));
    await client.delete(fileVersions).where(inArray(fileVersions.fileId, fileIds));
    await client.delete(files).where(eq(files.projectId, id));
    await client.delete(changeRequests).where(eq(changeRequests.projectId, id));
    await client.delete(issues).where(eq(issues.projectId, id));
    await client.delete(dailyReports).where(eq(dailyReports.projectId, id));
    await client.delete(tasks).where(eq(tasks.projectId, id));
    await client.delete(nodeRequirements).where(inArray(nodeRequirements.nodeId, nodeIds));
    await client.delete(projectNodes).where(eq(projectNodes.projectId, id));
    await client.delete(projectStages).where(eq(projectStages.projectId, id));
    await client.delete(projectArchives).where(eq(projectArchives.projectId, id));
    await client.delete(projectMembers).where(eq(projectMembers.projectId, id));
    await client.delete(projectStakeholders).where(eq(projectStakeholders.projectId, id));
    const rows = await client
      .delete(projects)
      .where(and(eq(projects.id, id), eq(projects.version, expectedVersion), isNotNull(projects.deletedAt)))
      .returning();
    const project = rows[0];
    if (project === undefined) {
      return null;
    }
    return { project, children };
  }

  /** 聚合子表行数（一次查询出 9 个计数；项目行不存在时全 0）。 */
  private async countChildren(id: string, client: DbClient): Promise<ProjectChildrenCounts> {
    const empty: ProjectChildrenCounts = { tasks: 0, nodes: 0, stages: 0, members: 0, stakeholders: 0, reports: 0, issues: 0, changeRequests: 0, files: 0 };
    const rows = await client
      .select({
        tasks: sql<number>`(select count(*)::int from ${tasks} where ${tasks.projectId} = ${id})`,
        nodes: sql<number>`(select count(*)::int from ${projectNodes} where ${projectNodes.projectId} = ${id})`,
        stages: sql<number>`(select count(*)::int from ${projectStages} where ${projectStages.projectId} = ${id})`,
        members: sql<number>`(select count(*)::int from ${projectMembers} where ${projectMembers.projectId} = ${id})`,
        stakeholders: sql<number>`(select count(*)::int from ${projectStakeholders} where ${projectStakeholders.projectId} = ${id})`,
        reports: sql<number>`(select count(*)::int from ${dailyReports} where ${dailyReports.projectId} = ${id})`,
        issues: sql<number>`(select count(*)::int from ${issues} where ${issues.projectId} = ${id})`,
        changeRequests: sql<number>`(select count(*)::int from ${changeRequests} where ${changeRequests.projectId} = ${id})`,
        files: sql<number>`(select count(*)::int from ${files} where ${files.projectId} = ${id})`,
      })
      .from(projects)
      .where(eq(projects.id, id))
      .limit(1);
    return rows[0] ?? empty;
  }

  /**
   * ADR-022 触点（ProjectToucher 语义，仓储层单点）：任务 / 成员 / 阶段等「项目聚合视图」变更调用；
   * 主数据变更由 updateWithVersion 一并刷新；文件 / 日报 / 系统调度不调用。
   */
  async touch(id: string, at: Date, client: DbClient = this.database.db): Promise<void> {
    await client
      .update(projects)
      .set({ updatedAt: at })
      .where(and(eq(projects.id, id), isNull(projects.deletedAt)));
  }
}

/** 列表 / facets 共用的 WHERE 条件（同一 filter 构造器，禁止两套 SQL）。scope 为记录级可见集（h6）。 */
function projectConditions(filter: ProjectFilter, scope: ProjectScopeFilter): SQL[] {
  const conditions: SQL[] = [filter.recycled ? isNotNull(projects.deletedAt) : isNull(projects.deletedAt)];
  if (scope.kind === "ids") conditions.push(inArray(projects.id, scope.ids));
  if (filter.regions !== null) conditions.push(inArray(projects.region, filter.regions));
  if (filter.projectTypes !== null) conditions.push(inArray(projects.projectType, filter.projectTypes));
  if (filter.managerIds !== null) {
    // sql.param：数组必须作为单个参数下发（直接内插会被展开成 ($1) 的文本参数，PG 报 malformed array literal）
    conditions.push(sql`${projects.managerIds} && ${sql.param(filter.managerIds)}::uuid[]`);
  }
  if (filter.stageKeys !== null) conditions.push(inArray(projects.stageKey, filter.stageKeys));
  if (filter.statuses !== null) conditions.push(inArray(projects.status, filter.statuses));
  if (filter.keyword !== null) {
    const pattern = "%" + escapeLikePattern(filter.keyword) + "%";
    const keywordCondition = or(
      ilike(projects.code, pattern),
      ilike(projects.name, pattern),
      ilike(projects.customer, pattern),
      sql`${projects.seqNo}::text like ${pattern}`,
    );
    if (keywordCondition !== undefined) conditions.push(keywordCondition);
  }
  // 「项目时间」区间 = **项目创建时间**（Push 175 业务定调；原 updated_at 口径作废）
  if (filter.createdFrom !== null) conditions.push(gte(projects.createdAt, filter.createdFrom));
  if (filter.createdToExclusive !== null) conditions.push(lt(projects.createdAt, filter.createdToExclusive));
  // 归档年份（C4-07）：按 archived_at 的 Asia/Shanghai 年判定；未归档（archived_at 为空）不命中任何年份。 时区字面量走 sql.raw（drizzle 模板会把普通插值当绑定参数，直接内插会变成 $n）。
  if (filter.archivedYears !== null) {
    conditions.push(sql`extract(year from ${projects.archivedAt} at time zone ${sql.raw("'Asia/Shanghai'")}) = any(${sql.param(filter.archivedYears)}::int[])`);
  }
  return conditions;
}

/** 排序映射 + 稳定 tie-breaker（seqNo 全库唯一，保证分页不跳行）。 */
function projectOrderBy(sorts: readonly ProjectSort[]): SQL[] {
  const clauses: SQL[] = sorts.map((sort) =>
    sort.direction === "desc" ? desc(SORT_COLUMNS[sort.field]) : asc(SORT_COLUMNS[sort.field]),
  );
  if (!sorts.some((sort) => sort.field === "seqNo")) {
    clauses.push(asc(projects.seqNo));
  }
  return clauses;
}

/** LIKE 通配符转义（PG 默认转义符为反斜杠）；避开字面反斜杠，用字符码构造。 */
function escapeLikePattern(value: string): string {
  const backslash = String.fromCharCode(92);
  return value.split(backslash).join(backslash + backslash).split("%").join(backslash + "%").split("_").join(backslash + "_");
}

function bump(target: Record<string, number>, key: string, value: number): void {
  target[key] = (target[key] ?? 0) + value;
}

/**
 * pg 唯一约束违例判定：drizzle 0.45 把驱动错误包成 DrizzleQueryError（原始错误挂在 cause 链上），
 * 因此逐层解包后再看 code / constraint（projects_code_key → 409 PROJECT_CODE_EXISTS）。
 */
export function isUniqueViolation(error: unknown, constraint: string): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5; depth += 1) {
    if (typeof current !== "object" || current === null) return false;
    const candidate = current as { code?: unknown; constraint?: unknown; cause?: unknown };
    if (candidate.code === "23505" && candidate.constraint === constraint) return true;
    current = candidate.cause;
  }
  return false;
}
