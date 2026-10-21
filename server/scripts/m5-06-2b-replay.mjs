#!/usr/bin/env node
/**
 * M5-06-2B 真机回放（Docker PostgreSQL 18 / 已迁移库）：
 *   ① 读面：渠道 / 状态 / 规则 / 收件人 / 时间 / 关键字筛选，createdAt desc + id desc；
 *   ② 掩码：尝试 target 只回末 4 位，错误中的 token / secret 脱敏；
 *   ③ 重发门禁：仅 failed / dead 外部渠道；inbox / email / pending / deferred / sent 409；
 *   ④ 重发事务：新归档 pending + 新 outbox pending + 审计 update / notify_delivery，原消息 / 原尝试不变；
 *   ⑤ 幂等：同 Idempotency-Key 重复 / 并发 / 原消息状态变化后重试均收敛；不同 key 各自新建；
 *   ⑥ HTTP（可选）：真实管理员 / 无权限会话，403 / 400 / 409 / 200 与静态路由顺序。
 *
 * 前置：server/dist 已构建；目标库已迁移（或加 --migrate 先跑 0001~0061 + roles / role-permissions seed）。
 * 用法：cd server && node scripts/m5-06-2b-replay.mjs [--base-url http://127.0.0.1:3012]
 * 退出码：断言全过 = 0，否则 = 1。
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { and, eq, inArray, like, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = join(HERE, "..");
const REPO_ROOT = join(SERVER_ROOT, "..");
const args = parseArgs(process.argv.slice(2));
const DATABASE_URL =
  args.databaseUrl ??
  process.env.M5_06_2B_REPLAY_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql://libiaolink_api@127.0.0.1:55432/libiaolink_m5_06_2b";
const BASE_URL = args.baseUrl ?? process.env.M5_06_2B_BASE_URL ?? null;

const TAG = "M5-06-2B-REPLAY-" + randomUUID().slice(0, 8);
const PREFIX = "R02:replay:m5-06-2b:" + TAG + ":";
const NOW = new Date();
const ADMIN_ID = randomUUID();
const DENIED_ID = randomUUID();
const HTTP_SESSION_TOKEN = randomBytes(32).toString("base64url");
const HTTP_CSRF_TOKEN = randomBytes(16).toString("base64url");
const DENIED_SESSION_TOKEN = randomBytes(32).toString("base64url");
const DENIED_CSRF_TOKEN = randomBytes(16).toString("base64url");
const PROJECT_ID = randomUUID();
const fixtureIds = [];
const expectedOutboxKeys = [];
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
      console.log("用法：node scripts/m5-06-2b-replay.mjs [--database-url <url>] [--base-url <url>] [--migrate] [--json <path>] [--keep]");
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

function seedOnly(name) {
  return execFileSync(process.execPath, [join(REPO_ROOT, "database", "scripts", "seed.mjs"), "--only=" + name], {
    cwd: join(REPO_ROOT, "database"),
    env: { ...process.env, DATABASE_URL },
    encoding: "utf8",
  });
}

function resendKey(actorId, messageId, idempotencyKey) {
  return "resend:" + messageId + ":" + createHash("sha256").update(actorId + "\n" + idempotencyKey).digest("hex");
}

async function main() {
  if (args.migrate) {
    const bootstrap = new pg.Client({ connectionString: DATABASE_URL });
    await bootstrap.connect();
    try {
      await bootstrap.query(readFileSync(join(REPO_ROOT, "database", "roles", "0001_roles.sql"), "utf8"));
    } finally {
      await bootstrap.end();
    }
    execFileSync(process.execPath, [join(REPO_ROOT, "database", "scripts", "migrate.mjs")], {
      cwd: join(REPO_ROOT, "database"),
      env: { ...process.env, DATABASE_URL },
      stdio: "inherit",
    });
  }
  seedOnly("roles");
  seedOnly("role-permissions");

  const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 6, application_name: "m5-06-2b-replay" });
  const db = drizzle(pool);
  const schema = await import(pathToFileURL(join(SERVER_ROOT, "dist", "db", "schema", "index.js")).href);
  const readModule = await import(pathToFileURL(join(SERVER_ROOT, "dist", "modules", "notify", "notify.delivery-read.repository.js")).href);
  const serviceModule = await import(pathToFileURL(join(SERVER_ROOT, "dist", "modules", "notify", "notify.delivery.service.js")).href);
  const auditRepositoryModule = await import(pathToFileURL(join(SERVER_ROOT, "dist", "modules", "audit", "audit.repository.js")).href);
  const auditServiceModule = await import(pathToFileURL(join(SERVER_ROOT, "dist", "modules", "audit", "audit.service.js")).href);
  const appErrorModule = await import(pathToFileURL(join(SERVER_ROOT, "dist", "common", "errors", "app-error.js")).href);
  const {
    auditLogs,
    notifyDeliveryMessages,
    notifyDeliveries,
    outboxEvents,
    roles,
    sessions,
    userRoles,
    users,
  } = schema;

  const database = { pool, db };
  const repository = new readModule.NotifyDeliveryReadRepository(database);
  const audit = new auditServiceModule.AuditService(database, new auditRepositoryModule.AuditRepository(database));
  const permission = {
    async assertCan(actorId) {
      if (actorId === DENIED_ID) throw new appErrorModule.AppError("FORBIDDEN", "回放：无权限");
    },
  };
  const service = new serviceModule.NotifyDeliveryService(repository, database, permission, audit);

  try {
    await check("夹具：管理员 / 无权限用户 / 8 条消息 / 4 条尝试", async () => {
      await db.insert(users).values([
        { id: ADMIN_ID, casdoorId: "replay-2b-admin-" + ADMIN_ID.slice(0, 8), username: "replay-2b-admin", displayName: "回放 2B 管理员" },
        { id: DENIED_ID, casdoorId: "replay-2b-denied-" + DENIED_ID.slice(0, 8), username: "replay-2b-denied", displayName: "回放 2B 无权限" },
      ]);
      const base = new Date(NOW.getTime() - 3_600_000);
      const rows = [
        { key: "failed-app", channel: "wecom_app", state: "failed", hour: 7, body: TAG + " failed app", error: "access_token=secret-token 调用失败" },
        { key: "dead-group", channel: "wecom_group", state: "dead", hour: 6, body: TAG + " dead group", error: "secret=top-secret" },
        { key: "sent-app", channel: "wecom_app", state: "sent", hour: 5, body: TAG + " sent app", error: null },
        { key: "pending-app", channel: "wecom_app", state: "pending", hour: 4, body: TAG + " pending app", error: null },
        { key: "inbox-sent", channel: "inbox", state: "sent", hour: 3, body: TAG + " inbox sent", error: null },
        { key: "email-dead", channel: "email", state: "dead", hour: 2, body: TAG + " email dead", error: "邮件未落地" },
        { key: "deferred-app", channel: "wecom_app", state: "deferred", hour: 1, body: TAG + " deferred app", error: "限速延期" },
        { key: "http-failed", channel: "wecom_app", state: "failed", hour: 0, body: TAG + " http failed", error: "HTTP 重发夹具" },
      ];
      for (const row of rows) {
        const createdAt = new Date(base.getTime() + row.hour * 60_000);
        const topic = row.channel === "wecom_group" ? "notify.group" : "notify.message";
        const payload =
          topic === "notify.group"
            ? { projectId: PROJECT_ID, title: "2B 群播报", body: row.body }
            : {
                recipientId: ADMIN_ID,
                type: "reminder",
                channel: row.channel,
                title: "2B 回放",
                body: row.body,
                templateCode: "R02_WECOM",
              };
        const inserted = await db
          .insert(notifyDeliveryMessages)
          .values({
            sourceDedupeKey: PREFIX + row.key,
            topic,
            channel: row.channel,
            recipientId: row.channel === "wecom_group" ? null : ADMIN_ID,
            recipientLabel: row.channel === "wecom_group" ? "project:" + PROJECT_ID + " · ****5678" : "****1234",
            title: "2B 回放",
            body: row.body,
            templateCode: "R02_WECOM",
            ruleCode: "R02",
            refType: null,
            refId: null,
            payload,
            lastState: row.state,
            attemptCount: row.state === "sent" ? 1 : row.state === "pending" ? 0 : 1,
            lastError: row.state === "sent" || row.state === "pending" ? null : row.error,
            sentAt: row.state === "sent" ? createdAt : null,
            createdAt,
            updatedAt: createdAt,
          })
          .returning({ id: notifyDeliveryMessages.id });
        const id = Number(inserted[0].id);
        fixtureIds.push(id);
        row.id = id;
      }
      const attemptRows = [
        { key: "failed-app", target: "full-userid-1234", state: "failed", error: "access_token=secret-token 调用失败" },
        { key: "dead-group", target: "full-chatid-5678", state: "dead", error: "secret=top-secret" },
        { key: "sent-app", target: "full-userid-9999", state: "sent", error: null },
        { key: "deferred-app", target: "full-userid-0000", state: "deferred", error: "限速延期" },
      ];
      for (const attempt of attemptRows) {
        const owner = rows.find((row) => row.key === attempt.key);
        await db.insert(notifyDeliveries).values({
          messageId: owner.id,
          channel: owner.channel,
          target: attempt.target,
          state: attempt.state,
          attempts: 1,
          error: attempt.error,
          sentAt: attempt.state === "sent" ? owner.createdAt ?? NOW : null,
        });
      }
      return rows.length + " 消息 / " + attemptRows.length + " 尝试";
    });

    const rowsByKey = Object.fromEntries(
      (await db.select().from(notifyDeliveryMessages).where(like(notifyDeliveryMessages.sourceDedupeKey, PREFIX + "%"))).map((row) => [
        row.sourceDedupeKey.slice(PREFIX.length),
        row,
      ]),
    );

    await check("读面：关键字 / 渠道 / 状态筛选，createdAt desc + id desc", async () => {
      const listed = await service.list(ADMIN_ID, { q: TAG, page: 1, limit: 50 });
      assert.equal(listed.total, 8);
      assert.equal(listed.items[0].id, rowsByKey["failed-app"].id);
      const failed = await service.list(ADMIN_ID, { channel: "wecom_app", lastState: "failed", q: TAG, page: 1, limit: 50 });
      assert.equal(failed.total, 2);
      assert.ok(failed.items.every((item) => item.channel === "wecom_app" && item.lastState === "failed"));
      const byRule = await service.list(ADMIN_ID, { ruleCode: "R02", q: TAG, page: 1, limit: 50 });
      assert.equal(byRule.total, 8);
      assert.ok(byRule.items.every((item) => item.ruleCode === "R02"));
      const byRecipient = await service.list(ADMIN_ID, { recipientId: ADMIN_ID, q: TAG, page: 1, limit: 50 });
      assert.equal(byRecipient.total, 7);
      assert.ok(byRecipient.items.every((item) => item.recipientId === ADMIN_ID));
      const timeWindow = await service.list(ADMIN_ID, {
        q: TAG,
        from: new Date(rowsByKey["pending-app"].createdAt.getTime() - 1_000).toISOString(),
        to: new Date(rowsByKey["dead-group"].createdAt.getTime() + 1_000).toISOString(),
        page: 1,
        limit: 50,
      });
      assert.equal(timeWindow.total, 3);
      const paged = await service.list(ADMIN_ID, { q: TAG, page: 2, limit: 3 });
      assert.equal(paged.total, 8);
      assert.equal(paged.items.length, 3);
      return "total=8 / failed=2 / rule=8 / recipient=7 / window=3 / page2=3";
    });

    await check("详情：target 末 4 位 + 错误脱敏；不存在 404", async () => {
      const detail = await service.detail(ADMIN_ID, rowsByKey["failed-app"].id);
      assert.equal(detail.attempts.length, 1);
      assert.equal(detail.attempts[0].targetMasked, "****1234");
      assert.equal(detail.attempts[0].error, "access_token=*** 调用失败");
      assert.ok(!JSON.stringify(detail).includes("full-userid-1234"));
      await assert.rejects(() => service.detail(ADMIN_ID, 999999999), (error) => error.code === "NOT_FOUND" && error.httpStatus === 404);
      return "targetMasked ****1234 / 404";
    });

    await check("重发门禁：inbox / email / pending / deferred / sent 409", async () => {
      for (const key of ["inbox-sent", "email-dead", "pending-app", "deferred-app", "sent-app"]) {
        await assert.rejects(
          () => service.resend(ADMIN_ID, rowsByKey[key].id, "guard-key-" + key),
          (error) => error.code === "VERSION_CONFLICT" && error.httpStatus === 409,
        );
      }
      return "5 类非法状态 / 渠道均 409";
    });

    await check("重发：failed app → 新归档 pending + 新 outbox + 审计；原记录不变", async () => {
      const original = rowsByKey["failed-app"];
      const key = "svc-resend-key";
      expectedOutboxKeys.push(resendKey(ADMIN_ID, original.id, key));
      const attemptsBefore = await db.select().from(notifyDeliveries).where(eq(notifyDeliveries.messageId, original.id)).orderBy(notifyDeliveries.id);
      const result = await service.resend(ADMIN_ID, original.id, key);
      assert.equal(result.message.lastState, "pending");
      assert.equal(result.message.resendOfMessageId, original.id);
      const after = (await db.select().from(notifyDeliveryMessages).where(eq(notifyDeliveryMessages.id, original.id)))[0];
      assert.equal(after.lastState, "failed");
      assert.equal(after.attemptCount, original.attemptCount);
      const outbox = (await db.select().from(outboxEvents).where(eq(outboxEvents.dedupeKey, expectedOutboxKeys.at(-1))))[0];
      assert.equal(outbox.topic, "notify.message");
      assert.equal(outbox.status, "pending");
      assert.deepEqual(outbox.payload, original.payload);
      const audits = await db.select().from(auditLogs).where(and(eq(auditLogs.actorId, ADMIN_ID), eq(auditLogs.objectType, "notify_delivery")));
      assert.equal(audits.length, 1);
      assert.equal(audits[0].objectId, String(result.message.id));
      assert.equal(audits[0].metadata.operation, "resend");
      assert.equal(audits[0].metadata.sourceMessageId, original.id);
      const attemptsAfter = await db.select().from(notifyDeliveries).where(eq(notifyDeliveries.messageId, original.id)).orderBy(notifyDeliveries.id);
      assert.deepEqual(attemptsAfter, attemptsBefore);
      return "new message=" + result.message.id + " / outbox=" + outbox.id;
    });

    await check("重发幂等：同 key 重复 + 并发收敛；不同 key 各自新建；状态变化不破坏同 key 重试", async () => {
      const original = rowsByKey["dead-group"];
      const firstKey = "svc-concurrent-key";
      const secondKey = "svc-different-key";
      const firstOutboxKey = resendKey(ADMIN_ID, original.id, firstKey);
      const secondOutboxKey = resendKey(ADMIN_ID, original.id, secondKey);
      expectedOutboxKeys.push(firstOutboxKey, secondOutboxKey);
      const [left, right] = await Promise.all([
        service.resend(ADMIN_ID, original.id, firstKey),
        service.resend(ADMIN_ID, original.id, firstKey),
      ]);
      const different = await service.resend(ADMIN_ID, original.id, secondKey);
      assert.notEqual(different.message.id, left.message.id);
      await db
        .update(notifyDeliveryMessages)
        .set({ lastState: "sent", sentAt: NOW, lastError: null, updatedAt: NOW })
        .where(eq(notifyDeliveryMessages.id, original.id));
      const again = await service.resend(ADMIN_ID, original.id, firstKey);
      assert.equal(left.message.id, right.message.id);
      assert.equal(again.message.id, left.message.id);
      const firstOutbox = await db.select().from(outboxEvents).where(eq(outboxEvents.dedupeKey, firstOutboxKey));
      const secondOutbox = await db.select().from(outboxEvents).where(eq(outboxEvents.dedupeKey, secondOutboxKey));
      assert.equal(firstOutbox.length, 1);
      assert.equal(secondOutbox.length, 1);
      const audits = await db.select().from(auditLogs).where(and(eq(auditLogs.actorId, ADMIN_ID), eq(auditLogs.objectId, String(left.message.id))));
      assert.equal(audits.length, 1);
      return "message=" + left.message.id + " / same-key outbox=1 / different-key outbox=1 / audit=1";
    });

    await check("无权限：读 / 重发均 FORBIDDEN", async () => {
      await assert.rejects(() => service.list(DENIED_ID, { page: 1, limit: 10 }), (error) => error.code === "FORBIDDEN");
      await assert.rejects(() => service.resend(DENIED_ID, rowsByKey["failed-app"].id, "denied-key-123"), (error) => error.code === "FORBIDDEN");
      return "list / resend 均 403";
    });

    if (BASE_URL !== null) {
      await check("HTTP：管理员会话读面 / 详情 / 重发 / 重复 key / 409 / 400", async () => {
        const adminRole = (await db.select({ id: roles.id }).from(roles).where(eq(roles.code, "admin")))[0];
        assert.ok(adminRole);
        await db.insert(userRoles).values({ userId: ADMIN_ID, roleId: adminRole.id });
        const now = new Date();
        await db.insert(sessions).values({
          tokenHash: createHash("sha256").update(HTTP_SESSION_TOKEN).digest("hex"),
          userId: ADMIN_ID,
          idToken: "replay-2b-http",
          lastSeenAt: now,
          expiresAt: new Date(now.getTime() + 3_600_000),
        });
        const headers = {
          cookie: "ll_sid=" + HTTP_SESSION_TOKEN + "; ll_csrf=" + HTTP_CSRF_TOKEN,
          "x-csrf-token": HTTP_CSRF_TOKEN,
        };
        const list = await httpJson(BASE_URL, "/api/v1/notifications/deliveries?q=" + encodeURIComponent(TAG) + "&page=1&limit=50", { headers });
        assert.equal(list.status, 200);
        assert.equal(list.body.total, 11);
        const detail = await httpJson(BASE_URL, "/api/v1/notifications/deliveries/" + rowsByKey["failed-app"].id, { headers });
        assert.equal(detail.status, 200);
        assert.equal(detail.body.attempts[0].targetMasked, "****1234");
        assert.ok(!JSON.stringify(detail.body).includes("full-userid-1234"));
        const missingDetail = await httpJson(BASE_URL, "/api/v1/notifications/deliveries/999999999", { headers });
        assert.equal(missingDetail.status, 404);
        const forbidden = await httpJson(BASE_URL, "/api/v1/notifications/deliveries?page=1&limit=10", { headers: { cookie: "ll_sid=" + DENIED_SESSION_TOKEN } });
        assert.equal(forbidden.status, 401);

        const original = rowsByKey["http-failed"];
        const key = "http-resend-key";
        expectedOutboxKeys.push(resendKey(ADMIN_ID, original.id, key));
        const resend = await httpJson(BASE_URL, "/api/v1/notifications/deliveries/" + original.id + "/resend", {
          method: "POST",
          headers: { ...headers, "content-type": "application/json", "Idempotency-Key": key },
          body: "{}",
        });
        assert.equal(resend.status, 200);
        assert.equal(resend.body.message.lastState, "pending");
        const again = await httpJson(BASE_URL, "/api/v1/notifications/deliveries/" + original.id + "/resend", {
          method: "POST",
          headers: { ...headers, "content-type": "application/json", "Idempotency-Key": key },
          body: "{}",
        });
        assert.equal(again.status, 200);
        assert.equal(again.body.message.id, resend.body.message.id);
        const conflict = await httpJson(BASE_URL, "/api/v1/notifications/deliveries/" + rowsByKey["sent-app"].id + "/resend", {
          method: "POST",
          headers: { ...headers, "content-type": "application/json", "Idempotency-Key": "http-conflict-key" },
          body: "{}",
        });
        assert.equal(conflict.status, 409);
        assert.equal(conflict.body.code, "VERSION_CONFLICT");
        const missingKey = await httpJson(BASE_URL, "/api/v1/notifications/deliveries/" + original.id + "/resend", {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: "{}",
        });
        assert.equal(missingKey.status, 400);
        const extraField = await httpJson(BASE_URL, "/api/v1/notifications/deliveries/" + original.id + "/resend", {
          method: "POST",
          headers: { ...headers, "content-type": "application/json", "Idempotency-Key": "http-extra-key" },
          body: JSON.stringify({ body: "篡改" }),
        });
        assert.equal(extraField.status, 400);
        return "list 200 / detail 200 / missing 404 / resend 200 / same id / 409 / 400";
      });

      await check("HTTP：无权限会话（有效 session 无 admin 角色）GET / POST 均 403", async () => {
        const now = new Date();
        await db.insert(sessions).values({
          tokenHash: createHash("sha256").update(DENIED_SESSION_TOKEN).digest("hex"),
          userId: DENIED_ID,
          idToken: "replay-2b-denied",
          lastSeenAt: now,
          expiresAt: new Date(now.getTime() + 3_600_000),
        });
        const headers = {
          cookie: "ll_sid=" + DENIED_SESSION_TOKEN + "; ll_csrf=" + DENIED_CSRF_TOKEN,
          "x-csrf-token": DENIED_CSRF_TOKEN,
        };
        const list = await httpJson(BASE_URL, "/api/v1/notifications/deliveries?page=1&limit=10", { headers });
        assert.equal(list.status, 403);
        const resend = await httpJson(BASE_URL, "/api/v1/notifications/deliveries/" + rowsByKey["failed-app"].id + "/resend", {
          method: "POST",
          headers: { ...headers, "content-type": "application/json", "Idempotency-Key": "denied-http-key" },
          body: "{}",
        });
        assert.equal(resend.status, 403);
        return "GET 403 / POST 403";
      });
    } else {
      console.log("http: 未提供 --base-url / M5_06_2B_BASE_URL，跳过 HTTP 会话断言");
    }
  } finally {
    if (!args.keep) {
      await cleanup(db);
    } else {
      console.log("keep: 保留夹具与变更（--keep）");
    }
    await pool.end();
  }

  console.log("\nM5-06-2B 回放：" + pass + " 通过 / " + fail + " 失败");
  if (args.json) {
    writeFileSync(args.json, JSON.stringify({ pass, fail, checks, tag: TAG }, null, 2));
  }
  if (fail > 0) process.exitCode = 1;
}

async function cleanup(db) {
  const schema = await import(pathToFileURL(join(SERVER_ROOT, "dist", "db", "schema", "index.js")).href);
  const { auditLogs, notifyDeliveryMessages, notifyDeliveries, outboxEvents, sessions, userRoles, users } = schema;
  const cleanupWhere = (ids) => {
    const conditions = [like(notifyDeliveryMessages.sourceDedupeKey, PREFIX + "%")];
    if (ids.length > 0) conditions.push(inArray(notifyDeliveryMessages.resendOfMessageId, ids));
    return conditions.length === 1 ? conditions[0] : or(...conditions);
  };
  const rows = await db
    .select({ id: notifyDeliveryMessages.id })
    .from(notifyDeliveryMessages)
    .where(cleanupWhere(fixtureIds));
  const ids = rows.map((row) => Number(row.id));
  if (ids.length > 0) {
    await db.delete(notifyDeliveries).where(inArray(notifyDeliveries.messageId, ids));
    await db.delete(outboxEvents).where(inArray(outboxEvents.dedupeKey, expectedOutboxKeys));
    await db.delete(notifyDeliveryMessages).where(inArray(notifyDeliveryMessages.id, ids));
  }
  await db.delete(auditLogs).where(and(eq(auditLogs.actorId, ADMIN_ID), eq(auditLogs.objectType, "notify_delivery")));
  await db.delete(sessions).where(inArray(sessions.userId, [ADMIN_ID, DENIED_ID]));
  await db.delete(userRoles).where(eq(userRoles.userId, ADMIN_ID));
  await db.delete(users).where(inArray(users.id, [ADMIN_ID, DENIED_ID]));

  const leftovers = await db
    .select({ value: sql`count(*)::int` })
    .from(notifyDeliveryMessages)
    .where(cleanupWhere(fixtureIds));
  assert.equal(Number(leftovers[0].value), 0);
  const audits = await db.select({ value: sql`count(*)::int` }).from(auditLogs).where(eq(auditLogs.actorId, ADMIN_ID));
  assert.equal(Number(audits[0].value), 0);
  const outboxes = expectedOutboxKeys.length === 0
    ? [{ value: 0 }]
    : await db.select({ value: sql`count(*)::int` }).from(outboxEvents).where(inArray(outboxEvents.dedupeKey, expectedOutboxKeys));
  assert.equal(Number(outboxes[0].value), 0);
  console.log("cleanup: 零残留（messages / attempts / outbox / audit / sessions / users）");
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

await main();
