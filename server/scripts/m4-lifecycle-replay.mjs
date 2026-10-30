#!/usr/bin/env node
/**
 * M4-02 真机回放（S7·file 版本 / 定档 / 回溯 / 回收站 + 到期清理 · PR-5）：
 *   证据一（读面）：GET /files/{id} 含当前版本；GET /files/{id}/versions 版本链（只读、不删历史）。
 *   证据二（定档锁版）：POST /files/{id}/finalize → draft → final + finalized_* 成对字段 + 审计（action=complete）+ outbox
 *           file.finalized；并发定档（两个请求持同一 version）第二个 409 VERSION_CONFLICT（M4 出口标准）。
 *   证据三（定档后管控）：定档后对既有文件追加版本 → 409 FILE_STATE_INVALID（version 意图目标须 draft）；
 *           定档后回溯 → 走变更流（M4-04 申请即通过：change_requests + 新版本挂 change_request_id + 状态 changed）。
 *   证据四（Push 130 定案放开：对既有 draft 文件追加版本）：intent=version + fileId → 同一文件行追加 v2；
 *           名称 / 归属与目标现状不一致 → 400（防静默改名 / 改挂接）。
 *   证据五（回溯）：POST /files/{id}/rollback 生成新版本（复制目标版对象到新版本契约键），不删历史；
 *           目标即当前版本 → 400 already_current。
 *   证据六（回收站）：recycle 任意状态可删（记 recycled_from_status，purge_after = +30 天）；restore 回到进入前状态。
 *   证据七（到期清理任务）：worker 定时档把 purge_after 已过期的文件按版本清对象 + 删元数据 + system 留痕。
 *   证据八（彻底删除）：仅管理员（成员 403）；对象与元数据一并清理、留痕；非回收站 → 409。
 *   证据九（权限）：读面项目可见即可（非成员 404 防 IDOR）；生命周期写面 file.upload 成员平权。
 *
 * 前置：真 PG（DATABASE_URL）+ 真对象存储（S3_*，见 deploy/minio/）+ 已起 api（BASE_URL，**须以 GROUP_ACCESS_ENFORCED=true 启动**，
 *      并让管理员账号命中系统管理员来源、成员账号的部门规则看不到本回放项目 —— L11 / L14 的「非成员 404 / 非管理员 403」按部门规则验证）。
 *      本脚本只在本地沙箱 / 联调库跑：
 *      铸两个临时会话（管理员 + 名册成员，跑完撤销）、建 M4L- 回放项目（跑完硬删项目及其文件 / 版本 / 会话 / 审计 / outbox 事件 + 清桶内前缀）。
 * 用法：cd server && M4_DATABASE_URL=postgresql://libiaolink_migrator@127.0.0.1:55432/libiaolink \
 *       node --env-file-if-exists=.env scripts/m4-lifecycle-replay.mjs [--out <报告.md>] [--json <证据.json>] [--keep]
 *      （脚本侧的断言 SQL 与收尾需要迁移器权限：audit_logs 对应用角色只授 SELECT / INSERT，删不动，故 M4_DATABASE_URL 优先于 DATABASE_URL）
 * 退出码：断言全过 = 0，否则 = 1（可当门禁用）。
 */
import { createHash, randomBytes } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "pg";

const serverRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = parseArgs(process.argv.slice(2));
const BASE_URL = args.baseUrl ?? process.env.M4_BASE_URL ?? process.env.BASE_URL ?? "http://127.0.0.1:3011";
const DATABASE_URL = args.databaseUrl ?? process.env.M4_DATABASE_URL ?? process.env.DATABASE_URL ?? "postgresql://libiaolink_migrator@127.0.0.1:55432/libiaolink";
const MI_B = 1024 * 1024;
const DAY_MS = 86_400_000;
const FILE_A_SIZE = 20 * MI_B;
const FILE_B_SIZE = 12 * MI_B;
const report = [];
const evidence = { steps: [] };
let failures = 0;
let db;

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (item === "--out") out.out = argv[++i];
    else if (item === "--json") out.json = argv[++i];
    else if (item === "--base-url") out.baseUrl = argv[++i];
    else if (item === "--database-url") out.databaseUrl = argv[++i];
    else if (item === "--keep") out.keep = true;
  }
  return out;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/** 会话（两个账号各自一套 Cookie + CSRF）。 */
async function makeSession(userId, idToken) {
  const session = { userId, token: "m4l-" + randomBytes(16).toString("hex"), csrf: randomBytes(16).toString("hex") };
  await db.query("insert into sessions (token_hash, user_id, id_token, expires_at) values ($1, $2, $3, now() + interval '2 hours')", [
    sha256(session.token),
    userId,
    idToken,
  ]);
  return session;
}

async function call(method, path, body, session, extraHeaders = {}) {
  const actor = session ?? admin;
  const response = await fetch(BASE_URL + path, {
    method,
    headers: {
      "content-type": "application/json",
      cookie: "ll_sid=" + actor.token + "; ll_csrf=" + actor.csrf,
      "x-csrf-token": actor.csrf,
      ...extraHeaders,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = text === "" ? null : JSON.parse(text);
  } catch {
    parsed = { raw: text.slice(0, 400) };
  }
  return { status: response.status, body: parsed };
}

function check(id, title, expected, actual, ok, note = "") {
  if (!ok) failures += 1;
  report.push((ok ? "| PASS | " : "| FAIL | ") + id + " | " + title + " | ");
  report.push("  - 期望：" + expected);
  report.push("  - 实际：" + actual);
  if (note !== "") report.push("  - 说明：" + note);
  evidence.steps.push({ id, title, expected, actual, ok, note });
  process.stdout.write((ok ? "PASS " : "FAIL ") + id + " " + title + "\n");
  if (!ok) throw new Error("M4-02 回放失败（" + id + "）：" + title);
}

function short(value, max = 320) {
  const text = JSON.stringify(value);
  return text === undefined ? "undefined" : text.length > max ? text.slice(0, max) + "…" : text;
}

/** 浏览器同口径直传：对预签名 URL 原样 PUT，不额外带任何头。 */
async function putPart(url, body) {
  const response = await fetch(url, { method: "PUT", body });
  const payload = Buffer.from(await response.arrayBuffer());
  return { status: response.status, etag: response.headers.get("etag"), text: response.ok ? "" : payload.toString("utf8").slice(0, 300) };
}

let admin;
let member;
let storage;
let rawClient;
let s3Module;
let adminId;
let memberId;
let project;
let projectNode;
let otherProject;
const createUpload = (body, session) => call("POST", "/api/v1/files/uploads", body, session);
const signParts = (fileId, uploadId, partNumbers, session) =>
  call("POST", "/api/v1/files/" + fileId + "/uploads/" + uploadId + "/parts", { partNumbers }, session);
const completeUpload = (fileId, uploadId, contentHash, session) =>
  call("POST", "/api/v1/files/" + fileId + "/uploads/" + uploadId + "/complete", { contentHash }, session);
const fileDetail = (fileId, session) => call("GET", "/api/v1/files/" + fileId, undefined, session);
const fileVersions = (fileId, session) => call("GET", "/api/v1/files/" + fileId + "/versions", undefined, session);
const finalizeFile = (fileId, version, session) => call("POST", "/api/v1/files/" + fileId + "/finalize", { version }, session);
const rollbackFile = (fileId, toVersionId, reason, version, session) =>
  call("POST", "/api/v1/files/" + fileId + "/rollback", { toVersionId, reason, version }, session);
const recycleFile = (fileId, version, reason, session) =>
  call("POST", "/api/v1/files/" + fileId + "/recycle", reason === undefined ? { version } : { version, reason }, session);
const restoreFile = (fileId, version, session) => call("POST", "/api/v1/files/" + fileId + "/restore", { version }, session);
const purgeFile = (fileId, version, reason, session) =>
  call("POST", "/api/v1/files/" + fileId + "/purge", reason === undefined ? { version } : { version, reason }, session);

/** 造分片（除末片外 8 MiB，同上传管道口径）。 */
function makeParts(sizeBytes) {
  const parts = [];
  for (let offset = 0; offset < sizeBytes; offset += 8 * MI_B) {
    parts.push(Buffer.alloc(Math.min(8 * MI_B, sizeBytes - offset), parts.length + 1));
  }
  return parts;
}

/** 完整上传一个新文件（发起 → 分片直传 → 完成），返回 fileId / contentHash / 完成响应。 */
async function uploadNewFile({ projectId, name, sizeBytes, docType, nodeId, session }) {
  const parts = makeParts(sizeBytes);
  const contentHash = sha256(Buffer.concat(parts));
  const init = await createUpload(
    { projectId, name, sizeBytes, contentHash, docType, nodeId, intent: "version" },
    session,
  );
  const fileId = init.body?.file?.id;
  const uploadId = init.body?.upload?.id;
  const signed = await signParts(fileId, uploadId, parts.map((_unused, index) => index + 1), session);
  for (let index = 0; index < parts.length; index += 1) {
    await putPart(signed.body.parts[index].url, parts[index]);
  }
  const completed = await completeUpload(fileId, uploadId, contentHash, session);
  return { init, fileId, uploadId, contentHash, completed, parts };
}

/** 对既有 draft 文件追加一版（Push 130 定案：intent=version + fileId）。 */
async function appendVersion({ projectId, fileId, name, sizeBytes, session }) {
  const parts = makeParts(sizeBytes);
  const contentHash = sha256(Buffer.concat(parts));
  const init = await createUpload({ projectId, name, sizeBytes, contentHash, fileId, intent: "version" }, session);
  const uploadId = init.body?.upload?.id;
  const signed = await signParts(fileId, uploadId, parts.map((_unused, index) => index + 1), session);
  for (let index = 0; index < parts.length; index += 1) {
    await putPart(signed.body.parts[index].url, parts[index]);
  }
  const completed = await completeUpload(fileId, uploadId, contentHash, session);
  return { init, uploadId, contentHash, completed };
}

/** 该键在存储侧的版本与 delete marker（按 Key 精确过滤：Prefix 会带出同前缀的其它键）。 */
async function versionsOfKey(key) {
  const output = await rawClient.send(new s3Module.ListObjectVersionsCommand({ Bucket: storage.bucket, Prefix: key }));
  return {
    versions: (output.Versions ?? []).filter((item) => item.Key === key),
    markers: (output.DeleteMarkers ?? []).filter((item) => item.Key === key),
  };
}

/** 清桶内前缀下的全部版本（收尾用；版本化桶必须带 VersionId 删）。 */
async function purgePrefix(prefix) {
  let keyMarker;
  let versionIdMarker;
  do {
    const listed = await rawClient.send(
      new s3Module.ListObjectVersionsCommand({ Bucket: storage.bucket, Prefix: prefix, KeyMarker: keyMarker, VersionIdMarker: versionIdMarker }),
    );
    const targets = [
      ...(listed.Versions ?? []).map((item) => ({ Key: item.Key, VersionId: item.VersionId })),
      ...(listed.DeleteMarkers ?? []).map((item) => ({ Key: item.Key, VersionId: item.VersionId })),
    ].filter((item) => item.Key !== undefined && item.Key.startsWith(prefix));
    for (let index = 0; index < targets.length; index += 500) {
      await rawClient.send(new s3Module.DeleteObjectsCommand({ Bucket: storage.bucket, Delete: { Objects: targets.slice(index, index + 500) } }));
    }
    keyMarker = listed.IsTruncated === true ? listed.NextKeyMarker : undefined;
    versionIdMarker = listed.IsTruncated === true ? listed.NextVersionIdMarker : undefined;
  } while (keyMarker !== undefined);
}

/** worker 启动即跑一轮（上传会话过期清理 + 回收站到期清理）；跑到日志出现后收工。 */
async function runWorkerOnce() {
  const child = spawn(process.execPath, ["--env-file-if-exists=.env", "dist/entry/worker.js"], { cwd: serverRoot, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (chunk) => (output += String(chunk)));
  child.stderr.on("data", (chunk) => (output += String(chunk)));
  await new Promise((resolve) => setTimeout(resolve, 6000));
  child.kill();
  await new Promise((resolve) => child.once("exit", resolve));
  return output;
}

const cleanup = { projectIds: [], sessions: [] };
try {
  try {
    const envModule = await import(pathToFileURL(join(serverRoot, "dist", "config", "env.js")).href);
    const storageModule = await import(pathToFileURL(join(serverRoot, "dist", "storage", "index.js")).href);
    s3Module = await import("@aws-sdk/client-s3");
    const env = envModule.loadEnv(process.env);
    storage = storageModule.createS3ObjectStorage(env);
    rawClient = storageModule.createS3Client(env);
  } catch (error) {
    throw new Error("无法加载 dist / S3 环境（先 npm run build，并用 --env-file-if-exists=.env 带上 S3_*）：" + String(error));
  }

  db = new Client({ connectionString: DATABASE_URL });
  await db.connect();

  const health = await fetch(BASE_URL + "/healthz").then((response) => response.status).catch(() => 0);
  if (health !== 200) throw new Error("api 不可用（" + BASE_URL + "/healthz → " + health + "）；先起 api 再跑本脚本");
  const ready = await fetch(BASE_URL + "/readyz").then((response) => response.status).catch(() => 0);
  check("S0", "api 可用（/healthz + /readyz：含存储探针）", "200 / 200", health + " / " + ready, health === 200 && ready === 200);

  const adminRow = await db.query(
    "select u.id from users u join user_roles ur on ur.user_id = u.id join roles r on r.id = ur.role_id where r.code = $1 and u.status = $2 order by u.id limit 1",
    ["admin", "active"],
  );
  adminId = adminRow.rows[0]?.id;
  if (adminId === undefined) throw new Error("找不到可用的管理员账号（roles.code = admin）");
  const otherUsers = await db.query("select id from users where id <> $1 and status = 'active' order by id limit 1", [adminId]);
  memberId = args.actor ?? otherUsers.rows[0]?.id;
  if (memberId === undefined) throw new Error("找不到第二个账号（名册成员基准账号）");
  admin = await makeSession(adminId, "m4l-replay-admin");
  member = await makeSession(memberId, "m4l-replay-member");
  cleanup.sessions.push(admin.token, member.token);

  // 前置守卫：L11 / L14 的「非成员 404 / 非管理员 403」按部门规则验证。
  // 目标 api 须以 GROUP_ACCESS_ENFORCED=true 启动；成员账号不得是系统管理员，并且其适用规则不能覆盖本回放项目。
  const enforceProbe = await call("GET", "/api/v1/permissions/me", undefined, member);
  const enforceProfile = enforceProbe.body?.permissions ?? {};
  check("S0b", "前置：目标 api 处于部门规则执行模式（GROUP_ACCESS_ENFORCED=true）且成员不是系统管理员", "groupAccessEnforced=true / groupAccessAdmin=false", "enforced=" + String(enforceProfile.groupAccessEnforced) + " admin=" + String(enforceProfile.groupAccessAdmin), enforceProbe.status === 200 && enforceProfile.groupAccessEnforced === true && enforceProfile.groupAccessAdmin === false, "请以 GROUP_ACCESS_ENFORCED=true 启动 api，并准备无本回放项目访问范围的成员账号");

  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const created = await call("POST", "/api/v1/projects", {
    code: "M4L-" + stamp,
    name: "m4-02 回放项目（版本 / 定档 / 回溯 / 回收站）",
    projectType: "default",
    managerIds: [adminId],
  });
  check("P1", "建回放项目（为 file 提供 projectId）", "201 + 项目可见", created.status + " " + short({ id: created.body?.id, code: created.body?.code }, 120), created.status === 201);
  project = created.body.id;
  cleanup.projectIds.push(project);

  const createdOther = await call("POST", "/api/v1/projects", {
    code: "M4LB-" + stamp,
    name: "m4-02 回放项目（跨项目反例）",
    projectType: "default",
    managerIds: [adminId],
  });
  check("P2", "建第二个项目（跨项目 fileId 反例用）", "201", createdOther.status, createdOther.status === 201);
  otherProject = createdOther.body.id;
  cleanup.projectIds.push(otherProject);

  const flow = await call("GET", "/api/v1/projects/" + project + "/flow");
  projectNode = (flow.body?.stages ?? []).flatMap((stage) => stage.nodes ?? [])[0]?.id;
  check("P3", "快照节点可见（为文件挂接 nodeId 用）", "节点非空", short({ node: projectNode }, 120), projectNode !== undefined);

  // ---------- 证据一：读面（详情 + 版本链） ----------
  const fileA = await uploadNewFile({
    projectId: project,
    name: "总装图-M4-02.docx",
    sizeBytes: FILE_A_SIZE,
    docType: "CAD图纸",
    nodeId: projectNode,
    session: admin,
  });
  const versionA1 = fileA.completed.body?.version;
  check(
    "L1",
    "先决条件：上传完成建 v1（draft，version=1）",
    "200 + seq=1 + files.version=1 + current_version_id=version.id",
    short({ fileId: fileA.fileId, seq: versionA1?.seq, hash: versionA1?.contentHash === fileA.contentHash }, 180),
    fileA.completed.status === 200 && versionA1?.seq === 1,
  );

  const detailA1 = await fileDetail(fileA.fileId);
  const versionsA1 = await fileVersions(fileA.fileId);
  check(
    "L2",
    "文件详情（含当前版本）与版本链：GET /files/{id} + /files/{id}/versions",
    "200 + currentVersion.seq=1 + 版本链 total=1（按 seq 升序）",
    short(
      {
        detailStatus: detailA1.status,
        status: detailA1.body?.status,
        currentVersionSeq: detailA1.body?.currentVersion?.seq,
        versionCount: versionsA1.body?.total,
        items: (versionsA1.body?.items ?? []).map((item) => item.seq),
      },
      260,
    ),
    detailA1.status === 200 &&
      detailA1.body?.currentVersion?.seq === 1 &&
      detailA1.body?.currentVersionId === versionA1?.id &&
      versionsA1.status === 200 &&
      versionsA1.body?.total === 1 &&
      versionsA1.body?.items?.[0]?.seq === 1,
  );

  // ---------- 证据二：定档（锁版 + 并发 409） ----------
  const finalized = await finalizeFile(fileA.fileId, detailA1.body.version, admin);
  const finalizedRow = await db.query("select status, finalized_at, finalized_by, version, current_version_id from files where id = $1", [fileA.fileId]);
  const finalizeAudit = await db.query(
    "select action, object_type, object_id, changes, metadata from audit_logs where object_type = 'file' and object_id = $1 and action = 'complete' order by id desc limit 1",
    [fileA.fileId],
  );
  const finalizeEvent = await db.query("select topic, dedupe_key, status from outbox_events where payload->>'fileId' = $1 order by id desc limit 1", [fileA.fileId]);
  check(
    "L3",
    "定档锁版：draft → final + finalized_at/by 成对 + 审计（action=complete）+ outbox file.finalized",
    "200 + status=final + 成对字段 + 审计 1 条 + outbox file.finalized",
    short(
      {
        status: finalized.status,
        fileStatus: finalized.body?.status,
        finalizedAt: finalized.body?.finalizedAt,
        finalizedBy: finalized.body?.finalizedBy === adminId,
        version: finalized.body?.version,
        dbStatus: finalizedRow.rows[0]?.status,
        pair: finalizedRow.rows[0]?.finalized_at !== null && finalizedRow.rows[0]?.finalized_by !== null,
        auditAction: finalizeAudit.rows[0]?.action,
        changes: finalizeAudit.rows[0]?.changes,
        topic: finalizeEvent.rows[0]?.topic,
      },
      420,
    ),
    finalized.status === 200 &&
      finalized.body?.status === "final" &&
      finalized.body?.finalizedAt !== null &&
      finalized.body?.finalizedBy === adminId &&
      finalizedRow.rows[0]?.status === "final" &&
      finalizedRow.rows[0]?.finalized_at !== null &&
      finalizedRow.rows[0]?.finalized_by === adminId &&
      finalizeAudit.rowCount === 1 &&
      finalizeAudit.rows[0]?.changes?.some((entry) => entry.field === "status" && entry.to === "final") === true &&
      finalizeEvent.rows[0]?.topic === "file.finalized" &&
      finalizeEvent.rows[0]?.dedupe_key === "file.finalized:" + fileA.fileId + ":2",
  );
  // ---------- 证据三：定档后管控（追加版本 409 / 回溯走变更流 400） ----------
  const appendRejected = await createUpload(
    { projectId: project, name: "总装图-M4-02.docx", sizeBytes: MI_B, fileId: fileA.fileId, intent: "version" },
    admin,
  );
  check(
    "L4",
    "定档后对既有文件追加版本 → 409 FILE_STATE_INVALID（version 意图目标须 draft；定档后走变更 M4-04）",
    "409 FILE_STATE_INVALID",
    appendRejected.status + " " + String(appendRejected.body?.code),
    appendRejected.status === 409 && appendRejected.body?.code === "FILE_STATE_INVALID",
    "上传入口在会话未建立前即拒绝：不留半截会话",
  );

  // 定档后回溯 = 变更：前置要「同一文件两版再定档」（回退目标版 ≠ 当前版）。
  const fileD = await uploadNewFile({
    projectId: project,
    name: "变更回溯-M4-04.docx",
    sizeBytes: FILE_B_SIZE,
    docType: "CAD图纸",
    nodeId: projectNode,
    session: admin,
  });
  const versionD1 = fileD.completed.body?.version;
  await appendVersion({ projectId: project, fileId: fileD.fileId, name: "变更回溯-M4-04.docx", sizeBytes: MI_B, session: admin });
  const detailD = await fileDetail(fileD.fileId);
  const finalizedD = await finalizeFile(fileD.fileId, detailD.body?.version, admin);
  const rollbackFinalized = await rollbackFile(fileD.fileId, versionD1.id, "定档后回退", finalizedD.body?.version, admin);
  const rollbackChange = rollbackFinalized.body?.changeRequest;
  const rollbackChangeRow = await db.query("select id, status, reason from change_requests where id = $1", [rollbackChange?.id]);
  const rollbackVersionRow = await db.query("select change_request_id from file_versions where file_id = $1 order by seq desc limit 1", [fileD.fileId]);
  check(
    "L5",
    "定档后回溯 = 变更（M4-04 申请即通过）：200 + changeRequest 非空 + 新版本挂 change_request_id + 状态 final → changed",
    "200 + changeRequest.status=applied + 版本 change_request_id 一致 + files.status=changed",
    rollbackFinalized.status +
      " " +
      short({ changeRequest: rollbackChange, versionRow: rollbackVersionRow.rows[0], changeRow: rollbackChangeRow.rows[0] }, 300),
    rollbackFinalized.status === 200 &&
      rollbackChange?.status === "applied" &&
      rollbackChange?.reason === "定档后回退" &&
      rollbackChangeRow.rows[0]?.status === "applied" &&
      rollbackVersionRow.rows[0]?.change_request_id === rollbackChange.id &&
      rollbackFinalized.body?.file?.status === "changed",
  );

  // ---------- 证据四：对既有 draft 文件追加版本（Push 130 定案放开） ----------
  const fileB = await uploadNewFile({
    projectId: project,
    name: "施工方案-M4-02.docx",
    sizeBytes: FILE_B_SIZE,
    docType: "评审单",
    nodeId: projectNode,
    session: admin,
  });
  const versionB1 = fileB.completed.body?.version;
  const appended = await appendVersion({ projectId: project, fileId: fileB.fileId, name: "施工方案-M4-02.docx", sizeBytes: FILE_B_SIZE + MI_B, session: admin });
  const versionB2 = appended.completed.body?.version;
  const rowB = await db.query("select status, version, current_version_id from files where id = $1", [fileB.fileId]);
  const versionsB = await fileVersions(fileB.fileId);
  const appendAudit = await db.query(
    "select action, metadata from audit_logs where object_type = 'file' and object_id = $1 and action = 'update' and metadata->>'targetFileId' = $2 order by id desc limit 1",
    [fileB.fileId, fileB.fileId],
  );
  check(
    "L6",
    "draft 追加版本：intent=version + fileId → 同一文件行追加 v2（版本链只增，current 指向新版本）",
    "200 + seq=2 + 版本链 total=2 + files.version=2 + 审计 action=update（metadata.targetFileId）",
    short(
      {
        initStatus: appended.init.status,
        sameFile: appended.init.body?.file?.id === fileB.fileId,
        seq: versionB2?.seq,
        total: versionsB.body?.total,
        dbVersion: rowB.rows[0]?.version,
        currentIsB2: rowB.rows[0]?.current_version_id === versionB2?.id,
        auditAction: appendAudit.rows[0]?.action,
        targetFileId: appendAudit.rows[0]?.metadata?.targetFileId,
      },
      340,
    ),
    appended.init.status === 201 &&
      appended.init.body?.file?.id === fileB.fileId &&
      versionB2?.seq === 2 &&
      versionsB.body?.total === 2 &&
      rowB.rows[0]?.version === 2 &&
      rowB.rows[0]?.current_version_id === versionB2?.id &&
      appendAudit.rows[0]?.action === "update" &&
      appendAudit.rows[0]?.metadata?.targetFileId === fileB.fileId,
  );

  const nameMismatch = await createUpload(
    { projectId: project, name: "改名.docx", sizeBytes: MI_B, fileId: fileB.fileId, intent: "version" },
    admin,
  );
  const crossProject = await createUpload(
    { projectId: otherProject, name: "施工方案-M4-02.docx", sizeBytes: MI_B, fileId: fileB.fileId, intent: "version" },
    admin,
  );
  check(
    "L7",
    "追加版本反例：名称与目标现状不一致 → 400 name_mismatch；与 projectId 不一致 → 400 invalid_file",
    "400（name_mismatch）/ 400（invalid_file）",
    short({ name: { status: nameMismatch.status, code: nameMismatch.body?.code, detail: nameMismatch.body?.details?.[0]?.code }, cross: { status: crossProject.status, code: crossProject.body?.code, detail: crossProject.body?.details?.[0]?.code } }, 240),
    nameMismatch.status === 400 &&
      nameMismatch.body?.details?.[0]?.code === "name_mismatch" &&
      crossProject.status === 400 &&
      crossProject.body?.details?.[0]?.code === "invalid_file",
  );

  // ---------- 证据五：回溯（生成新版本，不删历史） ----------
  const beforeRollback = await fileDetail(fileB.fileId);
  const rolledBack = await rollbackFile(fileB.fileId, versionB1.id, "现场按初版方案执行", beforeRollback.body?.version, admin);
  const versionB3 = rolledBack.body?.version;
  const newKey = "projects/" + project + "/files/" + fileB.fileId + "/v3/" + fileB.contentHash + ".docx";
  const copiedObject = await versionsOfKey(newKey);
  const versionsAfterRollback = await fileVersions(fileB.fileId);
  const rollbackAudit = await db.query(
    "select action, metadata from audit_logs where object_type = 'file' and object_id = $1 and action = 'rollback' order by id desc limit 1",
    [fileB.fileId],
  );
  check(
    "L8",
    "回溯：复制目标版对象到新版本契约键 + 新版本行（v3）+ current 指向新版本 + 审计 action=rollback（不删历史）",
    "200 + seq=3 + 对象键 …/v3/{hash}.docx 在存储侧存在 + 版本链 total=3 + 审计 rollback（metadata.toVersionId/fromSeq）",
    short(
      {
        status: rolledBack.status,
        seq: versionB3?.seq,
        hashSameAsV1: versionB3?.contentHash === fileB.contentHash,
        storedVersions: copiedObject.versions.length,
        total: versionsAfterRollback.body?.total,
        auditAction: rollbackAudit.rows[0]?.action,
        toVersionId: rollbackAudit.rows[0]?.metadata?.toVersionId === versionB1.id,
        fromSeq: rollbackAudit.rows[0]?.metadata?.fromSeq,
      },
      380,
    ),
    rolledBack.status === 200 &&
      versionB3?.seq === 3 &&
      versionB3?.contentHash === fileB.contentHash &&
      copiedObject.versions.length === 1 &&
      versionsAfterRollback.body?.total === 3 &&
      rollbackAudit.rows[0]?.action === "rollback" &&
      rollbackAudit.rows[0]?.metadata?.toVersionId === versionB1.id &&
      rollbackAudit.rows[0]?.metadata?.fromSeq === 1,
  );

  const alreadyCurrent = await rollbackFile(fileB.fileId, versionB3.id, "重复回溯", rolledBack.body?.file?.version, admin);
  check(
    "L9",
    "回溯反例：目标即当前版本 → 400 already_current（不复制对象）",
    "400 VALIDATION_FAILED（already_current）",
    alreadyCurrent.status + " " + short({ code: alreadyCurrent.body?.code, detail: alreadyCurrent.body?.details?.[0]?.code }, 120),
    alreadyCurrent.status === 400 &&
      alreadyCurrent.body?.code === "VALIDATION_FAILED" &&
      alreadyCurrent.body?.details?.[0]?.code === "already_current",
  );
  // ---------- 证据六：并发定档（乐观锁 409 · M4 出口标准） ----------
  const beforeFinalize = await fileDetail(fileB.fileId);
  const raceResults = await Promise.all([
    finalizeFile(fileB.fileId, beforeFinalize.body?.version, admin),
    finalizeFile(fileB.fileId, beforeFinalize.body?.version, admin),
  ]);
  const raceStatuses = raceResults.map((result) => result.status).sort((left, right) => left - right);
  const raceRow = await db.query("select status, version from files where id = $1", [fileB.fileId]);
  const raceLoser = raceResults.find((result) => result.status !== 200);
  check(
    "L10",
    "并发定档：两个请求持同一 version → 恰好一个 200 / 一个 409 VERSION_CONFLICT（乐观锁，不产生双写）",
    "[200, 409] + files.status=final + 版本只递增 1",
    short({ statuses: raceStatuses, loserCode: raceLoser?.body?.code, dbStatus: raceRow.rows[0]?.status, dbVersion: raceRow.rows[0]?.version }, 200),
    raceStatuses[0] === 200 &&
      raceStatuses[1] === 409 &&
      raceLoser?.body?.code === "VERSION_CONFLICT" &&
      raceRow.rows[0]?.status === "final" &&
      raceRow.rows[0]?.version === beforeFinalize.body?.version + 1,
  );

  // ---------- 权限：读面项目可见即可（非成员 404 防 IDOR） ----------
  const memberReadDenied = await fileDetail(fileB.fileId, member);
  const roster = await call("POST", "/api/v1/projects/" + project + "/members", { userId: memberId, roleInProject: "project_member" });
  const memberReadAllowed = await fileDetail(fileB.fileId, member);
  check(
    "L11",
    "读面权限：非成员 404（防 IDOR）→ 入名册后 200（成员平权读）",
    "404 NOT_FOUND / 200",
    memberReadDenied.status + " " + String(memberReadDenied.body?.code) + " / " + memberReadAllowed.status,
    memberReadDenied.status === 404 && memberReadDenied.body?.code === "NOT_FOUND" && memberReadAllowed.status === 200,
    "名册写入返回 " + roster.status,
  );

  // ---------- 证据七：回收站（回收 → 恢复） ----------
  const recycled = await recycleFile(fileB.fileId, raceRow.rows[0]?.version, "现场作废待恢复", admin);
  const recycledRow = await db.query("select status, recycled_at, recycled_by, recycled_from_status, purge_after from files where id = $1", [fileB.fileId]);
  const purgeAfter = recycledRow.rows[0]?.purge_after === null ? null : new Date(recycledRow.rows[0].purge_after);
  const recycleAudit = await db.query(
    "select action, metadata from audit_logs where object_type = 'file' and object_id = $1 and action = 'delete' order by id desc limit 1",
    [fileB.fileId],
  );
  check(
    "L12",
    "移入回收站：任意状态可删 + recycled 三列成对 + purge_after = 30 天 + 审计（reason/purgeAfter）",
    "200 + status=recycled + recycledFromStatus=final + purge_after ≈ now+30d + 审计 action=delete",
    short(
      {
        status: recycled.status,
        fileStatus: recycled.body?.status,
        fromStatus: recycled.body?.recycledFromStatus,
        dbPair: recycledRow.rows[0]?.recycled_at !== null && recycledRow.rows[0]?.recycled_by !== null && recycledRow.rows[0]?.recycled_from_status === "final",
        days: purgeAfter === null ? null : Math.round((purgeAfter.getTime() - Date.now()) / DAY_MS),
        auditReason: recycleAudit.rows[0]?.metadata?.reason,
        retainedDays: recycleAudit.rows[0]?.metadata?.retainedDays,
      },
      320,
    ),
    recycled.status === 200 &&
      recycled.body?.status === "recycled" &&
      recycled.body?.recycledFromStatus === "final" &&
      recycledRow.rows[0]?.status === "recycled" &&
      recycledRow.rows[0]?.recycled_at !== null &&
      recycledRow.rows[0]?.recycled_by === adminId &&
      recycledRow.rows[0]?.recycled_from_status === "final" &&
      purgeAfter !== null &&
      purgeAfter.getTime() - Date.now() > 29 * DAY_MS &&
      purgeAfter.getTime() - Date.now() < 31 * DAY_MS &&
      recycleAudit.rows[0]?.action === "delete" &&
      recycleAudit.rows[0]?.metadata?.reason === "现场作废待恢复" &&
      recycleAudit.rows[0]?.metadata?.retainedDays === 30,
  );

  const restored = await restoreFile(fileB.fileId, recycled.body?.version, admin);
  const restoredRow = await db.query("select status, recycled_at, recycled_by, recycled_from_status, purge_after from files where id = $1", [fileB.fileId]);
  check(
    "L13",
    "回收站恢复：回到进入前状态（final）+ 清空回收站三列与 purge_after",
    "200 + status=final + 三列与 purge_after 全空",
    short(
      {
        status: restored.status,
        fileStatus: restored.body?.status,
        recycledAt: restored.body?.recycledAt,
        recycledBy: restored.body?.recycledBy,
        fromStatus: restored.body?.recycledFromStatus,
        dbAllNull:
          restoredRow.rows[0]?.recycled_at === null &&
          restoredRow.rows[0]?.recycled_by === null &&
          restoredRow.rows[0]?.recycled_from_status === null &&
          restoredRow.rows[0]?.purge_after === null,
      },
      300,
    ),
    restored.status === 200 &&
      restored.body?.status === "final" &&
      restored.body?.recycledAt === null &&
      restored.body?.recycledBy === null &&
      restored.body?.recycledFromStatus === null &&
      restoredRow.rows[0]?.status === "final" &&
      restoredRow.rows[0]?.recycled_at === null &&
      restoredRow.rows[0]?.recycled_by === null &&
      restoredRow.rows[0]?.recycled_from_status === null &&
      restoredRow.rows[0]?.purge_after === null,
  );
  // ---------- 证据八：彻底删除（仅管理员；对象与元数据一并清理） ----------
  const recycledAgain = await recycleFile(fileB.fileId, restored.body?.version, "二次回收后彻底删除", admin);
  const versionsBeforePurge = await db.query("select object_key from file_versions where file_id = $1 order by seq", [fileB.fileId]);
  const memberPurge = await purgeFile(fileB.fileId, recycledAgain.body?.version, "成员越权尝试", member);
  const notRecycledPurge = await purgeFile(fileA.fileId, finalized.body?.version, "未回收尝试", admin);
  check(
    "L14",
    "彻底删除反例：非管理员 → 403 FORBIDDEN（项目可见 + file.upload 也不放行）；非回收站文件 → 409 FILE_STATE_INVALID",
    "403 FORBIDDEN（成员）/ 409 FILE_STATE_INVALID（未回收）",
    short({ member: { status: memberPurge.status, code: memberPurge.body?.code }, notRecycled: { status: notRecycledPurge.status, code: notRecycledPurge.body?.code } }, 200),
    memberPurge.status === 403 &&
      memberPurge.body?.code === "FORBIDDEN" &&
      notRecycledPurge.status === 409 &&
      notRecycledPurge.body?.code === "FILE_STATE_INVALID",
  );

  const purged = await purgeFile(fileB.fileId, recycledAgain.body?.version, "合规要求彻底删除", admin);
  const purgedFilesRow = await db.query("select count(*)::int as total from files where id = $1", [fileB.fileId]);
  const purgedVersionsRow = await db.query("select count(*)::int as total from file_versions where file_id = $1", [fileB.fileId]);
  const purgeAudit = await db.query(
    "select actor_id, action, metadata from audit_logs where object_type = 'file' and object_id = $1 order by id desc limit 1",
    [fileB.fileId],
  );
  const leftOver = [];
  for (const row of versionsBeforePurge.rows) {
    const remaining = await versionsOfKey(row.object_key);
    if (remaining.versions.length > 0 || remaining.markers.length > 0) leftOver.push(row.object_key);
  }
  check(
    "L15",
    "管理员彻底删除：200 + 文件行 / 版本行 / 全部版本对象一并清 + 审计留痕（deletedVersions / reason）",
    "200 {fileId, purgedAt} + 行与对象清零 + 审计 action=delete（metadata.deletedVersions=3）",
    short(
      {
        status: purged.status,
        fileId: purged.body?.fileId === fileB.fileId,
        purgedAt: purged.body?.purgedAt !== undefined,
        filesLeft: purgedFilesRow.rows[0]?.total,
        versionsLeft: purgedVersionsRow.rows[0]?.total,
        objectKeysLeft: leftOver.length,
        auditDeletedVersions: purgeAudit.rows[0]?.metadata?.deletedVersions,
        auditReason: purgeAudit.rows[0]?.metadata?.reason,
      },
      340,
    ),
    purged.status === 200 &&
      purged.body?.fileId === fileB.fileId &&
      typeof purged.body?.purgedAt === "string" &&
      purgedFilesRow.rows[0]?.total === 0 &&
      purgedVersionsRow.rows[0]?.total === 0 &&
      leftOver.length === 0 &&
      purgeAudit.rows[0]?.actor_id === adminId &&
      purgeAudit.rows[0]?.action === "delete" &&
      purgeAudit.rows[0]?.metadata?.deletedVersions === 3 &&
      purgeAudit.rows[0]?.metadata?.reason === "合规要求彻底删除",
  );

  // ---------- 证据九：回收站到期清理（worker 定时档） ----------
  const recycledExpired = await recycleFile(fileA.fileId, finalized.body?.version, "到期自动清理", admin);
  await db.query("update files set purge_after = now() - interval '1 minute' where id = $1", [fileA.fileId]);
  const fileAKeys = await db.query("select object_key from file_versions where file_id = $1 order by seq", [fileA.fileId]);
  const workerOutput = await runWorkerOnce();
  const expiredRow = await db.query("select count(*)::int as total from files where id = $1", [fileA.fileId]);
  const expiredVersions = await db.query("select count(*)::int as total from file_versions where file_id = $1", [fileA.fileId]);
  const expiredAudit = await db.query(
    "select actor_id, action, metadata from audit_logs where object_type = 'file' and object_id = $1 order by id desc limit 1",
    [fileA.fileId],
  );
  const expiredLeft = [];
  for (const row of fileAKeys.rows) {
    const remaining = await versionsOfKey(row.object_key);
    if (remaining.versions.length > 0 || remaining.markers.length > 0) expiredLeft.push(row.object_key);
  }
  check(
    "L16",
    "到期清理任务：worker 启动即跑一轮 → 过期文件彻底删除（对象按版本清 + 元数据删 + system 留痕 actorId=null）",
    "files/versions 清零 + 对象清零 + 审计 actorId=null（metadata.source=system）+ worker 日志",
    short(
      {
        recycled: recycledExpired.status,
        filesLeft: expiredRow.rows[0]?.total,
        versionsLeft: expiredVersions.rows[0]?.total,
        objectKeysLeft: expiredLeft.length,
        auditActor: expiredAudit.rows[0]?.actor_id,
        auditSource: expiredAudit.rows[0]?.metadata?.source,
        auditDeleted: expiredAudit.rows[0]?.metadata?.deletedVersions,
        workerSweep: /回收站到期清理/.test(workerOutput),
      },
      340,
    ),
    recycledExpired.status === 200 &&
      expiredRow.rows[0]?.total === 0 &&
      expiredVersions.rows[0]?.total === 0 &&
      expiredLeft.length === 0 &&
      expiredAudit.rows[0]?.actor_id === null &&
      expiredAudit.rows[0]?.action === "delete" &&
      expiredAudit.rows[0]?.metadata?.source === "system" &&
      expiredAudit.rows[0]?.metadata?.deletedVersions === 1 &&
      /回收站到期清理/.test(workerOutput),
  );
} catch (error) {
  failures += 1;
  report.push("| FAIL | 中断：" + (error instanceof Error ? error.message : String(error)));
  process.stderr.write("M4-02 回放失败：" + (error instanceof Error ? error.message : String(error)) + "\n");
} finally {
  if (db !== undefined) {
    try {
      if (args.keep !== true) {
        for (const projectId of cleanup.projectIds) {
          await db.query("update files set current_version_id = null where project_id = $1", [projectId]);
          await db.query("delete from upload_sessions where file_id in (select id from files where project_id = $1)", [projectId]);
          await db.query("delete from file_versions where file_id in (select id from files where project_id = $1)", [projectId]);
          await db.query("delete from change_requests where project_id = $1", [projectId]);
          await db.query("delete from audit_logs where project_id = $1", [projectId]);
          await db.query("delete from outbox_events where payload::text like $$%$$ || $1::text || $$%$$", [projectId]);
          await db.query("delete from files where project_id = $1", [projectId]);
          await db.query("delete from node_requirements where node_id in (select id from project_nodes where project_id = $1)", [projectId]);
          await db.query("delete from project_nodes where project_id = $1", [projectId]);
          await db.query("delete from project_stages where project_id = $1", [projectId]);
          await db.query("delete from project_members where project_id = $1", [projectId]);
          await db.query("delete from projects where id = $1", [projectId]);
        }
        if (storage !== undefined) {
          for (const projectId of cleanup.projectIds) {
            await purgePrefix("projects/" + projectId + "/").catch(() => undefined);
          }
        }
      }
      for (const token of cleanup.sessions) {
        await db.query("update sessions set revoked_at = now() where token_hash = $1 and revoked_at is null", [sha256(token)]);
      }
    } catch (error) {
      report.push("| WARN | 收尾未完全成功：" + (error instanceof Error ? error.message : String(error)));
    }
    await db.end();
  }
}
const commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: serverRoot }).toString().trim();
const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: serverRoot }).toString().trim() !== "";
const lines = [];
lines.push("# M4-02 回放证据（S7·file 版本 / 定档 / 回溯 / 回收站 + 到期清理任务）");
lines.push("");
lines.push("> 卡片：M4-02「版本 / 定档 / 回溯 / 回收站 + 到期清理任务」（主责 lan，评审 wmj）｜口径来源：系统功能书 A2-10（未定档可直接替换）/ A4-05（定档后不可覆盖）/ A4-12（回收站 30 天）/ A4-13（变更）｜技术设计v0.3 §3.5（文件生命周期）/ §4.8（错误码）；契约 shared/src/modules/files.ts + Push 130 定案（上传入口 fileId 分派）。");
lines.push("> 落点说明：`docs/` 属 px 线；本文件由 lan 随 M4-02 卡片代记（回放脚本与断言同 PR，请 px 复核）。");
lines.push("");
lines.push("| 项 | 值 |");
lines.push("|---|---|");
lines.push("| 回放时间 | " + new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 19).replace("T", " ") + " +08:00 |");
lines.push("| 目标 | " + BASE_URL + " |");
lines.push("| 数据库 | " + DATABASE_URL.replace(/:[^:@/]+@/, ":***@") + " |");
lines.push("| 对象存储 | " + (storage === undefined ? "-" : storage.bucket) + "（本地 MinIO 沙箱：仅沙箱、不代表生产选型） |");
lines.push("| 代码版本 | " + commit + (dirty ? "（回放时工作区含本卡未提交改动）" : "") + " |");
lines.push("| 执行账号 | 管理员（含 file.upload 与系统管理员）+ 名册成员（成员平权 / 越权反例） |");
lines.push("| 脚本 | server/scripts/m4-lifecycle-replay.mjs |");
lines.push("");
lines.push("## 断言明细");
lines.push("");
lines.push(...report);
lines.push("");
lines.push("## 汇总");
lines.push("");
lines.push(failures === 0 ? "- ✅ 全部断言通过（" + evidence.steps.filter((step) => step.ok).length + " 项）：读面 / 定档与并发 409 / 定档后管控 / draft 追加版本 / 回溯 / 回收与恢复 / 到期清理 / 彻底删除 / 权限。" : "- ❌ 有 " + failures + " 项失败，见上方 FAIL 行。");
lines.push("");
lines.push("## 验收对照（M4-02）");
lines.push("");
lines.push("- 读面 = L2 / L11：`GET /files/{id}`（含当前版本）与 `GET /files/{id}/versions`（版本链，按 seq 升序）；读面项目可见即可，非成员 404。");
lines.push("- 定档锁版 = L3：draft → final，`finalized_at/by` 成对落库，审计 action=complete + outbox `file.finalized`。");
lines.push("- 并发定档 409（M4 出口标准）= L10：两个请求持同一 version，恰好一个成功、一个 409 VERSION_CONFLICT。");
lines.push("- 定档后管控 = L4 / L5：对已定档文件追加版本 409 FILE_STATE_INVALID；定档后回溯 = 变更（M4-04 申请即通过：change_requests + 新版本挂 change_request_id + 状态 changed）。");
lines.push("- draft 追加版本（Push 130 定案放开）= L6 / L7：`intent=version + fileId` 同一文件行追加 v2；名称 / 跨项目不一致 400。");
lines.push("- 回溯 = L8 / L9：复制目标版对象到新版本契约键、生成新版本（不删历史）；目标即当前版本 400 already_current。");
lines.push("- 回收站 = L12 / L13：任意状态可删（记 `recycled_from_status`、`purge_after = +30 天`）；恢复回到进入前状态。");
lines.push("- 到期清理任务 = L16：worker 启动即跑一轮 —— 过期文件按版本清对象 + 删元数据 + system 留痕（actorId=null）。");
lines.push("- 彻底删除 = L14 / L15：仅系统管理员（成员 403）；非回收站 409；对象与元数据一并清、留痕（deletedVersions）。");
lines.push("- 单测回归（不连库）：server/test/file-service.test.ts（55 例）随 npm test 常跑：定档 / 并发 409 / 无版本 400 / 回溯（复制对象 + already_current + 位次竞态）/ 回收与恢复 / 越权 403 / 到期清理与跳过。");
lines.push("");
lines.push("## 与 M4-01 回放的关系");
lines.push("");
lines.push("- 本卡放开了 `intent=version + fileId`（Push 130 定案）→ `scripts/m4-upload-replay.mjs` 的 U22 断言同步切换为「version + fileId 接受 / change + fileId 目标门禁」，避免旧断言把新行为判失败；`docs/m4-01-回放证据(上传管道S7file).md` 的 U22 行同步修订。");
lines.push("- 复跑：cd server && node --env-file-if-exists=.env scripts/m4-lifecycle-replay.mjs --out \"../docs/m4-02-回放证据(版本定档回溯回收站).md\"");
lines.push("");

if (args.json !== undefined) writeFileSync(args.json, JSON.stringify(evidence, null, 2) + "\n", "utf8");
if (args.out !== undefined) writeFileSync(args.out, lines.join("\n"), "utf8");
process.stdout.write(lines.join("\n") + "\n");
process.exit(failures === 0 ? 0 : 1);