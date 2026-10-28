import { Injectable } from "@nestjs/common";
import { STAGE_KEYS } from "@libiaolink/contracts";
import { and, asc, count, desc, eq, gte, ilike, inArray, isNotNull, isNull, lte, or, sql, type SQL } from "drizzle-orm";
import { DatabaseService } from "../../db/database.service.js";
import type { DbClient } from "../../db/db-client.js";
import { changeRequests } from "../../db/schema/change.js";
import { files, uploadSessions } from "../../db/schema/files.js";
import { projectNodes } from "../../db/schema/flow.js";
import { users } from "../../db/schema/identity.js";
import { projectStages, projects } from "../../db/schema/projects.js";
import { issues } from "../../db/schema/reports.js";
import { taskEvents, tasks } from "../../db/schema/tasks.js";
import type { TaskListFilter, TaskSort } from "./task.query.js";

export type TaskRow = typeof tasks.$inferSelect;

/** 任务 ↔ 变更关联项（A1-07 / R01：一条任务可关联多条；读面按 change_refs 追加序下发）。 */
export interface TaskChangeLinkRow {
  id: string;
  reason: string | null;
  /** 变更生效时间（ISO8601 UTC，SQL 侧已格式化 —— 免二次解析）。 */
  appliedAt: string;
}

export interface TaskListRow {
  task: TaskRow;
  /** 负责人姓名数组（A23：与 owner_ids 同下标；「待分配」= 空数组；缺失用户该位为 null）。 */
  ownerNames: (string | null)[] | null;
  /** 变更关联（A1-07 / R01 多条）：按 tasks.change_refs 追加序（末位 = 最近一次变更），空数组 = 无变更。 */
  changeLinks: TaskChangeLinkRow[];
}

export interface TaskFileSummaryCounts {
  total: number;
  draft: number;
  final: number;
}

export interface TaskFileBriefRow {
  id: string;
  name: string;
  status: string;
  docType: string | null;
}

export interface TaskProjectRow {
  id: string;
  managerIds: string[];
  stageKey: string;
  status: string;
}

export interface TaskProjectNodeRow {
  id: string;
  stageKey: string;
  status: string;
}

export interface TaskInsertInput {
  projectId: string;
  /** null = 「未分组」（A15 · Push 124）。 */
  stageKey: string | null;
  nodeId: string | null;
  /** 来源任务节点库节点（迁移 0034 · M3-07 刀 3）：手工创建 / 流程节点任务为 null。 */
  sourceNodeId: string | null;
  title: string;
  titleEn: string | null;
  /** 空数组 = 「待分配」（A18 · Push 124 / A23 · Push 136）。 */
  ownerIds: string[];
  /** 组内位次（A19 / A20：插入位置由 service 计算，本层落列）。 */
  sortIndex: number;
  plannedStart: string | null;
  plannedEnd: string | null;
  estimatedDays: number | null;
  headcount: number | null;
  priority: string | null;
  /** 要求输出成果文件（ADR-024 多选）：空数组 = 不要求。 */
  deliverableTypes: string[];
  note: string | null;
}

export interface TaskUpdatePatch {
  /**
   * 任务描述 / 英文名：节点 / 模板生成的任务 = 锁定字段（A1-17，仅「例外调整」管理员路径写入 · M3-05 · Push 153）；
   * 无来源节点的临时任务（看板「添加 → 临时任务」手工创建）自 Push 196 起可走普通编辑改。
   */
  title?: string;
  titleEn?: string | null;
  deliverableTypes?: string[];
  ownerIds?: string[];
  status?: string;
  /** 显式覆盖（2026-09-24 · 迁移 0031）：overdue / early_done / null（清空）。 */
  statusOverride?: string | null;
  progress?: string;
  sortIndex?: number;
  plannedStart?: string | null;
  plannedEnd?: string | null;
  actualEnd?: string | null;
  estimatedDays?: number | null;
  headcount?: number | null;
  priority?: string | null;
  note?: string | null;
  /** 任务定档（Push 252 · 抽屉「定档」开关入口）：与 finalizedAt 成对写入；已定档任务任何写口 409 TASK_FINALIZED。
   *  Push 260（取消定档）：原值可回写 null（unfinalize 清位、任务重新开放修改 —— 文件级定档不回退，文件修改仍走变更）。 */
  finalizedAt?: Date | null;
  finalizedBy?: string | null;
}

/** 完成门禁目标（M3-03）：任务行上判定门禁需要的字段（含无节点任务的 deliverable_types 兜底）。 */
export interface TaskCompletionTargetRow {
  id: string;
  projectId: string;
  nodeId: string | null;
  status: string;
  deliverableTypes: string[];
}

export interface TaskOrderRow {
  id: string;
  sortIndex: number;
}

/** 任务精简读（无锁）：重排前取所属阶段 —— 组行锁（listGroupOrder lock=true）要早于任务行锁。 */
export interface TaskOrderBrief {
  id: string;
  projectId: string;
  stageKey: string | null;
  sortIndex: number;
}

export interface TaskEventInput {
  taskId: string;
  eventType: string;
  beforeValue: string | null;
  afterValue: string | null;
}

/**
 * 负责人姓名数组（A23 · Push 136）：与 owner_ids 同下标一一对应；
 * 展开数组按 ordinality left join users（缺失 / 停用用户该位为 null），顺序 = owner_ids 顺序。
 */
const OWNER_NAMES_SQL = sql<(string | null)[] | null>`(
  select array_agg(u.display_name order by o.ord)
  from unnest(${tasks.ownerIds}) with ordinality as o(uid, ord)
  left join ${users} u on u.id = o.uid
)`;

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

const SORT_COLUMNS = {
  plannedStart: tasks.plannedStart,
  plannedEnd: tasks.plannedEnd,
  actualEnd: tasks.actualEnd,
  progress: tasks.progress,
  title: tasks.title,
  createdAt: tasks.createdAt,
} as const;

/** 默认排序（A19 / A20 · Push 124）：阶段序（STAGE_KEYS 契约顺序，「未分组」落在最后）→ 组内位次 sort_index → id（稳定分页）。 */
const STAGE_ORDER = sql`case ${tasks.stageKey} ${sql.join(
  STAGE_KEYS.map((key, index) => sql`when ${key} then ${index}`),
  sql` `,
)} else ${STAGE_KEYS.length} end`;

/** 文件摘要口径：排除回收站（recycled）；total = 任务下全部文件，draft = 未定档，final = 已定档（final + changed）。 */
const FILE_STATUS_FOR_SUMMARY = ["draft", "final", "changed", "archived"];

/**
 * task 数据访问（M3-01 / M3-02）：列表 / 详情 / 写入 / 事件留痕 / 项目触点（ADR-022）都在本层。
 * 展示态筛选按「覆盖 + 派生」定义下推 SQL（overdue / early_done 非存储态，可由覆盖生效或读时派生命中），与读时派生同一口径。
 * 项目触点单点在本层（tasks 属项目聚合视图）；ProjectToucher 统一收口随 h6 / 后续卡（避免模块循环依赖）。
 */
@Injectable()
export class TaskRepository {
  constructor(private readonly database: DatabaseService) {}

  async listPage(
    projectId: string,
    filter: TaskListFilter,
    sorts: readonly TaskSort[],
    limit: number,
    offset: number,
    today: string,
    client: DbClient = this.database.db,
  ): Promise<{ items: TaskListRow[]; total: number }> {
    const where = and(...taskConditions(projectId, filter, today));
    const rows = await client
      .select({ task: tasks, ownerNames: OWNER_NAMES_SQL, changeLinks: CHANGE_LINKS_SQL })
      .from(tasks)
      .where(where)
      .orderBy(...taskOrderBy(sorts))
      .limit(limit)
      .offset(offset);
    const totals = await client.select({ value: count() }).from(tasks).where(where);
    const items = rows.map((row) => ({ ...row, changeLinks: row.changeLinks ?? [] }));
    return { items, total: Number(totals[0]?.value ?? 0) };
  }

  async findListRowById(taskId: string, projectId: string, client: DbClient = this.database.db): Promise<TaskListRow | null> {
    const rows = await client
      .select({ task: tasks, ownerNames: OWNER_NAMES_SQL, changeLinks: CHANGE_LINKS_SQL })
      .from(tasks)
      .where(and(eq(tasks.id, taskId), eq(tasks.projectId, projectId), isNull(tasks.deletedAt)))
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : { ...row, changeLinks: row.changeLinks ?? [] };
  }

  /**
   * 写路径（创建 / 编辑 / 完成响应）用：按 `change_refs` 顺序（追加序）取变更记录的 id / 原因 / 生效时间；
   * 已失效的引用（理论上不出现 —— change_requests 只追加）跳过，不抛错。
   */
  async listChangeLinks(changeRefs: readonly string[], client: DbClient = this.database.db): Promise<TaskChangeLinkRow[]> {
    if (changeRefs.length === 0) return [];
    const rows = await client
      .select({ id: changeRequests.id, reason: changeRequests.reason, appliedAt: changeRequests.appliedAt })
      .from(changeRequests)
      .where(inArray(changeRequests.id, [...changeRefs]));
    const byId = new Map(rows.map((row) => [row.id, row]));
    const links: TaskChangeLinkRow[] = [];
    for (const id of changeRefs) {
      const row = byId.get(id);
      if (row === undefined) continue;
      links.push({ id: row.id, reason: row.reason, appliedAt: row.appliedAt.toISOString() });
    }
    return links;
  }

  /** 详情文件清单：排除回收站（recycled）与没有完成版本的空上传，按创建时间倒序。 */
  async listFiles(taskId: string, client: DbClient = this.database.db): Promise<TaskFileBriefRow[]> {
    return client
      .select({ id: files.id, name: files.name, status: files.status, docType: files.docType })
      .from(files)
      .where(and(eq(files.taskId, taskId), inArray(files.status, FILE_STATUS_FOR_SUMMARY), isNotNull(files.currentVersionId)))
      .orderBy(desc(files.createdAt));
  }

  /** 列表随行文件摘要（免 N+1）：一次按 taskId 分组统计。 */
  async fileSummaries(taskIds: readonly string[], client: DbClient = this.database.db): Promise<Map<string, TaskFileSummaryCounts>> {
    const result = new Map<string, TaskFileSummaryCounts>();
    if (taskIds.length === 0) return result;
    const rows = await client
      .select({ taskId: files.taskId, status: files.status, value: count() })
      .from(files)
      .where(and(inArray(files.taskId, [...taskIds]), inArray(files.status, FILE_STATUS_FOR_SUMMARY), isNotNull(files.currentVersionId)))
      .groupBy(files.taskId, files.status);
    for (const row of rows) {
      if (row.taskId === null) continue;
      const entry = result.get(row.taskId) ?? { total: 0, draft: 0, final: 0 };
      const value = Number(row.value);
      entry.total += value;
      if (row.status === "draft") entry.draft += value;
      if (row.status === "final" || row.status === "changed") entry.final += value;
      result.set(row.taskId, entry);
    }
    return result;
  }

  /** 项目读（软删过滤）：任务读写都要先过项目可见性 / 归档写保护。 */
  async findProject(projectId: string, client: DbClient = this.database.db): Promise<TaskProjectRow | null> {
    const rows = await client
      .select({ id: projects.id, managerIds: projects.managerIds, stageKey: projects.stageKey, status: projects.status })
      .from(projects)
      .where(and(eq(projects.id, projectId), isNull(projects.deletedAt)))
      .limit(1);
    return rows[0] ?? null;
  }

  /** 来源任务节点（校验属于本项目 + 取阶段）：taskCreateBody.taskNodeId 的落点。 */
  async findProjectNode(projectId: string, nodeId: string, client: DbClient = this.database.db): Promise<TaskProjectNodeRow | null> {
    const rows = await client
      .select({ id: projectNodes.id, stageKey: projectStages.stageKey, status: projectNodes.status })
      .from(projectNodes)
      .innerJoin(projectStages, eq(projectStages.id, projectNodes.stageId))
      .where(and(eq(projectNodes.projectId, projectId), eq(projectNodes.id, nodeId)))
      .limit(1);
    return rows[0] ?? null;
  }

  /** 节点判重（A10 / A11）：同一节点在项目里只留一份任务（node_id = 项目流程节点）。 */
  async findTaskIdByNode(projectId: string, nodeId: string, client: DbClient = this.database.db): Promise<string | null> {
    const rows = await client
      .select({ id: tasks.id })
      .from(tasks)
      .where(and(eq(tasks.projectId, projectId), eq(tasks.nodeId, nodeId), isNull(tasks.deletedAt)))
      .limit(1);
    return rows[0]?.id ?? null;
  }

  /**
   * 节点库来源判重（迁移 0034 · A1-16）：同一项目内同一节点库节点只留一份（未删行参与）。
   * 模板实例化按一批 node_id 一次查完（避免逐条查），返回 nodeId → 已存在任务 id。
   */
  async findTaskIdsBySourceNodes(
    projectId: string,
    sourceNodeIds: readonly string[],
    client: DbClient = this.database.db,
  ): Promise<Map<string, string>> {
    if (sourceNodeIds.length === 0) {
      return new Map();
    }
    const rows = await client
      .select({ id: tasks.id, taskNodeId: tasks.taskNodeId })
      .from(tasks)
      .where(
        and(
          eq(tasks.projectId, projectId),
          inArray(tasks.taskNodeId, [...sourceNodeIds]),
          isNull(tasks.deletedAt),
        ),
      );
    return new Map(rows.filter((row) => row.taskNodeId !== null).map((row) => [row.taskNodeId as string, row.id]));
  }

  /** 完成门禁目标读（无锁）：can-complete 预检与写入口的事务内判定共用字段。 */
  async findCompletionTarget(client: DbClient, taskId: string): Promise<TaskCompletionTargetRow | null> {
    const rows = await client
      .select({
        id: tasks.id,
        projectId: tasks.projectId,
        nodeId: tasks.nodeId,
        status: tasks.status,
        deliverableTypes: tasks.deliverableTypes,
      })
      .from(tasks)
      .where(and(eq(tasks.id, taskId), isNull(tasks.deletedAt)))
      .limit(1);
    return rows[0] ?? null;
  }

  /** 任务精简读（无锁；只取重排需要的字段）。 */
  async findTaskBrief(taskId: string, client: DbClient = this.database.db): Promise<TaskOrderBrief | null> {
    const rows = await client
      .select({ id: tasks.id, projectId: tasks.projectId, stageKey: tasks.stageKey, sortIndex: tasks.sortIndex })
      .from(tasks)
      .where(and(eq(tasks.id, taskId), isNull(tasks.deletedAt)))
      .limit(1);
    return rows[0] ?? null;
  }

  /** 组内任务数（插入位次夹取用）：同一项目 + 同一阶段（null = 未分组）。 */
  async countGroup(projectId: string, stageKey: string | null, client: DbClient = this.database.db): Promise<number> {
    const rows = await client
      .select({ value: count() })
      .from(tasks)
      .where(and(eq(tasks.projectId, projectId), groupCondition(stageKey), isNull(tasks.deletedAt)));
    return Number(rows[0]?.value ?? 0);
  }

  /**
   * 组内顺序（读）：同一项目 + 同一阶段的全部位次（按位次 + id 稳定排序）。
   * lock=true：同一语句内 for update 加行锁（重排事务先锁组、后锁任务行，避免并发移动互相等待）。
   */
  async listGroupOrder(
    projectId: string,
    stageKey: string | null,
    client: DbClient = this.database.db,
    lock = false,
  ): Promise<TaskOrderRow[]> {
    const base = client
      .select({ id: tasks.id, sortIndex: tasks.sortIndex })
      .from(tasks)
      .where(and(eq(tasks.projectId, projectId), groupCondition(stageKey), isNull(tasks.deletedAt)))
      .orderBy(asc(tasks.sortIndex), asc(tasks.id));
    return lock ? base.for("update") : base;
  }

  /** 组内位次平移（插入 / 移动用）：位次落在 [from, to]（to = null 无上界）的任务整体 +delta；只写位次，不动 updated_at / version。 */
  async shiftGroupIndexes(
    projectId: string,
    stageKey: string | null,
    from: number,
    to: number | null,
    delta: number,
    client: DbClient,
  ): Promise<void> {
    const conditions: SQL[] = [eq(tasks.projectId, projectId), groupCondition(stageKey), gte(tasks.sortIndex, from), isNull(tasks.deletedAt) as SQL];
    if (to !== null) conditions.push(lte(tasks.sortIndex, to));
    await client
      .update(tasks)
      .set({ sortIndex: sql`${tasks.sortIndex} + ${delta}` })
      .where(and(...conditions));
  }

  /** 问题引用（issues.task_id，b-tree 索引 ix_issues_task）。 */
  async countIssueRefs(taskId: string, client: DbClient = this.database.db): Promise<number> {
    const rows = await client
      .select({ value: sql<number>`count(*)::int` })
      .from(issues)
      .where(eq(issues.taskId, taskId));
    return Number(rows[0]?.value ?? 0);
  }

  /**
   * 软删（M3-05 · A25 · 迁移 0022）：置 deleted_at / deleted_by；不物理删行（历史与留痕保留）。
   * 并发安全：条件带 deleted_at is null —— 重复删除不会二次置位（返回 false，由 service 转统一 404）。
   */
  async softDelete(client: DbClient, taskId: string, actorId: string, at: Date): Promise<boolean> {
    const rows = await client
      .update(tasks)
      .set({ deletedAt: at, deletedBy: actorId })
      .where(and(eq(tasks.id, taskId), isNull(tasks.deletedAt)))
      .returning({ id: tasks.id });
    return rows.length > 0;
  }

  async lockTask(client: DbClient, taskId: string): Promise<TaskRow | null> {
    const rows = await client.select().from(tasks).where(and(eq(tasks.id, taskId), isNull(tasks.deletedAt))).for("update");
    return rows[0] ?? null;
  }

  async insert(input: TaskInsertInput, at: Date, client: DbClient): Promise<TaskRow> {
    const rows = await client
      .insert(tasks)
      .values({
        projectId: input.projectId,
        stageKey: input.stageKey,
        nodeId: input.nodeId,
        taskNodeId: input.sourceNodeId,
        title: input.title,
        titleEn: input.titleEn,
        ownerIds: input.ownerIds,
        sortIndex: input.sortIndex,
        status: "pending",
        progress: "0",
        plannedStart: input.plannedStart,
        plannedEnd: input.plannedEnd,
        estimatedDays: input.estimatedDays,
        headcount: input.headcount,
        priority: input.priority,
        deliverableTypes: input.deliverableTypes,
        note: input.note,
        createdAt: at,
        updatedAt: at,
      })
      .returning();
    const row = rows[0];
    if (row === undefined) throw new Error("tasks insert 未返回行");
    return row;
  }

  /** 乐观锁更新：version 不匹配返回 null（由 service 转 409）。 */
  async updateWithVersion(
    taskId: string,
    expectedVersion: number,
    patch: TaskUpdatePatch,
    at: Date,
    client: DbClient,
  ): Promise<TaskRow | null> {
    const rows = await client
      .update(tasks)
      .set({ ...patch, version: sql`${tasks.version} + 1`, updatedAt: at })
      .where(and(eq(tasks.id, taskId), eq(tasks.version, expectedVersion)))
      .returning();
    return rows[0] ?? null;
  }

  async insertEvents(client: DbClient, events: readonly TaskEventInput[], actorId: string, at: Date): Promise<void> {
    if (events.length === 0) return;
    await client.insert(taskEvents).values(
      events.map((event) => ({
        taskId: event.taskId,
        eventType: event.eventType,
        beforeValue: event.beforeValue,
        afterValue: event.afterValue,
        actorId,
        createdAt: at,
      })),
    );
  }

  /** 项目最近活动触点（ADR-022 ④：任务变更视为项目活动；系统调度类写入不调用本方法）。 */
  async touchProject(projectId: string, at: Date, client: DbClient): Promise<void> {
    await client.update(projects).set({ updatedAt: at }).where(eq(projects.id, projectId));
  }

  /**
   * 任务定档兜底（防绕过补漏）：撤销该任务名下文件「在途（active）」的 version 上传会话；
   * 只撤 version —— change 是 A4-13 唯一保留的修改通道，且 change 会话只针对已定档文件。
   * 返回撤销条数（进任务定档审计 metadata）；漏网会话由 completeUpload 的任务定档复核兜住。
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

  /** 项目总览汇总（GET /projects/{id}/summary）：三个计数 + 最慢 / 最新阶段（阶段判定在 service，按 STAGE_KEYS 序）。 */
  async summaryCounts(
    projectId: string,
    today: string,
    client: DbClient = this.database.db,
  ): Promise<{ overdue: number; done: number; total: number }> {
    const rows = await client
      .select({
        total: count(),
        done: sql<number>`count(*) filter (where ${tasks.status} = ${"done"})`,
        overdue: sql<number>`count(*) filter (where ${tasks.status} <> ${"done"} and ${tasks.plannedEnd} < ${today})`,
      })
      .from(tasks)
      .where(and(eq(tasks.projectId, projectId), isNull(tasks.deletedAt)));
    const row = rows[0];
    return { overdue: Number(row?.overdue ?? 0), done: Number(row?.done ?? 0), total: Number(row?.total ?? 0) };
  }

  /** 阶段任务计数（GateService 阶段门禁 / 完成度用；h4 起由 task 模块提供，node 不再直读 tasks 表）。 */
  async countStageTasks(client: DbClient, projectId: string, stageKey: string): Promise<{ total: number; done: number }> {
    const rows = await client
      .select({ status: tasks.status, value: count() })
      .from(tasks)
      .where(and(eq(tasks.projectId, projectId), eq(tasks.stageKey, stageKey), isNull(tasks.deletedAt)))
      .groupBy(tasks.status);
    let total = 0;
    let done = 0;
    for (const row of rows) {
      const value = Number(row.value);
      total += value;
      if (row.status === "done") done += value;
    }
    return { total, done };
  }

  /** 全项目按阶段的任务计数（GET /projects/{id}/stages 的 tasks 完成度）。 */
  async taskCountsByStage(
    client: DbClient,
    projectId: string,
  ): Promise<{ stageKey: string | null; status: string; value: number }[]> {
    const rows = await client
      .select({ stageKey: tasks.stageKey, status: tasks.status, value: count() })
      .from(tasks)
      .where(and(eq(tasks.projectId, projectId), isNull(tasks.deletedAt)))
      .groupBy(tasks.stageKey, tasks.status);
    return rows.map((row) => ({ stageKey: row.stageKey, status: row.status, value: Number(row.value) }));
  }
}

function taskConditions(projectId: string, filter: TaskListFilter, today: string): SQL[] {
  const conditions: SQL[] = [eq(tasks.projectId, projectId), isNull(tasks.deletedAt) as SQL];
  if (filter.stageKey !== null) conditions.push(eq(tasks.stageKey, filter.stageKey));
  if (filter.ownerId !== null) conditions.push(sql`${tasks.ownerIds} @> array[${filter.ownerId}]::uuid[]`);
  if (filter.keyword !== null) {
    const pattern = "%" + filter.keyword + "%";
    conditions.push(or(ilike(tasks.title, pattern), ilike(tasks.titleEn, pattern)) as SQL);
  }
  if (filter.displayStatuses !== null) {
    const parts = filter.displayStatuses.map((status) => displayStatusCondition(status, today));
    conditions.push(or(...parts) as SQL);
  }
  return conditions;
}

/** 组条件：stage_key 为 null 时用 is null（SQL 的 = null 恒不成立）——「未分组」自成一组（A15 · Push 124）。 */
function groupCondition(stageKey: string | null): SQL {
  return stageKey === null ? (isNull(tasks.stageKey) as SQL) : (eq(tasks.stageKey, stageKey) as SQL);
}

/**
 * 展示态筛选下推（与 task.rules 的 deriveDisplayStatus 严格同形 —— 改一处必须改两处）：
 * 覆盖生效优先（early_done 仅在已完成时生效、overdue 仅在未完成时生效）→ 完成态按实际 / 预计完成日期分「已完成 / 提前完成」→
 * 未完成且已过预计完成日期 = 「已延期」→ 其余按基础态；overdue / early_done 可由「覆盖生效」或「读时派生」两种来源命中。
 */
function displayStatusExpression(today: string): SQL {
  const early = "early_done";
  const done = "done";
  const overdue = "overdue";
  return sql`case
    when ${tasks.statusOverride} = ${early} and ${tasks.status} = ${done} then ${early}
    when ${tasks.statusOverride} = ${overdue} and ${tasks.status} <> ${done} then ${overdue}
    when ${tasks.status} = ${done} then (case
      when ${tasks.actualEnd} is not null and ${tasks.plannedEnd} is not null and ${tasks.actualEnd} < ${tasks.plannedEnd} then ${early}
      else ${done}
    end)
    when ${tasks.plannedEnd} is not null and ${tasks.plannedEnd} < ${today}::date then ${overdue}
    else ${tasks.status}
  end`;
}

function displayStatusCondition(status: string, today: string): SQL {
  return sql`${displayStatusExpression(today)} = ${status}`;
}

/** 排序：显式 sort 走白名单列；缺省 = 阶段序 + 组内位次 + id（A8 / A19 / A20 · Push 124，与看板列内顺序同口径）。 */
function taskOrderBy(sorts: readonly TaskSort[]): SQL[] {
  if (sorts.length === 0) {
    return [sql`${STAGE_ORDER} asc`, asc(tasks.sortIndex), asc(tasks.id)];
  }
  return sorts.map((item) =>
    item.direction === "desc" ? desc(SORT_COLUMNS[item.field]) : asc(SORT_COLUMNS[item.field]),
  ) as SQL[];
}
