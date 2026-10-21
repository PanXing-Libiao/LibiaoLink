/**
 * M5-06-1B 规则管理门禁（不连库）：列表 / 详情 / 乐观锁保存 / 只读字段冲突 /
 * 收件人白名单 / 停用 job 联动 / 同事务审计 / 试运行零副作用与 100 主体截断 / 运行记录读面。
 * 真表版本 / 审计 / job / runs / outbox 联动见 scripts/m5-06-1b-replay.mjs。
 */
import { describe, expect, it } from "vitest";
import type {
  AutomationAction,
  AutomationRule,
  AutomationRuleTestResponse,
} from "@libiaolink/contracts";
import type { DatabaseService } from "../src/db/database.service.js";
import type { DbClient } from "../src/db/db-client.js";
import type { JobsStore } from "../src/db/jobs.store.js";
import type { AuditService } from "../src/modules/audit/index.js";
import { atShanghaiTime, calendarWindow } from "../src/modules/calendar/index.js";
import type { CalendarService } from "../src/modules/calendar/index.js";
import { BUILTIN_RULES, toTaskSubject, type ReplaySubject } from "../src/modules/automation/index.js";
import {
  AutomationService,
  type AutomationTrialSubjectPort,
} from "../src/modules/automation/automation.service.js";
import type {
  AutomationRuleRow,
  AutomationRunFilter,
  AutomationRunRow,
} from "../src/modules/automation/automation.repository.js";
import type { PermissionService } from "../src/modules/permission/index.js";
import type { ClockService } from "../src/common/clock/clock.service.js";

const NOW = new Date(atShanghaiTime("2026-09-24", "09:30"));
const BUSINESS_DATE = "2026-09-24";
const CALENDAR = calendarWindow("2026-09-01", "2026-09-30", []);
const TX = { marker: "tx" } as unknown as DbClient;

function rule(code: string): AutomationRule {
  const found = BUILTIN_RULES.find((item) => item.code === code);
  if (found === undefined) throw new Error("BUILTIN_RULES 缺规则 " + code);
  return found;
}

function rowOf(code: string, overrides: Partial<AutomationRuleRow> = {}): AutomationRuleRow {
  const base = rule(code);
  const index = BUILTIN_RULES.findIndex((item) => item.code === code);
  return {
    id: "00000000-0000-4000-8000-" + String(index + 1).padStart(12, "0"),
    code: base.code,
    name: base.name,
    builtIn: true,
    enabled: base.enabled,
    trigger: base.trigger,
    conditions: base.conditions,
    actions: base.actions,
    version: base.version,
    createdBy: null,
    updatedBy: null,
    createdAt: new Date("2026-10-20T00:00:00Z"),
    updatedAt: new Date("2026-10-20T00:00:00Z"),
    deletedAt: null,
    ...overrides,
  };
}

function runRow(overrides: Partial<AutomationRunRow> = {}): AutomationRunRow {
  return {
    id: 1,
    ruleId: "00000000-0000-4000-8000-000000000002",
    ruleCode: "R02",
    ruleVersion: 1,
    source: "event",
    topic: "task.completed",
    windowKey: "v5",
    entityType: "task",
    entityId: "t-1",
    dedupeKey: "R02:t-1:v5",
    status: "hit",
    skipReason: null,
    conditions: [],
    actions: [],
    messages: [],
    error: null,
    createdAt: new Date("2026-09-24T01:00:00Z"),
    ...overrides,
  };
}

function task(id: string, overrides: Record<string, unknown> = {}): ReplaySubject {
  return toTaskSubject({
    id,
    title: "安装摄像头",
    version: 5,
    displayStatus: "active",
    urgency: "高",
    plannedStart: null,
    plannedEnd: "2026-09-23",
    actualStart: null,
    actualEnd: null,
    ownerId: "u-owner-" + id,
    ownerName: "负责人" + id,
    managerId: "u-manager-" + id,
    managerName: "经理" + id,
    projectId: "p-1",
    projectCode: "LBUSA-20261020-001",
    projectName: "回放项目",
    projectProgress: 50,
    completedByName: "邵晨宇",
    projectGroupId: null,
    deliverableTypes: ["施工方案"],
    fileCount: 0,
    ...overrides,
  });
}

class FakeRules {
  readonly rows: AutomationRuleRow[];
  readonly jobMap = new Map<string, { status: string; runAt: Date }>();
  readonly updates: { id: string; expectedVersion: number; enabled: boolean; actions: AutomationAction[]; client: DbClient }[] = [];
  forceConflict = false;

  constructor(rows: readonly AutomationRuleRow[]) {
    this.rows = rows.map((row) => ({ ...row }));
    for (const item of rows) {
      if (item.trigger.kind === "schedule") {
        this.jobMap.set(item.code, { status: item.enabled ? "pending" : "done", runAt: NOW });
      }
    }
  }

  async listManageableRules(): Promise<AutomationRuleRow[]> {
    return this.rows
      .filter((row) => row.builtIn && row.code !== "R01" && row.deletedAt === null)
      .sort((left, right) => left.code.localeCompare(right.code));
  }

  async findManageableByCode(code: string): Promise<AutomationRuleRow | null> {
    return this.rows.find((row) => row.code === code && row.builtIn && row.deletedAt === null) ?? null;
  }

  async lastRunAtByRuleCodes(codes: readonly string[]): Promise<Map<string, Date>> {
    const result = new Map<string, Date>();
    if (codes.includes("R02")) result.set("R02", new Date("2026-09-23T01:00:00Z"));
    return result;
  }

  async scheduleJobsByRuleCodes(codes: readonly string[]): Promise<Map<string, { status: string; runAt: Date }>> {
    const result = new Map<string, { status: string; runAt: Date }>();
    for (const code of codes) {
      const job = this.jobMap.get(code);
      if (job !== undefined) result.set(code, job);
    }
    return result;
  }

  async updateWithVersion(
    id: string,
    expectedVersion: number,
    patch: { enabled: boolean; actions: AutomationAction[] },
    _actorId: string,
    at: Date,
    client: DbClient,
  ): Promise<AutomationRuleRow | null> {
    this.updates.push({ id, expectedVersion, enabled: patch.enabled, actions: patch.actions, client });
    if (this.forceConflict) return null;
    const index = this.rows.findIndex((row) => row.id === id);
    const before = this.rows[index];
    if (before === undefined || before.version !== expectedVersion) return null;
    const updated: AutomationRuleRow = {
      ...before,
      enabled: patch.enabled,
      actions: patch.actions,
      version: before.version + 1,
      updatedAt: at,
    };
    this.rows[index] = updated;
    return updated;
  }
}

class FakeRuns {
  readonly rows: AutomationRunRow[];
  readonly filters: AutomationRunFilter[] = [];

  constructor(rows: readonly AutomationRunRow[]) {
    this.rows = rows.map((row) => ({ ...row }));
  }

  async list(filter: AutomationRunFilter): Promise<AutomationRunRow[]> {
    this.filters.push(filter);
    return this.rows.slice(0, filter.limit ?? 50);
  }

  async count(): Promise<number> {
    return this.rows.length;
  }

  async findById(id: number): Promise<AutomationRunRow | null> {
    return this.rows.find((row) => row.id === id) ?? null;
  }
}

class FakeJobs {
  readonly calls: { client: DbClient; input: { ruleCode: string; ruleVersion: number; cron: string; enabled: boolean } }[] = [];
  constructor(private readonly rules: FakeRules) {}

  async reconcileAutomationScheduleJob(
    client: DbClient,
    input: { ruleCode: string; ruleVersion: number; cron: string; enabled: boolean },
  ): Promise<string> {
    this.calls.push({ client, input });
    this.rules.jobMap.set(input.ruleCode, { status: input.enabled ? "pending" : "done", runAt: NOW });
    return input.enabled ? "reactivated" : "disabled";
  }
}

class FakeAudit {
  readonly calls: { client: DbClient; input: Record<string, unknown> }[] = [];

  async record(client: DbClient, input: Record<string, unknown>): Promise<void> {
    this.calls.push({ client, input });
  }
}

class FakeSubjects implements AutomationTrialSubjectPort {
  readonly events = new Map<string, ReplaySubject | null>();
  windowSubjects: ReplaySubject[] = [];
  eventCalls = 0;
  windowCalls = 0;

  async subjectById(_topic: string, entityId: string): Promise<ReplaySubject | null> {
    this.eventCalls += 1;
    return this.events.get(entityId) ?? null;
  }

  async loadWindow(): Promise<{ subjects: ReplaySubject[]; calendar: typeof CALENDAR }> {
    this.windowCalls += 1;
    return { subjects: this.windowSubjects, calendar: CALENDAR };
  }
}

interface Harness {
  service: AutomationService;
  rules: FakeRules;
  runs: FakeRuns;
  jobs: FakeJobs;
  audit: FakeAudit;
  subjects: FakeSubjects;
  permissionCalls: string[];
}

function harness(overrides: { rows?: AutomationRuleRow[]; runs?: AutomationRunRow[] } = {}): Harness {
  const rows = overrides.rows ?? BUILTIN_RULES.map((item) => rowOf(item.code));
  const rules = new FakeRules(rows);
  const runs = new FakeRuns(overrides.runs ?? []);
  const jobs = new FakeJobs(rules);
  const audit = new FakeAudit();
  const subjects = new FakeSubjects();
  const permissionCalls: string[] = [];
  const permission = {
    async assertCan(actorId: string, key: string): Promise<void> {
      permissionCalls.push(actorId + ":" + key);
      if (actorId === "denied") {
        const { AppError } = await import("../src/common/errors/app-error.js");
        throw new AppError("FORBIDDEN", "无权限：" + key);
      }
    },
  } as unknown as PermissionService;
  const clock = { now: () => NOW, today: () => BUSINESS_DATE } as unknown as ClockService;
  const calendar = {
    async getSettings(): Promise<{ reminderShiftEnabled: boolean; shiftDirection: "forward" }> {
      return { reminderShiftEnabled: false, shiftDirection: "forward" };
    },
  } as unknown as CalendarService;
  const database = {
    db: { async transaction<T>(work: (client: DbClient) => Promise<T>): Promise<T> { return work(TX); } },
  } as unknown as DatabaseService;
  const service = new AutomationService(
    database,
    rules as never,
    runs as never,
    jobs as unknown as JobsStore,
    audit as unknown as AuditService,
    permission,
    clock,
    calendar,
    subjects,
  );
  return { service, rules, runs, jobs, audit, subjects, permissionCalls };
}

describe("AutomationService 规则读面", () => {
  it("列表固定内置规则、排除 R01、保留停用规则并按 code 升序", async () => {
    const h = harness();
    const result = await h.service.listRules("admin");
    expect(result.items.map((item) => item.code)).toEqual([
      "A01",
      "A02",
      "A08",
      "A14",
      "R02",
      "R03",
      "R04",
      "R05",
      "R06",
      "R07",
    ]);
    expect(result.items.find((item) => item.code === "A01")?.enabled).toBe(false);
    expect(result.items.find((item) => item.code === "R02")?.lastRunAt).toBe("2026-09-23T01:00:00.000Z");
    expect(result.items.find((item) => item.code === "R03")?.scheduleJobStatus).toBe("pending");
    expect(result.items.find((item) => item.code === "R02")?.editableFields).toEqual([
      "enabled",
      "actions.channel",
      "actions.recipient",
    ]);
    expect(h.permissionCalls).toEqual(["admin:automation.view"]);
  });

  it("详情：R01 / 未知规则统一 404（不泄漏存在性）", async () => {
    const h = harness();
    await expect(h.service.getRule("admin", "R01")).rejects.toMatchObject({ code: "NOT_FOUND", httpStatus: 404 });
    await expect(h.service.getRule("admin", "A03")).rejects.toMatchObject({ code: "NOT_FOUND", httpStatus: 404 });
    await expect(h.service.getRule("admin", "R02")).resolves.toMatchObject({ code: "R02" });
  });
});

describe("AutomationService.patchRule（乐观锁 + 只读字段 + job / 审计同事务）", () => {
  it("启用 A01：version + 1、同事务审计、调度 job 重新启用", async () => {
    const h = harness();
    const before = h.rules.rows.find((row) => row.code === "A01");
    if (before === undefined) throw new Error("A01 缺失");
    const view = await h.service.patchRule("admin", "A01", { version: before.version, enabled: true });
    expect(view.enabled).toBe(true);
    expect(view.version).toBe(before.version + 1);
    expect(view.scheduleJobStatus).toBe("pending");
    expect(view.nextRunAt).toBe(NOW.toISOString());
    expect(h.rules.updates).toHaveLength(1);
    expect(h.rules.updates[0]?.client).toBe(TX);
    expect(h.jobs.calls).toEqual([
      { client: TX, input: { ruleCode: "A01", ruleVersion: before.version + 1, cron: "30 19 * * *", enabled: true } },
    ]);
    expect(h.audit.calls).toHaveLength(1);
    expect(h.audit.calls[0]?.client).toBe(TX);
    expect(h.audit.calls[0]?.input).toMatchObject({
      action: "update",
      objectType: "automation_rule",
      objectId: before.id,
      metadata: { code: "A01", beforeVersion: before.version, afterVersion: before.version + 1 },
    });
  });

  it("停用 R03：job 置 done，规则行保留，nextRunAt = null", async () => {
    const h = harness();
    const before = h.rules.rows.find((row) => row.code === "R03");
    if (before === undefined) throw new Error("R03 缺失");
    const view = await h.service.patchRule("admin", "R03", { version: before.version, enabled: false });
    expect(view.enabled).toBe(false);
    expect(view.scheduleJobStatus).toBe("done");
    expect(view.nextRunAt).toBeNull();
    expect(h.jobs.calls[0]?.input.enabled).toBe(false);
    expect(h.rules.rows.find((row) => row.code === "R03")?.enabled).toBe(false);
  });

  it("事件型规则保存不登记调度 job", async () => {
    const h = harness();
    const before = h.rules.rows.find((row) => row.code === "R02");
    if (before === undefined) throw new Error("R02 缺失");
    await h.service.patchRule("admin", "R02", { version: before.version, enabled: false });
    expect(h.jobs.calls).toEqual([]);
    expect(h.audit.calls).toHaveLength(1);
  });

  it("version 不匹配：409 VERSION_CONFLICT，零更新 / 零审计 / 零 reconcile", async () => {
    const h = harness();
    await expect(h.service.patchRule("admin", "R02", { version: 99, enabled: false })).rejects.toMatchObject({
      code: "VERSION_CONFLICT",
      httpStatus: 409,
    });
    expect(h.rules.updates).toEqual([]);
    expect(h.jobs.calls).toEqual([]);
    expect(h.audit.calls).toEqual([]);
  });

  it("并发竞争（预检通过但 update 返回 null）：409，且不写审计 / job", async () => {
    const h = harness();
    const before = h.rules.rows.find((row) => row.code === "R02");
    if (before === undefined) throw new Error("R02 缺失");
    h.rules.forceConflict = true;
    await expect(h.service.patchRule("admin", "R02", { version: before.version, enabled: false })).rejects.toMatchObject({
      code: "VERSION_CONFLICT",
      httpStatus: 409,
    });
    expect(h.jobs.calls).toEqual([]);
    expect(h.audit.calls).toEqual([]);
  });

  it("改模板 / 动作数量：409（S8-4 不可修改口径），不落库", async () => {
    const h = harness();
    const before = h.rules.rows.find((row) => row.code === "R02");
    if (before === undefined) throw new Error("R02 缺失");
    const changedTemplate = before.actions.map((action, index) =>
      index === 0 ? { ...action, template: "R03_WECOM" } : action,
    );
    await expect(
      h.service.patchRule("admin", "R02", { version: before.version, actions: changedTemplate }),
    ).rejects.toMatchObject({ code: "VERSION_CONFLICT", httpStatus: 409 });
    await expect(
      h.service.patchRule("admin", "R02", { version: before.version, actions: before.actions.slice(0, 1) }),
    ).rejects.toMatchObject({ code: "VERSION_CONFLICT", httpStatus: 409 });
    expect(h.rules.updates).toEqual([]);
    expect(h.audit.calls).toEqual([]);
  });

  it("收件人口径不适用于主体类型：400 VALIDATION_FAILED", async () => {
    const h = harness();
    const before = h.rules.rows.find((row) => row.code === "R02");
    if (before === undefined) throw new Error("R02 缺失");
    const invalid = before.actions.map((action, index) =>
      index === 0 ? { ...action, recipient: "report.member" as const } : action,
    );
    await expect(
      h.service.patchRule("admin", "R02", { version: before.version, actions: invalid }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED", httpStatus: 400 });
    expect(h.rules.updates).toEqual([]);
  });

  it("缺少 automation.manage：403，且不读规则", async () => {
    const h = harness();
    await expect(h.service.patchRule("denied", "R02", { version: 1, enabled: false })).rejects.toMatchObject({
      code: "FORBIDDEN",
      httpStatus: 403,
    });
    expect(h.permissionCalls).toEqual(["denied:automation.manage"]);
    expect(h.rules.updates).toEqual([]);
  });
});

describe("AutomationService.testRule（只读试运行）", () => {
  it("事件型缺 entityId：400，且零主体读取 / 零写", async () => {
    const h = harness();
    await expect(h.service.testRule("admin", "R02", { businessDate: BUSINESS_DATE })).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      httpStatus: 400,
    });
    expect(h.subjects.eventCalls).toBe(0);
    expect(h.rules.updates).toEqual([]);
    expect(h.audit.calls).toEqual([]);
  });

  it("事件型命中：按主体求值，不写 run / outbox / 审计，recipient 只回展示值", async () => {
    const h = harness();
    h.subjects.events.set(
      "t-1",
      toTaskSubject({
        id: "t-1",
        title: "安装摄像头",
        version: 5,
        displayStatus: "done",
        urgency: "高",
        plannedStart: null,
        plannedEnd: null,
        actualStart: null,
        actualEnd: BUSINESS_DATE,
        ownerId: "u-1",
        ownerName: "张三",
        managerId: "u-9",
        managerName: "李四",
        projectId: "p-1",
        projectCode: "LBUSA-20261020-001",
        projectName: "回放项目",
        projectProgress: 50,
        completedByName: "邵晨宇",
        projectGroupId: null,
        deliverableTypes: ["施工方案"],
        fileCount: 0,
      }),
    );
    const result: AutomationRuleTestResponse = await h.service.testRule("admin", "R02", {
      businessDate: BUSINESS_DATE,
      entityId: "t-1",
    });
    expect(result.businessDate).toBe(BUSINESS_DATE);
    expect(result.evaluatedCount).toBe(1);
    expect(result.matchedCount).toBe(1);
    expect(result.skippedCount).toBe(0);
    expect(result.truncated).toBe(false);
    expect(result.messages).toHaveLength(4);
    expect(result.messages.map((message) => message.recipient)).toEqual(["张三", "李四", "张三", "李四"]);
    expect(result.messages.map((message) => message.template)).toEqual([
      "R02_INBOX",
      "R02_INBOX",
      "R02_WECOM",
      "R02_WECOM",
    ]);
    expect(h.subjects.eventCalls).toBe(1);
    expect(h.rules.updates).toEqual([]);
    expect(h.audit.calls).toEqual([]);
  });

  it("事件型主体不存在：404", async () => {
    const h = harness();
    await expect(
      h.service.testRule("admin", "R02", { businessDate: BUSINESS_DATE, entityId: "missing" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND", httpStatus: 404 });
  });

  it("调度型超过 100 个主体：截断并置 truncated = true，evaluatedCount = 100", async () => {
    const h = harness();
    h.subjects.windowSubjects = Array.from({ length: 101 }, (_, index) => task("t-" + String(index).padStart(3, "0")));
    const result = await h.service.testRule("admin", "R05", { businessDate: BUSINESS_DATE });
    expect(result.evaluatedCount).toBe(100);
    expect(result.matchedCount).toBe(100);
    expect(result.truncated).toBe(true);
    expect(result.messages).toHaveLength(200);
    expect(h.subjects.windowCalls).toBe(1);
    expect(h.audit.calls).toEqual([]);
  });

  it("调度型 entityId 不在主体池：404", async () => {
    const h = harness();
    h.subjects.windowSubjects = [task("t-1")];
    await expect(
      h.service.testRule("admin", "R05", { businessDate: BUSINESS_DATE, entityId: "t-missing" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND", httpStatus: 404 });
  });
});

describe("AutomationService 运行记录读面", () => {
  it("列表：筛选透传 + total + createdAt / 字段映射", async () => {
    const h = harness({ runs: [runRow(), runRow({ id: 2, dedupeKey: "R02:t-2:v5" })] });
    const result = await h.service.listRuns("admin", {
      ruleCode: "R02",
      status: "hit",
      source: "event",
      page: 2,
      limit: 20,
    });
    expect(result.total).toBe(2);
    expect(result.page).toBe(2);
    expect(result.items[0]).toMatchObject({
      id: 1,
      ruleCode: "R02",
      createdAt: "2026-09-24T01:00:00.000Z",
    });
    expect(h.runs.filters[0]).toMatchObject({ ruleCode: "R02", status: "hit", source: "event", page: 2, limit: 20 });
  });

  it("列表 from > to：400，且不查库", async () => {
    const h = harness();
    await expect(
      h.service.listRuns("admin", {
        from: "2026-09-25T00:00:00.000Z",
        to: "2026-09-24T00:00:00.000Z",
        page: 1,
        limit: 20,
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED", httpStatus: 400 });
    expect(h.runs.filters).toEqual([]);
  });

  it("详情：存在返回契约快照；不存在 404", async () => {
    const h = harness({ runs: [runRow()] });
    await expect(h.service.getRun("admin", 1)).resolves.toMatchObject({ id: 1, ruleCode: "R02" });
    await expect(h.service.getRun("admin", 99)).rejects.toMatchObject({ code: "NOT_FOUND", httpStatus: 404 });
  });
});
