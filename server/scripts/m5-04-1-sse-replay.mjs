#!/usr/bin/env node
/**
 * M5-04-1 · S8-3 真机回放（SSE 实时推送）：端到端验证「写方事务内 pg_notify → api 实例 LISTEN → SSE 帧」全链路。
 *   证据一（连接建立）：GET /api/v1/notifications/stream → 200 + text/event-stream 头部；建立后不主动发帧。
 *   证据二（投递推送）：NotifyService.consume 落库投递 → 本人连接收 notification（与库内行一致）+ unread（角标 1）。
 *   证据三（状态变更推送）：HTTP 标记已读 → 收 unread（角标 0）。
 *   证据四（跨用户隔离）：他人连接同窗口零事件（仅心跳注释行）。
 *   证据五（每用户连接上限）：3 连可达、第 4 条 429（RATE_LIMITED）；关闭一条后空位可复用。
 *   证据六（心跳）：空闲连接按 NOTIFY_STREAM_HEARTBEAT_MS 收注释行 `: ping`。
 *   证据七（自清理）：本脚本合成前缀零残留（finally 兜底，--keep 时保留现场）。
 *
 * 前置：真 PG（迁移器角色即可）+ 已构建的 server/dist + **已起 api**（CI database job 内 api 以
 *   NOTIFY_STREAM_HEARTBEAT_MS=1500 启动；本机若用缺省 25s 请设 M5_04_1_HEARTBEAT_WAIT_MS=30000）。
 * 用法：cd server && M5_04_1_DATABASE_URL=postgresql://libiaolink_migrator@127.0.0.1:55432/libiaolink \
 *       M5_04_1_BASE_URL=http://127.0.0.1:3011 node scripts/m5-04-1-sse-replay.mjs [--out <报告.md>] [--json <证据.json>] [--keep]
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
  process.env.M5_04_1_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql://libiaolink_migrator@127.0.0.1:55432/libiaolink";
const BASE_URL = args.baseUrl ?? process.env.M5_04_1_BASE_URL ?? "http://127.0.0.1:3011";
/** 心跳等待上限：CI api 以 NOTIFY_STREAM_HEARTBEAT_MS=1500 启动；本机缺省 25s 时请显式调大。 */
const HEARTBEAT_WAIT_MS = Number(process.env.M5_04_1_HEARTBEAT_WAIT_MS ?? "8000");

const DEDUPE_PREFIX = "m5041Replay";
const USER_PREFIX = "m5041rpl-";

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
  process.stdout.write((ok ? "PASS " : "FAIL ") + id + " " + title + String.fromCharCode(10));
  if (!ok) {
    process.stdout.write(
      "  → 期望：" + expected + " / 实际：" + actual + (extra === "" ? "" : " / " + extra) + String.fromCharCode(10),
    );
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

/** 带截止时间的轮询：fn 返回 undefined / false / null 视为未就绪，超时返回 undefined。 */
async function waitUntil(fn, timeoutMs, intervalMs = 100) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value !== undefined && value !== false && value !== null) return value;
    if (Date.now() >= deadline) return undefined;
    await sleep(intervalMs);
  }
}

/** 最小 SSE 客户端：逐块解析事件帧（event + data）与注释行（心跳），支持按条件等待。 */
class SseStream {
  constructor(name, cookie) {
    this.name = name;
    this.cookie = cookie;
    this.status = 0;
    this.contentType = "";
    this.cacheControl = "";
    this.buffering = "";
    this.body = "";
    this.events = [];
    this.comments = [];
    this.buffer = "";
    this.reader = null;
    this.controller = null;
    this.decoder = new TextDecoder();
  }

  async open() {
    this.controller = new AbortController();
    const response = await fetch(BASE_URL + "/api/v1/notifications/stream", {
      headers: { accept: "text/event-stream", cookie: this.cookie },
      signal: this.controller.signal,
    });
    this.status = response.status;
    this.contentType = response.headers.get("content-type") ?? "";
    this.cacheControl = response.headers.get("cache-control") ?? "";
    this.buffering = response.headers.get("x-accel-buffering") ?? "";
    if (this.status === 200 && response.body !== null) {
      this.reader = response.body.getReader();
      void this.pump();
    } else {
      // 非 200（如 429 拒新）：错误信封也是 JSON —— 与 call() 同口径解析，断言才拿得到 code。
      const text = await response.text().catch(() => "");
      try {
        this.body = text === "" ? null : JSON.parse(text);
      } catch {
        this.body = { raw: text.slice(0, 300) };
      }
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
        const same = this.events.filter((item) => item.type === type);
        throw new Error(
          this.name + " 等待事件超时：" + type + "（" + timeoutMs + "ms；已收 " + this.events.length + " 条：" +
            this.events.map((item) => item.type).join(",") + "；同类型 " + same.length + " 条，最近载荷：" +
            (same.length === 0 ? "无" : short(same[same.length - 1].data, 500)) +
            (note === "" ? "" : "；诊断：" + note) + "）",
        );
      }
      await sleep(50);
    }
  }

  async waitForComment(prefix, timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const hit = this.comments.find((item) => item.startsWith(prefix));
      if (hit !== undefined) return hit;
      if (Date.now() >= deadline) return null;
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
    const [envModule, configModule, databaseModule, clockModule, repositoryModule, archiveModule, serviceModule, publisherModule, streamModule] =
      await Promise.all([
        load("config/env.js"),
        load("config/config.module.js"),
        load("db/database.service.js"),
        load("common/clock/clock.service.js"),
        load("modules/notify/notify.repository.js"),
        load("modules/notify/notify.delivery-archive.repository.js"),
        load("modules/notify/notify.service.js"),
        load("modules/notify/notify.stream.publisher.js"),
        load("modules/notify/notify.stream.js"),
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
      NOTIFY_STREAM_CHANNEL: streamModule.NOTIFY_STREAM_CHANNEL,
    };
  } catch (error) {
    process.stderr.write("M5-04-1：无法加载 server/dist（先执行 cd server && npm run build）：" + String(error) + "\n");
    process.exit(1);
  }
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

async function makeSession(userId) {
  const session = { token: "m5041rpl-" + randomBytes(16).toString("hex"), csrf: randomBytes(16).toString("hex") };
  const hash = sha256(session.token);
  await db.query(
    "insert into sessions (token_hash, user_id, id_token, expires_at) values ($1, $2, $3, now() + interval '2 hours')",
    [hash, userId, JSON.stringify({ replay: "m5-04-1" })],
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

  // 回放环境（本进程写方）：关免打扰 / 不限量 / 关合并 —— 投递即投、单条独立（与 api 侧 env 无关）。
  const env = runtime.loadEnv({
    ...process.env,
    DATABASE_URL,
    NOTIFY_QUIET_HOURS: "",
    NOTIFY_DAILY_LIMIT: "0",
    NOTIFY_MERGE_WINDOW_MS: "0",
  });
  const config = new runtime.AppConfig(env);
  const database = new runtime.DatabaseService(config);
  const repository = new runtime.NotifyRepository(database);
  const archive = new runtime.NotifyDeliveryArchiveRepository(database);
  const clock = new runtime.ClockService();
  const notify = new runtime.NotifyService(repository, archive, database, config, clock, new runtime.NotifyStreamPublisher());
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

  evidence.anchors = { tag, baseUrl: BASE_URL, heartbeatWaitMs: HEARTBEAT_WAIT_MS, dedupePrefix: DEDUPE_PREFIX };

  try {
    // ------------------------------------------------------------------ S0 基线
    await db.query("delete from notify_delivery_messages where source_dedupe_key like $1", [DEDUPE_PREFIX + ".%"]).catch(() => {});
    await db.query("delete from notifications where source_dedupe_key like $1", [DEDUPE_PREFIX + ".%"]).catch(() => {});
    const users = await db.query(
      "insert into users (casdoor_id, username, display_name, status) values ($1, $2, $3, 'active'), ($4, $5, $6, 'active') returning id, username",
      [
        USER_PREFIX + tag + "-a",
        USER_PREFIX + tag + "-a",
        "M5-04-1 回放用户 A",
        USER_PREFIX + tag + "-b",
        USER_PREFIX + tag + "-b",
        "M5-04-1 回放用户 B",
      ],
    );
    cleanup.userIds = users.rows.map((row) => row.id);
    const [userA, userB] = cleanup.userIds;
    const sessionA = await makeSession(userA);
    const sessionB = await makeSession(userB);
    check(
      "S0",
      "基线：合成用户与两会话就绪",
      "users=2 / sessions=2",
      short({ users: cleanup.userIds.length, sessions: cleanup.tokenHashes.length }),
      cleanup.userIds.length === 2 && cleanup.tokenHashes.length === 2,
    );

    // ------------------------------------------------------------------ S1 连接建立
    const a1 = await new SseStream("A-1", cookieOf(sessionA)).open();
    streams.push(a1);
    check(
      "S1",
      "连接建立：200 + SSE 响应头（text/event-stream / no-cache / X-Accel-Buffering=no）",
      "200 / text/event-stream / no-cache / no",
      short({ status: a1.status, contentType: a1.contentType, cacheControl: a1.cacheControl, buffering: a1.buffering }),
      a1.status === 200 &&
        a1.contentType.startsWith("text/event-stream") &&
        a1.cacheControl.includes("no-cache") &&
        a1.buffering === "no",
    );
    await sleep(1000); // 建立后不主动发帧；同时给 api 侧惰性 LISTEN 就绪留出余量
    check("S1b", "建立后不主动发帧（无事件）", "events=0", String(a1.events.length), a1.events.length === 0);

    // ------------------------------------------------------------------ S2 投递推送
    const message1 = {
      recipientId: userA,
      type: "reminder",
      title: "M5-04-1 回放一",
      body: "第一条投递",
      refType: "report",
      refId: randomUUID(),
    };
    const outcome = await notify.consume(claimed(1, dedupe("m1"), message1));
    check("S2", "写方投递（consume）落库", "done", short(outcome), outcome?.outcome === "done");

    const stored = await db.query(
      "select id, delivered_at, status from notifications where source_dedupe_key = $1",
      [dedupe("m1")],
    );
    const storedRow = stored.rows[0];
    const storedId1 = Number(storedRow?.id);
    let notification1;
    try {
      notification1 = await a1.waitForEvent("notification", (data) => data.id === storedId1, 10_000, "storedId1=" + String(storedId1));
    } catch (error) {
      // 诊断探针（不改断言语义 · 仍抛原错）：超时后重投一条 —— 区分「发布早于 LISTEN 就绪（竞态）」与「广播桥 / 载荷被丢弃」。
      const probe = { ...message1, title: "M5-04-1 回放一（诊断重投）", refId: randomUUID() };
      const probeOutcome = await notify
        .consume(claimed(3, dedupe("m1-probe"), probe))
        .catch((probeError) => ({ outcome: "throw", error: messageOf(probeError) }));
      process.stdout.write("  诊断探针：重投 outcome=" + short(probeOutcome) + String.fromCharCode(10));
      try {
        const probeStored = await db.query("select id from notifications where source_dedupe_key = $1", [dedupe("m1-probe")]);
        const probeId = Number(probeStored.rows[0]?.id);
        await a1.waitForEvent("notification", (data) => data.id === probeId, 10_000, "probeId=" + String(probeId));
        process.stdout.write("  诊断探针：重投事件已到达 —— 首投缺失与投递 / 载荷无关（指向 LISTEN 就绪竞态）" + String.fromCharCode(10));
      } catch (probeError) {
        process.stdout.write("  诊断探针：重投仍无事件 —— " + messageOf(probeError) + String.fromCharCode(10));
        try {
          const stat = await db.query(
            "select pid, state, left(query, 90) as q from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid() order by pid limit 12",
          );
          process.stdout.write("  诊断探针 2：本库其它后端（" + stat.rows.length + " 条）" + String.fromCharCode(10));
          for (const row of stat.rows) {
            process.stdout.write(
              "    pid=" + row.pid + " state=" + (row.state ?? "-") + " q=" + row.q + String.fromCharCode(10),
            );
          }
        } catch (statError) {
          process.stdout.write("  诊断探针 2：pg_stat_activity 查询失败 —— " + messageOf(statError) + String.fromCharCode(10));
        }
        const raw = new pg.Client({ connectionString: DATABASE_URL });
        const rawSeen = [];
        try {
          raw.on("notification", (msg) => rawSeen.push(msg.payload));
          await raw.connect();
          await raw.query("LISTEN " + runtime.NOTIFY_STREAM_CHANNEL);
          const probe2 = { ...message1, title: "M5-04-1 回放一（诊断重投 2）", refId: randomUUID() };
          const outcome2 = await notify
            .consume(claimed(4, dedupe("m1-probe2"), probe2))
            .catch((probeError2) => ({ outcome: "throw", error: messageOf(probeError2) }));
          await sleep(1500);
          process.stdout.write(
            "  诊断探针 3（独立 LISTEN 复核发布侧）：outcome=" + short(outcome2) + "，收到广播 " + rawSeen.length + " 条" +
              (rawSeen.length === 0 ? "" : "，首条：" + String(rawSeen[0]).slice(0, 300)) + String.fromCharCode(10),
          );
        } catch (rawError) {
          process.stdout.write("  诊断探针 3：失败 —— " + messageOf(rawError) + String.fromCharCode(10));
        } finally {
          await raw.end().catch(() => {});
        }
        process.stdout.write(
          "  诊断：A-1 心跳注释行 " + a1.comments.length + " 条（连接写路径探针；CI 心跳 1500ms）" + String.fromCharCode(10),
        );
      }
      throw error;
    }
    check(
      "S2b",
      "本人连接收 notification：与库内行一致（title / status / deliveredAt / snoozeUntil）",
      "id=" + storedRow?.id + " / M5-04-1 回放一 / unread / 已投递 / null",
      short({
        id: notification1.data.id,
        title: notification1.data.title,
        status: notification1.data.status,
        deliveredAt: notification1.data.deliveredAt,
        snoozeUntil: notification1.data.snoozeUntil,
      }),
      notification1.data.id === storedId1 &&
        notification1.data.title === "M5-04-1 回放一" &&
        notification1.data.status === "unread" &&
        typeof notification1.data.deliveredAt === "string" &&
        notification1.data.snoozeUntil === null &&
        storedRow?.delivered_at != null,
    );
    const unread1 = await a1.waitForEvent("unread", (data) => data.unreadCount === 1, 10_000);
    check("S2c", "同事务广播 unread 角标（1）", "unreadCount=1", String(unread1.data.unreadCount), unread1.data.unreadCount === 1);

    // ------------------------------------------------------------------ S3 状态变更推送
    const marked = await call("PATCH", "/api/v1/notifications/" + storedRow.id, { status: "read" }, sessionA);
    check(
      "S3",
      "HTTP 标记已读",
      "200 / read",
      short({ status: marked.status, body: marked.body?.status }),
      marked.status === 200 && marked.body?.status === "read",
    );
    const unread2 = await a1.waitForEvent("unread", (data) => data.unreadCount === 0, 10_000);
    check("S3b", "状态变更广播 unread（0）", "unreadCount=0", String(unread2.data.unreadCount), unread2.data.unreadCount === 0);

    // ------------------------------------------------------------------ S4 跨用户隔离
    const b1 = await new SseStream("B-1", cookieOf(sessionB)).open();
    streams.push(b1);
    check("S4", "他人连接建立", "200", String(b1.status), b1.status === 200);

    const message2 = {
      recipientId: userA,
      type: "reminder",
      title: "M5-04-1 回放二",
      body: "第二条投递",
      refType: "report",
      refId: randomUUID(),
    };
    await notify.consume(claimed(2, dedupe("m2"), message2));
    const stored2 = await db.query("select id from notifications where source_dedupe_key = $1", [dedupe("m2")]);
    const storedId2 = Number(stored2.rows[0]?.id);
    const notification2 = await a1.waitForEvent("notification", (data) => data.id === storedId2, 10_000);
    const unread3 = await a1.waitForEvent("unread", (data) => data.unreadCount === 1, 10_000);
    await sleep(500);
    check(
      "S4b",
      "跨用户隔离：A 收第二条（通知 + 角标），B 同窗口零事件",
      "A=id" + stored2.rows[0]?.id + " / unread=1 / B=0",
      short({ a: notification2.data.id, aUnread: unread3.data.unreadCount, b: b1.events.length }),
      notification2.data.id === storedId2 && unread3.data.unreadCount === 1 && b1.events.length === 0,
    );

    // ------------------------------------------------------------------ S5 每用户连接上限
    const a2 = await new SseStream("A-2", cookieOf(sessionA)).open();
    streams.push(a2);
    const a3 = await new SseStream("A-3", cookieOf(sessionA)).open();
    streams.push(a3);
    const a4 = await new SseStream("A-4", cookieOf(sessionA)).open();
    streams.push(a4);
    check(
      "S5",
      "每用户连接上限：3 连可达、第 4 条拒新 429（RATE_LIMITED）",
      "a2=200 / a3=200 / a4=429",
      short({ a2: a2.status, a3: a3.status, a4: a4.status, a4code: a4.body?.code }),
      a2.status === 200 && a3.status === 200 && a4.status === 429 && a4.body?.code === "RATE_LIMITED",
    );

    a3.close();
    const a5 = await waitUntil(async () => {
      const candidate = await new SseStream("A-5", cookieOf(sessionA)).open();
      if (candidate.status === 200) {
        streams.push(candidate);
        return candidate;
      }
      candidate.close();
      await sleep(200);
      return undefined;
    }, 5000);
    check("S5b", "关闭一条后空位可复用（新连接 200）", "200", String(a5?.status ?? "超时"), a5?.status === 200);

    // ------------------------------------------------------------------ S6 心跳
    const ping = await b1.waitForComment(": ping", HEARTBEAT_WAIT_MS);
    check("S6", "空闲连接心跳注释行（周期 = NOTIFY_STREAM_HEARTBEAT_MS）", "≤" + HEARTBEAT_WAIT_MS + "ms 内 `: ping`", String(ping), ping !== null);
  } finally {
    for (const stream of streams) stream.close();
    try {
      if (!cleanup.keep) {
        await db.query("delete from notify_delivery_messages where source_dedupe_key like $1", [DEDUPE_PREFIX + ".%"]).catch(() => {});
        await db.query("delete from notifications where source_dedupe_key like $1", [DEDUPE_PREFIX + ".%"]).catch(() => {});
        if (cleanup.tokenHashes.length > 0) {
          await db.query("delete from sessions where token_hash = any($1::text[])", [cleanup.tokenHashes]);
        }
        if (cleanup.userIds.length > 0) {
          await db.query("delete from users where id = any($1::uuid[]) and username like $2", [
            cleanup.userIds,
            USER_PREFIX + "%",
          ]);
        }
      }
      const residue = await db.query("select count(*)::int as n from notifications where source_dedupe_key like $1", [
        DEDUPE_PREFIX + ".%",
      ]);
      const userResidue = await db.query("select count(*)::int as n from users where username like $1", [USER_PREFIX + "%"]);
      const archiveResidue = await db.query("select count(*)::int as n from notify_delivery_messages where source_dedupe_key like $1", [
        DEDUPE_PREFIX + ".%",
      ]);
      check(
        "S9",
        "自清理：合成前缀零残留（--keep 时保留现场、仅留痕）",
        cleanup.keep ? "keep=true（不清理）" : "notifications=0 / archives=0 / users=0",
        short({ notifications: residue.rows[0].n, archives: archiveResidue.rows[0].n, users: userResidue.rows[0].n, keep: cleanup.keep }),
        cleanup.keep || (residue.rows[0].n === 0 && archiveResidue.rows[0].n === 0 && userResidue.rows[0].n === 0),
      );
    } catch (error) {
      check("S9", "自清理：合成前缀零残留", "清理成功", "清理失败：" + messageOf(error), false);
    }
    await db.end().catch(() => {});
  }
}

function writeReports() {
  const summary = "M5-04-1 回放汇总：PASS " + pass + " / FAIL " + fail + "（合成前缀 " + DEDUPE_PREFIX + "）";
  if (args.out !== undefined) {
    writeFileSync(
      args.out,
      "# M5-04-1 · S8-3 真机回放证据（SSE 实时推送）\n\n" +
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
  check("X", "回放主流程", "无异常（中止即报告剩余断言未执行）", "异常：" + messageOf(error), false);
  try {
    const lines = readFileSync(join(HERE, "..", "api.log"), "utf8").trimEnd().split(String.fromCharCode(10));
    const sse = lines.filter((line) => line.includes("SSE") || line.includes("NotifyStream"));
    process.stdout.write(
      "—— api.log · SSE 相关行（" + sse.length + " 条）——" + String.fromCharCode(10) +
        (sse.length === 0 ? "（无）" : sse.slice(-40).join(String.fromCharCode(10))) + String.fromCharCode(10),
    );
    process.stdout.write(
      "—— api.log 尾部（最近 40 行 · 诊断）——" + String.fromCharCode(10) +
        lines.slice(-40).join(String.fromCharCode(10)) + String.fromCharCode(10),
    );
  } catch {
    // 无 api.log（本地运行）：跳过
  }
}

writeReports();
process.exit(fail === 0 ? 0 : 1);
