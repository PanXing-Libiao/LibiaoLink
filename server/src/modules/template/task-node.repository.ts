import { Injectable } from "@nestjs/common";
import { and, asc, eq, inArray, isNull, notInArray, sql } from "drizzle-orm";
import { DatabaseService } from "../../db/database.service.js";
import type { DbClient } from "../../db/db-client.js";
import { taskNodes } from "../../db/schema/templates.js";

/** 节点行（契约转换在服务层做）。ownerTemplateId = null 为公共节点，非空为模板私有节点。 */
export interface TaskNodeRow {
  id: string;
  ownerTemplateId: string | null;
  stageKey: string;
  seq: number;
  title: string;
  titleEn: string | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface TaskNodeInsertInput {
  ownerTemplateId?: string | null;
  stageKey: string;
  seq: number;
  title: string;
  titleEn: string | null;
}

/** 编辑补丁（只改传入的字段；titleEn = null 显式清空）。 */
export interface TaskNodeUpdatePatch {
  title?: string;
  titleEn?: string | null;
}

/** 九阶段顺序（列表排序用）：与 shared/src/common/dicts.ts 的 STAGE_KEYS 同序；未知 key 排最后。 */
const STAGE_RANK = sql`coalesce(array_position(array['presale','design','purchase','assembly','install','deploy','trial','production','acceptance']::text[], ${taskNodes.stageKey}), 99)`;

/**
 * 任务节点仓库（0032 · M3-05 余；0094 增模板私有节点）：只读写 task_nodes。
 * - 公共节点：owner_template_id is null；列表 / 全局编辑 / 删除只看公共行；
 * - 模板私有节点：owner_template_id = 模板 id；由模板接口创建，不出现在公共读面；
 * - 删除 = 物理删行（returning 回快照给服务层写审计），无软删标记 —— 与字典条目硬删同口径（Push 173）。
 */
@Injectable()
export class TaskNodeRepository {
  constructor(private readonly database: DatabaseService) {}

  /** 公共节点库按阶段过滤（null = 全部阶段）；排序 = 九阶段顺序 → seq → id。 */
  async list(stageKey: string | null, tx?: DbClient): Promise<TaskNodeRow[]> {
    const db = tx ?? this.database.db;
    const where = stageKey === null
      ? isNull(taskNodes.ownerTemplateId)
      : and(isNull(taskNodes.ownerTemplateId), eq(taskNodes.stageKey, stageKey));
    const rows = await db
      .select()
      .from(taskNodes)
      .where(where)
      .orderBy(STAGE_RANK, asc(taskNodes.seq), asc(taskNodes.id));
    return rows.map(toRow);
  }

  /** 公共节点详情；模板私有节点对公共写接口按不存在处理。 */
  async findById(id: string, tx?: DbClient): Promise<TaskNodeRow | null> {
    const db = tx ?? this.database.db;
    const rows = await db
      .select()
      .from(taskNodes)
      .where(and(eq(taskNodes.id, id), isNull(taskNodes.ownerTemplateId)))
      .limit(1);
    return rows.length === 0 ? null : toRow(rows[0] as TaskNodeRow);
  }

  /** 一批节点（按 id，顺序不保证）：公共 / 私有都返回，模板写入前由服务层校验归属。 */
  async listByIds(ids: string[], tx?: DbClient): Promise<TaskNodeRow[]> {
    if (ids.length === 0) {
      return [];
    }
    const db = tx ?? this.database.db;
    const rows = await db.select().from(taskNodes).where(inArray(taskNodes.id, ids));
    return rows.map(toRow);
  }

  /** 公共节点同阶段同名判重；ownerTemplateId 非空时改为模板内同名判重。 */
  async findByTitle(
    stageKey: string,
    title: string,
    ownerTemplateId: string | null,
    tx?: DbClient,
  ): Promise<TaskNodeRow | null> {
    const db = tx ?? this.database.db;
    const owner = ownerTemplateId === null ? isNull(taskNodes.ownerTemplateId) : eq(taskNodes.ownerTemplateId, ownerTemplateId);
    const rows = await db
      .select()
      .from(taskNodes)
      .where(and(eq(taskNodes.stageKey, stageKey), eq(taskNodes.title, title), owner))
      .limit(1);
    return rows.length === 0 ? null : toRow(rows[0] as TaskNodeRow);
  }

  /** 公共节点库该阶段当前最大 seq（空阶段 → 0）：新增公共节点追加到末尾（末位 + 10）。 */
  async maxSeq(stageKey: string, tx?: DbClient): Promise<number> {
    const db = tx ?? this.database.db;
    const rows = await db
      .select({ value: sql<number | null>`max(${taskNodes.seq})` })
      .from(taskNodes)
      .where(and(eq(taskNodes.stageKey, stageKey), isNull(taskNodes.ownerTemplateId)));
    const value = rows[0]?.value ?? null;
    return value === null ? 0 : Number(value);
  }

  /** 某模板私有节点的最大 seq（新增私有节点时追加到末尾）。 */
  async maxOwnerSeq(ownerTemplateId: string, tx?: DbClient): Promise<number> {
    const db = tx ?? this.database.db;
    const rows = await db
      .select({ value: sql<number | null>`max(${taskNodes.seq})` })
      .from(taskNodes)
      .where(eq(taskNodes.ownerTemplateId, ownerTemplateId));
    const value = rows[0]?.value ?? null;
    return value === null ? 0 : Number(value);
  }

  async insert(input: TaskNodeInsertInput, tx?: DbClient): Promise<TaskNodeRow> {
    const db = tx ?? this.database.db;
    const rows = await db
      .insert(taskNodes)
      .values({
        ownerTemplateId: input.ownerTemplateId ?? null,
        stageKey: input.stageKey,
        seq: input.seq,
        title: input.title,
        titleEn: input.titleEn,
      })
      .returning();
    return toRow(rows[0] as TaskNodeRow);
  }

  /** 乐观锁更新：version 不匹配返回 null（由 service 转 409 VERSION_CONFLICT）；只改传入的字段。 */
  async updateWithVersion(
    id: string,
    expectedVersion: number,
    patch: TaskNodeUpdatePatch,
    at: Date,
    tx?: DbClient,
  ): Promise<TaskNodeRow | null> {
    const db = tx ?? this.database.db;
    const rows = await db
      .update(taskNodes)
      .set({ ...patch, version: sql`${taskNodes.version} + 1`, updatedAt: at })
      .where(and(eq(taskNodes.id, id), isNull(taskNodes.ownerTemplateId), eq(taskNodes.version, expectedVersion)))
      .returning();
    return rows.length === 0 ? null : toRow(rows[0] as TaskNodeRow);
  }

  /** 物理删公共节点；返回被删的行（不存在 = null）。 */
  async deleteById(id: string, tx?: DbClient): Promise<TaskNodeRow | null> {
    const db = tx ?? this.database.db;
    const rows = await db
      .delete(taskNodes)
      .where(and(eq(taskNodes.id, id), isNull(taskNodes.ownerTemplateId)))
      .returning();
    return rows.length === 0 ? null : toRow(rows[0] as TaskNodeRow);
  }

  /** 模板保存后清理该模板已移除的私有节点；keepIds 里包含公共节点无影响。 */
  async deleteUnreferencedOwned(templateId: string, keepIds: string[], tx?: DbClient): Promise<string[]> {
    const db = tx ?? this.database.db;
    const where = keepIds.length === 0
      ? eq(taskNodes.ownerTemplateId, templateId)
      : and(eq(taskNodes.ownerTemplateId, templateId), notInArray(taskNodes.id, keepIds));
    const rows = await db.delete(taskNodes).where(where).returning({ id: taskNodes.id });
    return rows.map((row) => row.id);
  }
}

function toRow(row: typeof taskNodes.$inferSelect): TaskNodeRow {
  return {
    id: row.id,
    ownerTemplateId: row.ownerTemplateId,
    stageKey: row.stageKey,
    seq: row.seq,
    title: row.title,
    titleEn: row.titleEn,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
