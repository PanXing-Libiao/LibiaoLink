#!/usr/bin/env node
/**
 * S7-2 · PoC-4 真机回放（i6 · 团队分工.md §6 第 4 行）：Outbox 投递语义验证 —— 不丢 / 不重发 / 重试与可执行告警。
 *
 *   证据一（杀 worker 不丢）：真实子进程执行真领取语句（OutboxStore.claim，workerId=poc4-crashed-worker）后被 SIGKILL ——
 *        行留在 processing（可查、未丢）；崩溃窗口内第二 worker drain 0 条（不重复投递）；把 locked_at 回拨到
 *        OUTBOX_STALE_MS 之外（等价于「崩溃已超阈值」；CI 不等满默认窗口）→ 真 OutboxDispatcher 重领并消费
 *        **恰好一次**（done · locked_by = 第二 worker）。
 *   证据二（重复领取不重发）：done 行不再被领取；同 dedupeKey 复投（appendOutboxIfAbsent）不新增行、不重开 pending。
 *   证据三（重试与可执行告警）：可重试失败按主题策略退避回 pending（attempts 累计 / available_at = now + base*2^(n-1)）；
 *        到顶转 dead + onDead 留痕 + OUTBOX_ALERT_SINK 捕获「outbox.dead」即时告警；告警探针真机对照 ——
 *        积压 / 最老等待只记日志，连续无 done 进度时合并升级为 queue_stalled；合成 backlog 主题无消费者另发
 *        unconsumed_topic；dead_letter 不即时推送，只进入日报。同一快照宽阈值下阈值类 0 告警（未消费主题
 *        仍如实报告，证明不是恒告警噪声）。
 *
 * 前置：真 PG（迁移器角色即可）+ 已构建的 server/dist（cd server && npm run build）。
 * 用法：cd server && POC4_DATABASE_URL=postgresql://libiaolink_migrator@127.0.0.1:55432/libiaolink \
 *       node --env-file-if-exists=.env scripts/poc4-outbox-replay.mjs [--out <报告.md>] [--json <证据.json>] [--keep]
 * 退出码：断言全过 = 0，否则 = 1（可当门禁用）。
 * 说明：本机无 PG 时只做语法门禁；真机证据以 CI database job 为准（不伪造）。
 */
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const args = parseArgs(process.argv.slice(2));
const DATABASE_URL =
  args.databaseUrl ?? process.env.POC4_DATABASE_URL ?? process.env.DATABASE_URL ?? "postgresql://libiaolink_migrator@127.0.0.1:55432/libiaolink";

/** 本回放全部话题前缀（清理 / 计数用）：不在契约白名单内 —— 证据专用合成主题，不落生产代码。 */
const TOPIC_PREFIX = "poc4.replay.";
const TOPIC_KILL = TOPIC_PREFIX + "kill";
const TOPIC_DEDUPE = TOPIC_PREFIX + "dedupe";
const TOPIC_RETRY = TOPIC_PREFIX + "retry";
const TOPIC_DEAD = TOPIC_PREFIX + "dead";
/** 探针靶子：不注册 handler（dispatcher 未注册主题不领取）→ 行稳定留在 pending，供探针快照读取。 */
const TOPIC_BACKLOG = TOPIC_PREFIX + "backlog";
/** OUTBOX_STALE_MS 的 env 下限（60000）；CI 不等满窗口，用「回拨 locked_at」等价模拟。 */
const STALE_MS = 60_000;
const RETRY_ERROR = "poc4 通道抖动（可重试）";
const DEAD_ERROR = "poc4 上游持续不可用（重试到顶）";
const WORKER_MAIN = "poc4-main";
const WORKER_CHILD = "poc4-crashed-worker";

const report = [];
const evidence = { checks: [], rounds: {}, counts: {} };
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
    else if (item === "--topic") out.topic = argv[++i];
    else if (item === "--worker-id") out.workerId = argv[++i];
    else if (item === "--keep") out.keep = true;
  }
  return out;
}

function note(line) {
  report.push(line);
  process.stdout.write(line + "\n");
}

function check(id, title, expected, actual, ok) {
  if (!ok) { failures += 1; assertionThrown = true; }
  note("| " + (ok ? "PASS" : "FAIL") + " | " + id + " | " + title + " | 期望：" + expected + " | 实际：" + actual + " |");
  evidence.checks.push({ id, title, expected, actual, ok });
  if (!ok) throw new Error("PoC-4 断言失败（" + id + "）：" + title);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function short(value, max = 300) {
  const text = JSON.stringify(value);
  return text === undefined ? "undefined" : text.length > max ? text.slice(0, max) + "..." : text;
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

/** 读取行（证据断言只读；状态迁移一律走真代码路径）。 */
function fmtRow(row) {
  if (row === null || row === undefined) return "（行不存在）";
  return (
    "status=" + row.status + " / attempts=" + row.attempts + " / locked_by=" + (row.locked_by ?? "null") +
    " / locked_at=" + (row.locked_at === null ? "null" : "非空") + " / last_error=" + (row.last_error === null ? "null" : row.last_error)
  );
}

/** 录制型告警出口：捕获 OUTBOX_ALERT_SINK 的真实 emit（证据三）。 */
class RecordingSink {
  constructor() {
    this.alerts = [];
    this.digests = [];
  }
  emit(alert) {
    this.alerts.push(alert);
  }
  emitDigest(report) {
    this.digests.push(report);
  }
}

/** 加载 dist（真运行时类）；缺构建时给出明确指引。 */
async function loadRuntime() {
  await import("reflect-metadata");
  const load = (rel) => import(pathToFileURL(join(HERE, "..", "dist", rel)).href);
  try {
    const [envModule, configModule, databaseModule, storeModule, dispatcherModule, clockModule, policyModule, probeModule, outboxModule] =
      await Promise.all([
        load("config/env.js"),
        load("config/config.module.js"),
        load("db/database.service.js"),
        load("db/outbox.store.js"),
        load("outbox/dispatcher.js"),
        load("common/clock/clock.service.js"),
        load("outbox/policy.js"),
        load("outbox/probe.js"),
        load("db/outbox.js"),
      ]);
    return {
      loadEnv: envModule.loadEnv,
      AppConfig: configModule.AppConfig,
      DatabaseService: databaseModule.DatabaseService,
      OutboxStore: storeModule.OutboxStore,
      OutboxDispatcher: dispatcherModule.OutboxDispatcher,
      ClockService: clockModule.ClockService,
      defaultTopicPolicy: policyModule.defaultTopicPolicy,
      resolveOutboxPolicies: policyModule.resolveOutboxPolicies,
      OutboxAlertProbe: probeModule.OutboxAlertProbe,
      appendOutbox: outboxModule.appendOutbox,
      appendOutboxIfAbsent: outboxModule.appendOutboxIfAbsent,
    };
  } catch (error) {
    process.stderr.write("PoC-4：无法加载 server/dist（先执行 cd server && npm run build）：" + String(error) + "\n");
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
    OUTBOX_DEFAULT_MAX_ATTEMPTS: "3",
    OUTBOX_DEFAULT_BACKOFF_BASE_MS: "1000",
    OUTBOX_DEFAULT_BACKOFF_MAX_MS: "2000",
    OUTBOX_ALERT_BACKLOG_MAX: "1",
    OUTBOX_ALERT_OLDEST_MS: "60000",
    OUTBOX_ALERT_PROGRESS_WINDOW_MS: "60000",
    OUTBOX_ALERT_STALL_PROBES: "1",
    ...overrides,
  });
}

/** 子进程模式：真领取一行后挂起，等父进程 SIGKILL（= worker 崩溃，markDone 永不发生）。 */
async function runChildClaim() {
  const topic = args.topic;
  const workerId = args.workerId ?? WORKER_CHILD;
  const env = buildEnv({ WORKER_ID: workerId });
  const config = new runtime.AppConfig(env);
  const db = new runtime.DatabaseService(config);
  const store = new runtime.OutboxStore(db);
  const rows = await store.claim({ topics: [topic], limit: 1, staleAfterMs: STALE_MS, workerId });
  process.stdout.write("POC4_CLAIMED " + JSON.stringify({ id: rows.length > 0 ? rows[0].id : null, workerId }) + "\n");
  await new Promise(() => {});
}

/** 起子进程 → 等领取回执 → SIGKILL → 收退出码 / 信号。 */
async function spawnCrashedWorker(topic, workerId) {
  const child = spawn(
    process.execPath,
    [fileURLToPath(import.meta.url), "--child-claim", "--topic", topic, "--worker-id", workerId, "--database-url", DATABASE_URL],
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
    await sleep(50);
  }
  if (!stdout.includes("\n")) {
    child.kill("SIGKILL");
    throw new Error("子进程未在 30s 内完成领取（stderr 尾部：" + stderr.slice(-300) + "）");
  }
  const line = stdout.split("\n")[0];
  if (!line.startsWith("POC4_CLAIMED ")) {
    child.kill("SIGKILL");
    throw new Error("子进程输出非法：" + line);
  }
  const claimed = JSON.parse(line.slice("POC4_CLAIMED ".length));
  if (child.exitCode !== null || child.signalCode !== null) {
    return { claimed, exitCode: child.exitCode, exitSignal: child.signalCode, pid: child.pid, stderr };
  }
  child.kill("SIGKILL");
  const [exitCode, exitSignal] = await once(child, "exit");
  return { claimed, exitCode, exitSignal, pid: child.pid, stderr };
}
async function runMain() {
  const env = buildEnv({ WORKER_ID: WORKER_MAIN });
  const config = new runtime.AppConfig(env);
  const db = new runtime.DatabaseService(config);
  const store = new runtime.OutboxStore(db);
  const alerts = new RecordingSink();
  const clock = new runtime.ClockService();
  const deliveries = new Map();
  const deadHooks = [];
  const tag = randomBytes(4).toString("hex");
  const keyKill = "poc4-" + tag + "-kill";
  const keyDedupe = "poc4-" + tag + "-dedupe";
  const keyRetry = "poc4-" + tag + "-retry";
  const keyDead = "poc4-" + tag + "-dead";
  const keyBacklog = "poc4-" + tag + "-backlog";

  const record = (topic, row) => {
    const list = deliveries.get(topic) ?? [];
    list.push({ id: String(row.id), dedupeKey: row.dedupeKey, attempts: row.attempts });
    deliveries.set(topic, list);
  };
  const countDeliveries = (topic) => (deliveries.get(topic) ?? []).length;
  const handlers = new Map([
    [TOPIC_KILL, { handle: async (row) => { record(TOPIC_KILL, row); return { outcome: "done" }; } }],
    [TOPIC_DEDUPE, { handle: async (row) => { record(TOPIC_DEDUPE, row); return { outcome: "done" }; } }],
    [
      TOPIC_RETRY,
      {
        handle: async (row) => {
          record(TOPIC_RETRY, row);
          return countDeliveries(TOPIC_RETRY) === 1 ? { outcome: "retry", error: RETRY_ERROR } : { outcome: "done" };
        },
      },
    ],
    [
      TOPIC_DEAD,
      {
        handle: async (row) => { record(TOPIC_DEAD, row); return { outcome: "retry", error: DEAD_ERROR }; },
        onDead: async (row, error) => { deadHooks.push({ id: String(row.id), error }); },
      },
    ],
  ]);
  const policies = new Map(runtime.resolveOutboxPolicies(env));
  for (const topic of handlers.keys()) {
    policies.set(topic, runtime.defaultTopicPolicy(env));
  }
  const dispatcher = new runtime.OutboxDispatcher(store, handlers, policies, alerts, config, clock);
  const probe = new runtime.OutboxAlertProbe(store, alerts, config, handlers, clock);

  const rowOfKey = async (dedupeKey) => {
    const result = await db.pool.query(
      "select id, topic, dedupe_key, status, attempts, last_error, locked_by, locked_at, available_at, updated_at from outbox_events where dedupe_key = $1",
      [dedupeKey],
    );
    return result.rows[0] ?? null;
  };
  const countOfKey = async (dedupeKey) => {
    const result = await db.pool.query("select count(*)::int as n from outbox_events where dedupe_key = $1", [dedupeKey]);
    return result.rows[0].n;
  };
  const backdateLocked = async (id, extraSeconds) => {
    await db.pool.query("update outbox_events set locked_at = now() - ($2::int * interval '1 second') where id = $1", [
      id,
      Math.ceil(STALE_MS / 1000) + extraSeconds,
    ]);
  };
  const backdateAvailable = async (dedupeKey, seconds) => {
    await db.pool.query("update outbox_events set available_at = now() - ($2::int * interval '1 second') where dedupe_key = $1", [dedupeKey, seconds]);
  };

  try {
    // ---------------------------------------------------------------- 基线
    const baseline = await db.pool.query("select count(*)::int as n from outbox_events where topic like $1", [TOPIC_PREFIX + "%"]);
    check("P0", "基线：本脚本话题前缀无存量行（回放自清理）", "0 行", baseline.rows[0].n + " 行", baseline.rows[0].n === 0);

    // ------------------------------------------------- 证据一 / 二：杀 worker 不丢 · 不重发
    await runtime.appendOutbox(db.db, { topic: TOPIC_KILL, payload: { scenario: "kill-worker", tag }, dedupeKey: keyKill });
    const killRow = await rowOfKey(keyKill);
    check(
      "A1",
      "投递落库：appendOutbox 写 pending（提交后可见、可领取）",
      "status=pending / attempts=0 / locked_at=null",
      "id=" + killRow.id + " / " + fmtRow(killRow),
      killRow.status === "pending" && Number(killRow.attempts) === 0 && killRow.locked_at === null,
    );

    const crashed = await spawnCrashedWorker(TOPIC_KILL, WORKER_CHILD);
    const afterCrash = await rowOfKey(keyKill);
    check(
      "A2",
      "杀 worker 不丢：子进程真领取后被 SIGKILL —— 行留 processing 且可查（locked_by / locked_at 留痕）",
      "子进程 signal=SIGKILL；行 status=processing / locked_by=" + WORKER_CHILD + " / locked_at 非空 / attempts=0",
      "child pid=" + crashed.pid + " code=" + crashed.exitCode + " signal=" + crashed.exitSignal + " / claimed.id=" + crashed.claimed.id + " / " + fmtRow(afterCrash),
      String(crashed.claimed.id) === String(killRow.id) &&
        crashed.exitSignal === "SIGKILL" &&
        afterCrash.status === "processing" &&
        afterCrash.locked_by === WORKER_CHILD &&
        afterCrash.locked_at !== null &&
        Number(afterCrash.attempts) === 0,
    );

    const statsA3 = await dispatcher.drainOnce();
    check(
      "A3",
      "崩溃窗口内（locked_at 未超 OUTBOX_STALE_MS）第二 worker 领取 0 条 —— 不重复投递",
      "claimed=0 / done=0 / handler 调用 0",
      "stats=" + short(statsA3) + " / handler=" + countDeliveries(TOPIC_KILL),
      statsA3.claimed === 0 && countDeliveries(TOPIC_KILL) === 0,
    );

    await backdateLocked(killRow.id, 5);
    const statsA4 = await dispatcher.drainOnce();
    const reclaimed = await rowOfKey(keyKill);
    const killDeliveries = deliveries.get(TOPIC_KILL) ?? [];
    check(
      "A4",
      "超窗重领（回拨 locked_at 到 stale 之外 = 崩溃已超阈值）：真 dispatcher 重领并恰好消费一次",
      "claimed=1 / done=1 / handler=1（dedupeKey 一致）/ 行 done / locked_by=" + WORKER_MAIN,
      "stats=" + short(statsA4) + " / handler=" + killDeliveries.length + " / " + fmtRow(reclaimed),
      statsA4.claimed === 1 &&
        statsA4.done === 1 &&
        killDeliveries.length === 1 &&
        killDeliveries[0].dedupeKey === keyKill &&
        reclaimed.status === "done" &&
        reclaimed.locked_by === WORKER_MAIN,
    );

    const statsA5a = await dispatcher.drainOnce();
    const statsA5b = await dispatcher.drainOnce();
    await runtime.appendOutboxIfAbsent(db.db, { topic: TOPIC_KILL, payload: { scenario: "kill-worker", tag, replayed: true }, dedupeKey: keyKill });
    const afterReplay = await rowOfKey(keyKill);
    const killRows = await countOfKey(keyKill);
    check(
      "A5",
      "done 后不再投递 + 同 dedupeKey 复投不重开：行数仍 1 / 仍 done / 消费恒 1 次",
      "两轮 drain claimed=0 / 行数=1 / status=done / handler=1",
      "claimed=" + short([statsA5a.claimed, statsA5b.claimed]) + " / 行数=" + killRows + " / " + fmtRow(afterReplay) + " / handler=" + countDeliveries(TOPIC_KILL),
      statsA5a.claimed === 0 && statsA5b.claimed === 0 && killRows === 1 && afterReplay.status === "done" && countDeliveries(TOPIC_KILL) === 1,
    );

    await runtime.appendOutboxIfAbsent(db.db, { topic: TOPIC_DEDUPE, payload: { n: 1 }, dedupeKey: keyDedupe });
    await runtime.appendOutboxIfAbsent(db.db, { topic: TOPIC_DEDUPE, payload: { n: 2 }, dedupeKey: keyDedupe });
    const statsA6 = await dispatcher.drainOnce();
    const dedupeRow = await rowOfKey(keyDedupe);
    const dedupeRows = await countOfKey(keyDedupe);
    check(
      "A6",
      "去重键：同 dedupeKey 重复投递只落 1 行（onConflict 幂等）、只消费 1 次",
      "行数=1 / claimed=1 / handler=1 / status=done",
      "行数=" + dedupeRows + " / stats=" + short(statsA6) + " / " + fmtRow(dedupeRow) + " / handler=" + countDeliveries(TOPIC_DEDUPE),
      dedupeRows === 1 && statsA6.claimed === 1 && statsA6.done === 1 && dedupeRow.status === "done" && countDeliveries(TOPIC_DEDUPE) === 1,
    );

    // ------------------------------------------------------- 证据三：重试与可执行告警
    await runtime.appendOutbox(db.db, { topic: TOPIC_RETRY, payload: { scenario: "retry", tag }, dedupeKey: keyRetry });
    const statsB1 = await dispatcher.drainOnce();
    const retryRow1 = await rowOfKey(keyRetry);
    const retryDelay = await db.pool.query("select round(extract(epoch from (available_at - now())) * 1000)::int as ms from outbox_events where dedupe_key = $1", [keyRetry]);
    const retryDelayMs = retryDelay.rows[0].ms;
    check(
      "B1",
      "可重试失败：attempts 累计 + 按主题策略退避（第 1 次 = base 1000ms）回 pending",
      "retried=1 / status=pending / attempts=1 / last_error=记录 / 剩余退避 ∈ [850,1600]ms / locked_at=null",
      "stats=" + short(statsB1) + " / " + fmtRow(retryRow1) + " / 剩余退避=" + retryDelayMs + "ms",
      statsB1.retried === 1 &&
        retryRow1.status === "pending" &&
        Number(retryRow1.attempts) === 1 &&
        retryRow1.last_error === RETRY_ERROR &&
        retryRow1.locked_at === null &&
        retryDelayMs >= 850 &&
        retryDelayMs <= 1600,
    );

    await backdateAvailable(keyRetry, 1);
    const statsB2 = await dispatcher.drainOnce();
    const retryRow2 = await rowOfKey(keyRetry);
    check(
      "B2",
      "退避到期重领 → 第 2 次成功 done（attempts 留痕保留，不抹历史）",
      "done=1 / status=done / attempts=1 / last_error=null / handler=2",
      "stats=" + short(statsB2) + " / " + fmtRow(retryRow2) + " / handler=" + countDeliveries(TOPIC_RETRY),
      statsB2.done === 1 && retryRow2.status === "done" && Number(retryRow2.attempts) === 1 && retryRow2.last_error === null && countDeliveries(TOPIC_RETRY) === 2,
    );

    await runtime.appendOutbox(db.db, { topic: TOPIC_DEAD, payload: { scenario: "dead-letter", tag }, dedupeKey: keyDead });
    const deadRounds = [];
    for (let round = 1; round <= 3; round += 1) {
      if (round > 1) await backdateAvailable(keyDead, 1);
      deadRounds.push(await dispatcher.drainOnce());
    }
    evidence.rounds.dead = deadRounds;
    const deadRow = await rowOfKey(keyDead);
    const deadAlerts = alerts.alerts.filter((item) => item.code === "outbox.dead" && item.detail !== undefined && item.detail.dedupeKey === keyDead);
    check(
      "B3",
      "重试到顶（3/3）转 dead：onDead 留痕 + 单条死信即时告警（detail 口径）",
      "轮次 retried=1,retried=1,dead=1 / status=dead / attempts=3 / handler=3 / onDead=1 / outbox.dead 1 条（attempts=3 maxAttempts=3）",
      "stats=" + short(deadRounds.map((item) => ({ retried: item.retried, dead: item.dead }))) + " / " + fmtRow(deadRow) + " / handler=" + countDeliveries(TOPIC_DEAD) +
        " / onDead=" + deadHooks.length + " / 告警=" + short(deadAlerts.map((item) => ({ code: item.code, level: item.level, detail: item.detail }))),
      deadRounds[0].retried === 1 &&
        deadRounds[1].retried === 1 &&
        deadRounds[2].dead === 1 &&
        deadRow.status === "dead" &&
        Number(deadRow.attempts) === 3 &&
        deadRow.last_error === DEAD_ERROR &&
        countDeliveries(TOPIC_DEAD) === 3 &&
        deadHooks.length === 1 &&
        deadHooks[0].id === String(deadRow.id) &&
        deadHooks[0].error === DEAD_ERROR &&
        deadAlerts.length === 1 &&
        deadAlerts[0].level === "error" &&
        deadAlerts[0].detail.attempts === 3 &&
        deadAlerts[0].detail.maxAttempts === 3,
    );

    // ------------------------------------------------------- 告警探针（停滞升级 / 未消费主题 / 死信日报）
    await runtime.appendOutbox(db.db, { topic: TOPIC_BACKLOG, payload: { scenario: "probe", tag }, dedupeKey: keyBacklog + "-a" });
    await runtime.appendOutbox(db.db, { topic: TOPIC_BACKLOG, payload: { scenario: "probe", tag }, dedupeKey: keyBacklog + "-b" });
    await backdateAvailable(keyBacklog + "-b", 120);
    // 前面的成功消费落在进度窗口内，会掩盖「当前已停滞」；回拨 done 行等价于窗口内 0 完成。
    await db.pool.query(
      "update outbox_events set updated_at = now() - interval '2 minutes' where topic like $1 and status = 'done'",
      [TOPIC_PREFIX + "%"],
    );
    const probeAlerts = await probe.probeOnce();
    const codes = probeAlerts.map((item) => item.code).sort();
    const stalledAlert = probeAlerts.find((item) => item.code === "outbox.queue_stalled");
    const unconsumedAlert = probeAlerts.find((item) => item.code === "outbox.unconsumed_topic");
    check(
      "C1",
      "告警探针（阈值内且进度窗口 0 完成）：仅 queue_stalled + unconsumed_topic 即时告警；dead_letter 只记日志",
      "两码齐发；queue_stalled.detail.duePending>=2；oldestDueMs>=119000 且 doneRecent=0；unconsumed_topic 命中合成 backlog 主题；不含 backlog / oldest_due / dead_letter",
      "codes=" + short(codes) + " / " + short(probeAlerts.map((item) => ({ code: item.code, detail: item.detail }))),
      codes.length === 2 &&
        codes.includes("outbox.queue_stalled") &&
        codes.includes("outbox.unconsumed_topic") &&
        stalledAlert.detail.duePending >= 2 &&
        stalledAlert.detail.oldestDueMs >= 119_000 &&
        stalledAlert.detail.doneRecent === 0 &&
        unconsumedAlert.detail.byTopic.some((item) => item.topic === TOPIC_BACKLOG),
    );

    const wideEnv = buildEnv({
      WORKER_ID: WORKER_MAIN,
      OUTBOX_ALERT_BACKLOG_MAX: "1000",
      OUTBOX_ALERT_OLDEST_MS: "86400000",
      OUTBOX_ALERT_DEAD_RECENT_MAX: "100000",
    });
    const wideSink = new RecordingSink();
    const wideProbe = new runtime.OutboxAlertProbe(store, wideSink, new runtime.AppConfig(wideEnv), handlers, clock);
    const wideAlerts = await wideProbe.probeOnce();
    const wideThresholdAlerts = wideAlerts.filter((item) => item.code !== "outbox.unconsumed_topic");
    check(
      "C2",
      "同一份快照、宽阈值对照：阈值类 0 告警 + 未消费主题 1 条（探针语义不是恒告警噪声）",
      "threshold=0 / unconsumed=1",
      "threshold=" + wideThresholdAlerts.length + " / codes=" + short(wideAlerts.map((item) => item.code)),
      wideThresholdAlerts.length === 0 && wideAlerts.some((item) => item.code === "outbox.unconsumed_topic"),
    );

    const statusRows = await db.pool.query("select status, count(*)::int as n from outbox_events where topic like $1 group by status order by status", [TOPIC_PREFIX + "%"]);
    const byStatus = Object.fromEntries(statusRows.rows.map((row) => [row.status, row.n]));
    evidence.counts.byStatus = byStatus;
    check(
      "C3",
      "演示记录入库：本脚本全部状态迁移在 outbox_events 可查（三态计数）",
      "pending=2 / processing=0 / done=3 / dead=1",
      short(byStatus),
      byStatus.pending === 2 && (byStatus.processing ?? 0) === 0 && byStatus.done === 3 && byStatus.dead === 1,
    );
  } catch (error) {
    if (!assertionThrown) failures += 1;
    process.stderr.write("PoC-4 回放失败：" + messageOf(error) + "\n");
  } finally {
    try {
      if (args.keep === true) {
        note("| KEEP | — | --keep：保留本脚本 outbox 行 | 期望：— | 实际：前缀 " + TOPIC_PREFIX + " |");
      } else {
        const deleted = await db.pool.query("delete from outbox_events where topic like $1", [TOPIC_PREFIX + "%"]);
        note("| CLEANUP | — | 清除本脚本 outbox 行 | 期望：— | 实际：删除 " + deleted.rowCount + " 条（前缀 " + TOPIC_PREFIX + "） |");
      }
    } catch (error) {
      note("| WARN | — | 收尾未完全成功 | 期望：— | 实际：" + messageOf(error) + " |");
    }
    await db.onApplicationShutdown();
  }

  const commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: process.cwd() }).toString().trim();
  const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: process.cwd() }).toString().trim() !== "";
  const lines = [];
  lines.push("# S7-2 · PoC-4 回放证据（Outbox 投递语义：不丢 / 不重发 / 重试与可执行告警）");
  lines.push("");
  lines.push("> 卡片：i6 · S7·PoC-4（主责 lan，评审 wmj 或 px）｜验收：杀 worker 不丢消息、重复领取不重发、重试与可执行告警演示（团队分工.md §6 第 4 行）。");
  lines.push("");
  lines.push("| 项 | 值 |");
  lines.push("|---|---|");
  lines.push("| 回放时间 | " + new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 19).replace("T", " ") + " +08:00 |");
  lines.push("| 数据库 | " + DATABASE_URL.replace(/:[^:@/]+@/, ":***") + " |");
  lines.push("| 代码版本 | " + commit + (dirty ? "（工作区含未提交改动）" : "") + " |");
  lines.push("| 脚本 | server/scripts/poc4-outbox-replay.mjs |");
  lines.push("| 环境口径 | OUTBOX_STALE_MS=60000（env 下限）· 退避 1000ms 起 / 2000ms 封顶 · maxAttempts=3 · 告警阈值 backlog=1 / oldest=60s / 进度窗口=60s / 停滞=1 轮 |");
  lines.push("| 领取者 | " + WORKER_MAIN + "（主）· " + WORKER_CHILD + "（被 SIGKILL 的子进程）|");
  lines.push("");
  lines.push("## 断言明细");
  lines.push("");
  lines.push("| 结果 | 编号 | 断言 | 期望 | 实际 |");
  lines.push("|---|---|---|---|---|");
  lines.push(...report);
  lines.push("");
  lines.push("## 汇总");
  lines.push("");
  lines.push(failures === 0 ? "- 全部断言通过：杀 worker 不丢（A1~A4）· 重复领取不重发（A3 / A5 / A6）· 重试与可执行告警（B1~B3 / C1~C3）。" : "- 有 " + failures + " 项失败，见上方 FAIL 行。");
  lines.push("");
  lines.push("## 复跑");
  lines.push("");
  lines.push("cd server && POC4_DATABASE_URL=postgresql://libiaolink_migrator@127.0.0.1:55432/libiaolink node --env-file-if-exists=.env scripts/poc4-outbox-replay.mjs [--out ../docs/PoC-4-回放证据(Outbox投递语义).md] [--keep]");
  if (args.json !== undefined) writeFileSync(args.json, JSON.stringify(evidence, null, 2) + "\n", "utf8");
  if (args.out !== undefined) writeFileSync(args.out, lines.join("\n") + "\n", "utf8");
  process.stdout.write("\n" + lines.join("\n") + "\n");
  process.stdout.write("PoC-4 " + (failures === 0 ? "全部断言通过" : "失败 " + failures + " 项") + "\n");
  process.exit(failures === 0 ? 0 : 1);
}

runtime = await loadRuntime();
if (args.childClaim === true) {
  await runChildClaim();
} else {
  await runMain();
}
