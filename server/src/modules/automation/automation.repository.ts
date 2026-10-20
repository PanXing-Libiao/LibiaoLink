/**
 * automation 规则与运行记录 repository（M5-06-1A · 0060）。
 * 规则读取唯一来源 = automation_rules；代码常量 BUILTIN_RULES 只供 seed / 金标使用。
 * 运行记录 dedupe_key 唯一：先写 run，只有新建成功的 run 才允许追加 outbox。
 */
import { Injectable, Logger } from "@nestjs/common";
import { and, desc, eq, gte, isNull, lte, sql, type SQL } from "drizzle-orm";
import {
  AutomationRuleSchema,
  type AutomationAction,
  type AutomationConditionEvaluation,
  type AutomationMessageSnapshot,
  type AutomationRule,
  type AutomationRunSkipReason,
  type AutomationRunStatus,
  type RuleEventTopic,
  type RuleTriggerKind,
} from "@libiaolink/contracts";
import { DatabaseService } from "../../db/database.service.js";
import type { DbClient } from "../../db/db-client.js";
import { automationRuns, automationRules } from "../../db/schema/automation.js";

export type AutomationRuleRow = typeof automationRules.$inferSelect;
export type AutomationRunRow = typeof automationRuns.$inferSelect;

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
    const conditions: SQL[] = [];
    if (filter.ruleCode !== undefined) conditions.push(eq(automationRuns.ruleCode, filter.ruleCode));
    if (filter.status !== undefined) conditions.push(eq(automationRuns.status, filter.status));
    if (filter.source !== undefined) conditions.push(eq(automationRuns.source, filter.source));
    if (filter.topic !== undefined) conditions.push(eq(automationRuns.topic, filter.topic));
    if (filter.entityId !== undefined) conditions.push(eq(automationRuns.entityId, filter.entityId));
    if (filter.windowKey !== undefined) conditions.push(eq(automationRuns.windowKey, filter.windowKey));
    if (filter.from !== undefined) conditions.push(gte(automationRuns.createdAt, filter.from));
    if (filter.to !== undefined) conditions.push(lte(automationRuns.createdAt, filter.to));
    const page = Math.max(1, filter.page ?? 1);
    const limit = Math.min(100, Math.max(1, filter.limit ?? 20));
    return client
      .select()
      .from(automationRuns)
      .where(conditions.length === 0 ? undefined : and(...conditions))
      .orderBy(desc(automationRuns.createdAt), desc(automationRuns.id))
      .limit(limit)
      .offset((page - 1) * limit);
  }
}
