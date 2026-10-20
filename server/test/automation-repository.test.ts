/**
 * M5-06-1A 规则仓库门禁（不连库）：库行严格映射 + 空表不回落代码常量 + 非法行 fail closed。
 * 真表读写 / 迁移 / seed 幂等见 scripts/m5-06-1a-replay.mjs。
 */
import { describe, expect, it } from "vitest";
import type { DatabaseService } from "../src/db/database.service.js";
import type { DbClient } from "../src/db/db-client.js";
import { BUILTIN_RULES } from "../src/modules/automation/index.js";
import {
  AutomationRuleRepository,
  automationRuleFromRow,
  type AutomationRuleRow,
} from "../src/modules/automation/automation.repository.js";

function builtin(code: string): (typeof BUILTIN_RULES)[number] {
  const rule = BUILTIN_RULES.find((item) => item.code === code);
  if (rule === undefined) throw new Error("BUILTIN_RULES 缺规则 " + code);
  return rule;
}

function rowOf(code: string): AutomationRuleRow {
  const rule = builtin(code);
  return {
    id: "00000000-0000-4000-8000-000000000001",
    code: rule.code,
    name: rule.name,
    builtIn: true,
    enabled: rule.enabled,
    trigger: rule.trigger,
    conditions: rule.conditions,
    actions: rule.actions,
    version: rule.version,
    createdBy: null,
    updatedBy: null,
    createdAt: new Date("2026-10-20T00:00:00Z"),
    updatedAt: new Date("2026-10-20T00:00:00Z"),
    deletedAt: null,
  };
}

/** 只实现 listEnabledRules 用到的 select → from → where → orderBy 链。 */
function reader(rows: readonly AutomationRuleRow[]): DbClient {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: async () => rows,
        }),
      }),
    }),
  } as unknown as DbClient;
}

function repository(rows: readonly AutomationRuleRow[]): AutomationRuleRepository {
  const database = { db: reader(rows) } as unknown as DatabaseService;
  return new AutomationRuleRepository(database);
}

describe("automationRuleFromRow（库行 → 契约严格映射）", () => {
  it("合法行映射为契约规则，不含 DB 专属字段", () => {
    const row = rowOf("R02");
    const rule = automationRuleFromRow(row);
    expect(rule.code).toBe("R02");
    expect(rule.enabled).toBe(row.enabled);
    expect(rule.trigger).toEqual(row.trigger);
    expect(rule.conditions).toEqual(row.conditions);
    expect(rule.actions).toEqual(row.actions);
    expect(rule.version).toBe(row.version);
    expect(Object.keys(rule).sort()).toEqual(["actions", "code", "conditions", "enabled", "name", "trigger", "version"]);
  });

  it("非法 actions（空数组）→ 抛错并带规则码", () => {
    const row = { ...rowOf("R02"), actions: [] };
    expect(() => automationRuleFromRow(row)).toThrow(/R02/);
  });
});

describe("AutomationRuleRepository.listEnabledRules（读表唯一来源）", () => {
  it("空表返回空集，不回落 BUILTIN_RULES", async () => {
    await expect(repository([]).listEnabledRules(reader([]))).resolves.toEqual([]);
  });

  it("任一非法行 → 整体抛错（fail closed，不跳过该行继续发通知）", async () => {
    const rows = [rowOf("R02"), { ...rowOf("R03"), trigger: null } as unknown as AutomationRuleRow];
    await expect(repository(rows).listEnabledRules(reader(rows))).rejects.toThrow(/R03/);
  });

  it("合法行按查询结果返回契约规则", async () => {
    const rows = [rowOf("R02"), rowOf("R03")];
    const rules = await repository(rows).listEnabledRules(reader(rows));
    expect(rules.map((rule) => rule.code)).toEqual(["R02", "R03"]);
  });

  it("forceEnableCodes 可在运行时启用库中已停用的 R06", async () => {
    const rows = [rowOf("R02"), { ...rowOf("R06"), enabled: false }];
    const rules = await repository(rows).listEnabledRules(reader(rows), { forceEnableCodes: ["R06"] });
    expect(rules.map((rule) => rule.code)).toEqual(["R02", "R06"]);
    expect(rules.find((rule) => rule.code === "R06")?.enabled).toBe(true);
  });
});
