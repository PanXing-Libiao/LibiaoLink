#!/usr/bin/env node
/**
 * M5-06-1B 真机回放（Docker PostgreSQL 18 / 已迁移库）：
 *   证据一：管理读面 —— 10 条内置规则、R01 排除、停用保留、code 升序、job / lastRun 摘要；
 *   证据二：乐观锁保存 —— 真表 version + 1、enabled / actions.channel / actions.recipient 落库、
 *           审计与 job reconcile 同事务；旧 version / 只读字段 / 非法收件人分别 409 / 409 / 400；
 *   证据三：停用联动 —— job 置 done、规则行保留、nextRunAt = null；重新启用 job pending；
 *   证据四：只读试运行 —— 事件型按 entityId 读主体、调度型 100 主体截断；
 *           试运行前后 automation_runs / outbox_events / audit_logs 零新增；
 *   证据五：运行记录读面 —— 真表 list / total / 详情 / 404；
 *   证据六：清理 —— 夹具、审计、运行记录、outbox 零残留，规则 / job 原值恢复。
 *
 * 前置：server/dist 已构建；目标库已迁移（或加 --migrate 让脚本先跑 0001~0060 + 规则 seed）。
 * 用法：cd server && node scripts/m5-06-1b-replay.mjs
 *       可选：--database-url <url> / --migrate / --json <证据.json> / --keep
 * 退出码：断言全过 = 0，否则 = 1。
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, eq, like, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = join(HERE, "..");
const REPO_ROOT = join(SERVER_ROOT, "..");
const args = parseArgs(process.argv.slice(2));
const DATABASE_URL =
  args.databaseUrl ??
  process.env.M5_06_1B_DATABASE_URL ??
  process.env.M5_06_1B_REPLAY_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql://libiaolink_migrator@127.0.0.1:55432/libiaolink_m5_06_1b";
const BASE_URL = args.baseUrl ?? process.env.M5_06_1B_BASE_URL ?? null;

const RUN_PREFIX = "replay:m5-06-1b:";
// 固定业务日用于求值；写入时刻必须晚于 seed 的 created_at（当前时刻），否则触发 timestamp check。
const NOW = new Date(Date.now() + 60_000);
const BUSINESS_DATE = "2026-09-24";
const ADMIN_ID = randomUUID();
const HTTP_ADMIN_ID = randomUUID();
const HTTP_SESSION_TOKEN = randomBytes(32).toString("base64url");
const HTTP_CSRF_TOKEN = randomBytes(16).toString("base64url");
const OWNER_ID = randomUUID();
const MANAGER_ID = randomUUID();
const PROJECT_ID = randomUUID();
// 事件任务 id 排在所有调度夹具之后：R05 截断 100 主体时不会挤占调度任务。
const EVENT_TASK_ID = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const STAGE_ID = randomUUID();
const GROUP_CHATID = "replay-chat-1b-" + randomUUID().slice(0, 8);

const checks = [];
let pass = 0;
let fail = 0;

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (item === "--database-url") out.databaseUrl = argv[++i];
    else if (item === "--base-url") out.baseUrl = argv[++i];
    else if (item === "--json") out.json = argv[++i];
    else if (item === "--migrate") out.migrate = true;
    else if (item === "--keep") out.keep = true;
    else if (item === "--help" || item === "-h") {
      console.log("用法：node scripts/m5-06-1b-replay.mjs [--database-url <url>] [--base-url <url>] [--migrate] [--json <path>] [--keep]");
      process.exit(0);
    } else throw new Error("未知参数：" + item);
  }
  return out;
}

async function check(name, work) {
  try {
    const detail = await work();
    pass += 1;
    checks.push({ name, ok: true, detail: detail ?? null });
    console.log("PASS  " + name + (detail === undefined || detail === null ? "" : " —— " + detail));
  } catch (error) {
    fail += 1;
    checks.push({ name, ok: false, error: error instanceof Error ? error.message : String(error) });
    console.error("FAIL  " + name + " —— " + (error instanceof Error ? error.message : String(error)));
  }
}

function seedAutomationRules() {
  return execFileSync(process.execPath, [join(REPO_ROOT, "database", "scripts", "seed.mjs"), "--only=automation-rules"], {
    cwd: join(REPO_ROOT, "database"),
    env: { ...process.env, DATABASE_URL },
    encoding: "utf8",
  });
}

function seedOnly(name) {
  return execFileSync(process.execPath, [join(REPO_ROOT, "database", "scripts", "seed.mjs"), "--only=" + name], {
    cwd: join(REPO_ROOT, "database"),
    env: { ...process.env, DATABASE_URL },
    encoding: "utf8",
  });
}

function json(value) {
  return JSON.parse(JSON.stringify(value));
}

async function main() {
  if (args.migrate) {
    console.log("roles: 执行 0001_roles.sql（幂等，补当前库 default privileges）…");
    const bootstrap = new pg.Client({ connectionString: DATABASE_URL });
    await bootstrap.connect();
    try {
      await bootstrap.query(readFileSync(join(REPO_ROOT, "database", "roles", "0001_roles.sql"), "utf8"));
    } finally {
      await bootstrap.end();
    }
    console.log("migrate: 执行 0001~0060 …");
    execFileSync(process.execPath, [join(REPO_ROOT, "database", "scripts", "migrate.mjs")], {
      cwd: join(REPO_ROOT, "database"),
      env: { ...process.env, DATABASE_URL },
      stdio: "inherit",
    });
  }
  seedAutomationRules();

  const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 4 });
  const db = drizzle(pool, { schema });
  const database = { pool, db };
  const automation = await import(pathToFileURL(join(SERVER_ROOT, "dist", "modules", "automation", "index.js")).href);
  const serviceModule = await import(pathToFileURL(join(SERVER_ROOT, "dist", "modules", "automation", "automation.service.js")).href);
  const subjectsModule = await import(pathToFileURL(join(SERVER_ROOT, "dist", "outbox", "automation-subjects.js")).href);
  const auditRepositoryModule = await import(pathToFileURL(join(SERVER_ROOT, "dist", "modules", "audit", "audit.repository.js")).href);
  const auditServiceModule = await import(pathToFileURL(join(SERVER_ROOT, "dist", "modules", "audit", "audit.service.js")).href);
  const jobsStoreModule = await import(pathToFileURL(join(SERVER_ROOT, "dist", "db", "jobs.store.js")).href);

  const rules = new automation.AutomationRuleRepository(database);
  const runs = new automation.AutomationRunRepository(database);
  const jobs = new jobsStoreModule.JobsStore(database);
  const audit = new auditServiceModule.AuditService(database, new auditRepositoryModule.AuditRepository(database));
  const permission = { async assertCan() {} };
  const clock = { now: () => NOW, today: () => BUSINESS_DATE };
  const calendar = {
    async getSettings() {
      return { reminderShiftEnabled: false, shiftDirection: "forward" };
    },
    async getYear() {
      return { year: 2026, days: [] };
    },
  };
  const subjects = new subjectsModule.AutomationSubjectReader(database, calendar);
  const service = new serviceModule.AutomationService(
    database,
    rules,
    runs,
    jobs,
    audit,
    permission,
    clock,
    calendar,
    subjects,
  );

  const patchedCodes = ["R02", "A01", "A08", "R06"];
  const originalRules = new Map();
  let originalA01Job = null;
  let auditBaseline = 0;

  try {
    await check("夹具：管理员 / 负责人 / 经理 / 项目 / 群 / 阶段 / 102 个任务", async () => {
      await db.insert(users).values([
        { id: ADMIN_ID, casdoorId: "replay-1b-admin", username: "replay-1b-admin", displayName: "回放管理员" },
        { id: OWNER_ID, casdoorId: "replay-1b-owner", username: "replay-1b-owner", displayName: "回放负责人" },
        { id: MANAGER_ID, casdoorId: "replay-1b-manager", username: "replay-1b-manager", displayName: "回放经理" },
      ]);
      await db.insert(projects).values({
        id: PROJECT_ID,
        code: "LBUSA-20261020-1B",
        name: "M5-06-1B 回放项目",
        region: "华东",
        projectType: "标准",
        managerIds: [MANAGER_ID],
        stageKey: "install",
        status: "done",
      });
      await db.insert(wecomGroups).values({
        projectId: PROJECT_ID,
        chatid: GROUP_CHATID,
        name: "M5-06-1B 回放群",
        enabled: true,
        activatedAt: NOW,
      });
      await db.insert(projectStages).values([
        { id: STAGE_ID, projectId: PROJECT_ID, stageKey: "design", seq: 2, status: "done", version: 3, advancedAt: NOW, advancedBy: ADMIN_ID },
        { projectId: PROJECT_ID, stageKey: "purchase", seq: 3, status: "active", version: 1 },
      ]);
      const specialStage = await db
        .select({ id: projectStages.id })
        .from(projectStages)
        .where(and(eq(projectStages.projectId, PROJECT_ID), eq(projectStages.stageKey, "design")))
        .limit(1);
      assert.equal(specialStage[0]?.id, STAGE_ID);

      const taskRows = [
        {
          id: EVENT_TASK_ID,
          projectId: PROJECT_ID,
          stageKey: "install",
          title: "回放事件任务（R02）",
          ownerIds: [OWNER_ID],
          status: "done",
          progress: "1",
          plannedEnd: null,
          actualEnd: BUSINESS_DATE,
          deliverableTypes: ["CAD图纸"],
          version: 5,
        },
      ];
      for (let index = 0; index < 101; index += 1) {
        taskRows.push({
          id: "00000000-0000-4000-8000-" + String(index).padStart(12, "0"),
          projectId: PROJECT_ID,
          stageKey: "install",
          title: "回放调度任务 " + String(index).padStart(3, "0"),
          ownerIds: [OWNER_ID],
          status: "active",
          progress: "0.5",
          plannedEnd: "2026-09-23",
          deliverableTypes: ["CAD图纸"],
          version: 1,
        });
      }
      await db.insert(tasks).values(taskRows);
      return "users=3 / project=1 / group=1 / stages=2 / tasks=102";
    });

    await check("规则读面：10 条内置规则、R01 排除、停用保留、code 升序、job 摘要", async () => {
      const list = await service.listRules(ADMIN_ID);
      assert.equal(list.items.length, 10);
      assert.deepEqual(
        list.items.map((item) => item.code),
        ["A01", "A02", "A08", "A14", "R02", "R03", "R04", "R05", "R06", "R07"],
      );
      assert.equal(list.items.some((item) => item.code === "R01"), false);
      assert.equal(list.items.find((item) => item.code === "A01")?.enabled, false);
      const r03 = list.items.find((item) => item.code === "R03");
      assert.equal(r03?.scheduleJobStatus, "pending");
      assert.ok(r03?.nextRunAt !== null);
      assert.equal(list.items.find((item) => item.code === "R02")?.scheduleJobStatus, null);
      return "items=10 / R01 excluded / A01 disabled retained";
    });

    await check("规则详情：R01 / 未知 404，R02 详情字段齐备", async () => {
      await assert.rejects(() => service.getRule(ADMIN_ID, "R01"), (error) => error?.code === "NOT_FOUND");
      await assert.rejects(() => service.getRule(ADMIN_ID, "A03"), (error) => error?.code === "NOT_FOUND");
      const view = await service.getRule(ADMIN_ID, "R02");
      assert.equal(view.code, "R02");
      assert.equal(view.builtIn, true);
      assert.deepEqual(view.editableFields, ["enabled", "actions.channel", "actions.recipient"]);
      return "R01/A03 = 404 / R02 readable";
    });

    for (const code of patchedCodes) {
      const rows = await db
        .select({
          id: automationRules.id,
          code: automationRules.code,
          enabled: automationRules.enabled,
          actions: automationRules.actions,
          version: automationRules.version,
          updatedBy: automationRules.updatedBy,
          updatedAt: sql`${automationRules.updatedAt}::text`,
        })
        .from(automationRules)
        .where(eq(automationRules.code, code));
      assert.equal(rows.length, 1);
      originalRules.set(code, { ...rows[0] });
    }
    const a01JobRows = await db
      .select({
        payload: jobsTable.payload,
        cron: jobsTable.cron,
        status: jobsTable.status,
        runAt: sql`${jobsTable.runAt}::text`,
        lastRunAt: sql`${jobsTable.lastRunAt}::text`,
        attempts: jobsTable.attempts,
        lastError: jobsTable.lastError,
        lockedBy: jobsTable.lockedBy,
        lockedAt: sql`${jobsTable.lockedAt}::text`,
        updatedAt: sql`${jobsTable.updatedAt}::text`,
      })
      .from(jobsTable)
      .where(eq(jobsTable.dedupeKey, "automation-schedule:A01"));
    originalA01Job = a01JobRows[0] ?? null;
    const auditCount = await db
      .select({ value: sql`count(*)::int` })
      .from(auditLogs)
      .where(eq(auditLogs.actorId, ADMIN_ID));
    auditBaseline = Number(auditCount[0]?.value ?? 0);

    await check("保存 R02 渠道 / 收件人：version + 1、真表 actions、审计同事务、事件型无 job", async () => {
      const before = originalRules.get("R02");
      const nextActions = before.actions.map((action, index) =>
        index === 1 ? { ...action, channel: "wecom_group", recipient: "project.group" } : action,
      );
      const view = await service.patchRule(ADMIN_ID, "R02", { version: before.version, actions: nextActions });
      assert.equal(view.version, before.version + 1);
      const rows = await db.select().from(automationRules).where(eq(automationRules.code, "R02"));
      assert.equal(rows[0].version, before.version + 1);
      assert.equal(rows[0].actions[1].channel, "wecom_group");
      assert.equal(rows[0].actions[1].recipient, "project.group");
      const audits = await db
        .select()
        .from(auditLogs)
        .where(and(eq(auditLogs.actorId, ADMIN_ID), eq(auditLogs.objectId, before.id)));
      assert.equal(audits.length, 1);
      assert.equal(audits[0].objectType, "automation_rule");
      assert.equal(audits[0].action, "update");
      assert.deepEqual(audits[0].metadata, { code: "R02", beforeVersion: before.version, afterVersion: before.version + 1 });
      const jobRows = await db.select().from(jobsTable).where(eq(jobsTable.dedupeKey, "automation-schedule:R02"));
      assert.equal(jobRows.length, 0);
      return "version " + before.version + " → " + (before.version + 1) + " / audit=1 / job=0";
    });

    await check("旧 version：409 VERSION_CONFLICT，规则 / 审计零变化", async () => {
      const before = originalRules.get("R02");
      const current = await db.select().from(automationRules).where(eq(automationRules.code, "R02"));
      const auditsBefore = await db
        .select({ value: sql`count(*)::int` })
        .from(auditLogs)
        .where(eq(auditLogs.actorId, ADMIN_ID));
      await assert.rejects(
        () => service.patchRule(ADMIN_ID, "R02", { version: before.version, enabled: false }),
        (error) => error?.code === "VERSION_CONFLICT" && error?.httpStatus === 409,
      );
      const after = await db.select().from(automationRules).where(eq(automationRules.code, "R02"));
      assert.equal(after[0].version, current[0].version);
      const auditsAfter = await db
        .select({ value: sql`count(*)::int` })
        .from(auditLogs)
        .where(eq(auditLogs.actorId, ADMIN_ID));
      assert.equal(Number(auditsAfter[0].value), Number(auditsBefore[0].value));
      return "409 / version unchanged";
    });

    await check("只读字段 / 动作数量：409，规则 / 审计零变化", async () => {
      const current = await db.select().from(automationRules).where(eq(automationRules.code, "R02"));
      const row = current[0];
      const changedTemplate = row.actions.map((action, index) =>
        index === 0 ? { ...action, template: "R03_WECOM" } : action,
      );
      await assert.rejects(
        () => service.patchRule(ADMIN_ID, "R02", { version: row.version, actions: changedTemplate }),
        (error) => error?.code === "VERSION_CONFLICT" && error?.httpStatus === 409,
      );
      await assert.rejects(
        () => service.patchRule(ADMIN_ID, "R02", { version: row.version, actions: row.actions.slice(0, 1) }),
        (error) => error?.code === "VERSION_CONFLICT" && error?.httpStatus === 409,
      );
      const after = await db.select().from(automationRules).where(eq(automationRules.code, "R02"));
      assert.equal(after[0].version, row.version);
      return "template / action count = 409 / version unchanged";
    });

    await check("非法收件人：400 VALIDATION_FAILED，规则零变化", async () => {
      const current = await db.select().from(automationRules).where(eq(automationRules.code, "R02"));
      const row = current[0];
      const invalid = row.actions.map((action, index) =>
        index === 0 ? { ...action, recipient: "report.member" } : action,
      );
      await assert.rejects(
        () => service.patchRule(ADMIN_ID, "R02", { version: row.version, actions: invalid }),
        (error) => error?.code === "VALIDATION_FAILED" && error?.httpStatus === 400,
      );
      const after = await db.select().from(automationRules).where(eq(automationRules.code, "R02"));
      assert.equal(after[0].version, row.version);
      return "400 / version unchanged";
    });

    await check("启用 A01：job done → pending，payload.ruleVersion = 新版本", async () => {
      const before = originalRules.get("A01");
      const view = await service.patchRule(ADMIN_ID, "A01", { version: before.version, enabled: true });
      assert.equal(view.enabled, true);
      assert.equal(view.scheduleJobStatus, "pending");
      const jobRows = await db.select().from(jobsTable).where(eq(jobsTable.dedupeKey, "automation-schedule:A01"));
      assert.equal(jobRows.length, 1);
      assert.equal(jobRows[0].status, "pending");
      assert.equal(jobRows[0].payload.ruleCode, "A01");
      assert.equal(jobRows[0].payload.ruleVersion, before.version + 1);
      return "A01 v" + before.version + " → v" + (before.version + 1) + " / job pending";
    });

    await check("停用 A01：job 置 done、规则行保留、nextRunAt = null", async () => {
      const rows = await db.select().from(automationRules).where(eq(automationRules.code, "A01"));
      const current = rows[0];
      const view = await service.patchRule(ADMIN_ID, "A01", { version: current.version, enabled: false });
      assert.equal(view.enabled, false);
      assert.equal(view.scheduleJobStatus, "done");
      assert.equal(view.nextRunAt, null);
      const jobRows = await db.select().from(jobsTable).where(eq(jobsTable.dedupeKey, "automation-schedule:A01"));
      assert.equal(jobRows[0].status, "done");
      const ruleRows = await db.select().from(automationRules).where(eq(automationRules.code, "A01"));
      assert.equal(ruleRows.length, 1);
      return "job done / rule retained / nextRunAt null";
    });

    await check("启用 A08：事件型试运行按 stage entityId 命中群消息", async () => {
      const rows = await db.select().from(automationRules).where(eq(automationRules.code, "A08"));
      const before = rows[0];
      await service.patchRule(ADMIN_ID, "A08", { version: before.version, enabled: true });
      const result = await service.testRule(ADMIN_ID, "A08", { businessDate: BUSINESS_DATE, entityId: STAGE_ID });
      assert.equal(result.evaluatedCount, 1);
      assert.equal(result.matchedCount, 1);
      assert.equal(result.skippedCount, 0);
      assert.equal(result.messages.length, 1);
      assert.equal(result.messages[0].entityId, STAGE_ID);
      assert.equal(result.messages[0].channel, "wecom_group");
      assert.equal(result.messages[0].template, "A08_GROUP");
      assert.equal(result.messages[0].recipient, "project.group");
      return "stage trial matched=1 / group message=1";
    });

    await check("R06 项目完成试运行：project.completed + project entityId 命中群消息", async () => {
      const rows = await db.select().from(automationRules).where(eq(automationRules.code, "R06"));
      assert.equal(rows.length, 1);
      assert.equal(rows[0].trigger.kind, "event");
      assert.equal(rows[0].trigger.topic, "project.completed");
      await service.patchRule(ADMIN_ID, "R06", { version: rows[0].version, enabled: true });
      const result = await service.testRule(ADMIN_ID, "R06", { businessDate: BUSINESS_DATE, entityId: PROJECT_ID });
      assert.equal(result.evaluatedCount, 1);
      assert.equal(result.matchedCount, 1);
      assert.equal(result.skippedCount, 0);
      assert.equal(result.messages.length, 1);
      assert.equal(result.messages[0].channel, "wecom_group");
      assert.equal(result.messages[0].template, "R06_GROUP");
      return "project.completed enabled then trial matched=1 / group message=1";
    });

    await check("事件型试运行缺 entityId：400，主体零读取", async () => {
      const before = await db.select({ value: sql`count(*)::int` }).from(automationRuns);
      await assert.rejects(
        () => service.testRule(ADMIN_ID, "A08", { businessDate: BUSINESS_DATE }),
        (error) => error?.code === "VALIDATION_FAILED" && error?.httpStatus === 400,
      );
      const after = await db.select({ value: sql`count(*)::int` }).from(automationRuns);
      assert.equal(Number(after[0].value), Number(before[0].value));
      return "400 / runs unchanged";
    });

    await check("调度型试运行：101 个任务截断为 100 主体，命中 100 / 消息 200", async () => {
      const result = await service.testRule(ADMIN_ID, "R05", { businessDate: BUSINESS_DATE });
      assert.equal(result.evaluatedCount, 100);
      assert.equal(result.matchedCount, 100);
      assert.equal(result.skippedCount, 0);
      assert.equal(result.truncated, true);
      assert.equal(result.messages.length, 200);
      return "evaluated=100 / matched=100 / messages=200 / truncated=true";
    });

    await check("试运行零副作用：automation_runs / outbox_events / audit_logs 零新增", async () => {
      const counts = async () => {
        const runCount = await db.select({ value: sql`count(*)::int` }).from(automationRuns);
        const outboxCount = await db.select({ value: sql`count(*)::int` }).from(outboxEvents);
        const auditCount = await db
          .select({ value: sql`count(*)::int` })
          .from(auditLogs)
          .where(eq(auditLogs.actorId, ADMIN_ID));
        return {
          runs: Number(runCount[0].value),
          outbox: Number(outboxCount[0].value),
          audits: Number(auditCount[0].value),
        };
      };
      const before = await counts();
      await service.testRule(ADMIN_ID, "R05", { businessDate: BUSINESS_DATE });
      await service.testRule(ADMIN_ID, "A08", { businessDate: BUSINESS_DATE, entityId: STAGE_ID });
      const after = await counts();
      assert.deepEqual(after, before);
      return "runs=" + before.runs + " / outbox=" + before.outbox + " / audit=" + before.audits;
    });

    await check("运行记录：真表插入 / list total / 详情 / 404", async () => {
      const keys = [RUN_PREFIX + "run-1", RUN_PREFIX + "run-2"];
      await runs.insertIfAbsent(db, [
        runInput(keys[0], 1),
        runInput(keys[1], 2),
      ]);
      const list = await service.listRuns(ADMIN_ID, { ruleCode: "R02", page: 1, limit: 20 });
      assert.ok(list.total >= 2);
      const item = list.items.find((row) => row.dedupeKey === keys[0]);
      assert.ok(item !== undefined);
      const detail = await service.getRun(ADMIN_ID, item.id);
      assert.equal(detail.dedupeKey, keys[0]);
      assert.equal(detail.ruleCode, "R02");
      await assert.rejects(() => service.getRun(ADMIN_ID, 999999999), (error) => error?.code === "NOT_FOUND");
      return "total=" + list.total + " / detail OK / missing = 404";
    });

    await check("审计与试运行隔离：试运行未新增审计，保存仅新增规则审计", async () => {
      const audits = await db
        .select({ objectType: auditLogs.objectType, action: auditLogs.action })
        .from(auditLogs)
        .where(eq(auditLogs.actorId, ADMIN_ID));
      assert.ok(audits.every((row) => row.objectType === "automation_rule" && row.action === "update"));
      const trialAudits = await db
        .select({ value: sql`count(*)::int` })
        .from(auditLogs)
        .where(and(eq(auditLogs.actorId, ADMIN_ID), like(auditLogs.summary, "%试运行%")));
      assert.equal(Number(trialAudits[0].value), 0);
      return "audit rows=" + audits.length + " / trial audits=0";
    });

    if (BASE_URL !== null) {
      await check("HTTP：管理员会话 GET rules / POST test 200，PATCH 旧 version 409，GET runs 200", async () => {
        seedOnly("roles");
        seedOnly("role-permissions");
        const roleRows = await db.select({ id: roles.id }).from(roles).where(eq(roles.code, "admin"));
        assert.equal(roleRows.length, 1);
        await db.insert(users).values({
          id: HTTP_ADMIN_ID,
          casdoorId: "replay-1b-http",
          username: "replay-1b-http",
          displayName: "回放 HTTP 管理员",
        });
        await db.insert(userRoles).values({ userId: HTTP_ADMIN_ID, roleId: roleRows[0].id });
        const now = new Date();
        await db.insert(sessions).values({
          tokenHash: createHash("sha256").update(HTTP_SESSION_TOKEN).digest("hex"),
          userId: HTTP_ADMIN_ID,
          idToken: "replay-1b-http",
          lastSeenAt: now,
          expiresAt: new Date(now.getTime() + 3_600_000),
        });
        const headers = {
          cookie: "ll_sid=" + HTTP_SESSION_TOKEN + "; ll_csrf=" + HTTP_CSRF_TOKEN,
          "x-csrf-token": HTTP_CSRF_TOKEN,
        };
        const list = await httpJson(BASE_URL, "/api/v1/automation/rules", { headers });
        assert.equal(list.status, 200);
        assert.equal(list.body.items.length, 10);
        const trial = await httpJson(BASE_URL, "/api/v1/automation/rules/A08/test", {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({ businessDate: BUSINESS_DATE, entityId: STAGE_ID }),
        });
        assert.equal(trial.status, 200);
        assert.equal(trial.body.matchedCount, 1);
        assert.equal(trial.body.messages.length, 1);
        const conflict = await httpJson(BASE_URL, "/api/v1/automation/rules/R02", {
          method: "PATCH",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({ version: 1, enabled: true }),
        });
        assert.equal(conflict.status, 409);
        assert.equal(conflict.body.code, "VERSION_CONFLICT");
        const runsList = await httpJson(BASE_URL, "/api/v1/automation/runs?page=1&limit=20", { headers });
        assert.equal(runsList.status, 200);
        assert.ok(runsList.body.total >= 2);
        return "GET rules 200 / POST test 200 / PATCH 409 / GET runs 200";
      });
    } else {
      console.log("http: 未提供 --base-url / M5_06_1B_BASE_URL，跳过 HTTP 断言");
    }
  } finally {
    if (!args.keep) {
      await cleanup(db, pool, originalRules, originalA01Job, auditBaseline);
    } else {
      console.log("keep: 保留夹具与变更（--keep）");
    }
    await pool.end();
  }

  console.log("\nM5-06-1B 回放：" + pass + " 通过 / " + fail + " 失败");
  if (args.json) {
    writeFileSync(
      args.json,
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          database: DATABASE_URL.replace(/:[^:@/]+@/, ":***@"),
          pass,
          fail,
          checks,
        },
        null,
        2,
      ),
      "utf8",
    );
    console.log("证据 JSON：" + args.json);
  }
  process.exitCode = fail === 0 ? 0 : 1;
}

function runInput(dedupeKey, id) {
  return {
    ruleCode: "R02",
    ruleVersion: 1,
    source: "event",
    topic: "task.completed",
    windowKey: "v5",
    entityType: "task",
    entityId: EVENT_TASK_ID,
    dedupeKey,
    status: "hit",
    skipReason: null,
    conditions: [],
    actions: [],
    messages: [],
    error: null,
  };
}

async function cleanup(db, pool, originalRules, originalA01Job, auditBaseline) {
  console.log("cleanup: 恢复规则 / job，删除夹具与回放留痕…");
  for (const [code, row] of originalRules) {
    await pool.query(
      `update automation_rules
          set enabled = $1, actions = $2::jsonb, version = $3, updated_by = $4, updated_at = $5::timestamptz
        where code = $6`,
      [row.enabled, JSON.stringify(row.actions), row.version, row.updatedBy, row.updatedAt, code],
    );
  }
  if (originalA01Job !== null) {
    await pool.query(
      `update jobs
          set payload = $1::jsonb, cron = $2, status = $3, run_at = $4::timestamptz, last_run_at = $5::timestamptz,
              attempts = $6, last_error = $7, locked_by = $8, locked_at = $9::timestamptz, updated_at = $10::timestamptz
        where dedupe_key = 'automation-schedule:A01'`,
      [
        JSON.stringify(originalA01Job.payload),
        originalA01Job.cron,
        originalA01Job.status,
        originalA01Job.runAt,
        originalA01Job.lastRunAt,
        originalA01Job.attempts,
        originalA01Job.lastError,
        originalA01Job.lockedBy,
        originalA01Job.lockedAt,
        originalA01Job.updatedAt,
      ],
    );
  } else {
    await db.delete(jobsTable).where(eq(jobsTable.dedupeKey, "automation-schedule:A01"));
  }
  await db.delete(auditLogs).where(and(eq(auditLogs.actorId, ADMIN_ID), eq(auditLogs.objectType, "automation_rule")));
  await db.delete(automationRuns).where(like(automationRuns.dedupeKey, RUN_PREFIX + "%"));
  await db.delete(wecomGroups).where(eq(wecomGroups.projectId, PROJECT_ID));
  await db.delete(tasks).where(eq(tasks.projectId, PROJECT_ID));
  await db.delete(projectStages).where(eq(projectStages.projectId, PROJECT_ID));
  await db.delete(projects).where(eq(projects.id, PROJECT_ID));
  await db.delete(users).where(eq(users.id, ADMIN_ID));
  await db.delete(users).where(eq(users.id, OWNER_ID));
  await db.delete(users).where(eq(users.id, MANAGER_ID));
  await db.delete(sessions).where(eq(sessions.userId, HTTP_ADMIN_ID));
  await db.delete(userRoles).where(eq(userRoles.userId, HTTP_ADMIN_ID));
  await db.delete(users).where(eq(users.id, HTTP_ADMIN_ID));

  const leftoverRuns = await db.select({ value: sql`count(*)::int` }).from(automationRuns).where(like(automationRuns.dedupeKey, RUN_PREFIX + "%"));
  const leftoverAudits = await db.select({ value: sql`count(*)::int` }).from(auditLogs).where(eq(auditLogs.actorId, ADMIN_ID));
  const leftoverProject = await db.select({ value: sql`count(*)::int` }).from(projects).where(eq(projects.id, PROJECT_ID));
  const leftoverUsers = await db.select({ value: sql`count(*)::int` }).from(users).where(eq(users.id, ADMIN_ID));
  assert.equal(Number(leftoverRuns[0].value), 0);
  assert.equal(Number(leftoverAudits[0].value), auditBaseline);
  assert.equal(Number(leftoverProject[0].value), 0);
  assert.equal(Number(leftoverUsers[0].value), 0);
  console.log("cleanup: 零残留（runs / audit / project / users）");
}

async function httpJson(baseUrl, path, init) {
  const response = await fetch(baseUrl.replace(/\/+$/, "") + path, init);
  const text = await response.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: response.status, body };
}

const schema = await import(pathToFileURL(join(SERVER_ROOT, "dist", "db", "schema", "index.js")).href);
const {
  automationRules,
  automationRuns,
  auditLogs,
  jobs: jobsTable,
  outboxEvents,
  projectStages,
  projects,
  roles,
  sessions,
  tasks,
  userRoles,
  users,
  wecomGroups,
} = schema;

await main();
