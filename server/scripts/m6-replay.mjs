#!/usr/bin/env node
/**
 * M6 真机回放（S6·report-issue 日报 / 问题 + M6-01 收口 + M6-05 · 工作台 A6-01 / A6-03（2026-09-30 复评：四组 / 不限窗口 / 项目经理含我）· Push 215 口径）：
 *   证据一（A3-02 / A3-04 · 日报填报）：新报今天（今天 = submitted，过去日期 = 补填 supplement）、
 *           同人同项目同日可多条（Push 215：原「一人一天一条」409 REPORT_ALREADY_EXISTS 删除）、未来日期 400、
 *           草稿写库（state=draft 落行）+ 提交；关联阶段（stageKeys / stageNames 同下标）；附图校验（未知文件 400）。
 *   证据二（A3-09 问题生成 · 幂等 · 附图转挂 · A3-08 停用）：提交后现场发现问题非空 → 自动生成问题
 *           （source_report_id 唯一兜底；多值归类；部门名归类 = 责任部门、原因类 = null）；
 *           「问题图」提交时从日报侧（file_links kind=issue）转挂到问题侧（object_type=issue），日报侧只剩现场图；
 *           重编辑已提交日报触发重放：问题仍 1 条、事件不重复；A3-08 回写任务进展已停用（任务 note / task_events 不变）。
 *   证据三（A3-10 / A3-11 / A3-13 · 问题三态与留痕）：open → in_progress → done（写 closed_at / closed_by）→ 回退 open
 *           （自动清空关闭对）；每次实际变化各写一条 issue_events（state_change / solution / assignment）；
 *           描述 / 归类可改（PATCH 扩项）走审计不写事件；空更新 400、乐观锁 409。
 *   证据四（成对删除 + A2-01 删除引用守卫）：DELETE 日报 = 连带删除它派生的全部问题 + 两侧附图链；
 *           DELETE 问题（有来源日报）= 连带删除来源日报及其全部问题；被问题引用的任务 DELETE 409 TASK_HAS_REFERENCES
 *           （details[].code = issue_ref；日报一侧 report_ref 随「关联阶段」删除）；无引用任务可删、重复删除 404。
 *   证据五（M6-01 收口 · A7-01 当日汇总 / A7-05 应填未填）：当日汇总只算已提交条目（submitted / supplement）
 *           （entryCount / headcountTotal / issueCount + 工作日信息）；应填未填 = 名册 × 工作日历 × 当日未提交
 *           （草稿未提交仍计未填）；非工作日整列为空（不催报）；缺省日期 = 今天；未来日期 400。
 *   证据六（工作台 · M6-05 · A6-01 / A6-03 · 2026-09-30 口径复评）：靶子任务贯穿四组 —— 命中口径 = 任务负责人含我
 *           或 项目项目经理含我（本回放项目 managerIds = admin）+ 未完成、不限完成日期窗口：默认待分配（无日期）→ unscheduled；
 *           指派我 + 昨天 → overdue、今天 → today、明天与今天 + 400 天 → upcoming（原 7 天窗口取消）；
 *           清空负责人（待分配）+ 无日期仍命中未排期（项目经理口径）。我的问题两栏（我处理 ownerId / 我提出的 reporterId）双命中双列。
 *   证据七（归档 · M7-04 · C4-02 / C4-03 · ADR-027）：验收完成硬前置 → 首次归档 422 ARCHIVE_GATE_NOT_PASSED（缺项明细
 *           + 失败留痕 + 不置位）→ confirm=true 确认越过 200（置 archived + 引用式清单 + 成功留痕）→ 清单读面 GET /archive
 *           → PATCH 不再接受 archived（400，契约收紧）→ 归档检索 filter[archivedYear] 命中。
 *   证据八（归档写保护 · ADR-027）：归档项目写保护（G4：日报填报 / 问题处理 / 任务删除均 409 PROJECT_ARCHIVED）
 *           + 归档后工作台整项目剔除（W7：任务四组 / 问题两栏零残留）—— 项目由证据七真实归档端点置位。
 *
 * 前置：真 PG（DATABASE_URL，迁移器角色 —— 断言与收尾要跨表读删）+ 真 api（BASE_URL）。本脚本只在本地沙箱 / 联调库跑：
 *       铸一个管理员临时会话（跑完撤销）、建 M6RPL- 回放项目与任务（跑完硬删项目及其日报 / 问题 / 事件 / 任务 / 审计 / outbox / 会话）。
 *       附图证据不走上传管道：脚本直接以迁移器身份插入 files 行（status=draft）再引用其 id。
 * 用法：cd server && M6_DATABASE_URL=postgresql://libiaolink_migrator@127.0.0.1:55432/libiaolink \
 *       node --env-file-if-exists=.env scripts/m6-replay.mjs [--out <报告.md>] [--json <证据.json>] [--actor <userId>] [--keep]
 * 退出码：断言全过 = 0，否则 = 1（可当门禁用）。
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

const serverRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = parseArgs(process.argv.slice(2));
const BASE_URL = args.baseUrl ?? process.env.M6_BASE_URL ?? process.env.BASE_URL ?? "http://127.0.0.1:3011";
const DATABASE_URL = args.databaseUrl ?? process.env.M6_DATABASE_URL ?? process.env.DATABASE_URL ?? "postgresql://libiaolink_migrator@127.0.0.1:55432/libiaolink";
const report = [];
const evidence = { steps: [] };
let failures = 0;
let db;
let admin;
let adminId;
const cleanup = { projectId: null, tokens: [], syntheticUserId: null, fileIds: [] };

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (item === "--out") out.out = argv[++i];
    else if (item === "--json") out.json = argv[++i];
    else if (item === "--actor") out.actor = argv[++i];
    else if (item === "--base-url") out.baseUrl = argv[++i];
    else if (item === "--database-url") out.databaseUrl = argv[++i];
    else if (item === "--keep") out.keep = true;
  }
  return out;
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

/** 上海日期（与服务端 shanghaiToday 同口径）：offset 0 = 今天、-1 = 昨天、-2 = 前天、1 = 明天。 */
function shanghaiDate(offsetDays) {
  return new Date(Date.now() + 8 * 3600 * 1000 + offsetDays * 86400000).toISOString().slice(0, 10);
}

async function makeSession(userId, idToken) {
  const session = { userId, token: "m6rpl-" + randomBytes(16).toString("hex"), csrf: randomBytes(16).toString("hex") };
  await db.query("insert into sessions (token_hash, user_id, id_token, expires_at) values ($1, $2, $3, now() + interval $$2 hours$$)", [sha256(session.token), userId, idToken]);
  cleanup.tokens.push(session.token);
  return session;
}

async function call(method, path, body) {
  const response = await fetch(BASE_URL + path, {
    method,
    headers: {
      "content-type": "application/json",
      cookie: "ll_sid=" + admin.token + "; ll_csrf=" + admin.csrf,
      "x-csrf-token": admin.csrf,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed = null;
  try { parsed = text === "" ? null : JSON.parse(text); } catch { parsed = { raw: text.slice(0, 300) }; }
  return { status: response.status, body: parsed };
}

function check(id, title, expected, actual, ok, extra = "") {
  if (!ok) failures += 1;
  report.push("| " + (ok ? "PASS" : "FAIL") + " | " + id + " | " + title + " | 期望：" + expected + " | 实际：" + actual + (extra === "" ? "" : " | " + extra) + " |");
  evidence.steps.push({ id, title, expected, actual, ok, extra });
  process.stdout.write((ok ? "PASS " : "FAIL ") + id + " " + title + String.fromCharCode(10));
  if (!ok) throw new Error("M6 回放失败（" + id + "）：" + title);
}

function short(value, max = 320) {
  const text = JSON.stringify(value);
  return text === undefined ? "undefined" : text.length > max ? text.slice(0, max) + "..." : text;
}

let taskAId;
let taskBId;
let reportId;
let reportWithIssueId;
let reportToCascadeId;
let issueId;
let issueSiblingId;
let survivingIssueId;

try {
  db = new Client({ connectionString: DATABASE_URL });
  await db.connect();
  const health = await fetch(BASE_URL + "/healthz").then((response) => response.status).catch(() => 0);
  check("P1", "api 可用（/healthz）", "200", String(health), health === 200, "先起 api 再跑本脚本");

  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const adminRow = await db.query("select u.id from users u join user_roles ur on ur.user_id = u.id join roles r on r.id = ur.role_id where r.code = $1 and u.status = $2 order by u.id limit 1", ["admin", "active"]);
  if (args.actor === undefined && adminRow.rows.length === 0) {
    const adminRole = await db.query("select id from roles where code = $$admin$$ limit 1");
    if (adminRole.rows.length === 0) throw new Error("roles 表缺少 admin 角色；先在目标库跑 database/scripts/seed.mjs");
    const createdAdmin = await db.query("insert into users (casdoor_id, username, display_name, status) values ($1, $2, $3, $$active$$) returning id", ["m6rpl-" + stamp + "-admin", "m6rpl-" + stamp + "-admin", "M6 回放管理员"]);
    await db.query("insert into user_roles (user_id, role_id) values ($1, $2)", [createdAdmin.rows[0].id, adminRole.rows[0].id]);
    cleanup.syntheticUserId = createdAdmin.rows[0].id;
    adminRow.rows.push(createdAdmin.rows[0]);
  }
  adminId = args.actor ?? adminRow.rows[0]?.id;
  check("P2", "管理员账号可用（roles.code = admin；空库自动建合成管理员）", "非空 userId", short(adminId ?? null, 80), adminId !== undefined);
  admin = await makeSession(adminId, "m6-replay");
  const probe = await call("GET", "/api/v1/projects?limit=1");
  check("P3", "临时会话可用（GET /api/v1/projects）", "200", probe.status + " " + short(probe.body?.total ?? probe.body?.code ?? null, 80), probe.status === 200);

  const created = await call("POST", "/api/v1/projects", { code: "M6RPL-" + stamp, name: "M6 回放项目（日报与问题）", projectType: "default", managerIds: [adminId] });
  cleanup.projectId = created.body?.id ?? null;
  check("P4", "建回放项目（M6RPL-）", "201", created.status + " " + short({ id: cleanup.projectId, code: created.body?.code }, 160), created.status === 201);

  const taskA = await call("POST", "/api/v1/projects/" + cleanup.projectId + "/tasks", { title: "M6RPL-引用守卫靶子（被问题引用）" });
  const taskB = await call("POST", "/api/v1/projects/" + cleanup.projectId + "/tasks", { title: "M6RPL-对照任务（无引用）" });
  taskAId = taskA.body?.id ?? null;
  taskBId = taskB.body?.id ?? null;
  check("P5", "建 2 个任务（引用守卫靶子 + 无引用对照）", "201 x 2", short({ a: taskAId, b: taskBId }, 200), taskA.status === 201 && taskB.status === 201);

  /** 附图证据：直接插 files 行（迁移器身份，status=draft —— 不走上传管道）。 */
  async function seedFile(name) {
    const row = await db.query(
      "insert into files (project_id, name, status, version, created_by, created_at, updated_at) values ($1, $2, $$draft$$, 1, $3, now(), now()) returning id",
      [cleanup.projectId, name, adminId],
    );
    const fileId = row.rows[0].id;
    cleanup.fileIds.push(fileId);
    return fileId;
  }

  const fileOnsite = await seedFile("M6RPL-现场照片.jpg");
  const fileOnsite2 = await seedFile("M6RPL-现场照片-2.jpg");
  const fileIssue = await seedFile("M6RPL-问题照片.jpg");

  const today = shanghaiDate(0);
  const yesterday = shanghaiDate(-1);
  const beforeYesterday = shanghaiDate(-2);
  const tomorrow = shanghaiDate(1);
  const farFuture = shanghaiDate(400);

  // ---------- 证据一：日报填报（A3-02 / A3-04 · 同日多条 · 关联阶段 · 附图校验） ----------
  const API = "/api/v1/projects/" + cleanup.projectId;
  const listReports = (params) => {
    const search = new URLSearchParams(params).toString();
    return call("GET", API + "/reports" + (search === "" ? "" : "?" + search));
  };
  const listIssues = (params) => {
    const search = new URLSearchParams(params).toString();
    return call("GET", API + "/issues" + (search === "" ? "" : "?" + search));
  };

  const createToday = await call("POST", API + "/reports", { date: today, doneWork: "装配工装 A 段就位并点检", headcount: 12, plan: "装配 B 段", stageKeys: ["install", "install"], photoFileIds: [fileOnsite], suggestion: "复测后复紧地脚螺栓" });
  reportId = createToday.body?.id ?? null;
  const todayOk = createToday.status === 201 && createToday.body?.state === "submitted" && createToday.body?.authorId === adminId && createToday.body?.date === today && createToday.body?.headcount === 12 && Array.isArray(createToday.body?.stageKeys) && createToday.body.stageKeys.length === 1 && createToday.body.stageKeys[0] === "install" && createToday.body?.stageNames?.[0] === "硬件实施" && Array.isArray(createToday.body?.photos) && createToday.body.photos[0]?.fileId === fileOnsite && createToday.body?.issuePhotos?.length === 0 && createToday.body?.submittedAt !== null && createToday.body?.submittedAt !== undefined;
  check("R1", "新报今天（submitted + 关联阶段去重 + 现场附图 + 系统字段）", "201 / submitted / stageKeys=[install] / photos[0]=现场图 / issuePhotos=[]", createToday.status + " / " + (createToday.body?.state ?? "-") + " / " + short({ stageKeys: createToday.body?.stageKeys, stageNames: createToday.body?.stageNames, photos: createToday.body?.photos, issuePhotos: createToday.body?.issuePhotos }, 220), todayOk === true);

  const createToday2 = await call("POST", API + "/reports", { date: today, doneWork: "同日第二条：支架复测", headcount: 5, foundIssue: "现场发现：支架尺寸偏差 3mm", issueCategories: ["机械部", "供应商原因"], photoFileIds: [fileOnsite2], issuePhotoFileIds: [fileIssue] });
  reportWithIssueId = createToday2.body?.id ?? null;
  const sameDayOk = createToday2.status === 201 && reportWithIssueId !== null && reportWithIssueId !== reportId && createToday2.body?.state === "submitted" && createToday2.body?.issueCategories?.length === 2;
  check("R2", "同日多条（Push 215）：同人同项目同日第二条照常新建（无 409 判重）", "201 / 新 id / issueCategories 两项", createToday2.status + " " + short({ id: reportWithIssueId, first: reportId, categories: createToday2.body?.issueCategories }, 200), sameDayOk === true);

  const future = await call("POST", API + "/reports", { date: tomorrow, doneWork: "未来" });
  check("R3", "未来日期 400 VALIDATION_FAILED", "400 VALIDATION_FAILED", future.status + " " + (future.body?.code ?? "-"), future.status === 400 && future.body?.code === "VALIDATION_FAILED");

  const backfill = await call("POST", API + "/reports", { date: yesterday, doneWork: "昨天：下料完成", headcount: 8 });
  check("R4", "补填昨天（state=supplement）", "201 supplement", backfill.status + " " + (backfill.body?.state ?? "-"), backfill.status === 201 && backfill.body?.state === "supplement");

  const draft = await call("POST", API + "/reports", { date: beforeYesterday, state: "draft", doneWork: "前天：图纸会审（草稿）" });
  const draftRow = await db.query("select state, submitted_at from daily_reports where id = $1", [draft.body?.id]);
  const submitDraft = await call("PATCH", API + "/reports/" + draft.body?.id, { version: draft.body?.version ?? 0, state: "submitted" });
  check("R5", "草稿写库（state=draft 落行）+ 提交（过去日期 = 补填 supplement）", "201 draft（库内 state=draft / submitted_at 为空）-> 200 supplement", draft.status + " " + (draft.body?.state ?? "-") + " / 库内 " + short(draftRow.rows[0] ?? null, 120) + " -> " + submitDraft.status + " " + (submitDraft.body?.state ?? "-"), draft.status === 201 && draft.body?.state === "draft" && draftRow.rows[0]?.state === "draft" && draftRow.rows[0]?.submitted_at === null && submitDraft.status === 200 && submitDraft.body?.state === "supplement");

  const list = await listReports({ "filter[dateFrom]": beforeYesterday, "filter[dateTo]": today, limit: "10" });
  const dates = (list.body?.items ?? []).map((item) => item.date);
  check("R6", "日报列表：4 条 + 日期倒序", "200 / total=4 / 首行 " + today, list.status + " / total=" + (list.body?.total ?? "-") + " / " + dates.join(","), list.status === 200 && list.body?.total === 4 && dates[0] === today);

  const detail = await call("GET", API + "/reports/" + reportId);
  check("R7", "日报详情（A3-01 全字段回读：阶段 / 附图 / 建议）", "200 + stageKeys[0]=install / photos[0]=现场图 / suggestion 一致", detail.status + " " + short({ stageKeys: detail.body?.stageKeys, photos: detail.body?.photos, suggestion: detail.body?.suggestion }, 220), detail.status === 200 && detail.body?.stageKeys?.[0] === "install" && detail.body?.photos?.[0]?.fileId === fileOnsite && detail.body?.photos?.[0]?.name === "M6RPL-现场照片.jpg" && detail.body?.suggestion === "复测后复紧地脚螺栓");

  const detailWithIssue = await call("GET", API + "/reports/" + reportWithIssueId);
  check("R8", "日报详情（现场发现问题 + 多值归类 + 附件两栏位）", "200 + issueCategories 两项 / photos[0]=现场图-2", detailWithIssue.status + " " + short({ categories: detailWithIssue.body?.issueCategories, photos: detailWithIssue.body?.photos }, 220), detailWithIssue.status === 200 && detailWithIssue.body?.issueCategories?.join(",") === "机械部,供应商原因" && detailWithIssue.body?.photos?.[0]?.fileId === fileOnsite2);

  const unknownFile = await call("POST", API + "/reports", { date: today, doneWork: "带未知附图", photoFileIds: [randomUUID()] });
  check("R9", "附图校验：文件不存在 / 不属于本项目 -> 400 VALIDATION_FAILED", "400 VALIDATION_FAILED", unknownFile.status + " " + (unknownFile.body?.code ?? "-"), unknownFile.status === 400 && unknownFile.body?.code === "VALIDATION_FAILED");

  // ---------- 证据二：提交副作用（A3-09 问题生成 · 幂等 · 附图转挂 · A3-08 停用） ----------
  const issuesOfReport = await listIssues({ "filter[reportId]": reportWithIssueId, limit: "10" });
  const generated = issuesOfReport.body?.items?.[0] ?? null;
  issueId = generated?.id ?? null;
  const genOk = issuesOfReport.status === 200 && issuesOfReport.body?.total === 1 && generated !== null && generated.title === "现场发现：支架尺寸偏差 3mm" && generated.categories?.join(",") === "机械部,供应商原因" && generated.state === "open" && generated.reporterId === adminId && generated.raisedAt === today && generated.ownerDepartment === "机械部" && generated.taskId === null && generated.sourceReportId === reportWithIssueId;
  check("I1", "A3-09：提交自动生成问题（原文 / 多值归类 / 提出人 / 提出日期 / A3-12 归类分派）", "total=1 + state=open + categories 两项 + ownerDepartment=机械部", issuesOfReport.status + " total=" + (issuesOfReport.body?.total ?? "-") + " " + short(generated === null ? null : { title: generated.title, categories: generated.categories, state: generated.state, dept: generated.ownerDepartment }, 220), genOk === true);

  const issueDetail = await call("GET", API + "/issues/" + issueId);
  const reportAfterTransfer = await call("GET", API + "/reports/" + reportWithIssueId);
  const transferOk = issueDetail.status === 200 && (issueDetail.body?.photos ?? []).length === 1 && issueDetail.body?.photos?.[0]?.fileId === fileIssue && (reportAfterTransfer.body?.issuePhotos ?? []).length === 0 && (reportAfterTransfer.body?.photos ?? []).length === 1 && reportAfterTransfer.body?.photos?.[0]?.fileId === fileOnsite2;
  check("I2", "附图转挂（方案一）：提交生成问题时问题图从日报侧转挂到问题侧，日报侧只剩现场图", "问题 photos[0]=问题图 / 日报 issuePhotos=[] / 日报 photos[0]=现场图-2", short({ issuePhotos: issueDetail.body?.photos, reportIssuePhotos: reportAfterTransfer.body?.issuePhotos, reportPhotos: reportAfterTransfer.body?.photos }, 260), transferOk === true);

  const links = await db.query("select object_type, object_id, kind, count(*)::int as n from file_links where object_id in ($1, $2) or file_id = $3 group by 1, 2, 3 order by 1, 3", [reportWithIssueId, issueId, fileOnsite2]);
  const linkRows = links.rows.map((row) => row.object_type + "/" + row.kind + "=" + row.n).sort();
  check("I3", "附图链路落库（file_links）：日报侧 onsite=1、问题侧 =1（kind=空串），issue 侧链由问题持有", "report/onsite=1 + issue/=1（无 report/issue 残留 — 已转挂）", short(linkRows, 200), linkRows.indexOf("report/onsite=1") >= 0 && linkRows.indexOf("issue/=1") >= 0 && linkRows.indexOf("report/issue=1") === -1);

  const replay = await call("PATCH", API + "/reports/" + reportWithIssueId, { version: createToday2.body.version, doneWork: "同日第二条：支架复测（复述）", issuePhotoFileIds: [fileIssue] });
  const issuesAfterReplay = await listIssues({ "filter[reportId]": reportWithIssueId, limit: "10" });
  const seedEvents = await db.query("select count(*)::int as n from issue_events where issue_id = $1", [issueId]);
  check("I4", "幂等重放：重编辑已提交日报（重跑副作用）-> 问题仍 1 条、事件不重复（仅 created）", "issues total=1 / issue_events=1", "issues total=" + (issuesAfterReplay.body?.total ?? "-") + " / issue_events=" + seedEvents.rows[0].n, replay.status === 200 && issuesAfterReplay.body?.total === 1 && seedEvents.rows[0].n === 1);

  const taskRow = await db.query("select note from tasks where id = $1", [taskAId]);
  const noteEvents = await db.query("select count(*)::int as n from task_events where task_id = $1 and event_type = $2", [taskAId, "note_change"]);
  check("T1", "A3-08 停用（Push 215）：提交日报不再回写任务进展（note 空 / 无 note_change 事件）", "note 为空 / note_change=0", short({ note: taskRow.rows[0]?.note ?? null, events: noteEvents.rows[0].n }, 160), (taskRow.rows[0]?.note ?? null) === null && noteEvents.rows[0].n === 0);

  // ---------- 证据三：问题三态与留痕（A3-10 / A3-11 / A3-13） ----------
  const progressIssue = await call("PATCH", API + "/issues/" + issueId, { version: generated.version, state: "in_progress", note: "已联系厂家" });
  check("E1", "三态：open -> in_progress（写一条 state_change）", "200 in_progress / events=2", progressIssue.status + " " + (progressIssue.body?.state ?? "-") + " / events=" + (progressIssue.body?.events?.length ?? "-"), progressIssue.status === 200 && progressIssue.body?.state === "in_progress" && progressIssue.body?.events?.length === 2);

  const doneIssue = await call("PATCH", API + "/issues/" + issueId, { version: progressIssue.body?.version, state: "done", solution: "更换定位销并复测合格" });
  check("E2", "三态：in_progress -> done（同写 closed_at / closed_by + solution 事件）", "200 done / closedBy=admin / events=4", doneIssue.status + " " + (doneIssue.body?.state ?? "-") + " closedBy=" + (doneIssue.body?.closedBy ?? "-") + " / events=" + (doneIssue.body?.events?.length ?? "-"), doneIssue.status === 200 && doneIssue.body?.state === "done" && doneIssue.body?.closedAt !== null && doneIssue.body?.closedBy === adminId && doneIssue.body?.solution === "更换定位销并复测合格" && doneIssue.body?.events?.length === 4);

  const rollbackIssue = await call("PATCH", API + "/issues/" + issueId, { version: doneIssue.body?.version, state: "open", note: "复测未过，回退处理" });
  check("E3", "A3-10 允许回退：done -> open（自动清空关闭对）", "200 open / closedAt=null / events=5", rollbackIssue.status + " " + (rollbackIssue.body?.state ?? "-") + " closedAt=" + String(rollbackIssue.body?.closedAt ?? "null") + " / events=" + (rollbackIssue.body?.events?.length ?? "-"), rollbackIssue.status === 200 && rollbackIssue.body?.state === "open" && rollbackIssue.body?.closedAt === null && rollbackIssue.body?.closedBy === null && rollbackIssue.body?.events?.length === 5);

  const emptyUpdate = await call("PATCH", API + "/issues/" + issueId, { version: rollbackIssue.body?.version, note: "只有备注" });
  check("E4", "空更新 400 VALIDATION_FAILED（防刷留痕）", "400 VALIDATION_FAILED", emptyUpdate.status + " " + (emptyUpdate.body?.code ?? "-"), emptyUpdate.status === 400 && emptyUpdate.body?.code === "VALIDATION_FAILED");

  const staleUpdate = await call("PATCH", API + "/issues/" + issueId, { version: generated.version, state: "done" });
  check("E5", "乐观锁：过期 version 409 VERSION_CONFLICT", "409 VERSION_CONFLICT", staleUpdate.status + " " + (staleUpdate.body?.code ?? "-"), staleUpdate.status === 409 && staleUpdate.body?.code === "VERSION_CONFLICT");

  const byState = await listIssues({ "filter[state]": "open", limit: "10" });
  const byKeyword = await listIssues({ q: "支架", limit: "10" });
  const byCategory = await listIssues({ "filter[category]": "供应商原因", limit: "10" });
  const byCategoryMiss = await listIssues({ "filter[category]": "其它原因", limit: "10" });
  check("E6", "问题列表：状态 / 关键字 / 多值归类筛选（命中任一即入选）", "open total=1 / 支架 total=1 / 供应商原因 total=1 / 其它原因 total=0", "state total=" + (byState.body?.total ?? "-") + " / q total=" + (byKeyword.body?.total ?? "-") + " / category total=" + (byCategory.body?.total ?? "-") + " / miss total=" + (byCategoryMiss.body?.total ?? "-"), byState.status === 200 && byState.body?.total === 1 && byKeyword.body?.total === 1 && byCategory.body?.total === 1 && byCategoryMiss.body?.total === 0);

  const editedIssue = await call("PATCH", API + "/issues/" + issueId, { version: rollbackIssue.body?.version, title: "现场发现：支架尺寸偏差 3mm（复测）", categories: ["机械部", "生产原因"] });
  check("E7", "PATCH 扩项：描述 / 归类（多值）可改（走审计，不写事件 -> events 仍 5）", "200 / title 更新 / categories 两项 / events=5", editedIssue.status + " " + short({ title: editedIssue.body?.title, categories: editedIssue.body?.categories, events: editedIssue.body?.events?.length }, 200), editedIssue.status === 200 && editedIssue.body?.title === "现场发现：支架尺寸偏差 3mm（复测）" && editedIssue.body?.categories?.join(",") === "机械部,生产原因" && editedIssue.body?.events?.length === 5);

  const assignIssue = await call("PATCH", API + "/issues/" + issueId, { version: editedIssue.body?.version, ownerId: adminId, note: "转我自己跟进" });
  const detailIssue = await call("GET", API + "/issues/" + issueId);
  const types = (detailIssue.body?.events ?? []).map((event) => event.eventType);
  check("E8", "A3-13 留痕：分派（assignment）与四类事件齐备（created / state_change / solution / assignment）", "ownerId=admin + events=6 + 四类齐备", short({ owner: assignIssue.body?.ownerId, count: types.length, types }, 220), assignIssue.status === 200 && assignIssue.body?.ownerId === adminId && types.indexOf("created") >= 0 && types.indexOf("state_change") >= 0 && types.indexOf("solution") >= 0 && types.indexOf("assignment") >= 0 && types.length === 6);

  // ---------- 证据四：成对删除 + A2-01 删除引用守卫 ----------
  const survivingReport = await call("POST", API + "/reports", { date: today, doneWork: "同日第三条：客户协调", headcount: 5, foundIssue: "客户临时改期", issueCategories: ["客户原因"] });
  const survivingIssues = await listIssues({ "filter[reportId]": survivingReport.body?.id, limit: "10" });
  survivingIssueId = survivingIssues.body?.items?.[0]?.id ?? null;
  const assignSurvivor = await call("PATCH", API + "/issues/" + survivingIssueId, { version: survivingIssues.body?.items?.[0]?.version, ownerId: adminId });
  check("G0", "附带数据：同日补一条带问题日报（供我的问题两栏 / 归档清单留存量），问题负责人 = 我", "201 + issue total=1 + ownerId=admin", survivingReport.status + " / " + short({ report: survivingReport.body?.id, issue: survivingIssueId, owner: assignSurvivor.body?.ownerId, state: survivingIssues.body?.items?.[0]?.state }, 220), survivingReport.status === 201 && survivingIssueId !== null && assignSurvivor.status === 200 && assignSurvivor.body?.ownerId === adminId);

  const cascadeReport = await call("POST", API + "/reports", { date: yesterday, doneWork: "成对删除靶子：现场协调", foundIssue: "成对删除靶子问题", issueCategories: ["采购部"], photoFileIds: [fileOnsite] });
  const cascadeIssues = await listIssues({ "filter[reportId]": cascadeReport.body?.id, limit: "10" });
  const cascadeIssueId = cascadeIssues.body?.items?.[0]?.id ?? null;
  reportToCascadeId = cascadeReport.body?.id ?? null;
  check("G1a", "成对删除前置：新建带问题日报（靶子）", "201 + 派生问题 1 条", cascadeReport.status + " " + short({ report: reportToCascadeId, issue: cascadeIssueId }, 160), cascadeReport.status === 201 && cascadeIssueId !== null);

  const deleteReport = await call("DELETE", API + "/reports/" + reportToCascadeId);
  const goneIssue = await call("GET", API + "/issues/" + cascadeIssueId);
  const goneReport = await call("GET", API + "/reports/" + reportToCascadeId);
  const leftLinks = await db.query("select count(*)::int as n from file_links where object_type = $1 and object_id = $2", ["report", reportToCascadeId]);
  check("G1", "成对删除：DELETE 日报 = 连带删除它派生的全部问题 + 两侧附图链（cascadedIssueIds 回执）", "200 deleted + cascadedIssueIds=[派生问题] / 问题与日报 404 / file_links 0 行", deleteReport.status + " " + short({ body: deleteReport.body, issue: goneIssue.status, report: goneReport.status, links: leftLinks.rows[0].n }, 260), deleteReport.status === 200 && deleteReport.body?.deleted === true && (deleteReport.body?.cascadedIssueIds ?? []).indexOf(cascadeIssueId) >= 0 && goneIssue.status === 404 && goneReport.status === 404 && leftLinks.rows[0].n === 0);

  const deleteIssue = await call("DELETE", API + "/issues/" + issueId);
  const goneSourceReport = await call("GET", API + "/reports/" + reportWithIssueId);
  const goneIssuesAfter = await listIssues({ "filter[reportId]": reportWithIssueId, limit: "10" });
  check("G2", "成对删除：DELETE 问题（有来源日报）= 连带删除来源日报及其全部问题（cascadedReportId 回执）", "200 deleted + cascadedReportId=" + reportWithIssueId + " / 来源日报 404 / 派生问题清零", deleteIssue.status + " " + short({ body: deleteIssue.body, report: goneSourceReport.status, issuesLeft: goneIssuesAfter.body?.total }, 260), deleteIssue.status === 200 && deleteIssue.body?.deleted === true && deleteIssue.body?.cascadedReportId === reportWithIssueId && goneSourceReport.status === 404 && goneIssuesAfter.body?.total === 0);

  const syntheticIssue = await db.query(
    "insert into issues (project_id, task_id, title, categories, state, reporter_id, raised_at) values ($1, $2, $$M6RPL-引用守卫占位$$, array[$$机械部$$]::text[], $$open$$, $3, $4) returning id",
    [cleanup.projectId, taskAId, adminId, today],
  );
  const syntheticIssueId = syntheticIssue.rows[0].id;
  const deleteA = await call("DELETE", API + "/tasks/" + taskAId);
  const codesA = (deleteA.body?.details ?? []).map((item) => item.code);
  await db.query("delete from issues where id = $1", [syntheticIssueId]);
  check("G3", "A2-01：被问题引用的任务 DELETE 409（details[].code = issue_ref，带条数）", "409 TASK_HAS_REFERENCES + 仅 issue_ref", deleteA.status + " " + (deleteA.body?.code ?? "-") + " " + short(codesA, 140), deleteA.status === 409 && deleteA.body?.code === "TASK_HAS_REFERENCES" && codesA.join(",") === "issue_ref");

  const deleteB = await call("DELETE", API + "/tasks/" + taskBId);
  const deleteB2 = await call("DELETE", API + "/tasks/" + taskBId);
  check("G4", "无引用任务可删（200）+ 重复删除 404", "200 / 404", deleteB.status + " / " + deleteB2.status, deleteB.status === 200 && deleteB2.status === 404);

  const missingReport = await call("GET", API + "/reports/" + randomUUID());
  const missingIssue = await call("GET", API + "/issues/" + randomUUID());
  check("G5", "记录级 404：不存在 / 跨项目 id 的日报与问题详情", "404 / 404", missingReport.status + " / " + missingIssue.status, missingReport.status === 404 && missingIssue.status === 404);

  // ---------- 证据五：M6-01 收口 —— 当日汇总（A7-01）与应填未填（A7-05） ----------
  // 名册是 A7-05 的应填范围：先落 1 名成员（项目经理；M2-05 幂等 upsert），再验「名册 × 当日状态」
  const rosterAdd = await call("POST", API + "/members", { userId: adminId, roleInProject: "project_manager" });
  check("S0", "A7-05 前置：回放成员落名册（M2-05 幂等 upsert）+ 身份随行下发", "200 / userId=adminId / roleInProject=project_manager", rosterAdd.status + " " + short({ userId: rosterAdd.body?.userId, role: rosterAdd.body?.roleInProject }, 140), rosterAdd.status === 200 && rosterAdd.body?.userId === adminId && rosterAdd.body?.roleInProject === "project_manager");

  const summaryToday = await call("GET", API + "/reports/summary?date=" + today);
  const summaryEntry = (summaryToday.body?.entries ?? []).find((entry) => entry.id === reportId) ?? null;
  const summaryTodayOk = summaryToday.status === 200 && summaryToday.body?.date === today && summaryToday.body?.entryCount === 2 && summaryToday.body?.draftCount === 0 && summaryToday.body?.headcountTotal === 17 && summaryToday.body?.issueCount === 1 && summaryEntry !== null && summaryEntry.authorId === adminId && summaryEntry.date === today && summaryEntry.stageNames?.[0] === "硬件实施" && summaryEntry.photos?.[0]?.fileId === fileOnsite;
  check("S1", "A7-01 当日汇总：已提交条目聚合（entryCount=2 / 人数合计=17 / 问题数=1；同一人多条各计一条）", "200 entryCount=2 headcountTotal=17 issueCount=1 + 阶段名与附图随行", summaryToday.status + " " + short({ date: summaryToday.body?.date, entryCount: summaryToday.body?.entryCount, headcountTotal: summaryToday.body?.headcountTotal, issueCount: summaryToday.body?.issueCount, stages: summaryEntry?.stageNames, photos: summaryEntry?.photos?.length }, 240), summaryTodayOk);

  const summaryDefault = await call("GET", API + "/reports/summary");
  check("S2", "A7-01 / A7-05 缺省日期 = 今天（Asia/Shanghai）", "200 date=" + today, summaryDefault.status + " " + String(summaryDefault.body?.date ?? "-") + " / isWorkday=" + String(summaryDefault.body?.isWorkday), summaryDefault.status === 200 && summaryDefault.body?.date === today && summaryDefault.body?.entryCount === 2 && typeof summaryDefault.body?.dayKind === "string");

  const summaryFuture = await call("GET", API + "/reports/summary?date=" + tomorrow);
  const missingFuture = await call("GET", API + "/reports/missing?date=" + tomorrow);
  check("S3", "未来日期 400 VALIDATION_FAILED（汇总 / 应填未填同口径，A3-04）", "400 x 2", summaryFuture.status + " / " + missingFuture.status, summaryFuture.status === 400 && summaryFuture.body?.code === "VALIDATION_FAILED" && missingFuture.status === 400 && missingFuture.body?.code === "VALIDATION_FAILED");

  const missingToday = await call("GET", API + "/reports/missing?date=" + today);
  const missingTodayOk = missingToday.status === 200 && missingToday.body?.memberCount >= 1 && missingToday.body?.members?.length === missingToday.body?.memberCount && missingToday.body?.members?.filter((member) => member.userId === adminId && member.reportId === reportId && member.state === "submitted" && member.roleInProject === "project_manager").length === 1 && missingToday.body?.submittedCount === 1 && (missingToday.body?.missingUserIds ?? []).indexOf(adminId) === -1 && missingToday.body?.missingCount === (missingToday.body?.isWorkday === true ? missingToday.body.memberCount - 1 : 0) && (missingToday.body?.missingUserIds ?? []).length === missingToday.body?.missingCount;
  check("S4", "A7-05 应填未填：名册 × 当日状态（已提交 → 不在漏填名单；同一人多条取首条已提交）", "200 memberCount≥1 submittedCount=1 / 漏填 = 名册 − 1", missingToday.status + " " + short({ memberCount: missingToday.body?.memberCount, submittedCount: missingToday.body?.submittedCount, missingCount: missingToday.body?.missingCount, missingUserIds: missingToday.body?.missingUserIds }, 200), missingTodayOk);

  // 冒烟判定：近 16 天内挑一个「无日报的工作日」（用日历接口自证，不硬编码星期）
  let blankWorkday = null;
  for (let offset = -4; offset >= -16 && blankWorkday === null; offset -= 1) {
    const probeDay = shanghaiDate(offset);
    const dayView = await call("GET", "/api/v1/calendar/day?date=" + probeDay);
    if (dayView.status === 200 && dayView.body?.isWorkday === true) blankWorkday = probeDay;
  }
  if (blankWorkday === null) {
    check("S5", "A7-05 应填未填：工作日无日报 → 名册全员进漏填名单", "近 16 天内无工作日（跳过）", "跳过", true, "日历例外连成长假时不适用");
  } else {
    const missingBlank = await call("GET", API + "/reports/missing?date=" + blankWorkday);
    const ids = missingBlank.body?.missingUserIds ?? [];
    const blankOk = missingBlank.status === 200 && missingBlank.body?.isWorkday === true && missingBlank.body?.memberCount >= 1 && missingBlank.body?.submittedCount === 0 && missingBlank.body?.draftCount === 0 && ids.length === missingBlank.body?.memberCount && missingBlank.body?.missingCount === missingBlank.body?.memberCount && ids.indexOf(adminId) >= 0 && missingBlank.body?.members?.every((member) => member.state === null && member.reportId === null && member.submittedAt === null);
    check("S5", "A7-05 应填未填：工作日无日报（" + blankWorkday + "）→ 名册全员进漏填名单", "200 submittedCount=0 / missingCount=memberCount / missingUserIds 全量", missingBlank.status + " " + short({ date: missingBlank.body?.date, memberCount: missingBlank.body?.memberCount, missingCount: missingBlank.body?.missingCount, missingUserIds: ids }, 200), blankOk);
  }

  // 冒烟判定：近 21 天内挑一个「非工作日」——整列必须为空（不催报）
  let restDay = null;
  for (let offset = -3; offset >= -21 && restDay === null; offset -= 1) {
    const probeDay = shanghaiDate(offset);
    const dayView = await call("GET", "/api/v1/calendar/day?date=" + probeDay);
    if (dayView.status === 200 && dayView.body?.isWorkday === false) restDay = probeDay;
  }
  if (restDay === null) {
    check("S6", "A7-05 非工作日整列为空（不催报）", "近 21 天内无非工作日（跳过）", "跳过", true, "日历例外全为工作日时不适用");
  } else {
    const missingRest = await call("GET", API + "/reports/missing?date=" + restDay);
    const restOk = missingRest.status === 200 && missingRest.body?.isWorkday === false && missingRest.body?.missingCount === 0 && (missingRest.body?.missingUserIds ?? []).length === 0 && missingRest.body?.members?.length === missingRest.body?.memberCount && missingRest.body?.members?.every((member) => member.state === null);
    check("S6", "A7-05 非工作日整列为空（" + restDay + " / " + String(missingRest.body?.dayKind ?? "-") + " / " + String(missingRest.body?.dayName ?? "无例外名") + "）", "200 missingCount=0 missingUserIds=[]", missingRest.status + " " + short({ isWorkday: missingRest.body?.isWorkday, dayKind: missingRest.body?.dayKind, dayName: missingRest.body?.dayName, missingCount: missingRest.body?.missingCount, members: missingRest.body?.members?.length ?? null }, 200), restOk);
  }

  // ---------- 证据六：工作台（M6-05 · A6-01 我的任务四组 / A6-03 我的问题两栏 · 2026-09-30 口径复评） ----------
  // 命中口径 = 任务负责人含我 或 项目项目经理含我（本回放项目 managerIds=[adminId]，本项目未完成任务均可见）+ 未完成；
  // 分组不限窗口：plannedEnd 昨天 → overdue / 今天 → today / 远期 → upcoming / 空 → unscheduled（新增组）。
  const bench = await call("POST", API + "/tasks", { title: "M6RPL-工作台靶子（四组 / 两栏）" });
  let benchTask = bench.body ?? null;
  const workspaceNew = await call("GET", "/api/v1/workspace");
  const newHit = (workspaceNew.body?.myTasks?.unscheduled ?? []).find((item) => item.id === benchTask?.id) ?? null;
  check("W0", "工作台前置：建靶子任务（缺省待分配 + 无日期）→ 项目经理口径直接命中「未排期」组", "201 / ownerIds=[] / unscheduled 含靶子", bench.status + " " + short({ id: benchTask?.id ?? null, ownerIds: benchTask?.ownerIds ?? null, unscheduledHit: newHit !== null }, 220), bench.status === 201 && Array.isArray(benchTask?.ownerIds) && benchTask.ownerIds.length === 0 && workspaceNew.status === 200 && newHit !== null && newHit.plannedEnd === null);

  const setOverdue = await call("PATCH", API + "/tasks/" + benchTask.id, { version: benchTask.version, ownerIds: [adminId], plannedEnd: yesterday });
  benchTask = setOverdue.body ?? benchTask;
  const workspaceOverdue = await call("GET", "/api/v1/workspace");
  const overdueHit = (workspaceOverdue.body?.myTasks?.overdue ?? []).find((item) => item.id === benchTask.id) ?? null;
  check("W1", "A6-01 已逾期组：负责人含我 + plannedEnd < 今天 → overdue（displayStatus=overdue）", "200 / overdue 含靶子 / displayStatus=overdue", workspaceOverdue.status + " " + short({ patch: setOverdue.status, hit: overdueHit !== null, displayStatus: overdueHit?.displayStatus ?? null, base: workspaceOverdue.body?.today ?? null }, 220), setOverdue.status === 200 && workspaceOverdue.status === 200 && workspaceOverdue.body?.today === today && overdueHit !== null && overdueHit.plannedEnd === yesterday && overdueHit.displayStatus === "overdue" && overdueHit.projectCode === created.body?.code && (overdueHit.ownerIds ?? []).indexOf(adminId) >= 0);

  const setToday = await call("PATCH", API + "/tasks/" + benchTask.id, { version: benchTask.version, plannedEnd: today });
  benchTask = setToday.body ?? benchTask;
  const workspaceToday = await call("GET", "/api/v1/workspace");
  const todayHit = (workspaceToday.body?.myTasks?.today ?? []).find((item) => item.id === benchTask.id) ?? null;
  const todayLeak = ["upcoming", "overdue", "unscheduled"].filter((key) => (workspaceToday.body?.myTasks?.[key] ?? []).some((item) => item.id === benchTask.id));
  check("W2", "A6-01 今日待办组：plannedEnd = 今天 → today（不落他组）", "200 / today 含靶子 / 他组无", workspaceToday.status + " " + short({ patch: setToday.status, hit: todayHit !== null, leak: todayLeak }, 200), setToday.status === 200 && workspaceToday.status === 200 && todayHit !== null && todayHit.plannedEnd === today && todayLeak.length === 0);

  const setTomorrow = await call("PATCH", API + "/tasks/" + benchTask.id, { version: benchTask.version, plannedEnd: tomorrow });
  benchTask = setTomorrow.body ?? benchTask;
  const workspaceUpcoming = await call("GET", "/api/v1/workspace");
  const upcomingHit = (workspaceUpcoming.body?.myTasks?.upcoming ?? []).find((item) => item.id === benchTask.id) ?? null;
  check("W3", "A6-01 即将到期组：plannedEnd = 明天（> 今天）→ upcoming", "200 / upcoming 含靶子", workspaceUpcoming.status + " " + short({ patch: setTomorrow.status, hit: upcomingHit !== null, plannedEnd: upcomingHit?.plannedEnd ?? null }, 200), setTomorrow.status === 200 && workspaceUpcoming.status === 200 && upcomingHit !== null && upcomingHit.plannedEnd === tomorrow);

  const setFar = await call("PATCH", API + "/tasks/" + benchTask.id, { version: benchTask.version, plannedEnd: farFuture });
  benchTask = setFar.body ?? benchTask;
  const workspaceFar = await call("GET", "/api/v1/workspace");
  const farHit = (workspaceFar.body?.myTasks?.upcoming ?? []).find((item) => item.id === benchTask.id) ?? null;
  check("W4", "A6-01 不限窗口（复评）：plannedEnd = 今天 + 400 天仍进 upcoming（原 7 天窗口已取消）", "200 / upcoming 含靶子（plannedEnd=" + farFuture + "）", workspaceFar.status + " " + short({ patch: setFar.status, hit: farHit !== null, plannedEnd: farHit?.plannedEnd ?? null }, 220), setFar.status === 200 && workspaceFar.status === 200 && farHit !== null && farHit.plannedEnd === farFuture);

  const setUnassigned = await call("PATCH", API + "/tasks/" + benchTask.id, { version: benchTask.version, ownerIds: [], plannedEnd: null });
  benchTask = setUnassigned.body ?? benchTask;
  const workspaceUnassigned = await call("GET", "/api/v1/workspace");
  const unassignedHit = (workspaceUnassigned.body?.myTasks?.unscheduled ?? []).find((item) => item.id === benchTask?.id) ?? null;
  const unassignedLeak = ["today", "upcoming", "overdue"].filter((key) => (workspaceUnassigned.body?.myTasks?.[key] ?? []).some((item) => item.id === benchTask.id));
  check("W5", "A6-01 项目经理口径：清空负责人（ownerIds=[]）+ 清空日期 → 仍命中「未排期」组（原「待分配不进」反例随复评失效，供 W7 反证）", "200 / unscheduled 含靶子 / 他组无", workspaceUnassigned.status + " " + short({ patch: setUnassigned.status, ownerIds: benchTask?.ownerIds ?? null, hit: unassignedHit !== null }, 240), setUnassigned.status === 200 && (benchTask?.ownerIds ?? []).length === 0 && workspaceUnassigned.status === 200 && unassignedHit !== null && unassignedHit.plannedEnd === null && unassignedLeak.length === 0);

  const workspaceIssues = await call("GET", "/api/v1/workspace");
  const handlingHit = (workspaceIssues.body?.myIssues?.handling ?? []).find((item) => item.id === survivingIssueId) ?? null;
  const raisedHit = (workspaceIssues.body?.myIssues?.raised ?? []).find((item) => item.id === survivingIssueId) ?? null;
  const issuesOk = workspaceIssues.status === 200 && handlingHit !== null && raisedHit !== null && handlingHit.state === "open" && handlingHit.ownerId === adminId && raisedHit.reporterId === adminId && raisedHit.projectCode === created.body?.code && handlingHit.categories?.join(",") === "客户原因";
  check("W6", "A6-03 我的问题两栏：双命中（ownerId / reporterId 均为我）两边都出现；多值归类随行", "200 / handling 与 raised 均含问题 / categories=客户原因", workspaceIssues.status + " " + short({ handling: handlingHit?.id ?? null, raised: raisedHit?.id ?? null, state: handlingHit?.state ?? null, categories: handlingHit?.categories ?? null }, 240), issuesOk === true);
  // Push 302 全字段修订：聚合面直出任务表 15 列数据源 + 问题七列（solution / photos）+ 项目卡 projects
  // （前端不再逐项目回填）；此处对账随行 / 随盘字段齐全、空值不丢键。
  const wsProjectCard302 = (workspaceIssues.body?.projects ?? []).find((item) => item.id === cleanup.projectId) ?? null;
  const wsFull302 = unassignedHit !== null && handlingHit !== null && wsProjectCard302 !== null && unassignedHit.projectName === created.body?.name && Array.isArray(unassignedHit.files) && unassignedHit.files.length === 0 && Array.isArray(unassignedHit.deliverableTypes) && unassignedHit.deliverableTypes.length === 0 && Array.isArray(unassignedHit.changeLinks) && unassignedHit.changeLinks.length === 0 && typeof unassignedHit.version === "number" && unassignedHit.version >= 0 && handlingHit.solution === null && Array.isArray(handlingHit.photos) && handlingHit.photos.length === 0 && wsProjectCard302.code === created.body?.code && wsProjectCard302.managerIds.indexOf(adminId) >= 0;
  check("W6b", "Push 302 全字段修订：任务行随行 projectName / files / deliverableTypes / changeLinks / version，问题行随行 solution / photos，响应随盘 projects 卡（managerNames / managerIds / version）", "行字段齐全（空值不丢键）+ 项目卡命中", short({ projectName: unassignedHit?.projectName ?? null, files: unassignedHit?.files?.length ?? null, deliverables: unassignedHit?.deliverableTypes?.length ?? null, changes: unassignedHit?.changeLinks?.length ?? null, version: unassignedHit?.version ?? null, solution: handlingHit?.solution ?? "-", photos: handlingHit?.photos?.length ?? null, card: wsProjectCard302 === null ? null : { code: wsProjectCard302.code, managers: wsProjectCard302.managerNames, version: wsProjectCard302.version } }, 260), wsFull302 === true);

  // ---------- 证据七：归档（M7-04 · C4-02 / C4-03 · ADR-027）：门禁 → 确认越过 → 清单 → 只读 → 检索 ----------
  // 硬前置「验收完成」：回放不推进九阶段，直接造态（acceptance 行 done + 当前阶段指到 acceptance）。
  await db.query("update project_stages set status = $2, advanced_at = now() where project_id = $1 and stage_key = $3", [cleanup.projectId, "done", "acceptance"]);
  await db.query("update projects set stage_key = $2 where id = $1", [cleanup.projectId, "acceptance"]);
  const beforeArchive = await call("GET", API);
  const archiveVersion = beforeArchive.body?.version;
  check("A1", "归档前置：项目读到验收阶段（stageKey=acceptance）与当前 version", "200 stageKey=acceptance version>=0", beforeArchive.status + " " + short({ stageKey: beforeArchive.body?.stageKey, version: archiveVersion }, 140), beforeArchive.status === 200 && beforeArchive.body?.stageKey === "acceptance" && Number.isInteger(archiveVersion) && archiveVersion >= 0);

  const gateRejected = await call("POST", API + "/archive", { version: archiveVersion });
  const gateCodes = (gateRejected.body?.details ?? []).map((item) => item.code);
  check("A2", "归档门禁：有缺项且未确认 -> 422 ARCHIVE_GATE_NOT_PASSED（details 带缺项明细）", "422 ARCHIVE_GATE_NOT_PASSED + details 含 task_not_done", gateRejected.status + " " + (gateRejected.body?.code ?? "-") + " " + short(gateCodes, 160), gateRejected.status === 422 && gateRejected.body?.code === "ARCHIVE_GATE_NOT_PASSED" && gateCodes.indexOf("task_not_done") >= 0 && (gateRejected.body?.details ?? []).every((item) => item.path === "missing" && typeof item.message === "string"));

  const afterReject = await call("GET", API);
  const failedAudit = await db.query("select count(*)::int as n from audit_logs where project_id = $1 and action = $2 and result = $3", [cleanup.projectId, "archive", "failed"]);
  check("A3", "门禁拒绝：不置位（仍 active）+ 写失败留痕（audit archive / failed）", "200 status=active + audit failed>=1", afterReject.status + " " + short({ status: afterReject.body?.status, failed: failedAudit.rows[0].n }, 140), afterReject.status === 200 && afterReject.body?.status === "active" && failedAudit.rows[0].n >= 1);

  const confirmed = await call("POST", API + "/archive", { version: archiveVersion, confirm: true });
  const confirmedSnapshot = confirmed.body?.snapshot;
  const ackCodes = (confirmed.body?.acknowledgedMissing ?? []).map((item) => item.code);
  const afterConfirm = await call("GET", API);
  const snapshotOk = confirmedSnapshot !== undefined && confirmedSnapshot !== null && confirmedSnapshot.stage?.stageKey === "acceptance" && confirmedSnapshot.tasks?.total >= 2 && Array.isArray(confirmedSnapshot.files?.items) && confirmedSnapshot.reports?.total >= 1 && confirmedSnapshot.issues?.total >= 1 && confirmedSnapshot.issues?.byState?.open >= 1 && confirmedSnapshot.issues?.byState?.unassigned === undefined;
  check("A4", "确认越过（confirm=true）-> 200：置 archived + 引用式清单落库（缺项随 acknowledgedMissing 留痕；问题三态快照）", "200 projectId/archivedBy 对齐 + status=archived + archivedAt 非空 + snapshot 齐全 + ack 含 task_not_done", confirmed.status + " " + short({ id: confirmed.body?.id, projectId: confirmed.body?.projectId, archivedBy: confirmed.body?.archivedBy, ack: ackCodes, tasks: confirmedSnapshot?.tasks?.total, files: confirmedSnapshot?.files?.total, reports: confirmedSnapshot?.reports?.total, issues: confirmedSnapshot?.issues?.total, issueStates: confirmedSnapshot?.issues?.byState, projectStatus: afterConfirm.body?.status }, 320), confirmed.status === 200 && confirmed.body?.projectId === cleanup.projectId && typeof confirmed.body?.id === "string" && confirmed.body?.archivedBy === adminId && typeof confirmed.body?.archivedAt === "string" && ackCodes.indexOf("task_not_done") >= 0 && snapshotOk && afterConfirm.status === 200 && afterConfirm.body?.status === "archived" && afterConfirm.body?.archivedAt !== null);

  const archiveRead = await call("GET", API + "/archive");
  check("A5", "归档清单读面：GET /archive 200（与写面同形；未归档项目 404 见单测）", "200 同 id / 同 projectId / 同任务数", archiveRead.status + " " + short({ id: archiveRead.body?.id, tasks: archiveRead.body?.snapshot?.tasks?.total }, 140), archiveRead.status === 200 && archiveRead.body?.id === confirmed.body?.id && archiveRead.body?.projectId === cleanup.projectId && archiveRead.body?.snapshot?.tasks?.total === confirmedSnapshot?.tasks?.total);

  const afterConfirmVersion = afterConfirm.body?.version;
  const patchArchived = await call("PATCH", API, { version: afterConfirmVersion, status: "archived" });
  check("A6", "契约收紧反证：PATCH 项目不再接受 status=archived（归档只能走归档端点）", "400 VALIDATION_FAILED", patchArchived.status + " " + (patchArchived.body?.code ?? "-"), patchArchived.status === 400 && patchArchived.body?.code === "VALIDATION_FAILED");

  const archivedYear = Number(today.slice(0, 4));
  const searchArchived = await call("GET", "/api/v1/projects?q=" + encodeURIComponent(created.body.code) + "&filter[archivedYear]=" + archivedYear);
  const searchIds = (searchArchived.body?.items ?? []).map((item) => item.id);
  const searchWrongYear = await call("GET", "/api/v1/projects?q=" + encodeURIComponent(created.body.code) + "&filter[archivedYear]=" + (archivedYear - 1));
  const wrongIds = (searchWrongYear.body?.items ?? []).map((item) => item.id);
  check("A7", "归档检索：filter[archivedYear]=" + archivedYear + " 命中（当年归档）；错年不命中", "200 含该项目 / 错年不含", searchArchived.status + " " + short({ hit: searchIds.indexOf(cleanup.projectId) >= 0, wrong: wrongIds.indexOf(cleanup.projectId) >= 0 }, 140), searchArchived.status === 200 && searchIds.indexOf(cleanup.projectId) >= 0 && searchWrongYear.status === 200 && wrongIds.indexOf(cleanup.projectId) === -1);

  // ---------- 证据八：归档写保护（ADR-027）+ 归档后工作台剔除（W7）—— 项目由证据七归档端点真实置位 ----------
  const archivedReport = await call("POST", API + "/reports", { date: beforeYesterday, doneWork: "归档后补记" });
  const archivedIssueWrite = await call("PATCH", API + "/issues/" + survivingIssueId, { version: assignSurvivor.body?.version, state: "in_progress" });
  const archivedTaskWrite = await call("DELETE", API + "/tasks/" + taskAId);
  const protectedOk = archivedReport.status === 409 && archivedReport.body?.code === "PROJECT_ARCHIVED" && archivedIssueWrite.status === 409 && archivedIssueWrite.body?.code === "PROJECT_ARCHIVED" && archivedTaskWrite.status === 409 && archivedTaskWrite.body?.code === "PROJECT_ARCHIVED";
  check("G4b", "归档写保护（ADR-027）：日报填报 / 问题处理 / 任务删除均 409 PROJECT_ARCHIVED", "409 PROJECT_ARCHIVED x 3", short({ report: archivedReport.status + ":" + (archivedReport.body?.code ?? "-"), issue: archivedIssueWrite.status + ":" + (archivedIssueWrite.body?.code ?? "-"), task: archivedTaskWrite.status + ":" + (archivedTaskWrite.body?.code ?? "-") }, 220), protectedOk === true);

  const workspaceArchived = await call("GET", "/api/v1/workspace");
  const archivedTaskLeak = ["today", "upcoming", "overdue", "unscheduled"].filter((key) => (workspaceArchived.body?.myTasks?.[key] ?? []).some((item) => item.projectId === cleanup.projectId));
  const archivedIssueLeak = ["handling", "raised"].filter((key) => (workspaceArchived.body?.myIssues?.[key] ?? []).some((item) => item.projectId === cleanup.projectId));
  check("W7", "工作台 × 归档（ADR-027）：归档项目整项目剔除（任务四组 / 问题两栏零残留）", "200 / 该项目条目零残留", workspaceArchived.status + " " + short({ tasks: archivedTaskLeak, issues: archivedIssueLeak }, 160), workspaceArchived.status === 200 && archivedTaskLeak.length === 0 && archivedIssueLeak.length === 0);
} catch (error) {
  failures += 1;
  report.push("| FAIL | 中断：" + (error instanceof Error ? error.message : String(error)) + " |");
  process.stderr.write("M6 回放失败：" + (error instanceof Error ? error.message : String(error)) + String.fromCharCode(10));
} finally {
  if (db !== undefined) {
    try {
      if (args.keep !== true && cleanup.projectId !== null) {
        await db.query("delete from file_links where object_id in (select id from daily_reports where project_id = $1) or object_id in (select id from issues where project_id = $1) or file_id in (select id from files where project_id = $1)", [cleanup.projectId]);
        await db.query("delete from issue_events where issue_id in (select id from issues where project_id = $1)", [cleanup.projectId]);
        await db.query("delete from issues where project_id = $1", [cleanup.projectId]);
        await db.query("delete from daily_reports where project_id = $1", [cleanup.projectId]);
        await db.query("delete from files where project_id = $1", [cleanup.projectId]);
        await db.query("delete from task_events where task_id in (select id from tasks where project_id = $1)", [cleanup.projectId]);
        await db.query("delete from tasks where project_id = $1", [cleanup.projectId]);
        await db.query("delete from audit_logs where project_id = $1", [cleanup.projectId]);
        await db.query("delete from outbox_events where payload::text like $1", ["%" + cleanup.projectId + "%"]);
        await db.query("delete from node_requirements where node_id in (select id from project_nodes where project_id = $1)", [cleanup.projectId]);
        await db.query("delete from project_nodes where project_id = $1", [cleanup.projectId]);
        await db.query("delete from project_stages where project_id = $1", [cleanup.projectId]);
        await db.query("delete from project_archives where project_id = $1", [cleanup.projectId]);
        await db.query("delete from project_members where project_id = $1", [cleanup.projectId]);
        await db.query("delete from projects where id = $1", [cleanup.projectId]);
      }
      for (const token of cleanup.tokens) {
        await db.query("update sessions set revoked_at = now() where token_hash = $1 and revoked_at is null", [sha256(token)]);
      }
      if (cleanup.syntheticUserId !== null) {
        await db.query("delete from audit_logs where actor_id = $1", [cleanup.syntheticUserId]);
        await db.query("delete from user_roles where user_id = $1", [cleanup.syntheticUserId]);
        await db.query("delete from sessions where user_id = $1", [cleanup.syntheticUserId]);
        await db.query("delete from users where id = $1", [cleanup.syntheticUserId]);
      }
    } catch (error) {
      report.push("| WARN | 收尾未完全成功：" + (error instanceof Error ? error.message : String(error)) + " |");
    }
    await db.end();
  }
}

const commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: serverRoot }).toString().trim();
const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: serverRoot }).toString().trim() !== "";
const lines = [];
lines.push("# M6 / M7 回放证据（S6·report-issue：日报 / 问题 + M6-01 收口 A7-01 / A7-05 + M6-05 · 工作台 A6-01 / A6-03（2026-09-30 复评：四组 / 不限窗口 / 项目经理含我）+ M7-04 归档 C4-02 / C4-03 · Push 215 口径）");
lines.push("");
lines.push("> 卡片：M6-01 ~ M6-03「日报填报 / 同日多条 / 补填 + 问题自动生成 + 问题三态与留痕 + 成对删除」（主责 wmj，评审 lan）｜口径来源：系统功能书 A3-02 / A3-04 / A3-09 / A3-10 / A3-11 / A3-12 / A3-13、A7-01、A7-05、A2-01（删除引用守卫）、A6-01、A6-03、C4-02、C4-03；Push 215 契约修订（草稿写库 / 同日多条 / 处理时限删除 / 附图方案一）。");
lines.push("");
lines.push("| 项 | 值 |");
lines.push("|---|---|");
lines.push("| 回放时间 | " + new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 19).replace("T", " ") + " +08:00 |");
lines.push("| 目标 | " + BASE_URL + " |");
lines.push("| 数据库 | " + DATABASE_URL.replace(/:[^:@/]+@/, ":***") + " |");
lines.push("| 代码版本 | " + commit + (dirty ? "（回放时工作区含本卡未提交改动）" : "") + " |");
lines.push("| 脚本 | server/scripts/m6-replay.mjs |");
lines.push("| 回放项目 | M6RPL-（含 2 个任务 / 6 条日报（含草稿与等同日多条）/ 若干问题与附图链 / 1 名成员；工作台靶子任务随回放建改；归档走真实归档端点 A1 ~ A7）—— 跑完连同归档清单硬删 |");
lines.push("");
lines.push("## 断言明细");
lines.push("");
lines.push(...report);
lines.push("");
lines.push("## 汇总");
lines.push("");
lines.push(failures === 0 ? "- 全部断言通过（" + evidence.steps.filter((step) => step.ok).length + " 项）：日报填报（A3-02 / A3-04 · 同日多条）+ 提交副作用幂等与附图转挂（A3-09）+ A3-08 停用 + 三态与留痕（A3-10 / A3-13）+ 成对删除 + 引用守卫（A2-01）+ 当日汇总与应填未填（A7-01 / A7-05）+ 工作台四组两栏（A6-01 / A6-03 · 2026-09-30 复评口径）+ 归档门禁 / 确认越过 / 清单 / 检索（M7-04 · C4-02 / C4-03）+ 归档写保护。" : "- 有 " + failures + " 项失败，见上方 FAIL 行。");
lines.push("");
lines.push("## 验收对照（M6-01 ~ M6-03 + M6-01 收口 + M6-05（2026-09-30 口径复评）+ M7-04 · Push 215）");
lines.push("");
lines.push("- A3-02 / A3-04（日报填报）= R1 ~ R9：新报（submitted）/ 同日多条（无 409 判重）/ 未来日期 400 / 补填（supplement）/ 草稿写库 + 提交 / 列表日期倒序 / 详情回读（stageKeys / stageNames 同下标、现场附图）/ 未知文件 400。");
lines.push("- A3-08（回写任务进展，Push 215 停用）= T1：提交日报不再改任务 note、不再写 task_events(note_change)。");
lines.push("- A3-09（问题自动生成 · 幂等 · 附图转挂）= I1 ~ I4：source_report_id 唯一兜底幂等；原文 / 多值归类 / 提出人 / 提出日期；问题图从日报侧（kind=issue）转挂到问题侧，日报侧只剩现场图。");
lines.push("- A3-11 / A3-12（归类多值与分派）= I1 / E6 / E7：多值归类（十项、命中任一即入选筛选）；部门名归类落 owner_department，原因类不自动落部门（null = 待分派）。");
lines.push("- A3-10 / A3-13（三态与留痕）= E1 ~ E8：允许回退且每次实际变化写一条 issue_events（created / state_change / solution / assignment）；关闭写 closed_at / closed_by、回退自动清空；描述 / 归类可改走审计不写事件；空更新 400、乐观锁 409。");
lines.push("- 成对删除（Push 215）= G1 / G2：DELETE 日报 = 连带派生问题 + 两侧附图链（cascadedIssueIds）；DELETE 问题（有来源日报）= 连带来源日报及其全部问题（cascadedReportId）。");
lines.push("- A2-01（删除引用守卫，Push 215 口径）= G3 / G4：被问题引用的任务 409（details[].code = issue_ref）；日报一侧 report_ref 随「关联任务改关联阶段」删除；无引用任务可删、重复删除 404。");
lines.push("- A7-01（当日汇总）= S1 / S2：只算已提交条目（草稿不计入正文与人数；同一人多条各计一条）+ 人数合计 / 问题计数 + 阶段名与附图随行 + 工作日信息；缺省日期 = 今天。");
lines.push("- A7-05（应填未填）= S4 ~ S6：名册即应填范围；已提交（submitted / supplement）不进名单、草稿未提交仍计未填；同一人多条取首条已提交；非工作日整列为空（不催报）；未来日期 400。");
lines.push("- M7-04 归档（C4-02 / C4-03 · ADR-027）= A1 ~ A7：验收完成硬前置；缺项首次 422 ARCHIVE_GATE_NOT_PASSED（明细 + 失败留痕 + 不置位）；confirm=true 确认越过 200（置 archived + 引用式清单（问题三态快照）+ 成功留痕）；清单读面 GET /archive；PATCH 不再接受 archived（契约收紧）；filter[archivedYear] 归档检索。");
lines.push("- 归档写保护（ADR-027）= G4b：归档项目上日报填报 / 问题处理 / 任务删除均 409 PROJECT_ARCHIVED（项目由 A4 真实归档端点置位）。");
lines.push("- A6-01（我的任务四组 · 2026-09-30 复评）= W0 ~ W5：任务负责人含我 或 项目项目经理含我（本回放项目 managerIds = admin）+ 未完成、不限完成日期窗口 —— 默认待分配无日期 → unscheduled；指派我 + 昨天 → overdue / 今天 → today / 明天与今天 + 400 天 → upcoming（无窗口上限）；清空负责人 + 无日期仍命中「未排期」（原「待分配不进」反例失效，供 W7 反证）。");
lines.push("- A6-03（我的问题两栏）= W6：我处理（ownerId = 我）与我提出的（reporterId = 我）双命中两边都出现（本回放命中 open 未关闭条目，多值归类随行）。");
lines.push("- 工作台 × 归档（M6-05 + ADR-027）= W7：归档项目整项目剔除 —— 任务四组 / 问题两栏零残留。");
lines.push("- 单测回归（不连库）：server/test/report-issue.test.ts 32 例（日报 20 + 问题 12，含附图替身与成对删除）+ server/test/report-summary.test.ts 14 例 + server/test/task-remove.test.ts 引用守卫 + server/test/workspace.test.ts 9 例，随 npm test 常跑。");
lines.push("- 复跑：cd server && M6_DATABASE_URL=postgresql://libiaolink_migrator@127.0.0.1:55432/libiaolink node scripts/m6-replay.mjs --out ../docs/m6-回放证据(日报与问题+工作台).md");
lines.push("");
lines.push("");

if (args.json !== undefined) writeFileSync(args.json, JSON.stringify(evidence, null, 2) + String.fromCharCode(10), "utf8");
if (args.out !== undefined) writeFileSync(args.out, lines.join(String.fromCharCode(10)), "utf8");
process.stdout.write(lines.join(String.fromCharCode(10)) + String.fromCharCode(10));
process.exit(failures === 0 ? 0 : 1);
