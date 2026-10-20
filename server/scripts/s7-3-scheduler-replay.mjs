#!/usr/bin/env node
/**
 * S7-3 · i11 真机回放（M5-02 · 调度 / 补发 / 幂等执行键 / 状态回退再生窗口）：
 *   证据一（单活调度）：两个 JobsStore 实例争同一 advisory lock（OUTBOX_SCHEDULER.lockName）——先到者得、
 *        后到者 null、释放后可再取（会话级锁，进程崩溃随连接释放）。
 *   证据二（cron 补发）：真 JobScheduler tick 领取 jobs 行，窗口 (run_at-1ms, now] 枚举触发时刻；产出
 *        （appendOutboxIfAbsent，同事务）与 last_run_at / run_at 推进一起提交；窗口推进后同 tick 不重复领取。
 *   证据三（超跨度 skipped）：错过窗口超 OUTBOX_SCHEDULER_CATCHUP_MAX_DAYS，窗口收窄到上限处，
 *        超出区间只记 job_runs.skipped 留痕（不补发轰炸）。
 *   证据四（杀 worker 不丢 / 崩溃重领 / 重放不重发）：子进程真领取（claimDue）后被 SIGKILL —— 行留 locked_at；
 *        同窗内不重领；回拨 locked_at 超窗后重领并执行恰好一次；同一窗口人工重放 —— 幂等执行键兜底不重发。
 *   证据五（状态回退再生窗口）：state_version 窗口 —— 同版本重放不新增、版本推进（回退后再次进入触发态）
 *        生成新键可再投；日期窗口 —— 同日不重发、次日新键可再投（两类键并存是刻意的，契约 OUTBOX_WINDOW_KINDS）。
 *   证据六（失败重试到顶）：调度任务失败 attempts 累计；到 OUTBOX_SCHEDULER_MAX_ATTEMPTS 置 jobs.status=failed
 *        （重试死信，人工复位后继续），之后不再领取。
 *   证据七（双实例并发）：两实例并发 tick 同一批到期任务 —— 只有一个执行（单活锁 + SKIP LOCKED），产出无重复。
 *   证据八（每轮窗口上限 · 水位不越过）：OUTBOX_SCHEDULER_MAX_WINDOWS_PER_TICK=3 —— 触顶轮 last_run_at 停在
 *        本轮最后处理的窗口（不越过未处理窗口）且 run_at=now 下轮顺延；跨轮追平后 last_run_at=now、run_at=下一触发。
 *
 * 前置：真 PG（迁移器角色即可）+ 已构建的 server/dist（cd server && npm run build）。
 * 用法：cd server && S7_3_DATABASE_URL=postgresql://libiaolink_migrator@127.0.0.1:55432/libiaolink \
 *       node --env-file-if-exists=.env scripts/s7-3-scheduler-replay.mjs [--out <报告.md>] [--json <证据.json>] [--keep]
 * 退出码：断言全过 = 0，否则 = 1（可当门禁用）。
 * 说明：本机无 PG 时只做语法门禁；真机证据以 CI database job 为准（不伪造）。合成 kind / 去重键前缀独立，
 *   全部产出取契约白名单主题 notify.message（回放环境不启动消费侧 → 稳定留在 pending）→ 不干扰生产领取侧；
 *   开跑前把非本回放 pending job 临时推到远期（保留原行），finally 恢复原 run_at，避免 seed 规则 job 混入领取统计。
 */
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { OUTBOX_SCHEDULER } from "@libiaolink/contracts";

const HERE = dirname(fileURLToPath(import.meta.url));
const args = parseArgs(process.argv.slice(2));
const DATABASE_URL =
  args.databaseUrl ?? process.env.S7_3_DATABASE_URL ?? process.env.DATABASE_URL ?? "postgresql://libiaolink_migrator@127.0.0.1:55432/libiaolink";

/** 本回放全部合成 kind / 去重键前缀（清理 / 计数用）：证据专用，不落生产代码。 */
const KIND_PREFIX = "s73replay.";
const DEDUPE_PREFIX = "s73Replay";
/** 产出行的主题：契约白名单主题 notify.message（回放环境不启动消费侧；领取侧不注册 → 稳定留在 pending）。 */
const PRODUCED_TOPIC = "notify.message";
/** OUTBOX_STALE_MS 的 env 下限（60000）；CI 不等满窗口，用「回拨 locked_at」等价模拟崩溃超窗。 */
const STALE_MS = 60_000;
const MAX_ATTEMPTS = 2;
const CATCHUP_MAX_DAYS = 7;
const MAX_WINDOWS_PER_TICK = 3;
const CRASH_WORKER = "s73-crashed-worker";
const MAIN_WORKER = "s73-main";
const DAY_MS = 86_400_000;

/** 时间锚点：runAt = 当前分钟整（UTC 分钟边界 = 上海分钟边界；ADR-028 固定 +8 无夏令时）。 */
const runAt = new Date(Math.floor(Date.now() / 60_000) * 60_000);
const shanghaiWall = new Date(runAt.getTime() + 8 * 3_600_000);
/** cron 与 runAt 对齐（每天同一分钟触发）→ 触发时刻集合与脚本运行时刻无关，可确定性断言。 */
const cron = shanghaiWall.getUTCMinutes() + " " + shanghaiWall.getUTCHours() + " * * *";
/** 固定时钟：全部窗口求值以它为 now（真调度器经 ClockService 注入；生产禁止直接取系统时间）。 */
const clockNow = new Date(runAt.getTime() + 2 * DAY_MS + 30_000);
const dayOf = (offset) => new Date(runAt.getTime() + offset * DAY_MS);
const businessDateOf = (date) => new Date(date.getTime() + 8 * 3_600_000).toISOString().slice(0, 10);

const report = [];
const evidence = { anchors: {}, checks: [] };
let failures = 0;
let assertionThrown = false;
let runtime;

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (item === "--out") out.out = argv[++i];
    else if (item === "--json") out.json = argv[++i];
    else if (item === "--database-url") out.databaseUrl = argv[++i];
    else if (item === "--child-claim") out.childClaim = true;
    else if (item === "--keep") out.keep = true;
  }
  return out;
}

function note(line) {
  report.push(line);
  process.stdout.write(line + "\n");
}

function check(id, title, expected, actual, ok) {
  if (!ok) failures += 1;
  note("| " + (ok ? "PASS" : "FAIL") + " | " + id + " | " + title + " | 期望：" + expected + " | 实际：" + actual + " |");
  evidence.checks.push({ id, title, expected, actual, ok });
  if (!ok) {
    assertionThrown = true;
    throw new Error("S7-3 断言失败（" + id + "）：" + title);
  }
}

function short(value, max = 300) {
  const text = JSON.stringify(value);
  return text === undefined ? "undefined" : text.length > max ? text.slice(0, max) + "..." : text;
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

function fmtJob(row) {
  if (row === null || row === undefined) return "（行不存在）";
  return (
    "status=" + row.status + " / attempts=" + row.attempts + " / locked_by=" + (row.locked_by ?? "null") +
    " / locked_at=" + (row.locked_at === null ? "null" : "非空") +
    " / last_run_at=" + (row.last_run_at === null ? "null" : new Date(row.last_run_at).toISOString())
  );
}

/** 加载 dist（真运行时类）；缺构建时给出明确指引。 */
async function loadRuntime() {
  await import("reflect-metadata");
  const load = (relative) => import(pathToFileURL(join(HERE, "..", "dist", relative)).href);
  try {
    const [envModule, configModule, databaseModule, jobsStoreModule, outboxModule, schedulerModule, clockModule] =
      await Promise.all([
        load("config/env.js"),
        load("config/config.module.js"),
        load("db/database.service.js"),
        load("db/jobs.store.js"),
        load("db/outbox.js"),
        load("outbox/scheduler.js"),
        load("common/clock/clock.service.js"),
      ]);
    return {
      loadEnv: envModule.loadEnv,
      AppConfig: configModule.AppConfig,
      DatabaseService: databaseModule.DatabaseService,
      JobsStore: jobsStoreModule.JobsStore,
      appendOutboxIfAbsent: outboxModule.appendOutboxIfAbsent,
      JobScheduler: schedulerModule.JobScheduler,
      ClockService: clockModule.ClockService,
    };
  } catch (error) {
    process.stderr.write("S7-3：无法加载 server/dist（先执行 cd server && npm run build）：" + String(error) + "\n");
    process.exit(1);
  }
}

/** 回放环境：只覆盖本证据需要收紧的口径（其余沿默认）。 */
function buildEnv(overrides = {}) {
  return runtime.loadEnv({
    ...process.env,
    DATABASE_URL,
    // 环境契约：OUTBOX_STALE_MS >= PREVIEW_CONVERT_TIMEOUT_MS；本回放取两个下限档（1s / 60s）。
    PREVIEW_CONVERT_TIMEOUT_MS: "1000",
    OUTBOX_STALE_MS: String(STALE_MS),
    OUTBOX_SCHEDULER_BATCH_LIMIT: "10",
    OUTBOX_SCHEDULER_MAX_ATTEMPTS: String(MAX_ATTEMPTS),
    OUTBOX_SCHEDULER_CATCHUP_MAX_DAYS: String(CATCHUP_MAX_DAYS),
    OUTBOX_SCHEDULER_MAX_WINDOWS_PER_TICK: "50",
    ...overrides,
  });
}

/** 子进程模式：真领取一行后挂起，等父进程 SIGKILL（= worker 崩溃，finishRun 永不发生）。 */
async function runChildClaim() {
  const env = buildEnv({ WORKER_ID: CRASH_WORKER });
  const config = new runtime.AppConfig(env);
  const db = new runtime.DatabaseService(config);
  const store = new runtime.JobsStore(db);
  const rows = await store.claimDue({ limit: 1, staleAfterMs: STALE_MS, workerId: CRASH_WORKER });
  process.stdout.write(
    "S73_CLAIMED " + JSON.stringify({ id: rows.length > 0 ? rows[0].id : null, workerId: CRASH_WORKER }) + "\n",
  );
  await new Promise(() => {});
}

/** 起子进程 → 等领取回执 → SIGKILL → 收退出码 / 信号。 */
async function spawnCrashedWorker() {
  const child = spawn(
    process.execPath,
    [fileURLToPath(import.meta.url), "--child-claim", "--database-url", DATABASE_URL],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const deadline = Date.now() + 30_000;
  while (!stdout.includes("\n") && child.exitCode === null && child.signalCode === null && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (!stdout.includes("\n")) {
    child.kill("SIGKILL");
    throw new Error("子进程未在 30s 内完成领取（stderr 尾部：" + stderr.slice(-300) + "）");
  }
  const line = stdout.split("\n")[0];
  if (!line.startsWith("S73_CLAIMED ")) {
    child.kill("SIGKILL");
    throw new Error("子进程输出非法：" + line);
  }
  const claimed = JSON.parse(line.slice("S73_CLAIMED ".length));
  if (child.exitCode !== null || child.signalCode !== null) {
    return { claimed, exitCode: child.exitCode, exitSignal: child.signalCode, pid: child.pid, stderr };
  }
  child.kill("SIGKILL");
  const [exitCode, exitSignal] = await once(child, "exit");
  return { claimed, exitCode, exitSignal, pid: child.pid, stderr };
}

async function runMain() {
  const env = buildEnv({ WORKER_ID: MAIN_WORKER });
  const config = new runtime.AppConfig(env);
  const db = new runtime.DatabaseService(config);
  const dbB = new runtime.DatabaseService(new runtime.AppConfig(buildEnv({ WORKER_ID: MAIN_WORKER + "-b" })));
  const store = new runtime.JobsStore(db);
  const storeB = new runtime.JobsStore(dbB);
  const clock = new runtime.ClockService();
  clock.setSource(() => clockNow);
  const tag = randomBytes(4).toString("hex");
  const kinds = {
    catchup: KIND_PREFIX + "catchup",
    skip: KIND_PREFIX + "skip",
    kill: KIND_PREFIX + "kill",
    failure: KIND_PREFIX + "failure",
    single: KIND_PREFIX + "single",
    capped: KIND_PREFIX + "capped",
  };
  const runs = [];
  /** 非本回放 pending job 的原值（测试期间临时推到远期，finally 恢复）。 */
  const parkedJobs = [];
  const makeHandler = (kind, behavior) => ({
    run: async (context) => {
      runs.push({
        kind,
        jobId: context.job.id,
        windowFrom: context.windowFrom.toISOString(),
        windowTo: context.windowTo.toISOString(),
        fires: context.fireTimes.map((time) => time.toISOString()),
      });
      if (behavior === "fail") {
        throw new Error("s7-3 回放：处理器失败（重试到顶验证）");
      }
      for (const fire of context.fireTimes) {
        await runtime.appendOutboxIfAbsent(context.tx, {
          topic: PRODUCED_TOPIC,
          payload: { replay: "s7-3", kind, fire: fire.toISOString(), tag },
          dedupeKey: DEDUPE_PREFIX + "." + kind + ":" + tag + ":f" + fire.getTime(),
        });
      }
      return { produced: context.fireTimes.length };
    },
  });
  const handlers = new Map([
    [kinds.catchup, makeHandler(kinds.catchup, "ok")],
    [kinds.skip, makeHandler(kinds.skip, "ok")],
    [kinds.kill, makeHandler(kinds.kill, "ok")],
    [kinds.failure, makeHandler(kinds.failure, "fail")],
    [kinds.single, makeHandler(kinds.single, "ok")],
    [kinds.capped, makeHandler(kinds.capped, "ok")],
  ]);
  const scheduler = new runtime.JobScheduler(db, store, handlers, clock, config);
  const schedulerB = new runtime.JobScheduler(dbB, storeB, handlers, clock, config);
  const schedulerCap = new runtime.JobScheduler(
    db,
    store,
    handlers,
    clock,
    new runtime.AppConfig(
      buildEnv({ WORKER_ID: MAIN_WORKER + "-cap", OUTBOX_SCHEDULER_MAX_WINDOWS_PER_TICK: String(MAX_WINDOWS_PER_TICK) }),
    ),
  );

  const insertJob = async (kind, options) => {
    const result = await db.pool.query(
      "insert into jobs (kind, payload, cron, run_at, last_run_at) values ($1, $2::jsonb, $3, $4, $5) returning id",
      [kind, JSON.stringify({ tag }), options.cron ?? cron, options.runAt, options.lastRunAt ?? null],
    );
    return Number(result.rows[0].id);
  };
  const jobRow = async (id) => {
    const result = await db.pool.query(
      "select id, kind, cron, run_at, last_run_at, status, attempts, last_error, locked_by, locked_at from jobs where id = $1",
      [id],
    );
    return result.rows[0] ?? null;
  };
  const jobRuns = async (id) => {
    const result = await db.pool.query(
      "select status, window_from, window_to, fire_count, produced, note from job_runs where job_id = $1 order by id",
      [id],
    );
    return result.rows;
  };
  const outboxCount = async (pattern) => {
    const result = await db.pool.query("select count(*)::int as n from outbox_events where dedupe_key like $1", [pattern]);
    return result.rows[0].n;
  };
  const countKey = async (dedupeKey) => {
    const result = await db.pool.query("select count(*)::int as n from outbox_events where dedupe_key = $1", [dedupeKey]);
    return result.rows[0].n;
  };
  const parkUnrelatedPendingJobs = async () => {
    const found = await db.pool.query(
      "select id, run_at::text as run_at, updated_at::text as updated_at from jobs where status = 'pending' and kind not like $1 order by id",
      [KIND_PREFIX + "%"],
    );
    parkedJobs.push(...found.rows);
    if (found.rows.length > 0) {
      await db.pool.query(
        "update jobs set run_at = now() + interval '100 years', updated_at = now() where id = any($1::bigint[])",
        [found.rows.map((row) => row.id)],
      );
      note("| PARK | 暂避非本回放 pending jobs " + found.rows.length + " 条（finally 恢复原 run_at） |");
    }
  };
  const restoreParkedJobs = async () => {
    if (parkedJobs.length > 0) {
      await db.pool.query(
        "update jobs as j set run_at = v.run_at, updated_at = v.updated_at " +
          "from unnest($1::bigint[], $2::timestamptz[], $3::timestamptz[]) as v(id, run_at, updated_at) " +
          "where j.id = v.id",
        [parkedJobs.map((row) => row.id), parkedJobs.map((row) => row.run_at), parkedJobs.map((row) => row.updated_at)],
      );
      note("| RESTORE | 已恢复非本回放 pending jobs " + parkedJobs.length + " 条 |");
    }
  };

  evidence.anchors = {
    tag,
    cron,
    runAt: runAt.toISOString(),
    clockNow: clockNow.toISOString(),
    staleMs: STALE_MS,
    catchupMaxDays: CATCHUP_MAX_DAYS,
    maxWindowsPerTick: MAX_WINDOWS_PER_TICK,
    maxAttempts: MAX_ATTEMPTS,
    lockName: OUTBOX_SCHEDULER.lockName,
  };

  try {
    // ---------------------------------------------------------------- 基线
    const baselineJobs = await db.pool.query("select count(*)::int as n from jobs where kind like $1", [KIND_PREFIX + "%"]);
    const baselineOutbox = await outboxCount(DEDUPE_PREFIX + "%");
    check(
      "S0",
      "基线：本脚本 kind / 去重键前缀无存量行（回放自清理）",
      "jobs=0 / outbox=0",
      "jobs=" + baselineJobs.rows[0].n + " / outbox=" + baselineOutbox,
      baselineJobs.rows[0].n === 0 && baselineOutbox === 0,
    );
    await parkUnrelatedPendingJobs();

    // --------------------------------------------- 证据一：单活 advisory lock
    const lockA = await store.tryAdvisoryLock(OUTBOX_SCHEDULER.lockName);
    check("S1a", "单活锁：实例 A 取得（pg_try_advisory_lock(hashtext(锁名))）", "非 null", lockA === null ? "null" : "已取得", lockA !== null);
    const lockB = await storeB.tryAdvisoryLock(OUTBOX_SCHEDULER.lockName);
    check("S1b", "单活锁：实例 B 同刻拿不到（null）—— 同刻只允许一个调度器", "null", lockB === null ? "null" : "意外取得", lockB === null);
    await lockA.release();
    const lockB2 = await storeB.tryAdvisoryLock(OUTBOX_SCHEDULER.lockName);
    check("S1c", "单活锁：释放后可再取（会话级锁随 release / 断连自动释放）", "非 null", lockB2 === null ? "null" : "已取得", lockB2 !== null);
    if (lockB2 !== null) await lockB2.release();

    // ------------------------------------------------ 证据二：cron 补发与推进
    const jobCatchup = await insertJob(kinds.catchup, { runAt, lastRunAt: null });
    const statsCatchup = await scheduler.tickOnce();
    const catchupRuns = runs.filter((item) => item.kind === kinds.catchup);
    const expectedFires = [dayOf(0), dayOf(1), dayOf(2)].map((date) => date.toISOString());
    check(
      "S2a",
      "cron 补发：领取并执行 1 条（单活锁 + SKIP LOCKED）",
      "claimed=1 / executed=1 / produced=3",
      "stats=" + short(statsCatchup),
      statsCatchup.claimed === 1 && statsCatchup.executed === 1 && statsCatchup.produced === 3,
    );
    check(
      "S2b",
      "窗口 (run_at-1ms, now]：首触发 run_at 与其后两次全部命中（3 次触发无遗漏）",
      expectedFires.join(" / "),
      catchupRuns.length === 1 ? catchupRuns[0].fires.join(" / ") : "(未执行或重复执行 " + catchupRuns.length + " 次)",
      catchupRuns.length === 1 && catchupRuns[0].fires.join(",") === expectedFires.join(","),
    );
    const catchupRow = await jobRow(jobCatchup);
    check(
      "S2c",
      "产出与推进同事务：last_run_at = now / run_at 推进到下一触发 / locked_at 清空",
      "pending / last_run_at=" + clockNow.toISOString() + " / run_at=" + dayOf(3).toISOString() + " / locked_at=null",
      fmtJob(catchupRow) + " / run_at=" + new Date(catchupRow.run_at).toISOString(),
      catchupRow.status === "pending" &&
        catchupRow.locked_at === null &&
        new Date(catchupRow.last_run_at).getTime() === clockNow.getTime() &&
        new Date(catchupRow.run_at).getTime() === dayOf(3).getTime(),
    );
    const catchupRunRows = await jobRuns(jobCatchup);
    check(
      "S2d",
      "job_runs 留痕：executed / fire_count=3 / produced=3 / 窗口 (run_at-1ms, now] 落库",
      "1 行 executed · fire_count=3 · produced=3 · window_from=run_at-1ms",
      short(catchupRunRows.map((row) => ({ status: row.status, fire: row.fire_count, produced: row.produced }))),
      catchupRunRows.length === 1 &&
        catchupRunRows[0].status === "executed" &&
        Number(catchupRunRows[0].fire_count) === 3 &&
        Number(catchupRunRows[0].produced) === 3 &&
        new Date(catchupRunRows[0].window_from).getTime() === runAt.getTime() - 1,
    );
    const catchupOutbox = await outboxCount(DEDUPE_PREFIX + "." + kinds.catchup + ":" + tag + ":%");
    check("S2e", "产出落库：3 条 notify.message（幂等执行键含触发时刻段）", "3 行", catchupOutbox + " 行", catchupOutbox === 3);
    const statsCatchup2 = await scheduler.tickOnce();
    check(
      "S2f",
      "重复领取不重发：窗口已推进 / 任务未到期 —— 第二轮 tick 领取 0 条",
      "claimed=0 / executed=0",
      "stats=" + short(statsCatchup2),
      statsCatchup2.claimed === 0 && statsCatchup2.executed === 0,
    );

    // --------------------------------------------- 证据三：超补发跨度 skipped
    const jobSkip = await insertJob(kinds.skip, { runAt: dayOf(-10), lastRunAt: null });
    const statsSkip = await scheduler.tickOnce();
    const skipRuns = runs.filter((item) => item.kind === kinds.skip);
    const skipExpectedFires = [-4, -3, -2, -1, 0, 1, 2].map((offset) => dayOf(offset).toISOString());
    check(
      "S3a",
      "超跨度裁剪：窗口收窄到 now-7d —— 触发 7 次（day-4 ~ day+2），更早 6 次不补发",
      "executed=1 / produced=7 / fires=" + skipExpectedFires.length + " 个",
      "stats=" + short(statsSkip) + " / fires=" + (skipRuns[0]?.fires.length ?? -1) + " 个",
      statsSkip.executed === 1 &&
        skipRuns.length === 1 &&
        skipRuns[0].fires.join(",") === skipExpectedFires.join(",") &&
        statsSkip.produced === 7,
    );
    const skipRunRows = await jobRuns(jobSkip);
    const skipExecuted = skipRunRows.find((row) => row.status === "executed");
    const skipSkipped = skipRunRows.find((row) => row.status === "skipped");
    check(
      "S3b",
      "job_runs 留痕：executed（窗口 = 上限处起）+ skipped（超出区间 (run_at-1ms, now-7d] 只记不补）",
      "executed.window_from=now-7d / skipped.window=(run_at-1ms, now-7d] / note 含「补发跨度上限」",
      short(skipRunRows.map((row) => ({ status: row.status, from: row.window_from, to: row.window_to }))),
      skipExecuted !== undefined &&
        skipSkipped !== undefined &&
        new Date(skipExecuted.window_from).getTime() === clockNow.getTime() - CATCHUP_MAX_DAYS * DAY_MS &&
        new Date(skipSkipped.window_from).getTime() === dayOf(-10).getTime() - 1 &&
        new Date(skipSkipped.window_to).getTime() === clockNow.getTime() - CATCHUP_MAX_DAYS * DAY_MS &&
        String(skipSkipped.note ?? "").includes("补发跨度上限"),
    );

    // ------------------------- 证据四：杀 worker 不丢 / 崩溃重领 / 重放不重发
    const jobKill = await insertJob(kinds.kill, { runAt, lastRunAt: null });
    const crashed = await spawnCrashedWorker();
    const killRow1 = await jobRow(jobKill);
    check(
      "S4a",
      "杀 worker 不丢：子进程真领取（claimDue）后被 SIGKILL —— 行留 locked_by / locked_at 留痕、未丢",
      "子进程 signal=SIGKILL / claimed.id=" + jobKill + " / locked_by=" + CRASH_WORKER + " / locked_at 非空",
      "child pid=" + crashed.pid + " code=" + crashed.exitCode + " signal=" + crashed.exitSignal + " / claimed.id=" + crashed.claimed.id + " / " + fmtJob(killRow1),
      String(crashed.claimed.id) === String(jobKill) &&
        crashed.exitSignal === "SIGKILL" &&
        killRow1.locked_by === CRASH_WORKER &&
        killRow1.locked_at !== null &&
        killRow1.status === "pending",
    );
    const reclaimInWindow = await store.claimDue({ limit: 5, staleAfterMs: STALE_MS, workerId: MAIN_WORKER });
    check(
      "S4b",
      "崩溃窗口内不重复领取：locked_at 未超 OUTBOX_STALE_MS —— 重领 0 条",
      "0 条",
      reclaimInWindow.length + " 条",
      reclaimInWindow.length === 0,
    );
    await db.pool.query("update jobs set locked_at = now() - interval '2 minutes' where id = $1", [jobKill]);
    const statsKill = await scheduler.tickOnce();
    const killRunsAfterReclaim = runs.filter((item) => item.kind === kinds.kill);
    const killRow2 = await jobRow(jobKill);
    check(
      "S4c",
      "超窗重领（回拨 locked_at = 崩溃已超阈值）：真调度器重领并恰好执行一次",
      "claimed=1 / executed=1 / handler=1 / locked_at 清空 / last_run_at=" + clockNow.toISOString(),
      "stats=" + short(statsKill) + " / handler=" + killRunsAfterReclaim.length + " / " + fmtJob(killRow2),
      statsKill.claimed === 1 &&
        statsKill.executed === 1 &&
        statsKill.produced === 3 &&
        killRunsAfterReclaim.length === 1 &&
        killRow2.locked_at === null &&
        new Date(killRow2.last_run_at).getTime() === clockNow.getTime(),
    );
    const killOutboxPattern = DEDUPE_PREFIX + "." + kinds.kill + ":" + tag + ":%";
    const killOutboxBeforeReplay = await outboxCount(killOutboxPattern);
    await db.pool.query("update jobs set status = 'pending', run_at = $2, last_run_at = null, locked_at = null where id = $1", [
      jobKill,
      runAt,
    ]);
    const statsReplay = await scheduler.tickOnce();
    const killRunsAfterReplay = runs.filter((item) => item.kind === kinds.kill);
    const killOutboxAfterReplay = await outboxCount(killOutboxPattern);
    const killExecutedRows = (await jobRuns(jobKill)).filter((row) => row.status === "executed");
    check(
      "S4d",
      "同窗口人工重放不重发：幂等执行键兜底 —— 产出仍 3 行；job_runs 如实记第二次 executed",
      "outbox=3（重放前 " + killOutboxBeforeReplay + "）/ handler=2 / executed 留痕=2",
      "stats=" + short(statsReplay) + " / outbox=" + killOutboxAfterReplay + " / handler=" + killRunsAfterReplay.length + " / executed 留痕=" + killExecutedRows.length,
      statsReplay.executed === 1 &&
        killOutboxBeforeReplay === 3 &&
        killOutboxAfterReplay === 3 &&
        killRunsAfterReplay.length === 2 &&
        killExecutedRows.length === 2,
    );

    // --------------------------------- 证据五：状态回退再生窗口 / 日期窗口
    const entity = "entity-" + tag;
    const versionWindow7 = DEDUPE_PREFIX + ".completed:" + entity + ":v7";
    const versionWindow9 = DEDUPE_PREFIX + ".completed:" + entity + ":v9";
    const dailyKey0 = DEDUPE_PREFIX + ".daily:" + entity + ":" + businessDateOf(runAt);
    const dailyKey1 = DEDUPE_PREFIX + ".daily:" + entity + ":" + businessDateOf(dayOf(1));
    const appendWindow = (dedupeKey, window) =>
      runtime.appendOutboxIfAbsent(db.db, { topic: PRODUCED_TOPIC, payload: { replay: "s7-3", window, tag }, dedupeKey });

    await appendWindow(versionWindow7, "v7");
    await appendWindow(versionWindow7, "v7-replay");
    const versionSame = await countKey(versionWindow7);
    check("S5a", "状态版本窗口：同实体同版本重复投递 = 同键 —— 只落 1 行（不重发）", "1 行", versionSame + " 行", versionSame === 1);
    await appendWindow(versionWindow9, "v9-regenerated");
    const versionTotal = versionSame + (await countKey(versionWindow9));
    check(
      "S5b",
      "状态回退再生：回退后再次进入触发态（版本推进 v7 → v9）生成新键 —— 可再投",
      "合计 2 行（v7 去重 1 行 + v9 再生 1 行）",
      versionTotal + " 行",
      versionTotal === 2,
    );
    await appendWindow(dailyKey0, businessDateOf(runAt));
    await appendWindow(dailyKey0, businessDateOf(runAt) + "-replay");
    const dailySame = await countKey(dailyKey0);
    check("S5c", "日期窗口：同日重放 = 同键 —— 只落 1 行（回退当天不重发）", "1 行", dailySame + " 行", dailySame === 1);
    await appendWindow(dailyKey1, businessDateOf(dayOf(1)));
    const dailyTotal = dailySame + (await countKey(dailyKey1));
    check("S5d", "次日新窗口：日期推进生成新键 —— 可再投（合计 2 行）", "2 行", dailyTotal + " 行", dailyTotal === 2);

    // ------------------------------------------- 证据六：失败重试到顶（死信）
    const jobFailure = await insertJob(kinds.failure, { runAt, lastRunAt: null });
    const statsFail1 = await scheduler.tickOnce();
    const failRow1 = await jobRow(jobFailure);
    check(
      "S6a",
      "失败重试：attempts 累计、仍 pending（下个 tick 再试）、last_error / job_runs.failed 留痕",
      "failed=1 / status=pending / attempts=1 / last_error 非空",
      "stats=" + short(statsFail1) + " / " + fmtJob(failRow1),
      statsFail1.failed === 1 &&
        statsFail1.executed === 0 &&
        failRow1.status === "pending" &&
        Number(failRow1.attempts) === 1 &&
        String(failRow1.last_error ?? "").length > 0,
    );
    const statsFail2 = await scheduler.tickOnce();
    const failRow2 = await jobRow(jobFailure);
    check(
      "S6b",
      "重试到顶（" + MAX_ATTEMPTS + "/" + MAX_ATTEMPTS + "）：置 failed 终态（重试死信，人工复位后继续）",
      "status=failed / attempts=" + MAX_ATTEMPTS,
      "stats=" + short(statsFail2) + " / " + fmtJob(failRow2),
      statsFail2.failed === 1 && Number(failRow2.attempts) === MAX_ATTEMPTS && failRow2.status === "failed",
    );
    const statsFail3 = await scheduler.tickOnce();
    check(
      "S6c",
      "failed 后不再领取：第三轮 tick 领取 0 条（重试不死循环）",
      "claimed=0 / failed=0",
      "stats=" + short(statsFail3),
      statsFail3.claimed === 0 && statsFail3.failed === 0,
    );
    const failedRunRows = (await jobRuns(jobFailure)).filter((row) => row.status === "failed");
    check("S6d", "失败留痕：job_runs.failed 两次（每次失败一行）", "2 行", failedRunRows.length + " 行", failedRunRows.length === 2);

    // ------------------------------------------- 证据七：双实例并发 tick
    const jobSingle = await insertJob(kinds.single, { runAt, lastRunAt: null });
    const singleRunsBefore = runs.filter((item) => item.kind === kinds.single).length;
    const [statsSingleA, statsSingleB] = await Promise.all([scheduler.tickOnce(), schedulerB.tickOnce()]);
    const singleRunsAfter = runs.filter((item) => item.kind === kinds.single).length;
    check(
      "S7a",
      "双实例并发 tick：单活锁 + SKIP LOCKED —— 恰一个实例执行（claimed / executed 合计均 1）",
      "claimed 合计=1 / executed 合计=1 / handler=1",
      "A=" + short(statsSingleA) + " / B=" + short(statsSingleB) + " / handler=" + (singleRunsAfter - singleRunsBefore),
      statsSingleA.claimed + statsSingleB.claimed === 1 &&
        statsSingleA.executed + statsSingleB.executed === 1 &&
        singleRunsAfter - singleRunsBefore === 1,
    );
    const singleOutbox = await outboxCount(DEDUPE_PREFIX + "." + kinds.single + ":" + tag + ":%");
    check("S7b", "并发净度：产出恰好 3 行（无重复投递）", "3 行", singleOutbox + " 行", singleOutbox === 3);

    // ------------------------- 证据八：每轮窗口上限与「水位不越过未处理窗口」
    const jobCapped = await insertJob(kinds.capped, { runAt: dayOf(-6), lastRunAt: dayOf(-6) });
    const statsCap1 = await schedulerCap.tickOnce();
    const capRuns = runs.filter((item) => item.kind === kinds.capped);
    const capExpected1 = [dayOf(-4), dayOf(-3), dayOf(-2)].map((date) => date.toISOString());
    check(
      "S8a",
      "每轮窗口上限（MAX_WINDOWS_PER_TICK=" + MAX_WINDOWS_PER_TICK + "）：首轮只处理前 " + MAX_WINDOWS_PER_TICK + " 个窗口（day-4 ~ day-2；day-5 触发在 7 天跨度裁剪线之前，按 S3 口径 skipped）",
      "executed=1 / produced=3 / fires=" + capExpected1.join(" / "),
      "stats=" + short(statsCap1) + " / fires=" + (capRuns[0]?.fires.join(" / ") ?? "（未执行）"),
      statsCap1.executed === 1 &&
        capRuns.length === 1 &&
        capRuns[0].fires.join(",") === capExpected1.join(",") &&
        statsCap1.produced === 3,
    );
    const capRow1 = await jobRow(jobCapped);
    const capRunRows1 = await jobRuns(jobCapped);
    check(
      "S8b",
      "水位不越过未处理窗口：last_run_at=本轮最后处理的窗口（day-2）/ run_at=now（下轮顺延）/ note 含「触顶」",
      "last_run_at=" + dayOf(-2).toISOString() + " / run_at=" + clockNow.toISOString() + " / note 含「窗口触顶」",
      fmtJob(capRow1) + " / run_at=" + new Date(capRow1.run_at).toISOString() + " / note=" + String(capRunRows1[0]?.note ?? ""),
      new Date(capRow1.last_run_at).getTime() === dayOf(-2).getTime() &&
        new Date(capRow1.run_at).getTime() === clockNow.getTime() &&
        capRow1.locked_at === null &&
        String(capRunRows1[0]?.note ?? "").includes("窗口触顶"),
    );
    await db.pool.query("update jobs set run_at = now() where id = $1", [jobCapped]);
    const statsCap2 = await schedulerCap.tickOnce();
    const capRuns2 = runs.filter((item) => item.kind === kinds.capped);
    const capExpected2 = [dayOf(-1), dayOf(0), dayOf(1)].map((date) => date.toISOString());
    check(
      "S8c",
      "下一轮顺延：第 2 轮再处理 3 个窗口（day-1 ~ day+1），仍触顶",
      "executed=1 / produced=3 / fires=" + capExpected2.join(" / "),
      "stats=" + short(statsCap2) + " / fires=" + (capRuns2[1]?.fires.join(" / ") ?? "（未执行）"),
      statsCap2.executed === 1 &&
        capRuns2.length === 2 &&
        capRuns2[1].fires.join(",") === capExpected2.join(",") &&
        statsCap2.produced === 3,
    );
    await db.pool.query("update jobs set run_at = now() where id = $1", [jobCapped]);
    const statsCap3 = await schedulerCap.tickOnce();
    const capRuns3 = runs.filter((item) => item.kind === kinds.capped);
    const capRow3 = await jobRow(jobCapped);
    const capExpected3 = [dayOf(2)].map((date) => date.toISOString());
    check(
      "S8d",
      "追平收口：第 3 轮处理余下 1 个窗口（day+2）→ last_run_at=now / run_at=下一触发（day+3）",
      "executed=1 / produced=1 / last_run_at=" + clockNow.toISOString() + " / run_at=" + dayOf(3).toISOString(),
      "stats=" + short(statsCap3) + " / fires=" + (capRuns3[2]?.fires.join(" / ") ?? "（未执行）") + " / " + fmtJob(capRow3) + " / run_at=" + new Date(capRow3.run_at).toISOString(),
      statsCap3.executed === 1 &&
        statsCap3.produced === 1 &&
        capRuns3.length === 3 &&
        capRuns3[2].fires.join(",") === capExpected3.join(",") &&
        new Date(capRow3.last_run_at).getTime() === clockNow.getTime() &&
        new Date(capRow3.run_at).getTime() === dayOf(3).getTime(),
    );
    const statsCap4 = await schedulerCap.tickOnce();
    const capOutbox = await outboxCount(DEDUPE_PREFIX + "." + kinds.capped + ":" + tag + ":%");
    check(
      "S8e",
      "清空后不再领取且无重复：第 4 轮 0 条 / 三轮总产出 7 行（3+3+1，逐窗口一键）",
      "claimed=0 / outbox=7",
      "stats=" + short(statsCap4) + " / outbox=" + capOutbox + " 行",
      statsCap4.claimed === 0 && statsCap4.executed === 0 && capOutbox === 7,
    );
  } catch (error) {
    if (!assertionThrown) failures += 1;
    process.stderr.write("S7-3 回放失败：" + messageOf(error) + "\n");
  } finally {
    try {
      await restoreParkedJobs();
    } catch (error) {
      failures += 1;
      assertionThrown = true;
      note("| FAIL | 非本回放 pending jobs 恢复失败：" + messageOf(error) + " |");
    }
    try {
      if (args.keep === true) {
        note("| KEEP | --keep：保留本脚本 jobs / outbox 行（前缀 " + KIND_PREFIX + " / " + DEDUPE_PREFIX + "） |");
      } else {
        const deletedJobs = await db.pool.query("delete from jobs where kind like $1", [KIND_PREFIX + "%"]);
        const deletedOutbox = await db.pool.query("delete from outbox_events where dedupe_key like $1", [DEDUPE_PREFIX + "%"]);
        note(
          "| CLEANUP | 清除本脚本 jobs " + deletedJobs.rowCount + " 条（job_runs 级联）/ outbox " + deletedOutbox.rowCount + " 条 |",
        );
      }
    } catch (error) {
      note("| WARN | 收尾未完全成功：" + messageOf(error) + " |");
    }
    try {
      await db.onApplicationShutdown();
      await dbB.onApplicationShutdown();
    } catch {
      // 连接池已关或未建：忽略。
    }
  }

  const commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: process.cwd() }).toString().trim();
  const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: process.cwd() }).toString().trim() !== "";
  const lines = [];
  lines.push("# S7-3 · i11 回放证据（调度 / 补发 / 幂等执行键 / 状态回退再生窗口）");
  lines.push("");
  lines.push("> 卡片：i11 · M5-02（主责 lan，评审 wmj）｜验收：杀 worker 不丢消息、重复领取不重发；补发与状态回退再生窗口用例通过。");
  lines.push("");
  lines.push("| 项 | 值 |");
  lines.push("|---|---|");
  lines.push("| 回放时间 | " + new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 19).replace("T", " ") + " +08:00 |");
  lines.push("| 数据库 | " + DATABASE_URL.replace(/:[^:@/]+@/, ":***") + " |");
  lines.push("| 代码版本 | " + commit + (dirty ? "（工作区含未提交改动）" : "") + " |");
  lines.push("| 脚本 | server/scripts/s7-3-scheduler-replay.mjs |");
  lines.push("| 时间锚点 | cron = " + cron + "（与 run_at 对齐）· run_at = " + runAt.toISOString() + " · 假想 now = " + clockNow.toISOString() + " |");
  lines.push("| 环境口径 | OUTBOX_STALE_MS=" + STALE_MS + " · 补发跨度 " + CATCHUP_MAX_DAYS + " 天 · maxAttempts=" + MAX_ATTEMPTS + " · 每轮窗口上限 " + MAX_WINDOWS_PER_TICK + "（证据八实例）· 单活锁 " + OUTBOX_SCHEDULER.lockName + " |");
  lines.push("| 领取者 | " + MAIN_WORKER + "（主）· " + CRASH_WORKER + "（被 SIGKILL 的子进程）· " + MAIN_WORKER + "-b（并发第二实例） |");
  lines.push("");
  lines.push("## 断言明细");
  lines.push("");
  lines.push(...report);
  lines.push("");
  lines.push("## 汇总");
  lines.push("");
  lines.push(
    failures === 0
      ? "- 全部断言通过：单活调度（S1）· cron 补发与推进（S2）· 超跨度 skipped（S3）· 杀 worker 不丢 / 崩溃重领 / 重放不重发（S4）· 状态回退再生与日期窗口（S5）· 失败重试到顶（S6）· 双实例并发（S7）· 每轮窗口上限与水位不越过（S8）。"
      : "- 有 " + failures + " 项失败，见上方 FAIL 行。",
  );
  lines.push("");
  lines.push("## 复跑");
  lines.push("");
  lines.push(
    "cd server && S7_3_DATABASE_URL=postgresql://libiaolink_migrator@127.0.0.1:55432/libiaolink node --env-file-if-exists=.env scripts/s7-3-scheduler-replay.mjs [--out <报告.md>] [--keep]",
  );
  lines.push("");
  if (args.json !== undefined) writeFileSync(args.json, JSON.stringify(evidence, null, 2) + "\n", "utf8");
  if (args.out !== undefined) writeFileSync(args.out, lines.join("\n") + "\n", "utf8");
  process.stdout.write("\n" + lines.join("\n") + "\n");
  process.stdout.write("S7-3 " + (failures === 0 ? "全部断言通过" : "失败 " + failures + " 项") + "\n");
  process.exit(failures === 0 ? 0 : 1);
}

runtime = await loadRuntime();
if (args.childClaim === true) {
  await runChildClaim();
} else {
  await runMain();
}
