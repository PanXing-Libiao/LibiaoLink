#!/usr/bin/env node
/**
 * M5-06-1A 真机回放（Docker PG18 / 任意已迁移库）：
 *   证据一：0060 结构 + seed 基线 —— automation_rules 10 条、启用集 = R02 / R03 / R05；
 *           7 个 schedule job，启用规则 pending、停用规则 done；seed 二跑零插入 / 零更新。
 *   证据二：规则仓库 fail closed —— 空启用集返回 []（不回落 BUILTIN_RULES）；契约非法行整体抛错。
 *   证据三：automation_runs 真表 —— 唯一键去重、rule_id 回填、按 rule / entity 查询。
 *   证据四：事件接线真事务 —— R02 task.completed 产出 4 条 outbox + 1 条 run；重放零新增。
 *   证据五：调度接线真事务 —— R03 窗口产出 1 条 outbox + 1 条 run；同窗口重放零新增。
 *   证据六：job reconcile 真表 —— unchanged / disabled / reactivated / updated 四态。
 *   证据七：legacy 通用 job（dedupe_key = null）由 seed 置 done，不再并行空转。
 *   证据八：应用角色 libiaolink_api 可读写新表（default privileges 生效）。
 *
 * 前置：server/dist 已构建；目标库已迁移（或加 --migrate 让脚本先跑 0001~0060 + 规则 seed）。
 * 用法：cd server && node scripts/m5-06-1a-replay.mjs
 *       可选：--database-url <url> / --migrate / --json <证据.json> / --keep
 * 退出码：断言全过 = 0，否则 = 1。
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { eq, like } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = join(HERE, "..");
const REPO_ROOT = join(SERVER_ROOT, "..");
const args = parseArgs(process.argv.slice(2));
const DATABASE_URL =
  args.databaseUrl ??
  process.env.M5_06_1A_REPLAY_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql://libiaolink_migrator@127.0.0.1:55432/libiaolink_m5_06_1a";

const RUN_PREFIX = "replay:m5-06-1a:";
const NOW = new Date("2026-09-24T01:30:00.000Z"); // 上海 2026-09-24 09:30
const FROM = new Date("2026-09-23T01:00:00.000Z");
const TO = new Date("2026-09-24T01:15:00.000Z");

const checks = [];
let pass = 0;
let fail = 0;

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (item === "--database-url") out.databaseUrl = argv[++i];
    else if (item === "--json") out.json = argv[++i];
    else if (item === "--migrate") out.migrate = true;
    else if (item === "--keep") out.keep = true;
    else if (item === "--help" || item === "-h") {
      console.log("用法：node scripts/m5-06-1a-replay.mjs [--database-url <url>] [--migrate] [--json <path>] [--keep]");
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

function task(overrides = {}) {
  return {
    id: "t-replay-1A",
    title: "安装摄像头",
    version: 5,
    displayStatus: "active",
    urgency: "高",
    plannedStart: null,
    plannedEnd: null,
    actualStart: null,
    actualEnd: null,
    ownerId: "u-replay-owner",
    ownerName: "张三",
    managerId: "u-replay-manager",
    managerName: "李四",
    projectId: "p-replay-1A",
    projectCode: "LBUSA-20261020-001",
    projectName: "回放项目",
    projectProgress: 50,
    completedByName: "邵晨宇",
    deliverableTypes: ["施工方案"],
    fileCount: 0,
    ...overrides,
  };
}

function logger() {
  const lines = { log: [], warn: [], error: [] };
  return {
    lines,
    log: (message) => lines.log.push(message),
    warn: (message) => lines.warn.push(message),
    error: (message) => lines.error.push(message),
  };
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
  const seedTwice = seedAutomationRules();
  console.log(seedTwice.trim());

  const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 4 });
  const db = drizzle(pool, { schema });
  const modules = await import(pathToFileURL(join(SERVER_ROOT, "dist", "modules", "automation", "index.js")).href);
  const calendarModule = await import(pathToFileURL(join(SERVER_ROOT, "dist", "modules", "calendar", "index.js")).href);
  const wiring = await import(pathToFileURL(join(SERVER_ROOT, "dist", "outbox", "automation-wiring.js")).href);
  const jobsStoreModule = await import(pathToFileURL(join(SERVER_ROOT, "dist", "db", "jobs.store.js")).href);
  const rulesRepo = new modules.AutomationRuleRepository({ db });
  const runsRepo = new modules.AutomationRunRepository({ db });
  const jobsStore = new jobsStoreModule.JobsStore({ db });

  try {
    await db.delete(automationRuns).where(like(automationRuns.dedupeKey, RUN_PREFIX + "%"));

    await check("0060 基线：规则 10 条 / 启用集 R02·R03·R05 / schedule job 7 个", async () => {
      const rows = await db.select().from(automationRules).orderBy(automationRules.code);
      assert.equal(rows.length, 10);
      assert.deepEqual(rows.filter((row) => row.enabled).map((row) => row.code), ["R02", "R03", "R05"]);
      const jobRows = await db.select().from(jobs).where(eq(jobs.kind, "automation-schedule.job")).orderBy(jobs.dedupeKey);
      assert.equal(jobRows.length, 7);
      for (const rule of rows.filter((row) => row.trigger.kind === "schedule")) {
        const job = jobRows.find((item) => item.dedupeKey === "automation-schedule:" + rule.code);
        assert.ok(job, "缺 job：" + rule.code);
        assert.equal(job.status, rule.enabled ? "pending" : "done", rule.code + " job 状态");
      }
      return "rules=10 / scheduleJobs=7";
    });

    await check("seed 二跑零插入零更新", async () => {
      assert.match(seedTwice, /rulesInserted 0/);
      assert.match(seedTwice, /jobsInserted 0/);
      assert.match(seedTwice, /jobsUpdated 0/);
      assert.match(seedTwice, /jobsDisabled 0/);
      return "第二次执行 rulesUnchanged 10 / jobsUnchanged 7";
    });

    await check("规则仓库：启用集读表 / 空集不回落 / 非法行 fail closed", async () => {
      const enabled = await rulesRepo.listEnabledRules(db);
      assert.deepEqual(enabled.map((rule) => rule.code), ["R02", "R03", "R05"]);
      await db.update(automationRules).set({ deletedAt: NOW }).where(eq(automationRules.code, "R05"));
      try {
        assert.deepEqual((await rulesRepo.listEnabledRules(db)).map((rule) => rule.code), ["R02", "R03"]);
      } finally {
        await db.update(automationRules).set({ deletedAt: null }).where(eq(automationRules.code, "R05"));
      }
      await db.update(automationRules).set({ enabled: false });
      try {
        assert.deepEqual(await rulesRepo.listEnabledRules(db), []);
      } finally {
        await db
          .update(automationRules)
          .set({ enabled: true })
          .where(eq(automationRules.code, "R02"));
        await db.update(automationRules).set({ enabled: true }).where(eq(automationRules.code, "R03"));
        await db.update(automationRules).set({ enabled: true }).where(eq(automationRules.code, "R05"));
      }
      const original = await db.select().from(automationRules).where(eq(automationRules.code, "R02")).limit(1);
      await db.update(automationRules).set({ trigger: { kind: "bogus" } }).where(eq(automationRules.code, "R02"));
      try {
        await assert.rejects(() => rulesRepo.listEnabledRules(db), /R02/);
      } finally {
        await db.update(automationRules).set({ trigger: original[0].trigger }).where(eq(automationRules.code, "R02"));
      }
      return "enabled=3 / softDeleted=excluded / empty=[] / invalid throws";
    });

    await check("automation_runs：唯一键去重 / rule_id 回填 / 查询", async () => {
      const key = RUN_PREFIX + "repo:" + randomUUID();
      const input = {
        ruleCode: "R02",
        ruleVersion: 1,
        source: "event",
        topic: "task.completed",
        windowKey: "v5",
        entityType: "task",
        entityId: "t-replay-repo",
        dedupeKey: key,
        status: "hit",
        skipReason: null,
        conditions: [],
        actions: [],
        messages: [],
        error: null,
      };
      const first = await runsRepo.insertIfAbsent(db, [input]);
      assert.ok(first.has(key));
      assert.equal((await runsRepo.insertIfAbsent(db, [input])).size, 0);
      const listed = await runsRepo.list({ ruleCode: "R02", entityId: "t-replay-repo" }, db);
      assert.equal(listed.length, 1);
      assert.ok(listed[0].ruleId);
      return "insert=1 / duplicate=0 / ruleId=" + listed[0].ruleId;
    });

    const depsForWiring = (collect) => ({
      env: { AUTOMATION_EVENT_MAX_AGE_MS: 6 * 3_600_000 },
      subjects: {
        eventSubject: async () => modules.toTaskSubject(task({ displayStatus: "done" })),
        loadWindow: async () => ({
          subjects: [modules.toTaskSubject(task({ plannedEnd: "2026-09-25" }))],
          calendar: calendarModule.calendarWindow("2026-09-01", "2026-09-30", []),
        }),
      },
      append: async (_client, event) => collect.push(event),
      db,
      rules: (client) => rulesRepo.listEnabledRules(client),
      runs: runsRepo,
      transaction: (work) => db.transaction(work),
      now: () => NOW,
      shift: async () => ({ reminderShiftEnabled: false, shiftDirection: "forward" }),
      logger: logger(),
    });

    await check("事件接线真事务：R02 产出 4 条 outbox + 1 条 run；重放零新增", async () => {
      const appended = [];
      const deps = depsForWiring(appended);
      const eventKey = RUN_PREFIX + "event:" + randomUUID();
      const consumer = wiring.createRuleEventConsumers(deps).get("task.completed");
      const row = {
        id: 900001,
        topic: "task.completed",
        payload: { taskId: "t-replay-1A" },
        dedupeKey: eventKey,
        attempts: 0,
        availableAt: NOW,
        lockedAt: NOW,
        createdAt: NOW,
      };
      assert.deepEqual(await consumer.handle(row), { outcome: "done" });
      assert.equal(appended.length, 4);
      const dedupeKey = "event:" + eventKey + ":R02:t-replay-1A";
      const runRows = await runsRepo.list({ ruleCode: "R02", entityId: "t-replay-1A" }, db);
      assert.equal(runRows.length, 1);
      assert.equal(runRows[0].dedupeKey, dedupeKey);
      assert.equal(runRows[0].status, "hit");
      assert.equal(runRows[0].messages.length, 4);
      assert.deepEqual(await consumer.handle(row), { outcome: "done" });
      assert.equal(appended.length, 4);
      assert.equal((await runsRepo.list({ ruleCode: "R02", entityId: "t-replay-1A" }, db)).length, 1);
      await db.delete(automationRuns).where(eq(automationRuns.dedupeKey, dedupeKey));
      return "append=4 / run=1 / replay=0";
    });

    await check("调度接线真事务：R03 产出 1 条 outbox + 1 条 run；同窗口重放零新增", async () => {
      const appended = [];
      const deps = depsForWiring(appended);
      const handler = wiring.createAutomationScheduleHandler(deps);
      const job = {
        id: 900002,
        kind: "automation-schedule.job",
        payload: { ruleCode: "R03", ruleVersion: 1 },
        cron: "0 8 * * *",
        runAt: TO,
        lastRunAt: FROM,
        status: "processing",
        attempts: 0,
        lastError: null,
        lockedBy: "m5-06-1a-replay",
        lockedAt: NOW,
        dedupeKey: "automation-schedule:R03",
      };
      const context = { job, windowFrom: FROM, windowTo: TO, fireTimes: [], tx: null };
      await db.transaction(async (tx) => handler.run({ ...context, tx }));
      assert.equal(appended.length, 1);
      const dedupeKey = "schedule:R03:t-replay-1A:2026-09-24";
      const runRows = await runsRepo.list({ ruleCode: "R03", entityId: "t-replay-1A" }, db);
      assert.equal(runRows.length, 1);
      assert.equal(runRows[0].dedupeKey, dedupeKey);
      assert.equal(runRows[0].status, "hit");
      assert.equal(runRows[0].messages.length, 1);
      await db.transaction(async (tx) => handler.run({ ...context, tx }));
      assert.equal(appended.length, 1);
      assert.equal((await runsRepo.list({ ruleCode: "R03", entityId: "t-replay-1A" }, db)).length, 1);
      await db.delete(automationRuns).where(eq(automationRuns.dedupeKey, dedupeKey));
      return "append=1 / run=1 / replay=0";
    });

    await check("job reconcile：unchanged / disabled / reactivated / updated", async () => {
      const input = { ruleCode: "R03", ruleVersion: 1, cron: "0 8 * * *", enabled: true, now: NOW };
      assert.equal(await jobsStore.reconcileAutomationScheduleJob(db, input), "unchanged");
      assert.equal(await jobsStore.reconcileAutomationScheduleJob(db, { ...input, enabled: false }), "disabled");
      let rows = await db.select().from(jobs).where(eq(jobs.dedupeKey, "automation-schedule:R03"));
      assert.equal(rows[0].status, "done");
      assert.equal(await jobsStore.reconcileAutomationScheduleJob(db, input), "reactivated");
      rows = await db.select().from(jobs).where(eq(jobs.dedupeKey, "automation-schedule:R03"));
      assert.equal(rows[0].status, "pending");
      assert.equal(await jobsStore.reconcileAutomationScheduleJob(db, { ...input, ruleVersion: 2 }), "updated");
      assert.equal(await jobsStore.reconcileAutomationScheduleJob(db, input), "updated");
      return "4 outcomes / final payload version=1";
    });

    await check("jobs.dedupe_key 唯一约束：同规则第二个 job 被拒绝", async () => {
      await assert.rejects(
        () =>
          pool.query(
            `insert into jobs (kind, payload, cron, run_at, last_run_at, status, dedupe_key)
             values ('automation-schedule.job', '{}'::jsonb, '0 8 * * *', now(), now(), 'pending', 'automation-schedule:R03')`,
          ),
        (error) => error?.code === "23505",
      );
      return "SQLSTATE 23505";
    });

    await check("legacy 通用 job：seed 置 done，保留行", async () => {
      const inserted = await db
        .insert(jobs)
        .values({
          kind: "automation-schedule.job",
          payload: {},
          cron: "0 9 * * *",
          runAt: NOW,
          lastRunAt: FROM,
          status: "pending",
          dedupeKey: null,
        })
        .returning({ id: jobs.id });
      try {
        const output = seedAutomationRules();
        assert.match(output, /legacyJobsRetired 1/);
        const rows = await db.select().from(jobs).where(eq(jobs.id, inserted[0].id));
        assert.equal(rows[0].status, "done");
      } finally {
        await db.delete(jobs).where(eq(jobs.id, inserted[0].id));
      }
      return "legacyJobsRetired=1";
    });

    await check("应用角色 libiaolink_api 可读写新表（default privileges）", async () => {
      const appUrl = new URL(DATABASE_URL);
      appUrl.username = "libiaolink_api";
      appUrl.password = "";
      const appPool = new pg.Pool({ connectionString: appUrl.toString(), max: 1 });
      try {
        const key = RUN_PREFIX + "app:" + randomUUID();
        await appPool.query(
          `insert into automation_runs (rule_code, rule_version, source, topic, dedupe_key, status)
           values ('R02', 1, 'event', 'task.completed', $1, 'hit')`,
          [key],
        );
        const read = await appPool.query("select dedupe_key from automation_runs where dedupe_key = $1", [key]);
        assert.equal(read.rowCount, 1);
        await appPool.query("delete from automation_runs where dedupe_key = $1", [key]);
      } finally {
        await appPool.end();
      }
      return "insert / select / delete OK";
    });
  } finally {
    if (!args.keep) {
      await db.delete(automationRuns).where(like(automationRuns.dedupeKey, RUN_PREFIX + "%"));
    }
    await pool.end();
  }

  console.log("\nM5-06-1A 回放：" + pass + " 通过 / " + fail + " 失败");
  if (args.json) {
    writeFileSync(
      args.json,
      JSON.stringify({ generatedAt: new Date().toISOString(), database: DATABASE_URL.replace(/:[^:@/]+@/, ":***@"), pass, fail, checks }, null, 2),
      "utf8",
    );
    console.log("证据 JSON：" + args.json);
  }
  process.exitCode = fail === 0 ? 0 : 1;
}

const schema = await import(pathToFileURL(join(SERVER_ROOT, "dist", "db", "schema", "index.js")).href);
const { automationRules, automationRuns } = schema;
const { jobs } = await import(pathToFileURL(join(SERVER_ROOT, "dist", "db", "schema", "platform.js")).href);

await main();
