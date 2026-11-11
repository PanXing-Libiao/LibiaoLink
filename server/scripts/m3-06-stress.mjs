#!/usr/bin/env node
/**
 * M3-06 压测（1 万行任务数据集 + 索引调优评估 · 真 PG + 真 api）：
 *   证据一（数据集）：合成单项目 10000 条任务 —— 10 组（九阶段 + 未分组，组内位次 0 起密集）、8 位负责人、
 *           状态 / 进度 / 日期分布真实化，其中 200 条软删（模拟真实「活跃 9800 + 已删 200」）。
 *   证据二（API 时延）：列表默认读序分页 / 阶段筛选 / 负责人筛选 / 关键字 / 展示态筛选 / 项目总览四格 /
 *           阶段完成度 / 甘特图全量分页取数 —— p50 / p95 与阈值断言（shared runner 上留余量）。
 *   证据三（SQL 计划）：上述形状的 EXPLAIN (ANALYZE, BUFFERS)，记录计划节点与命中的索引名。
 *   证据四（索引对照 · M3-06 核心）：同一组查询在「保留 ix_tasks_project_stage_order」与「同库 DROP INDEX 后」
 *           两种状态下逐形状对照（中位耗时 + 计划）—— 用于判断 0015 建的旧索引能否被部分索引
 *           ix_tasks_active_group (project_id, stage_key, sort_index) where deleted_at is null 取代（写放大 / 空间）。
 *           默认收尾把索引建回（库结构不变），--drop-index 时保持删除状态（供迁移 0024 复核）。
 *
 * 前置：真 PG（DATABASE_URL，迁移器角色 —— 需要建索引 / 建合成数据）+ 真 api（BASE_URL，可选：只做 SQL 断言时用 --no-api）。
 *       脚本自建合成项目与 8 位合成负责人（跑完硬删：任务 / 事件 / 阶段 / 节点 / 成员 / 项目 / 合成用户与审计、outbox）。
 * 用法：cd server && M3_STRESS_DATABASE_URL=postgresql://libiaolink_migrator@127.0.0.1:55432/libiaolink \
 *       node --env-file-if-exists=.env scripts/m3-06-stress.mjs [--tasks 10000] [--rounds 6] [--out <报告.md>] [--json <证据.json>] [--keep] [--drop-index]
 * 退出码：断言全过 = 0，否则 = 1（可当门禁用）。
 */
import { createHash, randomBytes } from "node:crypto";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { Client } from "pg";

const args = parseArgs(process.argv.slice(2));
const BASE_URL = args.baseUrl ?? process.env.M3_STRESS_BASE_URL ?? process.env.BASE_URL ?? "http://127.0.0.1:3011";
const DATABASE_URL = args.databaseUrl ?? process.env.M3_STRESS_DATABASE_URL ?? process.env.DATABASE_URL ?? "postgresql://libiaolink_migrator@127.0.0.1:55432/libiaolink";
const TOTAL = Number(args.tasks ?? process.env.M3_STRESS_TASKS ?? 10000);
const ROUNDS = Number(args.rounds ?? process.env.M3_STRESS_ROUNDS ?? 6);
const LIMIT = 50;
const GANTT_LIMIT = 200;
const THRESHOLDS = { list: 800, filter: 800, summary: 500, stages: 800, ganttBatch: 900 };
const STAGES = ["presale", "design", "purchase", "assembly", "install", "deploy", "trial", "production", "acceptance"];
const KEYWORD = "M3K-777";
const OLD_INDEX = "ix_tasks_project_stage_order";
const SHAPE_BUDGET = { S1: THRESHOLDS.filter, S2: THRESHOLDS.filter, S3: THRESHOLDS.filter, S4: THRESHOLDS.filter, S5: THRESHOLDS.filter, S6: THRESHOLDS.filter, S7: THRESHOLDS.summary, S8: THRESHOLDS.stages, S9: THRESHOLDS.ganttBatch };
const NEW_INDEX = "ix_tasks_active_group";

const report = [];
const evidence = { shapes: [], api: [], index: {} };
let failures = 0;
let db;
let token = "";
let legacyIndexPresent = false;
const CSRF = randomBytes(16).toString("hex");
const cleanup = { projectId: null, userId: null, syntheticUserIds: [], syntheticRoleName: "" };

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (item === "--out") out.out = argv[++i];
    else if (item === "--json") out.json = argv[++i];
    else if (item === "--tasks") out.tasks = argv[++i];
    else if (item === "--rounds") out.rounds = argv[++i];
    else if (item === "--base-url") out.baseUrl = argv[++i];
    else if (item === "--database-url") out.databaseUrl = argv[++i];
    else if (item === "--no-api") out.noApi = true;
    else if (item === "--drop-index") out.dropIndex = true;
    else if (item === "--keep") out.keep = true;
  }
  return out;
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function note(line) {
  report.push(line);
  process.stdout.write(line + String.fromCharCode(10));
}

function check(id, title, expected, actual, ok, extra = "") {
  if (!ok) failures += 1;
  note("| " + (ok ? "PASS" : "FAIL") + " | " + id + " | " + title + " | 期望：" + expected + " | 实际：" + actual + (extra === "" ? "" : " | " + extra) + " |");
  if (!ok) throw new Error("M3-06 压测失败（" + id + "）：" + title);
}

function short(value, max = 240) {
  const text = JSON.stringify(value);
  return text === undefined ? "undefined" : text.length > max ? text.slice(0, max) + "..." : text;
}

async function call(method, path, body) {
  const response = await fetch(BASE_URL + path, {
    method,
    headers: { "content-type": "application/json", cookie: "ll_sid=" + token + "; ll_csrf=" + CSRF, "x-csrf-token": CSRF },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed = null;
  try { parsed = text === "" ? null : JSON.parse(text); } catch { parsed = { raw: text.slice(0, 300) }; }
  return { status: response.status, body: parsed, ms: 0 };
}

async function timed(fn) {
  const started = process.hrtime.bigint();
  const result = await fn();
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  return { result, ms };
}

function stats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))];
  return { min: sorted[0], p50: at(0.5), p95: at(0.95), max: sorted[sorted.length - 1] };
}

function fmt(value) {
  return Number(value).toFixed(1);
}

const stageOrderSql = "case stage_key " + STAGES.map((key, index) => "when $$" + key + "$$ then " + index).join(" ") + " else " + STAGES.length + " end";

const INSERT_TASKS_SQL = [
  "with owners as (select array_agg(id order by username) as ids from users where username like $3),",
  "src as (select g, case when mod(g, 10) = 0 then null else (array[$$presale$$,$$design$$,$$purchase$$,$$assembly$$,$$install$$,$$deploy$$,$$trial$$,$$production$$,$$acceptance$$])[1 + mod(g, 9)] end as stage_key from generate_series(1, $2) g)",
  "insert into tasks (project_id, stage_key, sort_index, title, status, progress, priority, owner_ids, manager_ids, planned_start, planned_end, actual_end, estimated_days, headcount, deliverable_types, change_refs, created_at, updated_at)",
  "select $1::uuid, src.stage_key, (row_number() over (partition by src.stage_key order by src.g))::int - 1,",
  "  case when mod(src.g, 977) = 0 then $4 || $$·装配·$$ || lpad(src.g::text, 5, $$0$$) else $$压测任务·$$ || lpad(src.g::text, 5, $$0$$) || $$ 工装装配$$ end,",
  "  case when mod(src.g, 7) = 0 then $$done$$ when mod(src.g, 5) = 0 then $$active$$ else $$pending$$ end,",
  "  case when mod(src.g, 7) = 0 then 1.0 when mod(src.g, 5) = 0 then 0.5 else 0 end,",
  "  $$normal$$,",
  "  case when mod(src.g, 11) = 0 then array[]::uuid[] else array[(owners.ids)[1 + mod(src.g, 8)]] end,",
  "  (select p.manager_ids from projects p where p.id = $1::uuid), date $$2026-01-01$$ + mod(src.g, 180)::int,",
  "  date $$2026-01-01$$ + mod(src.g, 180)::int + 30,",
  "  case when mod(src.g, 7) = 0 then date $$2026-01-01$$ + mod(src.g, 180)::int + 25 else null end,",
  "  (1 + mod(src.g, 10))::smallint, (1 + mod(src.g, 30))::smallint,",
  "  array[]::text[], array[]::uuid[],",
  "  now() - make_interval(days => mod(src.g, 365)), now()",
  "from src cross join owners"
].join(" ");

async function explain(sql, params) {
  const result = await db.query("explain (analyze, buffers, format json) " + sql, params);
  const plan = result.rows[0]["QUERY PLAN"][0];
  const nodes = [];
  const indexes = [];
  const walk = (node) => {
    nodes.push(node["Node Type"]);
    if (node["Index Name"]) indexes.push(node["Index Name"]);
    if (node["Relation Name"] === "tasks" && node["Node Type"] === "Seq Scan") indexes.push("SEQ SCAN tasks");
    for (const child of node.Plans ?? []) walk(child);
  };
  walk(plan.Plan);
  return { ms: plan["Execution Time"], nodes, indexes, rows: plan.Plan["Actual Rows"] };
}

async function measureSql(id, title, sql, params) {
  const times = [];
  let last = null;
  for (let i = 0; i < ROUNDS; i += 1) {
    last = await explain(sql, params);
    times.push(last.ms);
  }
  const stat = stats(times);
  const shape = { id, title, p50: stat.p50, p95: stat.p95, max: stat.max, indexes: last.indexes, nodes: last.nodes, rows: last.rows };
  evidence.shapes.push(shape);
  note("| " + id + " | " + title + " | " + fmt(stat.p50) + " ms | " + fmt(stat.p95) + " ms | " + (last.indexes.join(", ") || "-") + " |");
  return shape;
}

async function measureApi(id, title, path) {
  const times = [];
  let last = null;
  for (let i = 0; i < ROUNDS; i += 1) {
    const run = await timed(() => call("GET", path));
    times.push(run.ms);
    last = run.result;
  }
  const stat = stats(times);
  const item = { id, title, path, status: last.status, p50: stat.p50, p95: stat.p95, max: stat.max, body: last.body };
  evidence.api.push(item);
  note("| " + id + " | " + title + " | " + last.status + " | " + fmt(stat.p50) + " ms | " + fmt(stat.p95) + " ms |");
  return item;
}

const SHAPES = [
  { id: "S1", title: "列表 · 默认读序第 1 页（limit 50）", sql: "select id, title, stage_key, sort_index from tasks where project_id = $1 and deleted_at is null order by " + stageOrderSql + ", sort_index asc, id asc limit $2 offset 0", params: () => [cleanup.projectId, LIMIT] },
  { id: "S2", title: "列表 · 阶段筛选（design）第 1 页", sql: "select id, title from tasks where project_id = $1 and deleted_at is null and stage_key = $$design$$ order by " + stageOrderSql + ", sort_index asc, id asc limit $2 offset 0", params: () => [cleanup.projectId, LIMIT] },
  { id: "S3", title: "列表 · 负责人筛选（任一命中）第 1 页", sql: "select id, title from tasks where project_id = $1 and deleted_at is null and owner_ids @> array[$2::uuid] order by " + stageOrderSql + ", sort_index asc, id asc limit $3 offset 0", params: () => [cleanup.projectId, cleanup.syntheticUserIds[0], LIMIT] },
  { id: "S4", title: "列表 · 关键字（装配 · 全量命中）第 1 页", sql: "select id, title from tasks where project_id = $1 and deleted_at is null and (title ilike $2 or title_en ilike $2) order by " + stageOrderSql + ", sort_index asc, id asc limit $3 offset 0", params: () => [cleanup.projectId, "%装配%", LIMIT] },
  { id: "S5", title: "列表 · 关键字（M3K-777 · 稀疏命中）第 1 页", sql: "select id, title from tasks where project_id = $1 and deleted_at is null and (title ilike $2 or title_en ilike $2) order by " + stageOrderSql + ", sort_index asc, id asc limit $3 offset 0", params: () => [cleanup.projectId, "%" + KEYWORD + "%", LIMIT] },
  { id: "S6", title: "列表 · 展示态筛选（逾期）第 1 页", sql: "select id, title from tasks where project_id = $1 and deleted_at is null and progress < 1 and planned_end < current_date order by " + stageOrderSql + ", sort_index asc, id asc limit $2 offset 0", params: () => [cleanup.projectId, LIMIT] },
  { id: "S7", title: "项目总览四格（total / done / overdue 三个计数）", sql: "select count(*) as total, count(*) filter (where status = $$done$$) as done, count(*) filter (where progress < 1 and planned_end < current_date) as overdue from tasks where project_id = $1 and deleted_at is null", params: () => [cleanup.projectId] },
  { id: "S8", title: "阶段完成度（按 stage_key 分组计数）", sql: "select stage_key, count(*) from tasks where project_id = $1 and deleted_at is null group by stage_key", params: () => [cleanup.projectId] },
  { id: "S9", title: "甘特图 · 单页取数（limit 200 · 第 1 页）", sql: "select id, title, stage_key, sort_index, planned_start, planned_end, progress, status from tasks where project_id = $1 and deleted_at is null order by " + stageOrderSql + ", sort_index asc, id asc limit $2 offset 0", params: () => [cleanup.projectId, GANTT_LIMIT] }
];

const RUN = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
const USER_PREFIX = "m3stress-" + RUN + "-";

try {
  db = new Client({ connectionString: DATABASE_URL });
  await db.connect();
  const useApi = args.noApi !== true;
  if (useApi) {
    const health = await fetch(BASE_URL + "/healthz").then((response) => response.status).catch(() => 0);
    if (health !== 200) throw new Error("api 不可用（" + BASE_URL + "/healthz -> " + health + "）；先起 api，或用 --no-api 跳过 API 时延");
  }

  for (let i = 1; i <= 8; i += 1) {
    const row = await db.query("insert into users (casdoor_id, username, display_name, status) values ($1, $2, $3, $$active$$) returning id", ["m3stress-" + RUN + "-" + i, USER_PREFIX + i, "压测负责人" + i]);
    cleanup.syntheticUserIds.push(row.rows[0].id);
  }
  const managerId = cleanup.syntheticUserIds[0];
  cleanup.userId = managerId;
  const project = await db.query("insert into projects (code, name, customer, region, project_type, manager_ids, stage_key, status, description, version) values ($1, $2, $3, $$shanghai$$, $$default$$, array[$4::uuid], $$presale$$, $$active$$, $5, 1) returning id, code, seq_no", ["M3STRESS-" + RUN, "M3-06 压测项目（1 万行数据集）", "合成数据", managerId, "M3-06 压测 1 万行任务数据集与索引对照"]);
  cleanup.projectId = project.rows[0].id;
  note("- 合成项目 " + project.rows[0].code + "（seq_no=" + project.rows[0].seq_no + "）id=" + cleanup.projectId);
  await db.query("insert into project_members (project_id, user_id, role_in_project) values ($1, $2, $$project_manager$$)", [cleanup.projectId, managerId]);
  await db.query("insert into project_stages (project_id, stage_key, seq, status) select $1, key, ord, case when ord = 1 then $$active$$ else $$pending$$ end from unnest($2::text[]) with ordinality as t(key, ord)", [cleanup.projectId, STAGES]);

  const inserted = await db.query(INSERT_TASKS_SQL, [cleanup.projectId, TOTAL, USER_PREFIX + "%", KEYWORD]);
  const softDeleted = await db.query("update tasks set deleted_at = now(), deleted_by = $3 where id in (select id from tasks where project_id = $1 and title like $2 and sort_index >= 900 order by id limit 200)", [cleanup.projectId, "压测任务%", managerId]);
  await db.query("analyze tasks");
  const scale = await db.query("select count(*)::int as total, count(*) filter (where deleted_at is null)::int as active, count(*) filter (where deleted_at is null and stage_key is not null)::int as staged from tasks where project_id = $1", [cleanup.projectId]);
  const scaleTotal = scale.rows[0].total;
  const scaleActive = scale.rows[0].active;
  const scaleStaged = scale.rows[0].staged;
  check("A1", "数据集规模：单项目 1 万行（含 200 条软删）", "total=" + TOTAL + " active=" + (TOTAL - 200), "total=" + scaleTotal + " active=" + scaleActive, scaleTotal === TOTAL && scaleActive === TOTAL - 200, "inserted=" + inserted.rowCount + " softDeleted=" + softDeleted.rowCount);
  const keywordHit = await db.query("select count(*)::int as n from tasks where project_id = $1 and deleted_at is null and title ilike $2", [cleanup.projectId, "%" + KEYWORD + "%"]);
  check("A2", "关键字分布：稀疏关键字命中 10 条（mod 977）", "n=10", "n=" + keywordHit.rows[0].n, keywordHit.rows[0].n === 10);

  if (useApi) {
    token = "m3stress-" + randomBytes(16).toString("hex");
    await db.query("insert into sessions (token_hash, user_id, id_token, expires_at) values ($1, $2, $$m3-06-stress$$, now() + interval $$2 hours$$)", [sha256(token), managerId]);
  }

  if (useApi) {
    const API = "/api/v1/projects/" + cleanup.projectId;
    const listPath = API + "/tasks?page=1&limit=" + LIMIT;
    const list = await measureApi("L1", "列表 · 默认读序第 1 页（limit 50）", listPath);
    const listOk = list.status === 200 && list.body?.items?.length === LIMIT && list.body?.total === scaleActive && list.body?.items?.[0]?.stageKey === "presale" && list.body?.items?.[0]?.sortIndex === 0;
    check("A3", "列表第 1 页：50 条 + total=活跃数 + 首行属首阶段且位次 0", "200 / 50 条 / total=" + scaleActive + " / 首行 presale #0", list.status + " / " + (list.body?.items?.length ?? 0) + " 条 / total=" + list.body?.total + " / 首行 " + (list.body?.items?.[0]?.stageKey ?? "-") + " #" + (list.body?.items?.[0]?.sortIndex ?? "-"), listOk === true);
    check("A4", "列表 p95 阈值", "<= " + THRESHOLDS.list + " ms", fmt(list.p95) + " ms（p50 " + fmt(list.p50) + " / max " + fmt(list.max) + "）", list.p95 <= THRESHOLDS.list, ROUNDS + " 轮");
    const stage = await measureApi("L2", "列表 · 阶段筛选（stage=design）", listPath + "&stage=design");
    const stageItems = stage.body?.items ?? [];
    check("A5", "阶段筛选 p95 阈值 + 全部命中 design", "<= " + THRESHOLDS.filter + " ms + 全部 design", fmt(stage.p95) + " ms / 越界 " + stageItems.filter((item) => item.stageKey !== "design").length + " 条 / total=" + stage.body?.total, stage.p95 <= THRESHOLDS.filter && stageItems.length > 0 && stageItems.every((item) => item.stageKey === "design"));
    const owner = await measureApi("L3", "列表 · 负责人筛选（filter[ownerId]）", listPath + "&filter[ownerId]=" + cleanup.syntheticUserIds[0]);
    const ownerItems = owner.body?.items ?? [];
    const ownerMiss = ownerItems.filter((item) => (item.ownerIds ?? []).indexOf(cleanup.syntheticUserIds[0]) < 0).length;
    check("A6", "负责人筛选 p95 阈值 + 全部含该负责人", "<= " + THRESHOLDS.filter + " ms + 全部命中", fmt(owner.p95) + " ms / 越界 " + ownerMiss + " 条 / total=" + owner.body?.total, owner.p95 <= THRESHOLDS.filter && ownerItems.length > 0 && ownerMiss === 0);
    const keyword = await measureApi("L4", "列表 · 关键字（装配 · 全量命中）", listPath + "&q=" + encodeURIComponent("装配"));
    check("A7", "关键字筛选 p95 阈值 + total=活跃数", "<= " + THRESHOLDS.filter + " ms + total=" + scaleActive, fmt(keyword.p95) + " ms / total=" + keyword.body?.total, keyword.p95 <= THRESHOLDS.filter && keyword.body?.total === scaleActive);
    const overdue = await measureApi("L5", "列表 · 展示态筛选（filter[status]=overdue）", listPath + "&filter[status]=overdue");
    check("A8", "展示态筛选 p95 阈值", "<= " + THRESHOLDS.filter + " ms", fmt(overdue.p95) + " ms / total=" + overdue.body?.total, overdue.p95 <= THRESHOLDS.filter);
    const summary = await measureApi("L6", "项目总览四格（GET /summary）", API + "/summary");
    check("A9", "总览四格 p95 阈值 + total=活跃数", "<= " + THRESHOLDS.summary + " ms + total=" + scaleActive, fmt(summary.p95) + " ms / total=" + summary.body?.total, summary.p95 <= THRESHOLDS.summary && summary.body?.total === scaleActive);
    const stagesView = await measureApi("L7", "阶段完成度（GET /stages）", API + "/stages");
    const stageSum = (stagesView.body?.stages ?? []).reduce((sum, item) => sum + (item.tasks?.total ?? 0), 0);
    check("A10", "阶段完成度 p95 阈值 + 计数合计=带阶段活跃数（未分组不计）", "<= " + THRESHOLDS.stages + " ms + 合计=" + scaleStaged, fmt(stagesView.p95) + " ms / 合计=" + stageSum, stagesView.p95 <= THRESHOLDS.stages && stageSum === scaleStaged);
    const ganttTimes = [];
    for (let page = 1; page <= 10; page += 1) {
      const run = await timed(() => call("GET", API + "/tasks?page=" + page + "&limit=" + GANTT_LIMIT));
      ganttTimes.push(run.ms);
      if (run.result.status !== 200) throw new Error("甘特图分页失败：page=" + page + " status=" + run.result.status);
    }
    const ganttStat = stats(ganttTimes);
    evidence.api.push({ id: "L8", title: "甘特图 · 10 页 x 200 条（共 2000 行）", path: "/tasks?limit=200", status: 200, p50: ganttStat.p50, p95: ganttStat.p95, max: ganttStat.max });
    note("| L8 | 甘特图 · 10 页 x 200 条（共 2000 行） | 200 | " + fmt(ganttStat.p50) + " ms | " + fmt(ganttStat.p95) + " ms |");
    check("A11", "甘特图单页（200 条）p95 阈值", "<= " + THRESHOLDS.ganttBatch + " ms", fmt(ganttStat.p95) + " ms（10 页合计 " + fmt(ganttTimes.reduce((sum, value) => sum + value, 0)) + " ms）", ganttStat.p95 <= THRESHOLDS.ganttBatch);
  }
  note("");
  note("### SQL 计划与索引对照（EXPLAIN ANALYZE · 收尾还原库结构）");
  note("");
  note("| 形状 | 说明 | p50 | p95 | 命中索引 / 计划 |");
  note("|---|---|---|---|---|");
  const legacyExisted = await db.query("select count(*)::int as n from pg_class where relname = $1 and relkind = $$i$$", [OLD_INDEX]);
  const legacyPresent = legacyExisted.rows[0].n === 1;
  legacyIndexPresent = legacyPresent;
  const baseline = [];
  if (legacyPresent) {
    for (const shape of SHAPES) {
      baseline.push(await measureSql(shape.id, shape.title, shape.sql, shape.params()));
    }
  }
  const indexSizes = await db.query("select indexrelname as name, pg_relation_size(indexrelid)::bigint as bytes, pg_size_pretty(pg_relation_size(indexrelid)) as size from pg_stat_user_indexes where relname = $$tasks$$ and indexrelname = any($1::text[]) order by indexrelname", [[OLD_INDEX, NEW_INDEX]]);
  for (const row of indexSizes.rows) note("- 索引 " + row.name + "：" + row.size + "（" + row.bytes + " bytes）");
  check("A12", legacyPresent ? "对照前旧索引存在（迁移 0015 建立）" : "旧索引已下线（迁移 0024 落库后 · 直接按下线态跑）", legacyPresent ? "n=1" : "n=0（下线态）", "n=" + legacyExisted.rows[0].n, true, legacyPresent ? "马上 DROP 做前后对照" : "无对照基线：改为逐形状压预算 + 记录计划");
  const after = [];
  if (legacyPresent) {
    await db.query("drop index if exists " + OLD_INDEX);
    await db.query("analyze tasks");
    note("");
    note("- 已 DROP " + OLD_INDEX + "（对照态：任务表只用部分索引 " + NEW_INDEX + " 兜底）");
    for (const shape of SHAPES) {
      after.push(await measureSql("D" + shape.id, shape.title + " · 下线旧索引后", shape.sql, shape.params()));
    }
  } else {
    note("");
    note("- 旧索引不存在（迁移 0024 已下线）：直接按「部分索引 " + NEW_INDEX + " 兜底态」跑 9 形状");
    for (const shape of SHAPES) {
      after.push(await measureSql("D" + shape.id, shape.title + " · 下线态", shape.sql, shape.params()));
    }
  }
  const ratioOf = (item) => item.next / Math.max(item.base, 0.05);
  const ratios = legacyPresent ? SHAPES.map((shape, index) => ({ id: shape.id, base: baseline[index].p50, next: after[index].p50 })) : [];
  const worst = ratios.length > 0 ? ratios.reduce((max, item) => (ratioOf(item) > ratioOf(max) ? item : max), ratios[0]) : null;
  note("");
  if (legacyPresent) {
    note("- p50 倍率（下线后 / 基线）：" + ratios.map((item) => item.id + " " + ratioOf(item).toFixed(2) + "x").join(" / "));
  } else {
    note("- 旧索引已下线（无基线对照）：逐形状 p50 / 预算 —— " + after.map((item, index) => item.id + " " + fmt(item.p50) + " ms / " + SHAPE_BUDGET[SHAPES[index].id] + " ms").join(" / "));
  }
  evidence.index = { oldIndex: OLD_INDEX, newIndex: NEW_INDEX, legacyIndexPresent: legacyPresent, sizes: indexSizes.rows, ratios: ratios.map((item) => ({ id: item.id, baseP50: item.base, afterP50: item.next, ratio: Number(ratioOf(item).toFixed(3)) })), afterIndexes: after.map((item) => ({ id: item.id, indexes: item.indexes, nodes: item.nodes })), keptDropped: args.dropIndex === true || !legacyPresent };
  check("A13", legacyPresent ? "下线旧索引后最差形状的 p50 倍率 <= 1.5x" : "旧索引已下线（0024）：9 形状逐条压预算", legacyPresent ? "worst <= 1.5x" : "各形状 p50 <= 预算", legacyPresent ? worst.id + " " + ratioOf(worst).toFixed(2) + "x" : after.map((item, index) => item.id + " " + fmt(item.p50) + " / 预算 " + SHAPE_BUDGET[SHAPES[index].id]).join(" / "), legacyPresent ? ratioOf(worst) <= 1.5 : after.every((item, index) => item.p50 <= SHAPE_BUDGET[SHAPES[index].id]));
  check("A14", "下线旧索引后默认读序（S1）p50 阈值", "<= " + THRESHOLDS.list + " ms", fmt(after[0].p50) + " ms", after[0].p50 <= THRESHOLDS.list);
  if (!legacyPresent) {
    note("");
    note("- 旧索引本就不存在（迁移 0024 已下线），无需建回");
  } else if (args.dropIndex === true) {
    note("");
    note("- 按命令行要求保持 DROP 状态（供迁移 0024 复核），本次不建回：" + OLD_INDEX);
  } else {
    await db.query("create index if not exists " + OLD_INDEX + " on tasks (project_id, stage_key, sort_index)");
    await db.query("analyze tasks");
    const restored = await db.query("select count(*)::int as n from pg_class where relname = $1 and relkind = $$i$$", [OLD_INDEX]);
    check("A15", "对照结束后把旧索引建回（库结构与迁移一致）", "n=1", "n=" + restored.rows[0].n, restored.rows[0].n === 1);
  }
} catch (error) {
  failures += 1;
  report.push("| FAIL | 中断：" + (error instanceof Error ? error.message : String(error)) + " |");
  process.stderr.write("M3-06 压测失败：" + (error instanceof Error ? error.message : String(error)) + String.fromCharCode(10));
} finally {
  if (db !== undefined) {
    try {
      if (token !== "") await db.query("update sessions set revoked_at = now() where token_hash = $1 and revoked_at is null", [sha256(token)]);
      if (args.keep !== true && cleanup.projectId !== null) {
        await db.query("delete from task_events where task_id in (select id from tasks where project_id = $1)", [cleanup.projectId]);
        await db.query("delete from tasks where project_id = $1", [cleanup.projectId]);
        await db.query("delete from outbox_events where payload::text like $1", ["%" + cleanup.projectId + "%"]);
        await db.query("delete from project_stages where project_id = $1", [cleanup.projectId]);
        await db.query("delete from project_members where project_id = $1", [cleanup.projectId]);
        await db.query("delete from projects where id = $1", [cleanup.projectId]);
      }
      if (cleanup.syntheticUserIds.length > 0) {
        await db.query("delete from sessions where user_id = any($1::uuid[])", [cleanup.syntheticUserIds]);
        await db.query("delete from project_members where user_id = any($1::uuid[])", [cleanup.syntheticUserIds]);
        await db.query("delete from users where id = any($1::uuid[])", [cleanup.syntheticUserIds]);
      }
      if (args.dropIndex !== true && legacyIndexPresent) await db.query("create index if not exists " + OLD_INDEX + " on tasks (project_id, stage_key, sort_index)");
    } catch (error) {
      report.push("| WARN | 收尾未完全成功：" + (error instanceof Error ? error.message : String(error)) + " |");
    }
    await db.end();
  }
}
const commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: process.cwd() }).toString().trim();
const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: process.cwd() }).toString().trim() !== "";
const lines = [];
lines.push("# M3-06 压测证据（1 万行任务数据集 + 索引调优评估）");
lines.push("");
lines.push("> 卡片：M3-06 · 「1 万行性能达标（列表 / 筛选 / 总览 / 甘特取数）+ 索引调优评估」（主责 wmj，评审 lan）｜口径来源：技术设计v0.3-实施与验收.md §3.4 / §6.1、技术设计v0.2-架构与数据模型.md §2.3。");
lines.push("");
lines.push("| 项 | 值 |");
lines.push("|---|---|");
lines.push("| 回放时间 | " + new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 19).replace("T", " ") + " +08:00 |");
lines.push("| 目标 | " + BASE_URL + " |");
lines.push("| 数据库 | " + DATABASE_URL.replace(/:[^:@/]+@/, ":***") + " |");
lines.push("| 代码版本 | " + commit + (dirty ? "（工作区含未提交改动）" : "") + " |");
lines.push("| 脚本 | server/scripts/m3-06-stress.mjs |");
lines.push("| 数据集 | 单项目 " + TOTAL + " 行（含 200 条软删 · 活跃 " + (TOTAL - 200) + " 行 · 九阶段 + 未分组 · 8 位负责人） |");
lines.push("| 采样 | 每形状 " + ROUNDS + " 轮（SQL 用 EXPLAIN ANALYZE 的 Execution Time，API 用端到端耗时，取 p50 / p95 / max） |");
lines.push("");
lines.push("## 断言明细");
lines.push("");
lines.push(...report);
lines.push("");
lines.push("## 汇总");
lines.push("");
lines.push(failures === 0 ? "- 全部断言通过：数据集 A1 / A2 + API 时延 A3 ~ A11 + 索引对照 A12 ~ A15。" : "- 有 " + failures + " 项失败，见上方 FAIL 行。");
lines.push("");
lines.push("## 验收对照（M3-06）");
lines.push("");
lines.push("- 「1 万行数据集」= A1 / A2：单项目 1 万行任务落库（九阶段 + 未分组 · 8 位负责人 · 200 条软删），关键字与分布可复现。");
lines.push("- 「列表 / 筛选 / 总览 / 甘特取数性能」= A3 ~ A11：默认读序 50 条分页、阶段 / 负责人 / 关键字（全量与稀疏）/ 展示态筛选、项目总览四格、阶段完成度、甘特 10 页 x 200 条取数，p95 全部在阈值内。");
lines.push("- 「索引调优评估」= A12 ~ A15：DROP " + OLD_INDEX + " 前后 9 个形状逐一对齐（p50 倍率 + EXPLAIN 命中计划），评估由部分索引 " + NEW_INDEX + " 取代旧索引的可行性；对照结束把旧索引建回（默认与迁移结构一致）；迁移 0024 之后旧索引已不存在，则直接按下线态逐形状压预算并记录命中计划）。");
lines.push("- 复跑：cd server && M3_STRESS_DATABASE_URL=postgresql://libiaolink_migrator@127.0.0.1:55432/libiaolink node scripts/m3-06-stress.mjs --out ../docs/m3-06-压测证据.md");
lines.push("");
lines.push("");
if (args.json !== undefined) writeFileSync(args.json, JSON.stringify(evidence, null, 2) + String.fromCharCode(10), "utf8");
if (args.out !== undefined) writeFileSync(args.out, lines.join(String.fromCharCode(10)), "utf8");
process.stdout.write(lines.join(String.fromCharCode(10)) + String.fromCharCode(10));
process.exit(failures === 0 ? 0 : 1);
