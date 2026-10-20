#!/usr/bin/env node
/**
 * M5-04-2 · S8-3 真机回放（稍后提醒 · C5-05）：端到端验证「HTTP 三件套 + 迁移 0045 数据面 + 触发循环 + SSE 联动」。
 *   证据一（设置）：POST /snooze → 200 + 置读 + snoozeUntil（毫秒截断到秒）+ 记录一条 + `unread` 广播（角标 -1）。
 *   证据二（覆盖）：重复设置 → 旧记录 cancelledAt + 新记录；记录读面按 id 降序。
 *   证据三（取消）：DELETE 幂等 200（无未触发也 200）+ 清 snoozeUntil + 活跃记录回填 cancelledAt。
 *   证据四（404 族）：他人行 / 合并子行 / 未投递行统一 404。
 *   证据五（范围校验）：过近 / 过远 400；毫秒截断到秒后校验（+5min+1.5s → +5min+1s 合法）。
 *   证据六（到点触发）：flushSnoozes 置回 unread + 清 snoozeUntil + 记录回填 triggeredAt + SSE 收
 *     `notification`（同 id 原行，deliveredAt 留档）与 `unread`；不新增通知行、不消耗每日上限。
 *   证据七（免打扰顺延）：到点落免打扰时段 → snoozeUntil 推到时段结束、不发事件；时段结束后触发。
 *   证据八（handled 照提醒）：handled 行可设置（置读）→ 等待期间重标 handled → 到点仍置回 unread。
 *   证据九（自清理）：本脚本合成前缀零残留（finally 兜底，--keep 时保留现场）。
 *
 * 前置：真 PG（迁移器角色即可，需已应用 0045）+ 已构建的 server/dist + **已起 api**（CI database job 内；
 *   触发由本脚本直调 dist 的 `notify.flushSnoozes()` —— CI 只起 api 不起 worker，到点用 SQL 把 snooze_until 拨到过去）。
 * 用法：cd server && M5_04_2_DATABASE_URL=postgresql://libiaolink_migrator@127.0.0.1:55432/libiaolink \
 *       M5_04_2_BASE_URL=http://127.0.0.1:3011 node scripts/m5-04-2-snooze-replay.mjs [--out <报告.md>] [--json <证据.json>] [--keep]
 * 退出码：断言全过 = 0，否则 = 1（可当门禁用）。
 * 说明：本机无 PG 时只做语法门禁；真机证据以 CI database job 为准（不伪造）。合成用户名 / 去重键前缀独立。
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import pg from "pg";

const HERE = dirname(fileURLToPath(import.meta.url));
const args = parseArgs(process.argv.slice(2));
const DATABASE_URL =
  args.databaseUrl ??
  process.env.M5_04_2_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql://libiaolink_migrator@127.0.0.1:55432/libiaolink";
const BASE_URL = args.baseUrl ?? process.env.M5_04_2_BASE_URL ?? "http://127.0.0.1:3011";

const DEDUPE_PREFIX = "m5042Replay";
const USER_PREFIX = "m5042rpl-";
const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

const report = [];
const evidence = { anchors: {}, checks: [] };
let pass = 0;
let fail = 0;
let runtime;
let db;
const streams = [];
const cleanup = { userIds: [], tokenHashes: [], keep: args.keep === true };

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (item === "--out") out.out = argv[++i];
    else if (item === "--json") out.json = argv[++i];
    else if (item === "--database-url") out.databaseUrl = argv[++i];
    else if (item === "--base-url") out.baseUrl = argv[++i];
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
  process.stdout.write((ok ? "PASS " : "FAIL ") + id + " " + title + "\n");
  if (!ok) {
    process.stdout.write("  → 期望：" + expected + " / 实际：" + actual + (extra === "" ? "" : " / " + extra) + "\n");
  }
}

function short(value, max = 320) {
  const text = JSON.stringify(value);
  return text === undefined ? "undefined" : text.length > max ? text.slice(0, max) + "..." : text;
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 最小 SSE 客户端：逐块解析事件帧（event + data）与注释行（心跳），支持按条件等待。 */
class SseStream {
  constructor(name, cookie) {
    this.name = name;
    this.cookie = cookie;
    this.status = 0;
    this.events = [];
    this.comments = [];
    this.buffer = "";
    this.controller = null;
    this.reader = null;
    this.decoder = new TextDecoder();
  }

  async open() {
    this.controller = new AbortController();
    const response = await fetch(BASE_URL + "/api/v1/notifications/stream", {
      headers: { accept: "text/event-stream", cookie: this.cookie },
      signal: this.controller.signal,
    });
    this.status = response.status;
    if (this.status === 200 && response.body !== null) {
      this.reader = response.body.getReader();
      void this.pump();
    }
    return this;
  }

  async pump() {
    try {
      for (;;) {
        const { done, value } = await this.reader.read();
        if (done) break;
        this.ingest(this.decoder.decode(value, { stream: true }));
      }
    } catch {
      // abort / 连接关闭：正常收尾路径
    }
  }

  ingest(text) {
    this.buffer += text;
    let index = this.buffer.indexOf("\n\n");
    while (index >= 0) {
      const block = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 2);
      this.handleBlock(block);
      index = this.buffer.indexOf("\n\n");
    }
  }

  handleBlock(block) {
    let type = null;
    const dataLines = [];
    for (const raw of block.split("\n")) {
      const line = raw.replace(/\r$/, "");
      if (line.startsWith(":")) {
        this.comments.push(line);
      } else if (line.startsWith("event:")) {
        type = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trim());
      }
    }
    if (type !== null && dataLines.length > 0) {
      const text = dataLines.join("\n");
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        data = { raw: text };
      }
      this.events.push({ type, data });
    }
  }

  async waitForEvent(type, predicate = () => true, timeoutMs = 10_000, note = "") {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const hit = this.events.find((item) => item.type === type && predicate(item.data));
      if (hit !== undefined) return hit;
      if (Date.now() >= deadline) {
        throw new Error(
          this.name + " 等待事件超时：" + type + "（" + timeoutMs + "ms；已收 " + this.events.length + " 条：" +
            this.events.map((item) => item.type).join(",") + (note === "" ? "" : "；诊断：" + note) + "）",
        );
      }
      await sleep(50);
    }
  }

  close() {
    try {
      this.controller?.abort();
    } catch {
      // 已关闭
    }
  }
}

/** 加载 dist（真运行时类）；缺构建时给出明确指引。 */
async function loadRuntime() {
  await import("reflect-metadata");
  const load = (relative) => import(pathToFileURL(join(HERE, "..", "dist", relative)).href);
  try {
    const [envModule, configModule, databaseModule, clockModule, repositoryModule, archiveModule, serviceModule, publisherModule, deliveryModule] =
      await Promise.all([
        load("config/env.js"),
        load("config/config.module.js"),
        load("db/database.service.js"),
        load("common/clock/clock.service.js"),
        load("modules/notify/notify.repository.js"),
        load("modules/notify/notify.delivery-archive.repository.js"),
        load("modules/notify/notify.service.js"),
        load("modules/notify/notify.stream.publisher.js"),
        load("modules/notify/notify.delivery.js"),
      ]);
    return {
      loadEnv: envModule.loadEnv,
      AppConfig: configModule.AppConfig,
      DatabaseService: databaseModule.DatabaseService,
      ClockService: clockModule.ClockService,
      NotifyRepository: repositoryModule.NotifyRepository,
      NotifyDeliveryArchiveRepository: archiveModule.NotifyDeliveryArchiveRepository,
      NotifyService: serviceModule.NotifyService,
      NotifyStreamPublisher: publisherModule.NotifyStreamPublisher,
      parseQuietHours: deliveryModule.parseQuietHours,
      quietEndAfter: deliveryModule.quietEndAfter,
      shanghaiMinuteOfDay: deliveryModule.shanghaiMinuteOfDay,
      formatClockMinute: deliveryModule.formatClockMinute,
    };
  } catch (error) {
    process.stderr.write("M5-04-2：无法加载 server/dist（先执行 cd server && npm run build）：" + String(error) + "\n");
    process.exit(1);
  }
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

async function makeSession(userId) {
  const session = { token: "m5042rpl-" + randomBytes(16).toString("hex"), csrf: randomBytes(16).toString("hex") };
  const hash = sha256(session.token);
  await db.query(
    "insert into sessions (token_hash, user_id, id_token, expires_at) values ($1, $2, $3, now() + interval '2 hours')",
    [hash, userId, JSON.stringify({ replay: "m5-04-2" })],
  );
  cleanup.tokenHashes.push(hash);
  return session;
}

async function call(method, path, body, session) {
  const response = await fetch(BASE_URL + path, {
    method,
    headers: {
      "content-type": "application/json",
      cookie: "ll_sid=" + session.token + "; ll_csrf=" + session.csrf,
      "x-csrf-token": session.csrf,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = text === "" ? null : JSON.parse(text);
  } catch {
    parsed = { raw: text.slice(0, 300) };
  }
  return { status: response.status, body: parsed };
}

async function main() {
  runtime = await loadRuntime();
  db = new pg.Client({ connectionString: DATABASE_URL });
  await db.connect();

  const health = await fetch(BASE_URL + "/healthz").then((response) => response.status).catch(() => 0);
  check("P1", "api 可用（/healthz）", "200", String(health), health === 200, "先起 api 再跑本脚本");

  const tag = randomBytes(4).toString("hex");
  const dedupe = (suffix) => DEDUPE_PREFIX + "." + tag + "." + suffix;
  const cookieOf = (session) => "ll_sid=" + session.token;

  // 回放环境（本进程触发方）：关免打扰 / 不限量 / 关合并 —— 与 api 侧 env 无关。
  const env = runtime.loadEnv({
    ...process.env,
    DATABASE_URL,
    NOTIFY_QUIET_HOURS: "",
    NOTIFY_DAILY_LIMIT: "0",
    NOTIFY_MERGE_WINDOW_MS: "0",
    NOTIFY_SNOOZE_BATCH: "50",
  });
  const config = new runtime.AppConfig(env);
  const database = new runtime.DatabaseService(config);
  const repository = new runtime.NotifyRepository(database);
  const archive = new runtime.NotifyDeliveryArchiveRepository(database);
  const clock = new runtime.ClockService();
  const publisher = new runtime.NotifyStreamPublisher();
  const notify = new runtime.NotifyService(repository, archive, database, config, clock, publisher);
  const claimed = (id, dedupeKey, message) => ({
    // 本回放直接构造 outbox 领取行、不落 outbox_events；2A 归档允许 outbox_id = null。
    id: null,
    topic: "notify.message",
    payload: message,
    dedupeKey,
    attempts: 0,
    availableAt: new Date(),
    lockedAt: new Date(),
  });

  evidence.anchors = { tag, baseUrl: BASE_URL, dedupePrefix: DEDUPE_PREFIX };

  try {
    // ------------------------------------------------------------------ S0 基线
    await db.query("delete from notify_delivery_messages where source_dedupe_key like $1", [DEDUPE_PREFIX + ".%"]).catch(() => {});
    await db.query("delete from notifications where source_dedupe_key like $1", [DEDUPE_PREFIX + ".%"]).catch(() => {});
    const users = await db.query(
      "insert into users (casdoor_id, username, display_name, status) values ($1, $2, $3, 'active'), ($4, $5, $6, 'active') returning id, username",
      [
        USER_PREFIX + tag + "-a",
        USER_PREFIX + tag + "-a",
        "M5-04-2 回放用户 A",
        USER_PREFIX + tag + "-b",
        USER_PREFIX + tag + "-b",
        "M5-04-2 回放用户 B",
      ],
    );
    cleanup.userIds = users.rows.map((row) => row.id);
    const [userA, userB] = cleanup.userIds;
    const sessionA = await makeSession(userA);
    const sessionB = await makeSession(userB);

    const deliver = async (key, title, recipientId) => {
      const outcome = await notify.consume(
        claimed(1, dedupe(key), { recipientId, type: "reminder", title, body: title + " 正文", refType: "report", refId: randomUUID() }),
      );
      if (outcome?.outcome !== "done") {
        throw new Error("固定装置投递失败（" + key + "）：" + short(outcome));
      }
      const stored = await db.query("select id, delivered_at from notifications where source_dedupe_key = $1", [dedupe(key)]);
      return { id: Number(stored.rows[0]?.id), deliveredAt: stored.rows[0]?.delivered_at };
    };
    const row1 = await deliver("m1", "M5-04-2 回放一", userA);
    const row2 = await deliver("m2", "M5-04-2 回放二", userA);
    const row3 = await deliver("m3", "M5-04-2 回放三", userA);
    const row4 = await deliver("m4", "M5-04-2 回放四", userA);
    const row5 = await deliver("m5", "M5-04-2 回放五", userA);
    const rowB = await deliver("mB", "M5-04-2 回放 B", userB);

    const childInsert = await db.query(
      "insert into notifications (recipient_id, type, title, body, status, source_topic, source_dedupe_key, merge_key, merged_into_id, deliver_at) values ($1, 'reminder', '回放合并子行', '仅留档', 'unread', 'notify.message', $2, 'x', $3, now()) returning id",
      [userA, dedupe("child"), row1.id],
    );
    const childId = Number(childInsert.rows[0]?.id);
    const undeliveredInsert = await db.query(
      "insert into notifications (recipient_id, type, title, body, status, source_topic, source_dedupe_key, merge_key, deliver_at) values ($1, 'reminder', '回放未投递', '排队中', 'unread', 'notify.message', $2, 'y', now() + interval '1 hour') returning id",
      [userA, dedupe("undelivered")],
    );
    const undeliveredId = Number(undeliveredInsert.rows[0]?.id);
    const sessionBRow = rowB;

    const listA = await call("GET", "/api/v1/notifications?limit=50", undefined, sessionA);
    const unreadBefore = listA.body?.unreadCount;
    check(
      "S0",
      "基线：合成用户 / 会话 / 固定装置就绪（5 条已投递未读 + 他人行 + 合并子行 + 未投递行）",
      "users=2 / sessions=2 / 已投递未读=5 / unreadCount=5",
      short({ users: cleanup.userIds.length, sessions: cleanup.tokenHashes.length, unreadCount: unreadBefore, a: listA.status }),
      cleanup.userIds.length === 2 && cleanup.tokenHashes.length === 2 && listA.status === 200 && unreadBefore === 5,
    );

    const a1 = await new SseStream("A-1", cookieOf(sessionA)).open();
    streams.push(a1);
    await sleep(1200); // 给 api 侧惰性 LISTEN 就绪留出余量（先于首个事件发布）

    // ------------------------------------------------------------------ S1 设置
    const snoozeUntil1 = new Date(Math.floor((Date.now() + 7 * MINUTE_MS) / 1000) * 1000);
    const set1 = await call("POST", "/api/v1/notifications/" + row1.id + "/snooze", { snoozeUntil: snoozeUntil1.toISOString() }, sessionA);
    const listAfter1 = await call("GET", "/api/v1/notifications?limit=50", undefined, sessionA);
    const active1 = await db.query(
      "select id, set_at, snooze_until, triggered_at, cancelled_at from notification_snoozes where notification_id = $1 and triggered_at is null and cancelled_at is null",
      [row1.id],
    );
    check(
      "S1",
      "设置：200 + 置读 + snoozeUntil 原样（秒级）+ 记录一条活跃 + 未读数 -1",
      "200 / read / " + snoozeUntil1.toISOString() + " / records=1 / unread=" + (unreadBefore - 1),
      short({ status: set1.status, s: set1.body?.status, until: set1.body?.snoozeUntil, records: active1.rows.length, unread: listAfter1.body?.unreadCount }),
      set1.status === 200 &&
        set1.body?.status === "read" &&
        set1.body?.snoozeUntil === snoozeUntil1.toISOString() &&
        active1.rows.length === 1 &&
        active1.rows[0]?.snooze_until?.toISOString() === snoozeUntil1.toISOString() &&
        listAfter1.body?.unreadCount === unreadBefore - 1,
    );
    let unreadEvent;
    try {
      unreadEvent = await a1.waitForEvent("unread", (data) => data.unreadCount === unreadBefore - 1, 10_000);
    } catch (error) {
      unreadEvent = undefined;
      process.stdout.write("  S1b 诊断：" + messageOf(error) + "\n");
    }
    check("S1b", "设置置读广播 `unread`（角标快照，SSE 实收）", "unreadCount=" + (unreadBefore - 1), short(unreadEvent?.data), unreadEvent !== undefined);

    const records1 = await call("GET", "/api/v1/notifications/" + row1.id + "/snoozes", undefined, sessionA);
    check(
      "S1c",
      "记录读面：一条活跃记录（setAt / snoozeUntil / 未触发未取消）",
      "200 / items=1 / triggeredAt=null / cancelledAt=null",
      short({ status: records1.status, items: records1.body?.items }),
      records1.status === 200 &&
        records1.body?.items?.length === 1 &&
        records1.body.items[0]?.triggeredAt === null &&
        records1.body.items[0]?.cancelledAt === null,
    );

    // ------------------------------------------------------------------ S2 覆盖
    const snoozeUntil2 = new Date(Math.floor((Date.now() + 8 * MINUTE_MS) / 1000) * 1000);
    const set2 = await call("POST", "/api/v1/notifications/" + row1.id + "/snooze", { snoozeUntil: snoozeUntil2.toISOString() }, sessionA);
    const records2 = await call("GET", "/api/v1/notifications/" + row1.id + "/snoozes", undefined, sessionA);
    const items2 = records2.body?.items ?? [];
    check(
      "S2",
      "覆盖：重复设置 → 旧记录标 cancelledAt + 新记录活跃；读面 id 降序",
      "200 / items=2 / items[0].id=2 活跃 / items[1].cancelledAt 非空",
      short({ status: set2.status, until: set2.body?.snoozeUntil, items: items2.map((item) => ({ id: item.id, c: item.cancelledAt, t: item.triggeredAt })) }),
      set2.status === 200 &&
        set2.body?.snoozeUntil === snoozeUntil2.toISOString() &&
        items2.length === 2 &&
        items2[0]?.id === 2 &&
        items2[0]?.cancelledAt === null &&
        typeof items2[1]?.cancelledAt === "string",
    );

    // ------------------------------------------------------------------ S3 取消（幂等）
    const cancel1 = await call("DELETE", "/api/v1/notifications/" + row1.id + "/snooze", undefined, sessionA);
    const cancel2 = await call("DELETE", "/api/v1/notifications/" + row1.id + "/snooze", undefined, sessionA);
    const records3 = await call("GET", "/api/v1/notifications/" + row1.id + "/snoozes", undefined, sessionA);
    check(
      "S3",
      "取消：幂等 —— 两次 DELETE 均 200 + snoozeUntil=null；记录不再新增",
      "200 / null / 200 / null / items=2",
      short({ s1: cancel1.status, u1: cancel1.body?.snoozeUntil, s2: cancel2.status, u2: cancel2.body?.snoozeUntil, items: records3.body?.items?.length }),
      cancel1.status === 200 &&
        cancel1.body?.snoozeUntil === null &&
        cancel2.status === 200 &&
        cancel2.body?.snoozeUntil === null &&
        records3.body?.items?.length === 2,
    );

    // ------------------------------------------------------------------ S4 404 族
    const v404a = await call("POST", "/api/v1/notifications/" + sessionBRow.id + "/snooze", { snoozeUntil: snoozeUntil1.toISOString() }, sessionA);
    const v404b = await call("POST", "/api/v1/notifications/" + childId + "/snooze", { snoozeUntil: snoozeUntil1.toISOString() }, sessionA);
    const v404c = await call("POST", "/api/v1/notifications/" + undeliveredId + "/snooze", { snoozeUntil: snoozeUntil1.toISOString() }, sessionA);
    const v404d = await call("DELETE", "/api/v1/notifications/" + sessionBRow.id + "/snooze", undefined, sessionA);
    const v404e = await call("GET", "/api/v1/notifications/" + undeliveredId + "/snoozes", undefined, sessionA);
    check(
      "S4",
      "404 族：他人行（设置 / 取消）/ 合并子行 / 未投递行（设置 / 记录）统一 404",
      "404 ×5",
      short([v404a.status, v404b.status, v404c.status, v404d.status, v404e.status]),
      [v404a.status, v404b.status, v404c.status, v404d.status, v404e.status].every((status) => status === 404),
    );

    // ------------------------------------------------------------------ S5 范围校验
    const base = Math.floor(Date.now() / 1000) * 1000;
    const tooSoon = new Date(base + 5 * MINUTE_MS);
    const tooFar = new Date(base + 30 * DAY_MS + 60_000);
    const bad1 = await call("POST", "/api/v1/notifications/" + row1.id + "/snooze", { snoozeUntil: tooSoon.toISOString() }, sessionA);
    const bad2 = await call("POST", "/api/v1/notifications/" + row1.id + "/snooze", { snoozeUntil: tooFar.toISOString() }, sessionA);
    // 截断接受用例：基准即取即用（毫秒截断到秒后为 +5min+1s，距服务端 now 仍 > 5 分钟）。
    const truncBase = Math.floor(Date.now() / 1000) * 1000;
    const truncTarget = new Date(truncBase + 5 * MINUTE_MS + 1500);
    const truncExpected = new Date(truncBase + 5 * MINUTE_MS + 1000);
    const okTrunc = await call("POST", "/api/v1/notifications/" + row1.id + "/snooze", { snoozeUntil: truncTarget.toISOString() }, sessionA);
    check(
      "S5",
      "范围校验：过近 400 / 过远 400；毫秒截断到秒后校验（+5min+1.5s → +5min+1s 合法）",
      "400 / 400 / 200 且 snoozeUntil=" + truncExpected.toISOString(),
      short({ near: bad1.status + "/" + bad1.body?.code, far: bad2.status + "/" + bad2.body?.code, trunc: okTrunc.status + "/" + okTrunc.body?.snoozeUntil }),
      bad1.status === 400 &&
        bad1.body?.code === "VALIDATION_FAILED" &&
        bad2.status === 400 &&
        bad2.body?.code === "VALIDATION_FAILED" &&
        okTrunc.status === 200 &&
        okTrunc.body?.snoozeUntil === truncExpected.toISOString(),
    );
    await call("DELETE", "/api/v1/notifications/" + row1.id + "/snooze", undefined, sessionA);

    // ------------------------------------------------------------------ S6 到点触发
    const snoozeUntil6 = new Date(Math.floor((Date.now() + 7 * MINUTE_MS) / 1000) * 1000);
    const set6 = await call("POST", "/api/v1/notifications/" + row2.id + "/snooze", { snoozeUntil: snoozeUntil6.toISOString() }, sessionA);
    await db.query("update notifications set snooze_until = now() - interval '1 second' where id = $1", [row2.id]);
    const countBefore6 = Number((await db.query("select count(*)::int as n from notifications where recipient_id = $1", [userA])).rows[0]?.n);
    const stats6 = await notify.flushSnoozes();
    const row2Db = (await db.query("select status, snooze_until, delivered_at from notifications where id = $1", [row2.id])).rows[0];
    const record6 = (await db.query("select triggered_at from notification_snoozes where notification_id = $1", [row2.id])).rows[0];
    const countAfter6 = Number((await db.query("select count(*)::int as n from notifications where recipient_id = $1", [userA])).rows[0]?.n);
    check(
      "S6",
      "到点触发：置回 unread + 清 snoozeUntil + 记录回填 triggeredAt；不新增通知行（重投原行）",
      "200 / scanned=1 triggered=1 / unread / null / triggeredAt 非空 / 行数不变",
      short({ set: set6.status, stats: stats6, status: row2Db?.status, until: row2Db?.snooze_until, triggered: record6?.triggered_at, rows: countBefore6 + "→" + countAfter6 }),
      set6.status === 200 &&
        stats6.scanned === 1 &&
        stats6.triggered === 1 &&
        stats6.deferred === 0 &&
        row2Db?.status === "unread" &&
        row2Db?.snooze_until === null &&
        record6?.triggered_at !== null &&
        countAfter6 === countBefore6,
    );
    let triggerEvent;
    let triggerUnread;
    try {
      triggerEvent = await a1.waitForEvent("notification", (data) => data.id === row2.id, 10_000);
      // `unread` 须在 notification 之后到达（同一事务内先 notification 后 unread）；按事件序取其后首条。
      const notificationIndex = a1.events.indexOf(triggerEvent);
      const unreadDeadline = Date.now() + 5_000;
      triggerUnread = a1.events.slice(notificationIndex + 1).find((item) => item.type === "unread");
      while (triggerUnread === undefined && Date.now() < unreadDeadline) {
        await sleep(50);
        triggerUnread = a1.events.slice(notificationIndex + 1).find((item) => item.type === "unread");
      }
    } catch (error) {
      triggerEvent = undefined;
      process.stdout.write("  S6b 诊断：" + messageOf(error) + "\n");
    }
    const deliveredAtIso = new Date(row2.deliveredAt).toISOString();
    check(
      "S6b",
      "触发广播：`notification`（同 id 原行：unread / snoozeUntil=null / deliveredAt 留档）后 `unread`（SSE 实收）",
      "id=" + row2.id + " / status=unread / snoozeUntil=null / deliveredAt=" + deliveredAtIso,
      short({ notification: triggerEvent?.data, unread: triggerUnread?.data }),
      triggerEvent !== undefined &&
        triggerEvent.data.status === "unread" &&
        triggerEvent.data.snoozeUntil === null &&
        triggerEvent.data.deliveredAt === deliveredAtIso &&
        triggerUnread !== undefined,
    );

    // ------------------------------------------------------------------ S7 免打扰顺延
    const minute = runtime.shanghaiMinuteOfDay(new Date());
    const quietWindow = runtime.formatClockMinute((minute + 1439) % 1440) + "-" + runtime.formatClockMinute((minute + 3) % 1440);
    const quietExpectedEnd = runtime.quietEndAfter(new Date(), runtime.parseQuietHours(quietWindow));
    const envQuiet = runtime.loadEnv({
      ...process.env,
      DATABASE_URL,
      NOTIFY_QUIET_HOURS: quietWindow,
      NOTIFY_DAILY_LIMIT: "0",
      NOTIFY_MERGE_WINDOW_MS: "0",
    });
    const notifyQuiet = new runtime.NotifyService(repository, archive, database, new runtime.AppConfig(envQuiet), clock, publisher);

    const snoozeUntil7 = new Date(Math.floor((Date.now() + 7 * MINUTE_MS) / 1000) * 1000);
    await call("POST", "/api/v1/notifications/" + row3.id + "/snooze", { snoozeUntil: snoozeUntil7.toISOString() }, sessionA);
    await db.query("update notifications set snooze_until = now() - interval '1 second' where id = $1", [row3.id]);
    const eventsBefore7 = a1.events.length;
    const stats7 = await notifyQuiet.flushSnoozes();
    const row3Db = (await db.query("select status, snooze_until from notifications where id = $1", [row3.id])).rows[0];
    const record7 = (await db.query("select triggered_at, cancelled_at from notification_snoozes where notification_id = $1", [row3.id])).rows[0];
    check(
      "S7",
      "免打扰顺延：到点落免打扰 → snoozeUntil 推到时段结束（" + quietWindow + "）、状态不动、记录不回填、不发事件",
      "scanned=1 deferred=1 / read / " + quietExpectedEnd.toISOString() + " / triggeredAt=null / 事件数不变",
      short({ stats: stats7, status: row3Db?.status, until: row3Db?.snooze_until, record: record7, events: eventsBefore7 + "→" + a1.events.length }),
      stats7.scanned === 1 &&
        stats7.deferred === 1 &&
        stats7.triggered === 0 &&
        row3Db?.status === "read" &&
        row3Db?.snooze_until?.toISOString() === quietExpectedEnd.toISOString() &&
        record7?.triggered_at === null &&
        a1.events.length === eventsBefore7,
    );
    await db.query("update notifications set snooze_until = now() - interval '1 second' where id = $1", [row3.id]);
    const stats7b = await notify.flushSnoozes();
    const row3After = (await db.query("select status, snooze_until from notifications where id = $1", [row3.id])).rows[0];
    check(
      "S7b",
      "顺延后仍可触发：通过免打扰关闭实例再扫（回放口径）→ unread",
      "triggered=1 / unread / null",
      short({ stats: stats7b, status: row3After?.status, until: row3After?.snooze_until }),
      stats7b.triggered === 1 && row3After?.status === "unread" && row3After?.snooze_until === null,
    );

    // ------------------------------------------------------------------ S8 handled 行照提醒（定案 ④）
    await call("PATCH", "/api/v1/notifications/" + row4.id, { status: "handled" }, sessionA);
    const set8 = await call("POST", "/api/v1/notifications/" + row4.id + "/snooze", { snoozeUntil: snoozeUntil7.toISOString() }, sessionA);
    await call("PATCH", "/api/v1/notifications/" + row4.id, { status: "handled" }, sessionA);
    await db.query("update notifications set snooze_until = now() - interval '1 second' where id = $1", [row4.id]);
    const stats8 = await notify.flushSnoozes();
    const row4Db = (await db.query("select status, snooze_until from notifications where id = $1", [row4.id])).rows[0];
    check(
      "S8",
      "handled 行照提醒：handled 可设置（设置即置读）→ 等待期间重标 handled → 到点仍置回 unread",
      "设置 200/read / 触发 triggered=1 / unread",
      short({ set: set8.status + "/" + set8.body?.status, stats: stats8, status: row4Db?.status, until: row4Db?.snooze_until }),
      set8.status === 200 && set8.body?.status === "read" && stats8.triggered === 1 && row4Db?.status === "unread",
    );

    // ------------------------------------------------------------------ S9 不消耗每日上限
    const envLimit = runtime.loadEnv({
      ...process.env,
      DATABASE_URL,
      NOTIFY_QUIET_HOURS: "",
      NOTIFY_DAILY_LIMIT: "1",
      NOTIFY_MERGE_WINDOW_MS: "0",
    });
    const notifyLimit = new runtime.NotifyService(repository, archive, database, new runtime.AppConfig(envLimit), clock, publisher);
    await call("POST", "/api/v1/notifications/" + row5.id + "/snooze", { snoozeUntil: snoozeUntil7.toISOString() }, sessionA);
    await db.query("update notifications set snooze_until = now() - interval '1 second' where id = $1", [row5.id]);
    const deliveredToday = Number(
      (await db.query(
        "select count(*)::int as n from notifications where recipient_id = $1 and merged_into_id is null and delivered_at >= date_trunc('day', now() at time zone 'Asia/Shanghai') at time zone 'Asia/Shanghai'",
        [userA],
      )).rows[0]?.n,
    );
    const stats9 = await notifyLimit.flushSnoozes();
    const row5Db = (await db.query("select status, snooze_until from notifications where id = $1", [row5.id])).rows[0];
    check(
      "S9",
      "不消耗每日上限：限额 1 且当日已投递 " + deliveredToday + " 条仍照常触发（用户主动重提醒，非新投递）",
      "triggered=1 / unread / null",
      short({ limit: 1, deliveredToday, stats: stats9, status: row5Db?.status, until: row5Db?.snooze_until }),
      deliveredToday >= 1 && stats9.triggered === 1 && row5Db?.status === "unread" && row5Db?.snooze_until === null,
    );

    // ------------------------------------------------------------------ S10 记录读面收尾（触发回填可查）
    const records10 = await call("GET", "/api/v1/notifications/" + row2.id + "/snoozes", undefined, sessionA);
    check(
      "S10",
      "记录读面（触发后）：triggeredAt 非空、cancelledAt 空（C5-05「设置与触发记录可查」）",
      "200 / items=1 / triggeredAt 非空",
      short({ status: records10.status, items: records10.body?.items }),
      records10.status === 200 &&
        records10.body?.items?.length === 1 &&
        typeof records10.body.items[0]?.triggeredAt === "string" &&
        records10.body.items[0]?.cancelledAt === null,
    );
  } finally {
    for (const stream of streams) stream.close();
    try {
      if (!cleanup.keep) {
        await db.query("delete from notify_delivery_messages where source_dedupe_key like $1", [DEDUPE_PREFIX + ".%"]).catch(() => {});
        await db.query("delete from notifications where source_dedupe_key like $1", [DEDUPE_PREFIX + ".%"]);
        if (cleanup.userIds.length > 0) {
          await db.query("delete from users where id = any($1::uuid[])", [cleanup.userIds]);
        }
      }
      const residue = await db.query("select count(*)::int as n from notifications where source_dedupe_key like $1", [DEDUPE_PREFIX + ".%"]);
      const userResidue = await db.query("select count(*)::int as n from users where username like $1", [USER_PREFIX + "%"]);
      const archiveResidue = await db.query("select count(*)::int as n from notify_delivery_messages where source_dedupe_key like $1", [DEDUPE_PREFIX + ".%"]);
      const orphanSnoozes = await db.query(
        "select count(*)::int as n from notification_snoozes s left join notifications n on n.id = s.notification_id where n.id is null",
      );
      check(
        "S11",
        "自清理：合成前缀零残留 + 记录随通知级联零孤儿（--keep 时保留现场、仅留痕）",
        cleanup.keep ? "keep=true（不清理）" : "notifications=0 / archives=0 / users=0 / orphanSnoozes=0",
        short({ notifications: residue.rows[0].n, archives: archiveResidue.rows[0].n, users: userResidue.rows[0].n, orphanSnoozes: orphanSnoozes.rows[0].n, keep: cleanup.keep }),
        cleanup.keep || (residue.rows[0].n === 0 && archiveResidue.rows[0].n === 0 && userResidue.rows[0].n === 0 && orphanSnoozes.rows[0].n === 0),
      );
    } catch (error) {
      check("S11", "自清理：合成前缀零残留", "清理成功", "清理失败：" + messageOf(error), false);
    }
    await db.end().catch(() => {});
  }
}

function writeReports() {
  const summary = "M5-04-2 回放汇总：PASS " + pass + " / FAIL " + fail + "（合成前缀 " + DEDUPE_PREFIX + "）";
  if (args.out !== undefined) {
    writeFileSync(
      args.out,
      "# M5-04-2 · S8-3 真机回放证据（稍后提醒 C5-05）\n\n" +
        "| 结果 | 编号 | 断言 | 期望 | 实际 | 备注 |\n|---|---|---|---|---|---|\n" + report.join("\n") +
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
  check("X", "回放主流程", "无异常（中止即报告剩余断言未执行）", "异常：" + messageOf(error), false);
  try {
    const lines = readFileSync(join(HERE, "..", "api.log"), "utf8").trimEnd().split("\n");
    const notifyLines = lines.filter((line) => line.includes("Notify") || line.includes("稍后提醒"));
    process.stdout.write(
      "—— api.log · Notify 相关行（" + notifyLines.length + " 条）——\n" +
        (notifyLines.length === 0 ? "（无）" : notifyLines.slice(-40).join("\n")) + "\n",
    );
    process.stdout.write("—— api.log 尾部（最近 40 行 · 诊断）——\n" + lines.slice(-40).join("\n") + "\n");
  } catch {
    // 无 api.log（本地运行）：跳过
  }
}

writeReports();
process.exit(fail === 0 ? 0 : 1);
