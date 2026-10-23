#!/usr/bin/env node
/**
 * S8-2 回放证据（S3 · ONLYOFFICE 受控预览端点）真机回放 —— 安全定稿 §6 六用例：
 *   ① outbox=true 正常拉取 200：DocServer 形态 outbox Bearer（HS256 / payload.url 逐字绑定 / exp +300s）→ 200 + 字节与上传夹具逐字节一致；
 *      沙箱可达时附「真实 DocServer `/converter` 拉取」子用例（A1D：DocServer 经 outbox Bearer 现场拉本仓端点并转换出 PDF）；
 *   ② 401 反例：无 / 畸形 / 签名篡改 / 过期超容差 / URL 错配 / alg=none —— 统一 401 AUTH_REQUIRED、同形文案；
 *   ③ 无重定向：200 不跟随重定向可得（302 不存在、无 Location）；
 *   ④ 配置 token 无 `X-Amz-`：查看器签发形状 + token HMAC 复算 + claims / TTL（900s）；
 *   ⑤ 401 计数可观测：api 日志逐条 warn（`--api-log` 指定；未给则该用例 SKIP 并登记）；
 *   ⑥ 下载链回归：download-url 200 + 签名字节 = 原对象 + download 审计一条一次；查看器预览签发本身写一条 preview 审计（2026-10-23 恢复），preview-content 拉取不额外写。
 *
 * 前置：真 PG + 真 MinIO + 已起 api（BASE_URL；ONLYOFFICE_* 已配置 —— `ONLYOFFICE_DOCSERVER_API_BASE_URL` = DocServer 视角基址，
 *       本机联调 = `http://host.docker.internal:<api 端口>`，容器经 host.docker.internal 可达）。
 * 用法：cd server && node --env-file-if-exists=.env scripts/s8-2-preview-content-replay.mjs \
 *         [--out <报告.md>] [--json <证据.json>] [--keep] [--api-log <api 输出日志>] [--base-url <api>] [--database-url <pg>]
 * 退出码：断言全过 = 0（SKIP 不阻断），否则 = 1（可当门禁用）。
 */
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "pg";

const serverRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = parseArgs(process.argv.slice(2));
const BASE_URL = args.baseUrl ?? process.env.S8_BASE_URL ?? process.env.BASE_URL ?? "http://127.0.0.1:3011";
const DATABASE_URL =
  args.databaseUrl ?? process.env.S8_DATABASE_URL ?? process.env.DATABASE_URL ?? "postgresql://libiaolink_migrator@127.0.0.1:55432/libiaolink";
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
let ooSecret = "";
let ooBase = "";
let ooDocServer = "";
let ooViewerTtlSeconds = 900;
let project;
let docServerRan = false;
const cleanup = { projectIds: [], sessions: [] };

/**
 * 回放夹具：N1 生成的真实周报 .docx（真 PK/ZIP OOXML —— 可被 DocServer 真机转换；字节全等断言用它比对端点回传）。
 */
const FIXTURE_PATH = join(serverRoot, "scripts", "poc10", "fixtures", "n1-03-weekly-report.docx");
const SAMPLE_DOCX = readFileSync(FIXTURE_PATH);

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (item === "--out") out.out = argv[++i];
    else if (item === "--json") out.json = argv[++i];
    else if (item === "--base-url") out.baseUrl = argv[++i];
    else if (item === "--database-url") out.databaseUrl = argv[++i];
    else if (item === "--api-log") out.apiLog = argv[++i];
    else if (item === "--keep") out.keep = true;
  }
  return out;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function b64url(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

/** HS256 签发（与 server/src/modules/file/onlyoffice.jwt.ts 同口径：DocServer 逐请求现签 outbox Bearer 的等同形态）。 */
function signJwt(claims, secret) {
  const header = b64url({ alg: "HS256", typ: "JWT" });
  const payload = b64url(claims);
  return header + "." + payload + "." + createHmac("sha256", secret).update(header + "." + payload).digest("base64url");
}

function decodeJwt(token) {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    return { header: JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")), claims: JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) };
  } catch {
    return null;
  }
}

async function makeSession(userId, idToken) {
  const session = { userId, token: "s82-" + randomBytes(16).toString("hex"), csrf: randomBytes(16).toString("hex") };
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
  if (!ok) throw new Error("S8-2 受控预览端点回放失败（" + id + "）：" + title);
}

function skip(id, title, note) {
  report.push("| SKIP | " + id + " | " + title + " | ");
  report.push("  - 说明：" + note);
  evidence.steps.push({ id, title, expected: "-", actual: "SKIP", ok: true, note: "SKIP：" + note });
  process.stdout.write("SKIP " + id + " " + title + "\n");
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

/** 走真实上传管道（init → 分片直传 → complete）。 */
async function uploadFile({ projectId, name, bytes, docType }) {
  const parts = makeParts(bytes);
  const contentHash = sha256(bytes);
  const init = await call("POST", "/api/v1/files/uploads", {
    projectId,
    name,
    sizeBytes: bytes.length,
    contentHash,
    docType,
    intent: "version",
  });
  const fileId = init.body?.file?.id;
  const uploadId = init.body?.upload?.id;
  if (fileId === undefined || uploadId === undefined) {
    return { init, fileId, uploadId, contentHash, completed: { status: 0, body: null } };
  }
  const signed = await call(
    "POST",
    "/api/v1/files/" + fileId + "/uploads/" + uploadId + "/parts",
    { partNumbers: parts.map((_unused, index) => index + 1) },
  );
  for (let index = 0; index < parts.length; index += 1) {
    await putPart(signed.body.parts[index].url, parts[index]);
  }
  const completed = await call("POST", "/api/v1/files/" + fileId + "/uploads/" + uploadId + "/complete", { contentHash });
  return { init, fileId, uploadId, contentHash, completed };
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
  return { status: response.status, bytes, hash: sha256(bytes), disposition: response.headers.get("content-disposition") };
}

/** 受控端点请求（不跟随重定向：302 若存在必须可见）。 */
async function fetchEndpoint(url, authorization) {
  const headers = authorization === null ? {} : { authorization };
  const response = await fetch(url, { headers, redirect: "manual" });
  const bytes = Buffer.from(await response.arrayBuffer());
  let body = null;
  try {
    body = bytes.length === 0 ? null : JSON.parse(bytes.toString("utf8"));
  } catch {
    body = null;
  }
  return {
    status: response.status,
    headers: response.headers,
    bytes,
    body,
    redirected: response.redirected,
    hash: sha256(bytes),
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

async function docServerUp() {
  try {
    const response = await fetch(ooDocServer + "/healthcheck", { signal: AbortSignal.timeout(5000) });
    const text = (await response.text()).trim().toLowerCase();
    return response.ok && text.includes("true");
  } catch {
    return false;
  }
}

/** 真实 DocServer `/converter`：源 URL = 本仓受控端点（无预签名）——成功即证明 outbox Bearer 现场拉取成立。 */
async function convertViaDocServer(endpointUrl) {
  const key = randomUUID().replace(/-/g, "");
  const params = { url: endpointUrl, outputtype: "pdf", filetype: "docx", key, title: "s8-2-replay.docx", async: false };
  const token = signJwt({ payload: { ...params } }, ooSecret);
  const started = Date.now();
  const response = await fetch(ooDocServer + "/converter", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...params, token }),
    signal: AbortSignal.timeout(120000),
  });
  const text = await response.text();
  let body = null;
  try {
    body = text === "" ? null : JSON.parse(text);
  } catch {
    body = { raw: text.slice(0, 300) };
  }
  let output = null;
  if (body !== null && typeof body.fileUrl === "string") {
    const parsedUrl = new URL(body.fileUrl);
    const download = await fetch(ooDocServer + parsedUrl.pathname + parsedUrl.search, { signal: AbortSignal.timeout(60000) });
    const bytes = Buffer.from(await download.arrayBuffer());
    output = { status: download.status, bytesLength: bytes.length, magic: bytes.subarray(0, 5).toString("latin1") };
  }
  return { status: response.status, body, output, ms: Date.now() - started };
}

function apiLogCounts(logPath, patterns) {
  const text = readFileSync(logPath, "utf8");
  const lines = text.split(/\r?\n/);
  const counts = {};
  for (const pattern of patterns) {
    counts[pattern] = lines.filter((line) => line.includes(pattern)).length;
  }
  return counts;
}

try {
  try {
    const envModule = await import(pathToFileURL(join(serverRoot, "dist", "config", "env.js")).href);
    storageModule = await import(pathToFileURL(join(serverRoot, "dist", "storage", "index.js")).href);
    s3Module = await import("@aws-sdk/client-s3");
    const env = envModule.loadEnv(process.env);
    storage = storageModule.createS3ObjectStorage(env);
    rawClient = storageModule.createS3Client(env);
    ooSecret = env.ONLYOFFICE_JWT_SECRET;
    ooBase = env.ONLYOFFICE_DOCSERVER_API_BASE_URL.replace(/\/+$/, "");
    ooDocServer = env.ONLYOFFICE_DOCSERVER_URL;
    ooViewerTtlSeconds = env.ONLYOFFICE_JWT_TTL_SECONDS;
    if (ooSecret === "") throw new Error("ONLYOFFICE_JWT_SECRET 为空（回放前置：api 与脚本两侧配置同一共享密钥）");
  } catch (error) {
    throw new Error("无法加载 dist / ONLYOFFICE 环境（先 npm run build，并用 --env-file-if-exists=.env 带上 ONLYOFFICE_* / S3_*）：" + String(error));
  }

  db = new Client({ connectionString: DATABASE_URL });
  await db.connect();

  // ---------- S0：依赖就绪 ----------
  const health = await fetch(BASE_URL + "/healthz").then((response) => response.status).catch(() => 0);
  const ready = await fetch(BASE_URL + "/readyz").then((response) => response.status).catch(() => 0);
  check("S0", "api 可用（/healthz + /readyz：含存储探针）", "200 / 200", health + " / " + ready, health === 200 && ready === 200);

  // ---------- P1 / F1：铸会话 → 建回放项目 → 上传夹具（真实上传管道） ----------
  const adminRow = await db.query(
    "select u.id from users u join user_roles ur on ur.user_id = u.id join roles r on r.id = ur.role_id where r.code = $1 and u.status = $2 order by u.id limit 1",
    ["admin", "active"],
  );
  adminId = adminRow.rows[0]?.id;
  if (adminId === undefined) throw new Error("找不到可用的管理员账号（roles.code = admin）");
  admin = await makeSession(adminId, "s82-replay-admin");
  cleanup.sessions.push(admin.token);

  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const created = await call("POST", "/api/v1/projects", {
    code: "S82-" + stamp,
    name: "s8-2 受控预览端点回放项目",
    projectType: "default",
    managerIds: [adminId],
  });
  check("P1", "建回放项目（为 file 提供 projectId）", "201 + 项目可见", created.status + " " + short({ id: created.body?.id }, 120), created.status === 201);
  project = created.body.id;
  cleanup.projectIds.push(project);

  const uploaded = await uploadFile({ projectId: project, name: "受控端点回放-周报.docx", bytes: SAMPLE_DOCX, docType: "技术协议" });
  const fileId = uploaded.fileId;
  const versionId = uploaded.completed.body?.version?.id;
  const contentHash = uploaded.contentHash;
  check(
    "F1",
    "上传 N1 真实 .docx 夹具（init → 分片直传 → complete）",
    "200 + 版本 v1 + contentHash 与夹具一致",
    short({ status: uploaded.completed.status, seq: uploaded.completed.body?.version?.seq, hash: String(contentHash).slice(0, 12) + "…" }, 200),
    uploaded.completed.status === 200 && uploaded.completed.body?.version?.seq === 1 && contentHash === sha256(SAMPLE_DOCX),
  );
  const versionRow = (await db.query("select object_key, mime, size_bytes, content_hash from file_versions where id = $1", [versionId])).rows[0];
  const endpointUrl = ooBase + "/api/v1/files/" + fileId + "/versions/" + versionId + "/preview-content";

  // ---------- ④ 查看器签发：形状 + token（无 X-Amz- / HMAC / claims / TTL） ----------
  const preview = await call("GET", "/api/v1/files/" + fileId + "/preview", undefined, admin);
  const viewer = preview.body?.viewer ?? null;
  check(
    "A4a",
    "④ 查看器签发形状：Office（.docx）→ ready + viewer 非空、产物字段全空；permissions 只读；document.url = 受控端点（配置基址同源）",
    "ready + target/url/expiresAt/pipelineVersion/generatedAt = null + viewer.kind=onlyoffice/word/docx + permissions(edit..chat=false, protect=true)",
    short(
      {
        status: preview.body?.status,
        target: preview.body?.target,
        url: preview.body?.url,
        viewer: viewer === null ? null : { kind: viewer.kind, docServerUrl: viewer.docServerUrl, documentType: viewer.documentType, document: viewer.document, mode: viewer.editorConfig?.mode },
      },
      420,
    ),
    preview.status === 200 &&
      preview.body?.status === "ready" &&
      preview.body?.target === null &&
      preview.body?.url === null &&
      preview.body?.expiresAt === null &&
      preview.body?.pipelineVersion === null &&
      preview.body?.generatedAt === null &&
      viewer !== null &&
      viewer.kind === "onlyoffice" &&
      viewer.docServerUrl === ooDocServer &&
      viewer.documentType === "word" &&
      viewer.document?.fileType === "docx" &&
      viewer.document?.key === contentHash &&
      viewer.document?.url === endpointUrl &&
      viewer.editorConfig?.mode === "view" &&
      viewer.editorConfig?.user?.id === adminId &&
      typeof viewer.editorConfig?.user?.name === "string" &&
      viewer.editorConfig.user.name.length > 0 &&
      viewer.permissions?.edit === false &&
      viewer.permissions?.download === false &&
      viewer.permissions?.print === false &&
      viewer.permissions?.comment === false &&
      viewer.permissions?.chat === false &&
      viewer.permissions?.fillForms === false &&
      viewer.permissions?.protect === true,
  );

  const token = viewer?.token ?? "";
  const decoded = decodeJwt(token);
  const [tokenHeader, tokenPayload, tokenSignature] = token.split(".");
  const expectedSignature =
    tokenSignature === undefined ? "" : createHmac("sha256", ooSecret).update(tokenHeader + "." + tokenPayload).digest("base64url");
  const noPresign = JSON.stringify(preview.body).includes("X-Amz-") === false;
  check(
    "A4b",
    "④ 配置 token：无 `X-Amz-` 预签名参数 + HMAC 复算一致 + claims 四段 + TTL = ONLYOFFICE_JWT_TTL_SECONDS",
    "无 X-Amz- + 签名一致 + documentType=word + editorConfig.mode=view + exp - iat = " + ooViewerTtlSeconds,
    short(
      {
        noPresign,
        signatureMatch: tokenSignature === expectedSignature,
        documentType: decoded?.claims?.documentType,
        mode: decoded?.claims?.editorConfig?.mode,
        documentUrl: decoded?.claims?.document?.url,
        ttl: decoded?.claims?.exp === undefined ? null : decoded.claims.exp - decoded.claims.iat,
      },
      420,
    ),
    noPresign &&
      tokenSignature === expectedSignature &&
      decoded !== null &&
      decoded.header?.alg === "HS256" &&
      decoded.claims?.documentType === "word" &&
      decoded.claims?.document?.url === endpointUrl &&
      decoded.claims?.document?.key === contentHash &&
      decoded.claims?.editorConfig?.mode === "view" &&
      decoded.claims?.permissions?.download === false &&
      decoded.claims?.exp - decoded.claims?.iat === ooViewerTtlSeconds,
  );

  const previewAudits = await auditOf(project, "preview");
  check(
    "A4c",
    "④ 查看器预览签发写一条 `action = preview` 审计（2026-10-23 恢复）；preview-content 拉取不额外写",
    "1 条（版本 " + versionId + " + viewerKind=onlyoffice）",
    short({ count: previewAudits.length }, 200),
    previewAudits.length === 1 && previewAudits[0].metadata?.versionId === versionId && previewAudits[0].metadata?.viewerKind === "onlyoffice",
  );

  // ---------- ① / ③ 受控端点：outbox Bearer 正常拉取（字节全等、响应头、无重定向） ----------
  const nowSeconds = Math.floor(Date.now() / 1000);
  const outboxToken = signJwt({ payload: { url: endpointUrl }, iat: nowSeconds, exp: nowSeconds + 300 }, ooSecret);
  const pulled = await fetchEndpoint(endpointUrl.replace(ooBase, BASE_URL), "Bearer " + outboxToken);
  check(
    "A1",
    "① DocServer 形态 outbox Bearer → 200 + 字节与上传夹具逐字节一致 + 安全响应头（Content-Type 取版本 mime / Content-Length / inline / no-store / nosniff）",
    "200 + sha256=" + sha256(SAMPLE_DOCX).slice(0, 12) + "… + content-type=" + (versionRow?.mime ?? "-"),
    short(
      {
        status: pulled.status,
        hash: pulled.hash.slice(0, 12) + "…",
        contentType: pulled.headers.get("content-type"),
        contentLength: pulled.headers.get("content-length"),
        disposition: pulled.headers.get("content-disposition"),
        cacheControl: pulled.headers.get("cache-control"),
        nosniff: pulled.headers.get("x-content-type-options"),
      },
      420,
    ),
    pulled.status === 200 &&
      pulled.hash === sha256(SAMPLE_DOCX) &&
      pulled.headers.get("content-type") === (versionRow.mime ?? "application/octet-stream") &&
      Number(pulled.headers.get("content-length")) === SAMPLE_DOCX.length &&
      pulled.headers.get("content-disposition") === "inline" &&
      pulled.headers.get("cache-control") === "no-store" &&
      pulled.headers.get("x-content-type-options") === "nosniff",
  );
  check(
    "A3",
    "③ 无重定向：200 直出字节（302 不存在、无 Location、不跟随跳转）",
    "status=200 + 无 location + redirected=false",
    short({ status: pulled.status, location: pulled.headers.get("location"), redirected: pulled.redirected }, 200),
    pulled.status === 200 && pulled.headers.get("location") === null && pulled.redirected === false,
  );

  // ---------- ② 401 反例（六种） ----------
  const tamperedParts = outboxToken.split(".");
  const tampered = tamperedParts[0] + "." + tamperedParts[1] + "." + "A".repeat(tamperedParts[2].length);
  const noneHeader = b64url({ alg: "none", typ: "JWT" });
  const noneBody = b64url({ payload: { url: endpointUrl }, iat: nowSeconds, exp: nowSeconds + 300 });
  const otherUrl = ooBase + "/api/v1/files/" + randomUUID() + "/versions/" + versionId + "/preview-content";
  const negativeCases = [
    { name: "无 Authorization", authorization: null },
    { name: "畸形", authorization: "Bearer abc.def" },
    { name: "签名篡改", authorization: "Bearer " + tampered },
    { name: "过期超容差（now-61）", authorization: "Bearer " + signJwt({ payload: { url: endpointUrl }, iat: nowSeconds - 361, exp: nowSeconds - 61 }, ooSecret) },
    { name: "URL 错配", authorization: "Bearer " + signJwt({ payload: { url: otherUrl }, iat: nowSeconds, exp: nowSeconds + 300 }, ooSecret) },
    { name: "alg=none", authorization: "Bearer " + noneHeader + "." + noneBody + ".AAAA" },
  ];
  const negativeOutcomes = [];
  for (const testCase of negativeCases) {
    const attempt = await fetchEndpoint(endpointUrl.replace(ooBase, BASE_URL), testCase.authorization);
    negativeOutcomes.push({ name: testCase.name, status: attempt.status, code: attempt.body?.code, message: attempt.body?.message, location: attempt.headers.get("location") });
  }
  const allSame = negativeOutcomes.every(
    (item) => item.status === 401 && item.code === "AUTH_REQUIRED" && item.message === negativeOutcomes[0].message && item.location === null,
  );
  check(
    "A2",
    "② 401 反例 ×6（无 / 畸形 / 篡改 / 过期 / URL 错配 / alg=none）→ 统一 401 AUTH_REQUIRED、同形文案、无重定向",
    "6/6 = 401 + AUTH_REQUIRED + 同一 message",
    short({ cases: negativeOutcomes.map((item) => item.name + "=" + item.status), message: negativeOutcomes[0]?.message }, 420),
    allSame && negativeOutcomes.length === 6,
  );

  // ---------- ①·D 真实 DocServer 拉取（沙箱可达时） ----------
  if (await docServerUp()) {
    const conversion = await convertViaDocServer(endpointUrl);
    docServerRan = conversion.output !== null && conversion.output.status === 200 && conversion.output.magic === "%PDF-";
    check(
      "A1D",
      "①·D 真实 DocServer `/converter`：源 = 受控端点（无预签名）→ outbox Bearer 现场拉取 + 转换产出 PDF",
      "转换成功 + 输出 200 + magic=%PDF-",
      short({ status: conversion.status, error: conversion.body?.error ?? null, output: conversion.output, ms: conversion.ms }, 320),
      docServerRan,
    );
  } else {
    skip("A1D", "①·D 真实 DocServer 拉取", "DocServer 沙箱不可达（" + ooDocServer + "/healthcheck 未通过）—— 本子用例未执行；基线 A1 已由脚本自签同形态 outbox Bearer 覆盖");
  }

  // ---------- ⑤ 401 计数可观测（api 日志） ----------
  if (args.apiLog !== undefined) {
    await new Promise((resolve) => setTimeout(resolve, 800));
    const counts = apiLogCounts(args.apiLog, ["preview-content 401", "preview-content 200"]);
    const expected200 = docServerRan ? 2 : 1;
    check(
      "A5",
      "⑤ 401 计数可观测：api 日志逐条 warn（reason / file / version）；200 逐条记录（含 DocServer 拉取）",
      "401 行 ≥ 6 + 200 行 ≥ " + expected200,
      short({ counts401: counts["preview-content 401"], counts200: counts["preview-content 200"], docServerRan }, 200),
      counts["preview-content 401"] >= 6 && counts["preview-content 200"] >= expected200,
    );
  } else {
    skip("A5", "⑤ 401 计数可观测", "未给 --api-log（api 输出日志路径）—— 401 / 200 逐条 warn 由 unit 覆盖（preview-content.test.ts 日志计数无断言）；本项在带日志复跑时断言");
  }

  // ---------- ⑥ 下载链回归（下载链独立不动） ----------
  const signed = await call("GET", "/api/v1/files/" + fileId + "/versions/" + versionId + "/download-url", undefined, admin);
  const downloaded = signed.status === 200 ? await fetchSigned(signed.body.url) : { status: 0, hash: "", disposition: null };
  const downloadAudits = await auditOf(project, "download");
  check(
    "A6",
    "⑥ 下载链回归：download-url 200 + 签名字节 = 原对象（非转换件）+ download 审计一条一次",
    "200 + sha256=" + sha256(SAMPLE_DOCX).slice(0, 12) + "… + download 审计 1 条",
    short(
      {
        status: signed.status,
        hash: downloaded.hash.slice(0, 12) + "…",
        disposition: downloaded.disposition,
        downloads: downloadAudits.length,
        previews: (await auditOf(project, "preview")).length,
      },
      360,
    ),
    signed.status === 200 &&
      downloaded.status === 200 &&
      downloaded.hash === sha256(SAMPLE_DOCX) &&
      String(downloaded.disposition).startsWith("attachment") &&
      downloadAudits.length === 1 &&
      downloadAudits[0].metadata?.versionId === versionId &&
      downloadAudits[0].object_id === fileId,
  );
} catch (error) {
  failures += 1;
  report.push("| FAIL | 中断：" + (error instanceof Error ? error.message : String(error)) + " | ");
  process.stderr.write("S8-2 受控预览端点回放失败：" + (error instanceof Error ? error.message : String(error)) + "\n");
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
lines.push("# S8-2 回放证据（S3 · ONLYOFFICE 受控预览端点）");
lines.push("");
lines.push("> 卡片：ONLYOFFICE 替换实施切片 **S3**（主责 lan）｜口径来源：`docs/PoC-10-安全定稿(R1-R2·受控下载端点).md` §3.2 / §3.3 / §6（六用例）｜`docs/契约切片草案(S8-2-ONLYOFFICE查看器).md` §三（查看器四段 + 受控端点）｜ADR-030。");
lines.push("> 落点说明：`docs/` 属 px 线；本文件由 lan 随 S3 切片代记（回放脚本与断言同 PR，请 px 复核）。");
lines.push("");
lines.push("| 项 | 值 |");
lines.push("|---|---|");
lines.push("| 回放时间 | " + new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 19).replace("T", " ") + " +08:00 |");
lines.push("| 目标 api | " + BASE_URL + " |");
lines.push("| DocServer | " + ooDocServer + "（沙箱；`request.outbox=true` 由 S2 入口包装固化） |");
lines.push("| DocServer 视角 API 基址 | " + ooBase + "（`ONLYOFFICE_DOCSERVER_API_BASE_URL`：签发与校验的唯一同源配置） |");
lines.push("| 数据库 | " + DATABASE_URL.replace(/:[^:@/]+@/, ":***@") + " |");
lines.push("| 对象存储 | " + (storage === undefined ? "-" : storage.bucket) + "（本地 MinIO 沙箱：仅沙箱、不代表生产选型） |");
lines.push("| 查看器 token TTL | " + ooViewerTtlSeconds + "s（`ONLYOFFICE_JWT_TTL_SECONDS`；受控端点 outbox Bearer 由 DocServer 现签 300s） |");
lines.push("| 代码版本 | " + commit + (dirty ? "（回放时工作区含本卡未提交改动）" : "") + " |");
lines.push("| 夹具 | poc10/fixtures/n1-03-weekly-report.docx（" + SAMPLE_DOCX.length + "B · sha256 " + sha256(SAMPLE_DOCX).slice(0, 16) + "…） |");
lines.push("| 脚本 | server/scripts/s8-2-preview-content-replay.mjs |");
lines.push("");
lines.push("## 断言明细");
lines.push("");
lines.push(...report);
lines.push("");
lines.push("## 汇总");
lines.push("");
lines.push(
  failures === 0
    ? "- ✅ 全部断言通过（" + evidence.steps.filter((step) => step.ok).length + " 项）：查看器签发（无转换产物 / token 无预签名 / 四段 claims / TTL）+ 受控端点（outbox Bearer 200 字节全等、安全响应头、无重定向、401 六反例同形）+ DocServer 真机拉取" + (docServerRan ? "（转换成功）" : "（未执行，见 SKIP）") + " + api 日志计数（" + (args.apiLog === undefined ? "未执行，见 SKIP" : "断言通过") + "）+ 下载链回归。"
    : "- ❌ 有 " + failures + " 项失败，见上方 FAIL 行。",
);
lines.push("");
lines.push("## 未覆盖 / 风险登记");
lines.push("");
lines.push("- **流式读取未做**：`getObject` 整读进内存后直写响应（与 worker 转换读取同口径）；大文件分段流式 + 大小护栏记为遗留（S5 或后续切片）。");
lines.push("- **405 / 503 不走契约错误码**：Nest 异常 → 统一信封为 `INTERNAL`（HTTP 状态 405 / 503 正确）；契约未新增错误码，由 unit（preview-content.test.ts）覆盖。");
lines.push("- **401 计数以日志替代告警出口**：当前为逐条 warn（本脚本 A5 断言行数）；接 M5 监控告警后方为正式指标。");
lines.push("- **Range / HEAD 未覆盖**：PoC 抓包仅见 GET；若 DocServer 后续版本出现 HEAD / Range 拉取，需回 `docs/PoC-10-安全定稿…` §3.2「实现注意」补全。");
lines.push("");
lines.push("## 复跑");
lines.push("");
lines.push("```bash");
lines.push("# api（与 DocServer JWT_SECRET 同值；API 基址用容器可达地址）");
lines.push("cd server && ONLYOFFICE_JWT_SECRET=<与 OO_JWT_SECRET 同值> \\");
lines.push("  ONLYOFFICE_DOCSERVER_API_BASE_URL=http://host.docker.internal:3011 \\");
lines.push("  node --env-file-if-exists=.env dist/entry/api.js");
lines.push("# 回放（同 env；推荐带 --api-log 断言 ⑤）");
lines.push("cd server && node --env-file-if-exists=.env scripts/s8-2-preview-content-replay.mjs \\");
lines.push('  --out "../docs/s8-2-回放证据(S3·受控预览端点).md" --json "../docs/s8-2-回放证据(S3·受控预览端点).json"');
lines.push("```");
lines.push("");

const rendered = lines.map((line) => line.replace(/[ \t]+$/u, ""));
if (args.json !== undefined) writeFileSync(args.json, JSON.stringify(evidence, null, 2) + "\n", "utf8");
if (args.out !== undefined) writeFileSync(args.out, rendered.join("\n"), "utf8");
process.stdout.write(rendered.join("\n") + "\n");
process.exit(failures === 0 ? 0 : 1);
