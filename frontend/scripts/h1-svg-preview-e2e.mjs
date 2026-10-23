#!/usr/bin/env node
/**
 * H1 S6 浏览器端到端回归（B1 ~ B7）。
 *
 * 真实链路：Nginx HTTPS → SPA → API / S3 门面；上传经 Postgres / MinIO /
 * preview.job / worker / deploy/svg-preview，浏览器只读取服务端 PNG 或受控下载。
 * ONLYOFFICE 的 api.js 在 CI 用本地桩替代（真实 DocServer 渲染是发布窗口人工项）。
 *
 * 运行前置：API、worker、Postgres、MinIO、svg-preview、Nginx、ONLYOFFICE 桩已启动；
 * DATABASE_URL 使用可删测试数据的迁移器角色。脚本在 finally 清理本次对象与行。
 *
 * 证据纪律：摘要只保留 origin + pathname；不输出 Cookie、session token、签名 query，
 * 不写生产数据。失败截图写到 H1_ARTIFACT_DIR（默认 /tmp/h1-svg-preview-e2e）。
 */
import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { createRequire } from "node:module";
import { createServer as createNetServer } from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");
const requireFromServer = createRequire(path.join(REPO_ROOT, "server", "package.json"));
const pg = requireFromServer("pg");
const s3Module = requireFromServer("@aws-sdk/client-s3");

const BASE_URL = (process.env.H1_BASE_URL ?? "https://localhost").replace(/\/+$/, "");
const ORIGIN = new URL(BASE_URL).origin;
const DATABASE_URL = process.env.H1_DATABASE_URL ?? process.env.DATABASE_URL ?? "";
const S3_ENDPOINT = process.env.H1_S3_ENDPOINT ?? process.env.S3_ENDPOINT ?? "http://127.0.0.1:9000";
const S3_REGION = process.env.H1_S3_REGION ?? process.env.S3_REGION ?? "us-east-1";
const S3_BUCKET = process.env.H1_S3_BUCKET ?? process.env.S3_BUCKET ?? "libiaolink";
const S3_ACCESS_KEY = process.env.H1_S3_ACCESS_KEY ?? process.env.S3_ACCESS_KEY ?? "libiaolink";
const S3_SECRET_KEY = process.env.H1_S3_SECRET_KEY ?? process.env.S3_SECRET_KEY ?? "libiaolink-dev-secret";
const BACKUP_STORAGE_URL = (process.env.H1_BACKUP_STORAGE_URL ?? "").replace(/\/+$/, "");
const REQUIRE_HEADERS = process.env.H1_REQUIRE_HEADERS !== "0";
const ARTIFACT_DIR = process.env.H1_ARTIFACT_DIR ?? "/tmp/h1-svg-preview-e2e";
const CLEANUP = process.env.H1_CLEANUP !== "0";
const CHROME_PATH = process.env.CHROME_PATH ?? (process.platform === "win32"
  ? "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"
  : "google-chrome");

const results = { B1: [], B2: [], B3: [], B4: [], B5: [], B6: [], B7: [] };
const created = { projectId: null, taskId: null, userId: null, sessionId: null, versionIds: new Set() };
const BACKGROUND_TRANSLATE_WRITES = new Set(["/api/v1/translate", "/api/v1/translate/batch"]);
// 2026-10-23：项目详情进入会显式写一条访问审计；仅放行该受控路径，恶意 SVG 对 /api/v1/projects 的写仍须被捕获。
const PROJECT_VISIT_WRITE = /^\/api\/v1\/projects\/[0-9a-f-]{36}\/visit$/i;
let db = null;
let s3 = null;
let chrome = null;
let cdp = null;
let failureScreenshot = null;

function fail(message) {
  throw new Error(message);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function record(group, name, detail = "", status = "passed") {
  results[group].push({ name, status, detail: redact(detail) });
  process.stdout.write((status === "passed" ? "PASS" : status.toUpperCase()) + " [" + group + "] " + name + (detail === "" ? "" : " — " + redact(detail)) + "\n");
}

function redact(value) {
  return String(value)
    .replace(/([?&](?:X-Amz-[^=]+|token|Signature|Credential|Security-Token|Expires)=)[^&\s"'<>]+/gi, "$1[REDACTED]")
    .replace(/(https?:\/\/[^\s"'?<>]+\?)[^\s"'<>]+/g, "$1[REDACTED]");
}

function safeLocation(value) {
  try {
    const url = new URL(value, BASE_URL);
    return url.origin + url.pathname;
  } catch {
    return "[invalid-url]";
  }
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(label, probe, timeoutMs = 20_000, intervalMs = 200) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      last = await probe();
      if (last !== false && last !== null && last !== undefined) return last;
    } catch (error) {
      last = error;
    }
    await sleep(intervalMs);
  }
  fail("等待超时：" + label + (last instanceof Error ? " — " + redact(last.message) : ""));
}

function requireConfig() {
  if (DATABASE_URL === "") fail("缺少 H1_DATABASE_URL（或 DATABASE_URL）");
  if (!/^https?:\/\//.test(BASE_URL)) fail("H1_BASE_URL 必须是 http(s) 绝对地址");
}

function createS3Client() {
  return new s3Module.S3Client({
    endpoint: S3_ENDPOINT,
    region: S3_REGION,
    forcePathStyle: true,
    credentials: { accessKeyId: S3_ACCESS_KEY, secretAccessKey: S3_SECRET_KEY },
  });
}

async function writeSummary(status, error) {
  await mkdir(ARTIFACT_DIR, { recursive: true });
  const summary = {
    schemaVersion: 1,
    suite: "H1 S6 SVG preview browser regression",
    generatedAt: new Date().toISOString(),
    status,
    baseOrigin: ORIGIN,
    browser: chrome === null ? null : redact(process.env.H1_BROWSER_VERSION ?? "unknown"),
    headersRequired: REQUIRE_HEADERS,
    matrix: results,
    failureScreenshot: failureScreenshot === null ? null : path.basename(failureScreenshot),
    error: error === undefined ? null : redact(error instanceof Error ? error.message : String(error)),
    deployment: "automated CI-compatible run only; test server / production not deployed by this script",
    manualRemainder: [
      "real ONLYOFFICE DocServer document rendering",
      "real CAD production samples",
      "test-server and production response headers after deployment",
    ],
  };
  await writeFile(path.join(ARTIFACT_DIR, "summary.json"), JSON.stringify(summary, null, 2) + "\n", "utf8");
  return summary;
}

async function connectDatabase() {
  db = new pg.Client({ connectionString: DATABASE_URL, application_name: "h1-s6-browser-e2e" });
  await db.connect();
}

function fakeIdToken(userId) {
  const encode = (value) => Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  return encode({ alg: "none", typ: "JWT" }) + "." + encode({ sub: "h1-s6-" + userId, name: "H1 S6 E2E" }) + ".e2e";
}

async function seedActor() {
  const userId = randomUUID();
  const sessionId = randomUUID();
  const sessionToken = randomBytes(32).toString("base64url");
  const csrfToken = randomBytes(32).toString("base64url");
  const tokenHash = sha256(Buffer.from(sessionToken, "utf8"));
  const casdoorId = "h1-s6-" + randomUUID();
  const username = "h1_s6_e2e_" + randomUUID().slice(0, 12);
  await db.query("begin");
  try {
    await db.query(
      "insert into users (id, casdoor_id, username, display_name, email, status) values ($1, $2, $3, $4, null, 'active')",
      [userId, casdoorId, username, "H1 S6 Browser E2E"],
    );
    const role = await db.query("select id from roles where code = 'admin' limit 1");
    if (role.rowCount !== 1) fail("数据库缺少 admin 角色；先执行 database/scripts/seed.mjs");
    await db.query("insert into user_roles (user_id, role_id) values ($1, $2)", [userId, role.rows[0].id]);
    await db.query(
      "insert into sessions (id, token_hash, user_id, id_token, last_seen_at, expires_at) " +
        "values ($1, $2, $3, $4, now(), now() + interval '2 hours')",
      [sessionId, tokenHash, userId, fakeIdToken(userId)],
    );
    await db.query("commit");
    Object.assign(created, { userId, sessionId });
    return { userId, sessionToken, csrfToken };
  } catch (error) {
    await db.query("rollback").catch(() => {});
    throw error;
  }
}

async function purgeS3Prefix(prefix) {
  if (s3 === null || prefix === "") return 0;
  let token;
  let deleted = 0;
  do {
    const page = await s3.send(new s3Module.ListObjectsV2Command({
      Bucket: S3_BUCKET,
      Prefix: prefix,
      ContinuationToken: token,
    }));
    const objects = (page.Contents ?? []).flatMap((item) => item.Key === undefined ? [] : [{ Key: item.Key }]);
    if (objects.length > 0) {
      await s3.send(new s3Module.DeleteObjectsCommand({ Bucket: S3_BUCKET, Delete: { Objects: objects, Quiet: true } }));
      deleted += objects.length;
    }
    token = page.IsTruncated === true ? page.NextContinuationToken : undefined;
  } while (token !== undefined);
  return deleted;
}

async function cleanup() {
  if (s3 === null) s3 = createS3Client();
  const prefixes = [];
  if (created.projectId !== null) prefixes.push("projects/" + created.projectId + "/");
  for (const versionId of created.versionIds) prefixes.push("previews/versions/" + versionId + "/");
  for (const prefix of prefixes) await purgeS3Prefix(prefix).catch(() => 0);
  if (db === null) return;
  await db.query("begin");
  try {
    const projectId = created.projectId;
    const userId = created.userId;
    if (projectId !== null) {
      await db.query("update files set current_version_id = null where project_id = $1", [projectId]);
      await db.query("delete from file_links where file_id in (select id from files where project_id = $1)", [projectId]);
      await db.query("delete from preview_artifacts where file_id in (select id from files where project_id = $1)", [projectId]);
      await db.query("delete from upload_sessions where file_id in (select id from files where project_id = $1)", [projectId]);
      await db.query("delete from file_versions where file_id in (select id from files where project_id = $1)", [projectId]);
      await db.query("delete from files where project_id = $1", [projectId]);
      await db.query("delete from change_requests where project_id = $1", [projectId]);
      await db.query("delete from task_events where task_id in (select id from tasks where project_id = $1)", [projectId]);
      await db.query("delete from tasks where project_id = $1", [projectId]);
      await db.query("delete from node_requirements where node_id in (select id from project_nodes where project_id = $1)", [projectId]);
      await db.query("delete from project_nodes where project_id = $1", [projectId]);
      await db.query("delete from project_stages where project_id = $1", [projectId]);
      await db.query("delete from project_members where project_id = $1", [projectId]);
      await db.query("delete from projects where id = $1", [projectId]);
      await db.query("delete from outbox_events where payload->>'projectId' = $1", [projectId]);
    }
    if (userId !== null) {
      await db.query("delete from audit_logs where actor_id = $1 or project_id = $2", [userId, created.projectId]);
      await db.query("delete from sessions where user_id = $1", [userId]);
      await db.query("delete from user_roles where user_id = $1", [userId]);
      await db.query("delete from user_preferences where user_id = $1", [userId]);
      await db.query("delete from users where id = $1", [userId]);
    }
    await db.query("commit");
  } catch (error) {
    await db.query("rollback").catch(() => {});
    throw error;
  }
}

let auth = null;

function cookieHeader() {
  if (auth === null) fail("测试会话尚未建立");
  return "ll_sid=" + auth.sessionToken + "; ll_csrf=" + auth.csrfToken;
}

async function apiRequest(pathname, options = {}) {
  const method = (options.method ?? "GET").toUpperCase();
  const headers = new Headers(options.headers);
  headers.set("Cookie", cookieHeader());
  headers.set("Accept", "application/json");
  headers.set("Connection", "close");
  if (!["GET", "HEAD", "OPTIONS"].includes(method)) headers.set("X-CSRF-Token", auth.csrfToken);
  if (options.body !== undefined && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const response = await fetch(BASE_URL + pathname, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = text === "" ? null : JSON.parse(text);
  } catch {
    payload = null;
  }
  if (!response.ok) {
    const error = new Error(
      "API " + method + " " + safeLocation(BASE_URL + pathname) + " → HTTP " + String(response.status) +
        (payload && typeof payload.code === "string" ? " / " + payload.code : ""),
    );
    error.status = response.status;
    error.code = payload && typeof payload.code === "string" ? payload.code : null;
    error.details = payload && Array.isArray(payload.details) ? payload.details : [];
    throw error;
  }
  return payload;
}

async function createProjectTask(actorId) {
  const stamp = Date.now().toString(36).toUpperCase();
  const project = await apiRequest("/api/v1/projects", {
    method: "POST",
    body: {
      code: "H1S6-" + stamp,
      name: "H1 S6 浏览器回归 " + stamp,
      projectType: "default",
      region: "未分类",
      managerIds: [actorId],
    },
  });
  created.projectId = project.id;
  const task = await apiRequest("/api/v1/projects/" + project.id + "/tasks", {
    method: "POST",
    body: {
      stageKey: "design",
      title: "H1 S6 SVG 预览浏览器回归",
      titleEn: "H1 S6 SVG preview browser regression",
      ownerIds: [actorId],
    },
  });
  created.taskId = task.id;
  return { project, task };
}

async function uploadFile(input) {
  const bytes = Buffer.from(input.bytes);
  const contentHash = sha256(bytes);
  const body = {
    projectId: created.projectId,
    name: input.name,
    sizeBytes: bytes.byteLength,
    contentHash,
    intent: "version",
    taskId: created.taskId,
  };
  if (input.mime !== undefined && input.mime !== null && input.mime !== "") body.mime = input.mime;
  const started = await apiRequest("/api/v1/files/uploads", { method: "POST", body });
  if (started.upload === null) fail("任务成果上传被意外复用，应新建文件：" + input.name);
  const fileId = started.file.id;
  const uploadId = started.upload.id;
  const partNumbers = Array.from({ length: started.upload.totalParts }, (_, index) => index + 1);
  const signed = await apiRequest(
    "/api/v1/files/" + fileId + "/uploads/" + uploadId + "/parts",
    { method: "POST", body: { partNumbers } },
  );
  for (const part of signed.parts) {
    const partBytes = bytes.subarray((part.partNumber - 1) * signed.partSizeBytes, part.partNumber * signed.partSizeBytes);
    const response = await fetch(part.url, {
      method: "PUT",
      body: partBytes,
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) fail("分片直传失败 " + input.name + " part " + String(part.partNumber) + " → HTTP " + String(response.status));
    await response.arrayBuffer();
  }
  let completed;
  try {
    completed = await apiRequest(
      "/api/v1/files/" + fileId + "/uploads/" + uploadId + "/complete",
      { method: "POST", body: { contentHash } },
    );
  } catch (error) {
    if (error !== null && typeof error === "object") error.uploadAttempt = { fileId, uploadId };
    throw error;
  }
  created.versionIds.add(completed.version.id);
  return {
    id: fileId,
    versionId: completed.version.id,
    file: completed.file,
    version: completed.version,
    bytes,
    contentHash,
    name: input.name,
  };
}

async function expectUploadRejected(input, expectedDetailCode) {
  let error = null;
  try {
    await uploadFile(input);
  } catch (caught) {
    error = caught;
  }
  if (error === null) fail("冲突文件本应拒绝完成上传，实际成功：" + input.name);
  assert(
    error.status === 400,
    "冲突上传应返回 400，实际 HTTP " + String(error.status) + "：" + redact(error.message ?? String(error)),
  );
  assert(error.code === "VALIDATION_FAILED", "冲突上传错误码应为 VALIDATION_FAILED，实际 " + String(error.code));
  const codes = error.details.map((item) => item && item.code).filter(Boolean);
  assert(codes.includes(expectedDetailCode), "冲突上传缺少 detail code " + expectedDetailCode + "；实际 " + codes.join(","));
  const attempt = error.uploadAttempt;
  assert(attempt !== undefined && typeof attempt.fileId === "string", "冲突上传缺少被拒绝的文件标识");
  const versions = await db.query("select count(*)::int as count from file_versions where file_id = $1", [attempt.fileId]);
  const versionCount = versions.rows[0]?.count;
  assert(versionCount === 0, "冲突上传后仍生成了版本行：fileId=" + attempt.fileId + " count=" + String(versionCount));
  return { name: input.name, status: error.status, code: error.code, detail: expectedDetailCode, versionCount };
}

async function readPreview(fileId, versionId) {
  const query = versionId === undefined || versionId === null ? "" : "?versionId=" + encodeURIComponent(versionId);
  return apiRequest("/api/v1/files/" + fileId + "/preview" + query);
}

async function previewUntil(fileId, versionId, expected = "ready", timeoutMs = 25_000) {
  return waitFor(
    "预览 " + expected + " · " + fileId,
    async () => {
      const preview = await readPreview(fileId, versionId);
      if (expected === "terminal") return preview.status === "ready" || preview.status === "failed" ? preview : null;
      return preview.status === expected ? preview : null;
    },
    timeoutMs,
    300,
  );
}

function assertNoSvgPreviewUrl(preview, item, label) {
  if (preview.status === "failed") {
    assert(preview.url === null, label + "：failed 状态不得回退签名 URL");
    assert(typeof preview.reason === "string" && preview.reason.length > 0, label + "：failed 应带降级原因");
    return "failed";
  }
  assert(preview.status === "ready", label + "：预览状态应为 ready 或 failed，实际 " + preview.status);
  assert(typeof preview.url === "string" && preview.url !== "", label + "：ready 应返回 URL");
  const url = new URL(preview.url);
  const expectedPath = "/" + S3_BUCKET + "/previews/versions/" + item.versionId + "/" + item.contentHash + "/2.0.0/image";
  assert(url.pathname === expectedPath, label + "：SVG 预览必须指向当前版本的 2.0.0 PNG 产物，实际 " + safeLocation(preview.url));
  assert(!url.pathname.toLowerCase().includes(".svg"), label + "：预览路径不得含 .svg");
  assert(!url.pathname.includes("/projects/"), label + "：预览不得指向原对象");
  assert(preview.target === "image", label + "：target 应为 image");
  assert(preview.pipelineVersion === "2.0.0", label + "：pipelineVersion 应为 2.0.0");
  return "ready";
}

async function fetchBytes(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) fail("下载响应 HTTP " + String(response.status) + "：" + safeLocation(url));
  return {
    bytes: Buffer.from(await response.arrayBuffer()),
    headers: response.headers,
    contentType: response.headers.get("content-type") ?? "",
    contentDisposition: response.headers.get("content-disposition") ?? "",
  };
}

function assertPngBytes(bytes, label) {
  assert(
    bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    label + "：PNG 魔数不正确",
  );
}

/** SVG 只允许 ready=PNG 产物或 failed=无 URL；两种情况都不得泄漏原对象直签。 */
async function assertSvgTerminalClosed(preview, item, label) {
  const state = assertNoSvgPreviewUrl(preview, item, label);
  if (state === "ready") {
    const artifact = await fetchBytes(preview.url);
    assert(artifact.contentType.toLowerCase().startsWith("image/png"), label + "：产物 Content-Type 不是 image/png");
    assertPngBytes(artifact.bytes, label);
  }
  return state;
}

async function inspectSvgTerminal(item, label) {
  const preview = await previewUntil(item.id, item.versionId, "terminal");
  const state = await assertSvgTerminalClosed(preview, item, label);
  return { preview, state };
}

async function runB3(fixtures) {
  const accepted = [];
  for (const [item, label] of [
    [fixtures.param, "B3 MIME 参数"],
    [fixtures.uppercase, "B3 大写扩展名"],
    [fixtures.double, "B3 双扩展名"],
  ]) {
    const terminal = await inspectSvgTerminal(item, label);
    accepted.push({ name: item.name, status: terminal.state });
    record("B3", label, "accepted; terminal=" + terminal.state);
  }

  const mimeConflict = await expectUploadRejected(
    { name: "h1-mime-conflict.svg", mime: "image/png", bytes: fixtures.normal.bytes },
    "mime_mismatch",
  );
  record("B3", "扩展名 / MIME 冲突", "HTTP 400 / VALIDATION_FAILED / " + mimeConflict.detail + " / file_versions=0");

  const contentConflict = await expectUploadRejected(
    { name: "h1-content-conflict.png", mime: "image/png", bytes: fixtures.double.bytes },
    "content_mismatch",
  );
  record("B3", "文件头 / 扩展名冲突", "HTTP 400 / VALIDATION_FAILED / " + contentConflict.detail + " / file_versions=0");

  await apiRequest("/api/v1/files/" + fixtures.renamed.id, {
    method: "PATCH",
    body: { name: "h1-rename-history.png", version: fixtures.renamed.file.version },
  });
  const renamed = await inspectSvgTerminal(fixtures.renamed, "B3 改名后历史版本");
  assert(renamed.preview.versionId === fixtures.renamed.versionId, "B3 历史版本预览返回了错误版本");
  record("B3", "改名后历史版本仍按原扩展名裁决", "terminal=" + renamed.state + "; 无 .svg 直链");
  return accepted;
}

async function runB4(item) {
  const download = await downloadArtifact(item.id, item.versionId);
  assert(/\.svg$/i.test(download.fileName), "B4 下载文件名未保留 SVG 扩展名：" + download.fileName);
  assert(
    download.contentType.split(";")[0].trim().toLowerCase() === "application/octet-stream",
    "B4 下载 Content-Type 应为 application/octet-stream，实际 " + download.contentType,
  );
  assert(/^attachment\b/i.test(download.contentDisposition), "B4 下载不是 attachment：" + download.contentDisposition);
  assert(download.bytes.equals(item.bytes), "B4 下载字节与上传原文件不一致");
  assert(sha256(download.bytes) === item.contentHash, "B4 下载 SHA-256 与上传声明不一致");
  record("B4", "原 SVG 下载", "attachment; application/octet-stream; SHA-256=" + item.contentHash.slice(0, 12) + "…");
  return download;
}

async function downloadArtifact(fileId, versionId) {
  const signed = await apiRequest("/api/v1/files/" + fileId + "/versions/" + versionId + "/download-url");
  return { ...signed, ...(await fetchBytes(signed.url)) };
}

function svgFixture(label, color) {
  return Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360">' +
      '<rect width="640" height="360" fill="#f8fafc"/>' +
      '<rect x="28" y="28" width="584" height="304" rx="24" fill="' + color + '"/>' +
      '<circle cx="160" cy="180" r="78" fill="#ffffff" fill-opacity="0.82"/>' +
      '<path d="M330 108h190v144H330z" fill="#0f172a" fill-opacity="0.18"/>' +
      '<text x="320" y="196" text-anchor="middle" font-family="Noto Sans CJK SC, sans-serif" ' +
        'font-size="42" font-weight="700" fill="#0f172a">' + label + '</text>' +
      '<text x="320" y="244" text-anchor="middle" font-family="Noto Sans CJK SC, sans-serif" ' +
        'font-size="20" fill="#334155">中文 SVG 安全预览</text>' +
    '</svg>',
    "utf8",
  );
}

async function loadFixtures() {
  const readAsset = (name) => readFile(path.join(REPO_ROOT, "server", "assets", name));
  const webp = Buffer.from("UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA", "base64");
  const normalSvg = svgFixture("正常图纸", "#93c5fd");
  const paramSvg = svgFixture("MIME 参数", "#86efac");
  const uppercaseSvg = svgFixture("大写扩展名", "#fde68a");
  const doubleSvg = svgFixture("双扩展名", "#c4b5fd");
  const renamedSvg = svgFixture("改名后历史版本", "#fca5a5");
  const maliciousSvg = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360" ' +
      'onload="window.__h1XssMarkers=(window.__h1XssMarkers||[]).concat(`onload`);' +
      'fetch(`/api/v1/projects`,{method:`POST`,headers:{`Content-Type`:`application/json`},body:`{}`})">' +
      '<script>window.__h1XssMarkers=(window.__h1XssMarkers||[]).concat(`script`);' +
        'try{void document.cookie}catch(e){};fetch(`/api/v1/projects`,{method:`POST`,body:`{}`})</script>' +
      '<rect width="640" height="360" fill="#ef4444"/>' +
      '<text x="320" y="196" text-anchor="middle" font-size="42" fill="#fff">malicious SVG</text>' +
    '</svg>',
    "utf8",
  );
  const pdf = Buffer.from(
    "%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n" +
      "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n" +
      "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] >>\nendobj\n" +
      "trailer\n<< /Root 1 0 R >>\n%%EOF\n",
    "utf8",
  );
  const docx = await readFile(path.join(REPO_ROOT, "server", "scripts", "poc10", "fixtures", "n1-03-weekly-report.docx"));
  const stl = Buffer.from(
    "solid h1-s6\n" +
      "  facet normal 0 0 1\n    outer loop\n      vertex 0 0 0\n      vertex 20 0 0\n      vertex 0 20 0\n" +
      "    endloop\n  endfacet\nendsolid h1-s6\n",
    "utf8",
  );
  return {
    normalSvg,
    paramSvg,
    uppercaseSvg,
    doubleSvg,
    renamedSvg,
    maliciousSvg,
    pdf,
    docx,
    stl,
    images: [
      { name: "h1-regression.png", mime: "image/png", bytes: await readAsset("wecom-r06-poster.png") },
      { name: "h1-regression.jpg", mime: "image/jpeg", bytes: await readAsset("r06-brand-banner.jpg") },
      { name: "h1-regression.gif", mime: "image/gif", bytes: await readAsset("wecom-r06-on-time.gif") },
      { name: "h1-regression.webp", mime: "image/webp", bytes: webp },
    ],
  };
}

async function uploadFixtures(fixtures) {
  const normal = await uploadFile({ name: "h1-normal.svg", mime: "image/svg+xml", bytes: fixtures.normalSvg });
  const malicious = await uploadFile({ name: "h1-poc.svg", mime: "image/svg+xml", bytes: fixtures.maliciousSvg });
  const param = await uploadFile({ name: "h1-mime-param.svg", mime: "image/svg+xml; charset=utf-8", bytes: fixtures.paramSvg });
  const uppercase = await uploadFile({ name: "h1-uppercase.SVG", mime: "IMAGE/SVG+XML", bytes: fixtures.uppercaseSvg });
  const double = await uploadFile({ name: "h1-double.png.svg", mime: "image/svg+xml", bytes: fixtures.doubleSvg });
  const renamed = await uploadFile({ name: "h1-rename-history.svg", mime: "image/svg+xml", bytes: fixtures.renamedSvg });
  const pdf = await uploadFile({ name: "h1-regression.pdf", mime: "application/pdf", bytes: fixtures.pdf });
  const docx = await uploadFile({
    name: "h1-regression.docx",
    mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    bytes: fixtures.docx,
  });
  const cad = await uploadFile({ name: "h1-regression.stl", mime: "model/stl", bytes: fixtures.stl });
  const images = [];
  for (const image of fixtures.images) images.push(await uploadFile(image));
  return { normal, malicious, param, uppercase, double, renamed, pdf, docx, cad, images };
}

async function freePort() {
  const server = createNetServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  if (port <= 0) fail("无法分配 Chrome CDP 端口");
  return port;
}

class CdpClient {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.handlers = new Map();
    this.closed = false;
    socket.addEventListener("message", (event) => this.onMessage(event));
    socket.addEventListener("close", () => {
      this.closed = true;
      for (const pending of this.pending.values()) pending.reject(new Error("CDP 连接已关闭"));
      this.pending.clear();
    });
  }

  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("CDP WebSocket 连接超时")), 10_000);
      socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("CDP WebSocket 连接失败")); }, { once: true });
    });
    return new CdpClient(socket);
  }

  on(method, handler) {
    const list = this.handlers.get(method) ?? [];
    list.push(handler);
    this.handlers.set(method, list);
  }

  onMessage(event) {
    let message;
    try {
      message = JSON.parse(String(event.data));
    } catch {
      return;
    }
    if (typeof message.id === "number") {
      const pending = this.pending.get(message.id);
      if (pending === undefined) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message ?? "CDP command failed"));
      else pending.resolve(message.result ?? {});
      return;
    }
    for (const handler of this.handlers.get(message.method) ?? []) {
      try { handler(message.params ?? {}); } catch { /* diagnostics must not break the scenario */ }
    }
  }

  async send(method, params = {}) {
    if (this.closed) fail("CDP 已关闭，无法发送 " + method);
    const id = this.nextId++;
    const promise = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
    this.socket.send(JSON.stringify({ id, method, params }));
    return promise;
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    try { this.socket.close(); } catch { /* already closed */ }
  }
}

function browserScript() {
  return `(() => {
    if (window.__h1S6Installed) return;
    window.__h1S6Installed = true;
    window.__h1CookieReads = 0;
    window.__h1SecurityViolations = [];
    window.__h1XssMarkers = [];
    const descriptor = Object.getOwnPropertyDescriptor(Document.prototype, "cookie");
    if (descriptor && descriptor.get && descriptor.set) {
      Object.defineProperty(Document.prototype, "cookie", {
        configurable: true,
        enumerable: descriptor.enumerable,
        get() {
          window.__h1CookieReads += 1;
          return descriptor.get.call(this);
        },
        set(value) {
          return descriptor.set.call(this, value);
        },
      });
    }
    document.addEventListener("securitypolicyviolation", (event) => {
      window.__h1SecurityViolations.push({
        directive: String(event.violatedDirective || ""),
        blocked: String(event.blockedURI || ""),
        disposition: String(event.disposition || ""),
      });
    }, true);
  })();`;
}

const browserEvents = { exceptions: [], logs: [], dialogs: [], requests: [] };

async function launchBrowser() {
  const port = await freePort();
  const profile = path.join(os.tmpdir(), "h1-s6-chrome-" + randomUUID());
  const args = [
    "--headless=new",
    "--no-first-run",
    "--no-default-browser-check",
    "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=" + String(port),
    "--user-data-dir=" + profile,
    "--ignore-certificate-errors",
    "--enable-unsafe-swiftshader",
    "--disable-dev-shm-usage",
    "--window-size=1440,1200",
    "about:blank",
  ];
  if (process.env.H1_CHROME_NO_SANDBOX === "1" || process.platform === "linux") args.unshift("--no-sandbox");
  chrome = spawn(CHROME_PATH, args, { stdio: ["ignore", "ignore", "ignore"], windowsHide: true });
  chrome.once("exit", (code) => {
    if (cdp !== null && !cdp.closed && code !== null && code !== 0) process.stderr.write("Chrome 退出码 " + String(code) + "\n");
  });
  const target = await waitFor(
    "Chrome DevTools 端点",
    async () => {
      if (chrome.exitCode !== null) fail("Chrome 提前退出，exitCode=" + String(chrome.exitCode));
      const response = await fetch("http://127.0.0.1:" + String(port) + "/json/list", { signal: AbortSignal.timeout(2_000) });
      if (!response.ok) return null;
      const list = await response.json();
      return Array.isArray(list) ? list.find((item) => item && item.type === "page" && typeof item.webSocketDebuggerUrl === "string") ?? null : null;
    },
    20_000,
    250,
  );
  cdp = await CdpClient.connect(target.webSocketDebuggerUrl);
  await Promise.all([
    cdp.send("Page.enable"),
    cdp.send("Runtime.enable"),
    cdp.send("Network.enable"),
    cdp.send("Log.enable"),
  ]);
  cdp.on("Runtime.exceptionThrown", (params) => {
    const detail = params.exceptionDetails;
    browserEvents.exceptions.push(redact(detail?.exception?.description ?? detail?.text ?? "Runtime exception"));
  });
  cdp.on("Log.entryAdded", (params) => {
    const entry = params.entry;
    if (entry && (entry.level === "error" || entry.source === "security")) {
      browserEvents.logs.push({ level: entry.level, source: entry.source, text: redact(entry.text ?? "") });
    }
  });
  cdp.on("Network.requestWillBeSent", (params) => {
    if (!params.request) return;
    browserEvents.requests.push({ method: String(params.request.method ?? "GET").toUpperCase(), url: String(params.request.url ?? "") });
  });
  cdp.on("Page.javascriptDialogOpening", (params) => {
    browserEvents.dialogs.push(redact(params.message ?? params.type ?? "JavaScript dialog"));
    void cdp?.send("Page.handleJavaScriptDialog", { accept: false }).catch(() => {});
  });
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: browserScript() });
  const version = await cdp.send("Browser.getVersion").catch(() => null);
  process.env.H1_BROWSER_VERSION = version === null ? "unknown" : version.product + " / " + version.revision;
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1200, deviceScaleFactor: 1, mobile: false });
}

async function setBrowserCookie(name, value, httpOnly) {
  await cdp.send("Network.setCookie", {
    name,
    value,
    url: BASE_URL + "/",
    path: "/",
    secure: ORIGIN.startsWith("https:"),
    httpOnly,
    sameSite: "Lax",
  });
}

async function evaluate(expression, awaitPromise = false) {
  const response = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise,
    returnByValue: true,
    userGesture: true,
  });
  if (response.exceptionDetails) {
    fail("浏览器脚本异常：" + redact(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text));
  }
  return response.result?.value;
}

async function waitExpression(expression, label, timeoutMs = 20_000) {
  return waitFor(label, async () => Boolean(await evaluate(expression, true)), timeoutMs, 200);
}

async function navigate(url) {
  const result = await cdp.send("Page.navigate", { url });
  return result;
}

async function navigateReady(url) {
  const result = await navigate(url);
  if (result.errorText) fail("导航失败：" + safeLocation(url) + " — " + redact(result.errorText));
  await waitExpression("document.readyState === 'complete'", "页面加载完成 " + safeLocation(url), 30_000);
}

async function pressEscape() {
  await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
}

CdpClient.prototype.captureScreenshot = async function captureScreenshot() {
  await mkdir(ARTIFACT_DIR, { recursive: true });
  const shot = await this.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  const file = path.join(ARTIFACT_DIR, "failure.png");
  await writeFile(file, Buffer.from(shot.data, "base64"));
  return file;
};

async function resetBrowserSignals() {
  browserEvents.exceptions.length = 0;
  browserEvents.logs.length = 0;
  browserEvents.dialogs.length = 0;
  browserEvents.requests.length = 0;
  await evaluate("window.__h1CookieReads=0;window.__h1SecurityViolations=[];window.__h1XssMarkers=[];true;");
}

async function browserSignals() {
  const dom = await evaluate("({cookieReads:window.__h1CookieReads||0,csp:window.__h1SecurityViolations||[],markers:window.__h1XssMarkers||[]})");
  return { ...browserEvents, dom };
}

async function assertNoUnsafeSignals(label) {
  const signals = await browserSignals();
  const apiWrites = signals.requests.filter((item) => {
    const pathname = safeLocation(item.url).replace(ORIGIN, "");
    if (!pathname.startsWith("/api/v1/") || ["GET", "HEAD", "OPTIONS"].includes(item.method)) return false;
    return !(item.method === "POST" && (BACKGROUND_TRANSLATE_WRITES.has(pathname) || PROJECT_VISIT_WRITE.test(pathname)));
  });
  const securityLogs = signals.logs.filter((item) => item.source === "security");
  assert(signals.exceptions.length === 0, label + "：出现未捕获异常 " + signals.exceptions.join(" | "));
  assert(signals.dialogs.length === 0, label + "：出现 JavaScript dialog " + signals.dialogs.join(" | "));
  assert(apiWrites.length === 0, label + "：出现非预期 API 写请求 " + apiWrites.map((item) => item.method + " " + safeLocation(item.url)).join(", "));
  assert(securityLogs.length === 0, label + "：出现 CSP / 安全日志 " + securityLogs.map((item) => item.text).join(" | "));
  assert(signals.dom.csp.length === 0, label + "：出现 securitypolicyviolation " + JSON.stringify(signals.dom.csp));
  assert(signals.dom.cookieReads === 0, label + "：读取了 document.cookie " + String(signals.dom.cookieReads) + " 次");
  assert(signals.dom.markers.length === 0, label + "：恶意 SVG 脚本标记 " + signals.dom.markers.join(","));
}

function fileNameExpression(name) {
  return "Array.from(document.querySelectorAll('[data-drawer-file-item]')).find((row) => (row.textContent || '').includes(" +
    JSON.stringify(name) + "))";
}

async function openTaskDrawer() {
  const projectHash = BASE_URL + "/#/project/" + created.projectId;
  await navigateReady(projectHash);
  await waitExpression(
    "document.querySelector('[data-live-row=" + JSON.stringify(created.taskId) + "]') !== null",
    "项目任务行出现",
    30_000,
  );
  if (await evaluate("document.querySelector('aside[role=dialog]') === null")) {
    await evaluate("(document.querySelector('[data-live-row=" + JSON.stringify(created.taskId) + "]')).click(); true");
  }
  await waitExpression("document.querySelector('aside[role=dialog]') !== null", "任务详情抽屉打开", 20_000);
}

async function ensureDrawerOpen() {
  if (await evaluate("document.querySelector('aside[role=dialog]') !== null")) return;
  await openTaskDrawer();
}

async function findFileRow(name) {
  return waitFor("抽屉文件行 " + name, async () => {
    const found = await evaluate("Boolean(" + fileNameExpression(name) + ")");
    if (!found) return null;
    await evaluate("((" + fileNameExpression(name) + ") || document.body).scrollIntoView({block:'center'}); true");
    return true;
  }, 25_000, 250);
}

async function clickFileControl(name, preferThumb) {
  await findFileRow(name);
  const clicked = await evaluate(
    "(() => { const row = " + fileNameExpression(name) + "; const target = row ? " +
      (preferThumb ? "row.querySelector('[data-file-thumb]')" : "(row.querySelector('[data-file-preview-open]') || row.querySelector('[data-file-thumb]'))") +
      " : null;" +
      " if (!target) return false; target.click(); return true; })()",
  );
  assert(clicked === true, "文件行没有可点击预览控件：" + name);
}

async function waitOverlay(kind) {
  await waitExpression(
    "document.querySelector('[data-file-preview=\"true\"]')?.getAttribute('data-file-preview-kind') === " + JSON.stringify(kind),
    "预览浮层 kind=" + kind,
    20_000,
  );
}

async function closeOverlay() {
  await pressEscape();
  await waitExpression("document.querySelector('[data-file-preview=\"true\"]') === null", "预览浮层关闭", 10_000);
}

async function thumbnailReady(name) {
  await waitExpression(
    "(() => { const row = " + fileNameExpression(name) + "; const img = row?.querySelector('[data-file-thumb] img');" +
      " return Boolean(img && img.complete && img.naturalWidth > 0 && img.naturalHeight > 0); })()",
    "缩略图加载 " + name,
    25_000,
  );
  return evaluate(
    "(() => { const row = " + fileNameExpression(name) + "; const img = row.querySelector('[data-file-thumb] img');" +
      " return {src:img.currentSrc || img.src,naturalWidth:img.naturalWidth,naturalHeight:img.naturalHeight}; })()",
  );
}

async function overlayImageReady() {
  await waitExpression(
    "(() => { const img = document.querySelector('[data-image-zoom-image]'); return Boolean(img && img.complete && img.naturalWidth > 0); })()",
    "浮层图片加载",
    20_000,
  );
  return evaluate(
    "(() => { const img = document.querySelector('[data-image-zoom-image]'); return {src:img.currentSrc || img.src,naturalWidth:img.naturalWidth,naturalHeight:img.naturalHeight}; })()",
  );
}

async function runB1(normal, preview) {
  await resetBrowserSignals();
  await openTaskDrawer();
  // 项目进入会触发一次访问上报，其 CSRF 头需要读取前端自身 Cookie；页面稳定后重置监测基线，
  // 再验证预览交互期间没有恶意 SVG 读取 Cookie 或发起非预期写请求。
  await resetBrowserSignals();
  const thumb = await thumbnailReady(normal.name);
  assertNoSvgPreviewUrl(preview, normal, "B1 正常 SVG");
  assert(new URL(thumb.src).pathname === new URL(preview.url).pathname, "B1 缩略图未使用当前版本的 PNG 产物");
  record("B1", "40×40 SVG 缩略图真实加载", "naturalWidth=" + String(thumb.naturalWidth));
  await clickFileControl(normal.name, true);
  await waitOverlay("image");
  const image = await overlayImageReady();
  assert(new URL(image.src).pathname === new URL(preview.url).pathname, "B1 浮层图片未使用预览 API 的 PNG 产物");
  record("B1", "浮层图片加载", "naturalWidth=" + String(image.naturalWidth));
  const before = Number(await evaluate("document.querySelector('[data-image-zoom-viewer]')?.getAttribute('data-image-zoom') || '1'"));
  await evaluate("document.querySelector('[data-image-zoom-in]').click(); true");
  await waitExpression("Number(document.querySelector('[data-image-zoom-viewer]')?.getAttribute('data-image-zoom') || '1') > " + String(before), "图片放大", 5_000);
  const after = Number(await evaluate("document.querySelector('[data-image-zoom-viewer]')?.getAttribute('data-image-zoom') || '1'"));
  assert(after > before, "B1 图片缩放未生效");
  record("B1", "ImageZoomViewer 缩放", String(Math.round(before * 100)) + "% → " + String(Math.round(after * 100)) + "%");
  await closeOverlay();
  await assertNoUnsafeSignals("B1");
}

async function runB2(malicious, preview, downloadUrl) {
  await ensureDrawerOpen();
  await resetBrowserSignals();
  await clickFileControl(malicious.name, true);
  await sleep(1_200);
  const exposedPreview = await evaluate("document.querySelector('[data-file-preview=\"true\"]') !== null");
  await assertNoUnsafeSignals("B2 应用内点击恶意 SVG");
  if (preview.status === "failed") {
    assert(preview.url === null, "B2 恶意 SVG failed 时不得返回 URL");
    assert(exposedPreview === false, "B2 恶意 SVG failed 时不应打开预览浮层");
    record("B2", "恶意 SVG 预览 fail closed", "status=failed; url=null; reason=" + preview.reason.slice(0, 120));
  } else {
    await assertSvgTerminalClosed(preview, malicious, "B2 恶意 SVG ready");
    const response = await fetchBytes(preview.url);
    assert(response.contentType.toLowerCase().startsWith("image/png"), "B2 恶意 SVG ready 时必须返回 PNG");
    if (exposedPreview) {
      await waitOverlay("image");
      const image = await overlayImageReady();
      assert(new URL(image.src).pathname === new URL(preview.url).pathname, "B2 恶意 SVG 浮层未使用 PNG 产物");
      await closeOverlay();
      record("B2", "恶意 SVG 仅以 PNG 产物进入应用浮层", "status=ready; document 内容未执行");
    }
  }

  await resetBrowserSignals();
  await evaluate(
    "(async () => { const image = new Image(); image.id = 'h1-raw-download-image';" +
      " await new Promise((resolve) => { image.onload = resolve; image.onerror = resolve; window.setTimeout(resolve, 4000);" +
      " image.src = " + JSON.stringify(downloadUrl) + "; document.body.appendChild(image); }); return true; })()",
    true,
  );
  await assertNoUnsafeSignals("B2 恶意 SVG 作为 img");
  record("B2", "原始恶意 SVG 经 attachment 作为 img 不执行", "loaded=" + String(await evaluate("document.getElementById('h1-raw-download-image')?.naturalWidth || 0")));
  await evaluate("document.getElementById('h1-raw-download-image')?.remove(); true");

  if (preview.url === null) {
    record("B2", "恶意 SVG 顶层预览", "无预览 URL（fail closed），不构造直签绕过");
  } else {
    await resetBrowserSignals();
    await navigateReady(preview.url);
    const type = await evaluate("document.contentType");
    assert(type === "image/png", "B2 顶层预览最终文档类型不是 image/png：" + String(type));
    await assertNoUnsafeSignals("B2 恶意 SVG 顶层预览");
    record("B2", "恶意 SVG 顶层预览", "document.contentType=image/png");
  }

  await resetBrowserSignals();
  const nav = await navigate(downloadUrl);
  if (nav.errorText) process.stdout.write("B2 顶层下载导航返回：" + redact(nav.errorText) + "\n");
  await sleep(1_500);
  await assertNoUnsafeSignals("B2 恶意 SVG 顶层下载");
  record("B2", "恶意 SVG 顶层下载不执行", "无脚本、无 API 写、无 Cookie 读取");
}

async function runB5(images) {
  await openTaskDrawer();
  await resetBrowserSignals();
  for (const item of images) {
    const preview = await previewUntil(item.id, item.versionId, "ready");
    assert(preview.url !== null && preview.url !== "", "B5 位图预览未返回 URL：" + item.name);
    assert(preview.viewer === null, "B5 位图不应进入查看器通道：" + item.name);
    assert(preview.pipelineVersion === null, "B5 位图不应占用转换管线：" + item.name);
    assert(preview.target === "image", "B5 位图预览 target 应为 image：" + item.name);
    assert(!new URL(preview.url).pathname.includes("/previews/"), "B5 位图被误路由到 SVG 产物通道：" + item.name);

    const thumb = await thumbnailReady(item.name);
    assert(thumb.naturalWidth > 0 && thumb.naturalHeight > 0, "B5 缩略图自然尺寸无效：" + item.name);
    await clickFileControl(item.name, true);
    await waitOverlay("image");
    const image = await overlayImageReady();
    assert(image.naturalWidth > 0 && image.naturalHeight > 0, "B5 浮层图片自然尺寸无效：" + item.name);
    assert(new URL(image.src).pathname === new URL(preview.url).pathname, "B5 浮层图片与预览 API 地址不一致：" + item.name);
    await closeOverlay();
    record("B5", item.name, "缩略图 " + String(thumb.naturalWidth) + "×" + String(thumb.naturalHeight) + "; 浮层加载");
  }
  await assertNoUnsafeSignals("B5");
}

async function openViewerOverlay(item, kind, label) {
  await ensureDrawerOpen();
  await clickFileControl(item.name, false);
  await waitOverlay(kind);
  await waitExpression(
    "(() => { const viewer = document.querySelector('[data-onlyoffice-viewer=true]');" +
      " return Boolean(viewer && viewer.getAttribute('data-oo-status') === 'ready'); })()",
    label + " ONLYOFFICE 就绪",
    30_000,
  );
  const probe = await evaluate(
    "(() => { const overlay = document.querySelector('[data-file-preview=true]');" +
      " const viewer = overlay?.querySelector('[data-onlyoffice-viewer=true]');" +
      " return {kind:overlay?.getAttribute('data-file-preview-kind') || null,status:viewer?.getAttribute('data-oo-status') || null," +
      " frame:Boolean(overlay?.querySelector('[data-file-preview-frame]'))}; })()",
  );
  assert(probe.kind === kind, label + " 浮层 kind 不正确：" + String(probe.kind));
  assert(probe.status === "ready", label + " ONLYOFFICE 未就绪：" + String(probe.status));
  await closeOverlay();
  return probe;
}

async function runB6(fixtures) {
  await ensureDrawerOpen();
  await resetBrowserSignals();
  for (const [item, kind, label] of [
    [fixtures.pdf, "pdf", "PDF"],
    [fixtures.docx, "office", "DOCX"],
  ]) {
    const preview = await readPreview(item.id, item.versionId);
    assert(preview.status === "ready", "B6 " + label + " 预览未 ready：" + preview.status);
    assert(preview.viewer !== null, "B6 " + label + " 未进入 ONLYOFFICE 查看器通道");
    assert(preview.url === null && preview.target === null, "B6 " + label + " 误入转换产物通道");
    assert(preview.pipelineVersion === null, "B6 " + label + " 不应占用 SVG 转换管线");
    const probe = await openViewerOverlay(item, kind, label);
    record("B6", label + " ONLYOFFICE 回归", "kind=" + String(probe.kind) + "; status=" + String(probe.status) + "; 未进入 PNG 产物");
  }

  const cadPreview = await readPreview(fixtures.cad.id, fixtures.cad.versionId);
  // ADR-035：平台只开放独立 STEP 链；STL 明确降级，不能恢复已移除的原对象直签/浏览器解析。
  assert(cadPreview.status === "failed" && cadPreview.url === null, "B6 未支持的 STL 必须明确降级且不签原对象预览");
  assert(cadPreview.viewer === null && cadPreview.target === null, "B6 STL 不应进入查看器或 PNG 产物通道");
  assert(cadPreview.pipelineVersion === null, "B6 CAD 不应占用 SVG 转换管线");
  assert(typeof cadPreview.reason === "string" && cadPreview.reason.length > 0, "B6 STL 降级缺少用户可见原因");
  await clickFileControl(fixtures.cad.name, false);
  await waitExpression(
    "[...document.querySelectorAll('[data-file-preview-note=true]')].some(node => node.textContent?.includes(" + JSON.stringify(cadPreview.reason) + "))",
    "STL 暂不可预览提示",
    10_000,
  );
  assert(await evaluate("document.querySelector('[data-file-preview=true]') === null"), "B6 STL 不应挂载旧查看器");
  const cadDownload = await downloadArtifact(fixtures.cad.id, fixtures.cad.versionId);
  assert(cadDownload.bytes.equals(fixtures.cad.bytes), "B6 STL 下载字节与上传原文件不一致");
  assert(cadDownload.contentType.split(";")[0].trim().toLowerCase() === "application/octet-stream", "B6 STL 下载必须为 octet-stream");
  assert(/^attachment\b/i.test(cadDownload.contentDisposition), "B6 STL 下载必须为 attachment");
  record("B6", "未支持 STL 的明确降级与原文件下载", "无预览直签、无旧查看器、未进入 PNG 产物；下载 bytes 一致");
  await assertNoUnsafeSignals("B6");
}

function responseHeader(response, name) {
  return (response.headers.get(name) ?? "").toLowerCase();
}

function rawHeaderValues(url, name) {
  const target = new URL(url);
  const request = target.protocol === "https:" ? httpsRequest : httpRequest;
  const wanted = name.toLowerCase();
  return new Promise((resolve, reject) => {
    const req = request(target, { method: "GET" }, (response) => {
      const values = [];
      for (let index = 0; index < response.rawHeaders.length; index += 2) {
        if (response.rawHeaders[index].toLowerCase() === wanted) values.push(response.rawHeaders[index + 1]);
      }
      response.resume();
      response.once("end", () => resolve({ status: response.statusCode ?? 0, values }));
      response.once("error", reject);
    });
    req.setTimeout(15_000, () => req.destroy(new Error("原始响应头读取超时")));
    req.once("error", reject);
    req.end();
  });
}

async function assertHeaderSet(url, label, mode) {
  if (!REQUIRE_HEADERS) {
    record("B7", label, "本地显式 H1_REQUIRE_HEADERS=0，响应头检查跳过；CI 必须以 1 执行", "skipped");
    return null;
  }
  const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(15_000) });
  await response.arrayBuffer();
  const rawHsts = await rawHeaderValues(url, "strict-transport-security");
  assert(rawHsts.values.length === 1, label + " 应回传 1 条 HSTS，实际 " + String(rawHsts.values.length) + " 条");
  const hsts = responseHeader(response, "strict-transport-security");
  const nosniff = responseHeader(response, "x-content-type-options");
  const xfo = responseHeader(response, "x-frame-options");
  const csp = responseHeader(response, "content-security-policy");
  assert(hsts.includes("max-age="), label + " 缺少 HSTS");
  assert(nosniff === "nosniff", label + " 缺少 nosniff");
  assert(xfo === "deny", label + " 缺少 X-Frame-Options: DENY");
  if (mode === "spa") {
    assert(csp.includes("default-src 'self'"), label + " 缺少 SPA CSP default-src");
    assert(csp.includes("frame-ancestors 'none'"), label + " 缺少 SPA frame-ancestors");
    assert(csp.includes("object-src 'none'"), label + " 缺少 SPA object-src");
  } else {
    assert(csp.includes("sandbox"), label + " 缺少 CSP sandbox");
    assert(csp.includes("script-src 'none'"), label + " 缺少 script-src 'none'");
    assert(csp.includes("default-src 'none'"), label + " 缺少 default-src 'none'");
  }
  record("B7", label, "HSTS 1 条 + CSP + nosniff + XFO 生效；HTTP " + String(response.status));
  return response;
}

async function runB7() {
  await assertHeaderSet(BASE_URL + "/", "443 SPA 入口", "spa");
  await assertHeaderSet(BASE_URL + "/libiaolink/__h1_probe__", "443 对象存储门面", "object");
  const backup = BACKUP_STORAGE_URL === "" ? new URL(BASE_URL) : new URL(BACKUP_STORAGE_URL);
  if (BACKUP_STORAGE_URL === "") backup.port = process.env.H1_BACKUP_STORAGE_PORT ?? "9443";
  await assertHeaderSet(backup.origin + "/__h1_probe__", "9443 MinIO 备用门面", "object");

  await resetBrowserSignals();
  await navigateReady(BASE_URL + "/");
  await waitExpression("document.querySelector('#root') !== null", "SPA 根节点", 30_000);
  await sleep(800);
  const signals = await browserSignals();
  const securityLogs = signals.logs.filter((item) => item.source === "security");
  assert(signals.dom.csp.length === 0, "B7 SPA 出现 securitypolicyviolation：" + JSON.stringify(signals.dom.csp));
  assert(securityLogs.length === 0, "B7 SPA 出现安全日志：" + securityLogs.map((item) => item.text).join(" | "));
  record("B7", "SPA 浏览器控制台", "无 CSP violation / 安全日志");
}

async function main() {
  requireConfig();
  await mkdir(ARTIFACT_DIR, { recursive: true });
  try {
    await connectDatabase();
    s3 = createS3Client();
    auth = await seedActor();
    await createProjectTask(auth.userId);
    const fixtures = await loadFixtures();
    const uploaded = await uploadFixtures(fixtures);

    await launchBrowser();
    await setBrowserCookie("ll_sid", auth.sessionToken, true);
    await setBrowserCookie("ll_csrf", auth.csrfToken, false);
    await navigateReady(BASE_URL + "/");

    const normalPreview = await previewUntil(uploaded.normal.id, uploaded.normal.versionId, "ready");
    await runB1(uploaded.normal, normalPreview);

    const maliciousPreview = await previewUntil(uploaded.malicious.id, uploaded.malicious.versionId, "terminal");
    const maliciousDownload = await runB4(uploaded.malicious);
    await runB2(uploaded.malicious, maliciousPreview, maliciousDownload.url);

    await runB3(uploaded);
    await runB5(uploaded.images);
    await runB6(uploaded);
    await runB7();

    const summary = await writeSummary("passed");
    process.stdout.write("H1 S6 browser regression passed: " + path.join(ARTIFACT_DIR, "summary.json") + "\n");
    process.stdout.write(JSON.stringify(summary.matrix) + "\n");
  } catch (error) {
    if (cdp !== null) failureScreenshot = await cdp.captureScreenshot().catch(() => null);
    await writeSummary("failed", error).catch(() => {});
    throw error;
  } finally {
    await cdp?.close().catch(() => {});
    if (chrome !== null && chrome.exitCode === null) chrome.kill("SIGKILL");
    if (CLEANUP) await cleanup().catch((error) => process.stderr.write("cleanup warning: " + redact(error.message) + "\n"));
    await s3?.destroy();
    await db?.end().catch(() => {});
  }
}

main().catch((error) => {
  process.stderr.write("H1 S6 browser regression failed: " + redact(error instanceof Error ? error.stack ?? error.message : error) + "\n");
  process.exitCode = 1;
});
