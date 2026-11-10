/**
 * LibiaoLink 前端 · 「输出成果文件」可选 + 「预览」悬停提示撤除回放（2026-10-08 · Push 248）
 *
 * 业务口径：「文件输出成果也要可以选择」+「图四鼠标触碰预览的文字提示就不需要了」。
 *
 * 前置（都在本机跑着）：
 *   1. 前端 dev：cd frontend && npm run dev（默认 3000）
 *   2. api：cd server && npm run start:api（默认 3001，需先 npm run build；本刀为 deliverableTypes 常规编辑开放）
 *   3. 数据库：本地沙箱 PG（默认 127.0.0.1:5433/libiaolink）
 *   4. 本机装了 Chrome（脚本 headless 起一个调试实例；路径可用 CHROME_PATH 覆盖）
 *
 * 用法：node scripts/ui-deliverable-e2e.mjs
 *   可覆盖的环境变量：FRONTEND_BASE / API_BASE / DATABASE_URL / CHROME_PATH / CDP_PORT / REPLAY_USER / PG_MODULE
 *
 * 它做什么：用一条临时会话（跑完撤销）+ 一个临时项目（跑完移入回收站并彻底删除、读面零残留）真机过一遍 ——
 *   任务表「输出成果文件」列空态 = 「—」可点单元格 → 点开「查找选项」搜索 + 十类彩签多选面板（10 枚底色逐项比对）→
 *   搜索过滤（「协议」只剩技术协议）→ 勾选落库 + 单元格「首枚 + +N」回流 → 再点取消 → 点页面空白收面板 →
 *   底部「＋ 自定义（仅限项目经理）」由项目经理新增唯一全站名称：写入 deliverableType 字典并回显，
 *   字典接口可读、再点取消；收尾删除临时全局字典项 →
 *   抽屉行同款可点（彩签全摊）→ 上传 txt 验证抽屉「预览」按钮无 title 悬停提示（「下载」对照）→ 收尾清理。
 */

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
const PG_MODULE = process.env.PG_MODULE ?? new URL("../../server/node_modules/pg/lib/index.js", import.meta.url).href;
const { default: pg } = await import(PG_MODULE);

const { Client } = pg;
const FRONTEND = process.env.FRONTEND_BASE ?? "http://localhost:3000";
const API = process.env.API_BASE ?? "http://127.0.0.1:3001";
const CHROME = process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PORT = Number(process.env.CDP_PORT ?? 9399);
const DB = process.env.DATABASE_URL ?? "postgres://libiaolink_api@127.0.0.1:5433/libiaolink";
const REPLAY_USER = process.env.REPLAY_USER ?? "px-replay";
const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const Q = String.fromCharCode(34);
const j = (value) => JSON.stringify(value);
const TASK_TITLE = "回放任务·成果选择";
const CELL = "[aria-label=" + Q + "修改输出成果文件" + Q + "]";
const PANEL = "[data-deliverable-panel=true]";
const SEARCH = "[data-deliverable-search=true]";
const DRAWER = "aside[role=dialog]";
const DRAWER_INPUT = "aside[role=dialog] [data-file-upload-input=true]";

const db = new Client({ connectionString: DB });
await db.connect();
const userRow = (await db.query("select id, username, display_name from users where username = $1 and status = 'active'", [REPLAY_USER])).rows[0];
if (userRow === undefined) { console.log("中止：找不到回放账号 " + REPLAY_USER); process.exit(1); }
const token = "pxdlv-" + randomBytes(16).toString("hex");
const csrf = randomBytes(16).toString("hex");
await db.query("insert into sessions (token_hash, user_id, id_token, expires_at) values ($1, $2, $3, now() + make_interval(mins => 30))", [sha256(token), userRow.id, "px-deliverable-e2e"]);
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

// ---------- 清场：上一轮崩在中途留下的同名临时项目 ----------
const stale = (await db.query("select id from projects where code like $1 and deleted_at is null", ["PX-DLV-%"])).rows;
for (const row of stale) {
  const staleRow = await api("/api/v1/projects/" + row.id);
  if (staleRow.json === null) continue;
  const fileRows = (await db.query("select id, version, status from files where project_id = $1", [row.id])).rows;
  for (const file of fileRows) {
    let version = Number(file.version);
    if (file.status !== "recycled") {
      const recycled = await api("/api/v1/files/" + file.id + "/recycle", "POST", { version });
      if (recycled.status !== 200) continue;
      version = Number(recycled.json.version);
    }
    await api("/api/v1/files/" + file.id + "/purge", "POST", { version });
  }
  const gone = await api("/api/v1/projects/" + row.id, "DELETE", undefined, { "If-Match": String(staleRow.json.version) });
  console.log("清场：删残留临时项目 " + row.id + " → " + String(gone.status));
}

// ---------- 夹具：临时项目 + 一条任务 + 一份 txt（抽屉预览按钮探针用） ----------
const fixtureCode = "PX-DLV-" + randomBytes(3).toString("hex").toUpperCase();
const customName = "回放成果-" + randomBytes(2).toString("hex").toUpperCase();
await db.query("delete from dict_items where type_code = $1 and code like $2", ["deliverableType", "回放成果-%"]);
const dictBefore = await api("/api/v1/dicts/deliverableType");
const baselineCustomCount = dictBefore.status === 200 && Array.isArray(dictBefore.json.items) ? dictBefore.json.items.length : 0;
const projRes = await api("/api/v1/projects", "POST", { code: fixtureCode, name: "回放·成果文件选择", description: "回放·成果文件选择", managerIds: [userRow.id] });
check("夹具：建临时项目（201）", projRes.status === 201, String(projRes.status) + " " + projRes.text.slice(0, 140));
const projectId = projRes.json === null ? "" : projRes.json.id;
const taskRes = await api("/api/v1/projects/" + projectId + "/tasks", "POST", { stageKey: "design", title: TASK_TITLE, ownerIds: [] });
check("夹具：建一条任务（201 · 无成果要求）", taskRes.status === 201 && Array.isArray(taskRes.json.deliverableTypes) && taskRes.json.deliverableTypes.length === 0, String(taskRes.status) + " " + taskRes.text.slice(0, 120));
const taskId = taskRes.json === null ? "" : taskRes.json.id;

const fileDir = mkdtempSync(join(tmpdir(), "pxdlv-"));
const probeName = "回放-成果-预览.txt";
const probePath = join(fileDir, probeName);
writeFileSync(probePath, "LibiaoLink deliverable replay " + fixtureCode + "\n", "utf8");

// ---------- 无头 Chrome（CDP） ----------
const profile = mkdtempSync(join(tmpdir(), "pxdlv-"));
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
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error("cdp timeout: " + method)); }, 60000);
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
async function pointOf(expression) {
  return await ev("(function(){var el=" + expression + ";if(el===null||el===undefined){return null;}el.scrollIntoView({block:" + j("center") + ",inline:" + j("center") + "});var r=el.getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};})()");
}
async function clickAt(point) {
  if (point === null || point === undefined) throw new Error("点击目标不在");
  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y, button: "none" });
  await page.send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1 });
  await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1 });
  await sleep(450);
}
async function pressKey(key, code, keyCode) {
  await page.send("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode });
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode });
  await sleep(300);
}
async function setFileInput(selector, filePath) {
  const doc = await page.send("DOM.getDocument", {});
  const found = await page.send("DOM.querySelector", { nodeId: doc.root.nodeId, selector });
  if (found === undefined || found.nodeId === 0) throw new Error("找不到文件输入框：" + selector);
  await page.send("DOM.setFileInputFiles", { nodeId: found.nodeId, files: [filePath] });
}
async function screenshot(name) {
  const shot = await page.send("Page.captureScreenshot", { format: "png" });
  const out = join(tmpdir(), name);
  writeFileSync(out, Buffer.from(shot.data, "base64"));
  console.log("截图：" + out);
}
async function bail(message) {
  console.log("中止：" + message);
  checks.push(false);
  try { page.ws.close(); } catch (error) { /* 忽略 */ }
  chrome.kill();
  await db.end();
  process.exit(1);
}
const cellText = (scopeExpr) => ev("(function(){var el=" + scopeExpr + ";return el===null?null:el.textContent.trim();})()");
const optionPoint = (name, scopeExpr) => pointOf("(function(){var scope=" + scopeExpr + ";return scope===null?null:scope.querySelector(" + j("[data-deliverable-option=" + Q + name + Q + "]") + ");})()");
const dbDeliverables = async () => (await db.query("select deliverable_types from tasks where id = $1", [taskId])).rows[0].deliverable_types;

// ---------- 打开项目总览 ----------
await page.send("Page.navigate", { url: FRONTEND + "/#/project/" + projectId });
const boardReady = await waitFor("document.querySelector(" + j(CELL) + ")!==null", 15000);
if (boardReady !== true) await bail("项目总览没渲染出「输出成果文件」单元格（检查前端 dev / api / 会话）");

// ① 空态 + 点开面板（搜索 + 多选标 + 十类彩签）
const emptyCell = await ev("(function(){var b=document.querySelector(" + j(CELL) + ");if(b===null){return null;}return {text:b.textContent.trim(),hook:b.getAttribute(" + Q + "data-inline-cell" + Q + "),title:b.getAttribute(" + Q + "title" + Q + ")};})()");
check("①a 列空态 = 「—」+ 行内可编辑单元格（data-inline-cell=editor）", emptyCell !== null && emptyCell.text === "—" && emptyCell.hook === "editor", JSON.stringify(emptyCell));
const cellP = await pointOf("document.querySelector(" + j(CELL) + ")");
await clickAt(cellP);
const panelOpen = await waitFor("document.querySelector(" + j(PANEL) + ")!==null", 6000);
const panelInfo = panelOpen === true ? await ev("(function(){var p=document.querySelector(" + j(PANEL) + ");if(p===null){return null;}var s=p.querySelector(" + j(SEARCH) + ");return {search:s===null?null:s.getAttribute(" + Q + "placeholder" + Q + "),label:p.innerText.indexOf(" + j("多选") + ")>=0,count:p.querySelectorAll(" + j("[data-deliverable-option]") + ").length};})()") : null;
check("①b 点单元格 → 面板（搜索「查找选项」+「多选」标 + 十类选项）", panelOpen === true && panelInfo !== null && panelInfo.search === "查找选项" && panelInfo.label === true && panelInfo.count === 10, JSON.stringify(panelInfo));
const chipColors = await ev("(function(){var p=document.querySelector(" + j(PANEL) + ");if(p===null){return null;}var out={};var opts=p.querySelectorAll(" + j("[data-deliverable-option]") + ");for(var i=0;i<opts.length;i++){var name=opts[i].getAttribute(" + Q + "data-deliverable-option" + Q + ");var chip=opts[i].querySelector(" + j("span") + ");out[name]=chip===null?null:getComputedStyle(chip).backgroundColor;}return out;})()");
const colorWant = { "CAD图纸": "rgb(253, 242, 248)", "技术协议": "rgb(239, 246, 255)", "合同": "rgb(236, 254, 255)", "评审单": "rgb(236, 253, 245)", "设备清单": "rgb(254, 242, 242)", "物料总清单": "rgb(255, 247, 237)", "发货装箱单": "rgb(255, 251, 235)", "到货单": "rgb(250, 245, 255)", "安装完成证明": "rgb(254, 252, 232)", "验收单": "rgb(255, 247, 237)" };
const colorOk = chipColors !== null && Object.keys(colorWant).every((name) => chipColors[name] === colorWant[name]);
check("①c 十类彩签底色逐项比对（「是否按时交付」同款浅彩底）", colorOk === true, JSON.stringify(chipColors).slice(0, 260));

// ①c2 自定义：点击「＋ 自定义」→ 输入名称 → 添加即选中并落库；再点取消
const customButtonInfo = await ev("(function(){var p=document.querySelector(" + j(PANEL) + ");var b=p===null?null:p.querySelector(" + j("[data-deliverable-custom-button=true]") + ");return b===null?null:{text:b.textContent.trim(),disabled:b.disabled,title:b.getAttribute(" + Q + "title" + Q + ")};})()");
const customButtonP = await pointOf("document.querySelector(" + j(PANEL + " [data-deliverable-custom-button=true]") + ")");
await clickAt(customButtonP);
const customInputOpen = await waitFor("document.querySelector(" + j(PANEL + " [data-deliverable-custom-input=true]") + ")!==null", 5000);
check("①c2 面板底部显示「自定义（仅限项目经理）」，项目经理可点开输入框", customButtonInfo !== null && customButtonInfo.text === "自定义（仅限项目经理）" && customButtonInfo.disabled === false && customInputOpen === true, JSON.stringify({ customButtonInfo, customInputOpen }));
await page.send("Input.insertText", { text: customName });
const customSubmitP = await pointOf("document.querySelector(" + j(PANEL + " [data-deliverable-custom-submit=true]") + ")");
await clickAt(customSubmitP);
const customSaved = await waitForAsync(async () => JSON.stringify(await dbDeliverables()) === JSON.stringify([customName]), 10000);
const customGlobal = await waitForAsync(async () => {
  const res = await api("/api/v1/dicts/deliverableType");
  return res.status === 200 && Array.isArray(res.json.items) && res.json.items.some((item) => item.code === customName && item.name === customName);
}, 10000);
const customCellText = await cellText("document.querySelector(" + j(CELL) + ")");
const customOptionExists = await ev("(function(){var p=document.querySelector(" + j(PANEL) + ");return p!==null&&p.querySelector(" + j("[data-deliverable-option=" + Q + customName + Q + "]") + ")!==null;})()");
check("①c3 新增全站自定义「" + customName + "」→ 当前任务落库 + 全局字典可读 + 单元格回显", customSaved === true && customGlobal === true && customCellText === customName && customOptionExists === true, JSON.stringify({ customSaved, customGlobal, customCellText, customOptionExists }));
await clickAt(await optionPoint(customName, "document.querySelector(" + j(PANEL) + ")"));
const customCleared = await waitForAsync(async () => (await dbDeliverables()).length === 0, 10000);
check("①c4 再点自定义项 → 取消当前任务选择并落库为空（全局候选保留）", customCleared === true, String(customCleared));

// ①d 搜索过滤：「协议」只剩技术协议；清空搜索回内置十类 + 全站自定义
const searchP = await pointOf("document.querySelector(" + j(PANEL + " " + SEARCH) + ")");
await clickAt(searchP);
await page.send("Input.insertText", { text: "协议" });
await sleep(300);
const filtered = await ev("(function(){var p=document.querySelector(" + j(PANEL) + ");if(p===null){return null;}var opts=p.querySelectorAll(" + j("[data-deliverable-option]") + ");return {count:opts.length,first:opts[0]===undefined?null:opts[0].getAttribute(" + Q + "data-deliverable-option" + Q + ")};})()");
check("①d 搜索「协议」→ 只剩 技术协议 1 项", filtered !== null && filtered.count === 1 && filtered.first === "技术协议", JSON.stringify(filtered));
await pressKey("Backspace", "Backspace", 8);
await pressKey("Backspace", "Backspace", 8);
const restored = await ev("(function(){var p=document.querySelector(" + j(PANEL) + ");return p===null?0:p.querySelectorAll(" + j("[data-deliverable-option]") + ").length;})()");
const expectedOptions = 10 + baselineCustomCount + 1;
check("①e 退格清空搜索 → 回内置十类 + 全站自定义候选", restored === expectedOptions, JSON.stringify({ restored, expectedOptions }));

// ② 勾选 / 取消（落库 + 单元格回流）
await clickAt(await optionPoint("技术协议", "document.querySelector(" + j(PANEL) + ")"));
const one = await waitForAsync(async () => JSON.stringify(await dbDeliverables()) === JSON.stringify(["技术协议"]), 10000);
const selectedOne = await ev("(function(){var p=document.querySelector(" + j(PANEL) + ");var o=p===null?null:p.querySelector(" + j("[data-deliverable-option=" + Q + "技术协议" + Q + "]") + ");return o===null?null:o.getAttribute(" + Q + "aria-selected" + Q + ");})()");
check("②a 点选 技术协议 → 落库 + 选中态 + 面板不关", one === true && selectedOne === "true" && (await ev("document.querySelector(" + j(PANEL) + ")!==null")) === true, JSON.stringify({ one, selectedOne }));
const cellOne = await cellText("document.querySelector(" + j(CELL) + ")");
check("②b 单元格回流 = 技术协议 彩签（无 +N）", cellOne === "技术协议", String(cellOne));
await clickAt(await optionPoint("CAD图纸", "document.querySelector(" + j(PANEL) + ")"));
const two = await waitForAsync(async () => JSON.stringify(await dbDeliverables()) === JSON.stringify(["技术协议", "CAD图纸"]), 10000);
const cellTwo = await cellText("document.querySelector(" + j(CELL) + ")");
check("②c 再勾 CAD图纸 → 落库两枚 + 单元格 = 技术协议 +1", two === true && cellTwo.indexOf("技术协议") === 0 && cellTwo.indexOf("+1") >= 0, JSON.stringify({ two, cellTwo }));
await screenshot("px248-deliverable-cell.png");
await clickAt(await optionPoint("技术协议", "document.querySelector(" + j(PANEL) + ")"));
const backOne = await waitForAsync(async () => JSON.stringify(await dbDeliverables()) === JSON.stringify(["CAD图纸"]), 10000);
const cellBack = await cellText("document.querySelector(" + j(CELL) + ")");
check("②d 再点 技术协议 = 取消 → 落库只剩 CAD图纸", backOne === true && cellBack === "CAD图纸", JSON.stringify({ backOne, cellBack }));
await clickAt({ x: 12, y: 520 });
const panelClosed = await waitFor("document.querySelector(" + j(PANEL) + ")===null", 5000);
check("②e 点页面空白 → 面板收", panelClosed === true, String(panelClosed));

// ③ 抽屉行同款（彩签全摊）
const rowP = await pointOf("(function(){var cell2=document.querySelector(" + j(CELL) + ");return cell2===null?null:cell2.closest(" + j("[role=button]") + ");})()");
await clickAt(rowP);
const drawerOpen = await waitFor("document.querySelector(" + j(DRAWER) + ")!==null", 8000);
if (drawerOpen !== true) await bail("任务详情抽屉没打开");
const drawerCellText = await cellText("document.querySelector(" + j(DRAWER + " " + CELL) + ")");
check("③a 抽屉「输出成果文件」行 = 可点单元格 + CAD图纸 彩签", drawerCellText === "CAD图纸", String(drawerCellText));
const drawerCellP = await pointOf("document.querySelector(" + j(DRAWER + " " + CELL) + ")");
await clickAt(drawerCellP);
const drawerPanel = await waitFor("document.querySelector(" + j(PANEL) + ")!==null", 6000);
if (drawerPanel !== true) await bail("抽屉内成果面板没打开");
await clickAt(await optionPoint("验收单", "document.querySelector(" + j(PANEL) + ")"));
await clickAt(await optionPoint("合同", "document.querySelector(" + j(PANEL) + ")"));
const three = await waitForAsync(async () => JSON.stringify(await dbDeliverables()) === JSON.stringify(["CAD图纸", "验收单", "合同"]), 10000);
const drawerChips = await ev("(function(){var d=document.querySelector(" + j(DRAWER) + ");if(d===null){return null;}var vals=d.querySelectorAll(" + j("[data-deliverable-value]") + ");var names=[];for(var i=0;i<vals.length;i++){names.push(vals[i].getAttribute(" + Q + "data-deliverable-value" + Q + "));}return names;})()");
check("③b 抽屉勾 验收单 / 合同 → 落库三枚（保序）+ 抽屉彩签全摊", three === true && drawerChips !== null && drawerChips.join("|") === "CAD图纸|验收单|合同", JSON.stringify({ three, drawerChips }));
await screenshot("px248-deliverable-drawer.png");
const drawerBlank = await ev("(function(){var d=document.querySelector(" + j(DRAWER) + ");if(d===null){return null;}var r=d.getBoundingClientRect();return {x:Math.round(r.left+60),y:Math.round(r.top+120)};})()");
await clickAt(drawerBlank);
const panelClosed2 = await waitFor("document.querySelector(" + j(PANEL) + ")===null", 5000);
const drawerStill = await ev("document.querySelector(" + j(DRAWER) + ")!==null");
check("③c 抽屉面板点抽屉内空白收（抽屉本体不关）", panelClosed2 === true && drawerStill === true, JSON.stringify({ panelClosed2, drawerStill }));

// ④ 「预览」按钮悬停提示已撤（上传 txt 实测；「下载」对照仍带 title）
await setFileInput(DRAWER_INPUT, probePath);
const fileLanded = await waitForAsync(async () => (await db.query("select count(*)::int as c from files where task_id = $1", [taskId])).rows[0].c === 1, 30000);
const fileRow = await waitFor("document.querySelector(" + j("[data-drawer-file-item]") + ")!==null", 15000);
if (fileLanded !== true || fileRow !== true) await bail("抽屉上传探针文件没落地");
const buttonProbe = await ev("(function(){var item=document.querySelector(" + j("[data-drawer-file-item]") + ");if(item===null){return null;}var bs=item.querySelectorAll(" + j("button") + ");var out={preview:null,download:null};for(var i=0;i<bs.length;i++){var t=bs[i].textContent.trim();if(t===" + Q + "预览" + Q + "){out.preview={title:bs[i].getAttribute(" + Q + "title" + Q + "),disabled:bs[i].disabled};}if(t===" + Q + "下载" + Q + "){out.download=bs[i].getAttribute(" + Q + "title" + Q + ");}}return out;})()");
check("④a 「预览」按钮已无 title 悬停提示（可点）", buttonProbe !== null && buttonProbe.preview !== null && buttonProbe.preview.title === null && buttonProbe.preview.disabled === false, JSON.stringify(buttonProbe));
check("④b 对照：「下载」按钮 title 保留（只撤了预览那条）", buttonProbe !== null && typeof buttonProbe.download === "string" && buttonProbe.download.indexOf("下载原文件") === 0, String(buttonProbe === null ? null : buttonProbe.download));

// ⑤ 收尾：文件 purge → 项目移入回收站 → 读面 404 → 系统管理员彻底删除 → 零残留
const fileRowsAll = (await db.query("select id, version, status from files where project_id = $1", [projectId])).rows;
let purged = 0;
for (const file of fileRowsAll) {
  let version = Number(file.version);
  if (file.status !== "recycled") {
    const recycled = await api("/api/v1/files/" + file.id + "/recycle", "POST", { version });
    if (recycled.status !== 200) continue;
    version = Number(recycled.json.version);
  }
  const done = await api("/api/v1/files/" + file.id + "/purge", "POST", { version });
  if (done.status === 200) purged += 1;
}
check("⑤a 探针文件 purge（对象真删 + 元数据删 + 留痕）", purged === fileRowsAll.length, JSON.stringify({ total: fileRowsAll.length, purged }));
const projRow = await api("/api/v1/projects/" + projectId);
const delProj = await api("/api/v1/projects/" + projectId, "DELETE", undefined, { "If-Match": String(projRow.json.version) });
check("⑤b 临时项目移入回收站（200）", delProj.status === 200, String(delProj.status));
const projGone = await api("/api/v1/projects/" + projectId);
check("⑤c 项目读面 404（回收站中普通读面不可见）", projGone.status === 404, String(projGone.status));
const purgeProj = await api("/api/v1/projects/" + projectId + "/purge", "POST", { version: Number(delProj.json.version) });
check("⑤d 回收站项目彻底删除（200）", purgeProj.status === 200, JSON.stringify({ status: purgeProj.status, body: purgeProj.json }));
await db.query("delete from dict_items where type_code = $1 and code = $2", ["deliverableType", customName]);
await db.query("update dict_types set updated_at = now() where code = $1", ["deliverableType"]);
await db.query("update sessions set revoked_at = now() where token_hash = $1", [sha256(token)]);
const residue = (await db.query("select (select count(*)::int from files where project_id = $1) as files, (select count(*)::int from file_links where object_id = $2) as links, (select count(*)::int from tasks where id = $2) as tasks, (select count(*)::int from projects where id = $1) as projects, (select count(*)::int from sessions where token_hash = $3 and revoked_at is null) as sessions, (select count(*)::int from dict_items where type_code = $4 and code = $5) as global_types", [projectId, taskId, sha256(token), "deliverableType", customName])).rows[0];
check("⑤e 零残留：文件 / 关联 / 任务 / 项目 / 会话 / 临时全局字典项全 0 行", Number(residue.files) === 0 && Number(residue.links) === 0 && Number(residue.tasks) === 0 && Number(residue.projects) === 0 && Number(residue.sessions) === 0 && Number(residue.global_types) === 0, JSON.stringify(residue));

rmSync(fileDir, { recursive: true, force: true });
const failed = checks.filter((ok) => ok !== true).length;
console.log("—— 合计 " + String(checks.length) + " 项：" + String(checks.length - failed) + " 通过 / " + String(failed) + " 失败 ——");
const pageEvents = page.events.filter((line) => line.indexOf("EVT ") === 0);
console.log("页面控制台 / 异常：" + String(pageEvents.length) + " 条");
for (const line of pageEvents.slice(0, 8)) { console.log("  " + line.slice(0, 240)); }
try { page.ws.close(); } catch (error) { /* 忽略 */ }
chrome.kill();
await db.end();
process.exit(failed === 0 ? 0 : 1);
