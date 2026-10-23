#!/usr/bin/env node
/**
 * M4-05 读 API 真机回放（S7·file 预览读 API · PR-11）：
 *   证据一（not_ready + 幂等补投）：未生成的预览 → 读 API 返回 not_ready，同事务登记产物行 + 投 `preview.job`（trigger=read）；
 *             重复请求不重复登记、不重复投递（去重键 = 三元组）；not_ready **不写审计**。
 *   证据二（ready + 短时签名 · 审计恢复）：worker 转成后 → 读 API 返回 ready，附短时签名地址（可下载、形态正确）；
 *             **ready 读预览写一条 `action = preview` 审计**（2026-10-23 恢复；实际送达才写）。
 *   证据三（A4-06 版本路由）：缺省 = 当前版本；`versionId` 指定历史版本 → 按该版本的内容哈希取三元组（不串版本）。
 *   证据四（404 与禁匿名）：版本不属于该文件 / 文件不存在 → 404（同形，防 IDOR）；无会话 → 401（D2-04 禁匿名）。
 *   证据五（failed 缓存态）：产物为 failed → 返回失败原因（降级「请下载」），**不原地重投**。
 *   证据六（判不出通道）：`.zip` 这类判不出渲染通道的类型 → 终态降级 failed，不落表、不投递、不写审计。
 *
 * 前置：真 PG（DATABASE_URL）+ 真对象存储（S3_*，见 deploy/minio/）+ 真转换沙箱（deploy/preview，默认 http://127.0.0.1:9900）
 *       + 已起 api（BASE_URL）与 worker（消费补投的 preview.job；建议 OUTBOX_POLL_MS=1000 加快回放）。
 *       本脚本只在本地沙箱 / 联调库跑：铸临时管理员会话（跑完撤销）、建 M4PRD- 回放项目
 *       （跑完硬删项目及其文件 / 版本 / 会话 / 关联 / 审计 / outbox 事件 + 清桶内 projects/ 与 previews/ 前缀）。
 * 用法：cd server && M4_DATABASE_URL=postgresql://libiaolink_migrator@127.0.0.1:55432/libiaolink \
 *       node --env-file-if-exists=.env scripts/m4-preview-read-replay.mjs [--out <报告.md>] [--json <证据.json>] [--keep]
 * 退出码：断言全过 = 0，否则 = 1（可当门禁用）。
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
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

/** 回放样例：中文 HTML（soffice 家族 → pdf 通道），便于验证产物可读 + 中文不乱码。 */
const SAMPLE_HTML = Buffer.from(
  "<!doctype html><html><head><meta charset=\"utf-8\"><title>预览读 API 回放</title></head><body>" +
    "<h1>LibiaoLink 预览读 API 回放（M4-05 读面）</h1>" +
    "<p>机械设计图纸 / 技术协议 / 合同评审单：中文排版样例，用于验证读 API 的 ready 产物可用性。</p>" +
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

const preview = (fileId, versionId, session = admin) =>
  call("GET", "/api/v1/files/" + fileId + "/preview" + (versionId === null || versionId === undefined ? "" : "?versionId=" + versionId), undefined, session);

function check(id, title, expected, actual, ok, note = "") {
  if (!ok) failures += 1;
  report.push((ok ? "| PASS | " : "| FAIL | ") + id + " | " + title + " | ");
  report.push("  - 期望：" + expected);
  report.push("  - 实际：" + actual);
  if (note !== "") report.push("  - 说明：" + note);
  evidence.steps.push({ id, title, expected, actual, ok, note });
  process.stdout.write((ok ? "PASS " : "FAIL ") + id + " " + title + "\n");
  if (!ok) throw new Error("M4-05 读 API 回放失败（" + id + "）：" + title);
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
  const payload = Buffer.from(await response.arrayBuffer());
  return { status: response.status, etag: response.headers.get("etag"), text: response.ok ? "" : payload.toString("utf8").slice(0, 300) };
}

/** 走真实上传管道（init → 分片直传 → complete）；intent=version 且给 fileId = 追加版本。 */
async function uploadFile({ projectId, name, bytes, docType, fileId }) {
  const parts = makeParts(bytes);
  const contentHash = sha256(bytes);
  const body = { projectId, name, sizeBytes: bytes.length, contentHash, docType, intent: "version" };
  if (fileId !== undefined) body.fileId = fileId;
  const init = await call("POST", "/api/v1/files/uploads", body, admin);
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

async function artifactOf(contentHash, target = "pdf") {
  const rows = await db.query(
    "select id, file_id, version_id, content_hash, pipeline_version, target, status, object_key, error, generated_at from preview_artifacts where content_hash = $1 and target = $2",
    [contentHash, target],
  );
  return rows.rows;
}

async function jobOf(contentHash, target = "pdf") {
  const rows = await db.query("select id, status, attempts, last_error, dedupe_key, topic, payload from outbox_events where dedupe_key = $1", [
    "preview.job:" + contentHash + ":" + pipelineVersion + ":" + target,
  ]);
  return rows.rows[0];
}

async function jobCountOf(contentHash) {
  const rows = await db.query("select count(*)::int as total from outbox_events where dedupe_key like $1", [
    "preview.job:" + contentHash + ":%",
  ]);
  return rows.rows[0]?.total ?? 0;
}

async function previewAuditOf(projectId) {
  const rows = await db.query(
    "select action, object_type, object_id, project_id, metadata, summary from audit_logs where project_id = $1 and action = 'preview' order by occurred_at",
    [projectId],
  );
  return rows.rows;
}

async function waitForArtifact(contentHash, desired, timeoutMs = DRAIN_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let last = [];
  while (Date.now() < deadline) {
    last = await artifactOf(contentHash);
    if (last.some((row) => row.status === desired)) {
      return last;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return last;
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
let previewTtlSeconds = 300;
const cleanup = { projectIds: [], sessions: [], contentHashes: [] };

try {
  try {
    const envModule = await import(pathToFileURL(join(serverRoot, "dist", "config", "env.js")).href);
    const storageModule = await import(pathToFileURL(join(serverRoot, "dist", "storage", "index.js")).href);
    s3Module = await import("@aws-sdk/client-s3");
    const env = envModule.loadEnv(process.env);
    pipelineVersion = env.PREVIEW_PIPELINE_VERSION;
    previewTtlSeconds = env.PREVIEW_URL_TTL_SECONDS;
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
    "转换沙箱可用且管线版本与 server 配置同值（读 API 的三元组与沙箱产物必须同版本）",
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
    name: "m4-05 读 API 回放项目（预览读面）",
    projectType: "default",
    managerIds: [adminId],
  });
  check("P1", "建回放项目（为 file 提供 projectId）", "201 + 项目可见", created.status + " " + short({ id: created.body?.id, code: created.body?.code }, 120), created.status === 201);
  project = created.body.id;
  cleanup.projectIds.push(project);

  const sample = await uploadFile({ projectId: project, name: "中文样例-M4-05d.html", bytes: SAMPLE_HTML, docType: "技术协议" });
  cleanup.contentHashes.push(sample.contentHash);
  check(
    "F1",
    "上传中文样例（真实上传管道；**上传完成不投递** —— draft 可能被替换，预览走读取侧懒生成）",
    "200 + 版本 v1 + 无 preview.job",
    short({ status: sample.completed.status, version: sample.completed.body?.version?.seq, jobs: await jobCountOf(sample.contentHash) }, 200),
    sample.completed.status === 200 && sample.completed.body?.version?.seq === 1 && (await jobCountOf(sample.contentHash)) === 0,
  );

  // ---------- 证据一：not_ready + 幂等补投（读取侧懒生成） ----------
  const notReady = await preview(sample.fileId);
  const rowsAfterFirst = await artifactOf(sample.contentHash);
  const jobAfterFirst = await jobOf(sample.contentHash);
  check(
    "R1",
    "首次读预览 → not_ready：同事务登记 not_ready 行 + 补投 preview.job（trigger=read，去重键 = 三元组）",
    "status=not_ready + target/url/reason 为空 + 产物行 not_ready + outbox pending + payload.trigger=read",
    short(
      {
        status: notReady.body?.status,
        target: notReady.body?.target,
        url: notReady.body?.url,
        pipelineVersion: notReady.body?.pipelineVersion,
        artifact: rowsAfterFirst[0]?.status,
        job: jobAfterFirst?.status,
        trigger: jobAfterFirst?.payload?.trigger,
      },
      360,
    ),
    notReady.status === 200 &&
      notReady.body?.status === "not_ready" &&
      notReady.body?.target === null &&
      notReady.body?.url === null &&
      notReady.body?.reason === null &&
      notReady.body?.versionId === sample.completed.body.version.id &&
      rowsAfterFirst.length === 1 &&
      rowsAfterFirst[0].status === "not_ready" &&
      rowsAfterFirst[0].version_id === sample.completed.body.version.id &&
      jobAfterFirst?.status === "pending" &&
      jobAfterFirst?.payload?.trigger === "read",
  );

  await preview(sample.fileId);
  await preview(sample.fileId);
  const rowsAfterRepeat = await artifactOf(sample.contentHash);
  check(
    "R2",
    "重复读预览（未就绪期间再读两次）→ 不重复登记、不重复投递（三元组幂等）",
    "产物 1 行 + outbox 1 行",
    short({ artifacts: rowsAfterRepeat.length, jobs: await jobCountOf(sample.contentHash) }, 160),
    rowsAfterRepeat.length === 1 && (await jobCountOf(sample.contentHash)) === 1,
  );

  const auditAfterNotReady = await previewAuditOf(project);
  check(
    "R3",
    "not_ready 不写审计（只有实际送达就绪内容才写）",
    "preview 审计 0 条",
    short({ previewAudits: auditAfterNotReady.length }, 160),
    auditAfterNotReady.length === 0,
  );

  // ---------- 证据二：ready + 短时签名 + 审计 ----------
  const readyRows = await waitForArtifact(sample.contentHash, "ready");
  check(
    "W1",
    "worker 消费补投的任务 → 产物转 ready（读取侧懒生成闭环：not_ready → 转换 → ready）",
    "preview_artifacts.status = ready + object_key = previews/{hash}/{pipeline}/{target}",
    short({ status: readyRows[0]?.status, objectKey: readyRows[0]?.object_key, outbox: (await jobOf(sample.contentHash))?.status }, 260),
    readyRows[0]?.status === "ready" &&
      readyRows[0]?.object_key === "previews/" + sample.contentHash + "/" + pipelineVersion + "/pdf" &&
      (await jobOf(sample.contentHash))?.status === "done",
  );

  const beforeReadyRead = Date.now();
  const readyRead = await preview(sample.fileId);
  const expiresAtMs = readyRead.body?.expiresAt === null ? 0 : Date.parse(readyRead.body?.expiresAt);
  const ttlSeconds = Math.round((expiresAtMs - beforeReadyRead) / 1000);
  check(
    "R4",
    "ready 读预览：三态字段齐全（url / expiresAt / pipelineVersion / generatedAt）且 target = pdf",
    "status=ready + target=pdf + url 非空 + pipelineVersion=" + pipelineVersion + " + generatedAt 非空",
    short(
      {
        status: readyRead.body?.status,
        target: readyRead.body?.target,
        urlHost: readyRead.body?.url === null ? null : String(readyRead.body?.url).replace(/\?.*$/, ""),
        pipelineVersion: readyRead.body?.pipelineVersion,
        generatedAt: readyRead.body?.generatedAt,
        reason: readyRead.body?.reason,
      },
      360,
    ),
    readyRead.status === 200 &&
      readyRead.body?.status === "ready" &&
      readyRead.body?.target === "pdf" &&
      typeof readyRead.body?.url === "string" &&
      readyRead.body?.pipelineVersion === pipelineVersion &&
      readyRead.body?.generatedAt !== null &&
      readyRead.body?.reason === null,
  );

  check(
    "R5",
    "短时签名窗口 = PREVIEW_URL_TTL_SECONDS（D2-04：地址短时有效，过期需重新请求）",
    "expiresAt 距现在 ≈ " + previewTtlSeconds + "s（容差 -5s ~ +10s）",
    "实际 " + ttlSeconds + "s（" + readyRead.body?.expiresAt + "）",
    ttlSeconds >= previewTtlSeconds - 5 && ttlSeconds <= previewTtlSeconds + 10,
  );

  const signedResponse = await fetch(readyRead.body.url);
  const signedBytes = Buffer.from(await signedResponse.arrayBuffer());
  const signedHead = signedBytes.subarray(0, 5).toString("latin1");
  const signedHasCjk = /Noto[A-Za-z]*CJK/.test(signedBytes.toString("latin1"));
  check(
    "R6",
    "签名地址可直接取回产物（对象存储禁匿名 → 地址即鉴权）：200 + %PDF- + 内嵌 Noto CJK",
    "200 + %PDF- + 字体名含 Noto…CJK",
    short({ status: signedResponse.status, head: signedHead, sizeBytes: signedBytes.length, cjkFont: signedHasCjk }, 220),
    signedResponse.status === 200 && signedHead === "%PDF-" && signedHasCjk,
  );

  const auditsAfterReady = await previewAuditOf(project);
  check(
    "R7",
    "ready 读预览写一条 preview 审计（2026-10-23 恢复）",
    "preview 审计 1 条",
    short({ previewAudits: auditsAfterReady.length }, 160),
    auditsAfterReady.length === 1,
  );

  // ---------- 证据三：版本路由（A4-06） ----------
  const secondBytes = Buffer.from(SAMPLE_HTML.toString("utf8").replace("M4-05 读面", "M4-05 读面（v2）"), "utf8");
  const v2 = await uploadFile({ projectId: project, name: "中文样例-M4-05d.html", bytes: secondBytes, docType: "技术协议", fileId: sample.fileId });
  cleanup.contentHashes.push(v2.contentHash);
  const v1Id = sample.completed.body.version.id;
  const detail = await call("GET", "/api/v1/files/" + sample.fileId, undefined, admin);
  const currentVersionId = detail.body?.currentVersion?.id;
  const currentRead = await preview(sample.fileId);
  const historyRead = await preview(sample.fileId, v1Id);
  const currentJobs = await jobCountOf(v2.contentHash);
  const historyJobs = await jobCountOf(sample.contentHash);
  check(
    "V1",
    "版本路由（A4-06）：缺省 = 当前版本（v2 内容哈希，尚未生成 → not_ready 并补投）；versionId 指定历史版本 → 按该版本三元组（v1 已 ready，不串版本、不重复投递）",
    "详情 currentVersion = v2；缺省读 → v2 + not_ready + v2 三元组 1 条任务；指定 v1 → v1 + ready + v1 三元组仍 1 条任务",
    short(
      {
        v2Upload: { status: v2.completed.status, seq: v2.completed.body?.version?.seq },
        detailCurrent: currentVersionId === v2.completed.body.version.id ? "v2" : currentVersionId === v1Id ? "v1" : currentVersionId,
        current: { status: currentRead.body?.status, versionId: currentRead.body?.versionId === v2.completed.body.version.id ? "v2" : currentRead.body?.versionId, jobs: currentJobs },
        history: { status: historyRead.body?.status, versionId: historyRead.body?.versionId === v1Id ? "v1" : historyRead.body?.versionId, jobs: historyJobs },
      },
      420,
    ),
    v2.completed.status === 200 &&
      currentVersionId === v2.completed.body.version.id &&
      currentRead.status === 200 &&
      currentRead.body?.versionId === v2.completed.body.version.id &&
      currentRead.body?.status === "not_ready" &&
      currentJobs === 1 &&
      historyRead.status === 200 &&
      historyRead.body?.versionId === v1Id &&
      historyRead.body?.status === "ready" &&
      historyJobs === 1,
    "v1 的产物在证据二已 ready；指定 v1 读的仍是同一三元组（不再新增任务）；v2 尚未生成 → 读取侧懒生成补投",
  );

  // ---------- 证据四：404 与禁匿名 ----------
  const unknownVersion = await preview(sample.fileId, randomUUID());
  check("N1", "versionId 不属于该文件 / 不存在 → 404（防 IDOR，不泄露文件存在性之外的信息）", "404", unknownVersion.status + " " + short(unknownVersion.body?.error ?? unknownVersion.body, 120), unknownVersion.status === 404);

  const unknownFile = await preview(randomUUID());
  check("N2", "文件不存在 → 404（与不可见同形）", "404", unknownFile.status + " " + short(unknownFile.body?.error ?? unknownFile.body, 120), unknownFile.status === 404);

  const anonymous = await preview(sample.fileId, null, null);
  check("N3", "禁匿名（D2-04：预览地址短时签名 + 访问需鉴权）→ 无会话请求 401", "401", anonymous.status + " " + short(anonymous.body?.error ?? anonymous.body, 120), anonymous.status === 401);

  // ---------- 证据五：failed 缓存态（降级「请下载」，不原地重投） ----------
  const failingBytes = Buffer.from(SAMPLE_HTML.toString("utf8").replace("M4-05 读面", "M4-05 读面（失败缓存态）"), "utf8");
  const failing = await uploadFile({ projectId: project, name: "中文样例-M4-05d-failed.html", bytes: failingBytes, docType: "技术协议" });
  cleanup.contentHashes.push(failing.contentHash);
  await db.query(
    "insert into preview_artifacts (file_id, version_id, content_hash, pipeline_version, target, status, error) values ($1, $2, $3, $4, $5, 'failed', $6)",
    [failing.fileId, failing.completed.body.version.id, failing.contentHash, pipelineVersion, "pdf", "回放注入：模拟转换确定性失败（CONVERT_FAILED），降级「请下载查看」"],
  );
  const failedRead = await preview(failing.fileId);
  check(
    "X1",
    "产物为 failed（缓存态）→ 返回失败原因并降级「请下载」；**不原地重投**（等 pipeline_version 递增才失效）",
    "status=failed + reason 非空 + pipelineVersion 回填 + outbox 0 行",
    short({ status: failedRead.body?.status, reason: failedRead.body?.reason, pipelineVersion: failedRead.body?.pipelineVersion, jobs: await jobCountOf(failing.contentHash) }, 360),
    failedRead.status === 200 &&
      failedRead.body?.status === "failed" &&
      typeof failedRead.body?.reason === "string" &&
      failedRead.body.reason.length <= 500 &&
      failedRead.body?.pipelineVersion === pipelineVersion &&
      failedRead.body?.url === null &&
      (await jobCountOf(failing.contentHash)) === 0,
  );

  // ---------- 证据六：判不出通道（终态降级，不落表不投递） ----------
  const zip = await uploadFile({
    projectId: project,
    name: "交付包-M4-05d.zip",
    bytes: Buffer.from("PK\u0003\u0004 m4-05d replay zip placeholder", "binary"),
    docType: "合同",
  });
  cleanup.contentHashes.push(zip.contentHash);
  const auditsBeforeZip = (await previewAuditOf(project)).length;
  const zipRead = await preview(zip.fileId);
  const zipAudits = await previewAuditOf(project);
  check(
    "Z1",
    "判不出渲染通道的类型（.zip）→ 终态降级 failed（不落表、不投递、不写审计），前端轮询有终点",
    "status=failed + reason 含「暂不支持在线预览」+ 产物 0 行 + outbox 0 行 + 审计不增",
    short({ status: zipRead.body?.status, reason: zipRead.body?.reason, artifacts: (await artifactOf(zip.contentHash)).length, jobs: await jobCountOf(zip.contentHash), previewAuditsBefore: auditsBeforeZip, previewAuditsAfter: zipAudits.length }, 360),
    zipRead.status === 200 &&
      zipRead.body?.status === "failed" &&
      String(zipRead.body?.reason).includes("暂不支持在线预览") &&
      (await artifactOf(zip.contentHash)).length === 0 &&
      (await jobCountOf(zip.contentHash)) === 0 &&
      zipAudits.length === auditsBeforeZip,
  );
} catch (error) {
  failures += 1;
  report.push("| FAIL | 中断：" + (error instanceof Error ? error.message : String(error)) + " | ");
  process.stderr.write("M4-05 读 API 回放失败：" + (error instanceof Error ? error.message : String(error)) + "\n");
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
lines.push("# M4-05d 回放证据（S7·file 预览读 API）");
lines.push("");
lines.push("> 卡片：M4-05「在线预览」的读面切片（主责 lan，评审 wmj）｜口径来源：系统功能书 D2-04（短时签名 + 禁匿名）/ D2-05（失败降级「请下载」）/ D2-07（预览审计 2026-10-23 恢复：实际送达就绪内容写一条）｜技术设计v0.3 §3.5（M4-05 预览：短时签名 + 审计 + 禁匿名）｜v0.2 §7.2（`PREVIEW_NOT_READY` / `PREVIEW_FAILED` 的 200 语义）｜ADR-007（缓存键三元组 / 降级不阻塞下载）｜契约 `FilePreviewResponse`。");
lines.push("> 落点说明：`docs/` 属 px 线；本文件由 lan 随 M4-05 读面卡片代记（回放脚本与断言同 PR，请 px 复核）。");
lines.push("");
lines.push("| 项 | 值 |");
lines.push("|---|---|");
lines.push("| 回放时间 | " + new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 19).replace("T", " ") + " +08:00 |");
lines.push("| 目标 | " + BASE_URL + " |");
lines.push("| 数据库 | " + DATABASE_URL.replace(/:[^:@/]+@/, ":***@") + " |");
lines.push("| 对象存储 | " + (storage === undefined ? "-" : storage.bucket) + "（本地 MinIO 沙箱：仅沙箱、不代表生产选型） |");
lines.push("| 转换沙箱 | " + (process.env.PREVIEW_CONVERTER_URL ?? "-") + "（deploy/preview/，镜像 libiaolink/preview-converter:" + pipelineVersion + "） |");
lines.push("| 签名窗口 | " + previewTtlSeconds + "s（`PREVIEW_URL_TTL_SECONDS`） |");
lines.push("| 代码版本 | " + commit + (dirty ? "（回放时工作区含本卡未提交改动）" : "") + " |");
lines.push("| 执行账号 | 管理员（建项目 / 上传 / 读预览）；另有**匿名**请求一条（401 断言） |");
lines.push("| 脚本 | server/scripts/m4-preview-read-replay.mjs |");
lines.push("");
lines.push("## 断言明细");
lines.push("");
lines.push(...report);
lines.push("");
lines.push("## 汇总");
lines.push("");
lines.push(failures === 0 ? "- ✅ 全部断言通过（" + evidence.steps.filter((step) => step.ok).length + " 项）：三态（ready / not_ready / failed）/ 读取侧幂等补投与懒生成闭环 / 短时签名与窗口 / 预览实际送达写一条审计 / 版本路由与 404 / 禁匿名 / 判不出通道终态降级。" : "- ❌ 有 " + failures + " 项失败，见上方 FAIL 行。");
lines.push("");
lines.push("## 未覆盖 / 风险登记");
lines.push("");
lines.push("- **压测未做**：并发 2~4、200MB 级长跑内存曲线、转换成功率 ≥95%（PoC-1 真实样本集）不在本脚本范围（属 M4-05 压测 / M8 容量验证）。");
lines.push("- **failed 注入方式**：证据五的 failed 产物行由脚本直接注入（模拟转换确定性失败），而非等真实转换失败 —— 真实失败如何写 failed 由 M4-05c 证据（超大源文件 / `.zip` 不投递）覆盖；本脚本只证**读面在 failed 缓存态下的行为**（回原因、不原地重投）。");
lines.push("- **预览产物对象的清理未接**：彻底删除 / 回收站到期目前只清 `projects/` 前缀下的版本对象，`previews/` 前缀的产物对象需按 `content_hash` 反查引用后清理（M4-05 收口项）。");
lines.push("- **枚举边界**：v1 历史版本在证据二已经 ready，证据三只断言「按版本路由到对应三元组」，未重复覆盖 ready 分支。");
lines.push("");
lines.push("## 复跑");
lines.push("");
lines.push("```bash");
lines.push("cd deploy/preview && docker compose up -d            # 转换沙箱（首次需 build）");
lines.push("cd server && npm run build && npm run start:api &     # api（BASE_URL）");
lines.push("OUTBOX_POLL_MS=1000 npm run start:worker &            # worker（消费补投的 preview.job）");
lines.push('cd server && M4_DATABASE_URL=postgresql://libiaolink_migrator@127.0.0.1:55432/libiaolink \\');
lines.push('  node --env-file-if-exists=.env scripts/m4-preview-read-replay.mjs --out "../docs/m4-05d-回放证据(预览读API).md"');
lines.push("```");
lines.push("");

if (args.json !== undefined) writeFileSync(args.json, JSON.stringify(evidence, null, 2) + "\n", "utf8");
if (args.out !== undefined) writeFileSync(args.out, lines.join("\n"), "utf8");
process.stdout.write(lines.join("\n") + "\n");
process.exit(failures === 0 ? 0 : 1);