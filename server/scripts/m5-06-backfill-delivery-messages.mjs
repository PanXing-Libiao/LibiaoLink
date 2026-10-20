#!/usr/bin/env node
/**
 * M5-06-2A 历史发送归档回填（幂等 · 只补缺失，不伪造成功）：
 *   ① 外部渠道：从 notify_deliveries + 仍存在的 outbox_events 还原消息级归档，并回填所有历史尝试的 message_id；
 *   ② inbox：从 notifications 还原消息级归档（合并子行保留为 sent + mergedIntoId metadata）；
 *   ③ outbox_id 已因清理置 null / 关联事件已删除：无法可信还原来源键，保留 message_id = null 并计入 gap；
 *   ④ 重复运行：已存在的 source_dedupe_key 不再插入，已关联的尝试不再更新。
 *
 * 用法：cd server && node scripts/m5-06-backfill-delivery-messages.mjs [--dry-run] [--database-url <url>] [--json <path>]
 * 退出码：0 = 完成；1 = 参数 / SQL 错误。dry-run 在事务内执行后 rollback，并输出同口径摘要。
 */
import { writeFileSync } from "node:fs";
import pg from "pg";

const args = parseArgs(process.argv.slice(2));
const DATABASE_URL =
  args.databaseUrl ??
  process.env.DATABASE_URL ??
  "postgresql://libiaolink_migrator@127.0.0.1:55432/libiaolink";

const client = new pg.Client({ connectionString: DATABASE_URL, application_name: "m5-06-2a-backfill" });
await client.connect();

const summary = {
  dryRun: args.dryRun,
  externalGroups: 0,
  externalMessagesInserted: 0,
  externalAttemptsLinked: 0,
  externalInvalidPayload: 0,
  externalAmbiguous: 0,
  externalGapUnlinked: 0,
  inboxMessagesInserted: 0,
};

try {
  await client.query("begin");

  const external = await client.query(`
    select d.outbox_id, d.channel, count(*)::int as attempt_count, min(d.created_at) as first_created_at
    from notify_deliveries d
    join outbox_events o on o.id = d.outbox_id
    where d.message_id is null
    group by d.outbox_id, d.channel
    order by d.outbox_id, d.channel
  `);

  for (const group of external.rows) {
    summary.externalGroups += 1;
    const outbox = await client.query(
      `select id, topic, payload, dedupe_key from outbox_events where id = $1`,
      [group.outbox_id],
    );
    const event = outbox.rows[0];
    if (event === undefined) continue;
    const payload = asObject(event.payload);
    if (!isRestorablePayload(event.topic, payload) || !restorableChannel(group.channel)) {
      summary.externalInvalidPayload += 1;
      continue;
    }

    const latest = await client.query(
      `select id, target, state, error, sent_at
       from notify_deliveries
       where outbox_id = $1 and channel = $2 and message_id is null
       order by id desc limit 1`,
      [group.outbox_id, group.channel],
    );
    const latestAttempt = latest.rows[0];
    if (latestAttempt === undefined) continue;
    const exists = await client.query(
      `select id, channel from notify_delivery_messages where source_dedupe_key = $1`,
      [event.dedupe_key],
    );
    if (exists.rows[0] !== undefined && exists.rows[0].channel !== group.channel) {
      summary.externalAmbiguous += 1;
      continue;
    }

    const message = messageFromExternal(
      event,
      group.channel,
      latestAttempt,
      group.attempt_count,
      group.first_created_at,
    );
    const messageId = exists.rows[0]?.id ?? await insertMessage(message);
    if (exists.rows[0] === undefined) {
      summary.externalMessagesInserted += 1;
    }
    const linked = await client.query(
      `update notify_deliveries set message_id = $1
       where outbox_id = $2 and channel = $3 and message_id is null`,
      [messageId, group.outbox_id, group.channel],
    );
    summary.externalAttemptsLinked += linked.rowCount ?? 0;
  }

  const inbox = await client.query(`
    select n.id, n.recipient_id, n.type, n.title, n.body, n.ref_type, n.ref_id,
           n.source_topic, n.source_dedupe_key, n.template_code, n.merged_into_id,
           n.deliver_at, n.delivered_at, n.created_at,
           p.delivered_at as parent_delivered_at,
           o.id as outbox_id
    from notifications n
    left join notifications p on p.id = n.merged_into_id
    left join outbox_events o on o.dedupe_key = n.source_dedupe_key
    where not exists (
      select 1 from notify_delivery_messages m where m.source_dedupe_key = n.source_dedupe_key
    )
    order by n.id
  `);
  for (const row of inbox.rows) {
    await insertMessage(messageFromInbox(row));
    summary.inboxMessagesInserted += 1;
  }

  const gap = await client.query(
    `select count(*)::int as count from notify_deliveries where message_id is null`,
  );
  summary.externalGapUnlinked = gap.rows[0]?.count ?? 0;

  if (args.dryRun) {
    await client.query("rollback");
  } else {
    await client.query("commit");
  }

  console.log(JSON.stringify(summary, null, 2));
  if (args.json !== undefined) {
    writeFileSync(args.json, JSON.stringify(summary, null, 2) + "\n", "utf8");
  }
} catch (error) {
  try {
    await client.query("rollback");
  } catch {
    // 连接级失败时 rollback 也可能失败；保留原始错误。
  }
  console.error("m5-06-2a backfill 失败：" + (error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
} finally {
  await client.end();
}

function parseArgs(argv) {
  const out = { dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (item === "--dry-run") out.dryRun = true;
    else if (item === "--database-url") out.databaseUrl = argv[++i];
    else if (item === "--json") out.json = argv[++i];
    else if (item === "--help" || item === "-h") {
      console.log("用法：node scripts/m5-06-backfill-delivery-messages.mjs [--dry-run] [--database-url <url>] [--json <path>]");
      process.exit(0);
    } else {
      throw new Error("未知参数：" + item);
    }
  }
  return out;
}

async function insertMessage(message) {
  const inserted = await client.query(
    `insert into notify_delivery_messages (
       outbox_id, source_dedupe_key, topic, channel, recipient_id, recipient_label,
       title, body, template_code, rule_code, ref_type, ref_id, payload, metadata,
       last_state, attempt_count, last_error, sent_at, created_at, updated_at
     ) values (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14::jsonb,
       $15, $16, $17, $18, $19, $19
     )
     on conflict (source_dedupe_key) do nothing
     returning id`,
    [
      message.outboxId,
      message.sourceDedupeKey,
      message.topic,
      message.channel,
      message.recipientId,
      message.recipientLabel,
      message.title,
      message.body,
      message.templateCode,
      message.ruleCode,
      message.refType,
      message.refId,
      JSON.stringify(message.payload),
      JSON.stringify(message.metadata),
      message.lastState,
      message.attemptCount,
      message.lastError,
      message.sentAt,
      message.createdAt,
    ],
  );
  if (inserted.rows[0] !== undefined) return inserted.rows[0].id;
  const existing = await client.query(
    `select id from notify_delivery_messages where source_dedupe_key = $1`,
    [message.sourceDedupeKey],
  );
  if (existing.rows[0] === undefined) {
    throw new Error("归档冲突后未读回既有行：" + message.sourceDedupeKey);
  }
  return existing.rows[0].id;
}

function messageFromExternal(event, channel, latestAttempt, attemptCount, createdAt) {
  const payload = asObject(event.payload);
  const topic = event.topic;
  const projectId = optionalText(payload.projectId);
  const target = String(latestAttempt.target);
  return {
    outboxId: Number(event.id),
    sourceDedupeKey: String(event.dedupe_key),
    topic,
    channel,
    recipientId: topic === "notify.group" ? null : optionalUuid(payload.recipientId),
    recipientLabel: labelOf(channel, target, projectId),
    title: optionalText(payload.title),
    body: String(payload.body).trim(),
    templateCode: optionalText(payload.templateCode),
    ruleCode: inferRuleCode(String(event.dedupe_key)),
    refType: optionalText(payload.refType),
    refId: optionalText(payload.refId),
    payload,
    metadata: { backfill: "m5-06-2a", source: "notify_deliveries+outbox_events" },
    lastState: latestAttempt.state,
    attemptCount,
    lastError: latestAttempt.state === "sent" ? null : latestAttempt.error,
    sentAt: latestAttempt.state === "sent" ? latestAttempt.sent_at : null,
    createdAt,
  };
}

function messageFromInbox(row) {
  const merged = row.merged_into_id !== null;
  const sent = row.delivered_at !== null || merged;
  const sentAt = row.delivered_at ?? row.parent_delivered_at ?? (merged ? row.created_at : null);
  const payload = {
    recipientId: row.recipient_id,
    type: row.type,
    channel: "inbox",
    title: row.title,
    body: row.body,
    refType: row.ref_type,
    refId: row.ref_id,
    templateCode: row.template_code,
  };
  const metadata = { backfill: "m5-06-2a", source: "notifications" };
  if (String(row.source_dedupe_key).endsWith(":c504")) {
    metadata.c5_04 = true;
    metadata.sourceDedupeKey = String(row.source_dedupe_key).slice(0, -5);
  }
  if (merged) metadata.mergedIntoId = Number(row.merged_into_id);
  return {
    outboxId: row.outbox_id === null ? null : Number(row.outbox_id),
    sourceDedupeKey: String(row.source_dedupe_key),
    topic: "notify.message",
    channel: "inbox",
    recipientId: row.recipient_id,
    recipientLabel: "user:" + row.recipient_id,
    title: row.title,
    body: row.body,
    templateCode: row.template_code,
    ruleCode: inferRuleCode(String(row.source_dedupe_key)),
    refType: row.ref_type,
    refId: row.ref_id,
    payload,
    metadata,
    lastState: sent ? "sent" : "deferred",
    attemptCount: 0,
    lastError: sent ? null : "历史回填：站内信尚未投递",
    sentAt,
    createdAt: row.created_at,
  };
}

function isRestorablePayload(topic, payload) {
  return (topic === "notify.message" || topic === "notify.group")
    && optionalText(payload.body) !== null
    && optionalText(payload.body).length <= 4000;
}

function restorableChannel(channel) {
  return ["wecom_app", "wecom_aibot", "wecom_group", "email"].includes(channel);
}

function asObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function optionalText(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function optionalUuid(value) {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    ? value
    : null;
}

function inferRuleCode(dedupeKey) {
  const base = dedupeKey.endsWith(":c504") ? dedupeKey.slice(0, -5) : dedupeKey;
  const candidate = base.split(":", 1)[0]?.trim() ?? "";
  return /^[A-Za-z][A-Za-z0-9_-]{1,31}$/.test(candidate) ? candidate : null;
}

function labelOf(channel, target, projectId) {
  const masked = maskTarget(target);
  return channel === "wecom_group" && projectId !== null ? "project:" + projectId + " · " + masked : masked;
}

function maskTarget(target) {
  if (target.includes("@")) {
    const [local, domain] = target.split("@", 2);
    return (local.slice(0, 1) || "*") + "***@" + domain;
  }
  return "****" + target.slice(-4);
}
