#!/usr/bin/env node
/**
 * LibiaoLink 前端 · 回放：项目状态（Push 262 · 编辑项目「项目状态」四选一 + 卡片状态字 + 已归档归档流）+ 编辑弹窗「备注」字段（Push 280）
 *
 * 业务口径（2026-10-09）：「编辑项目里面加一个修改项目的状态 进行中 已暂停 已完成 已归档」+
 * 「在项目卡片分类右侧显示淡淡的文字状态」。
 *
 * 本脚本用真机浏览器（无头 Chrome + CDP）验：
 *   ① 项目卡片：每张卡分类徽标右侧有淡灰状态字（data-card-status）：文案四档、位置（同排、徽标右侧）、
 *      颜色（zinc-400 浅灰）、与库内 projects.status 逐卡对账；
 *   ② 编辑弹窗「项目状态」四选一：四枚选项 / 文案四档 / 当前选中 = 库内值；新建弹窗不含该区（只编辑有）；
 *   ③ 状态改「已暂停」→ 保存：卡面 / 库内 / 审计（status active → paused）三处对账；刷新后仍生效（持久化）；
 *      再改「已完成」对账、最后「进行中」还原（PATCH 走乐观锁 version，均写字段级留痕）；
 *   ④「已归档」走归档端点（契约：PATCH 不收 archived —— ADR-027 任务完成门禁 + 清单 + 留痕）：在抛荒项目上
 *      先插入未完成任务 → 409 提示、无二次确认、库内不置位 → SQL 置全部任务 done → 再保存直接归档；
 *      归档成功：status = archived + project_archives 清单 1 行（acknowledged_missing=[]）+ 审计 action = archive；
 *   ⑤ 已归档项目再开编辑弹窗：四枚选项与保存全禁用（只读保护），提示「项目已归档：处于只读保护」在场；
 *   ⑥ 控制台零报错；跑完会话撤销、抛荒项目业务表零残留（审计行追加写、按 C7-05 保留）、目标项目状态还原。
 *   ⑦ 编辑弹窗「备注」（Push 280 · 契约 description）：多行文本框在场（选填 · 上限 2000 · 占位文案）且初值 = 库内值；填文本保存 → 库内 description 落文本 + 审计字段级留痕（null → 文本）；重开弹窗回填；清空保存 → 库内 null（清空发 null）+ 审计（文本 → null）；再开为空；收尾随 ⑱ 一并还原。
 *
 * 前置（都在本机跑着）：前端 dev :3000 / api :3001 / 本地沙箱 PG :5433 / 本机 Chrome（无头）。
 * 用法：node scripts/ui-project-status-e2e.mjs
 *   可覆盖的环境变量：FRONTEND_BASE / API_BASE / DATABASE_URL / CHROME_PATH / CDP_PORT / REPLAY_USER / PG_MODULE / SHOT_DIR
 */

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
const PG_MODULE = process.env.PG_MODULE ?? new URL("../../server/node_modules/pg/lib/index.js", import.meta.url).href;
const { default: pg } = await import(PG_MODULE);
const { Client } = pg;
const FRONTEND = process.env.FRONTEND_BASE ?? "http://localhost:3000";
const API = process.env.API_BASE ?? "http://localhost:3001";
const CHROME = process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PORT = Number(process.env.CDP_PORT ?? 9422);
const DB = process.env.DATABASE_URL ?? "postgres://libiaolink_api@127.0.0.1:5433/libiaolink";
const REPLAY_USER = process.env.REPLAY_USER ?? "px-replay";
const SHOTS = process.env.SHOT_DIR ?? join(tmpdir(), "px-project-status-shots");
const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const j = (value) => JSON.stringify(value);
const checks = [];
const check = (name, ok, detail) => { checks.push({ name: name, ok: ok === true }); console.log((ok === true ? "  PASS  " : "  FAIL  ") + name + (ok === true || detail === undefined ? " " : "  —— " + detail)); };
const STATUS_TEXT = { active: "进行中", paused: "已暂停", done: "已完成", archived: "已归档" };
const STATUS_VALUES = ["active", "paused", "done", "archived"];

mkdirSync(SHOTS, { recursive: true });
const db = new Client({ connectionString: DB });
await db.connect();
const userRow = (await db.query("select id, username, display_name from users where username = $1 and status = 'active'", [REPLAY_USER])).rows[0];
if (userRow === undefined) { console.error("回放用户不存在：" + REPLAY_USER); process.exit(1); }
const token = "pxstat-" + randomBytes(16).toString("hex");
const csrf = randomBytes(16).toString("hex");
await db.query("insert into sessions (token_hash, user_id, id_token, expires_at) values ($1, $2, $3, now() + make_interval(mins => 30))", [sha256(token), userRow.id, "ui-project-status-e2e"]);
console.log("临时会话：" + userRow.username + "（" + userRow.display_name + "）");

async function apiCall(method, path, body) {
  const response = await fetch(API + path, {
    method: method,
    headers: { "content-type": "application/json", cookie: "ll_sid=" + token + "; ll_csrf=" + csrf, "x-csrf-token": csrf },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed = null;
  try { parsed = text === "" ? null : JSON.parse(text); } catch (error) { parsed = null; }
  return { status: response.status, body: parsed };
}

async function projectRowOf(id) {
  return (await db.query("select id, code, name, status, version from projects where id = $1", [id])).rows[0];
}

/** 审计行（最新在前）：action / result / changes —— 断言字段级留痕（status from → to）。 */
async function auditRows(projectId, limit) {
  return (await db.query("select action, result, summary, changes from audit_logs where object_id = $1 order by occurred_at desc, id desc limit $2", [projectId, limit])).rows;
}

function hasStatusChange(rows, from, to) {
  for (const row of rows) {
    const changes = Array.isArray(row.changes) ? row.changes : [];
    for (const item of changes) {
      if (item !== null && item.field === "status" && item.from === from && item.to === to) { return true; }
    }
  }
  return false;
}

// ---------- 夹具 ----------
const TARGET_CODE = process.env.TARGET_CODE ?? "LBEG-20260928-1002";
const target = (await db.query("select id, code, name, status from projects where code = $1 and deleted_at is null", [TARGET_CODE])).rows[0];
if (target === undefined) { console.error("目标项目不存在：" + TARGET_CODE); process.exit(1); }
if (target.status !== "active") { console.error("目标项目初始状态不是 active：" + target.status); process.exit(1); }
const targetDesc0 = (await db.query("select description from projects where id = $1", [target.id])).rows[0].description;

const stamp = Date.now().toString(36).toUpperCase();
const throwCode = "PXQC-" + stamp;
const created = await apiCall("POST", "/api/v1/projects", { code: throwCode, name: "回放-项目状态-" + stamp, managerIds: [userRow.id] });
if (created.body === null || typeof created.body.id !== "string") { console.error("抛荒项目创建失败：" + String(created.status) + " " + JSON.stringify(created.body)); process.exit(1); }
const throwId = created.body.id;
console.log("抛荒项目：" + throwCode + "（" + throwId + "）");
// 归档门禁 = 项目内任务全部 done；先插入一条未完成任务复现 409，再置为 done 复现直接归档。
await db.query("insert into tasks (project_id, stage_key, manager_ids, title, status) select id, stage_key, manager_ids, $2, $3 from projects where id = $1", [throwId, "回放-未完成任务-" + stamp, "pending"]);

async function cleanupThrowProject() {
  await db.query("delete from follows where object_type = $1 and object_id = $2", ["project", throwId]);
  await db.query("delete from tasks where project_id = $1", [throwId]);
  await db.query("delete from node_requirements where node_id in (select id from project_nodes where project_id = $1)", [throwId]);
  await db.query("delete from project_nodes where project_id = $1", [throwId]);
  await db.query("delete from project_stages where project_id = $1", [throwId]);
  await db.query("delete from project_archives where project_id = $1", [throwId]);
  await db.query("delete from project_members where project_id = $1", [throwId]);
  await db.query("delete from project_stakeholders where project_id = $1", [throwId]);
  await db.query("delete from projects where id = $1", [throwId]);
}

// ---------- 无头 Chrome + CDP ----------
const profile = mkdtempSync(join(tmpdir(), "pxstat-"));
const chrome = spawn(CHROME, ["--headless=new", "--remote-debugging-port=" + PORT, "--user-data-dir=" + profile, "--no-first-run", "--no-default-browser-check", "--disable-gpu", "about:blank"], { stdio: "ignore" });

async function waitTarget() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const list = await (await fetch("http://127.0.0.1:" + PORT + "/json/list")).json();
      const found = list.find((item) => item.type === "page" && item.webSocketDebuggerUrl);
      if (found) { return found; }
    } catch (error) { }
    await new Promise((resolve) => setTimeout(resolve, 500));
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
        if (msg.error) { item.reject(new Error(JSON.stringify(msg.error))); } else { item.resolve(msg.result); }
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error("cdp timeout: " + method)); }, 15000);
      this.pending.set(id, { resolve: (value) => { clearTimeout(timer); resolve(value); }, reject: (error) => { clearTimeout(timer); reject(error); } });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
}

const targetTab = await waitTarget();
const page = new Cdp(targetTab.webSocketDebuggerUrl);
await page.ready;
await page.send("Network.enable");
await page.send("Page.enable");
await page.send("Runtime.enable");
await page.send("Log.enable");
const consoleErrors = [];
page.ws.addEventListener("message", (event) => {
  const msg = JSON.parse(typeof event.data === "string" ? event.data : String(event.data));
  if (msg.method === "Log.entryAdded" && msg.params !== undefined && msg.params.entry !== undefined && msg.params.entry.level === "error") {
    consoleErrors.push({ text: String(msg.params.entry.text), url: String(msg.params.entry.url ?? "") });
  }
  if (msg.method === "Runtime.exceptionThrown") { consoleErrors.push({ text: "exceptionThrown", url: "" }); }
  if (msg.method === "Runtime.consoleAPICalled" && msg.params !== undefined && msg.params.type === "error") {
    consoleErrors.push({ text: (msg.params.args ?? []).map((item) => String(item.value ?? item.description ?? " ")).join(" "), url: "" });
  }
});
await page.send("Network.setCookie", { name: "ll_sid", value: token, url: FRONTEND + "/", path: "/", httpOnly: true, secure: false });
await page.send("Network.setCookie", { name: "ll_csrf", value: csrf, url: FRONTEND + "/", path: "/", httpOnly: false, secure: false });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ev = async (expression) => (await page.send("Runtime.evaluate", { expression, returnByValue: true })).result.value;
async function shot(name, clip) {
  const params = { format: "png" };
  if (clip !== undefined && clip !== null) { params.clip = clip; }
  const result = await page.send("Page.captureScreenshot", params);
  const file = join(SHOTS, name + ".png");
  writeFileSync(file, Buffer.from(result.data, "base64"));
  return file;
}
async function waitFor(expression, timeoutMs) {
  const start = Date.now();
  for (;;) {
    const value = await ev(expression);
    if (value === true) { return true; }
    if (Date.now() - start > timeoutMs) { return false; }
    await sleep(250);
  }
}
async function clickAt(point) {
  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y, button: "none" });
  await page.send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1 });
  await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1 });
  await sleep(450);
}
async function clickSelector(selector) {
  const point = await ev("(function(){var b=document.querySelector(" + j(selector) + ");if(b===null){return null;}b.scrollIntoView({block:" + j("center") + ",inline:" + j("nearest") + "});var r=b.getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};})()");
  if (point === null || point === undefined) { return false; }
  await clickAt(point);
  return true;
}
async function clickByText(selector, text) {
  const point = await ev("(function(){var bs=document.querySelectorAll(" + j(selector) + ");for(var i=0;i<bs.length;i+=1){if(String(bs[i].textContent).trim()===" + j(text) + "){bs[i].scrollIntoView({block:" + j("center") + "});var r=bs[i].getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};}}return null;})()");
  if (point === null || point === undefined) { return false; }
  await clickAt(point);
  return true;
}

/** Push 280：「备注」文本框用 —— 真键盘输入 / 清空（与 m6-06 同款）。 */
async function pressKey(key, code, vk, modifiers = 0) {
  await page.send("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers });
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers });
  await sleep(120);
}
/** 覆盖式输入（先 Ctrl+A 再插字；换行 = 真回车键）—— 便签标题 / 内容 / 搜索都用它。 */
async function typeInto(selector, text) {
  await clickSelector(selector);
  await pressKey("a", "KeyA", 65, 2);
  const parts = String(text).split("\n");
  for (let i = 0; i < parts.length; i += 1) {
    if (i > 0) {
      await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: String.fromCharCode(13), unmodifiedText: String.fromCharCode(13) });
      await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
      await sleep(160);
    }
    if (parts[i] !== "") {
      await page.send("Input.insertText", { text: parts[i] });
    }
    await sleep(160);
  }
  await sleep(360);
}
async function clearField(selector) {
  await clickSelector(selector);
  await pressKey("a", "KeyA", 65, 2);
  await pressKey("Backspace", "Backspace", 8);
  await sleep(300);
}

const editDialogSel = "[role=dialog][aria-label=" + j("编辑项目") + "]";
const createDialogSel = "[role=dialog][aria-label=" + j("新建项目") + "]";
const submitSel = editDialogSel + " button[type=submit]";

const cardExpr = () => "(function(){var ref=document.createElement(" + j("span") + ");ref.className=" + j("text-zinc-400") + ";ref.textContent=" + j("m") + ";ref.style.position=" + j("absolute") + ";ref.style.visibility=" + j("hidden") + ";document.body.appendChild(ref);var refColor=getComputedStyle(ref).color;document.body.removeChild(ref);var cards=document.querySelectorAll(" + j(".project-card") + ");var out=[];for(var i=0;i<cards.length;i+=1){var c=cards[i];var h=c.querySelector(" + j("h1") + ");var st=c.querySelector(" + j("[data-card-status]") + ");var badge=st===null?null:st.previousElementSibling;var r=st===null?null:st.getBoundingClientRect();var b=badge===null?null:badge.getBoundingClientRect();var conf=st===null?null:getComputedStyle(st);out.push({code:h===null?null:String(h.textContent).trim(),status:st===null?null:String(st.getAttribute(" + j("data-card-status") + ")),text:st===null?null:String(st.textContent).trim(),left:r===null?null:r.left,badgeRight:b===null?null:b.right,top:r===null?null:r.top,bottom:r===null?null:r.bottom,badgeTop:b===null?null:b.top,badgeBottom:b===null?null:b.bottom,color:conf===null?null:conf.color,refColor:refColor,fontSize:conf===null?null:conf.fontSize});}return out;})()";
const modalExpr = () => "(function(){var d=document.querySelector(" + j(editDialogSel) + ");if(d===null){return null;}var opts=[];var bs=d.querySelectorAll(" + j("[data-project-status-option]") + ");for(var i=0;i<bs.length;i+=1){opts.push({value:bs[i].getAttribute(" + j("data-project-status-option") + "),text:String(bs[i].textContent).trim(),selected:bs[i].getAttribute(" + j("aria-checked") + "),disabled:bs[i].disabled});}var submit=d.querySelector(" + j("button[type=submit]") + ");var spans=d.querySelectorAll(" + j("span") + ");var hint=null;for(var k=0;k<spans.length;k+=1){var t=String(spans[k].textContent).trim();if(t.indexOf(" + j("保存后立即生效") + ")===0||t.indexOf(" + j("项目任务全部完成后即可归档") + ")===0||t.indexOf(" + j("项目已归档：处于只读保护") + ")===0){hint=t;break;}}return {options:opts,submitLabel:submit===null?null:String(submit.textContent).trim(),submitDisabled:submit===null?true:submit.disabled,hint:hint};})()";

const remarkSel = editDialogSel + " textarea";
const remarkExpr = () => "(function(){var d=document.querySelector(" + j(editDialogSel) + ");if(d===null){return null;}var a=d.querySelector(" + j("textarea") + ");if(a===null){return {present:false};}var lab=a.closest(" + j("label") + ");return {present:true,tag:a.tagName,label:lab===null?null:String(lab.textContent).trim(),value:a.value,maxLength:a.maxLength,placeholder:a.placeholder,disabled:a.disabled};})()";

async function cardStatusOf(code) {
  const cards = await ev(cardExpr());
  const found = cards.find((item) => item.code === code);
  return found === undefined ? null : found;
}
async function ensureSidebarOpen() {
  const state = await ev("(function(){var panel=document.querySelector(" + j("#category-filter-panel") + ");var input=document.querySelector(" + j("input[aria-controls=\"category-filter-panel\"]") + ");if(panel===null){return null;}var r=panel.getBoundingClientRect();return {open:r.left>=-1&&r.width>0,checked:input===null?null:input.checked};})()");
  if (state === null || state === undefined) { return false; }
  if (state.open === true) { return true; }
  const point = await ev("(function(){var input=document.querySelector(" + j("input[aria-controls=\"category-filter-panel\"]") + ");if(input===null){return null;}var label=input.closest(" + j("label") + ");if(label===null){return null;}var r=label.getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};})()");
  if (point === null || point === undefined) { return false; }
  await clickAt(point);
  return await waitFor("(function(){var p=document.querySelector(" + j("#category-filter-panel") + ");if(p===null){return false;}return p.getBoundingClientRect().left>=-1;})()", 8000);
}
const sidebarExpr = () => "(function(){var panel=document.querySelector(" + j("#category-filter-panel") + ");var s=document.querySelector(" + j("[data-status-section]") + ");if(panel===null||s===null){return null;}var t=s.querySelector(" + j("p") + ");var bs=s.querySelectorAll(" + j("[data-chip]") + ");var out=[];for(var i=0;i<bs.length;i+=1){var n=bs[i].querySelector(" + j("span") + ");out.push({value:bs[i].getAttribute(" + j("data-chip") + "),text:String(bs[i].textContent).trim(),pressed:bs[i].getAttribute(" + j("aria-pressed") + "),count:n===null?null:Number(String(n.textContent).trim())});}var vp=panel.querySelector(" + j("[data-scroll-area=vertical]") + ");var heads=[];if(vp!==null){var ps=vp.querySelectorAll(" + j("p") + ");for(var k=0;k<ps.length;k+=1){var ht=String(ps[k].textContent).trim();if(ht===" + j("常用筛选") + "||ht===" + j("地区") + "||ht===" + j("项目类型") + "||ht===" + j("项目经理") + "||ht===" + j("项目状态") + "){heads.push(ht);}else if(ht.indexOf(" + j("项目时间") + ")===0){heads.push(" + j("项目时间") + ");}}}var sticky=0;if(vp!==null){var all=vp.querySelectorAll(" + j("*") + ");for(var m=0;m<all.length;m+=1){var pos=getComputedStyle(all[m]).position;if(pos===" + j("sticky") + "||pos===" + j("fixed") + "){sticky+=1;}}}var panelText=String(panel.textContent);return {title:t===null?null:String(t.textContent).trim(),oldTitleGone:panelText.indexOf(" + j("分类筛选") + ")===-1,oldDescGone:panelText.indexOf(" + j("按常看组合") + ")===-1,heads:heads,stickyCount:sticky,chips:out};})()";
const chipPressed = (value) => "(function(){var b=document.querySelector(" + j('[data-status-section] [data-chip="' + value + '"]') + ");return b===null?null:b.getAttribute(" + j("aria-pressed") + ");})()";
const footerText = () => "(function(){var panel=document.querySelector(" + j("#category-filter-panel") + ");if(panel===null){return " + j("") + ";}var spans=panel.querySelectorAll(" + j("span") + ");for(var i=0;i<spans.length;i+=1){var t=String(spans[i].textContent).trim();if(t.indexOf(" + j("已选") + ")===0||t.indexOf(" + j("未选择筛选条件") + ")===0){return t;}}return " + j("") + ";})()";
const modalScrollExpr = () => "(function(){var d=document.querySelector(" + j(editDialogSel) + ");if(d===null){return null;}var v=d.querySelector(" + j("[data-scroll-area=vertical]") + ");var r=d.getBoundingClientRect();var last=d.lastElementChild;var f=last===null?null:last.getBoundingClientRect();return {top:r.top,bottom:r.bottom,height:r.height,viewport:window.innerHeight,overflowY:v===null?null:getComputedStyle(v).overflowY,scrollHeight:v===null?null:v.scrollHeight,clientHeight:v===null?null:v.clientHeight,footerBottom:f===null?null:f.bottom};})()";
async function openEditFor(code) {
  const point = await ev("(function(){var cards=document.querySelectorAll(" + j(".project-card") + ");for(var i=0;i<cards.length;i+=1){var h=cards[i].querySelector(" + j("h1") + ");if(h===null||String(h.textContent).trim()!==" + j(code) + "){continue;}var bs=cards[i].querySelectorAll(" + j("button") + ");for(var k=0;k<bs.length;k+=1){if(bs[k].getAttribute(" + j("aria-label") + ")===" + j("编辑项目") + "){bs[k].scrollIntoView({block:" + j("center") + "});var r=bs[k].getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};}}}return null;})()");
  if (point === null || point === undefined) { return false; }
  await clickAt(point);
  return await waitFor("document.querySelector(" + j(editDialogSel) + ") !== null", 12000);
}

try {
  // ---------- ① 卡片状态字 ----------
  await page.send("Emulation.setDeviceMetricsOverride", { width: 1500, height: 1000, deviceScaleFactor: 1, mobile: false });
  await page.send("Page.navigate", { url: "about:blank" });
  await sleep(400);
  await page.send("Page.navigate", { url: FRONTEND + "/#/projects" });
  const cardsReady = await waitFor("document.querySelectorAll(" + j(".project-card") + ").length > 0", 40000);
  await sleep(1500);
  const cards = await ev(cardExpr());
  const dbStatus = new Map((await db.query("select code, status from projects where deleted_at is null")).rows.map((row) => [row.code, row.status]));
  const cardShot = await shot("project-status-card", { x: 16, y: 140, width: 430, height: 300, scale: 2 });
  console.log("截图：" + cardShot);
  check("① 卡片状态字在场：每张卡一枚（data-card-status）、四档取值、文案 = 中文状态（共 " + String(cards.length) + " 张）",
    cardsReady === true && cards.length > 0 && cards.every((c) => STATUS_VALUES.includes(c.status) && STATUS_TEXT[c.status] === c.text),
    JSON.stringify(cards.slice(0, 2)));
  const mismatch = cards.filter((c) => dbStatus.get(c.code) !== c.status);
  check("② 卡面状态 = 库内 projects.status（按编号逐卡对账）", mismatch.length === 0, JSON.stringify(mismatch.slice(0, 2)));
  const geomBad = cards.filter((c) => !(c.left !== null && c.badgeRight !== null && c.left >= c.badgeRight - 0.5 && Math.abs((c.top + c.bottom) / 2 - (c.badgeTop + c.badgeBottom) / 2) <= 8));
  check("③ 状态字位置：分类徽标右侧同排（左缘 ≥ 徽标右缘、垂直中心差 ≤ 8px）", geomBad.length === 0, JSON.stringify(geomBad.slice(0, 2)));
  function isLightGray(value) {
    const rgb = /^rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(value);
    if (rgb !== null) { return Math.abs(Number(rgb[1]) - 161) <= 6 && Math.abs(Number(rgb[2]) - 161) <= 6 && Math.abs(Number(rgb[3]) - 170) <= 6; }
    const oklch = /^oklch\(([\d.]+)\s+([\d.]+)\s+([\d.]+)/.exec(value);
    if (oklch !== null) { const l = Number(oklch[1]); const c = Number(oklch[2]); return l >= 0.6 && l <= 0.8 && c <= 0.05; }
    return false;
  }
  const colorBad = cards.filter((c) => c.color !== c.refColor || c.fontSize !== "11px" || !isLightGray(c.color));
  check("④ 状态字淡灰：与 text-zinc-400 同款 token（浏览器计算色值逐卡对比，且为浅灰低饱和）+ 11px 小字", colorBad.length === 0, JSON.stringify(colorBad.slice(0, 2)));

  // ---------- ② 新建弹窗回归（不含状态区） ----------
  await clickByText("button", "新建项目");
  const createReady = await waitFor("document.querySelector(" + j(createDialogSel) + ") !== null", 10000);
  const createOptions = Number(await ev("document.querySelectorAll(" + j(createDialogSel + " [data-project-status-option]") + ").length"));
  check("⑤ 新建弹窗不含状态区（「项目状态」只编辑弹窗有）", createReady === true && createOptions === 0, "count=" + String(createOptions));
  const createRemark = await ev("(function(){var d=document.querySelector(" + j(createDialogSel) + ");if(d===null){return null;}var a=d.querySelector(" + j("textarea") + ");if(a===null){return {present:false};}var lab=a.closest(" + j("label") + ");return {present:true,label:lab===null?null:String(lab.textContent).trim(),value:a.value,maxLength:a.maxLength};})()");
  check("⑤bis 新建弹窗同样含「备注」字段（初值空 · 上限 2000 —— 新建留空不发送）",
    createRemark !== null && createRemark.present === true && createRemark.label !== null && createRemark.label.indexOf("备注") === 0 && createRemark.value === "" && createRemark.maxLength === 2000,
    JSON.stringify(createRemark));
  await clickByText(createDialogSel + " button", "取消");
  await waitFor("document.querySelector(" + j(createDialogSel) + ") === null", 8000);

  // ---------- ③ 编辑弹窗四选一 + 状态切换（目标项目） ----------
  const opened = await openEditFor(TARGET_CODE);
  const modal = await ev(modalExpr());
  const selected = modal === null ? [] : modal.options.filter((o) => o.selected === "true");
  check("⑥ 编辑弹窗「项目状态」四选一：四枚选项 / 文案四档 / 当前选中 = 库内 active / 可保存",
    opened === true && modal !== null && modal.options.length === 4 && modal.options.map((o) => o.value).join(",") === "active,paused,done,archived" && modal.options.every((o) => STATUS_TEXT[o.value] === o.text) && selected.length === 1 && selected[0].value === "active" && modal.submitDisabled === false,
    JSON.stringify(modal));
  const modalShot = await shot("project-status-modal", { x: 380, y: 60, width: 740, height: 880, scale: 1 });
  console.log("截图：" + modalShot);
  await clickSelector("[data-project-status-option=" + j("paused") + "]");
  await clickSelector(submitSel);
  const pauseSaved = await waitFor("document.querySelector(" + j(editDialogSel) + ") === null", 20000);
  await sleep(1200);
  const targetAfterPause = await projectRowOf(target.id);
  const cardAfterPause = await cardStatusOf(TARGET_CODE);
  check("⑦ 改「已暂停」保存：弹窗关、库内 status = paused、卡面 = 已暂停、审计 status active → paused",
    pauseSaved === true && targetAfterPause.status === "paused" && cardAfterPause !== null && cardAfterPause.status === "paused" && cardAfterPause.text === "已暂停" && hasStatusChange(await auditRows(target.id, 3), "active", "paused"),
    JSON.stringify({ db: targetAfterPause.status, card: cardAfterPause === null ? null : cardAfterPause.status }));
  await page.send("Page.reload");
  await waitFor("document.querySelectorAll(" + j(".project-card") + ").length > 0", 40000);
  await sleep(1200);
  const cardAfterReload = await cardStatusOf(TARGET_CODE);
  check("⑧ 刷新后仍生效：卡面 = 已暂停（服务端持久化）", cardAfterReload !== null && cardAfterReload.status === "paused" && cardAfterReload.text === "已暂停", JSON.stringify(cardAfterReload));
  await openEditFor(TARGET_CODE);
  await clickSelector("[data-project-status-option=" + j("done") + "]");
  await clickSelector(submitSel);
  await waitFor("document.querySelector(" + j(editDialogSel) + ") === null", 20000);
  await sleep(1200);
  const targetAfterDone = await projectRowOf(target.id);
  const cardAfterDone = await cardStatusOf(TARGET_CODE);
  check("⑨ 改「已完成」保存：库内 done、卡面 = 已完成、审计 paused → done",
    targetAfterDone.status === "done" && cardAfterDone !== null && cardAfterDone.text === "已完成" && hasStatusChange(await auditRows(target.id, 3), "paused", "done"),
    JSON.stringify({ db: targetAfterDone.status, card: cardAfterDone === null ? null : cardAfterDone.status }));
  await openEditFor(TARGET_CODE);
  await clickSelector("[data-project-status-option=" + j("active") + "]");
  await clickSelector(submitSel);
  await waitFor("document.querySelector(" + j(editDialogSel) + ") === null", 20000);
  await sleep(1200);
  const targetRestored = await projectRowOf(target.id);
  const cardRestored = await cardStatusOf(TARGET_CODE);
  check("⑩ 改回「进行中」还原：库内 active、卡面 = 进行中、审计 done → active",
    targetRestored.status === "active" && cardRestored !== null && cardRestored.text === "进行中" && hasStatusChange(await auditRows(target.id, 3), "done", "active"),
    JSON.stringify({ db: targetRestored.status, card: cardRestored === null ? null : cardRestored.status }));

  // ---------- ③bis 编辑弹窗「备注」（Push 280 · 契约 description：建 / 读 / 清空 / 回填） ----------
  await openEditFor(TARGET_CODE);
  await sleep(400);
  const remark0 = await ev(remarkExpr());
  check("⑩a 编辑弹窗「备注」在场（选填 · 多行文本框 · 上限 2000 · 占位文案）且初值 = 库内 description",
    remark0 !== null && remark0.present === true && remark0.tag === "TEXTAREA" && remark0.label !== null && remark0.label.indexOf("备注") === 0 && remark0.value === (targetDesc0 === null ? "" : targetDesc0) && remark0.maxLength === 2000 && remark0.placeholder.indexOf("项目背景") === 0,
    JSON.stringify(remark0));
  const remarkText = "回放·备注-" + stamp;
  await typeInto(remarkSel, remarkText);
  const remarkFilledShot = await shot("project-remark-filled", { x: 380, y: 60, width: 740, height: 880, scale: 1 });
  console.log("截图：" + remarkFilledShot);
  await clickSelector(submitSel);
  const remarkSaved = await waitFor("document.querySelector(" + j(editDialogSel) + ") === null", 20000);
  await sleep(1200);
  const descAfterSave = (await db.query("select description from projects where id = $1", [target.id])).rows[0].description;
  const hasDescriptionChange = (rows, from, to) => rows.some((row) => (Array.isArray(row.changes) ? row.changes : []).some((item) => item !== null && item.field === "description" && item.from === from && item.to === to));
  check("⑩b 填备注 → 保存修改：弹窗关、库内 description 落文本、审计 update 含 description（原值 → 文本）",
    remarkSaved === true && descAfterSave === remarkText && hasDescriptionChange(await auditRows(target.id, 3), targetDesc0, remarkText),
    JSON.stringify({ db: descAfterSave }));
  await openEditFor(TARGET_CODE);
  await sleep(400);
  const remarkRefill = await ev(remarkExpr());
  check("⑩c 重开编辑弹窗：备注回填 = 刚保存的文本（持久化）",
    remarkRefill !== null && remarkRefill.present === true && remarkRefill.value === remarkText,
    JSON.stringify(remarkRefill));
  await clearField(remarkSel);
  await clickSelector(submitSel);
  await waitFor("document.querySelector(" + j(editDialogSel) + ") === null", 20000);
  await sleep(1200);
  const descAfterClear = (await db.query("select description from projects where id = $1", [target.id])).rows[0].description;
  check("⑩d 清空备注 → 保存修改：库内 description = null（清空发 null）、审计 update 含 description（文本 → null）",
    descAfterClear === null && hasDescriptionChange(await auditRows(target.id, 3), remarkText, null),
    JSON.stringify({ db: descAfterClear }));
  await openEditFor(TARGET_CODE);
  await sleep(400);
  const remarkCleared = await ev(remarkExpr());
  check("⑩e 重开编辑弹窗：备注已清空（回读 = 空）",
    remarkCleared !== null && remarkCleared.present === true && remarkCleared.value === "",
    JSON.stringify(remarkCleared));
  await clickByText(editDialogSel + " button", "取消");
  await waitFor("document.querySelector(" + j(editDialogSel) + ") === null", 8000);

  // ---------- ④ 已归档：有未完成任务 409 拦截 → 全部完成后直接归档（抛荒项目） ----------
  await page.send("Page.reload");
  await waitFor("document.querySelectorAll(" + j(".project-card") + ").length > 0", 40000);
  await sleep(1200);
  const throwCardShown = await cardStatusOf(throwCode);
  check("⑪ 抛荒项目卡片在场（status=active、状态字「进行中」）", throwCardShown !== null && throwCardShown.text === "进行中", JSON.stringify(throwCardShown));
  const openedThrow = await openEditFor(throwCode);
  await clickSelector("[data-project-status-option=" + j("archived") + "]");
  await sleep(600);
  const archivedModal = await ev(modalExpr());
  const archivedSelected = archivedModal === null ? [] : archivedModal.options.filter((o) => o.selected === "true");
  const hintOk = archivedModal !== null && archivedModal.hint !== null && archivedModal.hint.indexOf("项目任务全部完成后即可归档") === 0;
  const hintShot = await shot("project-status-archived-hint", { x: 380, y: 60, width: 740, height: 880, scale: 1 });
  console.log("截图：" + hintShot);
  check("⑫ 点「已归档」：选中态 + 提示「项目任务全部完成后即可归档」在场",
    openedThrow === true && archivedModal !== null && hintOk && archivedSelected.length === 1 && archivedSelected[0].value === "archived",
    JSON.stringify(archivedModal === null ? null : archivedModal.hint));
  await clickSelector(submitSel);
  const rejectedReady = await waitFor("(function(){var d=document.querySelector(" + j(editDialogSel) + ");if(d===null){return false;}var a=d.querySelector(" + j("[role=alert]") + ");return a!==null&&String(a.textContent).trim().indexOf(" + j("项目还有任务未完成") + ")===0;})()", 25000);
  const rejectedUi = await ev("(function(){var d=document.querySelector(" + j(editDialogSel) + ");if(d===null){return null;}var a=d.querySelector(" + j("[role=alert]") + ");return {text:a===null?null:String(a.textContent).trim(),panel:document.querySelector(" + j("[data-archive-confirm]") + ")!==null,dialog:true};})()");
  const stillActive = (await projectRowOf(throwId)).status;
  const rejectedArchiveCount = Number((await db.query("select count(*)::int n from project_archives where project_id = $1", [throwId])).rows[0].n);
  const rejectShot = await shot("project-status-archive-not-ready", { x: 380, y: 60, width: 740, height: 900, scale: 1 });
  console.log("截图：" + rejectShot);
  check("⑬ 有未完成任务 → 409：弹窗内提示「项目还有任务未完成，不能归档。」、无二次确认、库内未归档",
    rejectedReady === true && rejectedUi !== null && rejectedUi.text !== null && rejectedUi.text.indexOf("项目还有任务未完成") === 0 && rejectedUi.panel === false && stillActive === "active" && rejectedArchiveCount === 0,
    JSON.stringify({ ui: rejectedUi, status: stillActive, archives: rejectedArchiveCount }));
  await db.query("update tasks set status = $2, updated_at = now() where project_id = $1 and deleted_at is null", [throwId, "done"]);
  await clickSelector(submitSel);
  const archivedOk = await waitFor("document.querySelector(" + j(editDialogSel) + ") === null", 40000);
  await sleep(1500);
  const throwAfter = await projectRowOf(throwId);
  const archiveCount = Number((await db.query("select count(*)::int n from project_archives where project_id = $1", [throwId])).rows[0].n);
  const archiveRow = (await db.query("select acknowledged_missing from project_archives where project_id = $1", [throwId])).rows[0];
  const ackEmpty = archiveRow !== undefined && Array.isArray(archiveRow.acknowledged_missing) && archiveRow.acknowledged_missing.length === 0;
  const archiveAudit = Number((await db.query("select count(*)::int n from audit_logs where object_id = $1 and action = $2 and result = $3", [throwId, "archive", "succeeded"])).rows[0].n);
  const throwCardArchived = await cardStatusOf(throwCode);
  check("⑮ 全部任务完成 → 直接归档：status = archived + 清单 1 行 · acknowledged_missing 为空 + 审计 archive 成功 + 卡面 = 已归档",
    archivedOk === true && throwAfter.status === "archived" && archiveCount === 1 && ackEmpty === true && archiveAudit >= 1 && throwCardArchived !== null && throwCardArchived.text === "已归档",
    JSON.stringify({ db: throwAfter.status, archives: archiveCount, ack: archiveRow === undefined ? null : archiveRow.acknowledged_missing, audit: archiveAudit, card: throwCardArchived === null ? null : throwCardArchived.status }));

  // ---------- ⑤ 已归档项目只读 ----------
  const openedLocked = await openEditFor(throwCode);
  await sleep(600);
  const lockedModal = await ev(modalExpr());
  const lockedShot = await shot("project-status-locked", { x: 380, y: 60, width: 740, height: 880, scale: 1 });
  console.log("截图：" + lockedShot);
  check("⑯ 已归档项目只读：四枚选项全禁用、保存禁用（label「已归档只读」）、提示「项目已归档：处于只读保护」在场",
    openedLocked === true && lockedModal !== null && lockedModal.options.length === 4 && lockedModal.options.every((o) => o.disabled === true) && lockedModal.submitDisabled === true && lockedModal.submitLabel === "已归档只读" && lockedModal.hint !== null && lockedModal.hint.indexOf("项目已归档：处于只读保护") === 0,
    JSON.stringify({ submit: lockedModal === null ? null : lockedModal.submitLabel, hint: lockedModal === null ? null : lockedModal.hint }));
  await clickByText(editDialogSel + " button", "取消");
  await waitFor("document.querySelector(" + j(editDialogSel) + ") === null", 8000);

  // ---------- ⑤bis 侧栏「项目状态」筛选 ----------
  await page.send("Page.navigate", { url: "about:blank" });
  await sleep(400);
  await page.send("Page.navigate", { url: FRONTEND + "/#/projects" });
  const cardsSidebarReady = await waitFor("document.querySelectorAll(" + j(".project-card") + ").length > 0", 40000);
  await sleep(1200);
  const sidebarOpened = await ensureSidebarOpen();
  const sidebarState = await ev(sidebarExpr());
  const dbStatusCounts = new Map((await db.query("select status, count(*)::int n from projects where deleted_at is null group by status")).rows.map((row) => [row.status, Number(row.n)]));
  const statusChipShot = await shot("project-status-sidebar");
  console.log("截图：" + statusChipShot);
  check("⑲ 侧栏「项目状态」区（顺序 常用筛选→地区→项目类型→项目经理→项目状态→项目时间、无吸顶）：旧「分类筛选」标题与说明已删、四枚 chip 文案四档、计数 = 库内各档（无其他筛选）",
    cardsSidebarReady === true && sidebarOpened === true && sidebarState !== null && sidebarState.oldTitleGone === true && sidebarState.oldDescGone === true && sidebarState.heads.join(",") === "常用筛选,地区,项目类型,项目经理,项目状态,项目时间" && sidebarState.stickyCount === 0 && sidebarState.title === "项目状态" && sidebarState.chips.length === 4 && sidebarState.chips.map((c) => c.value).join(",") === "active,paused,done,archived" && sidebarState.chips.map((c) => c.text.indexOf(STATUS_TEXT[c.value]) === 0).every((x) => x === true) && sidebarState.chips.every((c) => c.count === (dbStatusCounts.get(c.value) ?? 0)),
    JSON.stringify({ open: sidebarOpened, state: sidebarState, db: Array.from(dbStatusCounts.entries()) }));
  await clickSelector("[data-status-section] [data-chip=" + j("active") + "]");
  await sleep(1400);
  const activeCards = await ev(cardExpr());
  const activeHash1 = await ev("window.location.hash");
  check("⑲b 点「进行中」：地址 filter[status]=active、卡面全进行中、张数 = 库内 active、chip 选中态 + 「已选 1 项」",
    typeof activeHash1 === "string" && activeHash1.indexOf("filter[status]=active") !== -1 && activeCards.length > 0 && activeCards.every((c) => c.status === "active") && activeCards.length === (dbStatusCounts.get("active") ?? 0) && (await ev(chipPressed("active"))) === "true" && (await ev(footerText())).indexOf("已选 1 项") === 0,
    JSON.stringify({ hash: activeHash1, cards: activeCards.length, db: dbStatusCounts.get("active") }));
  await clickSelector("[data-status-section] [data-chip=" + j("paused") + "]");
  await sleep(1600);
  const unionCards = await ev(cardExpr());
  const unionHash = await ev("window.location.hash");
  const unionExpect = (dbStatusCounts.get("active") ?? 0) + (dbStatusCounts.get("paused") ?? 0);
  check("⑲c 多选累加（进行中 + 已暂停）：地址逗号多值、张数 = 两档并集、卡面全在两档内",
    typeof unionHash === "string" && unionHash.indexOf("filter[status]=active,paused") !== -1 && unionCards.length === unionExpect && unionCards.every((c) => c.status === "active" || c.status === "paused"),
    JSON.stringify({ hash: unionHash, cards: unionCards.length, expect: unionExpect }));
  await clickSelector("[data-status-section] [data-chip=" + j("active") + "]");
  await sleep(1600);
  const pausedCards = await ev(cardExpr());
  check("⑲d 再点「进行中」= 取消选择：只剩 paused、张数 = 库内 paused",
    pausedCards.length === (dbStatusCounts.get("paused") ?? 0) && pausedCards.every((c) => c.status === "paused") && (await ev(chipPressed("active"))) === "false",
    JSON.stringify({ cards: pausedCards.length, db: dbStatusCounts.get("paused") }));
  await clickSelector("[data-status-section] [data-chip=" + j("paused") + "]");
  await sleep(1600);
  const clearedCards = await ev(cardExpr());
  const clearedHash = await ev("window.location.hash");
  const dbTotal = Array.from(dbStatusCounts.values()).reduce((sum, value) => sum + value, 0);
  check("⑲e 再点「已暂停」= 清空状态筛选：地址回 #/projects（缺省不落参数）、张数还原",
    typeof clearedHash === "string" && clearedHash.indexOf("filter[status]") === -1 && clearedCards.length === dbTotal && (await ev(footerText())).indexOf("未选择筛选条件") === 0,
    JSON.stringify({ hash: clearedHash, cards: clearedCards.length, total: dbTotal }));
  await clickSelector("[data-status-section] [data-chip=" + j("done") + "]");
  await sleep(1400);
  const resetClicked = await clickSelector("[data-filter-reset]");
  await sleep(1600);
  await sleep(400);
  const resetHash = await ev("window.location.hash");
  const resetCards = await ev(cardExpr());
  check("⑲f 重置：清掉状态筛选（地址回 #/projects、张数还原）、chip 全部取消选中",
    resetClicked === true && typeof resetHash === "string" && resetHash.indexOf("filter[status]") === -1 && resetCards.length === dbTotal && (await ev("(function(){var bs=document.querySelectorAll(" + j("[data-status-section] [data-chip]") + ");for(var i=0;i<bs.length;i+=1){if(bs[i].getAttribute(" + j("aria-pressed") + ")===" + j("true") + "){return false;}}return true;})()")) === true,
    JSON.stringify({ hash: resetHash, cards: resetCards.length, total: dbTotal }));

  // ---------- ⑤ter 编辑项目弹窗：滚动隔离（卡片外滚轮不带动后方项目页）+ 内容可滚 ----------
  await page.send("Emulation.setDeviceMetricsOverride", { width: 1500, height: 620, deviceScaleFactor: 1, mobile: false });
  await sleep(500);
  const openedShort = await openEditFor(TARGET_CODE);
  await sleep(800);
  const modalScroll = await ev(modalScrollExpr());
  await ev("(function(){var d=document.querySelector(" + j(editDialogSel) + ");if(d===null){return false;}var v=d.querySelector(" + j("[data-scroll-area=vertical]") + ");if(v===null){return false;}v.scrollTop=0;return true;})()");
  const pageYBefore = Number(await ev("window.scrollY"));
  const outsidePoint = await ev("(function(){var d=document.querySelector(" + j(editDialogSel) + ");if(d===null){return null;}var r=d.getBoundingClientRect();return {x:Math.max(10,Math.round(r.left-48)),y:Math.round(window.innerHeight/2)};})()");
  if (outsidePoint !== null && outsidePoint !== undefined) {
    await page.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: outsidePoint.x, y: outsidePoint.y, deltaX: 0, deltaY: 220 });
  }
  await sleep(500);
  const afterOutside = await ev("(function(){var d=document.querySelector(" + j(editDialogSel) + ");var v=d===null?null:d.querySelector(" + j("[data-scroll-area=vertical]") + ");return {pageY:window.scrollY,scrollTop:v===null?-1:v.scrollTop,locked:String(document.documentElement.style.overflow)};})()");
  await ev("(function(){var d=document.querySelector(" + j(editDialogSel) + ");if(d===null){return false;}var v=d.querySelector(" + j("[data-scroll-area=vertical]") + ");if(v===null){return false;}v.scrollTop=0;return true;})()");
  const insidePoint = await ev("(function(){var d=document.querySelector(" + j(editDialogSel) + ");if(d===null){return null;}var r=d.getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+140)};})()");
  if (insidePoint !== null && insidePoint !== undefined) {
    await page.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: insidePoint.x, y: insidePoint.y, deltaX: 0, deltaY: 180 });
  }
  await sleep(500);
  const afterInside = await ev("(function(){var d=document.querySelector(" + j(editDialogSel) + ");var v=d===null?null:d.querySelector(" + j("[data-scroll-area=vertical]") + ");return {pageY:window.scrollY,scrollTop:v===null?-1:v.scrollTop};})()");
  const modalShotScroll = await shot("project-modal-scroll", { x: 380, y: 0, width: 740, height: 620, scale: 1 });
  console.log("截图：" + modalShotScroll);
  check("⑳ 编辑弹窗滚动隔离（620px 视口）：卡片外滚轮只滚弹窗、后方项目页不动（window.scrollY 不变）、根元素锁滚动；卡片内滚轮同样只滚弹窗；弹窗不越界、底栏在视口内",
    openedShort === true && modalScroll !== null && modalScroll.top >= -1 && modalScroll.bottom <= modalScroll.viewport + 1 && modalScroll.overflowY === "auto" && modalScroll.scrollHeight > modalScroll.clientHeight && afterOutside.locked === "hidden" && afterOutside.pageY === pageYBefore && afterOutside.scrollTop > 0 && afterInside.pageY === pageYBefore && afterInside.scrollTop > 0 && afterInside.scrollTop <= afterOutside.scrollTop && modalScroll.footerBottom <= modalScroll.viewport + 1,
    JSON.stringify({ modal: modalScroll, pageYBefore: pageYBefore, outside: afterOutside, inside: afterInside }));
  await clickByText(editDialogSel + " button", "取消");
  await waitFor("document.querySelector(" + j(editDialogSel) + ") === null", 8000);
  await sleep(500);
  const unlocked = String(await ev("document.documentElement.style.overflow"));
  const pageYBeforeWheel = Number(await ev("window.scrollY"));
  await page.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: 400, y: 300, deltaX: 0, deltaY: 300 });
  await sleep(500);
  const pageYAfterWheel = Number(await ev("window.scrollY"));
  check("⑳b 关闭弹窗后解锁：根元素 overflow 复原、页面滚轮恢复（后方项目页可继续滚）",
    unlocked !== "hidden" && pageYAfterWheel > pageYBeforeWheel,
    JSON.stringify({ unlocked: unlocked, before: pageYBeforeWheel, after: pageYAfterWheel }));
  await page.send("Emulation.setDeviceMetricsOverride", { width: 1500, height: 1000, deviceScaleFactor: 1, mobile: false });
  await sleep(400);
  // ---------- ⑥ 控制台 ----------
  const archiveGateNoise = consoleErrors.filter((item) => item.text.indexOf("Failed to load resource") === 0 && item.text.indexOf("409") !== -1 && item.url.indexOf("/archive") !== -1);
  const realErrors = consoleErrors.filter((item) => archiveGateNoise.indexOf(item) === -1);
  check("⑰ 控制台零报错 / 零异常（归档门禁故意触发的 409 网络日志 " + String(archiveGateNoise.length) + " 条已豁免）", realErrors.length === 0, realErrors.slice(0, 3).map((item) => item.text).join(" ;; "));
} catch (error) {
  check("⑰-异常 流程异常中止：" + String(error !== null && error !== undefined && error.message !== undefined ? error.message : error), false);
} finally {
  await db.query("update projects set status = $2, updated_at = now() where id = $1 and status <> $2", [target.id, "active"]);
  await db.query("update projects set description = $2, updated_at = now() where id = $1 and description is distinct from $2", [target.id, targetDesc0]);
  await cleanupThrowProject();
  await db.query("update sessions set revoked_at = now() where token_hash = $1", [sha256(token)]);
  // 首页本地记忆（筛选 / 侧栏开合）清掉：本轮回放点过状态 chip，避免下一轮不带参数进入时恢复出筛选
  try { await ev("(function(){try{window.localStorage.removeItem(" + j("libiaolink.home.prefs.v1") + ");return true;}catch(error){return false;}})()"); } catch (error) { }
}

// ---------- ⑦ 收尾 ----------
const residue = (await db.query("select (select count(*)::int from projects where id = $1) as throw_projects, (select count(*)::int from tasks where project_id = $1) as throw_tasks, (select count(*)::int from project_stages where project_id = $1) as throw_stages, (select count(*)::int from project_archives where project_id = $1) as throw_archives, (select count(*)::int from sessions where token_hash = $2 and revoked_at is null) as sessions", [throwId, sha256(token)])).rows[0];
const targetFinal = (await projectRowOf(target.id)).status;
const targetDescFinal = (await db.query("select description from projects where id = $1", [target.id])).rows[0].description;
check("⑱ 零残留：抛荒项目业务表全 0 行、目标项目状态还原 active + 备注还原、临时会话已撤销",
  Number(residue.throw_projects) === 0 && Number(residue.throw_tasks) === 0 && Number(residue.throw_stages) === 0 && Number(residue.throw_archives) === 0 && Number(residue.sessions) === 0 && targetFinal === "active" && targetDescFinal === targetDesc0,
  JSON.stringify({ residue: residue, target: targetFinal, desc: targetDescFinal }));
const failed = checks.filter((item) => item.ok !== true).length;
console.log("—— 合计 " + String(checks.length) + " 项：" + String(checks.length - failed) + " 通过 / " + String(failed) + " 失败 ——");
try { page.ws.close(); } catch (error) { }
chrome.kill();
await db.end();
process.exit(failed === 0 ? 0 : 1);
