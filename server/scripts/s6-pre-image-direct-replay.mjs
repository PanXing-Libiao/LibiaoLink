#!/usr/bin/env node
/**
 * S6-前置 回放证据（图片直通 · 原对象直签）真机回放 —— 计划 §4「S6-前置」出口条件（转换器停机态）：
 *   S0  api 可用 + 转换器停机复核（`PREVIEW_CONVERTER_URL` 无监听 —— 出口条件前置，在线则拒绝执行）；
 *   F1  上传 1×1 真 PNG（真实上传管道 init → 分片直传 → complete）；
 *   I1  图片预览：`GET /files/{id}/preview` = ready + target=image + url 短时签名（原对象）+ pipelineVersion / generatedAt 空；
 *   I2  字节直出：url 直取 sha256 = 上传夹具全等（非转换件）+ PNG magic + Content-Type=image/png + 非 attachment；
 *   I3  签名形状：pathname = /{bucket}/{version.objectKey} + X-Amz-Expires = PREVIEW_URL_TTL_SECONDS；
 *   I4  预览审计（2026-10-23 恢复）：图片直签实际送达写 action = preview 1 条；
 *   I5  零投递 / 零产物：outbox 无 preview.job 行、preview_artifacts 0 行（读取不发任务、不落产物行）；
 *   F2  追加 v2（同文件新 PNG）；I6 版本路由：缺省签 v2、?versionId=v1 签 v1（字节分别全等、不串版本）；
 *   I7  定档（P1 触发点）：finalize 后仍零投递 / 零产物行（previewTargetsFor 空表 → 预生成循环空转）；
 *   I8  PDF 对照（非图片不受影响）：ready + viewer.documentType=pdf、url / target 空（查看器通道）。
 *
 * 前置：真 PG + 真 MinIO + 已起 api（BASE_URL）；`deploy/preview` **已停**（cd deploy/preview && docker compose down）。
 * 用法：cd server && S6_PRE_DATABASE_URL=postgresql://libiaolink_migrator@127.0.0.1:55432/libiaolink \
 *         node --env-file-if-exists=.env scripts/s6-pre-image-direct-replay.mjs \
 *         [--out <报告.md>] [--json <证据.json>] [--keep] [--base-url <api>] [--database-url <pg>] [--converter-url <url>]
 *         （库侧收尾含 audit_logs 删除：用 migrator 角色 —— 与 m4 / s8 系列回放同口径）
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
const BASE_URL = args.baseUrl ?? process.env.S6_PRE_BASE_URL ?? process.env.BASE_URL ?? "http://127.0.0.1:3011";
const DATABASE_URL =
  args.databaseUrl ?? process.env.S6_PRE_DATABASE_URL ?? process.env.DATABASE_URL ?? "postgresql://libiaolink_migrator@127.0.0.1:55432/libiaolink";
const report = [];
const evidence = { steps: [] };
let failures = 0;
let db;
let admin;
let adminId;
let storage;
let rawClient;
let s3Module;
let storageModule;
let previewTtlSeconds = 300;
let converterUrl = "http://127.0.0.1:9900";
let project = "";
let imageFileId = "";
let v1Id = "";
let v1Key = "";
let v2Id = "";
let v2Key = "";
const cleanup = { projectIds: [], sessions: [] };

/** 夹具：真 PNG（1×1）—— A 红点（前端 m4-07 同款）/ B 蓝点（本脚本生成，CRC 已对照真 PNG 校验、inflate 往返一致）。 */
const PNG_A = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const PNG_B = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYPj/HwADAgH/5ncLrgAAAABJRU5ErkJggg==",
  "base64",
);

/** 结构合法的最小单页 PDF（前端 m4-07 同款生成器）—— I8 对照用。 */
function minimalPdf(text) {
  const stream = "BT /F1 12 Tf 20 100 Td (" + text + ") Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    "<< /Length " + String(Buffer.byteLength(stream, "latin1")) + " >>\nstream\n" + stream + "\nendstream",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [];
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(Buffer.byteLength(pdf, "latin1"));
    pdf += String(index + 1) + " 0 obj\n" + objects[index] + "\nendobj\n";
  }
  const xref = Buffer.byteLength(pdf, "latin1");
  pdf += "xref\n0 " + String(objects.length + 1) + "\n0000000000 65535 f \n";
  for (const offset of offsets) {
    pdf += String(offset).padStart(10, "0") + " 00000 n \n";
  }
  pdf += "trailer\n<< /Size " + String(objects.length + 1) + " /Root 1 0 R >>\nstartxref\n" + String(xref) + "\n%%EOF\n";
  return Buffer.from(pdf, "latin1");
}
const SAMPLE_PDF = minimalPdf("LibiaoLink s6-pre replay pdf");

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (item === "--out") out.out = argv[++i];
    else if (item === "--json") out.json = argv[++i];
    else if (item === "--base-url") out.baseUrl = argv[++i];
    else if (item === "--database-url") out.databaseUrl = argv[++i];
    else if (item === "--converter-url") out.converterUrl = argv[++i];
    else if (item === "--keep") out.keep = true;
  }
  return out;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function makeSession(userId, idToken) {
  const session = { userId, token: "s6pre-" + randomBytes(16).toString("hex"), csrf: randomBytes(16).toString("hex") };
  await db.query("insert into sessions (token_hash, user_id, id_token, expires_at) values ($1, $2, $3, now() + interval '2 hours')", [
    sha256(session.token),
    userId,
    idToken,
  ]);
  return session;
}

async function call(method, path, body, session = admin, extraHeaders = {}) {
  const headers = { "content-type": "application/json", ...extraHeaders };
  if (session !== null) {
    headers.cookie = "ll_sid=" + session.token + "; ll_csrf=" + session.csrf;
    headers["x-csrf-token"] = session.csrf;
  }
  const response = await fetch(BASE_URL + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
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
  if (!ok) throw new Error("S6-前置 图片直通回放失败（" + id + "）：" + title);
}

function short(value, max = 320) {
  const text = JSON.stringify(value);
  return text === undefined ? "undefined" : text.length > max ? text.slice(0, max) + "…" : text;
}

function makeParts(bytes) {
  const parts = [];
  for (let offset = 0; offset < bytes.length; offset += 8 * 1024 * 1024) {
    parts.push(bytes.subarray(offset, Math.min(offset + 8 * 1024 * 1024, bytes.length)));
  }
  return parts;
}

async function putPart(url, body) {
  const response = await fetch(url, { method: "PUT", body });
  const payload = Buffer.from(await response.arrayBuffer());
  return { status: response.status, etag: response.headers.get("etag"), text: response.ok ? "" : payload.toString("utf8").slice(0, 300) };
}

/** 走真实上传管道（init → 分片直传 → complete）；fileId 给出 = 对既有 draft 文件追加版本。 */
async function uploadFile({ projectId, fileId, name, bytes, mime }) {
  const parts = makeParts(bytes);
  const contentHash = sha256(bytes);
  const init = await call(
    "POST",
    "/api/v1/files/uploads",
    fileId === undefined
      ? { projectId, name, sizeBytes: bytes.length, mime, contentHash, intent: "version" }
      : { projectId, name, fileId, sizeBytes: bytes.length, mime, contentHash, intent: "version" },
  );
  const targetFileId = init.body?.file?.id;
  const uploadId = init.body?.upload?.id;
  if (targetFileId === undefined || uploadId === undefined) {
    return { init, fileId: targetFileId, uploadId, contentHash, completed: { status: 0, body: null } };
  }
  const signed = await call("POST", "/api/v1/files/" + targetFileId + "/uploads/" + uploadId + "/parts", {
    partNumbers: parts.map((_unused, index) => index + 1),
  });
  for (let index = 0; index < parts.length; index += 1) {
    await putPart(signed.body.parts[index].url, parts[index]);
  }
  const completed = await call("POST", "/api/v1/files/" + targetFileId + "/uploads/" + uploadId + "/complete", { contentHash });
  return { init, fileId: targetFileId, uploadId, contentHash, completed };
}

async function previewAuditsOf(projectId) {
  const rows = await db.query(
    "select action, object_type, object_id, metadata, summary from audit_logs where project_id = $1 and action = 'preview' order by occurred_at",
    [projectId],
  );
  return rows.rows;
}

async function artifactCountOf(fileId) {
  const rows = await db.query("select count(*)::int as n from preview_artifacts where file_id = $1", [fileId]);
  return rows.rows[0].n;
}

async function jobCountOf(projectId) {
  const rows = await db.query("select count(*)::int as n from outbox_events where topic = 'preview.job' and payload->>'projectId' = $1", [
    projectId,
  ]);
  return rows.rows[0].n;
}

async function fetchSigned(url) {
  const response = await fetch(url);
  const bytes = Buffer.from(await response.arrayBuffer());
  return {
    status: response.status,
    bytes,
    hash: sha256(bytes),
    contentType: response.headers.get("content-type"),
    disposition: response.headers.get("content-disposition"),
  };
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

/** 转换器停机复核：0 = 连接拒绝 / 超时（停机）；任一 HTTP 响应 = 仍在线（出口条件不满足）。 */
async function converterStatus() {
  try {
    const response = await fetch(converterUrl + "/healthz", { signal: AbortSignal.timeout(2500) });
    return response.status;
  } catch {
    return 0;
  }
}

function signedPath(url) {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

try {
  try {
    const envModule = await import(pathToFileURL(join(serverRoot, "dist", "config", "env.js")).href);
    storageModule = await import(pathToFileURL(join(serverRoot, "dist", "storage", "index.js")).href);
    s3Module = await import("@aws-sdk/client-s3");
    const env = envModule.loadEnv(process.env);
    storage = storageModule.createS3ObjectStorage(env);
    rawClient = storageModule.createS3Client(env);
    previewTtlSeconds = env.PREVIEW_URL_TTL_SECONDS;
    converterUrl = args.converterUrl ?? env.PREVIEW_CONVERTER_URL;
  } catch (error) {
    throw new Error("无法加载 dist / 预览环境（先 npm run build，并用 --env-file-if-exists=.env 带上 PREVIEW_* / S3_*）：" + String(error));
  }

  db = new Client({ connectionString: DATABASE_URL });
  await db.connect();

  // ---------- S0：依赖就绪 + 转换器停机态（出口条件前置） ----------
  const health = await fetch(BASE_URL + "/healthz").then((response) => response.status).catch(() => 0);
  const ready = await fetch(BASE_URL + "/readyz").then((response) => response.status).catch(() => 0);
  check("S0a", "api 可用（/healthz + /readyz：含存储探针）", "200 / 200", health + " / " + ready, health === 200 && ready === 200);

  const converter = await converterStatus();
  check(
    "S0b",
    "转换器停机态（S6-前置 出口条件）：`PREVIEW_CONVERTER_URL` 无监听",
    "0（连接拒绝 / 超时）",
    converter + "（" + converterUrl + "）",
    converter === 0,
    "任一 HTTP 响应 = 转换器仍在线，出口条件不满足 —— 先 `cd deploy/preview && docker compose down` 再复跑",
  );

  // ---------- P1 / F1：铸会话 → 建回放项目 → 上传 v1 真 PNG ----------
  const adminRow = await db.query(
    "select u.id from users u join user_roles ur on ur.user_id = u.id join roles r on r.id = ur.role_id where r.code = $1 and u.status = $2 order by u.id limit 1",
    ["admin", "active"],
  );
  adminId = adminRow.rows[0]?.id;
  if (adminId === undefined) throw new Error("找不到可用的管理员账号（roles.code = admin）");
  admin = await makeSession(adminId, "s6pre-replay-admin");
  cleanup.sessions.push(admin.token);

  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const created = await call("POST", "/api/v1/projects", {
    code: "S6PRE-" + stamp,
    name: "S6-前置 图片直通回放项目",
    projectType: "default",
    managerIds: [adminId],
  });
  check("P1", "建回放项目（为 file 提供 projectId）", "201 + 项目可见", created.status + " " + short({ id: created.body?.id }, 120), created.status === 201);
  project = created.body.id;
  cleanup.projectIds.push(project);

  const up1 = await uploadFile({ projectId: project, name: "回放-现场图-A.png", bytes: PNG_A, mime: "image/png" });
  imageFileId = up1.fileId;
  v1Id = up1.completed.body?.version?.id;
  check(
    "F1",
    "上传 1×1 真 PNG（init → 分片直传 → complete）",
    "200 + 版本 v1 + contentHash 与夹具一致",
    short({ status: up1.completed.status, seq: up1.completed.body?.version?.seq, hash: String(up1.contentHash).slice(0, 12) + "…" }, 200),
    up1.completed.status === 200 && up1.completed.body?.version?.seq === 1 && up1.contentHash === sha256(PNG_A),
  );
  v1Key = (await db.query("select object_key from file_versions where id = $1", [v1Id])).rows[0].object_key;

  // ---------- I1：图片预览就绪形态（ready / target=image / 产物字段空） ----------
  const p1 = await call("GET", "/api/v1/files/" + imageFileId + "/preview", undefined, admin);
  const url1 = typeof p1.body?.url === "string" ? p1.body.url : "";
  const parsed1 = signedPath(url1);
  const expiresAt1 = p1.body?.expiresAt === undefined || p1.body?.expiresAt === null ? null : new Date(p1.body.expiresAt).getTime();
  const ttl1 = expiresAt1 === null ? null : Math.round((expiresAt1 - Date.now()) / 1000);
  check(
    "I1",
    "图片预览：ready + target=image + url 短时签名（原对象）+ pipelineVersion / generatedAt 空",
    "ready + target=image + url 非空 + viewer/reason 空 + 产物字段空 + 窗口 ≈ " + previewTtlSeconds + "s",
    short(
      {
        status: p1.body?.status,
        target: p1.body?.target,
        urlLen: url1.length,
        viewer: p1.body?.viewer,
        pipelineVersion: p1.body?.pipelineVersion,
        generatedAt: p1.body?.generatedAt,
        ttlSeconds: ttl1,
      },
      360,
    ),
    p1.status === 200 &&
      p1.body?.status === "ready" &&
      p1.body?.target === "image" &&
      url1.length > 0 &&
      p1.body?.viewer === null &&
      p1.body?.reason === null &&
      p1.body?.pipelineVersion === null &&
      p1.body?.generatedAt === null &&
      p1.body?.versionId === v1Id &&
      ttl1 !== null &&
      ttl1 >= previewTtlSeconds - 30 &&
      ttl1 <= previewTtlSeconds + 5,
  );

  // ---------- I2：字节直出（原对象，非转换件） ----------
  const fetched1 = await fetchSigned(url1);
  check(
    "I2",
    "字节直出（非转换件）：url 直取 sha256 = 上传夹具全等 + PNG magic + Content-Type=image/png + 非 attachment",
    "200 + sha256=" + sha256(PNG_A).slice(0, 12) + "… + magic=89504e47 + content-type=image/png",
    short(
      {
        status: fetched1.status,
        hash: fetched1.hash.slice(0, 12) + "…",
        magic: fetched1.bytes.subarray(0, 4).toString("hex"),
        contentType: fetched1.contentType,
        disposition: fetched1.disposition,
      },
      360,
    ),
    fetched1.status === 200 &&
      fetched1.hash === sha256(PNG_A) &&
      fetched1.bytes.subarray(0, 4).toString("hex") === "89504e47" &&
      String(fetched1.contentType).startsWith("image/png") &&
      !String(fetched1.disposition ?? "").startsWith("attachment"),
  );

  // ---------- I3：签名形状（原对象键 + 窗口） ----------
  const expiresParam = parsed1 === null ? null : parsed1.searchParams.get("X-Amz-Expires");
  check(
    "I3",
    "签名形状：pathname = /{bucket}/{version.objectKey} + X-Amz-Expires = PREVIEW_URL_TTL_SECONDS + 有签名参数",
    "pathname = /" + storage.bucket + "/{v1 objectKey} + expires = " + previewTtlSeconds,
    short(
      {
        pathname: parsed1?.pathname,
        expires: expiresParam,
        hasSignature: parsed1 === null ? false : parsed1.searchParams.has("X-Amz-Signature"),
      },
      360,
    ),
    parsed1 !== null &&
      parsed1.pathname === "/" + storage.bucket + "/" + v1Key &&
      (expiresParam === null || Number(expiresParam) === previewTtlSeconds) &&
      parsed1.searchParams.has("X-Amz-Signature"),
  );

  // ---------- I4：预览审计（2026-10-23 恢复：实际送达写一条） ----------
  const audits1 = await previewAuditsOf(project);
  check(
    "I4",
    "预览审计（2026-10-23 恢复）：图片直签实际送达写一条 audit_logs.action = preview",
    "1 条（versionId = v1 + direct = true）",
    short({ count: audits1.length }, 200),
    audits1.length === 1 && audits1[0].metadata?.versionId === v1Id && audits1[0].metadata?.direct === true,
  );

  // ---------- I5：零投递 / 零产物行 ----------
  const jobs1 = await jobCountOf(project);
  const artifacts1 = await artifactCountOf(imageFileId);
  check(
    "I5",
    "零投递 / 零产物行：outbox 无 preview.job、preview_artifacts 0 行（读取不发任务、不落产物行）",
    "jobs=0 + artifacts=0",
    short({ jobs: jobs1, artifacts: artifacts1 }, 200),
    jobs1 === 0 && artifacts1 === 0,
  );

  // ---------- F2 / I6：追加 v2 → 版本路由（缺省 v2 / 历史 v1） ----------
  // 追加版本：name 须与目标文件一致（契约「填写则须与目标文件一致，不一致 400」）—— 传 v1 原名。
  const up2 = await uploadFile({ projectId: project, name: "回放-现场图-A.png", fileId: imageFileId, bytes: PNG_B, mime: "image/png" });
  v2Id = up2.completed.body?.version?.id;
  check(
    "F2",
    "追加 v2（同文件、新 PNG 蓝点）：draft 期替换 / 追加版本",
    "200 + 版本 v2 + hash 与夹具 B 一致",
    short({ status: up2.completed.status, seq: up2.completed.body?.version?.seq, hash: String(up2.contentHash).slice(0, 12) + "…" }, 200),
    up2.completed.status === 200 && up2.completed.body?.version?.seq === 2 && up2.contentHash === sha256(PNG_B),
  );
  v2Key = (await db.query("select object_key from file_versions where id = $1", [v2Id])).rows[0].object_key;

  const p2 = await call("GET", "/api/v1/files/" + imageFileId + "/preview", undefined, admin);
  const parsed2 = signedPath(typeof p2.body?.url === "string" ? p2.body.url : "");
  const fetched2 = p2.body?.url === null || p2.body?.url === undefined ? { status: 0, hash: "", contentType: null } : await fetchSigned(p2.body.url);
  const audits2 = await previewAuditsOf(project);
  check(
    "I6a",
    "缺省预览 = 当前版本（v2）：签 v2 原对象 + 字节全等（夹具 B）",
    "ready + pathname 含 v2 objectKey + sha256(B) + 预览审计 2 条（累计）",
    short({ status: p2.body?.status, pathname: parsed2?.pathname, hash: fetched2.hash.slice(0, 12) + "…", audits: audits2.length }, 360),
    p2.body?.status === "ready" &&
      parsed2 !== null &&
      parsed2.pathname === "/" + storage.bucket + "/" + v2Key &&
      fetched2.hash === sha256(PNG_B) &&
      audits2.length === 2,
  );

  const p3 = await call("GET", "/api/v1/files/" + imageFileId + "/preview?versionId=" + v1Id, undefined, admin);
  const parsed3 = signedPath(typeof p3.body?.url === "string" ? p3.body.url : "");
  const fetched3 = p3.body?.url === null || p3.body?.url === undefined ? { status: 0, hash: "" } : await fetchSigned(p3.body.url);
  const audits3 = await previewAuditsOf(project);
  check(
    "I6b",
    "历史版本（?versionId=v1）：签 v1 原对象 + 字节全等（夹具 A），版本路由不经审计断言",
    "ready + pathname 含 v1 objectKey + sha256(A) + 预览审计 3 条（累计）",
    short({ status: p3.body?.status, pathname: parsed3?.pathname, hash: fetched3.hash.slice(0, 12) + "…", audits: audits3.length }, 360),
    p3.body?.status === "ready" &&
      parsed3 !== null &&
      parsed3.pathname === "/" + storage.bucket + "/" + v1Key &&
      fetched3.hash === sha256(PNG_A) &&
      audits3.length === 3,
  );

  // ---------- I7：定档（P1 触发点）后仍零投递 / 零产物行 ----------
  const fileVersion = (await db.query("select version from files where id = $1", [imageFileId])).rows[0].version;
  const fin = await call("POST", "/api/v1/files/" + imageFileId + "/finalize", { version: fileVersion }, admin);
  const jobsAfterFin = await jobCountOf(project);
  const artifactsAfterFin = await artifactCountOf(imageFileId);
  check(
    "I7",
    "定档（P1 触发点）后仍零投递 / 零产物行：`previewTargetsFor` 空表 → 预生成循环空转",
    "200 + status=final + jobs=0 + artifacts=0",
    short({ status: fin.status, fileStatus: fin.body?.status, jobs: jobsAfterFin, artifacts: artifactsAfterFin }, 240),
    fin.status === 200 && fin.body?.status === "final" && jobsAfterFin === 0 && artifactsAfterFin === 0,
  );

  // ---------- I8：PDF 对照（查看器通道不受影响） ----------
  const pdfUp = await uploadFile({ projectId: project, name: "回放-对照.pdf", bytes: SAMPLE_PDF, mime: "application/pdf" });
  const pdfFileId = pdfUp.fileId;
  const pdfPreview = await call("GET", "/api/v1/files/" + pdfFileId + "/preview", undefined, admin);
  const pdfJobs = await jobCountOf(project);
  const pdfArtifacts = await artifactCountOf(pdfFileId);
  const pdfAudits = await previewAuditsOf(project);
  check(
    "I8",
    "PDF 对照（非图片不受影响）：ready + viewer.documentType=pdf（url / target 空 / 无产物无投递）",
    "ready + viewer.kind=onlyoffice/pdf + url null + target null + jobs 0 + artifacts 0 + 预览审计 4 条（累计）",
    short(
      {
        status: pdfPreview.body?.status,
        target: pdfPreview.body?.target,
        url: pdfPreview.body?.url,
        viewerKind: pdfPreview.body?.viewer?.kind,
        documentType: pdfPreview.body?.viewer?.documentType,
        jobs: pdfJobs,
        artifacts: pdfArtifacts,
        audits: pdfAudits.length,
      },
      360,
    ),
    pdfPreview.body?.status === "ready" &&
      pdfPreview.body?.target === null &&
      pdfPreview.body?.url === null &&
      pdfPreview.body?.viewer?.kind === "onlyoffice" &&
      pdfPreview.body?.viewer?.documentType === "pdf" &&
      pdfJobs === 0 &&
      pdfArtifacts === 0 &&
      pdfAudits.length === 4,
  );
} catch (error) {
  failures += 1;
  report.push("| FAIL | 中断：" + (error instanceof Error ? error.message : String(error)) + " | ");
  process.stderr.write("S6-前置 图片直通回放失败：" + (error instanceof Error ? error.message : String(error)) + "\n");
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
        }
        if (project !== "") {
          const residue = await db.query(
            "select (select count(*)::int from projects where id = $1) as projects, (select count(*)::int from files where project_id = $1) as files, (select count(*)::int from audit_logs where project_id = $1) as audits, (select count(*)::int from outbox_events where payload::text like $$%$$ || $1::text || $$%$$) as outbox",
            [project],
          );
          const r = residue.rows[0];
          report.push(
            "| INFO | 收尾对账（零残留）：projects=" + r.projects + " / files=" + r.files + " / audits=" + r.audits + " / outbox=" + r.outbox + "｜桶前缀 projects/" + project + "/ 已清 | ",
          );
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
lines.push("# S6-前置 回放证据（图片直通 · 原对象直签）");
lines.push("");
lines.push("> 卡片：ONLYOFFICE 替换实施切片 **S6-前置**（主责 lan；于本回放 PR 内代记，请 px 复核）｜口径来源：`docs/ONLYOFFICE替换执行计划(Office预览).md` §0 D6（图片 → 原对象短时签名直签）+ §4「S6-前置」出口条件（`deploy/preview` 停机状态下图片预览 + 缩略图走通 + 字节与原对象全等）｜ADR-007（缓存三元组）/ D2-04（短时签名 + 禁匿名）/ D2-07（预览审计 2026-10-23 恢复：实际送达就绪内容写一条）｜契约 `FilePreviewResponse`。");
lines.push("> 落点说明：`docs/` 属 px 线；本文件由 lan 随 S6-前置 切片代记（回放脚本与断言同 PR，请 px 复核）。");
lines.push("");
lines.push("| 项 | 值 |");
lines.push("|---|---|");
lines.push("| 回放时间 | " + new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 19).replace("T", " ") + " +08:00 |");
lines.push("| 目标 api | " + BASE_URL + " |");
lines.push("| 数据库 | " + DATABASE_URL.replace(/:[^:@/]+@/, ":***@") + " |");
lines.push("| 对象存储 | " + (storage === undefined ? "-" : storage.bucket) + "（本地 MinIO 沙箱：仅沙箱、不代表生产选型） |");
lines.push("| 转换器 | " + converterUrl + " **停机**（出口条件：本回放全程不使用转换器与 worker） |");
lines.push("| 签名窗口 | " + previewTtlSeconds + "s（`PREVIEW_URL_TTL_SECONDS`） |");
lines.push("| 代码版本 | " + commit + (dirty ? "（回放时工作区含本卡未提交改动）" : "") + " |");
lines.push("| 执行账号 | 管理员（建项目 / 上传 / 读预览 / 定档） |");
lines.push("| 夹具 | PNG-A 红点 " + PNG_A.length + "B（sha256 " + sha256(PNG_A).slice(0, 16) + "…）/ PNG-B 蓝点 " + PNG_B.length + "B（sha256 " + sha256(PNG_B).slice(0, 16) + "…）/ 最小单页 PDF " + SAMPLE_PDF.length + "B |");
lines.push("| 脚本 | server/scripts/s6-pre-image-direct-replay.mjs |");
lines.push("");
lines.push("## 断言明细");
lines.push("");
lines.push(...report);
lines.push("");
lines.push("## 汇总");
lines.push("");
lines.push(
  failures === 0
    ? "- ✅ 全部断言通过（" + evidence.steps.filter((step) => step.ok).length + " 项）：停机态前置（S0b）+ 图片直签就绪形态（ready / target=image / 产物字段空）+ 字节与原对象全等（非转换件）+ 签名形状与窗口 + 预览实际送达写一条审计（2026-10-23 恢复）+ 零投递 / 零产物行 + 版本路由（v1 / v2 不串）+ 定档后零投递 + PDF 对照（查看器通道不受影响）。"
    : "- ❌ 有 " + failures + " 项失败，见上方 FAIL 行。",
);
lines.push("");
lines.push("## 未覆盖 / 风险登记");
lines.push("");
lines.push("- **浏览器侧缩略图 / 浮层走查**：本脚本只断言 API 层（签发 / 字节 / 审计 / 投递 / 产物）；前端缩略图（<img> 直出）与大图浮层在**同停机态**下由前端 CDP 脚本复跑，截图见 `docs/s6-pre-回放证据(图片直通·原对象直签).md` 前端小节。");
lines.push("- **停机态是出口条件**：转换器在线时本脚本拒绝执行（S0b）——若需在转换器在线时复跑，先 `cd deploy/preview && docker compose down`。");
lines.push("- **缩略图为前端直出**：无服务端缩略图端点 —— 前端缩略图复用同一 preview url（原对象直签），本切片零前端改动（预期）。");
lines.push("- **产物通道为保留段**：`preview_artifacts` / `preview.job` 消费路径仍随 structured 二期保留；S6 退役评审另行处置（D5 双轨在 S6 评审通过前不变）。");
lines.push("");
lines.push("## 复跑");
lines.push("");
lines.push("```bash");
lines.push("# 前置：停转换器（出口条件）");
lines.push("cd deploy/preview && docker compose down");
lines.push("# api（BASE_URL = 默认 3011；preview 栈不在线）");
lines.push("cd server && npm run build && node --env-file-if-exists=.env dist/entry/api.js");
lines.push("# 回放（库侧收尾含 audit_logs 删除：用 migrator 角色）");
lines.push("cd server && S6_PRE_DATABASE_URL=postgresql://libiaolink_migrator@127.0.0.1:55432/libiaolink \\");
lines.push("  node --env-file-if-exists=.env scripts/s6-pre-image-direct-replay.mjs \\");
lines.push('  --out "../docs/s6-pre-回放证据(图片直通·原对象直签).md" --json "../docs/s6-pre-回放证据(图片直通·原对象直签).json"');
lines.push("```");
lines.push("");

const rendered = lines.map((line) => line.replace(/[ \t]+$/u, ""));
if (args.json !== undefined) writeFileSync(args.json, JSON.stringify(evidence, null, 2) + "\n", "utf8");
if (args.out !== undefined) writeFileSync(args.out, rendered.join("\n"), "utf8");
process.stdout.write(rendered.join("\n") + "\n");
process.exit(failures === 0 ? 0 : 1);
