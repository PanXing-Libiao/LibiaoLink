#!/usr/bin/env node
/**
 * M2-06 真机回放（A1-03 视图 / A1-15 关注 · 首刀）：
 *   证据一（视图 A1-03 · 个人 / 公共）：建 / 读（个人在前排序 + scope 过滤）/ 局部改（空更新 400）/
 *           默认视图互斥（每人至多一条）/ 物理删（重复删 404）；归属：个人视图他人 404、公共视图非创建者 403、公共视图全员可见。
 *   证据二（关注 A1-15）：关注项目 / 任务（重复关注幂等 200 created=false）、清单随行名称与时间倒序、
 *           批量五态（followed / unfollowed / unchanged / failures not_found）、取关（未关注 404）、
 *           不可见目标 404（防 IDOR）、归档项目不可新关注（既有关系行保留可见）、
 *           项目移入回收站 → 关注行保留（可恢复；M7-04 × M2-06 接线，读库断言）。
 * 前置：真 PG（迁移器角色 —— 断言与收尾要跨表读删）+ 真 api。临时会话（跑完撤销）、合成复核用户（跑完删）、
 *       回放项目 × 3（主项目 / 归档项目 / 回收站项目；跑完连同关注行与归档清单硬删）。
 * 用法：cd server && M2_06_DATABASE_URL=postgresql://libiaolink_migrator@127.0.0.1:55432/libiaolink \
 *       node --env-file-if-exists=.env scripts/m2-06-replay.mjs [--out <报告.md>] [--json <证据.json>] [--actor <userId>] [--keep]
 * 退出码：断言全过 = 0，否则 = 1（可当门禁用）。
 */
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

const serverRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = parseArgs(process.argv.slice(2));
const BASE_URL = args.baseUrl ?? process.env.M2_06_BASE_URL ?? process.env.BASE_URL ?? "http://127.0.0.1:3011";
const DATABASE_URL = args.databaseUrl ?? process.env.M2_06_DATABASE_URL ?? process.env.DATABASE_URL ?? "postgresql://libiaolink_migrator@127.0.0.1:55432/libiaolink";
const report = [];
const evidence = { steps: [] };
let failures = 0;
let db;
let admin;
let adminId;
let plain;
let plainId;
const cleanup = { projectIds: [], viewIds: [], tokens: [], syntheticUserIds: [] };

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

async function makeSession(userId, idToken) {
  const session = { userId, token: "m2rpl-" + randomBytes(16).toString("hex"), csrf: randomBytes(16).toString("hex") };
  await db.query("insert into sessions (token_hash, user_id, id_token, expires_at) values ($1, $2, $3, now() + interval '2 hours')", [sha256(session.token), userId, idToken]);
  cleanup.tokens.push(session.token);
  return session;
}

async function call(method, path, body, session = admin, headers = {}) {
  const response = await fetch(BASE_URL + path, {
    method,
    headers: {
      "content-type": "application/json",
      cookie: "ll_sid=" + session.token + "; ll_csrf=" + session.csrf,
      "x-csrf-token": session.csrf,
      ...headers,
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
  if (!ok) throw new Error("M2-06 回放失败（" + id + "）：" + title);
}

function short(value, max = 320) {
  const text = JSON.stringify(value);
  return text === undefined ? "undefined" : text.length > max ? text.slice(0, max) + "..." : text;
}

try {
  db = new Client({ connectionString: DATABASE_URL });
  await db.connect();
  const health = await fetch(BASE_URL + "/healthz").then((response) => response.status).catch(() => 0);
  check("P1", "api 可用（/healthz）", "200", String(health), health === 200, "先起 api 再跑本脚本");

  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const adminRow = await db.query("select u.id, u.display_name from users u join user_roles ur on ur.user_id = u.id join roles r on r.id = ur.role_id where r.code = $1 and u.status = $2 order by u.id limit 1", ["admin", "active"]);
  if (args.actor === undefined && adminRow.rows.length === 0) {
    const adminRole = await db.query("select id from roles where code = 'admin' limit 1");
    if (adminRole.rows.length === 0) throw new Error("roles 表缺少 admin 角色；先在目标库跑 database/scripts/seed.mjs");
    const createdAdmin = await db.query("insert into users (casdoor_id, username, display_name, status) values ($1, $2, $3, 'active') returning id, display_name", ["m2rpl-" + stamp + "-admin", "m2rpl-" + stamp + "-admin", "M2 回放管理员"]);
    await db.query("insert into user_roles (user_id, role_id) values ($1, $2)", [createdAdmin.rows[0].id, adminRole.rows[0].id]);
    cleanup.syntheticUserIds.push(createdAdmin.rows[0].id);
    adminRow.rows.push(createdAdmin.rows[0]);
  }
  adminId = args.actor ?? adminRow.rows[0]?.id;
  const adminName = adminRow.rows[0]?.display_name ?? null;
  check("P2", "管理员账号可用（roles.code = admin；空库自动建合成管理员）", "非空 userId", short({ id: adminId ?? null, name: adminName }, 120), adminId !== undefined);
  admin = await makeSession(adminId, "m2-06-replay");
  const probe = await call("GET", "/api/v1/projects?limit=1");
  check("P3", "临时会话可用（GET /api/v1/projects）", "200", probe.status + " " + short(probe.body?.total ?? probe.body?.code ?? null, 80), probe.status === 200);

  const createdA = await call("POST", "/api/v1/projects", { code: "M2RPL-" + stamp, name: "M2 回放项目（视图与关注）", projectType: "default", managerIds: [adminId] });
  const projectA = createdA.body?.id ?? null;
  cleanup.projectIds.push(projectA);
  check("P4", "建主回放项目（M2RPL-）", "201", createdA.status + " " + short({ id: projectA, code: createdA.body?.code }, 160), createdA.status === 201 && projectA !== null);

  const taskA1 = await call("POST", "/api/v1/projects/" + projectA + "/tasks", { title: "M2RPL-装配任务一" });
  const taskA2 = await call("POST", "/api/v1/projects/" + projectA + "/tasks", { title: "M2RPL-装配任务二" });
  check("P5", "建 2 个任务（关注靶子一 / 二）", "201 x 2", short({ a: taskA1.body?.id ?? null, b: taskA2.body?.id ?? null }, 200), taskA1.status === 201 && taskA2.status === 201);

  const plainRow = await db.query("insert into users (casdoor_id, username, display_name, status) values ($1, $2, $3, 'active') returning id", ["m2rpl-" + stamp + "-plain", "m2rpl-" + stamp + "-plain", "M2 回放复核用户"]);
  plainId = plainRow.rows[0].id;
  cleanup.syntheticUserIds.push(plainId);
  plain = await makeSession(plainId, "m2-06-replay-plain");
  const plainProjects = await call("GET", "/api/v1/projects?limit=1", undefined, plain);
  const groupAccessRestricted = plainProjects.status === 200 && plainProjects.body?.total === 0;
  check("P6", "合成复核用户（无部门规则）：会话可用 + 部门规则状态探测", "200（并记录访问状态，供 F7 分派）", plainProjects.status + " total=" + (plainProjects.body?.total ?? "-"), plainProjects.status === 200);

  // ---------- 证据一：视图（A1-03 · 个人 / 公共） ----------
  const viewOne = await call("POST", "/api/v1/views", {
    name: "M2RPL-安装视图",
    scope: "personal",
    filters: { stageKey: "install", keyword: "工装" },
    columns: ["title", "ownerIds"],
    sort: { key: "plannedEnd", order: "asc" },
    grouping: { key: "stage" },
    isDefault: true,
  });
  const viewOneId = viewOne.body?.id ?? null;
  if (viewOneId !== null) cleanup.viewIds.push(viewOneId);
  const viewOneOk = viewOne.status === 201 && viewOne.body?.scope === "personal" && viewOne.body?.ownerId === adminId && viewOne.body?.ownerName === adminName && viewOne.body?.isDefault === true && viewOne.body?.filters?.stageKey === "install" && viewOne.body?.columns?.[1] === "ownerIds" && viewOne.body?.sort?.order === "asc" && viewOne.body?.grouping?.key === "stage";
  check("V1", "建个人视图（筛选 + 列 + 排序 + 分组 + 默认位）→ 201 全字段回读", "201 / 字段一致 / ownerName=管理员姓名", viewOne.status + " " + short({ id: viewOneId, scope: viewOne.body?.scope, ownerName: viewOne.body?.ownerName, filters: viewOne.body?.filters, columns: viewOne.body?.columns, sort: viewOne.body?.sort, grouping: viewOne.body?.grouping, isDefault: viewOne.body?.isDefault }, 260), viewOneOk === true);

  const viewPublic = await call("POST", "/api/v1/views", { name: "M2RPL-公共视图", scope: "public" });
  const viewPublicId = viewPublic.body?.id ?? null;
  if (viewPublicId !== null) cleanup.viewIds.push(viewPublicId);
  const viewPublicOk = viewPublic.status === 201 && viewPublic.body?.scope === "public" && viewPublic.body?.isDefault === false && short(viewPublic.body?.filters) === "{}" && short(viewPublic.body?.columns) === "[]" && viewPublic.body?.sort === null && viewPublic.body?.grouping === null;
  check("V2", "建公共视图（缺省口径：filters={} / columns=[] / sort=null / grouping=null / isDefault=false）", "201 / 缺省一致", viewPublic.status + " " + short({ scope: viewPublic.body?.scope, filters: viewPublic.body?.filters, columns: viewPublic.body?.columns, sort: viewPublic.body?.sort, grouping: viewPublic.body?.grouping }, 200), viewPublicOk === true);

  const listViews = await call("GET", "/api/v1/views");
  const items = listViews.body?.items ?? [];
  const listOk = listViews.status === 200 && items.length === 2 && items[0]?.id === viewOneId && items[0]?.scope === "personal" && items[1]?.id === viewPublicId;
  check("V3", "视图清单：个人 + 公共（排序个人在前）", "200 / 2 条 / items[0]=个人", listViews.status + " " + short(items.map((item) => ({ id: item.id, scope: item.scope, isDefault: item.isDefault })), 220), listOk === true);

  const listPublic = await call("GET", "/api/v1/views?scope=public");
  const listPersonal = await call("GET", "/api/v1/views?scope=personal");
  check("V4", "scope 过滤：public=仅公共（1 条）/ personal=仅我的个人（1 条）", "200 x 2 / 各 1 条", listPublic.status + "/" + (listPublic.body?.items?.length ?? "-") + " · " + listPersonal.status + "/" + (listPersonal.body?.items?.length ?? "-"), listPublic.status === 200 && listPublic.body?.items?.length === 1 && listPublic.body.items[0].id === viewPublicId && listPersonal.status === 200 && listPersonal.body?.items?.length === 1 && listPersonal.body.items[0].id === viewOneId);

  const viewTwo = await call("POST", "/api/v1/views", { name: "M2RPL-视图二", isDefault: true });
  const viewTwoId = viewTwo.body?.id ?? null;
  if (viewTwoId !== null) cleanup.viewIds.push(viewTwoId);
  const listAfterDefault = await call("GET", "/api/v1/views?scope=personal");
  const defaults = (listAfterDefault.body?.items ?? []).filter((item) => item.isDefault === true);
  check("V5", "默认视图互斥：新建第二个默认后，本人默认只剩 1 条（旧默认被清）", "默认数=1 且为视图二", short(defaults.map((item) => item.id), 160) + " / 视图一 isDefault=" + ((listAfterDefault.body?.items ?? []).find((item) => item.id === viewOneId)?.isDefault ?? "-"), viewTwo.status === 201 && defaults.length === 1 && defaults[0].id === viewTwoId && (listAfterDefault.body?.items ?? []).find((item) => item.id === viewOneId)?.isDefault === false);

  const renamed = await call("PATCH", "/api/v1/views/" + viewOneId, { name: "M2RPL-安装视图 v2" });
  check("V6", "局部更新：只改 name，filters / columns 原样保留", "200 / name 变更 / 其余不变", renamed.status + " " + short({ name: renamed.body?.name, filters: renamed.body?.filters, columns: renamed.body?.columns }, 200), renamed.status === 200 && renamed.body?.name === "M2RPL-安装视图 v2" && renamed.body?.filters?.stageKey === "install" && renamed.body?.columns?.[0] === "title");

  const emptyPatch = await call("PATCH", "/api/v1/views/" + viewOneId, {});
  check("V7", "空更新 400 VALIDATION_FAILED", "400 VALIDATION_FAILED", emptyPatch.status + " " + (emptyPatch.body?.code ?? "-"), emptyPatch.status === 400 && emptyPatch.body?.code === "VALIDATION_FAILED");

  const missingId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
  const patchMissing = await call("PATCH", "/api/v1/views/" + missingId, { name: "不存在" });
  const deleteMissing = await call("DELETE", "/api/v1/views/" + missingId);
  check("V8", "未知视图：PATCH / DELETE 均 404", "404 x 2", patchMissing.status + " / " + deleteMissing.status, patchMissing.status === 404 && deleteMissing.status === 404);

  const plainPatchPersonal = await call("PATCH", "/api/v1/views/" + viewOneId, { name: "越权改名" }, plain);
  const plainPatchPublic = await call("PATCH", "/api/v1/views/" + viewPublicId, { name: "越权改名" }, plain);
  check("V9", "归属：个人视图他人 404（不可见）；公共视图非创建者 403（可见无写权）", "404 / 403", plainPatchPersonal.status + " / " + plainPatchPublic.status, plainPatchPersonal.status === 404 && plainPatchPublic.status === 403 && plainPatchPublic.body?.code === "FORBIDDEN");

  const plainListPublic = await call("GET", "/api/v1/views?scope=public", undefined, plain);
  const plainListAll = await call("GET", "/api/v1/views", undefined, plain);
  check("V10", "公共视图全员可见：复核用户缺省清单 = 仅公共视图 1 条（无个人视图）", "1 条 / 含公共视图", (plainListAll.body?.items?.length ?? "-") + " / " + short((plainListAll.body?.items ?? []).map((item) => item.id), 140), plainListAll.status === 200 && plainListAll.body?.items?.length === 1 && plainListAll.body.items[0].id === viewPublicId && plainListPublic.body?.items?.length === 1);

  const removed = await call("DELETE", "/api/v1/views/" + viewOneId);
  const removedAgain = await call("DELETE", "/api/v1/views/" + viewOneId);
  const listAfterDelete = await call("GET", "/api/v1/views?scope=personal");
  const afterDeleteIds = (listAfterDelete.body?.items ?? []).map((item) => item.id);
  check("V11", "物理删：首次 200 {deleted:true}、删除后清单不含；重复删 404", "200 / 已消失 / 404", removed.status + " " + short(removed.body, 120) + " / " + removedAgain.status, removed.status === 200 && removed.body?.deleted === true && afterDeleteIds.indexOf(viewOneId) === -1 && removedAgain.status === 404);

  // ---------- 证据二：关注（A1-15） ----------
  const followProject = await call("POST", "/api/v1/follows", { objectType: "project", objectId: projectA });
  const followOk = followProject.status === 201 && followProject.body?.created === true && followProject.body?.item?.projectId === projectA && followProject.body?.item?.projectCode === createdA.body?.code && followProject.body?.item?.name === createdA.body?.name;
  check("F1", "关注项目：201 created=true + 随行编号 / 名称", "201 created=true", followProject.status + " " + short(followProject.body?.item, 200), followOk === true);

  const followAgain = await call("POST", "/api/v1/follows", { objectType: "project", objectId: projectA });
  check("F2", "重复关注幂等：200 created=false（不重复落行）", "200 created=false", followAgain.status + " " + short({ created: followAgain.body?.created }, 80), followAgain.status === 200 && followAgain.body?.created === false);

  const followTask = await call("POST", "/api/v1/follows", { objectType: "task", objectId: taskA1.body?.id });
  check("F3", "关注任务：201 + 随行任务标题与所属项目编号", "201 / name=任务标题 / projectCode 一致", followTask.status + " " + short(followTask.body?.item, 200), followTask.status === 201 && followTask.body?.created === true && followTask.body?.item?.objectType === "task" && followTask.body?.item?.projectId === projectA && followTask.body?.item?.name === "M2RPL-装配任务一");

  const listFollows = await call("GET", "/api/v1/follows");
  const followItems = listFollows.body?.items ?? [];
  const followListOk = listFollows.status === 200 && followItems.length === 2 && followItems[0]?.objectType === "task" && followItems[1]?.objectType === "project";
  const followByTask = await call("GET", "/api/v1/follows?objectType=task&objectId=" + taskA1.body?.id);
  check("F4", "清单：2 条时间倒序（任务后关注在前）；objectType+objectId 过滤命中 1 条", "200 / 2 条倒序 / 过滤 1 条", listFollows.status + " " + short(followItems.map((item) => item.objectType + ":" + item.name), 200) + " / 过滤 " + (followByTask.body?.items?.length ?? "-"), followListOk === true && followByTask.status === 200 && followByTask.body?.items?.length === 1 && followByTask.body.items[0].objectId === taskA1.body?.id);

  const batch = await call("POST", "/api/v1/follows/batch", {
    items: [
      { objectType: "task", objectId: taskA2.body?.id, follow: true },
      { objectType: "project", objectId: projectA, follow: true },
      { objectType: "project", objectId: missingId, follow: true },
      { objectType: "task", objectId: taskA1.body?.id, follow: false },
      { objectType: "task", objectId: missingId, follow: false },
    ],
  });
  const batchOk = batch.status === 200 && batch.body?.followed === 1 && batch.body?.unfollowed === 1 && batch.body?.unchanged === 2 && (batch.body?.failures ?? []).length === 1 && batch.body.failures[0].index === 2 && batch.body.failures[0].code === "not_found";
  const followRows = await db.query("select object_type, object_id from follows where object_id = any($1::uuid[]) order by object_type, object_id", [[projectA, taskA1.body?.id, taskA2.body?.id]]);
  check("F5", "批量五态：followed=1 / unfollowed=1 / unchanged=2 / failures=[index 2 not_found]；落库 2 行", "200 计数一致 + 库 2 行", batch.status + " " + short(batch.body, 220) + " / 库 " + followRows.rows.length + " 行", batchOk === true && followRows.rows.length === 2);

  const unfollowTaskA2 = await call("DELETE", "/api/v1/follows/task/" + taskA2.body?.id);
  const unfollowTaskA2Again = await call("DELETE", "/api/v1/follows/task/" + taskA2.body?.id);
  check("F6", "取关：首次 200 {removed:true}；再取关 404", "200 / 404", unfollowTaskA2.status + " / " + unfollowTaskA2Again.status, unfollowTaskA2.status === 200 && unfollowTaskA2.body?.removed === true && unfollowTaskA2Again.status === 404);

  const plainFollow = await call("POST", "/api/v1/follows", { objectType: "project", objectId: projectA }, plain);
  const plainList = await call("GET", "/api/v1/follows", undefined, plain);
  if (groupAccessRestricted) {
    check("F7", "防 IDOR（部门规则开启 · 无适用规则）：不可见项目关注 404；复核用户关注清单 0 条", "404 / 0 条", plainFollow.status + " / " + (plainList.body?.items?.length ?? "-"), plainFollow.status === 404 && plainFollow.body?.code === "NOT_FOUND" && plainList.status === 200 && plainList.body?.items?.length === 0);
  } else {
    const plainUnfollow = await call("DELETE", "/api/v1/follows/project/" + projectA, undefined, plain);
    const plainListAfter = await call("GET", "/api/v1/follows", undefined, plain);
    check("F7", "关注可见性（部门规则关闭）：全员可见 → 关注 201 / 取关 200 / 清单归零", "201 / 200 / 0 条", plainFollow.status + " / " + plainUnfollow.status + " / " + (plainListAfter.body?.items?.length ?? "-"), plainFollow.status === 201 && plainFollow.body?.created === true && plainUnfollow.status === 200 && plainUnfollow.body?.removed === true && plainListAfter.status === 200 && (plainListAfter.body?.items ?? []).length === 0);
  }

  const createdB = await call("POST", "/api/v1/projects", { code: "M2RPL-ARC-" + stamp, name: "M2 回放归档项目", projectType: "default", managerIds: [adminId] });
  const projectB = createdB.body?.id ?? null;
  cleanup.projectIds.push(projectB);
  const taskB1 = await call("POST", "/api/v1/projects/" + projectB + "/tasks", { title: "M2RPL-归档项目任务" });
  const followB = await call("POST", "/api/v1/follows", { objectType: "project", objectId: projectB });
  const followB1 = await call("POST", "/api/v1/follows", { objectType: "task", objectId: taskB1.body?.id });
  check("F8", "归档前：项目 B + 任务 B1 均可关注（201 x 2）", "201 x 2", followB.status + " / " + followB1.status, createdB.status === 201 && followB.status === 201 && followB1.status === 201);

  await db.query("update project_stages set status = $2, advanced_at = now() where project_id = $1 and stage_key = $3", [projectB, "done", "acceptance"]);
  await db.query("update projects set stage_key = $2 where id = $1", [projectB, "acceptance"]);
  const beforeArchiveB = await call("GET", "/api/v1/projects/" + projectB);
  const archiveB = await call("POST", "/api/v1/projects/" + projectB + "/archive", { version: beforeArchiveB.body?.version, confirm: true });
  check("F9", "归档项目 B（真实归档端点：acceptance 造态 + confirm=true 越过缺项）", "200 / status=archived", archiveB.status + " " + short({ status: archiveB.body?.status ?? archiveB.body?.project?.status ?? null }, 120), beforeArchiveB.status === 200 && archiveB.status === 200);

  const followArchivedProject = await call("POST", "/api/v1/follows", { objectType: "project", objectId: projectB });
  const followArchivedTask = await call("POST", "/api/v1/follows", { objectType: "task", objectId: taskB1.body?.id });
  const listAfterArchive = await call("GET", "/api/v1/follows");
  const archivedRows = (listAfterArchive.body?.items ?? []).filter((item) => item.projectId === projectB);
  check("F10", "归档项目不可新关注（项目 / 任务均 404）；既有关系行保留可见（2 条）", "404 x 2 / 清单含 2 条", followArchivedProject.status + " / " + followArchivedTask.status + " / 清单 " + archivedRows.length + " 条", followArchivedProject.status === 404 && followArchivedTask.status === 404 && archivedRows.length === 2);

  const createdC = await call("POST", "/api/v1/projects", { code: "M2RPL-DEL-" + stamp, name: "M2 回放回收站项目", projectType: "default", managerIds: [adminId] });
  const projectC = createdC.body?.id ?? null;
  cleanup.projectIds.push(projectC);
  const taskC1 = await call("POST", "/api/v1/projects/" + projectC + "/tasks", { title: "M2RPL-回收站项目任务" });
  await call("POST", "/api/v1/follows", { objectType: "project", objectId: projectC });
  await call("POST", "/api/v1/follows", { objectType: "task", objectId: taskC1.body?.id });
  const rowsBeforeDelete = await db.query("select count(*)::int as n from follows where object_id = any($1::uuid[])", [[projectC, taskC1.body?.id]]);
  const beforeDeleteC = await call("GET", "/api/v1/projects/" + projectC);
  const deletedC = await call("DELETE", "/api/v1/projects/" + projectC, undefined, admin, { "if-match": String(beforeDeleteC.body?.version) });
  const rowsAfterDelete = await db.query("select count(*)::int as n from follows where object_id = any($1::uuid[])", [[projectC, taskC1.body?.id]]);
  check("F11", "项目移入回收站（M7-04）× 关注保留（M2-06）：删除前 2 行 → 删除后 2 行", "删除 200 / 2 -> 2", deletedC.status + " / " + rowsBeforeDelete.rows[0].n + " -> " + rowsAfterDelete.rows[0].n, rowsBeforeDelete.rows[0].n === 2 && deletedC.status === 200 && rowsAfterDelete.rows[0].n === 2, "DELETE 仅写 projects.deleted_at / deleted_by，关注行保留；收尾由 migrator 硬删回放项目");
} catch (error) {
  failures += 1;
  report.push("| FAIL | 中断：" + (error instanceof Error ? error.message : String(error)) + " |");
  process.stderr.write("M2-06 回放失败：" + (error instanceof Error ? error.message : String(error)) + String.fromCharCode(10));
} finally {
  if (db !== undefined) {
    try {
      if (args.keep !== true) {
        if (cleanup.projectIds.length > 0) {
          const projectIds = cleanup.projectIds.filter((id) => typeof id === "string");
          const taskIdsOfProjects = "(select id from tasks where project_id = any($1::uuid[]))";
          await db.query("delete from follows where object_id = any($1::uuid[])", [projectIds]);
          await db.query("delete from follows where object_type = 'task' and object_id in " + taskIdsOfProjects, [projectIds]);
          await db.query("delete from issue_events where issue_id in (select id from issues where project_id = any($1::uuid[]))", [projectIds]);
          await db.query("delete from task_events where task_id in " + taskIdsOfProjects, [projectIds]);
          await db.query("delete from file_versions where file_id in (select id from files where project_id = any($1::uuid[]))", [projectIds]);
          await db.query("delete from files where project_id = any($1::uuid[])", [projectIds]);
          await db.query("delete from change_requests where project_id = any($1::uuid[])", [projectIds]);
          await db.query("delete from issues where project_id = any($1::uuid[])", [projectIds]);
          await db.query("delete from daily_reports where project_id = any($1::uuid[])", [projectIds]);
          await db.query("delete from tasks where project_id = any($1::uuid[])", [projectIds]);
          await db.query("delete from audit_logs where project_id = any($1::uuid[])", [projectIds]);
          for (const projectId of projectIds) {
            await db.query("delete from outbox_events where payload::text like $1", ["%" + projectId + "%"]);
          }
          await db.query("delete from node_requirements where node_id in (select id from project_nodes where project_id = any($1::uuid[]))", [projectIds]);
          await db.query("delete from project_nodes where project_id = any($1::uuid[])", [projectIds]);
          await db.query("delete from project_stages where project_id = any($1::uuid[])", [projectIds]);
          await db.query("delete from project_archives where project_id = any($1::uuid[])", [projectIds]);
          await db.query("delete from project_members where project_id = any($1::uuid[])", [projectIds]);
          await db.query("delete from project_stakeholders where project_id = any($1::uuid[])", [projectIds]);
          await db.query("delete from projects where id = any($1::uuid[])", [projectIds]);
        }
        if (cleanup.viewIds.length > 0) {
          await db.query("delete from project_views where id = any($1::uuid[])", [cleanup.viewIds.filter((id) => typeof id === "string")]);
        }
      }
      for (const token of cleanup.tokens) {
        await db.query("update sessions set revoked_at = now() where token_hash = $1 and revoked_at is null", [sha256(token)]);
      }
      for (const userId of cleanup.syntheticUserIds) {
        await db.query("delete from audit_logs where actor_id = $1", [userId]);
        await db.query("delete from project_views where owner_id = $1", [userId]);
        await db.query("delete from follows where user_id = $1", [userId]);
        await db.query("delete from user_roles where user_id = $1", [userId]);
        await db.query("delete from sessions where user_id = $1", [userId]);
        await db.query("delete from user_preferences where user_id = $1", [userId]);
        await db.query("delete from users where id = $1", [userId]);
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
lines.push("# M2-06 回放证据（A1-03 保存视图 · 个人 / 公共 + A1-15 关注订阅）");
lines.push("");
lines.push("> 卡片：M2-06「视图（个人 / 公共）/ 关注订阅 / 用户偏好」首刀 —— 视图与关注（偏好随 Push 169 已落地）｜主责 wmj，评审 lan｜口径来源：系统功能书 A1-03 / A1-15；技术设计v0.3-实施与验收.md 行 223。");
lines.push("");
lines.push("| 项 | 值 |");
lines.push("|---|---|");
lines.push("| 回放时间 | " + new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 19).replace("T", " ") + " +08:00 |");
lines.push("| 目标 | " + BASE_URL + " |");
lines.push("| 数据库 | " + DATABASE_URL.replace(/:[^:@/]+@/, ":***@") + " |");
lines.push("| 代码版本 | " + commit + (dirty ? "（回放时工作区含本卡未提交改动）" : "") + " |");
lines.push("| 脚本 | server/scripts/m2-06-replay.mjs |");
lines.push("| 回放项目 | M2RPL-（主）/ M2RPL-ARC-（归档）/ M2RPL-DEL-（回收站）—— 跑完连同视图 / 关注行 / 归档清单硬删 |");
lines.push("");
lines.push("## 断言明细");
lines.push("");
lines.push(...report);
lines.push("");
lines.push("## 汇总");
lines.push("");
lines.push(failures === 0 ? "- 全部断言通过（" + evidence.steps.filter((step) => step.ok).length + " 项）：视图（A1-03 建 / 读 / 改 / 删 + 归属 + 默认互斥）+ 关注（A1-15 幂等 / 清单 / 批量 / 取关 + 可见性（按权限开关分派）+ 归档口径 + 回收站保留）。" : "- 有 " + failures + " 项失败，见上方 FAIL 行。");
lines.push("");
lines.push("## 验收对照（M2-06 · A1-03 / A1-15）");
lines.push("");
lines.push("- A1-03（视图管理）= V1 ' V11：个人视图全字段建 / 读（个人在前 + scope 过滤）/ 局部改（空更新 400）/ 默认视图互斥（每人至多一条）/ 物理删（重复删 404）；归属：个人视图他人 404（不可见）、公共视图非创建者 403（可见无写权）、公共视图全员可见。");
lines.push("- A1-15（关注订阅）= F1 ' F11：关注项目 / 任务（201 created=true；重复关注 200 created=false 幂等）；清单随行名称 + 时间倒序 + object 过滤；批量五态（followed / unfollowed / unchanged / failures）+ 失败 index / code；取关（未关注 404）；关注目标可见性按部门规则状态分派（部门规则开启且无适用规则：不可见目标 404 防 IDOR；部门规则关闭：全员可见 201 + 取关清理）；归档项目不可新关注（既有关系行保留可见 —— 部门规则关闭口径）；项目移入回收站 → 关注行保留（可恢复）；彻底删除路径随项目关系键清理。");
lines.push("- 单测回归（不连库）：server/test/view.test.ts 7 例（范围透传 / 名称收敛 / 空更新 / 归属 / 默认互斥 / 物理删）+ server/test/follow.test.ts 7 例（幂等 / 404 三态 / 清单过滤 / 批量五态 / 归档失败），随 npm test 常跑。");
lines.push("- 差异登记：公共视图「共享给指定角色」（A1-03）未做 —— 一期公共视图 = 全员可见；关注后的关键事件通知随 M5（lan），关注动态流（A6-08）随工作台二刀。");
lines.push("- 复跑：cd server && M2_06_DATABASE_URL=postgresql://libiaolink_migrator@127.0.0.1:55432/libiaolink node scripts/m2-06-replay.mjs --out ../docs/m2-06-回放证据(视图与关注).md");
lines.push("");
lines.push("");

if (args.json !== undefined) writeFileSync(args.json, JSON.stringify(evidence, null, 2) + String.fromCharCode(10), "utf8");
if (args.out !== undefined) writeFileSync(args.out, lines.join(String.fromCharCode(10)), "utf8");
process.stdout.write(lines.join(String.fromCharCode(10)) + String.fromCharCode(10));
process.exit(failures === 0 ? 0 : 1);
