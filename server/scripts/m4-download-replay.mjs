#!/usr/bin/env node
/**
 * M4-05f 下载切片真机回放（S7·file 下载读 API · PR-13）：
 *   证据一（签名四字段与窗口）：`GET /files/{id}/versions/{versionId}/download-url` → 200 + url / fileName / sizeBytes / expiresAt；
 *             窗口 ≈ S3_DOWNLOAD_URL_TTL_SECONDS —— 与预览的 PREVIEW_URL_TTL_SECONDS **相互独立**（本脚本以不同值起 api 验证）。
 *   证据二（附件投递）：GET 签名地址 → 200 + 字节与源文件**逐字节一致** + `Content-Disposition: attachment`（原名 URL 编码回写）。
 *   证据三（审计）：一条 `action = download` 审计（object_type = file、metadata 记 versionId）；**不写 preview 行**（一次下载一条）。
 *   证据四（A4-06 版本路由）：v1 / v2 各签各自的对象键与体积 —— 下载内容不串版本。
 *   证据四·B（Office 夹具 round-trip）：真实 .docx（PK/ZIP）上传 → 下载字节与夹具**逐字节一致**（非 PDF 转换件）；
 *             并在 `previews/{hash}/{pipelineVersion}/pdf` 自造占位产物，证下载只签 `projects/` 原对象（与预览链不串）。
 *   证据五（404 与禁匿名）：版本不属于该文件 / 文件不存在 → 404（同形，防 IDOR）；无会话 → 401（D2-04 禁匿名）。
 *   证据六（部门规则双态 · 按运行形态自适应）：非名册成员——**部门规则关闭**时下载 200；
 *             **部门规则开启且无适用项目规则**时项目不可见 → 404（记录级优先于功能权限，不因缺权限暴露存在性）。
 *             脚本以 `/permissions/me` 的 `groupAccessEnforced` / `groupAccessAdmin` 探测实际形态。
 *
 * 前置：真 PG（DATABASE_URL）+ 真对象存储（S3_*，见 deploy/minio/）+ 已起 api（BASE_URL）。
 *       本脚本只在本地沙箱 / 联调库跑：铸临时管理员会话（跑完撤销）、建 M4DL- 回放项目
 *       （跑完硬删项目及其文件 / 版本 / 会话 / 关联 / 审计 / outbox 事件 + 清桶内 projects/ 前缀 + 合成用户）。
 * 用法：cd server && M4_DATABASE_URL=postgresql://libiaolink_migrator@127.0.0.1:55432/libiaolink \
 *       node --env-file-if-exists=.env scripts/m4-download-replay.mjs [--out <报告.md>] [--json <证据.json>] [--keep]
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
const report = [];
const evidence = { steps: [] };
let failures = 0;
let db;

/** 回放样例：v1 用中文 PDF 头占位字节（下载切片不做转换，字节可比即可）。 */
const SAMPLE_V1 = Buffer.concat([
  Buffer.from("%PDF-1.7\n1 0 obj\n<< /Title (M4-05f 下载切片回放 v1) >>\n", "utf8"),
  randomBytes(256 * 1024),
]);
const SAMPLE_V2 = Buffer.concat([
  Buffer.from("%PDF-1.7\n1 0 obj\n<< /Title (M4-05f 下载切片回放 v2) >>\n", "utf8"),
  randomBytes(384 * 1024),
]);

/**
 * Office 夹具：最小可打开的 .docx（OOXML 包 3 部件：`[Content_Types].xml` / `_rels/.rels` / `word/document.xml`，PK/ZIP 容器）。
 * 用途：预览通道对 Office 必转 PDF，下载字节与夹具一致 ⇔ 下载的不是转换件（PDF / 图片夹具是原样直通，证不了这一点）。
 */
const SAMPLE_DOCX = Buffer.from(
  "UEsDBBQAAAAIAEdUPl15bjPX8gAAAK0BAAATAAAAW0NvbnRlbnRfVHlwZXNdLnhtbHyQy07DMBBFf8XyFsUOLBBCcbrgsQQW5QMse5JYtWcsjxvS" +
  "v0dpSxeosL6Pc3W7zZKimKFwIDTyVrVSADryAUcjP7evzYMUXC16GwnByAOw3PTd9pCBxZIispFTrflRa3YTJMuKMuCS4kAl2cqKyqizdTs7gr5r" +
  "23vtCCtgberaIfvuGQa7j1W8LBXwtKNAZCmeTsaVZaTNOQZnayDUM/pflOZMUAXi0cNTyHyzpCj1VcKq/A04595nKCV4EB+21DebwEj9RcVrT26f" +
  "AKv6v+bKThqG4OCSX9tyIQfMAccU1UVJNuDPfn28u/8GAAD//wMAUEsDBBQAAAAIAEdUPl2b/TfqtwAAACkBAAALAAAAX3JlbHMvLnJlbHOMz8Fq" +
  "wzAQBNBfEXuv5eQQQrDsSwjkWtwPENLaFpV2hVZNnb/PJYc49NDrMLxhumFNUd2wSGAysGtaUEiOfaDZwNd4+TiCkmrJ28iEBu4oMPTdJ0ZbA5Ms" +
  "IYtaUyQxsNSaT1qLWzBZaTgjrSlOXJKt0nCZdbbu286o92170OXVgK2prt5AufodqPGe8T82T1NweGb3k5DqHxNvDVCjLTNWA79cvPbPuFlTBN13" +
  "enOxfwAAAP//AwBQSwMEFAAAAAgAR1Q+XbJtG+XrAAAABwEAABEAAAB3b3JkL2RvY3VtZW50LnhtbETPMU7DMBgF4KtY3hsHBAhFSboxFbHAAVzH" +
  "SS3s/7dsQ9IDIBWxoi5ISEhwhlKp4TQkYusVkMvA8r3tPb182hlN7qXzCqGgR0lKiQSBlYKmoDfXF5NzSnzgUHGNIAu6lJ5Oy7zNKhR3RkIgndHg" +
  "s7agixBsxpgXC2m4T9BK6Iyu0RkefIKuYS26yjoU0nsFjdHsOE3PmOEKaKycY7WMaSMuEsqZmiuOMwW35PJkkp7W5Pvz6afvh5fX8fmLXNW1EpIM" +
  "79vhYbPfrcZ1P2w+xvV2fFvtd485ix1Rd9Ae/Nth/x/KXwAAAP//AwBQSwECFAAUAAAACABHVD5deW4z1/IAAACtAQAAEwAAAAAAAAAAAAAAAAAA" +
  "AAAAW0NvbnRlbnRfVHlwZXNdLnhtbFBLAQIUABQAAAAIAEdUPl2b/TfqtwAAACkBAAALAAAAAAAAAAAAAAAAACMBAABfcmVscy8ucmVsc1BLAQIU" +
  "ABQAAAAIAEdUPl2ybRvl6wAAAAcBAAARAAAAAAAAAAAAAAAAAAMCAAB3b3JkL2RvY3VtZW50LnhtbFBLBQYAAAAAAwADALkAAAAdAwAAAAA=",
  "base64",
);

/** 自造"预览产物占位"（模拟 `previews/…/pdf`）：只为断言下载链不指向预览前缀；真实转换件不串链由 M4-05d 预览回放覆盖。 */
const DECOY_PDF = Buffer.from("%PDF-1.7\n% M4-05f replay decoy（非真实转换件）\n1 0 obj\n<< /Title (decoy) >>\nendobj\ntrailer\n<<>>\n%%EOF\n", "utf8");

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
  const session = { userId, token: "m4dl-" + randomBytes(16).toString("hex"), csrf: randomBytes(16).toString("hex") };
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

const downloadUrl = (fileId, versionId, session = admin) =>
  call("GET", "/api/v1/files/" + fileId + "/versions/" + versionId + "/download-url", undefined, session);

function check(id, title, expected, actual, ok, note = "") {
  if (!ok) failures += 1;
  report.push((ok ? "| PASS | " : "| FAIL | ") + id + " | " + title + " | ");
  report.push("  - 期望：" + expected);
  report.push("  - 实际：" + actual);
  if (note !== "") report.push("  - 说明：" + note);
  evidence.steps.push({ id, title, expected, actual, ok, note });
  process.stdout.write((ok ? "PASS " : "FAIL ") + id + " " + title + "\n");
  if (!ok) throw new Error("M4-05f 下载切片回放失败（" + id + "）：" + title);
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

async function auditOf(projectId, action) {
  const rows = await db.query(
    "select action, object_type, object_id, project_id, metadata, summary, result from audit_logs where project_id = $1 and action = $2 order by occurred_at",
    [projectId, action],
  );
  return rows.rows;
}

async function fetchSigned(url) {
  const response = await fetch(url);
  const bytes = Buffer.from(await response.arrayBuffer());
  return {
    status: response.status,
    bytes,
    hash: sha256(bytes),
    disposition: response.headers.get("content-disposition"),
    contentType: response.headers.get("content-type"),
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

let admin;
let adminId;
let storage;
let rawClient;
let s3Module;
let storageModule;
let project;
let downloadTtlSeconds = 300;
let previewTtlSeconds = 300;
let previewPipelineVersion = "1.0.0";
let groupAccessRestricted = false;
const cleanup = { projectIds: [], sessions: [], userIds: [], previewPrefixes: [] };

try {
  try {
    const envModule = await import(pathToFileURL(join(serverRoot, "dist", "config", "env.js")).href);
    storageModule = await import(pathToFileURL(join(serverRoot, "dist", "storage", "index.js")).href);
    s3Module = await import("@aws-sdk/client-s3");
    const env = envModule.loadEnv(process.env);
    downloadTtlSeconds = env.S3_DOWNLOAD_URL_TTL_SECONDS;
    previewTtlSeconds = env.PREVIEW_URL_TTL_SECONDS;
    previewPipelineVersion = env.PREVIEW_PIPELINE_VERSION;
    storage = storageModule.createS3ObjectStorage(env);
    rawClient = storageModule.createS3Client(env);
  } catch (error) {
    throw new Error("无法加载 dist / S3 环境（先 npm run build，并用 --env-file-if-exists=.env 带上 S3_*）：" + String(error));
  }

  db = new Client({ connectionString: DATABASE_URL });
  await db.connect();

  // ---------- 证据 0：依赖就绪 ----------
  const health = await fetch(BASE_URL + "/healthz").then((response) => response.status).catch(() => 0);
  const ready = await fetch(BASE_URL + "/readyz").then((response) => response.status).catch(() => 0);
  check("S0", "api 可用（/healthz + /readyz：含存储探针）", "200 / 200", health + " / " + ready, health === 200 && ready === 200);

  const adminRow = await db.query(
    "select u.id from users u join user_roles ur on ur.user_id = u.id join roles r on r.id = ur.role_id where r.code = $1 and u.status = $2 order by u.id limit 1",
    ["admin", "active"],
  );
  adminId = adminRow.rows[0]?.id;
  if (adminId === undefined) throw new Error("找不到可用的管理员账号（roles.code = admin）");
  admin = await makeSession(adminId, "m4dl-replay-admin");
  cleanup.sessions.push(admin.token);

  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const created = await call("POST", "/api/v1/projects", {
    code: "M4DL-" + stamp,
    name: "m4-05f 下载切片回放项目",
    projectType: "default",
    managerIds: [adminId],
  });
  check("P1", "建回放项目（为 file 提供 projectId）", "201 + 项目可见", created.status + " " + short({ id: created.body?.id, code: created.body?.code }, 120), created.status === 201);
  project = created.body.id;
  cleanup.projectIds.push(project);

  const v1 = await uploadFile({ projectId: project, name: "下载回放-机械设计图纸.pdf", bytes: SAMPLE_V1, docType: "技术协议" });
  check(
    "F1",
    "上传 v1（真实上传管道：init → 分片直传 → complete）",
    "200 + 版本 v1",
    short({ status: v1.completed.status, seq: v1.completed.body?.version?.seq }, 160),
    v1.completed.status === 200 && v1.completed.body?.version?.seq === 1,
  );
  const v1VersionId = v1.completed.body.version.id;
  const v1ObjectKey = v1.completed.body.version.objectKey ?? null;

  const v2 = await uploadFile({ projectId: project, name: "下载回放-机械设计图纸.pdf", bytes: SAMPLE_V2, docType: "技术协议", fileId: v1.fileId });
  check(
    "F2",
    "追加 v2（intent=version + fileId：同一文件第二个版本）",
    "200 + 版本 v2",
    short({ status: v2.completed.status, seq: v2.completed.body?.version?.seq, fileId: v2.fileId }, 200),
    v2.completed.status === 200 && v2.completed.body?.version?.seq === 2 && v2.fileId === v1.fileId,
  );
  const v2VersionId = v2.completed.body.version.id;

  // ---------- 证据一：签名四字段与窗口 ----------
  const beforeSign = Date.now();
  const v1Signed = await downloadUrl(v1.fileId, v1VersionId);
  const ttlSeconds = v1Signed.body?.expiresAt === undefined ? 0 : Math.round((Date.parse(v1Signed.body.expiresAt) - beforeSign) / 1000);
  check(
    "D1",
    "取 v1 下载地址 → 200 + 四字段（url / fileName / sizeBytes / expiresAt），窗口 ≈ S3_DOWNLOAD_URL_TTL_SECONDS（与预览窗口独立）",
    "fileName=原名 + sizeBytes=" + SAMPLE_V1.length + " + TTL ≈ " + downloadTtlSeconds + "s（预览配置 " + previewTtlSeconds + "s）",
    short({ status: v1Signed.status, fileName: v1Signed.body?.fileName, sizeBytes: v1Signed.body?.sizeBytes, ttlSeconds, urlHost: String(v1Signed.body?.url).split("?")[0]?.slice(0, 80) }, 360),
    v1Signed.status === 200 &&
      v1Signed.body?.fileName === "下载回放-机械设计图纸.pdf" &&
      v1Signed.body?.sizeBytes === SAMPLE_V1.length &&
      String(v1Signed.body?.url).includes(v1ObjectKey ?? "§") === (v1ObjectKey !== null) &&
      Math.abs(ttlSeconds - downloadTtlSeconds) <= 5,
  );

  // ---------- 证据二：附件投递（字节一致 + Content-Disposition） ----------
  const v1Fetched = await fetchSigned(v1Signed.body.url);
  check(
    "D2",
    "GET 签名地址 → 200 + 字节与 v1 **逐字节一致** + `Content-Disposition: attachment`（原名 URL 编码，浏览器落盘）",
    "status=200 + sha256=" + sha256(SAMPLE_V1).slice(0, 12) + "… + disposition 含 attachment 与 UTF-8 文件名",
    short({ status: v1Fetched.status, hash: v1Fetched.hash.slice(0, 12) + "…", disposition: v1Fetched.disposition }, 360),
    v1Fetched.status === 200 &&
      v1Fetched.hash === sha256(SAMPLE_V1) &&
      String(v1Fetched.disposition).startsWith("attachment") &&
      String(v1Fetched.disposition).includes("UTF-8''%E4%B8%8B%E8%BD%BD%E5%9B%9E%E6%94%BE"),
  );

  // ---------- 证据三：审计（一条 download，无 preview 行） ----------
  const downloads = await auditOf(project, "download");
  const previews = await auditOf(project, "preview");
  check(
    "D3",
    "写一条 `action = download` 审计（object_type = file、metadata.versionId = v1）；**不写 preview 行**",
    "download 1 条（metadata.versionId = v1）+ preview 0 条",
    short({ downloads: downloads.length, versionId: downloads[0]?.metadata?.versionId, objectType: downloads[0]?.object_type, summary: downloads[0]?.summary, previews: previews.length }, 400),
    downloads.length === 1 &&
      downloads[0].metadata?.versionId === v1VersionId &&
      downloads[0].object_type === "file" &&
      downloads[0].object_id === v1.fileId &&
      String(downloads[0].summary).includes("下载回放-机械设计图纸.pdf") &&
      previews.length === 0,
  );

  // ---------- 证据四：版本路由（v2 内容不串版本） ----------
  const v2Signed = await downloadUrl(v2.fileId, v2VersionId);
  const v2Fetched = await fetchSigned(v2Signed.body.url);
  check(
    "D4",
    "v2 下载：按 v2 对象键签名、返回 v2 体积 —— 下载内容不串版本（A4-06）",
    "status=200 + sha256=" + sha256(SAMPLE_V2).slice(0, 12) + "…（≠ v1）+ sizeBytes=" + SAMPLE_V2.length,
    short({ status: v2Fetched.status, hash: v2Fetched.hash.slice(0, 12) + "…", sizeBytes: v2Signed.body?.sizeBytes, sameAsV1: v2Fetched.hash === sha256(SAMPLE_V1) }, 320),
    v2Fetched.status === 200 && v2Fetched.hash === sha256(SAMPLE_V2) && v2Signed.body?.sizeBytes === SAMPLE_V2.length,
  );

  const downloadsAfterV2 = await auditOf(project, "download");
  check(
    "D5",
    "两次下载 → download 审计两条（一条一次，不合并、不重复）",
    "download 2 条",
    short({ downloads: downloadsAfterV2.length }, 160),
    downloadsAfterV2.length === 2,
  );

  // ---------- 证据四·B：Office 夹具 round-trip（下载 = 原 .docx；previews/ 产物在链外） ----------
  // 背景：既有夹具是 PDF / 图片（预览通道原样直通），"下载字节与夹具一致"在旧缺陷路径下也成立（产物 == 原件）。
  // 本组用真实 .docx（PK/ZIP 容器：预览产物必为 PDF、字节必然不同）+ 自造 previews/ 占位产物，
  // 不跑 converter 即可断言：下载只签版本原对象（projects/…docx），与预览产物前缀不串链。
  const office = await uploadFile({ projectId: project, name: "下载回放-施工方案.docx", bytes: SAMPLE_DOCX, docType: "评审单" });
  const officeVersionId = office.completed.body?.version?.id;
  const officeKeyRow = await db.query("select object_key from file_versions where id = $1", [officeVersionId]);
  const officeObjectKey = officeKeyRow.rows[0]?.object_key;
  check(
    "F3",
    "上传 Office 夹具（真实上传管道 · .docx）：版本对象键（file_versions.object_key） = projects/…/v1/{hash}.docx",
    "200 + seq=1 + 对象键 projects/" + project + "/files/…/v1/" + sha256(SAMPLE_DOCX).slice(0, 12) + "….docx",
    short({ status: office.completed.status, seq: office.completed.body?.version?.seq, objectKey: officeObjectKey }, 280),
    office.completed.status === 200 &&
      office.completed.body?.version?.seq === 1 &&
      officeObjectKey === "projects/" + project + "/files/" + office.fileId + "/v1/" + sha256(SAMPLE_DOCX) + ".docx",
  );

  const decoyObjectKey = storageModule.buildPreviewArtifactKey({ versionId: officeVersionId, contentHash: office.contentHash, pipelineVersion: previewPipelineVersion, target: "pdf" });
  await storage.putObject({ objectKey: decoyObjectKey, body: DECOY_PDF, contentType: "application/pdf", metadata: { "preview-replay-decoy": "1" } });
  cleanup.previewPrefixes.push("previews/versions/" + officeVersionId + "/");
  const decoyHead = await storage.headObject(decoyObjectKey);

  const officeSigned = await downloadUrl(office.fileId, officeVersionId);
  check(
    "D5b",
    "占位预览产物就位（previews/{hash}/{pipelineVersion}/pdf）→ 下载签名仍指向版本原对象（projects/…docx），不含产物键",
    "200 + fileName=下载回放-施工方案.docx + sizeBytes=" + SAMPLE_DOCX.length + " + url 含原对象键、不含产物键",
    short({ decoyExists: decoyHead !== null, status: officeSigned.status, fileName: officeSigned.body?.fileName, sizeBytes: officeSigned.body?.sizeBytes, urlHasOriginal: String(officeSigned.body?.url).includes(officeObjectKey), urlHasDecoy: String(officeSigned.body?.url).includes(decoyObjectKey) }, 420),
    decoyHead !== null &&
      officeSigned.status === 200 &&
      officeSigned.body?.fileName === "下载回放-施工方案.docx" &&
      officeSigned.body?.sizeBytes === SAMPLE_DOCX.length &&
      String(officeSigned.body?.url).includes(officeObjectKey) &&
      !String(officeSigned.body?.url).includes(decoyObjectKey),
  );

  const officeFetched = await fetchSigned(officeSigned.body.url);
  const officeMagic = officeFetched.bytes.subarray(0, 2).toString("latin1");
  check(
    "D5c",
    "GET 签名地址 → 200 + 字节与上传 .docx **逐字节一致**（PK/ZIP 容器、非 %PDF、≠ 预览占位产物）+ `Content-Disposition: attachment`（原名）",
    "status=200 + sha256=" + sha256(SAMPLE_DOCX).slice(0, 12) + "… + magic=PK + disposition 含 attachment 与 UTF-8 原名",
    short({ status: officeFetched.status, hash: officeFetched.hash.slice(0, 12) + "…", magic: officeMagic, isPdf: officeFetched.bytes.subarray(0, 5).toString("latin1") === "%PDF-", decoyHash: sha256(DECOY_PDF).slice(0, 12) + "…", disposition: officeFetched.disposition }, 420),
    officeFetched.status === 200 &&
      officeFetched.hash === sha256(SAMPLE_DOCX) &&
      officeMagic === "PK" &&
      officeFetched.bytes.subarray(0, 5).toString("latin1") !== "%PDF-" &&
      officeFetched.hash !== sha256(DECOY_PDF) &&
      String(officeFetched.disposition).startsWith("attachment") &&
      String(officeFetched.disposition).includes("UTF-8''%E4%B8%8B%E8%BD%BD%E5%9B%9E%E6%94%BE"),
  );

  const previewAuditsAfterOffice = await auditOf(project, "preview");
  const downloadsAfterOffice = await auditOf(project, "download");
  const officeAudit = downloadsAfterOffice.find((row) => row.metadata?.versionId === officeVersionId);
  check(
    "D5d",
    "Office 夹具下载 → download 审计一条一次（metadata.versionId = 该版本）；占位产物不写审计（preview 仍 0 条）",
    "download 3 条（新增 1 条且 versionId = " + officeVersionId + "）+ preview 0 条",
    short({ downloads: downloadsAfterOffice.length, matched: officeAudit !== undefined, summary: officeAudit?.summary, previews: previewAuditsAfterOffice.length }, 400),
    downloadsAfterOffice.length === 3 &&
      officeAudit !== undefined &&
      officeAudit.object_type === "file" &&
      officeAudit.object_id === office.fileId &&
      String(officeAudit.summary).includes("下载回放-施工方案.docx") &&
      previewAuditsAfterOffice.length === 0,
  );

  // ---------- 证据五：404 与禁匿名 ----------
  const other = await uploadFile({ projectId: project, name: "下载回放-另一个文件.pdf", bytes: SAMPLE_V1.subarray(0, 128 * 1024), docType: "合同" });
  const otherVersionId = other.completed.body?.version?.id;
  const cross = await downloadUrl(v1.fileId, otherVersionId);
  check(
    "D6",
    "版本不属于该文件（用另一文件的 versionId）→ 404（同形，不泄漏版本归属）",
    "404",
    short({ status: cross.status, code: cross.body?.code }, 160),
    cross.status === 404,
  );

  const missing = await downloadUrl(randomUUID(), v1VersionId);
  check("D7", "文件不存在（随机 UUID）→ 404", "404", short({ status: missing.status, code: missing.body?.code }, 160), missing.status === 404);

  const anonymous = await downloadUrl(v1.fileId, v1VersionId, null);
  check("D8", "无会话 → 401（D2-04 禁匿名：下载地址必须带会话换签）", "401", short({ status: anonymous.status, code: anonymous.body?.code }, 160), anonymous.status === 401);

  // ---------- 证据六：部门规则双态（关闭 = 全员可见；开启且无适用规则 = 非成员不可见 404） ----------
  const salesRow = await db.query("insert into users (casdoor_id, username, display_name, status) values ($1, $2, $3, $4) returning id", [
    "m4dl-" + stamp + "-sales",
    "m4dl-sales-" + stamp,
    "下载回放-非成员",
    "active",
  ]);
  const salesId = salesRow.rows[0].id;
  cleanup.userIds.push(salesId);
  const sales = await makeSession(salesId, "m4dl-replay-sales");
  cleanup.sessions.push(sales.token);

  const profile = await call("GET", "/api/v1/permissions/me", undefined, sales);
  const salesProfile = profile.body?.permissions ?? {};
  const salesKeys = Array.isArray(salesProfile.permissionKeys) ? salesProfile.permissionKeys : [];
  const fullBaseline = salesKeys.includes("file.download") && salesKeys.length >= 31;
  groupAccessRestricted = salesProfile.groupAccessEnforced === true && salesProfile.groupAccessAdmin !== true;
  check(
    "D9",
    "权限基线探测（非成员画像）：全量能力基线 + 部门规则执行状态",
    "全量功能权限基线；记录级由 groupAccessEnforced / 项目规则收敛",
    short({ groupAccessEnforced: salesProfile.groupAccessEnforced, groupAccessAdmin: salesProfile.groupAccessAdmin, profileKeys: salesKeys.length, hasFileDownload: salesKeys.includes("file.download"), fullBaseline }, 240),
    salesProfile.userId === salesId && fullBaseline === true,
  );

  const auditsBeforeSales = (await auditOf(project, "download")).length;
  const salesAttempt = await downloadUrl(v1.fileId, v1VersionId, sales);
  const auditsAfterSales = (await auditOf(project, "download")).length;
  check(
    "D10",
    groupAccessRestricted
      ? "部门规则开启：非名册成员无适用项目规则 → 项目不可见 404；不签发、不写 download 审计（记录级优先，防 IDOR）"
      : "部门规则关闭：非名册成员可下载 → 200 + 写一条 download 审计",
    groupAccessRestricted ? "404 + 审计不增（" + auditsBeforeSales + " 条）" : "200 + 审计 " + auditsBeforeSales + " → " + (auditsBeforeSales + 1) + " 条",
    short({ mode: groupAccessRestricted ? "group-rules" : "rules-off", status: salesAttempt.status, code: salesAttempt.body?.code, fileName: salesAttempt.body?.fileName, auditsBefore: auditsBeforeSales, auditsAfter: auditsAfterSales }, 320),
    groupAccessRestricted
      ? salesAttempt.status === 404 && auditsAfterSales === auditsBeforeSales
      : salesAttempt.status === 200 && auditsAfterSales === auditsBeforeSales + 1 && salesAttempt.body?.fileName === "下载回放-机械设计图纸.pdf",
  );

} catch (error) {
  failures += 1;
  report.push("| FAIL | 中断：" + (error instanceof Error ? error.message : String(error)) + " | ");
  process.stderr.write("M4-05f 下载切片回放失败：" + (error instanceof Error ? error.message : String(error)) + "\n");
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
          for (const prefix of cleanup.previewPrefixes) {
            await purgePrefix(prefix).catch(() => undefined);
          }
        }
        for (const userId of cleanup.userIds) {
          await db.query("delete from user_roles where user_id = $1", [userId]);
          await db.query("delete from sessions where user_id = $1", [userId]);
          await db.query("delete from users where id = $1", [userId]);
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
lines.push("# M4-05f 回放证据（S7·file 下载切片）");
lines.push("");
lines.push("> 卡片：M4-05「在线预览」的**下载切片**（主责 lan，评审 wmj）｜口径来源：系统功能书 A4-06（任意历史版本可预览与下载）/ A4-10（离线下载受权限控制并记日志 · 一期）｜技术设计v0.3 §3.5（预览 / 下载 / 定档 / 变更全部写审计；下载受 `file.download` 约束）｜ADR-006（对象存储禁匿名读取：短时签名投递）｜契约 `FileDownloadUrlResponse`。");
lines.push("> 落点说明：`docs/` 属 px 线；本文件由 lan 随 M4-05 下载切片卡片代记（回放脚本与断言同 PR，请 px 复核）。");
lines.push("");
lines.push("| 项 | 值 |");
lines.push("|---|---|");
lines.push("| 回放时间 | " + new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 19).replace("T", " ") + " +08:00 |");
lines.push("| 目标 | " + BASE_URL + " |");
lines.push("| 数据库 | " + DATABASE_URL.replace(/:[^:@/]+@/, ":***@") + " |");
lines.push("| 对象存储 | " + (storage === undefined ? "-" : storage.bucket) + "（本地 MinIO 沙箱：仅沙箱、不代表生产选型） |");
lines.push("| 签名窗口 | 下载 " + downloadTtlSeconds + "s（`S3_DOWNLOAD_URL_TTL_SECONDS`）／预览 " + previewTtlSeconds + "s（`PREVIEW_URL_TTL_SECONDS`）—— 两键独立配置 |");
lines.push("| 代码版本 | " + commit + (dirty ? "（回放时工作区含本卡未提交改动）" : "") + " |");
lines.push("| 权限形态 | " + (groupAccessRestricted ? "部门规则开启：非成员 → 不可见 404" : "部门规则关闭：全员可下载") + " |");
lines.push("| 执行账号 | 管理员（建项目 / 上传 / 换签下载）；另有**非成员**（sales 角色）与**匿名**（401）各一条 |");
lines.push("| 脚本 | server/scripts/m4-download-replay.mjs |");
lines.push("");
lines.push("## 断言明细");
lines.push("");
lines.push(...report);
lines.push("");
lines.push("## 汇总");
lines.push("");
lines.push(failures === 0 ? "- ✅ 全部断言通过（" + evidence.steps.filter((step) => step.ok).length + " 项）：签名四字段与独立窗口 / 附件投递（字节逐字节一致 + Content-Disposition 原名）/ Office 夹具 round-trip（.docx 字节一致 + PK 容器 + ≠ previews/ 占位产物）/ download 审计一条一次 / v1·v2 版本路由 / 跨文件版本 404 / 文件不存在 404 / 禁匿名 401 / 权限形态（" + (groupAccessRestricted ? "部门规则开启 → 非成员 404、不写审计" : "部门规则关闭 → 全员可下载") + "）。" : "- ❌ 有 " + failures + " 项失败，见上方 FAIL 行。");
lines.push("");
lines.push("## 未覆盖 / 风险登记");
lines.push("");
lines.push("- **运行形态（两态各跑一次）**：部门规则关闭证「全员可下载」；开启且非成员无适用项目规则证「不可见 → 404、不写审计」——脚本按 `/permissions/me` 的实际部门画像自适应断言。");
lines.push("- **403（可见但缺 `file.download`）真机不可达**：`file.download` 在项目成员 / 项目经理的**隐含权限位**内（`permission.rules.ts`），而可见性本身来自名册 / 主数据责任人 —— 一期六角色矩阵下「可见但无权下载」构造不出来；该分支由单测覆盖（`test/file-download.test.ts`：缺权限 403 且不签名不审计）。二期角色矩阵（更细粒度授权）落地后可在真机复验。");
lines.push("- **Office 夹具的「预览产物」为回放自造占位**：本脚本不跑 converter，占位对象只用于断言「下载不指向 `previews/` 前缀」（同一 contentHash 下 .docx 与 PDF 字节必然不同）；真实转换件与下载原文件的不串链由 M4-05d 预览回放 + 本组共同覆盖。");
lines.push("- **压测未做**：并发 2~4、200MB 级长跑内存曲线不在本脚本范围（属 M4-05 压测 / M8 容量验证）。");
lines.push("- **签名地址的生命周期由对象存储保证**：脚本只证「签发后可取回」；过期后 403 由 S3 侧拒绝（`S3_DOWNLOAD_URL_TTL_SECONDS` 窗口外），未在本脚本做等待过期的慢断言。");
lines.push("");
lines.push("## 复跑");
lines.push("");
lines.push("```bash");
lines.push("cd server && npm run build && S3_DOWNLOAD_URL_TTL_SECONDS=600 PREVIEW_URL_TTL_SECONDS=900 npm run start:api &");
lines.push("# 部门规则态复跑：api 以 GROUP_ACCESS_ENFORCED=true 启动，并让非成员账号无适用项目规则；D10 断言为「非成员 404」")
lines.push('cd server && M4_DATABASE_URL=postgresql://libiaolink_migrator@127.0.0.1:55432/libiaolink \\');
lines.push('  S3_DOWNLOAD_URL_TTL_SECONDS=600 PREVIEW_URL_TTL_SECONDS=900 node --env-file-if-exists=.env scripts/m4-download-replay.mjs --out "../docs/m4-05f-回放证据(下载切片).md"');
lines.push("```");
lines.push("");

if (args.json !== undefined) writeFileSync(args.json, JSON.stringify(evidence, null, 2) + "\n", "utf8");
if (args.out !== undefined) writeFileSync(args.out, lines.join("\n"), "utf8");
process.stdout.write(lines.join("\n") + "\n");
process.exit(failures === 0 ? 0 : 1);
