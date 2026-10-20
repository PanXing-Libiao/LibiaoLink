#!/usr/bin/env node
/**
 * M5-06-2A 真机回放（Docker PostgreSQL 18 / 任意已迁移库）：
 *   ① 0061 结构：notify_delivery_messages / notify_deliveries.message_id / 关键索引与 CHECK；
 *   ② 真实归档仓储：四渠道（inbox / wecom_app / wecom_aibot / wecom_group）先归档、再写尝试，
 *      覆盖 pending → sent / failed / deferred / dead、重复 ensure 幂等与 recipientLabel 掩码；
 *   ③ outbox 清理后归档仍在（archive.outbox_id / attempt.outbox_id 置 null，正文不丢）；
 *   ④ 回填脚本：outbox 尚存可还原、outbox 已清理保留历史 null、inbox 主行与合并子行还原；
 *      dry-run 零写入、首跑补齐、二跑零新增；
 *   ⑤ 应用角色 libiaolink_api 可读写新表。
 *
 * 前置：server/dist 已构建；目标库已迁移到 0061。
 * 用法：cd server && node scripts/m5-06-2a-replay.mjs [--database-url <url>] [--json <path>]
 * 退出码：断言全过 = 0，否则 = 1。
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = join(HERE, "..");
const args = parseArgs(process.argv.slice(2));
const DATABASE_URL =
  args.databaseUrl ??
  process.env.M5_06_2A_REPLAY_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql://libiaolink_api@127.0.0.1:55432/libiaolink_m5_06_2a";
const PREFIX = "R02:replay:m5-06-2a:";
const USER_ID = randomUUID();
// 归档写入晚于 `created_at default now()`：回放时钟取未来 60s，避免固定历史时刻触发时间戳 CHECK。
const AT = new Date(Date.now() + 60_000);

const { NotifyDeliveryArchiveRepository } = await import(
  pathToFileURL(join(SERVER_ROOT, "dist", "modules", "notify", "notify.delivery-archive.repository.js")).href
);
const schema = await import(pathToFileURL(join(SERVER_ROOT, "dist", "db", "schema", "index.js")).href);
const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 4, application_name: "m5-06-2a-replay" });
const db = drizzle(pool, { schema });
const archive = new NotifyDeliveryArchiveRepository({ db });
const checks = [];
let pass = 0;
let fail = 0;

try {
  await cleanup();
  await seedUser();

  await check("0061 结构：消息归档表 / message_id / 关键索引", async () => {
    const table = await one(
      `select count(*)::int as count from information_schema.tables where table_schema='public' and table_name='notify_delivery_messages'`,
    );
    assert.equal(table.count, 1);
    const column = await one(
      `select count(*)::int as count from information_schema.columns where table_schema='public' and table_name='notify_deliveries' and column_name='message_id'`,
    );
    assert.equal(column.count, 1);
    const indexes = await many(
      `select indexname from pg_indexes where schemaname='public' and tablename in ('notify_delivery_messages','notify_deliveries')`,
    );
    const names = new Set(indexes.map((row) => row.indexname));
    for (const name of [
      "uq_notify_delivery_messages_source",
      "ix_notify_delivery_messages_channel_created",
      "ix_notify_delivery_messages_state_created",
      "ix_notify_delivery_messages_rule_created",
      "ix_notify_deliveries_message",
    ]) {
      assert.ok(names.has(name), "缺索引 " + name);
    }
    return "表 + message_id + 5 索引";
  });

  let appOutboxId;
  await check("四渠道归档 + attempt 状态机（pending → sent/failed/deferred/dead）", async () => {
    const inbox = await archive.ensureMessage(messageInput("inbox-sent", "inbox", null, null));
    const pending = await one(`select last_state from notify_delivery_messages where id=$1`, [inbox.id]);
    assert.equal(pending.last_state, "pending");
    await archive.markState({ messageId: inbox.id, state: "sent", at: AT, sentAt: AT });

    appOutboxId = await insertOutbox("notify.message", PREFIX + "app:sent", notifyPayload("app:sent"));
    const app = await archive.ensureMessage(messageInput("app-sent", "wecom_app", appOutboxId, USER_ID));
    await archive.recordAttempt({
      messageId: app.id,
      outboxId: appOutboxId,
      channel: "wecom_app",
      target: "replay-userid",
      recipientLabel: "****rid",
      state: "failed",
      attempts: 1,
      error: "临时失败",
      sentAt: null,
      at: AT,
    });
    await archive.recordAttempt({
      messageId: app.id,
      outboxId: appOutboxId,
      channel: "wecom_app",
      target: "replay-userid",
      recipientLabel: "****rid",
      state: "sent",
      attempts: 1,
      error: null,
      sentAt: new Date(AT.getTime() + 1_000),
      at: new Date(AT.getTime() + 1_000),
    });

    const aibot = await archive.ensureMessage(messageInput("aibot-deferred", "wecom_aibot", null, USER_ID));
    await archive.recordAttempt({
      messageId: aibot.id,
      outboxId: null,
      channel: "wecom_aibot",
      target: "replay-open-userid",
      recipientLabel: "****erid",
      state: "deferred",
      attempts: 0,
      error: "限速",
      sentAt: null,
      at: AT,
    });

    const group = await archive.ensureMessage(messageInput("group-dead", "wecom_group", null, null));
    await archive.recordAttempt({
      messageId: group.id,
      outboxId: null,
      channel: "wecom_group",
      target: "replay-chatid",
      recipientLabel: "****atid",
      state: "dead",
      attempts: 1,
      error: "永久失败",
      sentAt: null,
      at: AT,
    });

    const again = await archive.ensureMessage(messageInput("group-dead", "wecom_group", null, null));
    assert.equal(again.id, group.id);
    const appRow = await one(
      `select last_state, attempt_count, last_error, sent_at, recipient_label from notify_delivery_messages where id=$1`,
      [app.id],
    );
    assert.equal(appRow.last_state, "sent");
    assert.equal(appRow.attempt_count, 2);
    assert.equal(appRow.last_error, null);
    assert.equal(appRow.sent_at.toISOString(), new Date(AT.getTime() + 1_000).toISOString());
    assert.equal(appRow.recipient_label, "****rid");
    const attempts = await many(
      `select channel, state, message_id from notify_deliveries where message_id is not null and target like 'replay-%' order by id`,
    );
    assert.deepEqual(attempts.map((row) => row.channel), ["wecom_app", "wecom_app", "wecom_aibot", "wecom_group"]);
    assert.ok(attempts.every((row) => row.message_id !== null));
    return "inbox / app / aibot / group · 4 尝试 + 1 次幂等 ensure";
  });

  await check("outbox 清理：消息归档与尝试留档保留", async () => {
    await execute(`delete from outbox_events where id=$1`, [appOutboxId]);
    const message = await one(
      `select outbox_id, body, last_state from notify_delivery_messages where source_dedupe_key=$1`,
      [PREFIX + "app-sent"],
    );
    assert.equal(message.outbox_id, null);
    assert.equal(message.last_state, "sent");
    assert.match(message.body, /回放正文/);
    const attempt = await one(
      `select outbox_id, message_id from notify_deliveries where channel='wecom_app' and target='replay-userid' order by id desc limit 1`,
    );
    assert.equal(attempt.outbox_id, null);
    assert.ok(attempt.message_id !== null);
    return "outbox FK set null；归档正文仍可读";
  });

  await check("回填 dry-run：外部 + inbox 均零写入", async () => {
    await seedBackfillFixtures();
    const before = await countArchives(PREFIX + "backfill:");
    const run = runBackfill(["--dry-run"]);
    assert.equal(run.dryRun, true);
    assert.ok(run.externalMessagesInserted >= 1);
    assert.ok(run.inboxMessagesInserted >= 2);
    assert.equal(await countArchives(PREFIX + "backfill:"), before);
    return "dry-run 报告 " + run.externalMessagesInserted + " 外部 / " + run.inboxMessagesInserted + " inbox，库内零写入";
  });

  await check("回填首跑：outbox 尚存还原 + 尝试关联 + inbox 主/子行", async () => {
    const run = runBackfill([]);
    assert.equal(run.externalMessagesInserted, 1);
    assert.equal(run.externalAttemptsLinked, 1);
    assert.equal(run.externalGapUnlinked, 1);
    assert.equal(run.inboxMessagesInserted, 2);
    const external = await one(
      `select m.channel, m.body, m.rule_code, d.message_id
       from notify_delivery_messages m join notify_deliveries d on d.message_id=m.id
       where m.source_dedupe_key=$1`,
      [PREFIX + "backfill:external"],
    );
    assert.equal(external.channel, "wecom_app");
    assert.equal(external.rule_code, "R02");
    assert.match(external.body, /回填外部正文/);
    const child = await one(
      `select last_state, metadata from notify_delivery_messages where source_dedupe_key=$1`,
      [PREFIX + "backfill:inbox-child"],
    );
    assert.equal(child.last_state, "sent");
    assert.ok(child.metadata.mergedIntoId > 0);
    const gap = await one(
      `select message_id from notify_deliveries where target='replay-gap-target'`,
    );
    assert.equal(gap.message_id, null);
    return "外部 1 条 + inbox 2 条；历史 null gap=1";
  });

  await check("回填二跑：零新增 / 零重链", async () => {
    const run = runBackfill([]);
    assert.equal(run.externalMessagesInserted, 0);
    assert.equal(run.externalAttemptsLinked, 0);
    assert.equal(run.inboxMessagesInserted, 0);
    assert.equal(run.externalGapUnlinked, 1);
    return "二跑 0 / 0 / 0，gap 保留";
  });
} catch (error) {
  fail += 1;
  console.error("FAIL  replay 中止 —— " + errorMessage(error));
} finally {
  await cleanup();
  await pool.end();
}

const result = { ok: fail === 0, pass, fail, checks };
console.log(JSON.stringify(result, null, 2));
if (args.json !== undefined) writeFileSync(args.json, JSON.stringify(result, null, 2) + "\n", "utf8");
process.exitCode = fail === 0 ? 0 : 1;

async function check(name, work) {
  try {
    const detail = await work();
    pass += 1;
    checks.push({ name, ok: true, detail: detail ?? null });
    console.log("PASS  " + name + (detail ? " —— " + detail : ""));
  } catch (error) {
    fail += 1;
    checks.push({ name, ok: false, error: errorMessage(error) });
    console.error("FAIL  " + name + " —— " + errorMessage(error));
  }
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (item === "--database-url") out.databaseUrl = argv[++i];
    else if (item === "--json") out.json = argv[++i];
    else if (item === "--help" || item === "-h") {
      console.log("用法：node scripts/m5-06-2a-replay.mjs [--database-url <url>] [--json <path>]");
      process.exit(0);
    } else throw new Error("未知参数：" + item);
  }
  return out;
}

function messageInput(key, channel, outboxId, recipientId) {
  const topic = channel === "wecom_group" ? "notify.group" : "notify.message";
  return {
    outboxId,
    sourceDedupeKey: PREFIX + key,
    topic,
    channel,
    recipientId,
    recipientLabel: channel === "wecom_group" ? "project:" + randomUUID() : null,
    title: "回放标题",
    body: "回放正文 " + key,
    templateCode: "R02_REPLAY",
    ruleCode: "R02",
    refType: "task",
    refId: randomUUID(),
    payload: channel === "wecom_group" ? notifyGroupPayload() : notifyPayload(key),
    metadata: { replay: true },
  };
}

function notifyPayload(key) {
  return {
    recipientId: USER_ID,
    type: "reminder",
    channel: "wecom_app",
    title: "回放标题",
    body: "回放正文 " + key,
  };
}

function notifyGroupPayload() {
  return {
    projectId: randomUUID(),
    title: "回放群标题",
    body: "回放群正文",
    templateCode: "R06_GROUP",
  };
}

async function insertOutbox(topic, dedupeKey, payload) {
  const row = await one(
    `insert into outbox_events (topic, payload, dedupe_key, status, created_at, updated_at)
     values ($1, $2::jsonb, $3, 'done', now(), now()) returning id`,
    [topic, JSON.stringify(payload), dedupeKey],
  );
  return Number(row.id);
}

async function seedUser() {
  await execute(
    `insert into users (id, casdoor_id, username, display_name, status)
     values ($1, $2, 'replay-2a-user', '回放用户', 'active')`,
    [USER_ID, "replay-2a-" + USER_ID],
  );
}

async function seedBackfillFixtures() {
  const outboxId = await insertOutbox("notify.message", PREFIX + "backfill:external", {
    recipientId: USER_ID,
    type: "reminder",
    channel: "wecom_app",
    title: "回填外部标题",
    body: "回填外部正文",
    templateCode: "R02_WECOM",
  });
  await execute(
    `insert into notify_deliveries (outbox_id, channel, target, state, attempts, error, sent_at, created_at)
     values ($1, 'wecom_app', 'replay-backfill-userid', 'sent', 1, null, $2, $2)`,
    [outboxId, AT],
  );

  const clearedOutboxId = await insertOutbox("notify.message", PREFIX + "backfill:cleared", {
    recipientId: USER_ID,
    type: "reminder",
    channel: "wecom_app",
    title: "已清理",
    body: "已清理正文",
  });
  await execute(
    `insert into notify_deliveries (outbox_id, channel, target, state, attempts, error, sent_at, created_at)
     values ($1, 'wecom_app', 'replay-gap-target', 'sent', 1, null, $2, $2)`,
    [clearedOutboxId, AT],
  );
  await execute(`delete from outbox_events where id=$1`, [clearedOutboxId]);

  const parent = await one(
    `insert into notifications (
       recipient_id, type, title, body, status, source_topic, source_dedupe_key,
       template_code, merge_key, merged_count, deliver_at, delivered_at, created_at, updated_at
     ) values ($1, 'reminder', '回填 inbox 主行', '回填 inbox 正文', 'read', 'notify.message', $2,
       'R02_INBOX', 'backfill-parent', 2, $3, $3, $3, $3) returning id`,
    [USER_ID, PREFIX + "backfill:inbox-parent", AT],
  );
  await execute(
    `insert into notifications (
       recipient_id, type, title, body, status, source_topic, source_dedupe_key,
       template_code, merge_key, merged_count, merged_into_id, deliver_at, created_at, updated_at
     ) values ($1, 'reminder', '回填 inbox 子行', '回填合并正文', 'unread', 'notify.message', $2,
       'R02_INBOX', 'backfill-child', 1, $3, $4, $4, $4)`,
    [USER_ID, PREFIX + "backfill:inbox-child", parent.id, AT],
  );
}

function runBackfill(extraArgs) {
  const stdout = execFileSync(
    process.execPath,
    [join(SERVER_ROOT, "scripts", "m5-06-backfill-delivery-messages.mjs"), ...extraArgs],
    {
      cwd: SERVER_ROOT,
      env: { ...process.env, DATABASE_URL },
      encoding: "utf8",
    },
  );
  return JSON.parse(stdout);
}

async function countArchives(prefix) {
  const row = await one(
    `select count(*)::int as count from notify_delivery_messages where source_dedupe_key like $1`,
    [prefix + "%"],
  );
  return row.count;
}

async function cleanup() {
  await execute(`delete from notify_delivery_messages where source_dedupe_key like $1`, [PREFIX + "%"]);
  await execute(`delete from notifications where source_dedupe_key like $1`, [PREFIX + "%"]);
  await execute(`delete from notify_deliveries where target like 'replay-%'`);
  await execute(`delete from outbox_events where dedupe_key like $1`, [PREFIX + "%"]);
  await execute(`delete from users where id=$1`, [USER_ID]);
}

async function one(sql, params = []) {
  const result = await pool.query(sql, params);
  assert.ok(result.rows[0] !== undefined, "查询无结果：" + sql);
  return result.rows[0];
}

async function many(sql, params = []) {
  return (await pool.query(sql, params)).rows;
}

async function execute(sql, params = []) {
  await pool.query(sql, params);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
