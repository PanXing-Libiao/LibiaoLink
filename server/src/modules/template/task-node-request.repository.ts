import { Injectable } from "@nestjs/common";
import { and, desc, eq, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { DatabaseService } from "../../db/database.service.js";
import type { DbClient } from "../../db/db-client.js";
import { users } from "../../db/schema/identity.js";
import { projects } from "../../db/schema/projects.js";
import { taskNodeRequests } from "../../db/schema/templates.js";

/** 申请行（读面带上申请人 / 审核人显示名与来源项目编号，契约转换在服务层做）。 */
export interface TaskNodeRequestRow {
  id: string;
  stageKey: string;
  title: string;
  titleEn: string | null;
  status: string;
  requestedBy: string;
  requestedByName: string | null;
  requestedAt: Date;
  projectId: string | null;
  projectCode: string | null;
  projectName: string | null;
  reviewedBy: string | null;
  reviewedByName: string | null;
  reviewedAt: Date | null;
  reviewNote: string | null;
  nodeId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** 本表原始行（行锁读取用；不含 join 出来的显示名 / 项目字段）。 */
export type TaskNodeRequestDbRow = typeof taskNodeRequests.$inferSelect;

export interface TaskNodeRequestListFilter {
  stageKey: string | null;
  status: string | null;
  /** 非空 = 只看该申请人（本人视角 / 导入内去重）。 */
  requestedBy: string | null;
}

export interface TaskNodeRequestInsertInput {
  stageKey: string;
  title: string;
  titleEn: string | null;
  requestedBy: string;
  requestedAt: Date;
  projectId: string | null;
  sourcePreviewId: string | null;
}

const requester = alias(users, "request_requester");
const reviewer = alias(users, "request_reviewer");

/**
 * 公共任务节点申请仓库（0095 · 2026-11-13）：只读写 task_node_requests。
 * - 状态机 pending → approved / rejected / withdrawn；改状态一律带 status = 'pending' 条件，天然幂等且防并发重复审核；
 * - 同阶段同名只允许一条 pending（部分唯一索引）：插入用 onConflictDoNothing，冲突时由服务层复用既有行。
 */
@Injectable()
export class TaskNodeRequestRepository {
  constructor(private readonly database: DatabaseService) {}

  /** 列表：审核人视角 = 全部申请（可用阶段 / 状态过滤）；本人视角 = requestedBy 过滤。待审排最前，其余按提交时间倒序。 */
  async list(filter: TaskNodeRequestListFilter, tx?: DbClient): Promise<TaskNodeRequestRow[]> {
    const db = tx ?? this.database.db;
    const conditions = [
      filter.stageKey === null ? undefined : eq(taskNodeRequests.stageKey, filter.stageKey),
      filter.status === null ? undefined : eq(taskNodeRequests.status, filter.status),
      filter.requestedBy === null ? undefined : eq(taskNodeRequests.requestedBy, filter.requestedBy),
    ].filter((value): value is NonNullable<typeof value> => value !== undefined);
    const rows = await this.selectRows(db)
      .where(conditions.length === 0 ? sql`true` : and(...conditions))
      .orderBy(sql`case when ${taskNodeRequests.status} = 'pending' then 0 else 1 end`, desc(taskNodeRequests.requestedAt), desc(taskNodeRequests.id));
    return rows.map(toRow);
  }

  /** 待审条数（requestedBy = null 时是全局待审；非空 = 该申请人的待审）。 */
  async countPending(requestedBy: string | null, tx?: DbClient): Promise<number> {
    const db = tx ?? this.database.db;
    const where = requestedBy === null
      ? eq(taskNodeRequests.status, "pending")
      : and(eq(taskNodeRequests.status, "pending"), eq(taskNodeRequests.requestedBy, requestedBy));
    const rows = await db.select({ value: sql<number | null>`count(*)` }).from(taskNodeRequests).where(where);
    return Number(rows[0]?.value ?? 0);
  }

  /** 单条（读面带 join：申请人 / 审核人显示名 + 来源项目）。 */
  async findById(id: string, tx?: DbClient): Promise<TaskNodeRequestRow | null> {
    const db = tx ?? this.database.db;
    const rows = await this.selectRows(db).where(eq(taskNodeRequests.id, id)).limit(1);
    return rows.length === 0 ? null : toRow(rows[0]!);
  }

  /**
   * 行锁读取（审核 / 撤销前读取，保证同一申请不会被两个审核人同时处理）。
   * 只查本表、不带 join —— PostgreSQL 不允许 FOR UPDATE 作用在 outer join 的可空侧
   * （真机报错：FOR UPDATE cannot be applied to the nullable side of an outer join）；
   * 需要读面字段时在本行锁之后另取 findById。
   */
  async lockById(id: string, tx?: DbClient): Promise<TaskNodeRequestDbRow | null> {
    const db = tx ?? this.database.db;
    const rows = await db
      .select()
      .from(taskNodeRequests)
      .where(eq(taskNodeRequests.id, id))
      .limit(1)
      .for("update");
    return rows.length === 0 ? null : rows[0]!;
  }

  /** 同阶段同名待审申请（导入内去重：已有待审则复用，不重复插入）。 */
  async findPendingByTitle(stageKey: string, title: string, tx?: DbClient): Promise<TaskNodeRequestRow | null> {
    const db = tx ?? this.database.db;
    const rows = await this.selectRows(db)
      .where(
        and(
          eq(taskNodeRequests.stageKey, stageKey),
          eq(taskNodeRequests.title, title),
          eq(taskNodeRequests.status, "pending"),
        ),
      )
      .limit(1);
    return rows.length === 0 ? null : toRow(rows[0]!);
  }

  /**
   * 插入申请：命中同阶段同名 pending 唯一索引时不插入、返回 null（调用方复用既有行）。
   * 不用 target 指定索引，任何冲突都按「已有待审」处理即可。
   */
  async insertIfAbsent(input: TaskNodeRequestInsertInput, tx?: DbClient): Promise<TaskNodeRequestRow | null> {
    const db = tx ?? this.database.db;
    const rows = await db
      .insert(taskNodeRequests)
      .values({
        stageKey: input.stageKey,
        title: input.title,
        titleEn: input.titleEn,
        status: "pending",
        requestedBy: input.requestedBy,
        requestedAt: input.requestedAt,
        projectId: input.projectId,
        sourcePreviewId: input.sourcePreviewId,
      })
      .onConflictDoNothing()
      .returning({ id: taskNodeRequests.id });
    if (rows.length === 0) return null;
    return await this.findById(rows[0]!.id, tx);
  }

  /**
   * 审核落定（通过 / 驳回）：只在 pending 上生效 —— 已处理的申请返回 null，由服务层转 409。
   * 通过时必须带 nodeId；驳回时必须带 reviewNote（库内 CHECK 亦兜底）。
   */
  async decide(
    id: string,
    input: {
      status: "approved" | "rejected";
      reviewedBy: string;
      reviewedAt: Date;
      reviewNote: string | null;
      nodeId: string | null;
    },
    tx?: DbClient,
  ): Promise<TaskNodeRequestRow | null> {
    const db = tx ?? this.database.db;
    const rows = await db
      .update(taskNodeRequests)
      .set({
        status: input.status,
        reviewedBy: input.reviewedBy,
        reviewedAt: input.reviewedAt,
        reviewNote: input.reviewNote,
        nodeId: input.nodeId,
        updatedAt: input.reviewedAt,
      })
      .where(and(eq(taskNodeRequests.id, id), eq(taskNodeRequests.status, "pending")))
      .returning({ id: taskNodeRequests.id });
    if (rows.length === 0) return null;
    return await this.findById(id, tx);
  }

  /** 申请人撤销自己的待审申请：非本人 / 非 pending 返回 null。 */
  async withdraw(id: string, requestedBy: string, at: Date, tx?: DbClient): Promise<TaskNodeRequestRow | null> {
    const db = tx ?? this.database.db;
    const rows = await db
      .update(taskNodeRequests)
      .set({ status: "withdrawn", updatedAt: at })
      .where(
        and(
          eq(taskNodeRequests.id, id),
          eq(taskNodeRequests.status, "pending"),
          eq(taskNodeRequests.requestedBy, requestedBy),
        ),
      )
      .returning({ id: taskNodeRequests.id });
    if (rows.length === 0) return null;
    return await this.findById(id, tx);
  }

  private selectRows(db: DbClient) {
    return db
      .select({
        id: taskNodeRequests.id,
        stageKey: taskNodeRequests.stageKey,
        title: taskNodeRequests.title,
        titleEn: taskNodeRequests.titleEn,
        status: taskNodeRequests.status,
        requestedBy: taskNodeRequests.requestedBy,
        requestedByName: requester.displayName,
        requestedAt: taskNodeRequests.requestedAt,
        projectId: taskNodeRequests.projectId,
        projectCode: projects.code,
        projectName: projects.name,
        reviewedBy: taskNodeRequests.reviewedBy,
        reviewedByName: reviewer.displayName,
        reviewedAt: taskNodeRequests.reviewedAt,
        reviewNote: taskNodeRequests.reviewNote,
        nodeId: taskNodeRequests.nodeId,
        createdAt: taskNodeRequests.createdAt,
        updatedAt: taskNodeRequests.updatedAt,
      })
      .from(taskNodeRequests)
      .leftJoin(requester, eq(requester.id, taskNodeRequests.requestedBy))
      .leftJoin(reviewer, eq(reviewer.id, taskNodeRequests.reviewedBy))
      .leftJoin(projects, eq(projects.id, taskNodeRequests.projectId));
  }
}

function toRow(row: TaskNodeRequestRow): TaskNodeRequestRow {
  return row;
}
