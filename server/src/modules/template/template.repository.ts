/**
 * 任务模板仓库（M3-05 余 · 第二段 · 0033）：只读写 task_templates / task_template_nodes 两张表。
 * - 读面恒带 `deleted_at is null`（软删模板对列表 / 详情 / 写操作一律不可见 → 服务层转 404）；
 * - 模板内节点顺序 = task_template_nodes.seq 升序（全量替换时按 nodeIds 下标重排为 10/20/30…）；
 * - 标题 / 英文名不落模板表：读面 join task_nodes 实时取（节点改名后模板预览随即更新，不存快照）。
 */
import { Injectable } from "@nestjs/common";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { DatabaseService } from "../../db/database.service.js";
import type { DbClient } from "../../db/db-client.js";
import { users } from "../../db/schema/identity.js";
import { taskNodes, taskTemplateNodes, taskTemplates } from "../../db/schema/templates.js";

/** 模板行（契约转换在服务层做）。 */
export interface TaskTemplateRow {
  id: string;
  name: string;
  stageKey: string;
  version: number;
  createdBy: string | null;
  createdByName: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** 模板内节点引用（含节点当前中英文名：join task_nodes 实时取）。 */
export interface TaskTemplateNodeRef {
  templateId: string;
  nodeId: string;
  seq: number;
  title: string;
  titleEn: string | null;
}

/** 编辑补丁（只改传入的字段）。 */
export interface TaskTemplateUpdatePatch {
  name?: string;
}

/** 九阶段顺序（列表排序用）：与 shared/src/common/dicts.ts 的 STAGE_KEYS 同序；未知 key 排最后。 */
const STAGE_RANK = sql`coalesce(array_position(array['presale', 'design', 'purchase', 'assembly', 'install', 'deploy', 'trial', 'production', 'acceptance']::text[], ${taskTemplates.stageKey}), 99)`;

@Injectable()
export class TaskTemplateRepository {
  constructor(private readonly database: DatabaseService) {}

  /**
   * 按阶段过滤（null = 全部阶段）；排序 = 九阶段顺序 → created_at 倒序 → id。
   * 倒序的理由：面板顺序 = 「最新在最左」——「＋ 新建模板」在界面上就把新面板插在主列右侧（Push 58 业务口径），
   * 刷新后按库里的顺序重排，同样得让最新的排在最左，否则新建的模板会在刷新后从左端跳到右端。
   * 种子（#9）按清单顺序倒排 created_at，所以业务清单的第一套（如「硬件实施模板一」）仍在最左。
   */
  async list(stageKey: string | null, tx?: DbClient): Promise<TaskTemplateRow[]> {
    const db = tx ?? this.database.db;
    const where = stageKey === null ? isNull(taskTemplates.deletedAt) : and(isNull(taskTemplates.deletedAt), eq(taskTemplates.stageKey, stageKey));
    const rows = await db
      .select({
        id: taskTemplates.id,
        name: taskTemplates.name,
        stageKey: taskTemplates.stageKey,
        version: taskTemplates.version,
        createdBy: taskTemplates.createdBy,
        createdByName: users.displayName,
        createdAt: taskTemplates.createdAt,
        updatedAt: taskTemplates.updatedAt,
        deletedAt: taskTemplates.deletedAt,
        deletedBy: taskTemplates.deletedBy,
      })
      .from(taskTemplates)
      .leftJoin(users, eq(users.id, taskTemplates.createdBy))
      .where(where)
      .orderBy(STAGE_RANK, desc(taskTemplates.createdAt), asc(taskTemplates.id));
    return rows.map(toRow);
  }

  /** 详情 / 写前读：已软删等同不存在（null）。 */
  async findById(id: string, tx?: DbClient): Promise<TaskTemplateRow | null> {
    const db = tx ?? this.database.db;
    const rows = await db
      .select({
        id: taskTemplates.id,
        name: taskTemplates.name,
        stageKey: taskTemplates.stageKey,
        version: taskTemplates.version,
        createdBy: taskTemplates.createdBy,
        createdByName: users.displayName,
        createdAt: taskTemplates.createdAt,
        updatedAt: taskTemplates.updatedAt,
        deletedAt: taskTemplates.deletedAt,
        deletedBy: taskTemplates.deletedBy,
      })
      .from(taskTemplates)
      .leftJoin(users, eq(users.id, taskTemplates.createdBy))
      .where(and(eq(taskTemplates.id, id), isNull(taskTemplates.deletedAt)))
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : toRow(row);
  }

  /** 一批模板的节点引用：模板内按 seq → node_id 升序（调用方按 templateId 分发）。 */
  async nodeRefsOf(templateIds: string[], tx?: DbClient): Promise<TaskTemplateNodeRef[]> {
    if (templateIds.length === 0) {
      return [];
    }
    const db = tx ?? this.database.db;
    const rows = await db
      .select({
        templateId: taskTemplateNodes.templateId,
        nodeId: taskTemplateNodes.nodeId,
        seq: taskTemplateNodes.seq,
        title: taskNodes.title,
        titleEn: taskNodes.titleEn,
      })
      .from(taskTemplateNodes)
      .innerJoin(taskNodes, eq(taskNodes.id, taskTemplateNodes.nodeId))
      .where(inArray(taskTemplateNodes.templateId, templateIds))
      .orderBy(asc(taskTemplateNodes.templateId), asc(taskTemplateNodes.seq), asc(taskTemplateNodes.nodeId));
    return rows.map((row) => ({
      templateId: row.templateId,
      nodeId: row.nodeId,
      seq: row.seq,
      title: row.title,
      titleEn: row.titleEn,
    }));
  }

  async insert(input: { name: string; stageKey: string; createdBy: string }, tx?: DbClient): Promise<TaskTemplateRow> {
    const db = tx ?? this.database.db;
    const rows = await db
      .insert(taskTemplates)
      .values({ name: input.name, stageKey: input.stageKey, createdBy: input.createdBy })
      .returning();
    const row = rows[0] as typeof taskTemplates.$inferSelect;
    return toRow({ ...row, createdByName: null });
  }

  /** 节点全量替换：先清空再按数组顺序写回（seq = (下标 + 1) × 10）—— 调用方在同一事务内调用。 */
  async replaceNodes(templateId: string, nodeIds: string[], tx?: DbClient): Promise<void> {
    const db = tx ?? this.database.db;
    await db.delete(taskTemplateNodes).where(eq(taskTemplateNodes.templateId, templateId));
    if (nodeIds.length === 0) {
      return;
    }
    await db.insert(taskTemplateNodes).values(
      nodeIds.map((nodeId, index) => ({ templateId, nodeId, seq: (index + 1) * 10 })),
    );
  }

  /** 乐观锁更新（改名）：version 不匹配返回 null（由 service 转 409 VERSION_CONFLICT）。 */
  async updateWithVersion(
    id: string,
    expectedVersion: number,
    patch: TaskTemplateUpdatePatch,
    at: Date,
    tx?: DbClient,
  ): Promise<TaskTemplateRow | null> {
    const db = tx ?? this.database.db;
    const rows = await db
      .update(taskTemplates)
      .set({ ...patch, version: sql`${taskTemplates.version} + 1`, updatedAt: at })
      .where(and(eq(taskTemplates.id, id), eq(taskTemplates.version, expectedVersion), isNull(taskTemplates.deletedAt)))
      .returning();
    if (rows.length === 0) return null;
    const row = rows[0] as typeof taskTemplates.$inferSelect;
    return toRow({ ...row, createdByName: null });
  }

  /** 软删（置 deleted_at / deleted_by + version + 1）：version 不匹配返回 null；引用行随之物理清掉。 */
  async softDelete(
    id: string,
    expectedVersion: number,
    actorId: string,
    at: Date,
    tx?: DbClient,
  ): Promise<TaskTemplateRow | null> {
    const db = tx ?? this.database.db;
    const rows = await db
      .update(taskTemplates)
      .set({
        deletedAt: at,
        deletedBy: actorId,
        version: sql`${taskTemplates.version} + 1`,
        updatedAt: at,
      })
      .where(and(eq(taskTemplates.id, id), eq(taskTemplates.version, expectedVersion), isNull(taskTemplates.deletedAt)))
      .returning();
    if (rows.length === 0) return null;
    const row = rows[0] as typeof taskTemplates.$inferSelect;
    return toRow({ ...row, createdByName: null });
  }

  /** 某节点被多少份未删模板引用（删节点前算影响面，写审计 metadata）。 */
  async countActiveByNodeId(nodeId: string, tx?: DbClient): Promise<number> {
    const db = tx ?? this.database.db;
    const rows = await db
      .select({ value: sql<number>`count(*)::int` })
      .from(taskTemplateNodes)
      .innerJoin(taskTemplates, eq(taskTemplates.id, taskTemplateNodes.templateId))
      .where(and(eq(taskTemplateNodes.nodeId, nodeId), isNull(taskTemplates.deletedAt)));
    return Number(rows[0]?.value ?? 0);
  }
}

type TaskTemplateRowSource = typeof taskTemplates.$inferSelect & { createdByName: string | null };

function toRow(row: TaskTemplateRowSource): TaskTemplateRow {
  return {
    id: row.id,
    name: row.name,
    stageKey: row.stageKey,
    version: row.version,
    createdBy: row.createdBy,
    createdByName: row.createdByName,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
