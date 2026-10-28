#!/usr/bin/env node
/**
 * LibiaoLink 前端 · 回放：ONLYOFFICE 查看器外壳接真（计划 S4 · R5：超时 / 重试 / 降级「请下载」）
 *
 * 前置（都在本机跑着）：
 *   1. 前端 dev（worktree）：cd frontend && BACKEND_ORIGIN=http://127.0.0.1:3011 npm run dev -- --port 3010
 *   2. api（3011；从 server/ 起）：
 *        PORT=3011 ONLYOFFICE_JWT_SECRET=<与 DocServer 同值> \
 *        ONLYOFFICE_DOCSERVER_API_BASE_URL=http://host.docker.internal:3011 \
 *        node --env-file-if-exists=.env dist/entry/api.js
 *   3. 数据库：本地沙箱 PG（默认 127.0.0.1:5433/libiaolink）
 *   4. 对象存储：本地 SeaweedFS 沙箱（默认 127.0.0.1:9000；storage:init 已建桶）
 *   5. DocServer：deploy/onlyoffice 沙箱（默认 127.0.0.1:8001；容器 JWT_ENABLED=true，密钥与 api 同值）
 *   6. 本机 Chrome（headless 调试实例；CHROME_PATH 可覆盖）
 *
 * 用法：node scripts/s4-onlyoffice-preview-e2e.mjs
 *   可覆盖：FRONTEND_BASE / API_BASE / OO_API_BASE / OO_DOCSERVER_URL / OO_ENV_FILE / DATABASE_URL /
 *           CHROME_PATH / CDP_PORT / REPLAY_USER / PG_MODULE / SCREENSHOT_DIR / FIXTURE_DIR
 *
 * 它做什么（一条临时会话 + 一个临时项目，跑完零残留）：
 *   ① 抽屉内上传真 XLSX → 点「预览」：api.js 被 CDP 网络阻断 → 查看器外壳降级「暂无在线预览」+「重试」（R5）；
 *   ② 解除阻断 → 点「重试」→ 重取配置 + nonce 重建 → data-oo-status=ready（重试路径闭环）；
 *   ③ 上传真 DOCX → 点「预览」→ 就绪（编辑器 iframe 在位；原生下载 ⬇ 可见、原位命中层接管——悬停对齐原生：pointer 小手 + #EAEAEA 灰底；Esc 先关浮层、抽屉仍在）；
 *   ③d 命中层真点击 → 原文件字节落盘（原名 + sha256 = 夹具 · 无 crdownload）+ download 审计 +1；
 *   ④ 直取 GET /files/{id}/preview 复核查看器配置（Push 258 修订：permissions 嵌 document）：viewer 非空 / url 空 /
 *      document.url 无 X-Amz- / token 三段 + HS256 复算一致 + exp-iat=900 + mode=view + document.permissions.download=true（保持可见 · 点击由浮层命中层接管）；
 *   ⑤ 审计：仅用户显式查看写预览记录（DOCX：UI + 直取 recordView=true = 2 条；XLSX：首开 1 条，重试不重复）；
 *   ⑥ 反例：无 token 直取 document.url 同路径 → 401 且无重定向；
 *   ⑦ 收尾：purge 两份文件 → 物理删项目 → 撤销会话 → 零残留；控制台无「非预期」异常。
 * 证据：docs/s4-回放证据(ONLYOFFICE查看器外壳·前端).md
 */

import { spawn } from "node:child_process";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const PG_MODULE = process.env.PG_MODULE ?? new URL("../../server/node_modules/pg/lib/index.js", import.meta.url).href;
const { default: pg } = await import(PG_MODULE);
const { Client } = pg;

const FRONTEND = process.env.FRONTEND_BASE ?? "http://localhost:3010";
const API = process.env.API_BASE ?? "http://127.0.0.1:3011";
/** DocServer 视角的 api 基址（与 api 进程 ONLYOFFICE_DOCSERVER_API_BASE_URL 同值）：document.url 前缀断言用。 */
const OO_API_BASE = process.env.OO_API_BASE ?? "http://host.docker.internal:3011";
/** 浏览器视角的 DocServer 基址（与 api 进程 ONLYOFFICE_DOCSERVER_URL 同值）。 */
const OO_DOCSERVER = process.env.OO_DOCSERVER_URL ?? "http://127.0.0.1:8001";
const CHROME = process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PORT = Number(process.env.CDP_PORT ?? 9412);
const DB = process.env.DATABASE_URL ?? "postgres://libiaolink_api@127.0.0.1:5433/libiaolink";
const REPLAY_USER = process.env.REPLAY_USER ?? "px-replay";
const SCREENSHOT_DIR = process.env.SCREENSHOT_DIR ?? tmpdir();
const FIXTURE_DIR = process.env.FIXTURE_DIR ?? fileURLToPath(new URL("../../server/scripts/poc10/fixtures/", import.meta.url));
const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const j = (value) => JSON.stringify(value);
const TASK_TITLE = "回放任务·ONLYOFFICE查看器";

/** 密钥只用于回放侧 HMAC 复算（不打印）：优先 env OO_JWT_SECRET，否则读 deploy/onlyoffice/.env（本地沙箱）。 */
function readOnlyOfficeSecret() {
  if ((process.env.OO_JWT_SECRET ?? "") !== "") {
    return process.env.OO_JWT_SECRET;
  }
  const file = process.env.OO_ENV_FILE ?? "D:/LibiaoLink/deploy/onlyoffice/.env";
  if (existsSync(file) === false) {
    return null;
  }
  const found = /^OO_JWT_SECRET=(.+)/m.exec(readFileSync(file, "utf8"));
  return found === null ? null : found[1].trim();
}

const db = new Client({ connectionString: DB });
await db.connect();
const userRow = (await db.query("select id, username, display_name from users where username = $1 and status = 'active'", [REPLAY_USER])).rows[0];
if (userRow === undefined) {
  console.error("回放用户不存在：" + REPLAY_USER);
  process.exit(1);
}
await db.query("update sessions set revoked_at = now() where user_id = $1 and id_token = $2 and revoked_at is null", [userRow.id, "px-s4-oo-e2e"]);
const token = "pxs4oo-" + randomBytes(16).toString("hex");
const csrf = randomBytes(16).toString("hex");
await db.query("insert into sessions (token_hash, user_id, id_token, expires_at) values ($1, $2, $3, now() + make_interval(mins => 30))", [sha256(token), userRow.id, "px-s4-oo-e2e"]);
console.log("临时会话：" + userRow.username + "（" + userRow.display_name + "）");

const cookieOf = (sid, csfr) => "ll_sid=" + sid + "; ll_csrf=" + csfr;
async function apiOn(base, cookie, csfr, path, method = "GET", body, extra) {
  const headers = Object.assign({ Cookie: cookie, "X-CSRF-Token": csfr, Accept: "application/json" }, extra || {});
  const init = { method, headers };
  if (body !== undefined) { headers["Content-Type"] = "application/json"; init.body = JSON.stringify(body); }
  const res = await fetch(base + path, init);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (error) { json = null; }
  return { status: res.status, json, text };
}
const api = (path, method, body, extra) => apiOn(API, cookieOf(token, csrf), csrf, path, method, body, extra);

const checks = [];
function check(name, ok, detail) {
  checks.push(ok === true);
  console.log((ok === true ? "PASS  " : "FAIL  ") + name + (detail === undefined ? "" : "   [" + detail + "]"));
}

/** 项目清场前把项目内文件先「回收站 → purge」清掉（files.current_version_id 外键）。 */
async function purgeProjectFiles(projectId) {
  const rows = (await db.query("select id, version, status from files where project_id = $1", [projectId])).rows;
  let purged = 0;
  for (const row of rows) {
    let version = Number(row.version);
    if (row.status !== "recycled") {
      const recycled = await api("/api/v1/files/" + row.id + "/recycle", "POST", { version });
      if (recycled.status !== 200 || recycled.json === null) continue;
      version = Number(recycled.json.version);
    }
    const done = await api("/api/v1/files/" + row.id + "/purge", "POST", { version });
    if (done.status === 200) purged += 1;
  }
  return { total: rows.length, purged };
}

// ---------- 清场：上一轮崩在中途留下的同名临时项目 ----------
const stale = (await db.query("select id from projects where code like $1 and deleted_at is null", ["PX-S4OO-%"])).rows;
for (const row of stale) {
  const staleRow = await api("/api/v1/projects/" + row.id);
  if (staleRow.json === null) continue;
  await purgeProjectFiles(row.id);
  const gone = await api("/api/v1/projects/" + row.id, "DELETE", undefined, { "If-Match": String(staleRow.json.version) });
  console.log("清场：删残留临时项目 " + row.id + " → " + String(gone.status));
}

// ---------- 夹具：临时项目 + 一条任务 + 两份真文件（PoC-10 夹具） ----------
const fixtureCode = "PX-S4OO-" + randomBytes(3).toString("hex").toUpperCase();
const projRes = await api("/api/v1/projects", "POST", { code: fixtureCode, name: "S4回放·ONLYOFFICE查看器", description: "S4回放·ONLYOFFICE查看器", managerIds: [userRow.id] });
check("夹具·P1 建临时项目（201）", projRes.status === 201, String(projRes.status) + " " + projRes.text.slice(0, 140));
const projectId = projRes.json === null ? "" : projRes.json.id;
const taskRes = await api("/api/v1/projects/" + projectId + "/tasks", "POST", { stageKey: "design", title: TASK_TITLE, ownerIds: [userRow.id] });
check("夹具·T1 建一条任务（201）", taskRes.status === 201, String(taskRes.status) + " " + taskRes.text.slice(0, 140));
const taskId = taskRes.json === null ? "" : taskRes.json.id;

const fixtureDir = mkdtempSync(join(tmpdir(), "pxs4oo-fixtures-"));
const XLSX_NAME = "回放-S4-费用表.xlsx";
const DOCX_NAME = "回放-S4-周报.docx";
const xlsxPath = join(fixtureDir, XLSX_NAME);
const docxPath = join(fixtureDir, DOCX_NAME);
copyFileSync(join(FIXTURE_DIR, "n1-01-fee-summary.xlsx"), xlsxPath);
copyFileSync(join(FIXTURE_DIR, "n1-03-weekly-report.docx"), docxPath);

// ---------- 无头 Chrome（CDP） ----------
const profile = mkdtempSync(join(tmpdir(), "pxs4oo-"));
const chrome = spawn(CHROME, ["--headless=new", "--remote-debugging-port=" + PORT, "--user-data-dir=" + profile, "--no-first-run", "--no-default-browser-check", "--disable-gpu", "about:blank"], { stdio: "ignore" });
async function waitTarget() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const list = await (await fetch("http://127.0.0.1:" + PORT + "/json/list")).json();
      const target = list.find((item) => item.type === "page" && item.webSocketDebuggerUrl);
      if (target) return target;
    } catch (error) { /* 未就绪 */ }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("Chrome 未就绪");
}
class Cdp {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.nextId = 0;
    this.pending = new Map();
    this.events = [];
    this.ready = new Promise((resolve, reject) => {
      this.ws.addEventListener("open", () => resolve());
      this.ws.addEventListener("error", () => reject(new Error("ws error")));
    });
    this.ws.addEventListener("message", (event) => {
      const msg = JSON.parse(typeof event.data === "string" ? event.data : String(event.data));
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const item = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) item.reject(new Error(JSON.stringify(msg.error))); else item.resolve(msg.result);
        return;
      }
      if (msg.method === "Runtime.exceptionThrown" || msg.method === "Log.entryAdded") this.events.push("EVT " + msg.method + " " + JSON.stringify(msg.params).slice(0, 400));
    });
  }
  send(method, params = {}) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error("cdp timeout: " + method)); }, 45000);
      this.pending.set(id, { resolve: (value) => { clearTimeout(timer); resolve(value); }, reject: (error) => { clearTimeout(timer); reject(error); } });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
}
const target = await waitTarget();
const page = new Cdp(target.webSocketDebuggerUrl);
await page.ready;
await page.send("Network.enable");
await page.send("Page.enable");
await page.send("Runtime.enable");
await page.send("DOM.enable");
await page.send("Log.enable");
await page.send("Network.setCookie", { name: "ll_sid", value: token, url: FRONTEND + "/", path: "/", httpOnly: true, secure: false });
await page.send("Network.setCookie", { name: "ll_csrf", value: csrf, url: FRONTEND + "/", path: "/", httpOnly: false, secure: false });
await page.send("Emulation.setDeviceMetricsOverride", { width: 1560, height: 1000, deviceScaleFactor: 1, mobile: false });
await page.send("Emulation.setFocusEmulationEnabled", { enabled: true });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ev = async (expression) => {
  const reply = await page.send("Runtime.evaluate", { expression, returnByValue: true });
  if (reply.exceptionDetails !== undefined) throw new Error("页面表达式抛异常：" + JSON.stringify(reply.exceptionDetails).slice(0, 300));
  return reply.result.value;
};
async function waitFor(expression, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await ev(expression)) === true) return true;
    await sleep(250);
  }
  return false;
}
async function waitForAsync(fn, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if ((await fn()) === true) return true; } catch (error) { /* 重试 */ }
    await sleep(300);
  }
  return false;
}
/** 按行内文本定位抽屉文件行里的某个按钮，返回中心点。 */
async function fileRowPoint(fileName, selector) {
  return await ev("(function(){var items=document.querySelectorAll(" + j("[data-drawer-file-item]") + ");"
    + "for(var i=0;i<items.length;i++){if(items[i].textContent.indexOf(" + j(fileName) + ")>=0){"
    + "var b=items[i].querySelector(" + j(selector) + ");if(b===null){return null;}"
    + "b.scrollIntoView({block:" + j("center") + "});"
    + "var r=b.getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};}}return null;})()");
}
async function clickAt(point) {
  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y, button: "none" });
  await page.send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1 });
  await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1 });
  await sleep(500);
}
/** 发一次按键（Esc / 回车）。 */
async function pressKey(key, code, keyCode) {
  await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: key, code: code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode });
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: key, code: code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode });
  await sleep(350);
}
/** 真选文件：CDP 直接把磁盘文件塞进隐藏输入框（等价原生文件框选完）。 */
async function setFileInput(selector, filePath) {
  const doc = await page.send("DOM.getDocument", {});
  const found = await page.send("DOM.querySelector", { nodeId: doc.root.nodeId, selector });
  if (found === undefined || found.nodeId === 0) throw new Error("找不到文件输入框：" + selector);
  await page.send("DOM.setFileInputFiles", { nodeId: found.nodeId, files: [filePath] });
}
async function shot(name) {
  const data = await page.send("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(SCREENSHOT_DIR, name), Buffer.from(data.data, "base64"));
  console.log("截图：" + join(SCREENSHOT_DIR, name));
}
async function bail(message) {
  console.log("中止：" + message);
  checks.push(false);
  try { page.ws.close(); } catch (error) { /* 忽略 */ }
  chrome.kill();
  await db.end();
  process.exit(1);
}
// ---------- 打开项目总览 → 打开任务抽屉 ----------
const FILE_CELL_BUTTON = "[data-cell-action=task-files]";
const DRAWER = "aside[role=dialog]";
const DRAWER_INPUT = DRAWER + " [data-file-upload-input=true]";
await page.send("Page.navigate", { url: FRONTEND + "/#/project/" + projectId });
const boardReady = await waitFor("document.querySelector(" + j(FILE_CELL_BUTTON) + ")!==null", 15000);
if (boardReady !== true) await bail("项目总览没渲染出「文件」列上传单元（检查前端 dev / api / 会话）");
const rowPoint = await ev("(function(){var rows=document.querySelectorAll(" + j("[role=button]") + ");for(var i=0;i<rows.length;i++){if(rows[i].textContent.indexOf(" + j(TASK_TITLE) + ")>=0){var b=rows[i].getBoundingClientRect();return {x:Math.round(b.left+b.width/2),y:Math.round(b.top+b.height/2)};}}return null;})()");
if (rowPoint === null || rowPoint === undefined) await bail("点不到任务行（行没渲染）");
await clickAt(rowPoint);
const drawerOpen = await waitFor("document.querySelector(" + j(DRAWER) + ")!==null", 8000);
check("夹具·D1 点任务行打开详情抽屉", drawerOpen === true, String(drawerOpen));

// ---------- ① XLSX：抽屉上传（真夹具） ----------
await setFileInput(DRAWER_INPUT, xlsxPath);
const xlsxLanded = await waitForAsync(async () => (await db.query("select count(*)::int as c from files where task_id = $1", [taskId])).rows[0].c === 1, 30000);
const xlsxRow = (await db.query("select id, name, status from files where task_id = $1 and name = $2", [taskId, XLSX_NAME])).rows[0];
check("①a 抽屉内上传 XLSX（真夹具）→ 落库（draft）", xlsxLanded === true && xlsxRow !== undefined && xlsxRow.name === XLSX_NAME && xlsxRow.status === "draft", JSON.stringify(xlsxRow === undefined ? null : xlsxRow));
const drawerOne = await waitFor("(function(){var d=document.querySelector(" + j(DRAWER) + ");return d!==null&&d.querySelectorAll(" + j("[data-drawer-file-item]") + ").length===1;})()", 15000);
let xlsxLabel = null;
for (let attempt = 0; attempt < 40; attempt += 1) {
  xlsxLabel = await ev("(function(){var items=document.querySelectorAll(" + j("[data-drawer-file-item]") + ");for(var i=0;i<items.length;i++){if(items[i].textContent.indexOf(" + j(XLSX_NAME) + ")>=0){var b=items[i].querySelector(" + j("[data-file-preview-open=true]") + ");return b===null?null:b.textContent.trim();}}return null;})()");
  if (xlsxLabel === "预览") break;
  await sleep(250);
}
check("①b Office 行有「预览」入口（data-file-preview-open · 文案「预览」）", drawerOne === true && xlsxLabel === "预览", String(xlsxLabel));

// ---------- ①（续）阻断 api.js → 降级 UI（R5） ----------
await page.send("Network.setBlockedURLs", { urls: ["*api.js*"] });
const xlsxPoint = await fileRowPoint(XLSX_NAME, "[data-file-preview-open=true]");
if (xlsxPoint === null || xlsxPoint === undefined) await bail("XLSX 行没有预览入口（data-file-preview-open）");
await clickAt(xlsxPoint);
const errorShown = await waitFor("document.querySelector(" + j("[data-oo-status=error]") + ")!==null", 30000);
const errorProbe = await ev("(function(){var v=document.querySelector(" + j("[data-onlyoffice-viewer=true]") + ");if(v===null){return {viewer:false};}"
  + "var f=v.querySelector(" + j("[data-oo-fallback=true]") + ");var b=v.querySelector(" + j("[data-oo-retry=true]") + ");"
  + "var ov=document.querySelector(" + j("[data-file-preview]") + ");"
  + "return {viewer:true,fallback:f!==null,text:f===null?null:f.innerText.split(String.fromCharCode(10)).join(" + j(" ") + "),"
  + "retry:b!==null,overlayKind:ov===null?null:ov.getAttribute(" + j("data-file-preview-kind") + "),"
  + "drawer:document.querySelector(" + j("aside[role=dialog]") + ")!==null};})()");
check("①c api.js 被阻断 → 查看器降级「暂无在线预览」+「重试」按钮（浮层与抽屉都在）", errorShown === true && errorProbe.viewer === true && errorProbe.fallback === true && String(errorProbe.text).indexOf("暂无在线预览") >= 0 && errorProbe.retry === true && errorProbe.overlayKind === "office" && errorProbe.drawer === true, JSON.stringify(errorProbe));
await shot("s4-onlyoffice-error.png");

// ---------- ② 解除阻断 → 「重试」→ 就绪（重试路径闭环） ----------
await page.send("Network.setBlockedURLs", { urls: [] });
const retryPoint = await ev("(function(){var b=document.querySelector(" + j("[data-oo-retry=true]") + ");if(b===null){return null;}var r=b.getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};})()");
if (retryPoint === null || retryPoint === undefined) await bail("降级 UI 没有「重试」按钮");
await clickAt(retryPoint);
const xlsxReady = await waitFor("document.querySelector(" + j("[data-oo-status=ready]") + ")!==null", 45000);
const xlsxReadyProbe = await ev("(function(){var v=document.querySelector(" + j("[data-onlyoffice-viewer=true]") + ");if(v===null){return {found:false};}return {found:true,status:v.getAttribute(" + j("data-oo-status") + "),frames:v.querySelectorAll(" + j("iframe") + ").length};})()");
check("②a 解除阻断 → 点「重试」→ data-oo-status=ready + 编辑器 iframe 在位（重试路径闭环）", xlsxReady === true && xlsxReadyProbe.found === true && xlsxReadyProbe.status === "ready" && xlsxReadyProbe.frames >= 1, JSON.stringify(xlsxReadyProbe));
await shot("s4-onlyoffice-ready-xlsx.png");
await ev("(function(){if(document.activeElement&&document.activeElement.blur){document.activeElement.blur();}return true;})()");
await pressKey("Escape", "Escape", 27);
const escOk = await waitFor("(function(){return document.querySelector(" + j("[data-file-preview]") + ")===null&&document.querySelector(" + j(DRAWER) + ")!==null;})()", 8000);
check("②b Esc 先关查看器浮层、抽屉仍在（「Esc 先关内层」）", escOk === true, String(escOk));

// ---------- ③ DOCX：成功路径 ----------
await setFileInput(DRAWER_INPUT, docxPath);
const docxLanded = await waitForAsync(async () => (await db.query("select count(*)::int as c from files where task_id = $1", [taskId])).rows[0].c === 2, 30000);
const docxRow = (await db.query("select id, name, status from files where task_id = $1 and name = $2", [taskId, DOCX_NAME])).rows[0];
check("③a 抽屉内上传 DOCX（真夹具）→ 落库（draft）", docxLanded === true && docxRow !== undefined && docxRow.name === DOCX_NAME && docxRow.status === "draft", JSON.stringify(docxRow === undefined ? null : docxRow));
const drawerTwo = await waitFor("(function(){var d=document.querySelector(" + j(DRAWER) + ");return d!==null&&d.querySelectorAll(" + j("[data-drawer-file-item]") + ").length===2;})()", 15000);
const docxPoint = await fileRowPoint(DOCX_NAME, "[data-file-preview-open=true]");
if (docxPoint === null || docxPoint === undefined) await bail("DOCX 行没有预览入口（data-file-preview-open）");
await clickAt(docxPoint);
const docxReady = await waitFor("document.querySelector(" + j("[data-oo-status=ready]") + ")!==null", 45000);
const docxProbe = await ev("(function(){var v=document.querySelector(" + j("[data-onlyoffice-viewer=true]") + ");if(v===null){return {found:false};}"
  + "var ov=document.querySelector(" + j("[data-file-preview]") + ");"
  + "return {found:true,status:v.getAttribute(" + j("data-oo-status") + "),frames:v.querySelectorAll(" + j("iframe") + ").length,"
  + "overlayKind:ov===null?null:ov.getAttribute(" + j("data-file-preview-kind") + "),"
  + "download:ov===null?false:ov.querySelector(" + j("[data-file-preview-download=true]") + ")!==null,"
  + "nativeDownload:ov===null?false:ov.querySelector(" + j("[data-file-preview-native-download=true]") + ")!==null,"
  + "drawer:document.querySelector(" + j("aside[role=dialog]") + ")!==null};})()");
check("③b 点「预览」→ 查看器就绪（kind=office / 编辑器 iframe 在位 / caption + 原位命中层「下载」入口 / 抽屉仍在）", docxReady === true && docxProbe.found === true && docxProbe.status === "ready" && docxProbe.frames >= 1 && docxProbe.overlayKind === "office" && docxProbe.download === true && docxProbe.nativeDownload === true && docxProbe.drawer === true, JSON.stringify(docxProbe));
await ev("(function(){var el=document.querySelector(" + j("[data-file-preview-native-download=true]") + ");if(el===null){return false;}el.style.outline=" + j("2px solid #ef4444") + ";return true;})()");
await shot("s4-onlyoffice-native-hit.png");
await ev("(function(){var el=document.querySelector(" + j("[data-file-preview-native-download=true]") + ");if(el!==null){el.style.outline=" + j("") + ";}return true;})()");
await shot("s4-onlyoffice-ready-docx.png");

// ---------- ③（续）命中层悬停反馈对齐原生（Push 258：鼠标小手 + 与旁边搜索一致） ----------
const hitGeom = await ev("(function(){var el=document.querySelector(" + j("[data-file-preview-native-download=true]") + ");if(el===null){return null;}var r=el.getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2),left:Math.round(r.left),top:Math.round(r.top),vw:innerWidth,vh:innerHeight};})()");
let hoverOk = false;
if (hitGeom !== null && hitGeom !== undefined) {
  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: hitGeom.x, y: hitGeom.y, button: "none" });
  await sleep(400);
  hoverOk = await ev("(function(){var el=document.querySelector(" + j("[data-file-preview-native-download=true]") + ");if(el===null){return false;}var s=getComputedStyle(el);return el.matches(" + j(":hover") + ")===true&&s.cursor===" + j("pointer") + "&&s.backgroundColor!==" + j("rgba(0, 0, 0, 0)") + ";})()");
  const clipX = Math.max(0, Math.round(hitGeom.left - 60));
  const clipY = Math.max(0, Math.round(hitGeom.top - 40));
  const hoverShot = await page.send("Page.captureScreenshot", { format: "png", clip: { x: clipX, y: clipY, width: Math.min(240, hitGeom.vw - clipX), height: Math.min(120, hitGeom.vh - clipY), scale: 2 } });
  writeFileSync(join(SCREENSHOT_DIR, "s4-onlyoffice-native-hit-hover.png"), Buffer.from(hoverShot.data, "base64"));
  console.log("截图：" + join(SCREENSHOT_DIR, "s4-onlyoffice-native-hit-hover.png"));
  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 4, y: 4, button: "none" });
  await sleep(200);
}
check("③c 命中层悬停反馈对齐原生（pointer 小手 + 灰底 #EAEAEA）", hoverOk === true, JSON.stringify(hitGeom));
//
// ---------- ③（续二）命中层真点击 → 原文件字节落盘 + download 审计（Push 258 续：fetch + Blob 落盘 —— 校验字节 sha256 与原名；headless + CDP 下载放行，真机 http 源另有「保留」步，见 docs/s4 证据） ----------
const DL_DIR = mkdtempSync(join(tmpdir(), "pxs4oo-dl-"));
try { await page.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: DL_DIR, eventsEnabled: true }); }
catch (dlError1) { try { await page.send("Page.setDownloadBehavior", { behavior: "allow", downloadPath: DL_DIR }); } catch (dlError2) { /* 下载行为设不上：③d 会因无落盘文件而失败 */ } }
let downloadLanded = null;
if (hitGeom !== null && hitGeom !== undefined) {
  await page.send("Input.dispatchMouseEvent", { type: "mousePressed", x: hitGeom.x, y: hitGeom.y, button: "left", clickCount: 1 });
  await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: hitGeom.x, y: hitGeom.y, button: "left", clickCount: 1 });
  const dlDeadline = Date.now() + 20000;
  while (Date.now() < dlDeadline && downloadLanded === null) {
    for (const f of readdirSync(DL_DIR)) {
      const full = join(DL_DIR, f);
      if (statSync(full).isFile() === true && f.endsWith(".crdownload") === false) {
        const bytes = readFileSync(full);
        downloadLanded = { name: f, bytes: statSync(full).size, head: bytes.subarray(0, 8).toString("hex"), sha256: createHash("sha256").update(bytes).digest("hex") };
        break;
      }
    }
    if (downloadLanded === null) { await sleep(400); }
  }
}
const fixtureSha = createHash("sha256").update(readFileSync(docxPath)).digest("hex");
const downloadAudit = (await db.query("select count(*)::int as c from audit_logs where object_id = $1 and action = $2", [docxRow.id, "download"])).rows[0].c;
check("③d 点右上角命中层 → 原文件字节落盘（原名 + sha256 与夹具一致 · 无 crdownload）+ download 审计 +1",
  downloadLanded !== null && downloadLanded.name === DOCX_NAME && downloadLanded.sha256 === fixtureSha && Number(downloadAudit) === 1,
  j({ landed: downloadLanded === null ? null : { name: downloadLanded.name, bytes: downloadLanded.bytes, head: downloadLanded.head }, fixtureBytes: statSync(docxPath).size, audit: downloadAudit }));
rmSync(DL_DIR, { recursive: true, force: true });

// ---------- ④ 直取 /preview 复核查看器四段（契约 + 安全断言） ----------
const previewRes = await api("/api/v1/files/" + docxRow.id + "/preview?recordView=true");
const preview = previewRes.json;
const viewer = preview === null ? null : preview.viewer;
check("④a 查看器签发形状：ready + viewer 非空 / url / target 空 + 只读权限（edit=false / download=true 保持可见 / protect=true）",
  previewRes.status === 200 && preview !== null && preview.status === "ready" && viewer !== null && preview.url === null && preview.target === null && viewer.kind === "onlyoffice" && viewer.docServerUrl === OO_DOCSERVER && viewer.documentType === "word" && viewer.document.fileType === "docx" && viewer.editorConfig.mode === "view" && viewer.document.permissions.edit === false && viewer.document.permissions.download === true && viewer.document.permissions.protect === true && viewer.permissions === undefined,
  j({ status: previewRes.status, viewerKind: viewer === null ? null : viewer.kind, documentType: viewer === null ? null : viewer.documentType, mode: viewer === null ? null : viewer.editorConfig.mode }));
const docUrl = viewer === null ? "" : viewer.document.url;
check("④b document.url = 受控端点绝对 URL（DocServer 视角基址 + /preview-content）+ 无 X-Amz- 预签名参数",
  String(docUrl).indexOf(OO_API_BASE + "/api/v1/files/") === 0 && String(docUrl).indexOf("/preview-content") >= 0 && String(docUrl).indexOf("X-Amz-") < 0,
  String(docUrl));
const parts = viewer === null ? [] : String(viewer.token).split(".");
const payload = parts.length === 3 ? JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) : null;
const secret = readOnlyOfficeSecret();
const expectedSig = secret === null || parts.length !== 3 ? null : createHmac("sha256", secret).update(parts[0] + "." + parts[1]).digest("base64url");
const contentHash = (await db.query("select content_hash from file_versions where file_id = $1 order by seq desc limit 1", [docxRow.id])).rows[0].content_hash;
check("④c token 三段 JWT：HS256 复算一致 + exp-iat=900 + 逐字签发（documentType / document.key=内容哈希 / document.permissions.download=true 嵌 document（保持可见）/ editorConfig.mode=view；顶层无 permissions）",
  parts.length === 3 && payload !== null && expectedSig !== null && expectedSig === parts[2] && payload.exp - payload.iat === 900 && payload.documentType === "word" && payload.document !== undefined && payload.document.key === contentHash && payload.document.url === docUrl && payload.document.permissions !== undefined && payload.document.permissions.download === true && payload.permissions === undefined && payload.editorConfig !== undefined && payload.editorConfig.mode === "view",
  j({ parts: parts.length, signatureMatch: expectedSig === parts[2], ttl: payload === null ? null : payload.exp - payload.iat, keyMatchesHash: payload !== null && payload.document !== undefined && payload.document.key === contentHash, secret: secret === null ? "missing" : "loaded" }));

// ---------- ⑤ 审计：仅用户显式查看写预览记录（2026-10-27 收口） ----------
const auditDocx = (await db.query("select count(*)::int as c from audit_logs where object_id = $1 and action = $2", [docxRow.id, "preview"])).rows[0];
check("⑤a DOCX：UI 开查看器 + 直取 = 2 条 preview 审计（各签发一次）",
  Number(auditDocx.c) === 2,
  j({ count: auditDocx.c }));
const auditXlsx = (await db.query("select count(*)::int as c from audit_logs where object_id = $1 and action = $2", [xlsxRow.id, "preview"])).rows[0];
check("⑤b XLSX：首开计 1 条，查看器重试不重复记录", Number(auditXlsx.c) === 1, String(auditXlsx.c));

// ---------- ⑥ 受控端点反例：无 token 直取 → 401 ----------
const docPath = new URL(String(docUrl)).pathname;
const bare = await fetch(API + docPath, { redirect: "manual" });
check("⑥ 无 token 直取 document.url 同路径 → 401 且无重定向", bare.status === 401 && bare.headers.get("location") === null && bare.redirected === false, j({ status: bare.status, location: bare.headers.get("location"), redirected: bare.redirected }));

// ---------- ⑦ 收尾：purge → 删项目 → 撤销会话 → 零残留 ----------
await ev("(function(){if(document.activeElement&&document.activeElement.blur){document.activeElement.blur();}return true;})()");
await pressKey("Escape", "Escape", 27);
await waitFor("document.querySelector(" + j("[data-file-preview]") + ")===null", 8000);
const purgeResult = await purgeProjectFiles(projectId);
check("⑦a 两份回放文件全部 purge（对象真删 + 元数据删 + 留痕）", purgeResult.total === 2 && purgeResult.purged === 2, JSON.stringify(purgeResult));
const projRow = await api("/api/v1/projects/" + projectId);
const delProj = await api("/api/v1/projects/" + projectId, "DELETE", undefined, { "If-Match": String(projRow.json.version) });
check("⑦b 临时项目物理删（200 / 204）", delProj.status === 200 || delProj.status === 204, String(delProj.status) + " " + delProj.text.slice(0, 120));
const projGone = await api("/api/v1/projects/" + projectId);
check("⑦c 项目读面 404（物理删、行不存在）", projGone.status === 404, String(projGone.status));
await db.query("update sessions set revoked_at = now() where token_hash = $1", [sha256(token)]);
const residue = (await db.query("select (select count(*)::int from files where project_id = $1) as files, (select count(*)::int from file_links where object_id = $2) as links, (select count(*)::int from tasks where id = $2) as tasks, (select count(*)::int from projects where id = $1) as projects, (select count(*)::int from sessions where token_hash = $3 and revoked_at is null) as sessions", [projectId, taskId, sha256(token)])).rows[0];
check("⑦d 零残留：文件 / 关联 / 任务 / 项目 / 会话全 0 行", Number(residue.files) === 0 && Number(residue.links) === 0 && Number(residue.tasks) === 0 && Number(residue.projects) === 0 && Number(residue.sessions) === 0, JSON.stringify(residue));

rmSync(fixtureDir, { recursive: true, force: true });
const pageEvents = page.events.filter((line) => line.indexOf("EVT ") === 0);
const unexpected = pageEvents.filter((line) => line.indexOf("ERR_BLOCKED_BY_CLIENT") < 0);
check("⑧ 页面控制台无「非预期」异常（排除①的 api.js 阻断注入）", unexpected.length === 0, String(pageEvents.length) + " 条（非预期 " + String(unexpected.length) + "）");
if (checks.filter((ok) => ok !== true).length > 0) {
  await shot("s4-onlyoffice-fail.png");
}
const failed = checks.filter((ok) => ok !== true).length;
console.log("—— 合计 " + String(checks.length) + " 项：" + String(checks.length - failed) + " 通过 / " + String(failed) + " 失败 ——");
console.log("页面控制台 / 异常：" + String(pageEvents.length) + " 条（含①阻断注入的 " + String(pageEvents.length - unexpected.length) + " 条）");
for (const line of pageEvents.slice(0, 8)) { console.log("  " + line.slice(0, 240)); }
try { page.ws.close(); } catch (error) { /* 忽略 */ }
chrome.kill();
await db.end();
process.exit(failed === 0 ? 0 : 1);