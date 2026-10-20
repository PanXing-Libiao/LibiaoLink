#!/usr/bin/env node
/**
 * S7-4 · j1 / M5-04 首刀 真机回放（站内信投递内核）：
 *   证据一（投递落库）：真 NotifyService 消费 notify.message → notifications 一行（delivered_at 非空、
 *        source_topic / merge_key 回退口径正确），收件箱读面立即可见（total / unreadCount）。
 *   证据二（同期合并）：窗口内同人同合并键的第二条 → 并入主行（merged_into_id 指向主行、主行 merged_count=2、
 *        收件箱仍 1 条、子行全量留档）—— C2-09「同期消息合并推送」+ C5-03「全量留档」。
 *   证据三（消费幂等）：同 source_dedupe_key 重放消费 → 不新增行（唯一索引兜底，至少一次投递的配对幂等）。
 *   证据四（非法载荷）：确定性失败 → dead 分类且零落库（一次即弃，不重试轰炸）。
 *   证据五（免打扰次日补发）：上海 23:00 投递 → 静默排期到次日 08:00（deliver_at）；未到点 flush 不投；
 *        次日 flush 真正投递（C2-09 免打扰时段静默、次日补发）。
 *   证据六（每人每日上限）：当日已投递量达上限 → 排到次日窗口起点；次日 flush 投递。
 *   证据七（收件箱读面与标记）：状态 / 类型 / 关联对象过滤 + 未读角标 + 标记已读·已处理 + 全部已读 + 跨用户隔离。
 *   证据八（通知偏好）：无行 → env 缺省生效值；写入三态 / 上限 / 合并窗口 → 落库并回读（局部更新不丢键）。
 *   证据九（自清理）：本脚本合成前缀零残留（finally 兜底）。
 *
 * 前置：真 PG（迁移器角色即可）+ 已构建的 server/dist（cd server && npm run build）。
 * 用法：cd server && S7_4_DATABASE_URL=postgresql://libiaolink_migrator@127.0.0.1:55432/libiaolink \
 *       node scripts/s7-4-notify-replay.mjs [--out <报告.md>] [--json <证据.json>] [--keep]
 * 退出码：断言全过 = 0，否则 = 1（可当门禁用）。
 * 说明：本机无 PG 时只做语法门禁；真机证据以 CI database job 为准（不伪造）。合成用户名 / 去重键前缀独立，
 *   全部行取自清理时同一前缀判定（--keep 时保留现场）。
 */
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import pg from "pg";

const HERE = dirname(fileURLToPath(import.meta.url));
const args = parseArgs(process.argv.slice(2));
const DATABASE_URL =
  args.databaseUrl ??
  process.env.S7_4_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql://libiaolink_migrator@127.0.0.1:55432/libiaolink";

/** 本回放全部合成行前缀（清理 / 基线计数用）：证据专用，不落生产代码。 */
const DEDUPE_PREFIX = "s74Replay";
const USER_PREFIX = "s74rpl-";
const MINUTE_MS = 60_000;

const report = [];
const evidence = { anchors: {}, checks: [] };
let pass = 0;
let fail = 0;
let runtime;
let db;
const cleanup = { userIds: [], keep: args.keep === true };

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

/** 加载 dist（真运行时类）；缺构建时给出明确指引。 */
async function loadRuntime() {
  await import("reflect-metadata");
  const load = (relative) => import(pathToFileURL(join(HERE, "..", "dist", relative)).href);
  try {
    const [envModule, configModule, databaseModule, clockModule, repositoryModule, archiveModule, serviceModule, publisherModule] = await Promise.all([
      load("config/env.js"),
      load("config/config.module.js"),
      load("db/database.service.js"),
      load("common/clock/clock.service.js"),
      load("modules/notify/notify.repository.js"),
      load("modules/notify/notify.delivery-archive.repository.js"),
      load("modules/notify/notify.service.js"),
      load("modules/notify/notify.stream.publisher.js"),
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
    };
  } catch (error) {
    process.stderr.write("S7-4：无法加载 server/dist（先执行 cd server && npm run build）：" + String(error) + "\n");
    process.exit(1);
  }
}

/** 回放环境：只覆盖本证据需要收紧的口径（其余沿默认）；免打扰 / 上限 / 合并窗口取小巧值便于断言。 */
function buildEnv(overrides = {}) {
  return runtime.loadEnv({
    ...process.env,
    DATABASE_URL,
    NOTIFY_QUIET_HOURS: "22:00-08:00",
    NOTIFY_DAILY_LIMIT: "200",
    NOTIFY_MERGE_WINDOW_MS: "1800000",
    NOTIFY_DAILY_WINDOW_START_MINUTE: "480",
    NOTIFY_FLUSH_BATCH: "50",
    ...overrides,
  });
}

async function main() {
  runtime = await loadRuntime();
  db = new pg.Client({ connectionString: DATABASE_URL });
  await db.connect();

  const tag = randomBytes(4).toString("hex");
  const dedupe = (suffix) => DEDUPE_PREFIX + "." + tag + "." + suffix;
  let clockNow = new Date("2026-09-28T06:00:00.000Z"); // 上海 2026-09-28 14:00（非免打扰）
  const env = buildEnv();
  const clock = new runtime.ClockService();
  clock.setSource(() => clockNow);
  const config = new runtime.AppConfig(env);
  const database = new runtime.DatabaseService(config);
  const repository = new runtime.NotifyRepository(database);
  const archive = new runtime.NotifyDeliveryArchiveRepository(database);
  // S8-3（M5-04-1）：投递在事务内 pg_notify 广播（本回放无 SSE 连接 → 事件静默丢弃，不影响投递断言）。
  const notify = new runtime.NotifyService(repository, archive, database, config, clock, new runtime.NotifyStreamPublisher());

  const row = (payload, id = 1, dedupeKey = dedupe("m" + id)) => ({
    // 本回放直接构造 outbox 领取行、不落 outbox_events；2A 归档允许 outbox_id = null。
    id: null,
    topic: "notify.message",
    payload,
    dedupeKey,
    attempts: 0,
    availableAt: clockNow,
    lockedAt: clockNow,
  });
  const message = (overrides = {}) => ({
    recipientId: cleanup.userIds[0],
    type: "reminder",
    title: "日报未填",
    body: "请补填今日日报",
    ...overrides,
  });
  const notifyRows = async (pattern) => {
    const result = await db.query(
      "select id, recipient_id, status, merged_count, merged_into_id, deliver_at, delivered_at, source_topic, source_dedupe_key, merge_key, template_code from notifications where source_dedupe_key like $1 order by id",
      [pattern],
    );
    return result.rows;
  };
  const countRows = async (pattern) => (await notifyRows(pattern)).length;

  evidence.anchors = {
    tag,
    clockStart: clockNow.toISOString(),
    quietHours: env.NOTIFY_QUIET_HOURS,
    dailyLimit: env.NOTIFY_DAILY_LIMIT,
    mergeWindowMs: env.NOTIFY_MERGE_WINDOW_MS,
    dailyWindowStartMinute: env.NOTIFY_DAILY_WINDOW_START_MINUTE,
  };

  try {
    // ------------------------------------------------------------------ 基线
    const users = await db.query(
      "insert into users (casdoor_id, username, display_name, status) values ($1, $2, $3, 'active'), ($4, $5, $6, 'active') returning id, username",
      [
        USER_PREFIX + tag + "-a",
        USER_PREFIX + tag + "-a",
        "S7-4 回放收件人 A",
        USER_PREFIX + tag + "-b",
        USER_PREFIX + tag + "-b",
        "S7-4 回放收件人 B",
      ],
    );
    cleanup.userIds = users.rows.map((item) => item.id);
    const pattern = DEDUPE_PREFIX + "." + tag + ".%";
    const baseline = await countRows(pattern);
    check("S0a", "基线：合成用户与去重键前缀可用（回放自清理）", "notifications=0", "notifications=" + baseline, baseline === 0);
    const prefsBaseline = await db.query("select count(*)::int as n from notify_prefs where user_id = any($1::uuid[])", [
      cleanup.userIds,
    ]);
    check("S0b", "基线：合成用户偏好零存量", "notify_prefs=0", "notify_prefs=" + prefsBaseline.rows[0].n, prefsBaseline.rows[0].n === 0);

    // ------------------------------------------------------- 证据一：投递落库
    const outcome1 = await notify.consume(
      row(message({ refType: "report", refId: cleanup.userIds[1], templateCode: "A01_INBOX_MERGED" }), 1, dedupe("d1")),
    );
    const rows1 = await notifyRows(pattern);
    const first = rows1[0];
    check(
      "S1a",
      "投递落库：notify.message 消费 → done 且一行已投递（delivered_at 非空）",
      "done / 1 行 / delivered_at 非空 / source_topic=notify.message",
      short({ outcome: outcome1.outcome, rows: rows1.length, delivered: first?.delivered_at !== null }),
      outcome1.outcome === "done" && rows1.length === 1 && first?.delivered_at !== null && first?.source_topic === "notify.message",
    );
    check(
      "S1b",
      "合并键回退：显式 templateCode 优先于 type:refType:refId",
      "merge_key=A01_INBOX_MERGED",
      "merge_key=" + first?.merge_key,
      first?.merge_key === "A01_INBOX_MERGED",
    );
    const inbox1 = await notify.list(cleanup.userIds[0], { page: 1, limit: 50 });
    check(
      "S1c",
      "收件箱读面：立即可见（total=1 / unreadCount=1 / 契约字段齐全）",
      "total=1 / unreadCount=1 / status=unread / mergedCount=1",
      short({ total: inbox1.total, unread: inbox1.unreadCount, status: inbox1.items[0]?.status, merged: inbox1.items[0]?.mergedCount }),
      inbox1.total === 1 && inbox1.unreadCount === 1 && inbox1.items[0]?.status === "unread" && inbox1.items[0]?.mergedCount === 1,
    );

    // --------------------------------------------------------- 证据二：合并
    clockNow = new Date(clockNow.getTime() + 5 * MINUTE_MS);
    const outcome2 = await notify.consume(
      row(message({ title: "第二个项目日报未填", templateCode: "A01_INBOX_MERGED" }), 2, dedupe("d2")),
    );
    const rows2 = await notifyRows(pattern);
    const child = rows2.find((item) => item.id !== first.id);
    const parent = rows2.find((item) => item.id === first.id);
    check(
      "S2a",
      "同期合并：窗口内同人同键第二条 → 子行留档（merged_into_id=主行 / delivered_at 空）",
      "2 行 / child.merged_into_id=" + first.id + " / child.delivered_at=null",
      short({ rows: rows2.length, childInto: child?.merged_into_id, childDelivered: child?.delivered_at }),
      outcome2.outcome === "done" && rows2.length === 2 && String(child?.merged_into_id) === String(first.id) && child?.delivered_at === null,
    );
    check(
      "S2b",
      "合并计数：主行 merged_count=2（收件箱仍 1 条，不新增可见行）",
      "merged_count=2 / inbox.total=1 / inbox.mergedCount=2",
      short({ mergedCount: parent?.merged_count, total: (await notify.list(cleanup.userIds[0], { page: 1, limit: 50 })).total }),
      Number(parent?.merged_count) === 2 && (await notify.list(cleanup.userIds[0], { page: 1, limit: 50 })).items[0]?.mergedCount === 2,
    );

    // ----------------------------------------------------- 证据三：消费幂等
    const beforeReplay = await countRows(pattern);
    const outcome3 = await notify.consume(row(message({ templateCode: "A01_INBOX_MERGED" }), 1, dedupe("d1")));
    const afterReplay = await countRows(pattern);
    check(
      "S3",
      "消费幂等：同 source_dedupe_key 重放 → done 且不新增行（唯一索引兜底）",
      "done / rows=" + beforeReplay,
      short({ outcome: outcome3.outcome, rows: afterReplay }),
      outcome3.outcome === "done" && afterReplay === beforeReplay,
    );

    // --------------------------------------------------- 证据四：非法载荷
    const beforeDead = await countRows(pattern);
    const outcome4 = await notify.consume(row({ recipientId: cleanup.userIds[0], type: "reminder", title: " ", body: "x" }, 9, dedupe("bad")));
    check(
      "S4",
      "非法载荷：确定性失败 → dead 分类且零落库（一次即弃）",
      "dead / rows=" + beforeDead,
      short({ outcome: outcome4.outcome, rows: await countRows(pattern) }),
      outcome4.outcome === "dead" && (await countRows(pattern)) === beforeDead,
    );

    // ----------------------------------------------- 证据五：免打扰次日补发
    clockNow = new Date("2026-09-28T15:00:00.000Z"); // 上海 23:00（缺省免打扰 22:00-08:00 内）
    await notify.consume(row(message({ title: "免打扰静默", templateCode: "R02_INBOX" }), 3, dedupe("quiet")));
    const quietRow = (await notifyRows(pattern)).find((item) => item.source_dedupe_key === dedupe("quiet"));
    const quietDue = await notify.flushDue(); // 未到点：不投递
    const afterEarlyFlush = (await notifyRows(pattern)).find((item) => item.source_dedupe_key === dedupe("quiet"));
    check(
      "S5a",
      "免打扰静默：上海 23:00 投递 → 不即时送达，排期到次日 08:00（deliver_at）",
      "delivered_at=null / deliver_at=2026-09-29T00:00:00Z（上海 08:00）",
      short({ delivered: quietRow?.delivered_at, deliverAt: quietRow?.deliver_at }),
      quietRow?.delivered_at === null && new Date(quietRow?.deliver_at).toISOString() === "2026-09-29T00:00:00.000Z",
    );
    check(
      "S5b",
      "未到点不投：静默期的 flush 不达（scanned=0，行保持未投递）",
      "scanned=0 / delivered_at=null",
      short({ scanned: quietDue.scanned, delivered: afterEarlyFlush?.delivered_at }),
      quietDue.scanned === 0 && afterEarlyFlush?.delivered_at === null,
    );
    clockNow = new Date("2026-09-29T00:30:00.000Z"); // 上海次日 08:30（免打扰结束）
    const quietFlush = await notify.flushDue();
    const afterQuietFlush = (await notifyRows(pattern)).find((item) => item.source_dedupe_key === dedupe("quiet"));
    check(
      "S5c",
      "次日补发：时段结束后 flush 真正投递（delivered=1）",
      "delivered=1 / delivered_at=2026-09-29T00:30:00Z",
      short({ ...quietFlush, deliveredAt: afterQuietFlush?.delivered_at }),
      quietFlush.delivered === 1 && new Date(afterQuietFlush?.delivered_at).toISOString() === "2026-09-29T00:30:00.000Z",
    );

    // ----------------------------------------------- 证据六：每人每日上限
    const capUser = cleanup.userIds[0];
    // 上限设 2：当日（上海 09-29）已投递 1 条（证据五的次日补发行）→ 第一条仍投、第二条溢出到次日。
    await notify.updatePrefs(capUser, { dailyLimit: 2, quietHours: "off", mergeWindowMs: 0 });
    await notify.consume(row(message({ title: "上限内第一条", templateCode: "R03" }), 4, dedupe("cap1")));
    await notify.consume(row(message({ title: "上限外第二条", templateCode: "R04" }), 5, dedupe("cap2")));
    const capRow = (await notifyRows(pattern)).find((item) => item.source_dedupe_key === dedupe("cap2"));
    check(
      "S6a",
      "每日上限：当日已投递达上限（2）→ 第二条排到次日窗口起点（08:00）",
      "delivered_at=null / deliver_at=2026-09-30T00:00:00Z",
      short({ delivered: capRow?.delivered_at, deliverAt: capRow?.deliver_at }),
      capRow?.delivered_at === null && new Date(capRow?.deliver_at).toISOString() === "2026-09-30T00:00:00.000Z",
    );
    clockNow = new Date("2026-09-30T00:10:00.000Z"); // 次日窗口后
    const capFlush = await notify.flushDue();
    const capRowAfter = (await notifyRows(pattern)).find((item) => item.source_dedupe_key === dedupe("cap2"));
    check(
      "S6b",
      "上限解除：次日 flush 投递（delivered=1，当日额度已重置）",
      "delivered=1 / delivered_at=2026-09-30T00:10:00Z",
      short({ ...capFlush, deliveredAt: capRowAfter?.delivered_at }),
      capFlush.delivered === 1 && new Date(capRowAfter?.delivered_at).toISOString() === "2026-09-30T00:10:00.000Z",
    );

    // ------------------------------------------- 证据七：收件箱读面与标记
    const listAll = await notify.list(cleanup.userIds[0], { page: 1, limit: 50 });
    const listReminder = await notify.list(cleanup.userIds[0], { type: "reminder", page: 1, limit: 50 });
    const listReportRef = await notify.list(cleanup.userIds[0], { refType: "report", page: 1, limit: 50 });
    const listOther = await notify.list(cleanup.userIds[1], { page: 1, limit: 50 });
    check(
      "S7a",
      "收件箱读面：全量 / 类型过滤 / 关联对象过滤 / 跨用户隔离",
      "all=4（主行合计：d1 + 免打扰补发 + 上限两条）/ reminder=4 / refType(report)=1 / 他人=0",
      short({ all: listAll.total, reminder: listReminder.total, byRef: listReportRef.total, other: listOther.total }),
      listAll.total === 4 && listReminder.total === 4 && listReportRef.total === 1 && listOther.total === 0,
    );
    const markedRead = await notify.mark(cleanup.userIds[0], listAll.items.find((item) => item.status === "unread").id, "read");
    const markedHandled = await notify.mark(cleanup.userIds[0], markedRead.id, "handled");
    const otherMarked = await notify
      .mark(cleanup.userIds[1], markedRead.id, "read")
      .then(() => "越权成功")
      .catch((error) => error?.code ?? messageOf(error));
    check(
      "S7b",
      "标记：已读 → 已处理（幂等）；他人标记 → 404（防 IDOR）",
      "read → handled / 越权=NOT_FOUND",
      short({ first: markedRead.status, second: markedHandled.status, other: otherMarked }),
      markedRead.status === "read" && markedHandled.status === "handled" && otherMarked === "NOT_FOUND",
    );
    const markAll = await notify.markAllRead(cleanup.userIds[0]);
    const afterMarkAll = await notify.list(cleanup.userIds[0], { page: 1, limit: 50 });
    check(
      "S7c",
      "全部已读：updated=剩余未读数 / unreadCount 归零 / 幂等（再次 updated=0）",
      "updated=3（1 条已处理）→ 0 / unreadCount=0",
      short({ markAll, unread: afterMarkAll.unreadCount, again: (await notify.markAllRead(cleanup.userIds[0])).updated }),
      markAll.updated === 3 && afterMarkAll.unreadCount === 0 && (await notify.markAllRead(cleanup.userIds[0])).updated === 0,
    );

    // ----------------------------------------------------------- 证据八：偏好
    const prefsDefault = await notify.getPrefs(cleanup.userIds[1]);
    const prefsSaved = await notify.updatePrefs(cleanup.userIds[1], { quietHours: "12:00-13:00", dailyLimit: 5, mergeWindowMs: 0 });
    const prefsPartial = await notify.updatePrefs(cleanup.userIds[1], { dailyLimit: 7 });
    const prefsStored = await db.query("select quiet_hours, daily_limit, merge_window_ms from notify_prefs where user_id = $1", [
      cleanup.userIds[1],
    ]);
    check(
      "S8",
      "通知偏好：缺省生效值 → 三态 / 上限 / 合并窗口落库；局部更新不丢键",
      "default 22:00-08:00 → 12:00-13:00 / 5 / 0 → 局部改 7（quiet 保持）",
      short({ defaultFrom: prefsDefault.quietFrom, saved: prefsSaved, partial: prefsPartial, stored: prefsStored.rows[0] }),
      prefsDefault.quietFrom === "22:00" &&
        prefsSaved.quietFrom === "12:00" &&
        prefsSaved.dailyLimit === 5 &&
        prefsStored.rows[0]?.quiet_hours === "12:00-13:00" &&
        prefsStored.rows[0]?.daily_limit === 7 &&
        prefsStored.rows[0]?.merge_window_ms === 0,
    );
  } finally {
    try {
      if (!cleanup.keep) {
        await db.query("delete from notify_delivery_messages where source_dedupe_key like $1", [DEDUPE_PREFIX + "." + tag + ".%"]);
        await db.query("delete from notifications where source_dedupe_key like $1", [DEDUPE_PREFIX + "." + tag + ".%"]);
        if (cleanup.userIds.length > 0) {
          await db.query("delete from notify_prefs where user_id = any($1::uuid[])", [cleanup.userIds]);
          await db.query("delete from users where id = any($1::uuid[]) and username like $2", [cleanup.userIds, USER_PREFIX + "%"]);
        }
      }
      const residue = await db.query("select count(*)::int as n from notifications where source_dedupe_key like $1", [
        DEDUPE_PREFIX + "." + tag + ".%",
      ]);
      const userResidue = await db.query("select count(*)::int as n from users where username like $1", [USER_PREFIX + "%"]);
      const archiveResidue = await db.query("select count(*)::int as n from notify_delivery_messages where source_dedupe_key like $1", [
        DEDUPE_PREFIX + "." + tag + ".%",
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
  const summary = "S7-4 回放汇总：PASS " + pass + " / FAIL " + fail + "（合成前缀 " + DEDUPE_PREFIX + "）";
  if (args.out !== undefined) {
    writeFileSync(
      args.out,
      "# S7-4 · j1 / M5-04 首刀 真机回放证据（站内信投递内核）\n\n" +
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
  process.stderr.write("S7-4 回放异常：" + messageOf(error) + "\n");
}

writeReports();
process.exit(fail === 0 ? 0 : 1);
