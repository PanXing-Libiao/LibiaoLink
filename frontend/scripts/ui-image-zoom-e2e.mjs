#!/usr/bin/env node
/**
 * 前端 · 回放：图片预览缩放（Push 273 · 业务口径 2026-10-10「图片预览要有缩放功能」）
 *
 * 全站三处图片大图预览共用组件 ImageZoomViewer，本脚本逐处真机验（无头 Chrome + CDP）：
 *   A 文件库预览浮层（FilePreviewOverlay 图片分支）：点列表行打开（无行内预览按钮）、100% 起、缩放条齐全、点图不关（留给缩放 / 拖动）、
 *     ＋ = 125%、滚轮以光标为锚点缩放且背景页不跟着滚、放大后拖动平移（含边界夹取）、百分比钮回 100%、
 *     缩小下限 25%、双击 100% ↔ 200%、Esc / 点遮罩关闭、800% 不撑出页面滚动条；
 *   B 项目页「日报及问题 → 问题追踪」附图（ReportIssuePanel.PhotoPreview）：核心口径同上；
 *   C 工作台「提出/负责的问题」附图（WorkspacePage.PhotoPreview）：核心口径同上。
 *
 * 数据夹具（全部真接口 / 真库）：临时项目 + 一条任务 + 一张 1600x1000 真 PNG（分片直传）→
 * 日报（当前问题附图 = 该 PNG）提交后派生一条「带附图的问题」（项目页问题追踪 / 工作台共用这一条）。
 *
 * 前置（都在本机跑着）：前端 dev :3000 / api :3001 / 本地沙箱 PG :5433 / MinIO :9000 / 本机 Chrome。
 * 用法：node scripts/ui-image-zoom-e2e.mjs
 *   可覆盖：FRONTEND_BASE / API_BASE / DATABASE_URL / CHROME_PATH / CDP_PORT / REPLAY_USER / PG_MODULE / SHOT_DIR
 * 证据：docs/Push 273 回放截图 + 开发日志（Push 273）
 */
import { spawn } from "node:child_process";
import { deflateSync } from "node:zlib";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";

const PG_MODULE = process.env.PG_MODULE ?? new URL("../../server/node_modules/pg/lib/index.js", import.meta.url).href;
const { default: pg } = await import(PG_MODULE);
const { Client } = pg;

const FRONTEND = process.env.FRONTEND_BASE ?? "http://localhost:3000";
const API = process.env.API_BASE ?? "http://127.0.0.1:3001";
const CHROME = process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PORT = Number(process.env.CDP_PORT ?? 9421);
const DB = process.env.DATABASE_URL ?? "postgres://libiaolink_api@127.0.0.1:5433/libiaolink";
const REPLAY_USER = process.env.REPLAY_USER ?? "px-replay";
const SHOTS = process.env.SHOT_DIR ?? join(tmpdir(), "px-image-zoom-shots");
const PNG_NAME = "回放-图片缩放-现场图.png";
const ISSUE_TITLE = "回放-图片缩放-问题（附图）";
const TASK_TITLE = "回放任务·图片缩放";
const Q = String.fromCharCode(34);
const j = (value) => JSON.stringify(value);
const sha256 = (data) => createHash("sha256").update(data).digest("hex");
mkdirSync(SHOTS, { recursive: true });

/** 1600x1000 真 PNG（渐变 + 网格 + 每轮随机底色，手搓字节 + 手写 CRC32，不引依赖 —— 供缩放目视截图）。 */
function pngBytes(width, height) {
  const crcTable = [];
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) !== 0 ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    crcTable[n] = c >>> 0;
  }
  const crc32 = (buf) => {
    let c = 0xffffffff;
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body), 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const seed = randomBytes(3);
  const rows = [];
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(1 + width * 3);
    for (let x = 0; x < width; x += 1) {
      const at = 1 + x * 3;
      const grid = x % 200 < 4 || y % 160 < 4 ? 70 : 0;
      row[at] = Math.min(255, Math.round((x / width) * 200) + grid + seed[0]);
      row[at + 1] = Math.min(255, Math.round((y / height) * 180) + grid + seed[1]);
      row[at + 2] = Math.min(255, 90 + Math.round((x / width) * 120) + seed[2]);
    }
    rows.push(row);
  }
  const idat = deflateSync(Buffer.concat(rows), { level: 6 });
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}
const PNG_BYTES = pngBytes(1600, 1000);

const db = new Client({ connectionString: DB });
await db.connect();
const userRow = (await db.query("select id, username, display_name from users where username = $1 and status = 'active'", [REPLAY_USER])).rows[0];
if (userRow === undefined) {
  console.error("回放用户不存在：" + REPLAY_USER);
  process.exit(1);
}
const token = "zoom-fe-" + randomBytes(16).toString("hex");
const csrf = randomBytes(16).toString("hex");
await db.query("insert into sessions (token_hash, user_id, id_token, expires_at) values ($1, $2, $3, now() + make_interval(mins => 30))", [sha256(token), userRow.id, "ui-image-zoom-e2e"]);
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

/** 项目清场前把项目内文件先「回收站 → purge」清掉（与 m4-07 / m6 回放同一绕行：files.current_version_id 外键）。 */
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
const stale = (await db.query("select id from projects where code like $1 and deleted_at is null", ["ZOOMFE-%"])).rows;
for (const row of stale) {
  const staleRow = await api("/api/v1/projects/" + row.id);
  if (staleRow.json === null) continue;
  await purgeProjectFiles(row.id);
  const gone = await api("/api/v1/projects/" + row.id, "DELETE", undefined, { "If-Match": String(staleRow.json.version) });
  console.log("清场：删残留临时项目 " + row.id + " → " + String(gone.status));
}

// ---------- 夹具：临时项目 + 一条任务 + 一张真 PNG（真实上传管道）+ 日报（问题附图）派生问题 ----------
const fixtureCode = "ZOOMFE-" + randomBytes(3).toString("hex").toUpperCase();
const projRes = await api("/api/v1/projects", "POST", { code: fixtureCode, name: "图片缩放回放", description: "Push 273 图片预览缩放回放", managerIds: [userRow.id] });
check("夹具 a 建临时项目（201）", projRes.status === 201, String(projRes.status) + " " + projRes.text.slice(0, 140));
const projectId = projRes.json === null ? "" : projRes.json.id;
const taskRes = await api("/api/v1/projects/" + projectId + "/tasks", "POST", { stageKey: "design", title: TASK_TITLE, ownerIds: [userRow.id] });
check("夹具 b 建一条任务（201）", taskRes.status === 201, String(taskRes.status) + " " + taskRes.text.slice(0, 140));
const taskId = taskRes.json === null ? "" : taskRes.json.id;

const contentHash = sha256(PNG_BYTES);
const initRes = await api("/api/v1/files/uploads", "POST", { projectId, name: PNG_NAME, sizeBytes: PNG_BYTES.length, mime: "image/png", contentHash, taskId, intent: "version" });
const fileId = initRes.json === null || initRes.json.file === undefined ? "" : initRes.json.file.id;
const uploadId = initRes.json === null || initRes.json.upload === undefined ? "" : initRes.json.upload.id;
if (fileId !== "" && uploadId !== "") {
  const partsRes = await api("/api/v1/files/" + fileId + "/uploads/" + uploadId + "/parts", "POST", { partNumbers: [1] });
  const partUrl = partsRes.json.parts[0].url;
  const putRes = await fetch(partUrl, { method: "PUT", body: PNG_BYTES });
  const completeRes = await api("/api/v1/files/" + fileId + "/uploads/" + uploadId + "/complete", "POST", { contentHash });
  check("夹具 c 上传真 PNG（分片直传 + 关联任务）", putRes.ok === true && completeRes.status === 200 && completeRes.json.version.seq === 1, String(completeRes.status) + " seq=" + String(completeRes.json === null ? null : completeRes.json.version.seq));
} else {
  check("夹具 c 上传真 PNG（分片直传 + 关联任务）", false, "init 未返回 file / upload：" + initRes.text.slice(0, 160));
}
const reportRes = await api("/api/v1/projects/" + projectId + "/reports", "POST", { date: new Date().toISOString().slice(0, 10), state: "submitted", headcount: 6, doneWork: "回放·图片缩放-完成工作", plan: "回放·图片缩放-明日计划", foundIssue: ISSUE_TITLE, issueCategories: ["机械部"], issuePhotoFileIds: [fileId] });
check("夹具 d 提交日报（当前问题附图 = 该 PNG → 派生带图问题）", reportRes.status === 201 && reportRes.json !== null && reportRes.json.photos !== undefined && reportRes.json.photos.length === 0 && reportRes.json.issuePhotos.length === 0, reportRes.status + " " + reportRes.text.slice(0, 140));
const reportId = reportRes.json === null ? "" : reportRes.json.id;
const issuesRes = await api("/api/v1/projects/" + projectId + "/issues");
const issueRow = issuesRes.json === null ? undefined : (issuesRes.json.items === undefined ? [] : issuesRes.json.items).filter((item) => item.title === ISSUE_TITLE)[0];
check("夹具 e 派生问题已生成且带 1 张附图", issueRow !== undefined && issueRow.photos.length === 1 && issueRow.photos[0].fileId === fileId, issuesRes.text.slice(0, 160));
const issueId = issueRow === undefined ? "" : issueRow.id;

// ---------- 无头 Chrome（CDP） ----------
const profile = mkdtempSync(join(tmpdir(), "pxzoom-"));
const chrome = spawn(CHROME, ["--headless=new", "--remote-debugging-port=" + String(PORT), "--user-data-dir=" + profile, "--no-first-run", "--no-default-browser-check", "--disable-gpu", "about:blank"], { stdio: "ignore" });
async function waitTarget() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const list = await (await fetch("http://127.0.0.1:" + String(PORT) + "/json/list")).json();
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
async function clickAt(point) {
  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y, button: "none" });
  await page.send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1 });
  await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1 });
  await sleep(320);
}
async function centerOf(selector) {
  return ev("(function(){var el=document.querySelector(" + j(selector) + ");if(el===null){return null;}el.scrollIntoView({block:" + j("center") + ",inline:" + j("center") + "});var r=el.getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};})()");
}
async function clickSelector(selector) {
  const point = await centerOf(selector);
  if (point === null || point === undefined) return false;
  await clickAt(point);
  return true;
}
async function dragBy(point, dx, dy) {
  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y, button: "none" });
  await page.send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", buttons: 1, clickCount: 1 });
  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x + Math.round(dx / 2), y: point.y + Math.round(dy / 2), button: "left", buttons: 1 });
  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x + dx, y: point.y + dy, button: "left", buttons: 1 });
  await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x + dx, y: point.y + dy, button: "left", buttons: 0, clickCount: 1 });
  await sleep(320);
}
async function wheelAt(point, deltaY) {
  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y, button: "none" });
  await page.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: point.x, y: point.y, deltaX: 0, deltaY });
  await sleep(320);
}
async function doubleClickAt(point) {
  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y, button: "none" });
  await page.send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1 });
  await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1 });
  await page.send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 2 });
  await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 2 });
  await sleep(400);
}
async function pressKey(key, code, keyCode) {
  await page.send("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode });
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode });
  await sleep(320);
}
async function shot(name) {
  const reply = await page.send("Page.captureScreenshot", { format: "png" });
  const file = join(SHOTS, name + ".png");
  writeFileSync(file, Buffer.from(reply.data, "base64"));
  console.log("截图：" + file);
  return file;
}
async function bail(reason) {
  console.error("中止：" + reason);
  checks.push(false);
  try { page.ws.close(); } catch (error) { /* 忽略 */ }
  chrome.kill();
  await db.end();
  process.exit(1);
}

/** 缩放浮层探针：倍率（data 属性）/ 百分比文案 / transform / 图片几何 / 缩放条是否齐全。 */
const viewerProbe = (overlaySelector) => "(function(){var o=document.querySelector(" + j(overlaySelector) + ");if(o===null){return null;}var v=o.querySelector(" + j("[data-image-zoom-viewer]") + ");var img=o.querySelector(" + j("[data-image-zoom-image]") + ");var pct=o.querySelector(" + j("[data-image-zoom-percent]") + ");if(v===null||img===null||pct===null){return {viewer:false};}var r=img.getBoundingClientRect();return {viewer:true,zoom:Number(v.getAttribute(" + j("data-image-zoom") + ")),percent:pct.textContent.trim(),transform:String(img.style.transform),point:{x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)},rect:{left:r.left,top:r.top,width:r.width,height:r.height},offsetW:img.offsetWidth,offsetH:img.offsetHeight,loaded:img.complete===true&&img.naturalWidth>0,hasBar:o.querySelector(" + j("[data-image-zoom-bar]") + ")!==null,hasOut:o.querySelector(" + j("[data-image-zoom-out]") + ")!==null,hasIn:o.querySelector(" + j("[data-image-zoom-in]") + ")!==null,hasHint:o.querySelector(" + j("[data-image-zoom-hint]") + ")!==null};})()";
/** transform 解析：translate(xpx, ypx) scale(z)。 */
const parseTransform = (transform) => {
  const m = /translate\((-?[0-9.]+)px, (-?[0-9.]+)px\) scale\(([0-9.]+)\)/.exec(String(transform));
  return m === null ? null : { x: Number(m[1]), y: Number(m[2]), scale: Number(m[3]) };
};
const maxOffsetOf = (probe) => ({
  x: Math.max(0, (probe.offsetW * probe.zoom - probe.offsetW) / 2),
  y: Math.max(0, (probe.offsetH * probe.zoom - probe.offsetH) / 2),
});
const percentOf = (probe) => (probe === null || probe === undefined || probe.percent === null ? -1 : Number(String(probe.percent).replace("%", "")));

// ---------- A 文件库：预览浮层（FilePreviewOverlay 图片分支） ----------
/** 浮层本体选择器：列表入口为 data-file-row；浮层本体才带 data-file-preview-kind。 */
const A_OVERLAY = "[data-file-preview][data-file-preview-kind]";
const fileNameEnc = encodeURIComponent(PNG_NAME);
await page.send("Page.navigate", { url: FRONTEND + "/#/files?q=" + fileNameEnc });
const rowReady = await waitFor("document.querySelectorAll(" + j("[data-file-row]") + ").length === 1", 40000);
if (rowReady !== true) await bail("文件库没有命中 1 行（检查前端 dev / api / 会话 / 夹具）");
await sleep(700);
await ev("window.scrollTo(0, 260)");
await sleep(400);
const docSize0 = await ev("({w:document.documentElement.scrollWidth,h:document.documentElement.scrollHeight})");
const scrollAtOpen = await ev("Math.round(window.scrollY)");
const noPreviewButton = await ev("document.querySelector(" + j("[data-file-preview=" + Q + fileId + Q + "]") + ") === null");
const previewClick = await clickSelector("[data-file-row=" + Q + fileId + Q + "]");
const overlayReady = await waitFor("document.querySelector(" + j(A_OVERLAY) + ")!==null&&document.querySelector(" + j("[data-file-preview-kind=image]") + ")!==null", 30000);
const aLoaded = await waitFor("(function(){var p=" + viewerProbe(A_OVERLAY) + ";return p!==null&&p.loaded===true;})()", 30000);
const a1 = await ev(viewerProbe(A_OVERLAY));
if (a1 === null || a1 === undefined || a1.viewer !== true) await bail("文件库预览浮层里没有缩放视图（ImageZoomViewer 没挂上）");
check("A1 点击文件库行打开图片预览：无行内预览按钮、缩放条 / ＋ − / 提示齐全、图已加载、初始 100%", noPreviewButton === true && previewClick === true && overlayReady === true && aLoaded === true && a1 !== null && a1.viewer === true && a1.hasBar === true && a1.hasOut === true && a1.hasIn === true && a1.hasHint === true && a1.percent === "100%" && a1.zoom === 1, JSON.stringify({noPreviewButton: noPreviewButton, click: previewClick, ready: overlayReady, loaded: aLoaded, percent: a1 === null ? null : a1.percent}));
await shot("push273-a1-文件库预览-100");
await clickAt(a1.point);
const keptOpen = await waitFor("document.querySelector(" + j(A_OVERLAY) + ")===null", 1200) === false;
check("A2 点图片本身不关浮层（点击留给缩放 / 拖动）", keptOpen === true, String(keptOpen));
const plusClick = await clickSelector("[data-image-zoom-in]");
const a3 = await ev(viewerProbe(A_OVERLAY));
const t3 = a3 === null ? null : parseTransform(a3.transform);
check("A3 「＋」= 1.25 步进：125% / scale 1.25", plusClick === true && a3 !== null && a3.percent === "125%" && t3 !== null && Math.abs(t3.scale - 1.25) < 0.01, JSON.stringify({percent: a3 === null ? null : a3.percent, t: t3}));
const scrollBeforeWheel = await ev("Math.round(window.scrollY)");
await wheelAt(a3.point, -240);
const a4 = await ev(viewerProbe(A_OVERLAY));
const scrollAfterWheel = await ev("Math.round(window.scrollY)");
check("A4 滚轮以光标为锚点放大（≈179%）且背景页不跟着滚（preventDefault 生效）", percentOf(a4) >= 170 && percentOf(a4) <= 190 && scrollAfterWheel === scrollBeforeWheel, JSON.stringify({percent: a4 === null ? null : a4.percent, before: scrollBeforeWheel, after: scrollAfterWheel}));
await dragBy(a4.point, 90, 60);
const a5 = await ev(viewerProbe(A_OVERLAY));
const t5 = a5 === null ? null : parseTransform(a5.transform);
check("A5 放大后拖动平移：translate ≈ (+90, +60)、倍率不变、浮层仍开", a5 !== null && t5 !== null && t5.x > 40 && t5.y > 25 && Math.abs(t5.scale - a5.zoom) < 0.01 && a5.percent === a4.percent, JSON.stringify({t: t5, percent: a5 === null ? null : a5.percent}));
await dragBy(a5.point, 4000, 4000);
const a6 = await ev(viewerProbe(A_OVERLAY));
const t6 = a6 === null ? null : parseTransform(a6.transform);
const max6 = a6 === null ? null : maxOffsetOf(a6);
check("A6 拖动边界夹取：偏移封顶 (w×(zoom−1)/2, h×(zoom−1)/2)，图片拖不丢", t6 !== null && max6 !== null && Math.abs(t6.x - max6.x) <= 2 && Math.abs(t6.y - max6.y) <= 2 && t6.x > 100, JSON.stringify({t: t6, max: max6}));
await shot("push273-a6-文件库预览-拖动到边界");
const resetClick = await clickSelector("[data-image-zoom-reset]");
const a7 = await ev(viewerProbe(A_OVERLAY));
const t7 = a7 === null ? null : parseTransform(a7.transform);
check("A7 百分比钮 = 一键回 100%：percent 100% / translate 0,0 / scale 1", resetClick === true && a7 !== null && a7.percent === "100%" && t7 !== null && t7.x === 0 && t7.y === 0 && t7.scale === 1, JSON.stringify({percent: a7 === null ? null : a7.percent, t: t7}));
for (let i = 0; i < 12; i += 1) { await clickSelector("[data-image-zoom-out]"); }
const a8 = await ev(viewerProbe(A_OVERLAY));
check("A8 缩小下限 25%（连点 12 次 − 封底不归零）", percentOf(a8) === 25, JSON.stringify({percent: a8 === null ? null : a8.percent}));
await doubleClickAt(a8.point);
const a9 = await ev(viewerProbe(A_OVERLAY));
check("A9 双击（非 100% 档）= 回到 100%", percentOf(a9) === 100, JSON.stringify({percent: a9 === null ? null : a9.percent}));
await doubleClickAt(a9.point);
const a10 = await ev(viewerProbe(A_OVERLAY));
check("A10 再双击（100% 档）= 放大到 200%（锚点 = 双击点）", percentOf(a10) === 200, JSON.stringify({percent: a10 === null ? null : a10.percent}));
await shot("push273-a10-文件库预览-双击200");
await clickSelector("[data-image-zoom-reset]");
for (let i = 0; i < 10; i += 1) { await clickSelector("[data-image-zoom-in]"); }
const a11 = await ev(viewerProbe(A_OVERLAY));
const docSize1 = await ev("({w:document.documentElement.scrollWidth,h:document.documentElement.scrollHeight})");
check("A11 上限 800% 封顶 + 变换不撑出页面滚动条（文档尺寸与开浮层前一致）", percentOf(a11) === 800 && docSize1.w === docSize0.w && docSize1.h === docSize0.h, JSON.stringify({percent: a11 === null ? null : a11.percent, before: docSize0, after: docSize1}));
await shot("push273-a11-文件库预览-800");
await pressKey("Escape", "Escape", 27);
const escClosed = await waitFor("document.querySelector(" + j(A_OVERLAY) + ")===null", 8000);
check("A12 Esc 关闭预览浮层", escClosed === true, String(escClosed));
const rowFocused = await ev("(function(){var row=document.querySelector(" + j("[data-file-row=" + Q + fileId + Q + "]") + ");if(row===null){return false;}row.focus();return document.activeElement===row;})()");
await pressKey("Enter", "Enter", 13);
const reopened = await waitFor("document.querySelector(" + j(A_OVERLAY) + ")!==null", 20000);
const backClick = await ev("(function(){var o=document.querySelector(" + j(A_OVERLAY) + ");if(o===null){return null;}var r=o.getBoundingClientRect();return {x:Math.round(r.left+12),y:Math.round(r.top+12)};})()");
if (backClick !== null && backClick !== undefined) await clickAt(backClick);
const backClosed = await waitFor("document.querySelector(" + j(A_OVERLAY) + ")===null", 8000);
check("A13 聚焦行按 Enter 重开 → 点遮罩（浮层角落）关闭", rowFocused === true && reopened === true && backClick !== null && backClosed === true, JSON.stringify({focused: rowFocused, reopened: reopened, closed: backClosed}));

// ---------- B 项目页「日报及问题 → 问题追踪」附图（ReportIssuePanel.PhotoPreview） ----------
await page.send("Page.navigate", { url: FRONTEND + "/#/project/" + projectId + "?view=daily&sub=issues" });
const issueThumbReady = await waitFor("document.querySelector(" + j("[data-attachment-thumb]") + ")!==null", 30000);
if (issueThumbReady !== true) await bail("项目页「问题追踪」没渲染出附图缩略图（路由 / 夹具问题）");
const bThumbClick = await clickSelector("[data-attachment-thumb]");
const bOpen = await waitFor("document.querySelector(" + j("[data-photo-preview]") + ")!==null&&document.querySelector(" + j("[data-image-zoom-viewer]") + ")!==null", 20000);
const bLoaded = await waitFor("(function(){var p=" + viewerProbe("[data-photo-preview]") + ";return p!==null&&p.loaded===true;})()", 30000);
const b1 = await ev(viewerProbe("[data-photo-preview]"));
if (b1 === null || b1 === undefined || b1.viewer !== true) await bail("项目页附图预览浮层里没有缩放视图");
check("B1 项目页问题附图预览：缩放条齐全、图已加载、初始 100%", bThumbClick === true && bOpen === true && bLoaded === true && b1 !== null && b1.viewer === true && b1.hasBar === true && b1.hasHint === true && b1.percent === "100%", JSON.stringify({thumb: bThumbClick, open: bOpen, loaded: bLoaded, percent: b1 === null ? null : b1.percent}));
await shot("push273-b1-项目页问题附图-100");
await clickSelector("[data-image-zoom-in]");
const b2 = await ev(viewerProbe("[data-photo-preview]"));
check("B2 「＋」→ 125%", percentOf(b2) === 125, JSON.stringify({percent: b2 === null ? null : b2.percent}));
await dragBy(b2.point, 120, 80);
const b3 = await ev(viewerProbe("[data-photo-preview]"));
const tb3 = b3 === null ? null : parseTransform(b3.transform);
const bKept = await ev("document.querySelector(" + j("[data-photo-preview]") + ")!==null");
check("B3 放大后拖动平移生效（translate > 0）且浮层仍开", tb3 !== null && tb3.x > 30 && tb3.y > 20 && bKept === true, JSON.stringify({t: tb3, kept: bKept}));
await clickSelector("[data-image-zoom-reset]");
const b4 = await ev(viewerProbe("[data-photo-preview]"));
check("B4 百分比钮一键回 100%", percentOf(b4) === 100, JSON.stringify({percent: b4 === null ? null : b4.percent}));
const bBack = await ev("(function(){var o=document.querySelector(" + j("[data-photo-preview]") + ");if(o===null){return null;}var r=o.getBoundingClientRect();return {x:Math.round(r.left+12),y:Math.round(r.top+12)};})()");
if (bBack !== null && bBack !== undefined) await clickAt(bBack);
const bClosed = await waitFor("document.querySelector(" + j("[data-photo-preview]") + ")===null", 8000);
check("B5 点遮罩关闭预览层", bBack !== null && bClosed === true, JSON.stringify({closed: bClosed}));

// ---------- C 工作台「提出/负责的问题」附图（WorkspacePage.PhotoPreview） ----------
const panelSel = "[data-workspace-panel=" + Q + projectId + Q + "]";
await page.send("Page.navigate", { url: FRONTEND + "/#/my-tasks?tab=raised" });
const panelReady = await waitFor("document.querySelector(" + j(panelSel) + ")!==null", 40000);
if (panelReady !== true) await bail("工作台「提出/负责的问题」没有该项目面板（聚合读面 / 夹具问题）");
await clickSelector(panelSel + " [data-workspace-panel-toggle]");
const tileReady = await waitFor("document.querySelector(" + j(panelSel + " [data-issue-photo]") + ")!==null", 25000);
const cTileClick = tileReady === true ? await clickSelector(panelSel + " [data-issue-photo]") : false;
const cOpen = await waitFor("document.querySelector(" + j("[data-photo-preview]") + ")!==null&&document.querySelector(" + j("[data-image-zoom-viewer]") + ")!==null", 20000);
const cLoaded = await waitFor("(function(){var p=" + viewerProbe("[data-photo-preview]") + ";return p!==null&&p.loaded===true;})()", 30000);
const c1 = await ev(viewerProbe("[data-photo-preview]"));
if (c1 === null || c1 === undefined || c1.viewer !== true) await bail("工作台附图预览浮层里没有缩放视图");
check("C1 工作台问题附图预览：缩放条齐全、图已加载、初始 100%", panelReady === true && cTileClick === true && cOpen === true && cLoaded === true && c1 !== null && c1.viewer === true && c1.hasBar === true && c1.percent === "100%", JSON.stringify({tile: cTileClick, open: cOpen, loaded: cLoaded, percent: c1 === null ? null : c1.percent}));
await wheelAt(c1.point, -180);
const c2 = await ev(viewerProbe("[data-photo-preview]"));
check("C2 滚轮以光标为锚点放大生效（percent > 110%）", percentOf(c2) > 110, JSON.stringify({percent: c2 === null ? null : c2.percent}));
await shot("push273-c2-工作台问题附图-滚轮");
await pressKey("Escape", "Escape", 27);
const cClosed = await waitFor("document.querySelector(" + j("[data-photo-preview]") + ")===null", 8000);
const workspaceKept = await ev("document.querySelector(" + j("[data-workspace-panel]") + ")!==null");
check("C3 Esc 只关预览层（工作台页面仍在）", cClosed === true && workspaceKept === true, JSON.stringify({closed: cClosed, kept: workspaceKept}));

// ---------- 收尾：删日报（连带问题）→ purge 文件 → 物理删临时项目 → 会话撤销 → 零残留 ----------
const delReport = await api("/api/v1/projects/" + projectId + "/reports/" + reportId, "DELETE");
const purgeResult = await purgeProjectFiles(projectId);
const projRow = await api("/api/v1/projects/" + projectId);
const delProj = await api("/api/v1/projects/" + projectId, "DELETE", undefined, { "If-Match": String(projRow.json.version) });
await db.query("update sessions set revoked_at = now() where token_hash = $1", [sha256(token)]);
check("收尾 a 删日报（连带问题）+ purge 文件 + 物理删项目 + 会话撤销", delReport.status === 200 && purgeResult.total === 1 && purgeResult.purged === 1 && (delProj.status === 200 || delProj.status === 204), JSON.stringify({report: delReport.status, purge: purgeResult, project: delProj.status}));
const residue = (await db.query("select (select count(*)::int from files where project_id = $1) as files, (select count(*)::int from file_links where file_id = $2 or object_id in ($3, $4)) as links, (select count(*)::int from daily_reports where project_id = $1) as reports, (select count(*)::int from issues where project_id = $1) as issues, (select count(*)::int from tasks where id = $5) as tasks, (select count(*)::int from projects where id = $1) as projects, (select count(*)::int from sessions where token_hash = $6 and revoked_at is null) as sessions", [projectId, fileId, reportId, issueId, taskId, sha256(token)])).rows[0];
check("收尾 b 零残留：文件 / 关联 / 日报 / 问题 / 任务 / 项目 / 会话全 0 行", Number(residue.files) === 0 && Number(residue.links) === 0 && Number(residue.reports) === 0 && Number(residue.issues) === 0 && Number(residue.tasks) === 0 && Number(residue.projects) === 0 && Number(residue.sessions) === 0, JSON.stringify(residue));

const failed = checks.filter((ok) => ok !== true).length;
console.log("—— 合计 " + String(checks.length) + " 项：" + String(checks.length - failed) + " 通过 / " + String(failed) + " 失败 ——");
const pageEvents = page.events.filter((line) => line.indexOf("EVT ") === 0);
console.log("页面控制台 / 异常：" + String(pageEvents.length) + " 条");
for (const line of pageEvents.slice(0, 8)) { console.log("  " + line.slice(0, 240)); }
try { page.ws.close(); } catch (error) { /* 忽略 */ }
chrome.kill();
await new Promise((resolve) => setTimeout(resolve, 1500));
try { rmSync(profile, { recursive: true, force: true }); } catch (error) { /* 浏览器退出竞态：目录可能仍被占用，留给系统清理 */ }
await db.end();
process.exit(failed === 0 ? 0 : 1);
