#!/usr/bin/env node
/**
 * M4-05 预览产物对象清理真机回放（S7·file 预览收口 · PR-12）：
 *   证据一（共享缓存）：两个同内容文件 A / B —— 只读 A 触发生成 → 三元组 ready；读 B 直接命中（不重投、不重转）。
 *   证据二（有引用 → 转移不删）：彻底删除 A → 产物对象**保留** + `preview_artifacts` 行归属转移到 B 的版本
 *             （D2-06「同一文件只转换一次」：删掉一份重复文件不该把共享缓存打回 not_ready）。
 *   证据三（无引用 → 清对象）：彻底删除 B → 产物对象与行一并清（`previews/{contentHash}/` 不再留对象）。
 *   证据四（审计 / 不重投 / 不复活）：purge 审计 metadata 记 previewArtifactsPurged / previewArtifactsReassigned；
 *             归属转移不触发重新投递；文件彻底删除后读预览 404（产物不复活）。
 *
 * 前置：真 PG（DATABASE_URL）+ 真对象存储（S3_*，见 deploy/minio/）+ 真转换沙箱（deploy/preview，默认 http://127.0.0.1:9900）
 *       + 已起 api（BASE_URL）与 worker（消费 preview.job；建议 OUTBOX_POLL_MS=1000 加快回放）。
 *       本脚本只在本地沙箱 / 联调库跑：铸临时管理员会话（跑完撤销）、建 M4PRD- 回放项目
 *       （跑完硬删项目及其文件 / 版本 / 会话 / 关联 / 产物 / 审计 / outbox 事件 + 清桶内 projects/ 与 previews/ 前缀）。
 * 用法：cd server && M4_DATABASE_URL=postgresql://libiaolink_migrator@127.0.0.1:55432/libiaolink \
 *       node --env-file-if-exists=.env scripts/m4-preview-cleanup-replay.mjs [--out <报告.md>] [--json <证据.json>] [--keep]
 * 退出码：断言全过 = 0，否则 = 1（可当门禁用）。
 */
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "pg";

const serverRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = parseArgs(process.argv.slice(2));
const BASE_URL = args.baseUrl ?? process.env.M4_BASE_URL ?? process.env.BASE_URL ?? "http://127.0.0.1:3011";
const DATABASE_URL =
  args.databaseUrl ?? process.env.M4_DATABASE_URL ?? process.env.DATABASE_URL ?? "postgresql://libiaolink_migrator@127.0.0.1:55432/libiaolink";
const MI_B = 1024 * 1024;
const DRAIN_TIMEOUT_MS = 120_000;
const report = [];
const evidence = { steps: [] };
let failures = 0;
let db;

/** 回放样例：中文 HTML（soffice 家族 → pdf 通道），A / B 同内容（共享三元组缓存）。 */
const SAMPLE_HTML = Buffer.from(
  "<!doctype html><html><head><meta charset=\"utf-8\"><title>预览产物清理回放</title></head><body>" +
    "<h1>LibiaoLink 预览产物清理回放（M4-05 收口）</h1>" +
    "<p>机械设计图纸 / 技术协议 / 合同评审单：中文排版样例，用于验证产物对象的引用反查清理。</p>" +
    "</body></html>",
  "utf8",
);

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

async function makeSession(userId, idToken) {
  const session = { userId, token: "m4prd-" + randomBytes(16).toString("hex"), csrf: randomBytes(16).toString("hex") };
  await db.query("insert into sessions (token_hash, user_id, id_token, expires_at) values ($1, $2, $3, now() + interval '2 hours')", [
    sha256(session.token),
    userId,
    idToken,
  ]);
  return session;
}

async function call(method, path, body, session, extraHeaders = {}) {
  const actor = session === null ? null : session ?? admin;
  const headers = { "content-type": "application/json", ...extraHeaders };
  if (actor !== null) {
    headers.cookie = "ll_sid=" + actor.token + "; ll_csrf=" + actor.csrf;
    headers["x-csrf-token"] = actor.csrf;
  }
  const response = await fetch(BASE_URL + path, {
    method,
    headers,
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

const preview = (fileId, session = admin) => call("GET", "/api/v1/files/" + fileId + "/preview", undefined, session);

function check(id, title, expected, actual, ok, note = "") {
  if (!ok) failures += 1;
  report.push((ok ? "| PASS | " : "| FAIL | ") + id + " | " + title + " | ");
  report.push("  - 期望：" + expected);
  report.push("  - 实际：" + actual);
  if (note !== "") report.push("  - 说明：" + note);
  evidence.steps.push({ id, title, expected, actual, ok, note });
  process.stdout.write((ok ? "PASS " : "FAIL ") + id + " " + title + "\n");
  if (!ok) throw new Error("M4-05 预览产物清理回放失败（" + id + "）：" + title);
}

function short(value, max = 320) {
  const text = JSON.stringify(value);
  return text === undefined ? "undefined" : text.length > max ? text.slice(0, max) + "…" : text;
}

function makeParts(bytes) {
  const parts = [];
  for (let offset = 0; offset < bytes.length; offset += 8 * MI_B) {
    parts.push(bytes.subarray(offset, Math.min(offset + 8 * MI_B, bytes.length)));
  }
  return parts;
}

async function putPart(url, body) {
  const response = await fetch(url, { method: "PUT", body });
  return { status: response.status };
}

/** 走真实上传管道（init → 分片直传 → complete）；新建文件（intent=version 且不给 fileId）。 */
async function uploadFile({ projectId, name, bytes, docType }) {
  const parts = makeParts(bytes);
  const contentHash = sha256(bytes);
  const init = await call("POST", "/api/v1/files/uploads", { projectId, name, sizeBytes: bytes.length, contentHash, docType, intent: "version" }, admin);
  const targetId = init.body?.file?.id;
  const uploadId = init.body?.upload?.id;
  if (targetId === undefined || uploadId === undefined) {
    return { init, fileId: targetId, uploadId, contentHash, completed: { status: 0, body: null } };
  }
  const signed = await call(
    "POST",
    "/api/v1/files/" + targetId + "/uploads/" + uploadId + "/parts",
    { partNumbers: parts.map((_unused, index) => index + 1) },
    admin,
  );
  for (let index = 0; index < parts.length; index += 1) {
    await putPart(signed.body.parts[index].url, parts[index]);
  }
  const completed = await call("POST", "/api/v1/files/" + targetId + "/uploads/" + uploadId + "/complete", { contentHash }, admin);
  return { init, fileId: targetId, uploadId, contentHash, completed };
}

async function artifactRow(contentHash, target = "pdf") {
  const rows = await db.query(
    "select id, file_id, version_id, status, object_key, generated_at from preview_artifacts where content_hash = $1 and target = $2",
    [contentHash, target],
  );
  return rows.rows[0] ?? null;
}

async function artifactCount(contentHash) {
  const rows = await db.query("select count(*)::int as total from preview_artifacts where content_hash = $1", [contentHash]);
  return rows.rows[0]?.total ?? 0;
}

async function jobCountOf(contentHash) {
  const rows = await db.query("select count(*)::int as total from outbox_events where dedupe_key like $1", [
    "preview.job:" + contentHash + ":%",
  ]);
  return rows.rows[0]?.total ?? 0;
}

async function fileVersion(fileId) {
  const rows = await db.query("select version from files where id = $1", [fileId]);
  return rows.rows[0]?.version;
}

async function versionKeysOf(fileId) {
  const rows = await db.query("select seq, object_key from file_versions where file_id = $1 order by seq", [fileId]);
  return rows.rows;
}

async function purgeAuditOf(projectId, fileId) {
  const rows = await db.query(
    "select action, object_id, summary, metadata from audit_logs where project_id = $1 and object_type = 'file' and action = 'delete' and object_id = $2 order by occurred_at desc",
    [projectId, fileId],
  );
  return rows.rows[0] ?? null;
}

async function waitForArtifact(contentHash, desired, timeoutMs = DRAIN_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await artifactRow(contentHash);
    if (last !== null && last.status === desired) {
      return last;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return last;
}

async function headOrNull(objectKey) {
  try {
    return await storage.headObject(objectKey);
  } catch {
    return "error";
  }
}

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

let admin;
let adminId;
let storage;
let rawClient;
let s3Module;
let project;
let pipelineVersion = "1.0.0";
const cleanup = { projectIds: [], sessions: [], contentHashes: [] };

try {
  try {
    const envModule = await import(pathToFileURL(join(serverRoot, "dist", "config", "env.js")).href);
    const storageModule = await import(pathToFileURL(join(serverRoot, "dist", "storage", "index.js")).href);
    s3Module = await import("@aws-sdk/client-s3");
    const env = envModule.loadEnv(process.env);
    pipelineVersion = env.PREVIEW_PIPELINE_VERSION;
    storage = storageModule.createS3ObjectStorage(env);
    rawClient = storageModule.createS3Client(env);
  } catch (error) {
    throw new Error("无法加载 dist / S3 环境（先 npm run build，并用 --env-file-if-exists=.env 带上 S3_* / PREVIEW_*）：" + String(error));
  }

  db = new Client({ connectionString: DATABASE_URL });
  await db.connect();

  // ---------- 证据 0：依赖就绪 ----------
  const health = await fetch(BASE_URL + "/healthz").then((response) => response.status).catch(() => 0);
  const ready = await fetch(BASE_URL + "/readyz").then((response) => response.status).catch(() => 0);
  check("S0", "api 可用（/healthz + /readyz：含存储探针）", "200 / 200", health + " / " + ready, health === 200 && ready === 200);

  const converterHealth = await fetch(process.env.PREVIEW_CONVERTER_URL + "/healthz")
    .then((response) => response.json())
    .catch(() => null);
  check(
    "S1",
    "转换沙箱可用且管线版本与 server 配置同值（清理判定的三元组必须同版本）",
    "ok=true 且 pipelineVersion=" + pipelineVersion,
    short({ ok: converterHealth?.ok, pipelineVersion: converterHealth?.pipelineVersion }, 160),
    converterHealth?.ok === true && converterHealth?.pipelineVersion === pipelineVersion,
  );

  const adminRow = await db.query(
    "select u.id from users u join user_roles ur on ur.user_id = u.id join roles r on r.id = ur.role_id where r.code = $1 and u.status = $2 order by u.id limit 1",
    ["admin", "active"],
  );
  adminId = adminRow.rows[0]?.id;
  if (adminId === undefined) throw new Error("找不到可用的管理员账号（roles.code = admin）");
  admin = await makeSession(adminId, "m4prd-replay-admin");
  cleanup.sessions.push(admin.token);

  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const created = await call("POST", "/api/v1/projects", {
    code: "M4PRD-" + stamp,
    name: "m4-05e 预览产物清理回放项目（预览收口）",
    projectType: "default",
    managerIds: [adminId],
  });
  check("P1", "建回放项目（为 file 提供 projectId）", "201 + 项目可见", created.status + " " + short({ id: created.body?.id, code: created.body?.code }, 120), created.status === 201);
  project = created.body.id;
  cleanup.projectIds.push(project);

  // ---------- 证据一：共享三元组缓存（A / B 同内容） ----------
  const fileA = await uploadFile({ projectId: project, name: "同内容样例A-M4-05e.html", bytes: SAMPLE_HTML, docType: "技术协议" });
  cleanup.contentHashes.push(fileA.contentHash);
  const fileB = await uploadFile({ projectId: project, name: "同内容样例B-M4-05e.html", bytes: SAMPLE_HTML, docType: "技术协议" });
  check(
    "F1",
    "上传两个同内容文件 A / B（真实上传管道；上传完成不投递预览任务）",
    "200 + 两边版本 v1 + 同 contentHash + outbox 0 行",
    short(
      {
        a: { status: fileA.completed.status, seq: fileA.completed.body?.version?.seq },
        b: { status: fileB.completed.status, seq: fileB.completed.body?.version?.seq },
        sameHash: fileA.contentHash === fileB.contentHash,
        jobs: await jobCountOf(fileA.contentHash),
      },
      240,
    ),
    fileA.completed.status === 200 &&
      fileB.completed.status === 200 &&
      fileA.completed.body?.version?.seq === 1 &&
      fileB.completed.body?.version?.seq === 1 &&
      fileA.contentHash === fileB.contentHash &&
      (await jobCountOf(fileA.contentHash)) === 0,
  );

  const readA = await preview(fileA.fileId);
  check(
    "R1",
    "读 A 预览 → not_ready + 补投（读取侧懒生成；产物的「首登版本」= A 的 v1）",
    "200 + status=not_ready + outbox 1 行",
    short({ status: readA.body?.status, jobs: await jobCountOf(fileA.contentHash) }, 200),
    readA.status === 200 && readA.body?.status === "not_ready" && (await jobCountOf(fileA.contentHash)) === 1,
  );

  const artifact = await waitForArtifact(fileA.contentHash, "ready");
  const versionA = fileA.completed.body.version.id;
  const versionB = fileB.completed.body.version.id;
  check(
    "R2",
    "worker 消费 → 三元组 ready（产物对象落 `previews/{contentHash}/{pipelineVersion}/{target}`）",
    "status=ready + object_key = 契约键 + generated_at 非空",
    short({ status: artifact?.status, objectKey: artifact?.object_key, generatedAt: artifact?.generated_at }, 240),
    artifact?.status === "ready" &&
      artifact?.object_key === "previews/" + fileA.contentHash + "/" + pipelineVersion + "/pdf" &&
      artifact?.generated_at !== null,
  );

  const readB = await preview(fileB.fileId);
  const objectBeforePurge = await headOrNull(artifact.object_key);
  check(
    "R3",
    "读 B（同内容另一文件）→ 直接命中同一三元组（共享缓存：不重投、不重转）",
    "status=ready + url 非空 + outbox 仍 1 行 + 对象存在",
    short({ status: readB.body?.status, url: typeof readB.body?.url === "string" ? readB.body.url.slice(0, 80) + "…" : readB.body?.url, jobs: await jobCountOf(fileA.contentHash), objectInStorage: objectBeforePurge !== null }, 320),
    readB.status === 200 &&
      readB.body?.status === "ready" &&
      typeof readB.body?.url === "string" &&
      (await jobCountOf(fileA.contentHash)) === 1 &&
      objectBeforePurge !== null,
  );

  const ownerBefore = await artifactRow(fileA.contentHash);
  check(
    "R4",
    "产物行归属 = 首登版本（A 的 v1；D2-06 只转换一次的登记口径）",
    "file_id = A + version_id = A.v1",
    short({ fileId: ownerBefore?.file_id, versionId: ownerBefore?.version_id }, 200),
    ownerBefore?.file_id === fileA.fileId && ownerBefore?.version_id === versionA,
  );

  // ---------- 证据二：有引用 → 转移不删（彻底删除 A） ----------
  const keyA = (await versionKeysOf(fileA.fileId))[0]?.object_key;
  await call("POST", "/api/v1/files/" + fileA.fileId + "/recycle", { version: await fileVersion(fileA.fileId), reason: "回放：清理验证" }, admin);
  const purgedA = await call("POST", "/api/v1/files/" + fileA.fileId + "/purge", { version: await fileVersion(fileA.fileId), reason: "回放：清 A（B 仍引用同内容）" }, admin);
  check("X1", "彻底删除 A（先回收后彻底删除）", "200 + purgedAt 非空", purgedA.status + " " + short(purgedA.body, 160), purgedA.status === 200 && typeof purgedA.body?.purgedAt === "string");

  const afterA = await artifactRow(fileA.contentHash);
  check(
    "X2",
    "有存活引用（B 的 v1 同内容）→ **不清对象**，缓存行归属转移给 B 的版本",
    "行仍在 + file_id = B + version_id = B.v1 + 对象仍存在",
    short({ row: afterA === null ? null : { fileId: afterA.file_id, versionId: afterA.version_id, status: afterA.status }, objectInStorage: (await headOrNull(artifact.object_key)) !== null }, 280),
    afterA !== null &&
      afterA.file_id === fileB.fileId &&
      afterA.version_id === versionB &&
      (await headOrNull(artifact.object_key)) !== null,
  );

  const auditA = await purgeAuditOf(project, fileA.fileId);
  check(
    "X3",
    "A 的 purge 审计：previewArtifactsReassigned = 1 / previewArtifactsPurged = 0（摘要把「转移」与「清对象」分开）",
    "action=delete + metadata {purged: 0, reassigned: 1}",
    short({ action: auditA?.action, metadata: auditA?.metadata, summary: auditA?.summary }, 320),
    auditA?.action === "delete" && auditA?.metadata?.previewArtifactsPurged === 0 && auditA?.metadata?.previewArtifactsReassigned === 1,
  );

  const readBAfter = await preview(fileB.fileId);
  const aKeysGone = await headOrNull(keyA);
  check(
    "X4",
    "删 A 后 B 仍 ready（缓存未被打回 not_ready、不重投）；A 的版本对象照旧已清",
    "status=ready + outbox 仍 1 行 + A 版本对象不存在",
    short({ status: readBAfter.body?.status, jobs: await jobCountOf(fileA.contentHash), versionObjectA: aKeysGone === null ? null : "exists" }, 240),
    readBAfter.status === 200 && readBAfter.body?.status === "ready" && (await jobCountOf(fileA.contentHash)) === 1 && aKeysGone === null,
  );

  // ---------- 证据三：无引用 → 清对象（彻底删除 B） ----------
  const urlB = readBAfter.body?.url;
  await call("POST", "/api/v1/files/" + fileB.fileId + "/recycle", { version: await fileVersion(fileB.fileId), reason: "回放：清理验证" }, admin);
  const purgedB = await call("POST", "/api/v1/files/" + fileB.fileId + "/purge", { version: await fileVersion(fileB.fileId), reason: "回放：清 B（同内容已无引用）" }, admin);
  check("X5", "彻底删除 B（同内容已无存活引用）", "200 + purgedAt 非空", purgedB.status + " " + short(purgedB.body, 160), purgedB.status === 200 && typeof purgedB.body?.purgedAt === "string");

  const rowsAfterB = await artifactCount(fileA.contentHash);
  const objectAfterB = await headOrNull(artifact.object_key);
  check(
    "X6",
    "无剩余引用 → 产物对象与行一并清（`preview_artifacts` 行随版本级联，对象在持锁事务内同序清理）",
    "rows = 0 + 对象不存在",
    short({ rows: rowsAfterB, objectInStorage: objectAfterB === null ? null : "exists" }, 200),
    rowsAfterB === 0 && objectAfterB === null,
  );

  const auditB = await purgeAuditOf(project, fileB.fileId);
  check(
    "X7",
    "B 的 purge 审计：previewArtifactsPurged = 1 / previewArtifactsReassigned = 0",
    "action=delete + metadata {purged: 1, reassigned: 0}",
    short({ action: auditB?.action, metadata: auditB?.metadata, summary: auditB?.summary }, 320),
    auditB?.action === "delete" && auditB?.metadata?.previewArtifactsPurged === 1 && auditB?.metadata?.previewArtifactsReassigned === 0,
  );

  const oldUrlStatus = urlB === undefined ? 0 : await fetch(urlB).then((response) => response.status).catch(() => 0);
  const readerAfterB = await preview(fileB.fileId);
  check(
    "X8",
    "对象已清：清前签发的短时地址再取 → 404；文件已彻底删除 → 读预览 404（不复活产物）",
    "签名地址 404 + 读预览 404",
    short({ signedUrlStatus: oldUrlStatus, previewStatus: readerAfterB.status }, 200),
    oldUrlStatus === 404 && readerAfterB.status === 404,
  );
} catch (error) {
  failures += 1;
  report.push("| FAIL | 中断：" + (error instanceof Error ? error.message : String(error)) + " | ");
  process.stderr.write("M4-05 预览产物清理回放失败：" + (error instanceof Error ? error.message : String(error)) + "\n");
} finally {
  if (db !== undefined) {
    try {
      if (args.keep !== true) {
        for (const projectId of cleanup.projectIds) {
          await db.query("update files set current_version_id = null where project_id = $1", [projectId]);
          await db.query("delete from file_links where file_id in (select id from files where project_id = $1)", [projectId]);
          await db.query("delete from upload_sessions where file_id in (select id from files where project_id = $1)", [projectId]);
          await db.query("delete from preview_artifacts where file_id in (select id from files where project_id = $1)", [projectId]);
          await db.query("delete from file_versions where file_id in (select id from files where project_id = $1)", [projectId]);
          await db.query("delete from files where project_id = $1", [projectId]);
          await db.query("delete from audit_logs where project_id = $1", [projectId]);
          await db.query("delete from outbox_events where payload::text like $$%$$ || $1::text || $$%$$", [projectId]);
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
          for (const contentHash of cleanup.contentHashes) {
            await purgePrefix("previews/" + contentHash + "/").catch(() => undefined);
          }
        }
      }
      for (const token of cleanup.sessions) {
        await db.query("update sessions set revoked_at = now() where token_hash = $1 and revoked_at is null", [sha256(token)]);
      }
    } catch (error) {
      report.push("| WARN | 收尾未完全成功：" + (error instanceof Error ? error.message : String(error)) + " | ");
    }
    await db.end();
  }
}

const commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: serverRoot }).toString().trim();
const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: serverRoot }).toString().trim() !== "";
const lines = [];
lines.push("# M4-05e 回放证据（S7·file 预览产物清理）");
lines.push("");
lines.push("> 卡片：M4-05「在线预览」的收口切片（主责 lan，评审 wmj）｜口径来源：迁移 `0027` 口径 3（彻底删除 / 回收站到期须按 `content_hash` 反查引用，无剩余引用才清对象与行）｜系统功能书 D2-06（同一内容只转换一次）/ A4-12（彻底删除仅管理员、操作留痕）｜ADR-007（三元组缓存键 / 沙箱 / 降级）｜ADR-006（对象键形态）。");
lines.push("> 落点说明：`docs/` 属 px 线；本文件由 lan 随 M4-05 收口卡片代记（回放脚本与断言同 PR，请 px 复核）。");
lines.push("");
lines.push("| 项 | 值 |");
lines.push("|---|---|");
lines.push("| 回放时间 | " + new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 19).replace("T", " ") + " +08:00 |");
lines.push("| 目标 | " + BASE_URL + " |");
lines.push("| 数据库 | " + DATABASE_URL.replace(/:[^:@/]+@/, ":***@") + " |");
lines.push("| 对象存储 | " + (storage === undefined ? "-" : storage.bucket) + "（本地 MinIO 沙箱：仅沙箱、不代表生产选型） |");
lines.push("| 转换沙箱 | " + (process.env.PREVIEW_CONVERTER_URL ?? "-") + "（deploy/preview/，镜像 libiaolink/preview-converter:" + pipelineVersion + "） |");
lines.push("| 代码版本 | " + commit + (dirty ? "（回放时工作区含本卡未提交改动）" : "") + " |");
lines.push("| 执行账号 | 管理员（建项目 / 上传 / 读预览 / 回收 / 彻底删除） |");
lines.push("| 脚本 | server/scripts/m4-preview-cleanup-replay.mjs |");
lines.push("");
lines.push("## 断言明细");
lines.push("");
lines.push(...report);
lines.push("");
lines.push("## 汇总");
lines.push("");
lines.push(failures === 0 ? "- ✅ 全部断言通过（" + evidence.steps.filter((step) => step.ok).length + " 项）：共享三元组缓存 / 有引用则归属转移（不清对象）/ 无引用则清对象与行 / 审计记数 / 不重投 / 不复活。" : "- ❌ 有 " + failures + " 项失败，见上方 FAIL 行。");
lines.push("");
lines.push("## 未覆盖 / 风险登记");
lines.push("");
lines.push("- **回收站到期清理（worker 定时档）走的是同一个 `purgeRecycled`**：真机回放按「管理员手动彻底删除」两条覆盖（A / B），定时档路径由单测 `test/file-service.test.ts` 的 sweep 用例覆盖（`RECYCLE_SWEEP_INTERVAL_MS` = 24 小时，等真实定时档不现实）。");
lines.push("- **反查未加索引**：`findVersionByContentHash` 按 `file_versions.content_hash` 扫描（无索引）。彻底删除是低频批处理，暂可接受；量大后按需补一条只追加索引迁移（登记为后续项）。");
lines.push("- **跨项目同内容**：本脚本的 A / B 在同一项目内；跨项目复用同一三元组是同一逻辑（反查不带项目条件），未单独覆盖。");
lines.push("- **压测未做**：并发 2~4、200MB 级长跑、转换成功率 ≥95%（PoC-1 真实样本集）属 M4-05 压测 / M8 容量验证。");
lines.push("");
lines.push("## 复跑");
lines.push("");
lines.push("```bash");
lines.push("cd deploy/preview && docker compose up -d            # 转换沙箱（首次需 build）");
lines.push("cd server && npm run build && npm run start:api &     # api（BASE_URL）");
lines.push("OUTBOX_POLL_MS=1000 npm run start:worker &            # worker（消费 preview.job）");
lines.push('cd server && M4_DATABASE_URL=postgresql://libiaolink_migrator@127.0.0.1:55432/libiaolink \\');
lines.push('  node --env-file-if-exists=.env scripts/m4-preview-cleanup-replay.mjs --out "../docs/m4-05e-回放证据(预览产物清理).md"');
lines.push("```");
lines.push("");

if (args.json !== undefined) writeFileSync(args.json, JSON.stringify(evidence, null, 2) + "\n", "utf8");
if (args.out !== undefined) writeFileSync(args.out, lines.join("\n"), "utf8");
process.stdout.write(lines.join("\n") + "\n");
process.exit(failures === 0 ? 0 : 1);