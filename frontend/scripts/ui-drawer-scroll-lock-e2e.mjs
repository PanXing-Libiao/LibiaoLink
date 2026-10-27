#!/usr/bin/env node
/**
 * LibiaoLink 前端 · 回放：开关任务抽屉不再让整张表抖动（业务口径 2026-09-24）
 *
 * 业务口径：px 报「展开抽屉后 再关闭 整个表格会抖动」—— 修掉。
 * 根因：抽屉打开时把 `overflow: hidden` 写进 body → 纵向滚动条消失 → 视口宽出一个滚动条宽（Windows 经典滚动条实测 15px）
 *      → 任务表列宽按比例分配，整表被横向撑开 15px；关抽屉时缩回来 —— 一开一关就是「抖两下」。
 * 修法：锁滚动时按滚动条实测宽度补一份等宽 `padding-right`（frontend/src/scrollLock.ts），内容宽度前后逐像素一致。
 *
 * 本脚本在真机浏览器上**量像素**：打开前 / 打开后 / 关闭后，表格左边缘与宽度、任务行左边缘与宽度、表头宽度都必须一致；
 * 同时验证滚动锁本身没丢（打开时 body 是 hidden、关掉能滚）。夹具做成 12 条任务，保证内容高过视口（有滚动条才复现得出）。
 *
 * 前置（四件都在本机跑着）：
 *   1. 前端 dev：cd frontend && npm run dev（默认 3000）
 *   2. api：cd server && npm run start:api（默认 3001，需先 npm run build）
 *   3. 数据库：本地沙箱 PG（默认 127.0.0.1:5433/libiaolink）
 *   4. 本机装了 Chrome（脚本 headless 起一个调试实例；路径可用 CHROME_PATH 覆盖）
 *
 * 用法：node scripts/ui-drawer-scroll-lock-e2e.mjs
 *   可覆盖的环境变量：FRONTEND_BASE / API_BASE / DATABASE_URL / CHROME_PATH / CDP_PORT / REPLAY_USER / PG_MODULE
 *
 * 夹具：一条**临时会话**（跑完撤销）+ 一个**临时项目**（跑完硬删）+ 12 条**临时节点 / 任务**（跑完物理删节点 / 软删任务），跑完零残留。
 */

import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
const PG_MODULE = process.env.PG_MODULE ?? new URL("../../server/node_modules/pg/lib/index.js", import.meta.url).href;
const { default: pg } = await import(PG_MODULE);

const { Client } = pg;
const FRONTEND = process.env.FRONTEND_BASE ?? "http://localhost:3000";
const API = process.env.API_BASE ?? "http://127.0.0.1:3001";
const CHROME = process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PORT = Number(process.env.CDP_PORT ?? 9402);
const DB = process.env.DATABASE_URL ?? "postgres://libiaolink_api@127.0.0.1:5433/libiaolink";
const REPLAY_USER = process.env.REPLAY_USER ?? "px-replay";
const Q = String.fromCharCode(34);
const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const db = new Client({ connectionString: DB });
await db.connect();
const userRow = (await db.query("select id, username, display_name from users where username = $1 and status = 'active'", [REPLAY_USER])).rows[0];
if (userRow === undefined) {
  console.error("回放用户不存在：" + REPLAY_USER);
  process.exit(1);
}
const token = "pxlock-" + randomBytes(16).toString("hex");
const csrf = randomBytes(16).toString("hex");
await db.query("insert into sessions (token_hash, user_id, id_token, expires_at) values ($1, $2, $3, now() + make_interval(mins => 30))", [sha256(token), userRow.id, "px-drawer-scroll-lock-e2e"]);
console.log("临时会话：" + userRow.username + "（" + userRow.display_name + "）");

const profile = mkdtempSync(join(tmpdir(), "pxlock-"));
const chrome = spawn(CHROME, ["--headless=new", "--remote-debugging-port=" + PORT, "--user-data-dir=" + profile, "--no-first-run", "--no-default-browser-check", "--disable-gpu", "about:blank"], { stdio: "ignore" });

async function waitTarget() {
  for (let i = 0; i !== 60; i += 1) {
    try {
      const list = await (await fetch("http://127.0.0.1:" + PORT + "/json/list")).json();
      const target = list.find((item) => item.type === "page" && item.webSocketDebuggerUrl);
      if (target) return target;
    } catch (error) { /* 未就绪 */ }
    await sleep(500);
  }
  throw new Error("Chrome 未就绪");
}

class Cdp {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.nextId = 0;
    this.pending = new Map();
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
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error("cdp timeout " + method)); }, 20000);
      this.pending.set(id, { resolve: (value) => { clearTimeout(timer); resolve(value); }, reject: (error) => { clearTimeout(timer); reject(error); } });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
}

const COOKIE = "ll_sid=" + token + "; ll_csrf=" + csrf;
async function api(path, method = "GET", body, extra) {
  const headers = Object.assign({ Cookie: COOKIE, "X-CSRF-Token": csrf, Accept: "application/json" }, extra || {});
  const init = { method, headers };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const res = await fetch(API + path, init);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (error) { json = null; }
  return { status: res.status, json, text };
}

const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok: ok === true, detail: detail === undefined ? "" : String(detail) });
  console.log((ok === true ? "PASS  " : "FAIL  ") + name + (detail === undefined ? "" : "   [" + detail + "]"));
}

// ---------- 夹具：临时项目 + 12 条「节点 → 任务」（内容高过视口才有滚动条，本 bug 才复现得出来） ----------
const stamp = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 19).replace(/[-:T]/g, "");
const projRes = await api("/api/v1/projects", "POST", { code: "PX-LOCK-" + randomBytes(2).toString("hex").toUpperCase(), name: "抽屉滚动锁回放", managerIds: [userRow.id] });
check("夹具：临时项目（201）", projRes.status === 201, String(projRes.status) + " " + projRes.text.slice(0, 120));
const projectId = projRes.json === null ? "" : projRes.json.id;
const nodeIds = [];
let created = 0;
for (let k = 0; k !== 12; k += 1) {
  const nodeRes = await api("/api/v1/task-nodes", "POST", { stageKey: "design", title: "回放·滚动锁·" + String(k) + "·" + stamp, titleEn: "Scroll lock " + String(k) });
  if (nodeRes.json === null) continue;
  nodeIds.push(nodeRes.json.id);
  const taskRes = await api("/api/v1/projects/" + projectId + "/tasks", "POST", { stageKey: "design", title: "滚动锁任务-" + String(k) + "-" + stamp, titleEn: "Scroll lock task " + String(k), sourceNodeId: nodeRes.json.id });
  if (taskRes.status === 201) created += 1;
}
check("夹具：12 条任务都建好（页面因此高过视口、出纵向滚动条）", created === 12, "created=" + String(created));

// ---------- 浏览器 ----------
const target = await waitTarget();
const page = new Cdp(target.webSocketDebuggerUrl);
await page.ready;
await page.send("Network.enable");
await page.send("Page.enable");
await page.send("Runtime.enable");
await page.send("Network.setCookie", { name: "ll_sid", value: token, url: FRONTEND + "/", path: "/", httpOnly: true, secure: false });
await page.send("Network.setCookie", { name: "ll_csrf", value: csrf, url: FRONTEND + "/", path: "/", httpOnly: false, secure: false });
await page.send("Emulation.setDeviceMetricsOverride", { width: 1500, height: 1000, deviceScaleFactor: 1, mobile: false });
const ev = async (expression) => (await page.send("Runtime.evaluate", { expression, returnByValue: true })).result.value;
/** 硬刷新：先回 about:blank 再进目标 URL —— 同一个 hash 的二次导航浏览器会当同文档、SPA 不重挂（踩过）。 */
async function openView(view) {
  await page.send("Page.navigate", { url: "about:blank" });
  await sleep(500);
  await page.send("Page.navigate", { url: FRONTEND + "/#/project/" + projectId + "?view=" + view });
  await sleep(5200);
}
/** 真实鼠标点一下（CDP Input，不是合成 click()）：走浏览器命中测试。 */
async function clickAt(x, y) {
  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none" });
  await page.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  await sleep(900);
}

function metrics() {
  var doc = document.documentElement;
  var board = document.getElementById("task-board-scroll");
  var head = document.querySelector("[data-stage-header]");
  var row = null;
  var cands = document.querySelectorAll("[role=button]");
  for (var i = 0; i !== cands.length; i += 1) {
    if (cands[i].getAttribute("title") === "点击查看任务详情") { row = cands[i]; break; }
  }
  var panel = document.querySelector("aside[role=dialog]");
  var rect = function (el) { if (el === null || el === undefined) { return null; } var b = el.getBoundingClientRect(); return { left: Math.round(b.left), right: Math.round(b.right), width: Math.round(b.width), top: Math.round(b.top), height: Math.round(b.height) }; };
  return { innerW: window.innerWidth, innerH: window.innerHeight, clientW: doc.clientWidth, sb: window.innerWidth - doc.clientWidth, scrollH: doc.scrollHeight, clientH: doc.clientHeight, scrollable: doc.scrollHeight > doc.clientHeight, scrollY: window.scrollY, bodyOverflow: document.body.style.overflow, bodyPaddingRight: document.body.style.paddingRight, board: rect(board), head: rect(head), row: rect(row), panel: rect(panel) };
}
function drawerOpen() { return document.querySelector("aside[role=dialog]") !== null; }
function closePoint() { var el = document.querySelector("[aria-label=关闭任务详情]"); if (el === null) { return null; } var b = el.getBoundingClientRect(); return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) }; }
function hitInfo(px, py) {
  var el = document.elementFromPoint(px, py);
  if (el === null) { return "null"; }
  var out = [];
  var node = el;
  var depth = 0;
  while (node !== null && depth !== 9) { out.push(node.tagName + (node.getAttribute("aria-label") === null ? "" : "[" + node.getAttribute("aria-label") + "]")); node = node.parentElement; depth += 1; }
  return out.join(" < ");
}
const METRICS = "(" + metrics.toString() + ")()";
const DRAWER = "(" + drawerOpen.toString() + ")()";
const CLOSE = "(" + closePoint.toString() + ")()";

await openView("overview");
const before = await ev(METRICS);
check("前置：页面内容高过视口、确实有纵向滚动条（本 bug 的复现条件）", before.scrollable === true && before.sb > 0, "scrollable=" + String(before.scrollable) + " 滚动条宽=" + String(before.sb) + "px 文档高=" + String(before.scrollH));
check("前置：任务表 / 任务行都量得到（夹具渲染出来了）", before.board !== null && before.row !== null && before.head !== null, "board=" + JSON.stringify(before.board) + " row=" + JSON.stringify(before.row));
check("前置：抽屉关着、页面没有残留的滚动锁", before.bodyOverflow === "" && before.bodyPaddingRight === "" && (await ev(DRAWER)) === false, "overflow=" + Q + before.bodyOverflow + Q + " padding=" + Q + before.bodyPaddingRight + Q);

const openX = before.row.left + 45;
const openY = before.row.top + Math.round(before.row.height / 2);
console.log("落点检查（任务行第一个单元格）：" + (await ev("(" + hitInfo.toString() + ")(" + openX + "," + openY + ")")));

// ---------- ① 打开抽屉：表格不许动 ----------
await clickAt(openX, openY);
const opened = await ev(METRICS);
check("① 抽屉打开了（右侧任务详情出现）", (await ev(DRAWER)) === true);
check("② 滚动锁还在：打开时 body overflow=hidden", opened.bodyOverflow === "hidden", "overflow=" + Q + opened.bodyOverflow + Q);
check("③ 打开时按滚动条实测宽度补了等宽内边距", opened.bodyPaddingRight === String(before.sb) + "px", "bodyPaddingRight=" + Q + opened.bodyPaddingRight + Q + " 滚动条宽=" + String(before.sb) + "px");
check("④ 打开后表格宽度逐像素不变（不再被撑开 15px）", opened.board.width === before.board.width && opened.board.left === before.board.left, "宽 " + String(before.board.width) + " -> " + String(opened.board.width) + "; 左 " + String(before.board.left) + " -> " + String(opened.board.left));
check("⑤ 打开后任务行左边缘 / 宽度不变", opened.row.left === before.row.left && opened.row.width === before.row.width, "左 " + String(before.row.left) + " -> " + String(opened.row.left) + "; 宽 " + String(before.row.width) + " -> " + String(opened.row.width));
check("⑥ 打开后阶段分组头宽度不变", opened.head.width === before.head.width, String(before.head.width) + " -> " + String(opened.head.width));
check("⑦ 抽屉面板居中、增宽且低于视口（2026-10-27 布局）", opened.panel !== null && opened.panel !== undefined && Math.abs((opened.panel.left + opened.panel.width / 2) - opened.innerW / 2) <= 2 && opened.panel.width >= 900 && opened.panel.height <= opened.innerH - 32, "panel=" + JSON.stringify(opened.panel) + " inner=" + String(opened.innerW) + "x" + String(opened.innerH));

// ---------- ② 关闭抽屉：表格不许抖回来 ----------
const close = await ev(CLOSE);
await clickAt(close.x, close.y);
const closed = await ev(METRICS);
check("⑧ 抽屉关闭了", (await ev(DRAWER)) === false);
check("⑨ 关闭后滚动锁与内边距都还原成空（没留脏样式）", closed.bodyOverflow === "" && closed.bodyPaddingRight === "", "overflow=" + Q + closed.bodyOverflow + Q + " padding=" + Q + closed.bodyPaddingRight + Q);
check("⑩ 关闭后表格逐像素还原（这就是不抖）", closed.board.width === before.board.width && closed.row.left === before.row.left && closed.row.width === before.row.width && closed.head.width === before.head.width, "宽 " + String(before.board.width) + " -> 开 " + String(opened.board.width) + " -> 关 " + String(closed.board.width));
await ev("window.scrollTo(0, 200)");
await sleep(300);
const scrolled = await ev("window.scrollY");
check("⑪ 关闭后页面还能正常滚动（没把滚动锁死）", scrolled === 200, "scrollY=" + String(scrolled));
await ev("window.scrollTo(0, 0)");
await sleep(400);

// ---------- ③ 再开一次 / 再关一次：还原要能重复 ----------
const round2 = await ev(METRICS);
await clickAt(round2.row.left + 45, round2.row.top + Math.round(round2.row.height / 2));
const opened2 = await ev(METRICS);
check("⑫ 二次打开：表格依旧逐像素不变、内边距依旧补上", opened2.board.width === round2.board.width && opened2.row.width === round2.row.width && opened2.bodyPaddingRight === String(round2.sb) + "px" && opened2.bodyOverflow === "hidden", "宽 " + String(round2.board.width) + " -> " + String(opened2.board.width) + "; padding=" + Q + opened2.bodyPaddingRight + Q);
const close2 = await ev(CLOSE);
await clickAt(close2.x, close2.y);
const closed2 = await ev(METRICS);
check("⑬ 二次关闭：styles 还原干净、表格逐像素还原", closed2.bodyOverflow === "" && closed2.bodyPaddingRight === "" && closed2.board.width === round2.board.width && closed2.row.left === round2.row.left, "宽 " + String(round2.board.width) + " -> " + String(closed2.board.width));

// ---------- 清理 ----------
const leftovers = (await api("/api/v1/projects/" + projectId + "/tasks?limit=200")).json.items;
let deleted = 0;
for (const item of leftovers) {
  const res = await api("/api/v1/projects/" + projectId + "/tasks/" + item.id, "DELETE", undefined, { "If-Match": String(item.version) });
  if (res.status === 200 || res.status === 204) deleted += 1;
}
check("清理：软删 12 条临时任务", deleted === leftovers.length && leftovers.length === 12, String(deleted) + "/" + String(leftovers.length));
const projNow = await api("/api/v1/projects/" + projectId);
const delProj = await api("/api/v1/projects/" + projectId, "DELETE", undefined, { "If-Match": String(projNow.json.version) });
check("清理：硬删临时项目（200 / 204）", delProj.status === 200 || delProj.status === 204, String(delProj.status));
let delNodes = 0;
for (const nodeId of nodeIds) {
  const res = await api("/api/v1/task-nodes/" + nodeId, "DELETE");
  if (res.status === 200 || res.status === 204) delNodes += 1;
}
check("清理：物理删 12 个临时节点", delNodes === nodeIds.length, String(delNodes) + "/" + String(nodeIds.length));
await db.query("update sessions set revoked_at = now() where token_hash = $1", [sha256(token)]);
const residue = (await db.query("select (select count(*)::int from tasks where project_id = $1 and deleted_at is null) as tasks, (select count(*)::int from projects where id = $1) as projects, (select count(*)::int from task_nodes where id = any($2::uuid[])) as nodes, (select count(*)::int from sessions where token_hash = $3 and revoked_at is null) as sessions", [projectId, nodeIds, sha256(token)])).rows[0];
check("清理：任务 / 项目 / 节点 / 会话零残留", Number(residue.tasks) === 0 && Number(residue.projects) === 0 && Number(residue.nodes) === 0 && Number(residue.sessions) === 0, JSON.stringify(residue));

// ---------- 收尾 ----------
const failed = checks.filter((item) => item.ok !== true).length;
console.log("—— 合计 " + String(checks.length) + " 项：" + String(checks.length - failed) + " 通过 / " + String(failed) + " 失败 ——");
try { page.ws.close(); } catch (error) { /* 忽略 */ }
chrome.kill();
await db.end();
process.exit(failed === 0 ? 0 : 1);
