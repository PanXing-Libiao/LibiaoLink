#!/usr/bin/env node
/**
 * M4-01 真机回放（S7·file 上传管道 · PR-4）：
 *   证据一（发起上传）：POST /files/uploads 建 draft 文件 + 上传会话（暂存键 …/staging/{sessionId}），服务端给分片计划
 *           （partSizeBytes / totalParts）与 expiresAt；附件域（无 taskId / nodeId / docType）带 contentHash 命中既有
 *           同内容 → 秒传复用（reused=true、upload=null，不新建文件 / 会话；2026-10-12）。
 *   证据二（分片直传 + 断点续传）：分片预签名 URL 由「浏览器同口径」直接 PUT 到对象存储（api 不代理大文件流量）；
 *           分片状态以对象存储 ListParts 为唯一真相（不落 upload_parts 表）；GET 会话状态回已传 / 缺失分片，只补缺失的。
 *   证据三（完成 = 复制到契约键 + 落版本）：complete 校验分片齐全 → 合并 → HEAD 校大小 → contentHash 一致性
 *           （与 init 声明不一致 422 FILE_HASH_MISMATCH）→ copyObject 到契约键 …/v{seq}/{contentHash}.{ext}
 *           → 事务写 file_versions + files.current_version_id/version + 会话 completed + 审计 + outbox → 按版本清暂存。
 *   证据四（失败面）：缺片 409 UPLOAD_INCOMPLETE（details.missing）/ 大小不符 409 / 哈希不符 422 / 已完成会话 409 /
 *           取消幂等（重复取消 200）；跨项目 nodeId 400；intent=change 缺 fileId 400（契约层）；带 fileId 的 version 请求随 M4-02 放开
 *           （名称 / 归属不一致 400），change + fileId 随 M4-04 放开（目标须定档，未定档 409）。
 *   证据五（过期与清理）：过期会话访问即 410（惰性置 expired + 清暂存 + system 审计）；worker 启动即跑一轮定时清理并留痕。
 *   证据六（权限）：file.upload 项目成员平权（非成员 404 防 IDOR）。
 *
 * 前置：真 PG（DATABASE_URL）+ 真对象存储（S3_*，见 deploy/minio/）+ 已起 api（BASE_URL）；U20 的「非成员 404 → 入名册后 201」需 GROUP_ACCESS_ENFORCED=true，并且成员账号的部门规则为「仅自己的项目」或其它在入名册前不覆盖回放项目的范围。本脚本只在本地沙箱 / 联调库跑：
 *      铸两个临时会话（管理员 + 名册成员，跑完撤销）、建 M4- 回放项目（跑完硬删项目及其文件 / 版本 / 会话 / 审计 / outbox 事件 + 清桶内前缀）。
 * 用法：cd server && M4_DATABASE_URL=postgresql://libiaolink_migrator@127.0.0.1:55432/libiaolink \
 *       node --env-file-if-exists=.env scripts/m4-upload-replay.mjs [--out <报告.md>] [--json <证据.json>] [--keep]
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
const FILE_SIZE = 20 * MI_B;
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
  const session = { userId, token: "m4-" + randomBytes(16).toString("hex"), csrf: randomBytes(16).toString("hex") };
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
  if (!ok) throw new Error("M4 回放失败（" + id + "）：" + title);
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
let projectA;
let projectB;
let projectANode;
let projectBNode;

const createUpload = (body, session) => call("POST", "/api/v1/files/uploads", body, session);
const signParts = (fileId, uploadId, partNumbers, session) =>
  call("POST", "/api/v1/files/" + fileId + "/uploads/" + uploadId + "/parts", { partNumbers }, session);
const sessionStatus = (fileId, uploadId, session) => call("GET", "/api/v1/files/" + fileId + "/uploads/" + uploadId, undefined, session);
const completeUpload = (fileId, uploadId, contentHash, session) =>
  call("POST", "/api/v1/files/" + fileId + "/uploads/" + uploadId + "/complete", { contentHash }, session);
const abortUpload = (fileId, uploadId, session) => call("POST", "/api/v1/files/" + fileId + "/uploads/" + uploadId + "/abort", undefined, session);

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

/** worker 启动即跑一轮上传会话过期清理；跑到日志出现后收工。 */
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
  const adminId = adminRow.rows[0]?.id;
  if (adminId === undefined) throw new Error("找不到可用的管理员账号（roles.code = admin）");
  // 非成员基准账号不得是系统管理员；部门规则应在其入名册前排除本回放项目，以构成「非成员」404 反例。
  const otherUsers = await db.query(
    "select u.id from users u where u.id <> $1 and u.status = 'active' and not exists (select 1 from user_roles ur join roles r on r.id = ur.role_id where ur.user_id = u.id and r.code = 'admin') order by u.id limit 1",
    [adminId],
  );
  const memberId = args.actor ?? otherUsers.rows[0]?.id;
  if (memberId === undefined) throw new Error("找不到第二个账号（名册成员基准账号）");
  admin = await makeSession(adminId, "m4-replay-admin");
  member = await makeSession(memberId, "m4-replay-member");
  cleanup.sessions.push(admin.token, member.token);

  const me = await call("GET", "/api/v1/permissions/me");
  check(
    "S1",
    "管理员会话含 file.upload / file.download（上传入口的功能权限位）",
    "200 + 含 file.upload 与 file.download",
    me.status + " " + short({ userId: me.body?.permissions?.userId, roleCodes: me.body?.permissions?.roleCodes, hasUpload: me.body?.permissions?.permissionKeys?.includes("file.upload"), hasDownload: me.body?.permissions?.permissionKeys?.includes("file.download") }, 200),
    me.status === 200 &&
      me.body?.permissions?.permissionKeys?.includes("file.upload") === true &&
      me.body?.permissions?.permissionKeys?.includes("file.download") === true,
  );
  // ---------- 回放项目（导入即快照） ----------
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const created = await call("POST", "/api/v1/projects", {
    code: "M4-" + stamp,
    name: "m4-01 回放项目（上传管道）",
    projectType: "default",
    managerIds: [adminId],
  });
  check("P1", "建回放项目（导入即快照，为 file 提供 projectId）", "201 + 项目可见", created.status + " " + short({ id: created.body?.id, code: created.body?.code }, 120), created.status === 201);
  projectA = created.body.id;
  cleanup.projectIds.push(projectA);

  const createdB = await call("POST", "/api/v1/projects", {
    code: "M4B-" + stamp,
    name: "m4-01 回放项目（跨项目挂接反例）",
    projectType: "default",
    managerIds: [adminId],
  });
  check("P2", "建第二个项目（跨项目 nodeId 反例用）", "201", createdB.status, createdB.status === 201);
  projectB = createdB.body.id;
  cleanup.projectIds.push(projectB);

  const flowA = await call("GET", "/api/v1/projects/" + projectA + "/flow");
  const flowB = await call("GET", "/api/v1/projects/" + projectB + "/flow");
  projectANode = (flowA.body?.stages ?? []).flatMap((stage) => stage.nodes ?? [])[0]?.id;
  projectBNode = (flowB.body?.stages ?? []).flatMap((stage) => stage.nodes ?? [])[0]?.id;
  check("P3", "快照节点可见（项目 A / B 各取一个节点）", "两个节点非空", short({ nodeA: projectANode, nodeB: projectBNode }, 120), projectANode !== undefined && projectBNode !== undefined);

  // ---------- 证据一：发起上传 ----------
  const parts = [];
  for (let offset = 0; offset < FILE_SIZE; offset += 8 * MI_B) {
    parts.push(Buffer.alloc(Math.min(8 * MI_B, FILE_SIZE - offset), parts.length + 1));
  }
  const contentHash = sha256(Buffer.concat(parts));
  const fileName = "机械设计图纸-v2.docx";

  const t1 = await db.query("select to_regclass('public.upload_parts') as table_name");
  check(
    "T1",
    "分片状态不落表（2026-09-18 评审定案：以 ListParts 为唯一真相）",
    "upload_parts 表不存在（null）",
    String(t1.rows[0]?.table_name),
    t1.rows[0]?.table_name === null,
    "会话元数据落 upload_sessions；分片清单只从对象存储读",
  );

  const init = await createUpload({
    projectId: projectA,
    name: fileName,
    sizeBytes: FILE_SIZE,
    mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    contentHash,
    docType: "CAD图纸",
    nodeId: projectANode,
    intent: "version",
  });
  const fileId = init.body?.file?.id;
  const uploadId = init.body?.upload?.id;
  check(
    "U1",
    "发起上传：建 draft 文件 + 会话（返回分片计划与到期时间）",
    "201 + status=draft + version=0 + intent=version + 8 MiB x 3 片 + duplicateHint=null",
    init.status + " " + short({ fileId, status: init.body?.file?.status, version: init.body?.file?.version, intent: init.body?.upload?.intent, partSizeBytes: init.body?.upload?.partSizeBytes, totalParts: init.body?.upload?.totalParts, duplicateHint: init.body?.duplicateHint }, 240),
    init.status === 201 &&
      init.body?.file?.status === "draft" &&
      init.body?.file?.version === 0 &&
      init.body?.file?.currentVersionId === null &&
      init.body?.upload?.intent === "version" &&
      init.body?.upload?.partSizeBytes === 8 * MI_B &&
      init.body?.upload?.totalParts === 3 &&
      init.body?.duplicateHint === null,
  );

  const sessionRow = await db.query("select * from upload_sessions where id = $1", [uploadId]);
  const fileRow = await db.query("select * from files where id = $1", [fileId]);
  const stagingKey = sessionRow.rows[0]?.object_key;
  const ttlHours = Math.round((new Date(sessionRow.rows[0]?.expires_at).getTime() - new Date(sessionRow.rows[0]?.created_at).getTime()) / 3_600_000);
  const auditCreate = await db.query("select * from audit_logs where object_type = $1 and object_id = $2 and action = $3 order by id desc limit 1", ["file", fileId, "create"]);
  check(
    "U2",
    "落库口径：会话先写暂存键 / 文件 draft version 0 / 发起上传留痕（objectType=file）",
    "object_key = …/staging/{sessionId}、files.status=draft、files.version=0、审计 1 条（metadata.uploadId）",
    short({ objectKey: stagingKey, status: fileRow.rows[0]?.status, version: fileRow.rows[0]?.version, currentVersionId: fileRow.rows[0]?.current_version_id, ttlHours, auditAction: auditCreate.rows[0]?.action, auditUploadId: auditCreate.rows[0]?.metadata?.uploadId }, 300),
    sessionRow.rowCount === 1 &&
      stagingKey === "projects/" + projectA + "/files/" + fileId + "/staging/" + uploadId &&
      sessionRow.rows[0]?.status === "active" &&
      sessionRow.rows[0]?.storage_upload_id === null &&
      fileRow.rows[0]?.status === "draft" &&
      fileRow.rows[0]?.version === 0 &&
      fileRow.rows[0]?.current_version_id === null &&
      ttlHours === 24 &&
      auditCreate.rowCount === 1 &&
      auditCreate.rows[0]?.project_id === projectA &&
      auditCreate.rows[0]?.metadata?.uploadId === uploadId,
  );

  const signed = await signParts(fileId, uploadId, [1, 2, 3]);
  const firstUrl = new URL(signed.body?.parts?.[0]?.url ?? "https://invalid.test/");
  const storageUploadIdRow = await db.query("select storage_upload_id from upload_sessions where id = $1", [uploadId]);
  check(
    "U3",
    "取分片预签名 URL（首次调用登记存储侧 UploadId；URL 指向对象存储、api 不代理流量）",
    "200 + 3 条 URL（含 X-Amz-Signature）+ 落 storage_upload_id",
    signed.status + " " + short({ count: signed.body?.parts?.length, host: firstUrl.host, signature: firstUrl.searchParams.has("X-Amz-Signature"), storageUploadId: storageUploadIdRow.rows[0]?.storage_upload_id !== null }, 220),
    signed.status === 200 &&
      signed.body?.parts?.length === 3 &&
      firstUrl.searchParams.has("X-Amz-Signature") &&
      storageUploadIdRow.rows[0]?.storage_upload_id !== null,
  );

  const put1 = await putPart(signed.body.parts[0].url, parts[0]);
  check("U4", "分片 1 直传（浏览器同口径：裸 PUT 预签名 URL）", "HTTP 200 + ETag", "HTTP " + put1.status + " " + String(put1.etag), put1.status === 200 && put1.etag !== null);

  const status1 = await sessionStatus(fileId, uploadId);
  check(
    "U5",
    "断点续传依据：会话状态回已传 / 缺失分片（ListParts 为唯一真相）",
    "uploaded=[1] missing=[2,3]",
    short({ uploaded: status1.body?.uploadedPartNumbers, missing: status1.body?.missingPartNumbers, status: status1.body?.status }, 160),
    status1.status === 200 && JSON.stringify(status1.body?.uploadedPartNumbers) === "[1]" && JSON.stringify(status1.body?.missingPartNumbers) === "[2,3]",
  );

  const signedMissing = await signParts(fileId, uploadId, status1.body.missingPartNumbers);
  const putMissing = [];
  for (const target of signedMissing.body.parts) {
    putMissing.push(await putPart(target.url, parts[target.partNumber - 1]));
  }
  check("U6", "只补缺失分片（续传不重传已传分片）", "2 条补传均 200 + ETag", short(putMissing.map((item) => item.status), 120), putMissing.length === 2 && putMissing.every((item) => item.status === 200 && item.etag !== null));

  const status2 = await sessionStatus(fileId, uploadId);
  check(
    "U7",
    "补齐后会话状态：已传 3 / 缺失 0",
    "uploaded=[1,2,3] missing=[]",
    short({ uploaded: status2.body?.uploadedPartNumbers, missing: status2.body?.missingPartNumbers }, 140),
    status2.status === 200 && JSON.stringify(status2.body?.uploadedPartNumbers) === "[1,2,3]" && JSON.stringify(status2.body?.missingPartNumbers) === "[]",
  );

  // ---------- 证据三：完成（合并 → 复制契约键 → 落版本） ----------
  const completed = await completeUpload(fileId, uploadId, contentHash);
  const versionId = completed.body?.version?.id;
  check(
    "U8",
    "完成上传：版本 v1 落库、文件 currentVersionId / version 前进",
    "200 + version.seq=1 + sizeBytes=20 MiB + files.version=1 + changeRequest=null",
    completed.status + " " + short({ seq: completed.body?.version?.seq, sizeBytes: completed.body?.version?.sizeBytes, fileVersion: completed.body?.file?.version, currentVersionId: completed.body?.file?.currentVersionId, changeRequest: completed.body?.changeRequest }, 240),
    completed.status === 200 &&
      completed.body?.version?.seq === 1 &&
      completed.body?.version?.sizeBytes === FILE_SIZE &&
      completed.body?.version?.contentHash === contentHash &&
      completed.body?.file?.version === 1 &&
      completed.body?.file?.currentVersionId === versionId &&
      completed.body?.changeRequest === null,
  );

  const versionRow = await db.query("select * from file_versions where file_id = $1", [fileId]);
  const expectObjectKey = "projects/" + projectA + "/files/" + fileId + "/v1/" + contentHash + ".docx";
  const sessionAfter = await db.query("select * from upload_sessions where id = $1", [uploadId]);
  check(
    "U9",
    "契约键口径（ADR-006）：file_versions.object_key = …/v{seq}/{contentHash}.{ext}，会话 completed",
    "object_key=" + expectObjectKey,
    short({ objectKey: versionRow.rows[0]?.object_key, sizeBytes: Number(versionRow.rows[0]?.size_bytes), status: sessionAfter.rows[0]?.status, completedAt: sessionAfter.rows[0]?.completed_at !== null }, 300),
    versionRow.rowCount === 1 &&
      versionRow.rows[0]?.object_key === expectObjectKey &&
      Number(versionRow.rows[0]?.size_bytes) === FILE_SIZE &&
      versionRow.rows[0]?.seq === 1 &&
      sessionAfter.rows[0]?.status === "completed" &&
      sessionAfter.rows[0]?.completed_at !== null,
  );

  const headContract = await storage.headObject(expectObjectKey);
  const stagingLeft = await versionsOfKey(stagingKey);
  check(
    "U10",
    "存储侧：契约键对象存在且大小一致；暂存对象按版本清理干净（无数据版本 / 无 delete marker）",
    "契约键 20 MiB；暂存键 0 版本 0 marker",
    short({ contractSize: headContract?.sizeBytes, stagingVersions: stagingLeft.versions.length, stagingMarkers: stagingLeft.markers.length }, 160),
    headContract !== null && headContract.sizeBytes === FILE_SIZE && stagingLeft.versions.length === 0 && stagingLeft.markers.length === 0,
  );

  const auditComplete = await db.query("select * from audit_logs where object_type = $1 and object_id = $2 and action = $3 order by id desc limit 1", ["file", fileId, "complete"]);
  const outbox = await db.query("select * from outbox_events where topic = $1 and payload->>$2 = $3", ["file.version.created", "fileId", fileId]);
  check(
    "U11",
    "留痕与事件：complete 审计（metadata 带 versionSeq / objectKey）+ outbox file.version.created（dedupeKey 幂等）",
    "审计 1 条 + outbox 1 条（dedupeKey=file.version.created:" + String(versionId) + "）",
    short({ audit: auditComplete.rowCount, versionSeq: auditComplete.rows[0]?.metadata?.versionSeq, objectKey: auditComplete.rows[0]?.metadata?.objectKey, outbox: outbox.rowCount, dedupeKey: outbox.rows[0]?.dedupe_key, status: outbox.rows[0]?.status }, 300),
    auditComplete.rowCount === 1 &&
      auditComplete.rows[0]?.metadata?.versionSeq === 1 &&
      auditComplete.rows[0]?.metadata?.objectKey === expectObjectKey &&
      outbox.rowCount === 1 &&
      outbox.rows[0]?.dedupe_key === "file.version.created:" + versionId &&
      outbox.rows[0]?.status === "pending",
  );

  const dupInit = await createUpload({ projectId: projectA, name: "另一份同名内容.docx", sizeBytes: FILE_SIZE, contentHash, intent: "version" });
  check(
    "U12",
    "秒传提示（A4-04）：同项目同内容哈希 → duplicateHint 指向既有文件（不阻断继续上传；U1 文件带 docType / nodeId 归属，不参与附件域秒传复用）",
    "duplicateHint.fileId=" + String(fileId),
    dupInit.status + " " + short({ hint: dupInit.body?.duplicateHint, newFileId: dupInit.body?.file?.id }, 240),
    dupInit.status === 201 && dupInit.body?.duplicateHint?.fileId === fileId && dupInit.body?.duplicateHint?.name === fileName && dupInit.body?.file?.id !== fileId,
  );

  // U12b（2026-10-12 附件域秒传复用）：无 taskId / nodeId / docType 的纯附图上传，同内容二次发起 → 直接复用既有文件。
  const attachBytes = Buffer.from("m4-01 附件域秒传复用回放 " + stamp, "utf8");
  const attachHash = sha256(attachBytes);
  const attachInit = await createUpload({ projectId: projectA, name: "回放-附件域复用.png", sizeBytes: attachBytes.length, mime: "image/png", contentHash: attachHash, intent: "version" });
  if (attachInit.body?.upload === null || attachInit.body?.upload === undefined) throw new Error("U12b 前置上传未建会话");
  const attachSigned = await signParts(attachInit.body.file.id, attachInit.body.upload.id, [1]);
  await putPart(attachSigned.body.parts[0].url, attachBytes);
  const attachDone = await completeUpload(attachInit.body.file.id, attachInit.body.upload.id, attachHash);
  const attachDup = await createUpload({ projectId: projectA, name: "回放-附件域复用-第二处.png", sizeBytes: attachBytes.length, mime: "image/png", contentHash: attachHash, intent: "version" });
  const attachFileRows = await db.query("select count(*)::int as n from files where id = $1", [attachInit.body.file.id]);
  const attachSessionRows = await db.query("select count(*)::int as n from upload_sessions where file_id = $1", [attachInit.body.file.id]);
  check(
    "U12b",
    "附件域秒传复用（2026-10-12）：同项目同内容附件再次发起 → 不新建文件 / 会话，直接复用既有文件",
    "201 + reused=true + upload=null + file.id=" + String(attachInit.body?.file?.id),
    attachDone.status + " / " + attachDup.status + " " + short({ reused: attachDup.body?.reused, upload: attachDup.body?.upload, fileId: attachDup.body?.file?.id, hintFileId: attachDup.body?.duplicateHint?.fileId }, 260),
    attachDone.status === 200 &&
      attachDup.status === 201 &&
      attachDup.body?.reused === true &&
      attachDup.body?.upload === null &&
      attachDup.body?.file?.id === attachInit.body.file.id &&
      attachDup.body?.duplicateHint?.fileId === attachInit.body.file.id &&
      attachFileRows.rows[0]?.n === 1 &&
      attachSessionRows.rows[0]?.n === 1,
  );

  const statusDone = await sessionStatus(fileId, uploadId);
  const abortDone = await abortUpload(fileId, uploadId);
  check(
    "U13",
    "已完成会话不可续传（409 FILE_STATE_INVALID）/ 不可取消（回退走版本回溯 M4-02）",
    "409 + 409",
    statusDone.status + " " + short(statusDone.body, 120) + " / " + abortDone.status + " " + short(abortDone.body, 120),
    statusDone.status === 409 && statusDone.body?.code === "FILE_STATE_INVALID" && abortDone.status === 409 && abortDone.body?.code === "FILE_STATE_INVALID",
  );
  // ---------- 证据四：失败面 ----------
  const incompleteInit = await createUpload({ projectId: projectA, name: "缺片完成反例.docx", sizeBytes: FILE_SIZE, contentHash, intent: "version" });
  const incompleteFile = incompleteInit.body.file.id;
  const incompleteId = incompleteInit.body.upload.id;
  const partOne = await signParts(incompleteFile, incompleteId, [1]);
  await putPart(partOne.body.parts[0].url, parts[0]);
  const early = await completeUpload(incompleteFile, incompleteId, contentHash);
  const earlyVersions = await db.query("select count(*)::int as n from file_versions where file_id = $1", [incompleteFile]);
  check(
    "U14",
    "分片未齐 → 409 UPLOAD_INCOMPLETE（details.missing 可驱动前端补传）",
    "409 + missing=[2,3] + 无版本行",
    early.status + " " + short({ code: early.body?.code, missing: early.body?.details?.[0]?.meta?.missing }, 200),
    early.status === 409 && early.body?.code === "UPLOAD_INCOMPLETE" && JSON.stringify(early.body?.details?.[0]?.meta?.missing) === "[2,3]" && earlyVersions.rows[0].n === 0,
  );

  const mismatchInit = await createUpload({ projectId: projectA, name: "哈希不符反例.docx", sizeBytes: 8 * MI_B, contentHash: "c".repeat(64), intent: "version" });
  const mismatchFile = mismatchInit.body.file.id;
  const mismatchId = mismatchInit.body.upload.id;
  const mismatchSigned = await signParts(mismatchFile, mismatchId, [1]);
  const mismatchPut = await putPart(mismatchSigned.body.parts[0].url, parts[0]);
  const mismatch = await completeUpload(mismatchFile, mismatchId, sha256(parts[0]));
  const mismatchVersions = await db.query("select count(*)::int as n from file_versions where file_id = $1", [mismatchFile]);
  check(
    "U15",
    "complete 哈希与 init 声明不一致 → 422 FILE_HASH_MISMATCH（一致性校验不省；不复制不落库）",
    "422 + code=FILE_HASH_MISMATCH + 无版本行",
    mismatch.status + " " + short({ code: mismatch.body?.code, detail: mismatch.body?.details?.[0]?.code }, 160),
    mismatchPut.status === 200 && mismatch.status === 422 && mismatch.body?.code === "FILE_HASH_MISMATCH" && mismatchVersions.rows[0].n === 0,
  );

  const sizeInit = await createUpload({ projectId: projectA, name: "大小不符反例.docx", sizeBytes: 8 * MI_B, intent: "version" });
  const sizeFile = sizeInit.body.file.id;
  const sizeId = sizeInit.body.upload.id;
  const sizeSigned = await signParts(sizeFile, sizeId, [1]);
  await putPart(sizeSigned.body.parts[0].url, Buffer.concat([parts[0], Buffer.from([0])]));
  const sizeMismatch = await completeUpload(sizeFile, sizeId, sha256(parts[0]));
  check(
    "U16",
    "合并后大小与声明不一致 → 409 UPLOAD_INCOMPLETE（size_mismatch；不信客户端声明）",
    "409 + code=UPLOAD_INCOMPLETE + details.size_mismatch",
    sizeMismatch.status + " " + short({ code: sizeMismatch.body?.code, details: sizeMismatch.body?.details }, 240),
    sizeMismatch.status === 409 && sizeMismatch.body?.code === "UPLOAD_INCOMPLETE" && sizeMismatch.body?.details?.[0]?.code === "size_mismatch",
  );

  const abortTwice = await abortUpload(incompleteFile, incompleteId);
  const abortAgain = await abortUpload(incompleteFile, incompleteId);
  const signAfterAbort = await signParts(incompleteFile, incompleteId, [2]);
  check(
    "U17",
    "取消上传：首个 200 aborted + 重复取消幂等 200 + 之后取分片 410（会话不可再用）",
    "200 aborted / 200 aborted / 410 UPLOAD_SESSION_EXPIRED",
    short({ first: abortTwice.body?.upload?.status, second: abortAgain.body?.upload?.status, sign: signAfterAbort.status + " " + String(signAfterAbort.body?.code) }, 240),
    abortTwice.status === 200 &&
      abortTwice.body?.upload?.status === "aborted" &&
      abortAgain.status === 200 &&
      abortAgain.body?.upload?.status === "aborted" &&
      signAfterAbort.status === 410 &&
      signAfterAbort.body?.code === "UPLOAD_SESSION_EXPIRED",
  );

  // ---------- 证据五：过期与清理 ----------
  await db.query("update upload_sessions set created_at = now() - interval '2 hours', expires_at = now() - interval '1 minute' where id = $1", [sizeId]);
  const expiredLazy = await signParts(sizeFile, sizeId, [1]);
  const expiredRow = await db.query("select status from upload_sessions where id = $1", [sizeId]);
  const expiredAudit = await db.query("select * from audit_logs where object_id = $1 and metadata->>$2 = $3 order by id desc limit 1", [sizeFile, "uploadId", sizeId]);
  const expiredKey = (await db.query("select object_key from upload_sessions where id = $1", [sizeId])).rows[0].object_key;
  const stagingAfterExpire = await versionsOfKey(expiredKey);
  check(
    "U18",
    "过期会话（访问时惰性）：取分片 410 + 会话置 expired + 暂存清干净 + system 审计（actorId=null）",
    "410 UPLOAD_SESSION_EXPIRED + status=expired + 0 数据版本 + 审计 actor_id=null",
    short({ code: expiredLazy.body?.code, status: expiredRow.rows[0]?.status, versions: stagingAfterExpire.versions.length, auditActor: expiredAudit.rows[0]?.actor_id ?? null }, 240),
    expiredLazy.status === 410 &&
      expiredLazy.body?.code === "UPLOAD_SESSION_EXPIRED" &&
      expiredRow.rows[0]?.status === "expired" &&
      stagingAfterExpire.versions.length === 0 &&
      expiredAudit.rowCount === 1 &&
      expiredAudit.rows[0]?.actor_id === null,
    "过期模拟：created_at / expires_at 同时前移（ck_upload_sessions_expires 要求 expires_at > created_at）",
  );

  await db.query("update upload_sessions set created_at = now() - interval '2 hours', expires_at = now() - interval '1 minute' where id = $1", [mismatchId]);
  const mismatchKey = (await db.query("select object_key from upload_sessions where id = $1", [mismatchId])).rows[0].object_key;
  const workerOutput = await runWorkerOnce();
  const sweptRow = await db.query("select status from upload_sessions where id = $1", [mismatchId]);
  const sweptVersions = await versionsOfKey(mismatchKey);
  check(
    "U19",
    "worker 定时档（启动即跑一轮）：中止未完成分片 + 按版本清暂存 + 置 expired",
    "status=expired + 0 数据版本 + worker 启动日志",
    short({ status: sweptRow.rows[0]?.status, versions: sweptVersions.versions.length, started: /已启动/.test(workerOutput) }, 200),
    sweptRow.rows[0]?.status === "expired" && sweptVersions.versions.length === 0 && /已启动/.test(workerOutput),
    "worker 日志：" + workerOutput.split("\n").filter((line) => line.includes("worker") || line.includes("上传")).slice(0, 2).join(" | ").slice(0, 220),
  );

  // ---------- 证据六：权限与登记项 ----------
  const asMemberRejected = await createUpload({ projectId: projectA, name: "非成员上传反例.docx", sizeBytes: MI_B, intent: "version" }, member);
  const roster = await call("POST", "/api/v1/projects/" + projectA + "/members", { userId: memberId, roleInProject: "project_member" });
  const asMemberAccepted = await createUpload({ projectId: projectA, name: "名册成员上传.docx", sizeBytes: MI_B, intent: "version" }, member);
  check(
    "U20",
    "file.upload 项目成员平权：非成员 404（防 IDOR）→ 入名册后 201",
    "404 NOT_FOUND / 201 + draft",
    asMemberRejected.status + " " + String(asMemberRejected.body?.code) + " / " + asMemberAccepted.status + " " + String(asMemberAccepted.body?.file?.status),
    asMemberRejected.status === 404 && asMemberRejected.body?.code === "NOT_FOUND" && asMemberAccepted.status === 201 && asMemberAccepted.body?.file?.status === "draft",
    "名册写入返回 " + roster.status,
  );

  const crossNode = await createUpload({ projectId: projectA, name: "跨项目节点反例.docx", sizeBytes: MI_B, nodeId: projectBNode, intent: "version" });
  const foreignChange = await createUpload({ projectId: projectA, name: "变更上传（登记项）.docx", sizeBytes: MI_B, intent: "change", change: { reason: "设计变更" } });
  check(
    "U21",
    "跨项目 nodeId → 400（防跨项目挂接）；intent=change → 400（Push 130 定案：change 必填 fileId，本请求缺 fileId 被契约拒；实现随 M4-04）",
    "400 VALIDATION_FAILED（invalid_node）/ 400 VALIDATION_FAILED",
    crossNode.status + " " + short({ code: crossNode.body?.code, detail: crossNode.body?.details?.[0]?.code }, 120) + " / " + foreignChange.status + " " + String(foreignChange.body?.code),
    crossNode.status === 400 &&
      crossNode.body?.code === "VALIDATION_FAILED" &&
      crossNode.body?.details?.[0]?.code === "invalid_node" &&
      foreignChange.status === 400 &&
      foreignChange.body?.code === "VALIDATION_FAILED",
  );

  const existingDraft = await createUpload({ projectId: projectA, name: "既有文件（draft）", sizeBytes: MI_B, intent: "version" });
  const appendAccepted = await createUpload({
    projectId: projectA,
    name: "既有文件（draft）",
    sizeBytes: MI_B,
    intent: "version",
    fileId: existingDraft.body?.file?.id,
  });
  const appendNameMismatch = await createUpload({
    projectId: projectA,
    name: "改名反例.docx",
    sizeBytes: MI_B,
    intent: "version",
    fileId: existingDraft.body?.file?.id,
  });
  const guardChange = await createUpload({
    projectId: projectA,
    name: "既有文件（draft）",
    sizeBytes: MI_B,
    intent: "change",
    fileId: existingDraft.body?.file?.id,
    change: { reason: "设计变更" },
  });
  check(
    "U22",
    "上传入口 fileId 分派（Push 130 定案 · M4-02 放开 version 路径 · M4-04 放开 change 路径）：version + fileId 接受（名称须与目标现状一致，不一致 400 name_mismatch）/ change + fileId 目标须定档（draft 目标 409 FILE_STATE_INVALID）",
    "201（追加版本会话，同一 fileId）/ 400 VALIDATION_FAILED（name_mismatch）/ 409 FILE_STATE_INVALID（change 目标未定档）",
    appendAccepted.status + " " + String(appendAccepted.body?.file?.id === existingDraft.body?.file?.id) + " / " + appendNameMismatch.status + " " + short({ code: appendNameMismatch.body?.code, detail: appendNameMismatch.body?.details?.[0]?.code }, 120) + " / " + guardChange.status + " " + short({ code: guardChange.body?.code }, 120),
    existingDraft.status === 201 &&
      appendAccepted.status === 201 &&
      appendAccepted.body?.file?.id === existingDraft.body?.file?.id &&
      appendNameMismatch.status === 400 &&
      appendNameMismatch.body?.code === "VALIDATION_FAILED" &&
      appendNameMismatch.body?.details?.[0]?.code === "name_mismatch" &&
      guardChange.status === 409 &&
      guardChange.body?.code === "FILE_STATE_INVALID",
  );
} catch (error) {
  failures += 1;
  report.push("| FAIL | 中断：" + (error instanceof Error ? error.message : String(error)));
  process.stderr.write("M4 回放失败：" + (error instanceof Error ? error.message : String(error)) + "\n");
} finally {
  if (db !== undefined) {
    try {
      if (args.keep !== true) {
        for (const projectId of cleanup.projectIds) {
          await db.query("update files set current_version_id = null where project_id = $1", [projectId]);
          await db.query("delete from upload_sessions where file_id in (select id from files where project_id = $1)", [projectId]);
          await db.query("delete from file_versions where file_id in (select id from files where project_id = $1)", [projectId]);
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
lines.push("# M4-01 回放证据（S7·file 上传管道：分片直传 / 断点续传 / 完成落版本 / 过期清理）");
lines.push("");
lines.push("> 卡片：M4-01「file 模块：上传管道（发起 / 分片 / 完成 / 取消）」（主责 lan，评审 wmj）｜口径来源：ADR-006 定案（Push 126）、系统功能书 A4-01~A4-03、技术设计v0.2 §5.1-5.2、上传错误码契约 V0.3。");
lines.push("> 落点说明：`docs/` 属 px 线；本文件由 lan 随 M4-01 卡片代记（回放脚本与断言同 PR，请 px 复核）。");
lines.push("");
lines.push("| 项 | 值 |");
lines.push("|---|---|");
lines.push("| 回放时间 | " + new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 19).replace("T", " ") + " +08:00 |");
lines.push("| 目标 | " + BASE_URL + " |");
lines.push("| 数据库 | " + DATABASE_URL.replace(/:[^:@/]+@/, ":***") + " |");
lines.push("| 对象存储 | " + (storage === undefined ? "-" : storage.bucket) + "（本地 MinIO 沙箱：仅沙箱、不代表生产选型） |");
lines.push("| 代码版本 | " + commit + (dirty ? "（回放时工作区含本卡未提交改动）" : "") + " |");
lines.push("| 执行账号 | 管理员（含 file.upload）+ 名册成员（file.upload 平权基准） |");
lines.push("| 脚本 | server/scripts/m4-upload-replay.mjs |");
lines.push("");
lines.push("## 断言明细");
lines.push("");
lines.push(...report);
lines.push("");
lines.push("## 汇总");
lines.push("");
lines.push(failures === 0 ? "- ✅ 全部断言通过（" + evidence.steps.filter((step) => step.ok).length + " 项）：发起上传 / 分片直传与续传 / 完成落版本（契约键）+ 留痕与事件 / 失败面 / 过期清理（惰性 + worker）/ 权限平权。" : "- ❌ 有 " + failures + " 项失败，见上方 FAIL 行。");
lines.push("");
lines.push("## 验收对照（M4-01）");
lines.push("");
lines.push("- 发起上传 = U1 / U2：POST /files/uploads 建 draft 文件 + 上传会话；会话先写暂存键（ADR-006），附件域同内容命中即复用既有文件（U12，2026-10-12）。");
lines.push("- 分片直传 / 断点续传 = U3 ~ U7：预签名 URL 由浏览器裸 PUT（api 不代理流量）；GET 会话状态回已传 / 缺失分片；分片状态不落表（T1）。");
lines.push("- 完成上传 = U8 ~ U11：合并 → HEAD 校大小 → 哈希一致性 → copyObject 到契约键 → 事务写版本 / 文件 / 会话 + 审计 + outbox → 按版本清暂存。");
lines.push("- 失败面 = U13 ~ U17：缺片 409 / 大小不符 409 / 哈希不符 422 / 已完成 409 / 取消幂等 + 取消后 410。");
lines.push("- 过期与清理 = U18 / U19：访问时惰性置 expired（410 + system 审计）；worker 启动一轮即清理未完成分片与暂存对象。");
lines.push("- 权限与守卫 = U20 / U21 / U22：非成员 404（防 IDOR）→ 名册成员 201；跨项目 nodeId 400；intent=change 缺 fileId 400（契约层，随 M4-04 已在服务层放开）；带 fileId 的 version 请求已随 M4-02 放开（名称不一致 400 name_mismatch）；change + fileId 随 M4-04 放开（目标须定档，未定档 409）—— 详见 docs/m4-04-回放证据(变更申请即通过).md。");
lines.push("- 单测回归（不连库）：server/test/file-service.test.ts（34 例）随 npm test 常跑：成功链路 / 缺片 / 哈希 / 大小 / 过期 / 秒传 / 越界 / 完成位次竞态。");
lines.push("- 复跑：cd server && node --env-file-if-exists=.env scripts/m4-upload-replay.mjs --out \"./../docs/m4-01-回放证据(上传管道S7file).md\"");
lines.push("");

if (args.json !== undefined) writeFileSync(args.json, JSON.stringify(evidence, null, 2) + "\n", "utf8");
if (args.out !== undefined) writeFileSync(args.out, lines.join("\n"), "utf8");
process.stdout.write(lines.join("\n") + "\n");
process.exit(failures === 0 ? 0 : 1);