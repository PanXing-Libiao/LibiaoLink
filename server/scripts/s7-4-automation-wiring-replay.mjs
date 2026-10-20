#!/usr/bin/env node
/**
 * S7-4 · M5-02 接线段 真机回放（规则事件消费 + automation-schedule.job → notify.message 生产 /
 *   M5-03-5-4 接线段：单聊 aibot 产出接线 + 分流消费）：
 *   证据一（事件链全链）：task.completed 真 outbox 行 → 真 OutboxDispatcher 领取 → 规则接线消费（R02 命中）
 *        → 产出 notify.message（收件人 / 类型 / 渠道 / 模板 / 关联对象 / 幂等键全字段断言；M5-03-5-4 起同规则
 *        双产行 = inbox + wecom_aibot（幂等键 :aibot 后缀））→ 下一轮领取 → 按载荷 channel 分流（镜像
 *        OutboxModule.buildRegistry）：wecom_aibot → 真 NotifyDmService（stub socket 自动应答）→
 *        notify_deliveries sent 行（**M5-03-5-6：发送地址 = 绑定行 `wecom_userid`** —— 夹具按
 *        `(bot_id, wecom_userid)` 播种绑定行，等价于「该用户已完成绑定」；旁证回填 D4 仍保留为兜底）；其余 →
 *        真 NotifyService 落行 → 收件箱读面立即可见。
 *   证据二（冷启动保护）：行创建时刻超 AUTOMATION_EVENT_MAX_AGE_MS 的历史事件 → done、零产出；同载荷新事件
 *        正常产出（对照组：拦截判据是「事件年龄」而非条件不命中）。
 *   证据三（主体不可解析）：taskId 不存在 → outbox 行 dead（确定性失败一次即弃）、零产出。
 *   证据四（无事件型规则订阅）：issue.updated 主题 → 直接消费完成、零产出（不产无主通知）。
 *   证据五（渠道护栏 · M5-03-3）：channel=wecom_app 原始行（本回放注册表刻意不接应用分支 —— 保留 NotifyService
 *        防御面证据）→ 确定性 dead + 零落库（生产装配按 channel 分流至 NotifyAppService —— 应用分支语义见 m5-03-3 回放）。
 *   证据六（调度窗口 · A01 应填未填）：真 JobScheduler tick 领取 automation-schedule.job → 产出与 last_run_at 推进
 *        同事务提交、job_runs 留痕（executed / fire_count / produced / note）→ 消费 → 收件箱可见。
 *   证据七（调度窗口 · A01 合并）：同一人名下多项目 → 收件人粒度一条（项目清单合并文案 + 幂等键收件人粒度）。
 *   证据八（重放幂等）：回拨窗口重放 → 产出幂等键不重复（appendOutboxIfAbsent 唯一约束兜底）、job_runs 如实留痕。
 *   证据九（渠道落地口径 · M5-03-5-4 接线段）：wecom_aibot 产出接线已落（R02 ×2 + A01 ×1 → :aibot 行）且消费 =
 *   单聊发送（stub 应答）全 sent；channelSkipped = 0（未落地渠道仅余 email · 无 warn 留痕）。note 口径 = 主体数 /
 *   notify.message 条数 / notify.group 条数 / 未落地渠道跳过条数。
 *   证据十（自清理）：合成前缀 / 实体 id 全量精确清理（含投递留痕 / 激活表），零残留（finally 兜底）。
 *
 * 前置：真 PG（迁移器角色即可）+ 已构建的 server/dist（cd server && npm run build）；本回放不触外网
 *   （aibot 长连接走 stub socket 自动应答 —— 先例 m5-03-5-dm-replay.mjs）。
 * 用法：cd server && S7_4_WIRING_DATABASE_URL=postgresql://libiaolink_migrator@127.0.0.1:55432/libiaolink \
 *       node scripts/s7-4-automation-wiring-replay.mjs [--out <报告.md>] [--json <证据.json>] [--keep]
 * 退出码：断言全过 = 0，否则 = 1（可当门禁用）。
 * 说明：本机无 PG 时只做语法门禁；真机证据以 CI database job 为准（不伪造）。合成实体 id 全部由脚本生成、
 *   按 id / 前缀精确清理（--keep 时保留现场）；非本回放 pending job 临时推到远期并在收尾恢复，
 *   避免 M5-06 seed 的 per-rule job 混入调度领取统计。
 */
import { randomBytes, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import pg from "pg";

const HERE = dirname(fileURLToPath(import.meta.url));
const args = parseArgs(process.argv.slice(2));
const DATABASE_URL =
  args.databaseUrl ??
  process.env.S7_4_WIRING_DATABASE_URL ??
  process.env.S7_4_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql://libiaolink_migrator@127.0.0.1:55432/libiaolink";

/** 本回放合成 outbox 去重键前缀（清理 / 基线计数用）：证据专用，不落生产代码。 */
const OUTBOX_PREFIX = "s74wireReplay.";
const USER_PREFIX = "s74w-";
/** 单聊 aibot 机器人维度（M5-03-5-6：绑定行 / 激活表按 (bot_id, wecom_userid) 成对）—— stub 客户端与 AppConfig 同值。 */
const DM_STUB_BOT_ID = "bot-stub";
const JOB_REPLAY_TAG = "s74wire-replay";
const WORKER_ID = "s74wire-replay";
const HOUR_MS = 3_600_000;
/** 与 env 缺省同档（6h）：冷启动保护证据按它构造「过旧」行。 */
const EVENT_MAX_AGE_MS = 6 * HOUR_MS;
/** 固定时钟：上海 2026-09-24 20:00 —— A01（当日 19:30）触发已过且在窗口内。 */
const CLOCK_NOW = new Date("2026-09-24T12:00:00.000Z");
/** 调度窗口起点：上海 2026-09-24 00:00 —— 窗口 (起点, now] 覆盖当日全部触发时刻。 */
const JOB_WINDOW_START = new Date("2026-09-23T16:00:00.000Z");
/** 业务日（A01 上报基准日；上海 2026-09-24 周四 = 缺省工作日）。 */
const BUSINESS_DATE = "2026-09-24";

const report = [];
const evidence = { anchors: {}, checks: [] };
let pass = 0;
let fail = 0;
let runtime;
let db;

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (item === "--out") out.out = argv[++i];
    else if (item === "--json") out.json = argv[++i];
    else if (item === "--database-url") out.databaseUrl = argv[++i];
    else if (item === "--keep") out.keep = true;
  }
  return out;
}

function check(id, title, expected, actual, ok, extra = "") {
  if (ok) {
    pass += 1;
  } else {
    fail += 1;
  }
  report.push(
    "| " + (ok ? "PASS" : "FAIL") + " | " + id + " | " + title + " | 期望：" + expected + " | 实际：" + actual +
      (extra === "" ? "" : " | " + extra) + " |",
  );
  evidence.checks.push({ id, title, expected, actual, ok, extra });
  process.stdout.write((ok ? "PASS " : "FAIL ") + id + " " + title + String.fromCharCode(10));
}

function short(value, max = 320) {
  const text = JSON.stringify(value);
  return text === undefined ? "undefined" : text.length > max ? text.slice(0, max) + "..." : text;
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

function fmtJob(row) {
  if (row === null || row === undefined) return "（行不存在）";
  return (
    "status=" + row.status + " / attempts=" + row.attempts + " / locked_at=" + (row.locked_at === null ? "null" : "非空") +
    " / last_run_at=" + (row.last_run_at === null ? "null" : new Date(row.last_run_at).toISOString())
  );
}

/**
 * 假 socket（AibotSocket 替身 · 自动应答版 —— 先例 m5-03-5-dm-replay.mjs 假帧驱动面）：
 * send 即解析 req_id 并在下一 tick 回 errcode=0 回执（订阅 / 发送 / 心跳同形）→ stub 链路不触外网。
 */
function makeAutoAckSocket() {
  const socket = {
    sent: [],
    closed: false,
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
    send(data) {
      socket.sent.push(data);
      let reqId = null;
      try {
        reqId = JSON.parse(data)?.headers?.req_id ?? null;
      } catch {
        reqId = null;
      }
      if (typeof reqId !== "string") return;
      setTimeout(() => {
        if (socket.closed) return;
        socket.onmessage?.(JSON.stringify({ headers: { req_id: reqId }, errcode: 0, errmsg: "ok" }));
      }, 0);
    },
    close(code, reason) {
      if (socket.closed) return;
      socket.closed = true;
      socket.onclose?.(code ?? 1000, reason ?? "closed by replay");
    },
    open() {
      socket.onopen?.();
    },
  };
  return socket;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 加载 dist（真运行时类）；缺构建时给出明确指引。 */
async function loadRuntime() {
  await import("reflect-metadata");
  const load = (relative) => import(pathToFileURL(join(HERE, "..", "dist", relative)).href);
  try {
    const [
      envModule,
      configModule,
      databaseModule,
      clockModule,
      notifyRepositoryModule,
      notifyServiceModule,
      notifyStreamPublisherModule,
      notifyDmRepositoryModule,
      notifyDmServiceModule,
      notifyDeliveryModule,
      wecomAibotModule,
      wecomRateModule,
      notifyIndexModule,
      outboxModule,
      outboxStoreModule,
      dispatcherModule,
      policyModule,
      alertModule,
      jobsStoreModule,
      schedulerModule,
      subjectsModule,
      wiringModule,
      automationIndexModule,
      calendarServiceModule,
      calendarRepositoryModule,
      auditServiceModule,
      auditRepositoryModule,
    ] = await Promise.all([
      load("config/env.js"),
      load("config/config.module.js"),
      load("db/database.service.js"),
      load("common/clock/clock.service.js"),
      load("modules/notify/notify.repository.js"),
      load("modules/notify/notify.service.js"),
      load("modules/notify/notify.stream.publisher.js"),
      load("modules/notify/notify.dm.repository.js"),
      load("modules/notify/notify.dm.service.js"),
      load("modules/notify/notify.delivery.js"),
      load("modules/notify/wecom.aibot.js"),
      load("modules/notify/wecom.rate.js"),
      load("modules/notify/index.js"),
      load("db/outbox.js"),
      load("db/outbox.store.js"),
      load("outbox/dispatcher.js"),
      load("outbox/policy.js"),
      load("outbox/alert.js"),
      load("db/jobs.store.js"),
      load("outbox/scheduler.js"),
      load("outbox/automation-subjects.js"),
      load("outbox/automation-wiring.js"),
      load("modules/automation/index.js"),
      load("modules/calendar/calendar.service.js"),
      load("modules/calendar/calendar.repository.js"),
      load("modules/audit/audit.service.js"),
      load("modules/audit/audit.repository.js"),
    ]);
    return {
      loadEnv: envModule.loadEnv,
      AppConfig: configModule.AppConfig,
      DatabaseService: databaseModule.DatabaseService,
      ClockService: clockModule.ClockService,
      NotifyRepository: notifyRepositoryModule.NotifyRepository,
      NotifyService: notifyServiceModule.NotifyService,
      NotifyStreamPublisher: notifyStreamPublisherModule.NotifyStreamPublisher,
      NotifyDmRepository: notifyDmRepositoryModule.NotifyDmRepository,
      NotifyDmService: notifyDmServiceModule.NotifyDmService,
      channelOfNotifyPayload: notifyDeliveryModule.channelOfNotifyPayload,
      createWecomAibotClientFromEnv: wecomAibotModule.createWecomAibotClientFromEnv,
      InMemoryRateWindowStore: wecomRateModule.InMemoryRateWindowStore,
      NOTIFY_MESSAGE_TOPIC: notifyIndexModule.NOTIFY_MESSAGE_TOPIC,
      appendOutboxIfAbsent: outboxModule.appendOutboxIfAbsent,
      OutboxStore: outboxStoreModule.OutboxStore,
      OutboxDispatcher: dispatcherModule.OutboxDispatcher,
      resolveOutboxPolicies: policyModule.resolveOutboxPolicies,
      LogOutboxAlertSink: alertModule.LogOutboxAlertSink,
      JobsStore: jobsStoreModule.JobsStore,
      JobScheduler: schedulerModule.JobScheduler,
      AutomationSubjectReader: subjectsModule.AutomationSubjectReader,
      createRuleEventConsumers: wiringModule.createRuleEventConsumers,
      createAutomationScheduleHandler: wiringModule.createAutomationScheduleHandler,
      AUTOMATION_SCHEDULE_JOB_KIND: automationIndexModule.AUTOMATION_SCHEDULE_JOB_KIND,
      BUILTIN_RULES: automationIndexModule.BUILTIN_RULES,
      AutomationRuleRepository: automationIndexModule.AutomationRuleRepository,
      AutomationRunRepository: automationIndexModule.AutomationRunRepository,
      CalendarService: calendarServiceModule.CalendarService,
      CalendarRepository: calendarRepositoryModule.CalendarRepository,
      AuditService: auditServiceModule.AuditService,
      AuditRepository: auditRepositoryModule.AuditRepository,
    };
  } catch (error) {
    process.stderr.write("S7-4 接线：无法加载 server/dist（先执行 cd server && npm run build）：" + String(error) + "\n");
    process.exit(1);
  }
}

/** 回放环境：接线开启 + 冷启动阈值 6h + 投递不受免打扰 / 上限影响（上海 20:00 投递）。 */
function buildEnv(overrides = {}) {
  return runtime.loadEnv({
    ...process.env,
    DATABASE_URL,
    AUTOMATION_WIRING_ENABLED: "true",
    AUTOMATION_EVENT_MAX_AGE_MS: String(EVENT_MAX_AGE_MS),
    NOTIFY_QUIET_HOURS: "22:00-08:00",
    NOTIFY_DAILY_LIMIT: "200",
    NOTIFY_MERGE_WINDOW_MS: "1800000",
    WORKER_ID,
    ...overrides,
  });
}async function main() {
  runtime = await loadRuntime();
  db = new pg.Client({ connectionString: DATABASE_URL });
  await db.connect();

  const tag = randomBytes(4).toString("hex");
  const env = buildEnv({ WECOM_BOT_ID: DM_STUB_BOT_ID });
  const clock = new runtime.ClockService();
  clock.setSource(() => CLOCK_NOW);
  const config = new runtime.AppConfig(env);
  const database = new runtime.DatabaseService(config);
  // S8-3（M5-04-1）：投递在事务内 pg_notify 广播（本回放无 SSE 连接 → 事件静默丢弃，不影响投递断言）。
  const notify = new runtime.NotifyService(new runtime.NotifyRepository(database), database, config, clock, new runtime.NotifyStreamPublisher());
  const outboxStore = new runtime.OutboxStore(database);
  const jobsStore = new runtime.JobsStore(database);
  const calendar = new runtime.CalendarService(
    database,
    new runtime.CalendarRepository(database),
    new runtime.AuditService(database, new runtime.AuditRepository(database)),
    clock,
  );
  const subjects = new runtime.AutomationSubjectReader(database, calendar);
  const ruleRepository = new runtime.AutomationRuleRepository(database);
  const runRepository = new runtime.AutomationRunRepository(database);
  const replayRunKeys = new Set();
  const runPort = {
    insertIfAbsent: async (client, inputs) => {
      const inserted = await runRepository.insertIfAbsent(client, inputs);
      for (const input of inputs) {
        if (inserted.has(input.dedupeKey)) replayRunKeys.add(input.dedupeKey);
      }
      return inserted;
    },
  };

  // M5-03-5-4 接线段：单聊 aibot 消费（真 NotifyDmService + 真客户端 + stub socket 自动应答 —— 不触外网）。
  const dmSockets = [];
  const dmAibot = runtime.createWecomAibotClientFromEnv(
    {
      WECOM_BOT_WS_URL: "wss://stub.test/aibot",
      WECOM_BOT_ID: DM_STUB_BOT_ID,
      WECOM_BOT_SECRET: "secret-stub",
      WECOM_BOT_PING_INTERVAL_MS: 3_600_000,
      WECOM_BOT_ACK_TIMEOUT_MS: 1000,
      WECOM_BOT_RECONNECT_MIN_MS: 60_000,
      WECOM_BOT_RECONNECT_MAX_MS: 60_000,
      WECOM_BOT_RATE_LIMIT_PER_MINUTE: 30,
      WECOM_BOT_RATE_LIMIT_PER_HOUR: 1000,
    },
    {
      socketFactory: () => {
        const socket = makeAutoAckSocket();
        dmSockets.push(socket);
        return socket;
      },
      store: new runtime.InMemoryRateWindowStore(),
      now: () => CLOCK_NOW.getTime(),
    },
  ).aibot;
  // M5-03-5-6 / 契约刀：第 5 参 = AppConfig（`bot_id` 维度取值来源：config.env.WECOM_BOT_ID）；
  // 第 6 / 7 参 = 审计服务（解绑留痕 —— D6）与数据库（解绑事务）。真 AuditService 走真库（本回放不触解绑路径）。
  const audit = new runtime.AuditService(database, new runtime.AuditRepository(database));
  const dmNotify = new runtime.NotifyDmService(
    new runtime.NotifyDmRepository(database),
    dmAibot,
    notify,
    clock,
    config,
    audit,
    database,
  );
  dmAibot.start();
  dmSockets[0].open();
  /** 确定性等待订阅完成（stub 应答；超时即回放异常，不静默降级断言）。 */
  for (let waited = 0; dmAibot.getStats().state !== "subscribed"; waited += 10) {
    if (waited > 5000) throw new Error("stub aibot 未订阅成功（超时）");
    await sleep(10);
  }

  /** 接线日志（真装配 = Nest Logger；回放捕获以断言 warn 留痕）。 */
  const wiringLogs = { log: [], warn: [], error: [] };
  const wiringDeps = {
    env,
    subjects,
    append: runtime.appendOutboxIfAbsent,
    db: database.db,
    rules: async () => runtime.BUILTIN_RULES.map((rule) => ({ ...rule, enabled: true })),
    runs: runPort,
    transaction: (work) => database.db.transaction(work),
    now: () => clock.now(),
    shift: () => calendar.getSettings(),
    logger: {
      log: (line) => wiringLogs.log.push(line),
      warn: (line) => wiringLogs.warn.push(line),
      error: (line) => wiringLogs.error.push(line),
    },
  };
  /** 真分派器：规则事件主题全量 + notify.message 投递（与 OutboxModule 组合根同形 · M5-03-5-4 分流：
   *  wecom_aibot → NotifyDmService；其余（含 wecom_app —— 防御面证据）→ NotifyService；镜像 buildRegistry
   *  的 channelOfNotifyPayload 分流）。 */
  const registry = new Map();
  for (const [topic, handler] of runtime.createRuleEventConsumers(wiringDeps)) registry.set(topic, handler);
  registry.set(runtime.NOTIFY_MESSAGE_TOPIC, {
    handle: (row) =>
      runtime.channelOfNotifyPayload(row.payload) === "wecom_aibot" ? dmNotify.consume(row) : notify.consume(row),
  });
  const dispatcher = new runtime.OutboxDispatcher(
    outboxStore,
    registry,
    runtime.resolveOutboxPolicies(env),
    new runtime.LogOutboxAlertSink(),
    config,
    clock,
  );
  /** 真调度器：注册 automation-schedule.job 生产者（窗口 / 补发 / 单活锁全走运行时）。 */
  const scheduler = new runtime.JobScheduler(
    database,
    jobsStore,
    new Map([[runtime.AUTOMATION_SCHEDULE_JOB_KIND, runtime.createAutomationScheduleHandler(wiringDeps)]]),
    clock,
    config,
  );

  const cleanup = {
    keep: args.keep === true,
    userIds: [],
    projectIds: [],
    taskIds: [],
    issueIds: [],
    jobIds: [],
    outboxKeys: [],
    parkedJobs: [],
  };
  const parkUnrelatedPendingJobs = async () => {
    const found = await db.query("select id, run_at::text as run_at, updated_at::text as updated_at from jobs where status = 'pending' order by id");
    cleanup.parkedJobs.push(...found.rows);
    if (found.rows.length > 0) {
      await db.query(
        "update jobs set run_at = now() + interval '100 years', updated_at = now() where id = any($1::bigint[])",
        [found.rows.map((row) => row.id)],
      );
    }
    return found.rows.length;
  };
  const restoreParkedJobs = async () => {
    if (cleanup.parkedJobs.length > 0) {
      await db.query(
        "update jobs as j set run_at = v.run_at, updated_at = v.updated_at " +
          "from unnest($1::bigint[], $2::timestamptz[], $3::timestamptz[]) as v(id, run_at, updated_at) " +
          "where j.id = v.id",
        [
          cleanup.parkedJobs.map((row) => row.id),
          cleanup.parkedJobs.map((row) => row.run_at),
          cleanup.parkedJobs.map((row) => row.updated_at),
        ],
      );
    }
  };
  const trackedKey = (key) => {
    cleanup.outboxKeys.push(key);
    return key;
  };
  const insertOutbox = async (topic, payload, dedupeKey, createdAt) => {
    trackedKey(dedupeKey);
    await db.query(
      "insert into outbox_events (topic, payload, dedupe_key, status, available_at, created_at) values ($1, $2::jsonb, $3, 'pending', $4, $4)",
      [topic, JSON.stringify(payload), dedupeKey, createdAt],
    );
  };
  const outboxRow = async (dedupeKey) => {
    const result = await db.query("select id, topic, status, attempts, last_error, payload from outbox_events where dedupe_key = $1", [dedupeKey]);
    return result.rows[0] ?? null;
  };
  const notifyRowCount = async (dedupeKey) => {
    const result = await db.query("select count(*)::int as n from notifications where source_dedupe_key = $1", [dedupeKey]);
    return result.rows[0].n;
  };
  /** 本回放产出（收件人 ∈ 合成用户）的 notify.message 行数。 */
  const ourMessageCount = async () => {
    const result = await db.query(
      "select count(*)::int as n from outbox_events where topic = 'notify.message' and (payload->>'recipientId')::uuid = any($1::uuid[])",
      [cleanup.userIds],
    );
    return result.rows[0].n;
  };
  /** 本回放产出且 channel=wecom_aibot 的 notify.message 行数（M5-03-5-4）。 */
  const ourAibotCount = async () => {
    const result = await db.query(
      "select count(*)::int as n from outbox_events where topic = 'notify.message' and (payload->>'recipientId')::uuid = any($1::uuid[]) and payload->>'channel' = 'wecom_aibot'",
      [cleanup.userIds],
    );
    return result.rows[0].n;
  };
  /** 本回放 aibot 行的投递留痕（notify_deliveries · 按 outbox 幂等键 join）。 */
  const deliveriesFor = async (dedupeKey) => {
    const result = await db.query(
      "select d.channel, d.target, d.state, d.attempts, d.sent_at from notify_deliveries d join outbox_events e on e.id = d.outbox_id where e.dedupe_key = $1 order by d.id",
      [dedupeKey],
    );
    return result.rows;
  };
  /** 本回放合成目标的投递留痕行（计数 / 清理残留用）。 */
  const ourDeliveryRows = async () => {
    const result = await db.query("select state from notify_deliveries where target like $1", [USER_PREFIX + "%"]);
    return result.rows;
  };
  /** 激活表命中（旁证回填 D4 证据）。 */
  const activationFor = async (userid) => {
    const result = await db.query(
      "select user_id, first_activated_at, last_message_at from wecom_aibot_dm_activations where wecom_userid = $1",
      [userid],
    );
    return result.rows[0] ?? null;
  };
  const activationCount = async () => {
    const result = await db.query(
      "select count(*)::int as n from wecom_aibot_dm_activations where wecom_userid like $1",
      [USER_PREFIX + "%"],
    );
    return result.rows[0].n;
  };

  evidence.anchors = {
    tag,
    clockNow: CLOCK_NOW.toISOString(),
    jobWindowStart: JOB_WINDOW_START.toISOString(),
    businessDate: BUSINESS_DATE,
    eventMaxAgeMs: EVENT_MAX_AGE_MS,
    workerId: WORKER_ID,
    topics: [...registry.keys()].sort(),
  };

  try {
    // ---------------------------------------------------------------- 基线
    const usersBaseline = await db.query("select count(*)::int as n from users where username like $1", [USER_PREFIX + "%"]);
    const outboxBaseline = await db.query("select count(*)::int as n from outbox_events where dedupe_key like $1", [OUTBOX_PREFIX + "%"]);
    const jobsBaseline = await db.query("select count(*)::int as n from jobs where payload->>'replay' = $1", [JOB_REPLAY_TAG]);
    const deliveriesBaseline = (await ourDeliveryRows()).length;
    const activationsBaseline = await activationCount();
    check(
      "S0a",
      "基线：合成前缀（用户 / outbox 去重键 / 调度任务 / 投递留痕 / 激活表）无存量行（回放自清理）",
      "users=0 / outbox=0 / jobs=0 / deliveries=0 / activations=0",
      short({
        users: usersBaseline.rows[0].n,
        outbox: outboxBaseline.rows[0].n,
        jobs: jobsBaseline.rows[0].n,
        deliveries: deliveriesBaseline,
        activations: activationsBaseline,
      }),
      usersBaseline.rows[0].n === 0 &&
        outboxBaseline.rows[0].n === 0 &&
        jobsBaseline.rows[0].n === 0 &&
        deliveriesBaseline === 0 &&
        activationsBaseline === 0,
    );
    const calendarGuard = await db.query("select date::text as date from calendar_days where date between date '2026-09-22' and date '2026-09-25'");
    check(
      "S0b",
      "基线：回放日期窗口无日历例外（触发日确定性前提）",
      "calendar_days=0",
      "calendar_days=" + calendarGuard.rows.length + (calendarGuard.rows.length === 0 ? "" : " · " + short(calendarGuard.rows)),
      calendarGuard.rows.length === 0,
    );
    const parkedJobCount = await parkUnrelatedPendingJobs();
    const pendingBaseline = await db.query(
      "select (select count(*)::int from outbox_events where topic in ('task.completed','task.updated','task.progress_changed','change.applied','node.completed','report.submitted','issue.updated','notify.message') and status in ('pending','processing')) as outbox, (select count(*)::int from jobs where status = 'pending' and run_at <= now()) as jobs",
    );
    check(
      "S0c",
      "基线：注册主题无待领行、无到期任务（非本回放 pending job 已临时推到远期，收尾恢复）",
      "outbox=0 / jobs=0",
      short({ ...pendingBaseline.rows[0], parked: parkedJobCount }),
      pendingBaseline.rows[0].outbox === 0 && pendingBaseline.rows[0].jobs === 0,
    );
    // M5-06-1A 起运行时规则来源 = automation_rules（代码常量只供 seed / 本回放显式注入）。
    const activeRuleCodes = (await ruleRepository.listEnabledRules()).map((rule) => rule.code);
    check(
      "S0d",
      "生产规则启用集：仅 R02 / R03 / R05（本回放另行显式启用全部定义以验证保留实现）",
      "R02,R03,R05",
      activeRuleCodes.join(","),
      activeRuleCodes.join(",") === "R02,R03,R05",
    );

    // ---------------------------------------------------------------- 造数
    const users = await db.query(
      "insert into users (casdoor_id, username, display_name, status) values ($1, $1, $2, 'active'), ($3, $3, $4, 'active'), ($5, $5, $6, 'active') returning id",
      [
        USER_PREFIX + tag + "-owner",
        "S7-4 接线回放·责任人",
        USER_PREFIX + tag + "-manager",
        "S7-4 接线回放·项目经理",
        USER_PREFIX + tag + "-owner2",
        "S7-4 接线回放·次责任人",
      ],
    );
    cleanup.userIds = users.rows.map((row) => row.id);
    const owner = cleanup.userIds[0];
    const manager = cleanup.userIds[1];
    const owner2 = cleanup.userIds[2];
    const ownerUsername = USER_PREFIX + tag + "-owner";
    const owner2Username = USER_PREFIX + tag + "-owner2";
    // M5-03-5-6 绑定码口径：单聊可投递地址 = 绑定行（bot_id + 密文 open_userid）——
    // 本回放以 username 充当 stub 侧的 open_userid，直接播种绑定行（等价于「该用户已完成绑定」）。
    await db.query(
      "insert into wecom_aibot_dm_activations (bot_id, wecom_userid, user_id, bound_at) values ($1, $2, $3, $4), ($1, $5, $6, $4)",
      [DM_STUB_BOT_ID, ownerUsername, owner, CLOCK_NOW, owner2Username, owner2],
    );

    const projects = await db.query(
      "insert into projects (code, name, customer, region, project_type, manager_ids, stage_key, status, description, version) values ($1, $2, $3, 'shanghai', 'default', array[$4::uuid], 'presale', 'active', $5, 1), ($6, $7, $8, 'shanghai', 'default', array[$10::uuid], 'presale', 'active', $9, 1) returning id",
      [
        "S74W-" + tag + "-A",
        "临港数据中心",
        "合成客户",
        owner,
        "S7-4 接线回放项目 A",
        "S74W-" + tag + "-B",
        "张江机房",
        "合成客户",
        "S7-4 接线回放项目 B",
        owner2,
      ],
    );
    const projectA = projects.rows[0].id;
    const projectB = projects.rows[1].id;
    cleanup.projectIds = [projectA, projectB];
    await db.query(
      "insert into project_members (project_id, user_id, role_in_project) values ($1, $2, 'project_member'), ($3, $2, 'project_member')",
      [projectA, owner, projectB],
    );

    const tasks = await db.query(
      "insert into tasks (project_id, stage_key, sort_index, title, status, progress, priority, owner_ids, deliverable_types, version, planned_start, planned_end, actual_end) values ($1, 'presale', 0, $2, 'done', 1, '高', array[$3::uuid], array['CAD图纸'], 5, null, null, null), ($6, 'presale', 1, $4, 'done', 1, '高', array[$5::uuid], array['CAD图纸'], 1, null, null, null) returning id, version",
      [projectA, "安装摄像头", owner, "机房布线", owner2, projectB],
    );
    cleanup.taskIds = tasks.rows.map((row) => row.id);
    const taskA = cleanup.taskIds[0];
    const taskB = cleanup.taskIds[1];

    const issues = await db.query(
      "insert into issues (project_id, title, categories, state, reporter_id, owner_id, raised_at) values ($1, $2, array['其它原因'], 'open', $3, $4, date '2026-09-20') returning id",
      [projectA, "现场漏水", manager, owner],
    );
    cleanup.issueIds = issues.rows.map((row) => row.id);
    const issue = cleanup.issueIds[0];

    const job = await db.query(
      "insert into jobs (kind, payload, cron, run_at, last_run_at) values ($1, $2::jsonb, null, $3, $3) returning id",
      [runtime.AUTOMATION_SCHEDULE_JOB_KIND, JSON.stringify({ replay: JOB_REPLAY_TAG, tag }), JOB_WINDOW_START],
    );
    cleanup.jobIds = [Number(job.rows[0].id)];
    const jobId = cleanup.jobIds[0];

    const r02TaskAKey = trackedKey("R02:" + taskA + ":v" + tasks.rows[0].version);
    const r02TaskBKey = trackedKey("R02:" + taskB + ":v" + tasks.rows[1].version);
    const a01Key = trackedKey("A01:" + owner + ":" + BUSINESS_DATE);
    const wecomKey = trackedKey(OUTBOX_PREFIX + tag + ".chan.wecom");

    // --------------------------------------------- 证据一：事件链（R02 全链）
    await insertOutbox("task.completed", { taskId: taskA }, OUTBOX_PREFIX + tag + ".evt.task-completed", new Date(CLOCK_NOW.getTime() - 60_000));
    const drain1 = await dispatcher.drainOnce();
    const eventRow1 = await outboxRow(OUTBOX_PREFIX + tag + ".evt.task-completed");
    check(
      "S1a",
      "事件领取：task.completed 行经真领取器消费完成（claimed=1 / done=1）",
      "status=done / claimed=1 / done=1 / dead=0",
      short({ status: eventRow1?.status, ...drain1 }),
      eventRow1?.status === "done" && drain1.claimed === 1 && drain1.done === 1 && drain1.dead === 0,
    );
    const produced1 = await outboxRow(r02TaskAKey);
    const payload1 = produced1?.payload ?? {};
    check(
      "S1b",
      "R02 命中产出：notify.message 载荷全字段（收件人 / 类型 / 渠道 / 模板 / 关联对象 / 合并键）",
      "recipient=owner / type=reminder / channel=inbox / R02_INBOX / ref=task:" + taskA + " / mergeKey=幂等键",
      short({
        recipient: payload1.recipientId === owner,
        type: payload1.type,
        channel: payload1.channel,
        template: payload1.templateCode,
        ref: payload1.refType + "/" + payload1.refId,
        mergeKey: payload1.mergeKey === r02TaskAKey,
      }),
      produced1?.topic === "notify.message" &&
        payload1.recipientId === owner &&
        payload1.type === "reminder" &&
        payload1.channel === "inbox" &&
        payload1.templateCode === "R02_INBOX" &&
        payload1.refType === "task" &&
        payload1.refId === taskA &&
        payload1.mergeKey === r02TaskAKey,
    );
    check(
      "S1c",
      "R02 文案渲染：模板标题 / 正文含任务描述（引擎按主体快照渲染）",
      "标题=及时添加文件 / 正文含「安装摄像头」",
      short({ title: payload1.title, body: payload1.body }),
      payload1.title === "及时添加文件" && String(payload1.body).includes("安装摄像头"),
    );
    const drain2 = await dispatcher.drainOnce();
    const notification1 = await db.query(
      "select id, recipient_id, title, status, ref_type, ref_id, template_code, merge_key, source_topic, delivered_at from notifications where source_dedupe_key = $1",
      [r02TaskAKey],
    );
    const notification1Row = notification1.rows[0] ?? null;
    const delivery1 = await deliveriesFor(r02TaskAKey + ":aibot");
    const activation1 = await activationFor(ownerUsername);
    check(
      "S1d",
      "投递落库：notify.message 双行分流消费（inbox → notifications 一行；wecom_aibot → 读绑定行寻址（M5-03-5-6）→ 单聊发送（stub 应答 errcode=0）→ notify_deliveries sent 行）",
      "claimed=2 / done=2 / notifications=1 行 / deliveries sent=1（channel=wecom_aibot · target=绑定行 wecom_userid = 责任人）/ 绑定行 user_id=责任人",
      short({
        ...drain2,
        rows: notification1.rows.length,
        delivered: notification1Row?.delivered_at !== null,
        deliveries: delivery1,
        activation: activation1 !== null,
      }),
      drain2.claimed === 2 &&
        drain2.done === 2 &&
        notification1.rows.length === 1 &&
        notification1Row?.delivered_at !== null &&
        notification1Row?.source_topic === "notify.message" &&
        delivery1.length === 1 &&
        delivery1[0].channel === "wecom_aibot" &&
        delivery1[0].state === "sent" &&
        delivery1[0].target === ownerUsername &&
        delivery1[0].sent_at !== null &&
        activation1?.user_id === owner,
    );
    const inbox1 = await notify.list(owner, { page: 1, limit: 50 });
    check(
      "S1e",
      "收件箱读面：规则产出的站内信立即可见（total / unreadCount / 关联对象）",
      "total=1 / unreadCount=1 / refType=task",
      short({ total: inbox1.total, unread: inbox1.unreadCount, ref: inbox1.items[0]?.refType }),
      inbox1.total === 1 && inbox1.unreadCount === 1 && inbox1.items[0]?.refType === "task",
    );
    const aibotRow1 = await outboxRow(r02TaskAKey + ":aibot");
    const appRow1After = await outboxRow(r02TaskAKey + ":app");
    check(
      "S1f",
      "aibot 产出接线（M5-03-5-4）：R02 第二动作 wecom_aibot → :aibot 行（模板码 R02_WECOM · 收件人=责任人）且已分流消费为 done；无「渠道未落地」warn；同规则 inbox + aibot 双产行",
      "aibot 行存在（status=done · channel=wecom_aibot · R02_WECOM）/ 无 :app 行 / 无渠道未落地 warn / notify.message=2",
      short({
        aibot: aibotRow1 !== null,
        status: aibotRow1?.status,
        channel: aibotRow1?.payload?.channel,
        template: aibotRow1?.payload?.templateCode,
        app: appRow1After !== null,
        skipWarn: wiringLogs.warn.some((line) => line.includes("渠道未落地")),
        messages: await ourMessageCount(),
      }),
      aibotRow1 !== null &&
        aibotRow1.status === "done" &&
        aibotRow1.payload?.channel === "wecom_aibot" &&
        aibotRow1.payload?.templateCode === "R02_WECOM" &&
        aibotRow1.payload?.recipientId === owner &&
        appRow1After === null &&
        !wiringLogs.warn.some((line) => line.includes("渠道未落地")) &&
        (await ourMessageCount()) === 2,
    );

    // --------------------------------- 证据二：冷启动保护（过旧拦截 / 新建对照）
    await insertOutbox("task.completed", { taskId: taskB }, OUTBOX_PREFIX + tag + ".evt.cold", new Date(CLOCK_NOW.getTime() - EVENT_MAX_AGE_MS - HOUR_MS));
    const drain3 = await dispatcher.drainOnce();
    const coldRow = await outboxRow(OUTBOX_PREFIX + tag + ".evt.cold");
    const coldProduced = await outboxRow(r02TaskBKey);
    check(
      "S2",
      "冷启动保护：行创建时刻超 AUTOMATION_EVENT_MAX_AGE_MS → done、零产出（event_too_old 留痕）",
      "status=done / claimed=1 / done=1 / R02 幂等键无产出",
      short({
        status: coldRow?.status,
        ...drain3,
        produced: coldProduced !== null,
        tooOld: wiringLogs.log.some((line) => line.includes("event_too_old")),
      }),
      coldRow?.status === "done" &&
        drain3.claimed === 1 &&
        drain3.done === 1 &&
        coldProduced === null &&
        wiringLogs.log.some((line) => line.includes("event_too_old")),
    );
    await insertOutbox("task.completed", { taskId: taskB }, OUTBOX_PREFIX + tag + ".evt.fresh", new Date(CLOCK_NOW.getTime() - 60_000));
    const drain4 = await dispatcher.drainOnce();
    const freshProduced = await outboxRow(r02TaskBKey);
    check(
      "S2b",
      "对照组：同载荷新事件（60s 前）正常产出（证明拦截判据 = 事件年龄）",
      "claimed=1 / done=1 / 产出 R02 行（收件人=次责任人）",
      short({ ...drain4, produced: freshProduced !== null, recipient: freshProduced?.payload?.recipientId === owner2 }),
      drain4.claimed === 1 && drain4.done === 1 && freshProduced !== null && freshProduced.payload?.recipientId === owner2,
    );
    const drain4b = await dispatcher.drainOnce();
    const deliveryB = await deliveriesFor(r02TaskBKey + ":aibot");
    check(
      "S2c",
      "对照组落库：次责任人收件箱 1 条 + aibot sent 行（inbox / aibot 双行分流消费）",
      "claimed=2 / done=2 / notifications=1 行 / deliveries sent=1（channel=wecom_aibot · target=次责任人 userid）",
      short({ ...drain4b, rows: await notifyRowCount(r02TaskBKey), deliveries: deliveryB }),
      drain4b.claimed === 2 &&
        drain4b.done === 2 &&
        (await notifyRowCount(r02TaskBKey)) === 1 &&
        deliveryB.length === 1 &&
        deliveryB[0].state === "sent" &&
        deliveryB[0].channel === "wecom_aibot" &&
        deliveryB[0].target === owner2Username,
    );

    // ----------------------------------------- 证据三：主体不可解析 → dead
    const ghostTaskId = randomUUID();
    await insertOutbox("task.completed", { taskId: ghostTaskId }, OUTBOX_PREFIX + tag + ".evt.ghost", new Date(CLOCK_NOW.getTime() - 60_000));
    const messagesBeforeGhost = await ourMessageCount();
    const drain5 = await dispatcher.drainOnce();
    const ghostRow = await outboxRow(OUTBOX_PREFIX + tag + ".evt.ghost");
    check(
      "S3",
      "主体不可解析：taskId 不存在 → dead（确定性失败一次即弃）、零产出",
      "status=dead / claimed=1 / dead=1 / 产出数不变",
      short({ status: ghostRow?.status, error: ghostRow?.last_error, ...drain5, messages: await ourMessageCount() }),
      ghostRow?.status === "dead" &&
        String(ghostRow?.last_error).includes("主体不可解析") &&
        drain5.claimed === 1 &&
        drain5.dead === 1 &&
        (await ourMessageCount()) === messagesBeforeGhost,
    );

    // ------------------------------------- 证据四：无事件型规则订阅 → 直接完成
    const messagesBeforeIssueTopic = await ourMessageCount();
    await insertOutbox("issue.updated", { issueId: issue }, OUTBOX_PREFIX + tag + ".evt.issue-updated", new Date(CLOCK_NOW.getTime() - 60_000));
    const drain6 = await dispatcher.drainOnce();
    const issueTopicRow = await outboxRow(OUTBOX_PREFIX + tag + ".evt.issue-updated");
    check(
      "S4",
      "无事件型规则订阅：issue.updated → 直接消费完成、零产出（不产无主通知）",
      "status=done / claimed=1 / done=1 / 产出数不变",
      short({ status: issueTopicRow?.status, ...drain6, messages: await ourMessageCount() }),
      issueTopicRow?.status === "done" &&
        drain6.claimed === 1 &&
        drain6.done === 1 &&
        (await ourMessageCount()) === messagesBeforeIssueTopic,
    );

    // ------------------------------------- 证据五：渠道护栏（M5-03 前非 inbox）
    await insertOutbox(
      "notify.message",
      { recipientId: owner, type: "reminder", channel: "wecom_app", title: "企微提醒", body: "M5-03 未落地前不得静默当站内信投递" },
      wecomKey,
      new Date(CLOCK_NOW.getTime() - 60_000),
    );
    const drain7 = await dispatcher.drainOnce();
    const wecomRow = await outboxRow(wecomKey);
    check(
      "S5",
      "渠道护栏（防御）：channel=wecom_app 原始行（本回放注册表未接应用分支）→ NotifyService 确定性 dead、零落库（生产装配按 channel 分流至 NotifyAppService）",
      "status=dead / claimed=1 / dead=1 / notifications=0 / error 含「非 inbox」",
      short({ status: wecomRow?.status, error: wecomRow?.last_error, ...drain7, rows: await notifyRowCount(wecomKey) }),
      wecomRow?.status === "dead" &&
        String(wecomRow?.last_error).includes("非 inbox") &&
        drain7.claimed === 1 &&
        drain7.dead === 1 &&
        (await notifyRowCount(wecomKey)) === 0,
    );

    // ------------------------- 证据六/七：调度窗口（A01 应填未填 + 同人多项目合并）
    const tick1 = await scheduler.tickOnce();
    const jobAfter = (await db.query("select id, kind, status, attempts, last_run_at, locked_by, locked_at, cron from jobs where id = $1", [jobId])).rows[0] ?? null;
    const runs1 = (await db.query("select status, window_from, window_to, fire_count, produced, note from job_runs where job_id = $1 order by id", [jobId])).rows;
    check(
      "S6a",
      "调度领取与推进：真 tick 领取 automation-schedule.job → 执行、last_run_at 推进到 now、锁清空",
      "lockAcquired / claimed=1 / executed=1 / status=done / last_run_at=" + CLOCK_NOW.toISOString(),
      short({ ...tick1, job: fmtJob(jobAfter) }),
      tick1.lockAcquired === true &&
        tick1.claimed === 1 &&
        tick1.executed === 1 &&
        jobAfter?.status === "done" &&
        new Date(jobAfter?.last_run_at).getTime() === CLOCK_NOW.getTime() &&
        jobAfter?.locked_at === null,
    );
    check(
      "S6b",
      "job_runs 留痕：executed / fire_count=1 / produced=2（A01 inbox + aibot 双产 · M5-03-5-4）/ note 含主体数与渠道计数",
      "1 行 / executed / produced=2 / note 含「主体 4」与「notify.message 2 条 / notify.group 0 条 / 未落地渠道跳过 0 条」",
      short(runs1),
      runs1.length === 1 &&
        runs1[0]?.status === "executed" &&
        runs1[0]?.produced === 2 &&
        runs1[0]?.fire_count === 1 &&
        String(runs1[0]?.note).includes("主体 4") &&
        String(runs1[0]?.note).includes("notify.message 2 条") &&
        String(runs1[0]?.note).includes("notify.group 0 条") &&
        String(runs1[0]?.note).includes("未落地渠道跳过 0 条"),
    );
    const a01Row = await outboxRow(a01Key);
    const a01Payload = a01Row?.payload ?? {};
    check(
      "S6c",
      "A01 合并产出：同一人名下两项目合并一条（收件人粒度幂等键 + 项目清单文案 + 无单一关联对象）",
      "A01:{owner}:2026-09-24 / refType=null / A01_INBOX_MERGED / 正文含两项目名",
      short({ key: a01Row !== null, ref: a01Payload.refType, template: a01Payload.templateCode, body: a01Payload.body }),
      a01Row !== null &&
        a01Payload.recipientId === owner &&
        a01Payload.refType === null &&
        a01Payload.refId === null &&
        a01Payload.templateCode === "A01_INBOX_MERGED" &&
        String(a01Payload.body).includes("临港数据中心") &&
        String(a01Payload.body).includes("张江机房"),
    );
    const drain8 = await dispatcher.drainOnce();
    const a01AibotRow = await outboxRow(a01Key + ":aibot");
    const deliveryA01 = await deliveriesFor(a01Key + ":aibot");
    const inboxOwner = await notify.list(owner, { page: 1, limit: 50 });
    const ownerTemplates = inboxOwner.items.map((item) => item.templateCode).sort();
    check(
      "S6d",
      "调度产出消费：A01 双行分流（inbox 落行 → 责任人收件箱共 2 条；wecom_aibot → A01_WECOM_MERGED 行 sent）",
      "claimed=2 / done=2 / total=2 / unreadCount=2 / 模板集命中 / deliveryA01 sent（target=责任人 userid）",
      short({
        ...drain8,
        total: inboxOwner.total,
        unread: inboxOwner.unreadCount,
        templates: ownerTemplates,
        aibotTemplate: a01AibotRow?.payload?.templateCode,
        deliveries: deliveryA01,
      }),
      drain8.claimed === 2 &&
        drain8.done === 2 &&
        inboxOwner.total === 2 &&
        inboxOwner.unreadCount === 2 &&
        JSON.stringify(ownerTemplates) === JSON.stringify(["A01_INBOX_MERGED", "R02_INBOX"]) &&
        a01AibotRow?.payload?.templateCode === "A01_WECOM_MERGED" &&
        a01AibotRow?.payload?.recipientId === owner &&
        deliveryA01.length === 1 &&
        deliveryA01[0].state === "sent" &&
        deliveryA01[0].target === ownerUsername,
    );
    check(
      "S6e",
      "渠道落地口径（证据九 · M5-03-5-4 接线段）：wecom_aibot 产出已接线（R02 ×2 + A01 ×1 = :aibot 行 3）且 stub 消费全 sent；无「渠道未落地」warn（channelSkipped=0 · 仅余 email）",
      "渠道未落地 warn=0 / notify.message=7（aibot=3）/ deliveries sent=3 / activations=2",
      short({
        skipWarn: wiringLogs.warn.filter((line) => line.includes("渠道未落地")).length,
        messages: await ourMessageCount(),
        aibot: await ourAibotCount(),
        deliveries: (await ourDeliveryRows()).map((row) => row.state),
        activations: await activationCount(),
      }),
      wiringLogs.warn.filter((line) => line.includes("渠道未落地")).length === 0 &&
        (await ourMessageCount()) === 7 &&
        (await ourAibotCount()) === 3 &&
        (await ourDeliveryRows()).length === 3 &&
        (await ourDeliveryRows()).every((row) => row.state === "sent") &&
        (await activationCount()) === 2,
    );
    // ------------------------------------- 证据八：同窗口重放（幂等键兜底不重发）
    await db.query(
      "update jobs set status = 'pending', run_at = $2, last_run_at = $2, attempts = 0, locked_at = null, locked_by = null where id = $1",
      [jobId, JOB_WINDOW_START],
    );
    const messagesBeforeReplay = await ourMessageCount();
    const tick2 = await scheduler.tickOnce();
    const runs2 = (await db.query("select status, produced, note from job_runs where job_id = $1 order by id", [jobId])).rows;
    const a01Replay = await outboxRow(a01Key);
    check(
      "S7",
      "窗口重放：任务再执行、产出幂等键已存在 → 不新增行（appendOutboxIfAbsent 兜底）、job_runs 如实留痕",
      "executed=1 / 产出数不变 / job_runs=2 行（均 executed）",
      short({ ...tick2, messages: await ourMessageCount(), runs: runs2.length, lastProduced: runs2[1]?.produced }),
      tick2.executed === 1 &&
        (await ourMessageCount()) === messagesBeforeReplay &&
        runs2.length === 2 &&
        runs2[1]?.status === "executed" &&
        a01Replay !== null,
    );
    const inboxAfterReplay = await notify.list(owner, { page: 1, limit: 50 });
    check(
      "S7b",
      "重放不重发（读面）：责任人收件箱仍 2 条（无重复通知）",
      "total=2 / unreadCount=2",
      short({ total: inboxAfterReplay.total, unread: inboxAfterReplay.unreadCount }),
      inboxAfterReplay.total === 2 && inboxAfterReplay.unreadCount === 2,
    );
  } finally {
    try {
      await restoreParkedJobs();
      check(
        "S9a",
        "非本回放 pending job 原值恢复",
        "恢复 " + cleanup.parkedJobs.length + " 条",
        "已恢复",
        true,
      );
    } catch (error) {
      check(
        "S9a",
        "非本回放 pending job 原值恢复",
        "恢复 " + cleanup.parkedJobs.length + " 条",
        "恢复失败：" + messageOf(error),
        false,
      );
    }
    try {
      if (!cleanup.keep) {
        const userIds = cleanup.userIds;
        const produced = await db
          .query("select dedupe_key from outbox_events where topic = 'notify.message' and (payload->>'recipientId')::uuid = any($1::uuid[])", [userIds])
          .catch(() => ({ rows: [] }));
        const keys = [...new Set([...cleanup.outboxKeys, ...produced.rows.map((row) => row.dedupe_key)])];
        if (keys.length > 0) {
          await db.query("delete from notifications where source_dedupe_key = any($1::text[])", [keys]);
          await db.query("delete from outbox_events where dedupe_key = any($1::text[])", [keys]);
        }
        if (userIds.length > 0) {
          await db.query("delete from notifications where recipient_id = any($1::uuid[])", [userIds]);
          await db.query("delete from notify_deliveries where target like $1", [USER_PREFIX + "%"]);
          await db.query("delete from wecom_aibot_dm_activations where wecom_userid like $1", [USER_PREFIX + "%"]);
        }
        if (cleanup.jobIds.length > 0) {
          await db.query("delete from jobs where id = any($1::bigint[])", [cleanup.jobIds]);
        }
        if (replayRunKeys.size > 0) {
          await db.query("delete from automation_runs where dedupe_key = any($1::text[])", [[...replayRunKeys]]);
        }
        if (cleanup.projectIds.length > 0) {
          await db.query("delete from project_members where project_id = any($1::uuid[])", [cleanup.projectIds]);
        }
        if (cleanup.issueIds.length > 0) {
          await db.query("delete from issues where id = any($1::uuid[])", [cleanup.issueIds]);
        }
        if (cleanup.taskIds.length > 0) {
          await db.query("delete from tasks where id = any($1::uuid[])", [cleanup.taskIds]);
        }
        if (cleanup.projectIds.length > 0) {
          await db.query("delete from projects where id = any($1::uuid[])", [cleanup.projectIds]);
        }
        if (userIds.length > 0) {
          await db.query("delete from users where id = any($1::uuid[]) and username like $2", [userIds, USER_PREFIX + "%"]);
        }
      }
      const residueUsers = await db.query("select count(*)::int as n from users where username like $1", [USER_PREFIX + "%"]);
      const residueOutbox = await db.query("select count(*)::int as n from outbox_events where dedupe_key like $1", [OUTBOX_PREFIX + "%"]);
      const residueJobs = await db.query("select count(*)::int as n from jobs where payload->>'replay' = $1", [JOB_REPLAY_TAG]);
      const residueRuns = await db.query("select count(*)::int as n from automation_runs where dedupe_key = any($1::text[])", [[...replayRunKeys]]);
      const residueMessages = cleanup.userIds.length === 0 ? 0 : await ourMessageCount();
      const residueNotifications =
        cleanup.userIds.length === 0
          ? 0
          : (await db.query("select count(*)::int as n from notifications where recipient_id = any($1::uuid[])", [cleanup.userIds])).rows[0].n;
      const residueDeliveries = (await ourDeliveryRows()).length;
      const residueActivations = await activationCount();
      check(
        "S9",
        "自清理：合成前缀 / 实体 / 运行记录零残留（--keep 时保留现场、仅留痕）",
        cleanup.keep ? "keep=true（不清理）" : "users=0 / outbox=0 / jobs=0 / runs=0 / notifications=0 / deliveries=0 / activations=0",
        short({
          users: residueUsers.rows[0].n,
          outbox: residueOutbox.rows[0].n,
          jobs: residueJobs.rows[0].n,
          runs: residueRuns.rows[0].n,
          messages: residueMessages,
          notifications: residueNotifications,
          deliveries: residueDeliveries,
          activations: residueActivations,
          keep: cleanup.keep,
        }),
        cleanup.keep ||
          (residueUsers.rows[0].n === 0 &&
            residueOutbox.rows[0].n === 0 &&
            residueJobs.rows[0].n === 0 &&
            residueRuns.rows[0].n === 0 &&
            residueMessages === 0 &&
            residueNotifications === 0 &&
            residueDeliveries === 0 &&
            residueActivations === 0),
      );
    } catch (error) {
      check("S9", "自清理：合成前缀 / 实体零残留", "清理成功", "清理失败：" + messageOf(error), false);
    }
    await dmAibot.stop().catch(() => {});
    await db.end().catch(() => {});
  }
}

function writeReports() {
  const summary = "S7-4 接线回放汇总：PASS " + pass + " / FAIL " + fail + "（合成 outbox 前缀 " + OUTBOX_PREFIX + "）";
  if (args.out !== undefined) {
    writeFileSync(
      args.out,
      "# S7-4 · M5-02 接线段 真机回放证据（事件消费 + 调度产出 → notify.message · M5-03-5-4 aibot 产出 / 分流消费）\n\n" +
        "| 结果 | 编号 | 断言 | 期望 | 实际 | 备注 |\n|---|---|---|---|---|---|\n" +
        report.join("\n") +
        "\n\n" + summary + "\n\n锚点：" + short(evidence.anchors) + "\n",
      "utf8",
    );
  }
  if (args.json !== undefined) {
    writeFileSync(args.json, JSON.stringify({ anchors: evidence.anchors, checks: evidence.checks, pass, fail }, null, 2), "utf8");
  }
  process.stdout.write("\n" + summary + "\n");
}

try {
  await main();
} catch (error) {
  fail += 1;
  process.stderr.write("S7-4 接线回放异常：" + messageOf(error) + "\n");
}

writeReports();
process.exit(fail === 0 ? 0 : 1);
