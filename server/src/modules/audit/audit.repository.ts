import { Injectable } from "@nestjs/common";
import { and, count, desc, eq, gte, ilike, inArray, lte, or, sql, type SQL } from "drizzle-orm";
import { DatabaseService } from "../../db/database.service.js";
import type { DbClient } from "../../db/db-client.js";
import { auditLogs, type AuditChangeEntry } from "../../db/schema/admin.js";
import { users } from "../../db/schema/identity.js";
import { projects } from "../../db/schema/projects.js";

/** 审计写入入参（actor / result / entry 由服务层补全；字段口径 = audit_logs 表）。 */
export interface AuditInsertInput {
  occurredAt: Date;
  actorId: string | null;
  actorName: string | null;
  action: string;
  objectType: string;
  objectId: string;
  projectId: string | null;
  projectCode: string | null;
  projectName: string | null;
  result: string;
  entry: string;
  summary: string;
  changes: AuditChangeEntry[] | null;
  metadata: Record<string, unknown>;
}

/**
 * 审计检索条件（h7 验收项②：按对象 / 操作人；动作 / 结果 / 项目 / 时间 / 关键字为 C7-04 查询页）。
 * 2026-10-09 追订：对象类型 / 操作人 / 动作 / 结果 / 项目改**多值**（数组，OR 语义；undefined = 不筛）——
 * 由 AuditService 解析逗号分隔参数并逐值校验白名单（非法 400），与文件列表 filter[status] 同一先例。
 */
export interface AuditListFilter {
  objectTypes?: string[];
  objectId?: string;
  actorIds?: string[];
  actions?: string[];
  results?: string[];
  projectIds?: string[];
  /** 关键字（Push 260 · C7-04 搜索）：操作内容摘要 / 操作人姓名快照 / 字段级修改明细（ILIKE 包含，大小写不敏感）。 */
  keyword?: string;
  from?: Date;
  to?: Date;
  /** 当前查看者：非管理员时至少只能看到本人记录。 */
  viewerActorId?: string;
  /** 当前查看者有效管理项目：与本人记录取 OR，允许看到这些项目的全部记录。 */
  viewerManagedProjectIds?: string[];
}

export interface AuditRow {
  id: number;
  occurredAt: Date;
  actorId: string | null;
  actorName: string | null;
  action: string;
  objectType: string;
  objectId: string;
  projectId: string | null;
  projectCode: string | null;
  projectName: string | null;
  result: string;
  entry: string;
  summary: string;
  changes: AuditChangeEntry[] | null;
  metadata: Record<string, unknown>;
}

/**
 * 审计数据访问（h7 · C7）：只 INSERT + SELECT —— UPDATE / DELETE 已在库级收回（0013 迁移 + 角色脚本，C7-05 防篡改）。
 * 写入以调用方事务为准（业务留痕与业务写入同事务）；越权留痕由 AuditService 走独立连接。
 */
@Injectable()
export class AuditRepository {
  constructor(private readonly database: DatabaseService) {}

  /** 追加写（业务事务内调用）。 */
  async insert(client: DbClient, input: AuditInsertInput): Promise<void> {
    await client.insert(auditLogs).values({
      occurredAt: input.occurredAt,
      actorId: input.actorId,
      actorName: input.actorName,
      action: input.action,
      objectType: input.objectType,
      objectId: input.objectId,
      projectId: input.projectId,
      projectCode: input.projectCode,
      projectName: input.projectName,
      result: input.result,
      entry: input.entry,
      summary: input.summary,
      changes: input.changes,
      metadata: input.metadata,
    });
    // PostgreSQL releases the hint only at commit; identical hints in one transaction coalesce.
    await client.execute(sql`select pg_notify('notify_stream', ${JSON.stringify({ recipientId: null, event: "invalidate", data: { resources: ["audit"] } })})`);

  }

  /** 检索（occurredAt 降序 + id 降序：同毫秒写入也稳定）。 */
  async listPage(filter: AuditListFilter, limit: number, offset: number, beforeId?: number): Promise<{ items: AuditRow[]; total: number; windowId: number | null }> {
    const where = buildAuditWhere(filter);
    const totals = await this.database.db.select({ value: count(), maxId: sql<number>`coalesce(max(${auditLogs.id}), 0)` }).from(auditLogs).where(where);
    const windowId = beforeId ?? Number(totals[0]?.maxId ?? 0);
    const items = await this.database.db
      .select({
        id: auditLogs.id,
        occurredAt: auditLogs.occurredAt,
        actorId: auditLogs.actorId,
        actorName: auditLogs.actorName,
        action: auditLogs.action,
        objectType: auditLogs.objectType,
        objectId: auditLogs.objectId,
        projectId: auditLogs.projectId,
        projectCode: sql<string | null>`coalesce(${projects.code}, ${auditLogs.projectCode})`,
        projectName: sql<string | null>`coalesce(${projects.name}, ${auditLogs.projectName})`,
        result: auditLogs.result,
        entry: auditLogs.entry,
        summary: auditLogs.summary,
        changes: auditLogs.changes,
        metadata: auditLogs.metadata,
      })
      .from(auditLogs)
      .leftJoin(projects, eq(projects.id, auditLogs.projectId))
      .where(and(where, lte(auditLogs.id, windowId)))
      .orderBy(desc(auditLogs.occurredAt), desc(auditLogs.id))
      .limit(limit)
      .offset(offset);
    return { items, total: Number(totals[0]?.value ?? 0), windowId: windowId === 0 ? null : windowId };
  }

  /** 操作人姓名快照（只读 users 一列；避免平台模块依赖 identity 的业务出口 —— check:boundaries）。 */
  async findUserDisplayName(userId: string, client: DbClient = this.database.db): Promise<string | null> {
    const rows = await client
      .select({ displayName: users.displayName })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    return rows[0]?.displayName ?? null;
  }

  /** 项目编号 / 名称快照：不过滤 deleted_at，回收站项目也作为当前项目返回。 */
  async findProjectSnapshot(projectId: string, client: DbClient = this.database.db): Promise<{ code: string; name: string } | null> {
    const rows = await client
      .select({ code: projects.code, name: projects.name })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    return rows[0] ?? null;
  }
}

/** 条件构造：多值 IN（单值数组 = 等值）+ 关键字 ILIKE（摘要 / 操作人姓名 / 变化明细）+ 时间闭区间（索引覆盖）。 */
function buildAuditWhere(filter: AuditListFilter): SQL | undefined {
  const conditions: SQL[] = [];
  if (filter.objectTypes !== undefined) conditions.push(inArray(auditLogs.objectType, filter.objectTypes));
  if (filter.objectId !== undefined) conditions.push(eq(auditLogs.objectId, filter.objectId));
  if (filter.actorIds !== undefined) conditions.push(inArray(auditLogs.actorId, filter.actorIds));
  if (filter.actions !== undefined) conditions.push(inArray(auditLogs.action, filter.actions));
  if (filter.results !== undefined) conditions.push(inArray(auditLogs.result, filter.results));
  if (filter.projectIds !== undefined) conditions.push(inArray(auditLogs.projectId, filter.projectIds));
  if (filter.keyword !== undefined && filter.keyword !== "") {
    const pattern = "%" + escapeLikePattern(filter.keyword) + "%";
    const keywordMatch = or(
      ilike(auditLogs.summary, pattern),
      ilike(auditLogs.actorName, pattern),
      sql`${auditLogs.changes}::text ilike ${pattern}`,
    );
    if (keywordMatch !== undefined) conditions.push(keywordMatch);
  }
  if (filter.from !== undefined) conditions.push(gte(auditLogs.occurredAt, filter.from));
  if (filter.to !== undefined) conditions.push(lte(auditLogs.occurredAt, filter.to));
  if (filter.viewerActorId !== undefined) {
    const self = eq(auditLogs.actorId, filter.viewerActorId);
    const managedIds = filter.viewerManagedProjectIds ?? [];
    const managed = managedIds.length > 0 ? inArray(auditLogs.projectId, managedIds) : undefined;
    const visibility = managed === undefined ? self : or(self, managed);
    if (visibility !== undefined) conditions.push(visibility);
  }
  if (conditions.length === 0) return undefined;
  return and(...conditions);
}

/** LIKE 通配符转义（PG 默认转义符为反斜杠；与 project / file 仓储同口径）。 */
function escapeLikePattern(value: string): string {
  const backslash = String.fromCharCode(92);
  return value.split(backslash).join(backslash + backslash).split("%").join(backslash + "%").split("_").join(backslash + "_");
}
