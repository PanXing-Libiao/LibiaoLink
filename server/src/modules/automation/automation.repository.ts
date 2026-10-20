/**
 * automation 规则与运行记录 repository（M5-06-1A · 0060）。
 * 规则读取唯一来源 = automation_rules；代码常量 BUILTIN_RULES 只供 seed / 金标使用。
 * 运行记录 dedupe_key 唯一：先写 run，只有新建成功的 run 才允许追加 outbox。
 */
import { Injectable, Logger } from "@nestjs/common";
import { and, desc, eq, gte, inArray, isNull, lte, ne, sql, type SQL } from "drizzle-orm";
import {
  AutomationRunSchema,
  AutomationRuleSchema,
  type AutomationAction,
  type AutomationConditionEvaluation,
  type AutomationMessageSnapshot,
  type AutomationRule,
  type AutomationRun,
  type AutomationRunSkipReason,
  type AutomationRunStatus,
  type RuleEventTopic,
  type RuleTriggerKind,
} from "@libiaolink/contracts";
import { DatabaseService } from "../../db/database.service.js";
import type { DbClient } from "../../db/db-client.js";
import { automationRuns, automationRules } from "../../db/schema/automation.js";
import { jobs } from "../../db/schema/platform.js";

export type AutomationRuleRow = typeof automationRules.$inferSelect;
export type AutomationRunRow = typeof automationRuns.$inferSelect;

/** 规则管理列表 / 详情使用的调度 job 摘要（jobs.dedupe_key = automation-schedule:<ruleCode>）。 */
export interface AutomationScheduleJobRow {
  status: string;
  runAt: Date;
}

/** 乐观锁更新入参：只允许调用方已经校验过的可编辑字段。 */
export interface AutomationRuleUpdatePatch {
  enabled: boolean;
  actions: AutomationAction[];
}

/** 把库行映射为契约规则；任一行非法直接抛错（fail closed，不跳过继续发）。 */
export function automationRuleFromRow(row: AutomationRuleRow): AutomationRule {
  const parsed = AutomationRuleSchema.safeParse({
    code: row.code,
    name: row.name,
    enabled: row.enabled,
    trigger: row.trigger,
    conditions: row.conditions,
    actions: row.actions,
    version: row.version,
  });
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => issue.path.join(".") + ": " + issue.message).join("; ");
    throw new Error("automation_rules 行非法（code=" + row.code + "）：" + issues);
  }
  return parsed.data;
}

/** 把 automation_runs 行映射为契约运行记录；日期统一 ISO 串（契约 DateTimeSchema）。 */
export function automationRunFromRow(row: AutomationRunRow): AutomationRun {
  const parsed = AutomationRunSchema.safeParse({
    id: row.id,
    ruleId: row.ruleId,
    ruleCode: row.ruleCode,
    ruleVersion: row.ruleVersion,
    source: row.source,
    topic: row.topic,
    windowKey: row.windowKey,
    entityType: row.entityType,
    entityId: row.entityId,
    dedupeKey: row.dedupeKey,
    status: row.status,
    skipReason: row.skipReason,
    conditions: row.conditions,
    actions: row.actions,
    messages: row.messages,
    error: row.error,
    createdAt: row.createdAt.toISOString(),
  });
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => issue.path.join(".") + ": " + issue.message).join("; ");
    throw new Error("automation_runs 行非法（id=" + String(row.id) + "）：" + issues);
  }
  return parsed.data;
}

/** 规则表读取：只返回 enabled = true 且未软删的行；空表不回落代码常量。 */
@Injectable()
export class AutomationRuleRepository {
  private readonly logger = new Logger(AutomationRuleRepository.name);
  private emptyWarned = false;

  constructor(private readonly database: DatabaseService) {}

  async listEnabledRules(client: DbClient = this.database.db): Promise<AutomationRule[]> {
    const rows = await client
      .select()
      .from(automationRules)
      .where(and(eq(automationRules.enabled, true), isNull(automationRules.deletedAt)))
      .orderBy(automationRules.code);
    if (rows.length === 0) {
      if (!this.emptyWarned) {
        this.emptyWarned = true;
        this.logger.error("automation_rules 无启用规则：请先执行 database/scripts/seed.mjs（禁止回落代码常量）");
      }
      return [];
    }
    return rows.map(automationRuleFromRow);
  }

  async findByCode(code: string, client: DbClient = this.database.db): Promise<AutomationRuleRow | null> {
    const rows = await client
      .select()
      .from(automationRules)
      .where(and(eq(automationRules.code, code), isNull(automationRules.deletedAt)))
      .limit(1);
    return rows[0] ?? null;
  }

  /** 管理面规则（M5-06-1B）：一期固定内置规则，R01 不入列表，停用规则仍返回，按 code 升序。 */
  async listManageableRules(client: DbClient = this.database.db): Promise<AutomationRuleRow[]> {
    return client
      .select()
      .from(automationRules)
      .where(
        and(
          eq(automationRules.builtIn, true),
          ne(automationRules.code, "R01"),
          isNull(automationRules.deletedAt),
        ),
      )
      .orderBy(automationRules.code);
  }

  /** 管理面单条规则：未知 / 非内置 / R01 / 已软删统一 null（由 service 转 404，不泄漏存在性）。 */
  async findManageableByCode(code: string, client: DbClient = this.database.db): Promise<AutomationRuleRow | null> {
    const rows = await client
      .select()
      .from(automationRules)
      .where(
        and(
          eq(automationRules.code, code),
          eq(automationRules.builtIn, true),
          ne(automationRules.code, "R01"),
          isNull(automationRules.deletedAt),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /** 最近一次正式运行时刻（含 skipped / failed）；无运行记录 = 不在 Map 中。 */
  async lastRunAtByRuleCodes(
    codes: readonly string[],
    client: DbClient = this.database.db,
  ): Promise<Map<string, Date>> {
    const result = new Map<string, Date>();
    if (codes.length === 0) return result;
    const rows = await client
      .select({
        ruleCode: automationRuns.ruleCode,
        lastRunAt: sql<Date | null>`max(${automationRuns.createdAt})`,
      })
      .from(automationRuns)
      .where(inArray(automationRuns.ruleCode, [...codes]))
      .groupBy(automationRuns.ruleCode);
    for (const row of rows) {
      if (row.lastRunAt === null) continue;
      result.set(
        row.ruleCode,
        row.lastRunAt instanceof Date ? row.lastRunAt : new Date(String(row.lastRunAt)),
      );
    }
    return result;
  }

  /** 一规则一 job 的调度状态；只认 dedupe_key = automation-schedule:<ruleCode> 的新行（legacy 通用 job 忽略）。 */
  async scheduleJobsByRuleCodes(
    codes: readonly string[],
    client: DbClient = this.database.db,
  ): Promise<Map<string, AutomationScheduleJobRow>> {
    const result = new Map<string, AutomationScheduleJobRow>();
    if (codes.length === 0) return result;
    const prefix = "automation-schedule:";
    const rows = await client
      .select({ dedupeKey: jobs.dedupeKey, status: jobs.status, runAt: jobs.runAt })
      .from(jobs)
      .where(inArray(jobs.dedupeKey, codes.map((code) => prefix + code)));
    for (const row of rows) {
      if (row.dedupeKey === null || !row.dedupeKey.startsWith(prefix)) continue;
      const code = row.dedupeKey.slice(prefix.length);
      if (!codes.includes(code)) continue;
      result.set(code, { status: row.status, runAt: row.runAt });
    }
    return result;
  }

  /** 乐观锁保存：version 不匹配返回 null（由 service 转 409 VERSION_CONFLICT）。 */
  async updateWithVersion(
    id: string,
    expectedVersion: number,
    patch: AutomationRuleUpdatePatch,
    actorId: string,
    at: Date,
    client: DbClient,
  ): Promise<AutomationRuleRow | null> {
    const rows = await client
      .update(automationRules)
      .set({
        enabled: patch.enabled,
        actions: patch.actions,
        version: sql`${automationRules.version} + 1`,
        updatedBy: actorId,
        updatedAt: at,
      })
      .where(
        and(
          eq(automationRules.id, id),
          eq(automationRules.version, expectedVersion),
          isNull(automationRules.deletedAt),
        ),
      )
      .returning();
    return rows[0] ?? null;
  }
}

export interface AutomationRunInsert {
  ruleCode: string;
  ruleVersion: number;
  source: RuleTriggerKind;
  topic: RuleEventTopic | null;
  windowKey: string | null;
  entityType: string | null;
  entityId: string | null;
  dedupeKey: string;
  status: AutomationRunStatus;
  skipReason: AutomationRunSkipReason | null;
  conditions: AutomationConditionEvaluation[];
  actions: AutomationAction[];
  messages: AutomationMessageSnapshot[];
  error: string | null;
}

export interface AutomationRunFilter {
  ruleCode?: string;
  status?: AutomationRunStatus;
  source?: RuleTriggerKind;
  topic?: RuleEventTopic;
  entityId?: string;
  windowKey?: string;
  from?: Date;
  to?: Date;
  page?: number;
  limit?: number;
}

/** 运行记录读写：同批插入 on conflict do nothing，返回真正新建的 dedupe_key。 */
@Injectable()
export class AutomationRunRepository {
  constructor(private readonly database: DatabaseService) {}

  async insertIfAbsent(client: DbClient, inputs: readonly AutomationRunInsert[]): Promise<ReadonlySet<string>> {
    if (inputs.length === 0) return new Set<string>();
    const values = inputs.map((input) => ({
      ruleId: sql`(select id from ${automationRules} where ${automationRules.code} = ${input.ruleCode} and ${automationRules.deletedAt} is null)`,
      ruleCode: input.ruleCode,
      ruleVersion: input.ruleVersion,
      source: input.source,
      topic: input.topic,
      windowKey: input.windowKey,
      entityType: input.entityType,
      entityId: input.entityId,
      dedupeKey: input.dedupeKey,
      status: input.status,
      skipReason: input.skipReason,
      conditions: input.conditions,
      actions: input.actions,
      messages: input.messages,
      error: input.error,
    }));
    const rows = await client
      .insert(automationRuns)
      .values(values)
      .onConflictDoNothing({ target: automationRuns.dedupeKey })
      .returning({ dedupeKey: automationRuns.dedupeKey });
    return new Set(rows.map((row) => row.dedupeKey));
  }

  async list(filter: AutomationRunFilter = {}, client: DbClient = this.database.db): Promise<AutomationRunRow[]> {
    const conditions = runConditions(filter);
    const page = Math.max(1, filter.page ?? 1);
    // 契约 PageQuerySchema 上限 200；响应 limit 必须与实际取数一致，不能静默截到 100。
    const limit = Math.min(200, Math.max(1, filter.limit ?? 50));
    return client
      .select()
      .from(automationRuns)
      .where(conditions.length === 0 ? undefined : and(...conditions))
      .orderBy(desc(automationRuns.createdAt), desc(automationRuns.id))
      .limit(limit)
      .offset((page - 1) * limit);
  }

  /** 运行记录总数（与 list 同筛选口径，供稳定分页）。 */
  async count(filter: AutomationRunFilter = {}, client: DbClient = this.database.db): Promise<number> {
    const conditions = runConditions(filter);
    const rows = await client
      .select({ value: sql<number>`count(*)::int` })
      .from(automationRuns)
      .where(conditions.length === 0 ? undefined : and(...conditions));
    return Number(rows[0]?.value ?? 0);
  }

  /** 运行详情：不存在返回 null（由 service 转 404）。 */
  async findById(id: number, client: DbClient = this.database.db): Promise<AutomationRunRow | null> {
    const rows = await client.select().from(automationRuns).where(eq(automationRuns.id, id)).limit(1);
    return rows[0] ?? null;
  }
}

/** list / count 共用筛选条件（状态 / 来源 / 主题 / 实体 / 窗口 / 时间闭区间）。 */
function runConditions(filter: AutomationRunFilter): SQL[] {
  const conditions: SQL[] = [];
  if (filter.ruleCode !== undefined) conditions.push(eq(automationRuns.ruleCode, filter.ruleCode));
  if (filter.status !== undefined) conditions.push(eq(automationRuns.status, filter.status));
  if (filter.source !== undefined) conditions.push(eq(automationRuns.source, filter.source));
  if (filter.topic !== undefined) conditions.push(eq(automationRuns.topic, filter.topic));
  if (filter.entityId !== undefined) conditions.push(eq(automationRuns.entityId, filter.entityId));
  if (filter.windowKey !== undefined) conditions.push(eq(automationRuns.windowKey, filter.windowKey));
  if (filter.from !== undefined) conditions.push(gte(automationRuns.createdAt, filter.from));
  if (filter.to !== undefined) conditions.push(lte(automationRuns.createdAt, filter.to));
  return conditions;
}
