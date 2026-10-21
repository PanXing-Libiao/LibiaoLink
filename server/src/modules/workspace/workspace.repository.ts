import { Injectable } from "@nestjs/common";
import { and, asc, desc, eq, inArray, isNull, ne, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { DatabaseService } from "../../db/database.service.js";
import type { DbClient } from "../../db/db-client.js";
import { changeRequests } from "../../db/schema/change.js";
import { files } from "../../db/schema/files.js";
import { users } from "../../db/schema/identity.js";
import { projects } from "../../db/schema/projects.js";
import { issues } from "../../db/schema/reports.js";
import { tasks } from "../../db/schema/tasks.js";
import type { ProjectScopeFilter } from "../permission/index.js";
import { loadIssuePhotos, type FilePhotoRefRow } from "../report-issue/index.js";
import type { TaskChangeLinkRow, TaskFileBriefRow, TaskFileSummaryCounts } from "../task/index.js";

/**
 * 工作台任务行（跨项目：任务表全字段 + 负责人姓名聚合 / 变更关联 / 文件摘要与文件清单 + 项目编号 / 名称）。
 * 2026-10-13 全字段修订（Push 302）：原 9 列抽取面补全为任务表 15 列数据源（行内编辑用 version 一并随行）。
 */
export interface WorkspaceTaskRow {
  id: string;
  projectId: string;
  projectCode: string;
  projectName: string;
  stageKey: string | null;
  sortIndex: number;
  nodeId: string | null;
  /** 来源任务节点库节点（tasks.task_node_id → 契约 sourceNodeId；2026-10-13 全字段修订补）。 */
  sourceNodeId: string | null;
  title: string;
  titleEn: string | null;
  status: string;
  statusOverride: string | null;
  progress: string;
  plannedStart: string | null;
  plannedEnd: string | null;
  actualEnd: string | null;
  estimatedDays: number | null;
  headcount: number | null;
  priority: string | null;
  deliverableTypes: string[];
  note: string | null;
  onTime: boolean | null;
  finalizedAt: Date | null;
  finalizedBy: string | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
  ownerIds: string[];
  ownerNames: (string | null)[] | null;
  /** 变更关联（A1-07 / R01 多条；口径与 task 模块 CHANGE_LINKS_SQL 同源，本模块为只读副本）。 */
  changeLinks: TaskChangeLinkRow[];
  /** 随行文件摘要（口径与 task 模块 fileSummaries 同源：排除回收站；final 计 final + changed）。 */
  fileSummary: TaskFileSummaryCounts;
  /** 随行文件清单（排除回收站、创建时间倒序；工作台行内「文件」列下拉数据源）。 */
  files: TaskFileBriefRow[];
}

/** 工作台项目行（聚合涉及项目的项目卡 + 项目经理姓名；契约 = ProjectSchema + managerNames）。 */
export interface WorkspaceProjectRow {
  id: string;
  code: string;
  seqNo: number;
  name: string;
  customer: string | null;
  region: string;
  projectType: string;
  managerIds: string[];
  managerNames: (string | null)[] | null;
  stageKey: string;
  status: string;
  description: string | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
  archivedAt: Date | null;
  archivedBy: string | null;
}

/** 工作台问题行（跨项目：问题列 + 提出人 / 责任人姓名 + 项目编号 / 名称 + 解决方案与附图）。 */
export interface WorkspaceIssueRow {
  id: string;
  projectId: string;
  projectCode: string;
  projectName: string;
  taskId: string | null;
  title: string;
  categories: string[];
  state: string;
  reporterId: string;
  reporterName: string | null;
  ownerDepartment: string | null;
  ownerId: string | null;
  ownerName: string | null;
  raisedAt: string;
  /** 解决方案或建议（A3-13；2026-10-13 全字段修订随行）。 */
  solution: string | null;
  /** 问题附图（file_links(object_type=issue)，插入序；2026-10-13 全字段修订随行）。 */
  photos: FilePhotoRefRow[];
  updatedAt: Date;
  version: number;
}

/** 负责人姓名数组（口径与 task 模块 OWNER_NAMES_SQL 同源，本模块为只读副本）。 */
/**
 * 负责人姓名数组（A23 · Push 136）：与 owner_ids 同下标一一对应；
 * 展开数组按 ordinality left join users（缺失 / 停用用户该位为 null），顺序 = owner_ids 顺序。
 */
const OWNER_NAMES_SQL = sql<(string | null)[] | null>`(
  select array_agg(u.display_name order by o.ord)
  from unnest(${tasks.ownerIds}) with ordinality as o(uid, ord)
  left join ${users} u on u.id = o.uid
)`;

/** 变更关联（口径与 task 模块 CHANGE_LINKS_SQL 同源，本模块为只读副本）。 */
/**
 * 变更关联（A1-07 / R01 多条 · 迁移 0020 `tasks.change_refs` uuid[]）：一次聚合出任务的全部关联变更，
 * 列 = id / 原因 / 生效时间；排序按 `array_position`（= 追加序，末位 = 最近一次变更）；空数组 → `[]`。
 * 时间在 SQL 侧按 ISO8601 UTC 格式化（`to_char` 带 Z 后缀），与 JS `toISOString()` 同形。
 */
const CHANGE_LINKS_SQL = sql<TaskChangeLinkRow[] | null>`(
  select coalesce(
    json_agg(
      json_build_object(
        'id', c.id,
        'reason', c.reason,
        'appliedAt', to_char(c.applied_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      )
      order by array_position(${tasks.changeRefs}, c.id)
    ),
    '[]'::json
  )
  from ${changeRequests} c
  where c.id = any(${tasks.changeRefs})
)`;

/** 项目经理姓名数组（口径与 project 模块 MANAGER_NAMES_SQL 同源，本模块为只读副本）。 */
/**
 * 项目经理姓名数组（A2 / A22 · Push 136）：与 manager_ids 同下标一一对应；
 * 展开数组按 ordinality left join users（缺失 / 停用用户该位为 null），顺序 = manager_ids 顺序。
 */
const MANAGER_NAMES_SQL = sql<(string | null)[] | null>`(
  select array_agg(u.display_name order by m.ord)
  from unnest(${projects.managerIds}) with ordinality as m(uid, ord)
  left join ${users} u on u.id = m.uid
)`;

/** 文件摘要口径（与 task 模块 FILE_STATUS_FOR_SUMMARY 同源）：排除回收站（recycled）。 */
const FILE_STATUS_FOR_SUMMARY = ["draft", "final", "changed", "archived"];

const ISSUE_OWNER = alias(users, "workspace_issue_owner");

/**
 * 工作台数据访问（M6-05 第一刀 · 只读）：跨项目聚合查询 —— 「我的任务」「我的问题」与涉及项目卡。
 * 本模块不改任何表；读面统一过滤：软删项目 / 归档项目（ADR-027 冻结，不再催办）不进工作台。
 * 记录级可见性由调用方以 ProjectScopeFilter 传入（permission.projectScope 出口；空集短路不查库）。
 */
@Injectable()
export class WorkspaceRepository {
  constructor(private readonly database: DatabaseService) {}

  /**
   * 我的任务：负责人含我 或 项目经理含我（均多值任一位命中 · 2026-09-30 复评）、未完成、未删除；不设时间窗口。
   * 组内排序 plannedEnd 升序（未排期空值置末 —— PG ASC 默认 NULLS LAST）→ id 升序。
   * 2026-10-13 全字段修订：任务表 15 列 + 变更关联 + 文件摘要与文件清单一次带全（免 N+1）。
   */
  async listMyTasks(actorId: string, scope: ProjectScopeFilter, client: DbClient = this.database.db): Promise<WorkspaceTaskRow[]> {
    if (scope.kind === "ids" && scope.ids.length === 0) return [];
    const conditions: SQL[] = [
      isNull(tasks.deletedAt),
      ne(tasks.status, "done"),
      sql`(${tasks.ownerIds} @> array[${actorId}]::uuid[] or ${projects.managerIds} @> array[${actorId}]::uuid[])`,
      isNull(projects.deletedAt),
      ne(projects.status, "archived"),
    ];
    if (scope.kind === "ids") conditions.push(inArray(tasks.projectId, scope.ids));
    const rows = await client
      .select({
        id: tasks.id,
        projectId: tasks.projectId,
        projectCode: projects.code,
        projectName: projects.name,
        stageKey: tasks.stageKey,
        sortIndex: tasks.sortIndex,
        nodeId: tasks.nodeId,
        sourceNodeId: tasks.taskNodeId,
        title: tasks.title,
        titleEn: tasks.titleEn,
        status: tasks.status,
        statusOverride: tasks.statusOverride,
        progress: tasks.progress,
        plannedStart: tasks.plannedStart,
        plannedEnd: tasks.plannedEnd,
        actualEnd: tasks.actualEnd,
        estimatedDays: tasks.estimatedDays,
        headcount: tasks.headcount,
        priority: tasks.priority,
        deliverableTypes: tasks.deliverableTypes,
        note: tasks.note,
        onTime: tasks.onTime,
        finalizedAt: tasks.finalizedAt,
        finalizedBy: tasks.finalizedBy,
        version: tasks.version,
        createdAt: tasks.createdAt,
        updatedAt: tasks.updatedAt,
        ownerIds: tasks.ownerIds,
        ownerNames: OWNER_NAMES_SQL,
        changeLinks: CHANGE_LINKS_SQL,
      })
      .from(tasks)
      .innerJoin(projects, eq(projects.id, tasks.projectId))
      .where(and(...conditions))
      .orderBy(asc(tasks.plannedEnd), asc(tasks.id));
    const fileBriefs = await this.listTaskFileBriefs(rows.map((row) => row.id), client);
    return rows.map((row) => {
      const taskFiles = fileBriefs.get(row.id) ?? [];
      return {
        ...row,
        changeLinks: row.changeLinks ?? [],
        files: taskFiles,
        fileSummary: summarizeFiles(taskFiles),
      } as WorkspaceTaskRow;
    });
  }

  /**
   * 我的问题：我处理（ownerId）∪ 我提出的（reporterId）；未关闭在前 —— raisedAt（提出日期）升序 → id 升序（Push 215 删处理时限档）。
   * 2026-10-13 全字段修订：补 solution（解决方案或建议）与 photos（问题附图，file_links(object_type=issue) 插入序）。
   */
  async listMyIssues(
    actorId: string,
    scope: ProjectScopeFilter,
    client: DbClient = this.database.db,
  ): Promise<WorkspaceIssueRow[]> {
    if (scope.kind === "ids" && scope.ids.length === 0) return [];
    const conditions: SQL[] = [
      sql`(${issues.ownerId} = ${actorId} or ${issues.reporterId} = ${actorId})`,
      isNull(projects.deletedAt),
      ne(projects.status, "archived"),
    ];
    if (scope.kind === "ids") conditions.push(inArray(issues.projectId, scope.ids));
    const rows = await client
      .select({
        id: issues.id,
        projectId: issues.projectId,
        projectCode: projects.code,
        projectName: projects.name,
        taskId: issues.taskId,
        title: issues.title,
        categories: issues.categories,
        state: issues.state,
        reporterId: issues.reporterId,
        reporterName: users.displayName,
        ownerDepartment: issues.ownerDepartment,
        ownerId: issues.ownerId,
        ownerName: ISSUE_OWNER.displayName,
        raisedAt: issues.raisedAt,
        solution: issues.solution,
        updatedAt: issues.updatedAt,
        version: issues.version,
      })
      .from(issues)
      .innerJoin(projects, eq(projects.id, issues.projectId))
      .leftJoin(users, eq(users.id, issues.reporterId))
      .leftJoin(ISSUE_OWNER, eq(ISSUE_OWNER.id, issues.ownerId))
      .where(and(...conditions))
      .orderBy(
        sql`case when ${issues.state} = ${"done"} then 1 else 0 end`,
        asc(issues.raisedAt),
        asc(issues.id),
      );
    const photoMap = await loadIssuePhotos(rows.map((row) => row.id), client);
    return rows.map((row) => ({ ...row, photos: photoMap.get(row.id) ?? [] })) as WorkspaceIssueRow[];
  }

  /** 聚合涉及的项目卡（我的任务 / 我的问题命中的项目；软删项目剔除，顺序由服务层按首次出现重排）。 */
  async listProjects(projectIds: readonly string[], client: DbClient = this.database.db): Promise<WorkspaceProjectRow[]> {
    if (projectIds.length === 0) return [];
    const rows = await client
      .select({
        id: projects.id,
        code: projects.code,
        seqNo: projects.seqNo,
        name: projects.name,
        customer: projects.customer,
        region: projects.region,
        projectType: projects.projectType,
        managerIds: projects.managerIds,
        managerNames: MANAGER_NAMES_SQL,
        stageKey: projects.stageKey,
        status: projects.status,
        description: projects.description,
        version: projects.version,
        createdAt: projects.createdAt,
        updatedAt: projects.updatedAt,
        archivedAt: projects.archivedAt,
        archivedBy: projects.archivedBy,
      })
      .from(projects)
      .where(and(inArray(projects.id, [...projectIds]), isNull(projects.deletedAt)));
    return rows as WorkspaceProjectRow[];
  }

  /** 随行文件清单（跨任务一次取）：排除回收站（口径与 task 模块 listFiles 同源）、创建时间倒序。 */
  private async listTaskFileBriefs(taskIds: readonly string[], client: DbClient): Promise<Map<string, TaskFileBriefRow[]>> {
    const result = new Map<string, TaskFileBriefRow[]>();
    if (taskIds.length === 0) return result;
    const rows = await client
      .select({ taskId: files.taskId, id: files.id, name: files.name, status: files.status, docType: files.docType })
      .from(files)
      .where(and(inArray(files.taskId, [...taskIds]), inArray(files.status, FILE_STATUS_FOR_SUMMARY)))
      .orderBy(desc(files.createdAt));
    for (const row of rows) {
      if (row.taskId === null) continue;
      const list = result.get(row.taskId) ?? [];
      list.push({ id: row.id, name: row.name, status: row.status, docType: row.docType });
      result.set(row.taskId, list);
    }
    return result;
  }
}

/** 文件摘要（口径与 task 模块 fileSummaries 同源：total = 清单数；draft = 未定档；final = final + changed）。 */
function summarizeFiles(briefs: readonly TaskFileBriefRow[]): TaskFileSummaryCounts {
  let draft = 0;
  let final = 0;
  for (const brief of briefs) {
    if (brief.status === "draft") draft += 1;
    if (brief.status === "final" || brief.status === "changed") final += 1;
  }
  return { total: briefs.length, draft, final };
}
