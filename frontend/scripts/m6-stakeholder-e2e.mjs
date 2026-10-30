#!/usr/bin/env node
/**
 * LibiaoLink 前端 · 回放：项目详情「干系人」标签接真（Push 221 · A27 / M6-06 前端接线；Push 222 口径修订：表单不录具体公司名 / 编辑只走行尾按钮；Push 225 代 wmj 线扩契约：新增「干系人角色」列（role）—— 列表 / 表单 / 落库 / 脱敏边界一并实证）
 *
 * 前置（都在本机跑着）：
 *   1. 前端 dev：cd frontend && npm run dev（默认 3000）
 *   2. api：cd server && npm run start:api（默认 3001）
 *   3. 数据库：本地沙箱 PG（默认 127.0.0.1:5433/libiaolink）
 *   4. 本机装了 Chrome（脚本 headless 起一个调试实例；路径可用 CHROME_PATH 覆盖）
 *
 * 用法：node scripts/m6-stakeholder-e2e.mjs
 *   可覆盖的环境变量：FRONTEND_BASE / API_BASE / DATABASE_URL / CHROME_PATH / CDP_PORT / REPLAY_USER / PG_MODULE
 *
 * 它做什么：用一条**临时会话**（跑完撤销）+ 一个**临时项目**（跑完物理删、零残留）在真机浏览器里跑一遍
 * 「干系人」标签接真后的读写口径 ——
 *   ① 项目详情导航栏共 7 个标签：「干系人」为第 6 个、其后固定为「项目文件」；「干系人」走地址 ?view=stakeholders；
 *   ② 表格口径：9 列表头（含「干系人角色」）/ 只列本项目关联（A5-03 反查；未关联的不出现）/ 电话 / 公司分类徽标 / 填写者 / 点击行体不进入编辑（Push 222：编辑只走行尾「编辑」按钮）；
 *   ③ 新建（UI 表单）：落库 + 自动关联本项目（A5-03 projectIds）；
 *   ④ 编辑（PATCH 部分更新）：改职务 + 清空微信（null 落库）；
 *   ⑤ 删除二次确认（第一下只开口）→ 软删（deleted_at 置位 + 读面 404 + 行消失）；
 *   ⑥ 收尾：物理删临时项目 / 撤销会话 / 硬删测试行 → 零残留。
 * 证据：docs/m6-回放证据(干系人台账·前端).md
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
const PORT = Number(process.env.CDP_PORT ?? 9412);
const DB = process.env.DATABASE_URL ?? "postgres://libiaolink_api@127.0.0.1:5433/libiaolink";
const REPLAY_USER = process.env.REPLAY_USER ?? "px-replay";
const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const Q = String.fromCharCode(34);
const j = (value) => JSON.stringify(value);

const db = new Client({ connectionString: DB });
await db.connect();
const userRow = (await db.query("select id, username, display_name from users where username = $1 and status = 'active'", [REPLAY_USER])).rows[0];
if (userRow === undefined) {
  console.error("回放用户不存在：" + REPLAY_USER);
  process.exit(1);
}
const token = "pxm6sh-" + randomBytes(16).toString("hex");
const csrf = randomBytes(16).toString("hex");
await db.query("insert into sessions (token_hash, user_id, id_token, expires_at) values ($1, $2, $3, now() + make_interval(mins => 30))", [sha256(token), userRow.id, "px-m6-stakeholder-e2e"]);
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

// ---------- 清场：上一轮崩在中途留下的同名临时项目 / 测试干系人 ----------
const staleProjects = (await db.query("select id from projects where code like $1 and deleted_at is null", ["PX-M6SH-%"])).rows;
for (const row of staleProjects) {
  const staleRow = await api("/api/v1/projects/" + row.id);
  if (staleRow.json === null) continue;
  const gone = await api("/api/v1/projects/" + row.id, "DELETE", undefined, { "If-Match": String(staleRow.json.version) });
  console.log("清场：删残留临时项目 " + row.id + " → " + String(gone.status));
}
const staleStakeholders = (await db.query("select id from stakeholders where name like $1", ["回放·干系人%"])).rows;
for (const row of staleStakeholders) {
  await db.query("delete from project_stakeholders where stakeholder_id = $1", [row.id]);
  await db.query("delete from stakeholders where id = $1", [row.id]);
}
console.log("清场：硬删残留测试干系人 " + String(staleStakeholders.length) + " 行");

// ---------- 夹具：临时项目 + 两位干系人（甲关联本项目、乙不关联） ----------
const fixtureCode = "PX-M6SH-" + randomBytes(3).toString("hex").toUpperCase();
const projRes = await api("/api/v1/projects", "POST", { code: fixtureCode, name: "M6回放·干系人接真", description: "M6回放·干系人接真", managerIds: [userRow.id] });
check("夹具：建临时项目（201）", projRes.status === 201, String(projRes.status) + " " + projRes.text.slice(0, 140));
const projectId = projRes.json === null ? "" : projRes.json.id;

const linkedRes = await api("/api/v1/stakeholders", "POST", { name: "回放·干系人甲", companyType: "libiao", company: "立镖机器人（回放）", title: "现场项目经理", role: "决策人", phone: "+86 138 0000 0001", wechat: "px-replay-jia", email: "jia@example.com", projectIds: [projectId] });
check("夹具：建干系人甲（关联本项目 · 201 · 角色落库）", linkedRes.status === 201 && linkedRes.json !== null && linkedRes.json.projects.length === 1 && linkedRes.json.role === "决策人", String(linkedRes.status) + " " + linkedRes.text.slice(0, 140));
const jia = linkedRes.json;

const looseRes = await api("/api/v1/stakeholders", "POST", { name: "回放·干系人乙", companyType: "customer" });
check("夹具：建干系人乙（不关联本项目 · 201）", looseRes.status === 201, String(looseRes.status) + " " + looseRes.text.slice(0, 140));
const yi = looseRes.json;

const listOfProject = () => api("/api/v1/stakeholders?filter[projectId]=" + projectId + "&limit=200");
const listRes = await listOfProject();
check("夹具：filter[projectId] 只回本项目关联的 1 位（甲出现 / 乙不出现）", listRes.status === 200 && listRes.json.total === 1 && listRes.json.items[0].id === jia.id, JSON.stringify({ status: listRes.status, total: listRes.json === null ? null : listRes.json.total }));

// ---------- 无头 Chrome（CDP）：真机浏览器里点标签 / 填表单 / 点按钮 ----------
const profile = mkdtempSync(join(tmpdir(), "pxm6sh-"));
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
await page.send("Log.enable");
const setCookie = async (sid, csfr) => {
  await page.send("Network.setCookie", { name: "ll_sid", value: sid, url: FRONTEND + "/", path: "/", httpOnly: true, secure: false });
  await page.send("Network.setCookie", { name: "ll_csrf", value: csfr, url: FRONTEND + "/", path: "/", httpOnly: false, secure: false });
};
await setCookie(token, csrf);
await page.send("Emulation.setDeviceMetricsOverride", { width: 1500, height: 1000, deviceScaleFactor: 1, mobile: false });
await page.send("Emulation.setFocusEmulationEnabled", { enabled: true });

const LF = String.fromCharCode(10);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ev = async (expression) => {
  const reply = await page.send("Runtime.evaluate", { expression, returnByValue: true });
  if (reply.exceptionDetails !== undefined) throw new Error("页面表达式抛异常：" + JSON.stringify(reply.exceptionDetails).slice(0, 300) + " | " + expression.slice(0, 160));
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
async function openStakeholders(base = FRONTEND) {
  await page.send("Page.navigate", { url: "about:blank" });
  await sleep(400);
  await page.send("Page.navigate", { url: base + "/#/project/" + projectId + "?view=stakeholders" });
  await sleep(4800);
}
async function rectOf(selector) {
  return await ev("(() => { const node = document.querySelector(" + j(selector) + ");"
    + " if (node === null) { return null; }"
    + " node.scrollIntoView({ block: " + j("center") + ", inline: " + j("nearest") + " });"
    + " const box = node.getBoundingClientRect();"
    + " if (box.width === 0 || box.height === 0) { return null; }"
    + " return { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) }; })()");
}
async function clickAt(point) {
  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y, button: "none" });
  await page.send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1 });
  await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1 });
  await sleep(500);
}
async function clickSelector(selector) {
  const point = await rectOf(selector);
  if (point === null || point === undefined) throw new Error("点不到（元素不存在或不可见）：" + selector);
  await clickAt(point);
  return point;
}
async function pressKey(key, code, vk, modifiers = 0) {
  await page.send("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers });
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers });
  await sleep(260);
}
async function typeInto(selector, text) {
  await clickSelector(selector);
  await pressKey("a", "KeyA", 65, 2);
  const parts = String(text).split(LF);
  for (let i = 0; i < parts.length; i += 1) {
    if (i > 0) {
      await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: String.fromCharCode(13), unmodifiedText: String.fromCharCode(13) });
      await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
      await sleep(160);
    }
    await page.send("Input.insertText", { text: parts[i] });
    await sleep(160);
  }
  await sleep(360);
}
/** 拿不到关键回包就直接收摊（避免后续断言连坐崩溃）。 */
async function bail(message) {
  console.log("中止：" + message);
  checks.push(false);
  try { page.ws.close(); } catch (error) { /* 忽略 */ }
  chrome.kill();
  await db.end();
  process.exit(1);
}

/** 主标签栏探针：数量 / 顺序 / 最后一枚 / 选中态。 */
const TABS_PROBE = "(function(){var tabs=document.querySelectorAll(" + j("[data-maintabs-item]") + ");"
  + "var names=[];for(var i=0;i<tabs.length;i++){names.push(tabs[i].textContent.trim());}"
  + "var last=tabs.length>0?tabs[tabs.length-1]:null;"
  + "var stakeholder=null;for(var i=0;i<tabs.length;i++){if(tabs[i].textContent.trim()===" + Q + "干系人" + Q + "){stakeholder=tabs[i];}}"
  + "return {count:tabs.length,names:names.join(" + Q + "/" + Q + "),last:last===null?" + Q + Q + ":last.textContent.trim(),lastCurrent:last===null?null:last.getAttribute(" + Q + "aria-current" + Q + "),stakeholderCurrent:stakeholder===null?null:stakeholder.getAttribute(" + Q + "aria-current" + Q + ")};})()";

/** 「干系人」表格探针：表头 / 行 / 计数 / 写入口 / 底部滑块。 */
const TABLE_PROBE = "(function(){var t=document.querySelector(" + j("[data-stakeholder-table]") + ");"
  + "if(t===null){return {has:false};}"
  + "var head=t.querySelector(" + j("[data-stakeholder-head]") + ");"
  + "var cols=[];if(head!==null){var cs=head.querySelectorAll(" + j("[data-column]") + ");for(var i=0;i<cs.length;i++){cols.push(cs[i].textContent.trim());}}"
  + "var rows=t.querySelectorAll(" + j("[data-stakeholder-row]") + ");var ids=[];for(var k=0;k<rows.length;k++){ids.push(rows[k].getAttribute(" + Q + "data-stakeholder-row" + Q + "));}"
  + "var totalEl=document.querySelector(" + j("[data-stakeholder-total]") + ");"
  + "return {has:true,cols:cols.join(" + Q + "|" + Q + "),rowCount:rows.length,ids:ids.join(" + Q + "," + Q + "),"
  + "newButton:document.querySelector(" + j("[data-stakeholder-new]") + ")!==null,"
  + "bar:document.querySelector(" + j("#table-scrollbar-bar") + ")!==null,"
  + "total:totalEl===null?null:totalEl.textContent.trim()};})()";

/** 某行探针：各单元格文本 + 行尾动作 + role。 */
function rowProbe(id) {
  return "(function(){var r=document.querySelector(" + j("[data-stakeholder-row=" + Q + id + Q + "]") + ");"
    + "if(r===null){return {has:false};}"
    + "var out={has:true,role:r.getAttribute(" + Q + "role" + Q + ")};"
    + "var keys=[" + ["name","phone","wechat","email","title","company","createdBy"].map(j).join(",") + "];"
    + "for(var i=0;i<keys.length;i++){var c=r.querySelector(" + j("[data-stakeholder-cell=") + "+keys[i]+" + j("]") + ");out[keys[i]]=c===null?null:c.textContent.trim();}"
    + "var rc=r.querySelector(" + j("[data-stakeholder-cell=role]") + ");out.roleText=rc===null?null:rc.textContent.trim();"
    + "out.edit=r.querySelector(" + j("[data-stakeholder-edit-slot] button") + ")!==null;"
    + "out.del=r.querySelector(" + j("[data-stakeholder-delete-slot] button") + ")!==null;"
    + "return out;})()";
}

/** 下拉浮层里按文案点一枚选项（公司分类四值）。 */
async function clickOptionByText(text) {
  const point = await ev("(function(){var list=document.querySelector(" + j("[data-select-popover]") + ");if(list===null){return null;}"
    + "var items=list.querySelectorAll(" + j("[role=option]") + ");"
    + "for(var i=0;i<items.length;i++){if(items[i].textContent.trim()===" + j(text) + "){items[i].scrollIntoView({block:" + j("center") + "});var r=items[i].getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};}}return null;})()");
  if (point === null || point === undefined) throw new Error("选不到选项：" + text);
  await clickAt(point);
}
/** 清空输入框（点击 → 全选 → Delete）。 */
async function clearField(selector) {
  await clickSelector(selector);
  await pressKey("a", "KeyA", 65, 2);
  await pressKey("Delete", "Delete", 46);
}

// ---------- ① 项目总览 → 点第 6 个「干系人」标签（第 7 个固定为「项目文件」） ----------
await page.send("Page.navigate", { url: "about:blank" });
await sleep(400);
await page.send("Page.navigate", { url: FRONTEND + "/#/project/" + projectId });
await sleep(4800);
const tabsBefore = await ev(TABS_PROBE);
check("①a 导航栏共 7 个标签、「干系人」为第 6 个、最右侧为「项目文件」", tabsBefore.count === 7 && tabsBefore.names.split("/")[5] === "干系人" && tabsBefore.last === "项目文件", JSON.stringify({ count: tabsBefore.count, names: tabsBefore.names }));
await clickSelector("[data-maintabs-item=" + Q + "干系人" + Q + "]");
const hashNow = await ev("window.location.hash");
const tabsAfter = await ev(TABS_PROBE);
check("①b 点「干系人」= 地址切到 ?view=stakeholders 且为选中态", String(hashNow).indexOf("view=stakeholders") >= 0 && tabsAfter.stakeholderCurrent === "page", JSON.stringify({ hash: hashNow, current: tabsAfter.stakeholderCurrent }));
const tableReady = await waitFor("document.querySelector(" + j("[data-stakeholder-table]") + ") !== null", 12000);
if (tableReady !== true) { await bail("干系人表格没出来"); }

// ---------- ② 表格口径（只列本项目关联 / 8 列 / 底部滑块） ----------
const table = await ev(TABLE_PROBE);
check("②a 表头 9 列（姓名 / 电话 / 微信 / 邮箱 / 职务 / 所属公司 / 填写者 / 干系人角色 / 动作）", table.has === true && table.cols === "干系人姓名|电话 / WhatsApp|微信|邮箱 Email|职务 / 责任板块|所属公司|填写者|干系人角色|", JSON.stringify({ cols: table.cols }));
check("②b 只列本项目关联：1 行（乙不出现）+ 计数 1 + 底部滑块在位", table.rowCount === 1 && table.ids === jia.id && table.total === "1" && table.bar === true, JSON.stringify({ rows: table.rowCount, total: table.total, bar: table.bar }));
const jiaRow = await ev(rowProbe(jia.id));
check("②c 行内容：姓名 / 电话 / 微信 / 邮箱 / 职务 / 公司分类徽标 + 存量公司名（只读）/ 填写者 / 干系人角色",
  jiaRow.name === "回放·干系人甲" && jiaRow.phone === "+86 138 0000 0001" && jiaRow.wechat === "px-replay-jia" && jiaRow.email === "jia@example.com" && jiaRow.title === "现场项目经理" && jiaRow.company.indexOf("立镖机器人") >= 0 && jiaRow.company.indexOf("立镖机器人（回放）") >= 0 && jiaRow.createdBy.indexOf("潘兴") >= 0 && jiaRow.roleText === "决策人" && jiaRow.role === null && jiaRow.edit === true && jiaRow.del === true,
  JSON.stringify(jiaRow));
// ②d 点击行体不进入编辑（Push 222 业务口径：编辑只走行尾「编辑」按钮）
const bodyPoint = await ev("(function(){var r=document.querySelector(" + j("[data-stakeholder-row=" + Q + jia.id + Q + "]") + ");if(r===null){return null;}var c=r.querySelector(" + j("[data-stakeholder-cell=name]") + ");var box=(c===null?r:c).getBoundingClientRect();return {x:Math.round(box.left+box.width/2),y:Math.round(box.top+box.height/2)};})()");
await clickAt(bodyPoint);
await sleep(700);
const modalAfterBodyClick = await ev("document.querySelector(" + j("[data-stakeholder-modal]") + ") !== null");
check("②d 点行体不进入编辑（Push 222：编辑只走行尾按钮）", modalAfterBodyClick === false, String(modalAfterBodyClick));

// ---------- ③ 新建（UI 表单）：落库 + 自动关联本项目 ----------
await clickSelector("[data-stakeholder-new]");
const modalOpen = await waitFor("document.querySelector(" + j("[data-stakeholder-modal]") + ") !== null", 5000);
const modalFields = await ev("(function(){return {open:document.querySelector(" + j("[data-stakeholder-modal]") + ")!==null,hasCompanyField:document.querySelector(" + j("[data-stakeholder-field=company]") + ")!==null,hasRoleField:document.querySelector(" + j("[data-stakeholder-field=role]") + ")!==null};})()");
check("③a 点「新建干系人」= 弹窗打开、有「干系人角色」字段（Push 225）、且无「具体公司名称」字段（Push 222）", modalOpen === true && modalFields.open === true && modalFields.hasRoleField === true && modalFields.hasCompanyField === false, JSON.stringify(modalFields));
await typeInto("[data-stakeholder-field=name]", "回放·干系人丙");
await clickSelector("[data-stakeholder-field=companyType] button");
await sleep(400);
await clickOptionByText("客户");
await typeInto("[data-stakeholder-field=title]", "采购经理");
await typeInto("[data-stakeholder-field=phone]", "+86 139 0000 0002");
await typeInto("[data-stakeholder-field=wechat]", "px-replay-bing");
await typeInto("[data-stakeholder-field=email]", "bing@example.com");
await typeInto("[data-stakeholder-field=role]", "采购接口人");
await clickSelector("[data-stakeholder-submit]");
const modalClosed = await waitFor("document.querySelector(" + j("[data-stakeholder-modal]") + ") === null", 12000);
const tableAfterCreate = await ev(TABLE_PROBE);
check("③b 提交后弹窗关闭、表格 2 行、计数 2", modalClosed === true && tableAfterCreate.rowCount === 2 && tableAfterCreate.total === "2", JSON.stringify({ closed: modalClosed, rows: tableAfterCreate.rowCount, total: tableAfterCreate.total }));
const listAfterCreate = await listOfProject();
const bing = listAfterCreate.json.items.filter((row) => row.name === "回放·干系人丙")[0];
check("③c 落库：分类 customer / 关联本项目 / 填写者 = 潘兴 / 角色落库 / 联系方式齐全",
  bing !== undefined && bing.companyType === "customer" && bing.projects.length === 1 && bing.projects[0].id === projectId && bing.createdByName === userRow.display_name && bing.company === null && bing.phone === "+86 139 0000 0002" && bing.email === "bing@example.com" && bing.role === "采购接口人",
  JSON.stringify(bing === undefined ? null : { companyType: bing.companyType, projects: bing.projects.length, createdByName: bing.createdByName, company: bing.company, phone: bing.phone }));
const bingRow0 = await ev(rowProbe(bing.id));
check("③d 表格行同步：分类徽标「客户」（表单不录具体公司名）+ 电话 / 邮箱 / 职务 / 干系人角色", bingRow0.company === "客户" && bingRow0.phone === "+86 139 0000 0002" && bingRow0.title === "采购经理" && bingRow0.email === "bing@example.com" && bingRow0.roleText === "采购接口人", JSON.stringify(bingRow0));

// ---------- ④ 编辑（PATCH 部分更新：改职务 + 清空微信 = null） ----------
await clickSelector("[data-stakeholder-row=" + Q + bing.id + Q + "] [data-stakeholder-edit-slot] button");
const editOpen = await waitFor("document.querySelector(" + j("[data-stakeholder-modal]") + ") !== null", 5000);
const prefill = await ev("(function(){var t=document.querySelector(" + j("[data-stakeholder-field=title]") + ");var w=document.querySelector(" + j("[data-stakeholder-field=wechat]") + ");var ro=document.querySelector(" + j("[data-stakeholder-field=role]") + ");return {title:t===null?null:t.value,wechat:w===null?null:w.value,role:ro===null?null:ro.value};})()");
check("④a 点行尾编辑 = 弹窗带出原值（职务 / 微信 / 干系人角色预填）", editOpen === true && prefill.title === "采购经理" && prefill.wechat === "px-replay-bing" && prefill.role === "采购接口人", JSON.stringify(prefill));
await typeInto("[data-stakeholder-field=title]", "采购负责人");
await clearField("[data-stakeholder-field=wechat]");
await typeInto("[data-stakeholder-field=role]", "采购决策人");
await clickSelector("[data-stakeholder-submit]");
const editClosed = await waitFor("document.querySelector(" + j("[data-stakeholder-modal]") + ") === null", 12000);
const listAfterEdit = await listOfProject();
const bingEdited = listAfterEdit.json.items.filter((row) => row.id === bing.id)[0];
check("④b 编辑落库：职务 = 采购负责人、微信清空为 null、干系人角色 = 采购决策人、updatedAt 前进",
  editClosed === true && bingEdited !== undefined && bingEdited.title === "采购负责人" && bingEdited.wechat === null && bingEdited.role === "采购决策人" && bingEdited.updatedAt !== bing.updatedAt,
  JSON.stringify({ title: bingEdited === undefined ? null : bingEdited.title, wechat: bingEdited === undefined ? null : bingEdited.wechat, updated: bingEdited === undefined ? false : bingEdited.updatedAt !== bing.updatedAt }));
const bingRow1 = await ev(rowProbe(bing.id));
check("④c 表格行同步：职务新值 + 微信占位「—」+ 干系人角色新值", bingRow1.title === "采购负责人" && bingRow1.wechat === "—" && bingRow1.roleText === "采购决策人", JSON.stringify({ title: bingRow1.title, wechat: bingRow1.wechat, roleText: bingRow1.roleText }));

// ---------- ⑤ 删除二次确认 → 软删 ----------
await clickSelector("[data-stakeholder-row=" + Q + bing.id + Q + "] [data-stakeholder-delete-slot] button");
const stripShown = await waitFor("document.querySelector(" + j("[data-delete-confirm-strip]") + ") !== null", 5000);
await sleep(400);
const stripPos = await ev("(function(){var el=document.querySelector(" + j("[data-delete-confirm-strip]") + ");if(el===null){return null;}var r=el.getBoundingClientRect();return {top:Math.round(r.top),cls:String(el.className)};})()");
const stillThere = await ev("document.querySelector(" + j("[data-stakeholder-row=" + Q + bing.id + Q + "]") + ") !== null");
check("⑤a 第一下删除 = 只出顶部同款确认 Toast、不真删", stripShown === true && stripPos !== null && stripPos.top <= 48 && String(stripPos.cls).indexOf("ll-toast-top") >= 0 && stillThere === true, JSON.stringify({ strip: stripShown, pos: stripPos, row: stillThere }));
await clickSelector("[data-delete-confirm]");
const rowGone = await waitFor("document.querySelector(" + j("[data-stakeholder-row=" + Q + bing.id + Q + "]") + ") === null", 12000);
const goneRead = await api("/api/v1/stakeholders/" + bing.id);
const softRow = (await db.query("select deleted_at from stakeholders where id = $1", [bing.id])).rows[0];
check("⑤b 第二下真删：行消失 + 读面 404 + 库内软删（deleted_at 置位）", rowGone === true && goneRead.status === 404 && softRow !== undefined && softRow.deleted_at !== null, JSON.stringify({ gone: goneRead.status, deletedAt: String(softRow === undefined ? null : softRow.deleted_at) }));
const tableAfterDelete = await ev(TABLE_PROBE);
check("⑤c 删除后表格回到 1 行、计数 1", tableAfterDelete.rowCount === 1 && tableAfterDelete.total === "1", JSON.stringify({ rows: tableAfterDelete.rowCount, total: tableAfterDelete.total }));

// ---------- ⑦ 收尾：物理删临时项目 + 撤销会话 + 硬删测试行 → 零残留 ----------
const projRow = await api("/api/v1/projects/" + projectId);
const delProj = await api("/api/v1/projects/" + projectId, "DELETE", undefined, { "If-Match": String(projRow.json.version) });
check("⑦a 删临时项目（物理删 · 200 / 204）", delProj.status === 200 || delProj.status === 204, String(delProj.status) + " " + delProj.text.slice(0, 120));
const projGone = await api("/api/v1/projects/" + projectId);
check("⑦b 项目读面 404（物理删、行不存在）", projGone.status === 404, String(projGone.status));

const createdIds = [jia.id, yi.id, bing.id];
const tokenHashes = [sha256(token)];
await db.query("delete from project_stakeholders where stakeholder_id = any($1::uuid[])", [createdIds]);
await db.query("delete from stakeholders where id = any($1::uuid[])", [createdIds]);
await db.query("update sessions set revoked_at = now() where token_hash = $1", [sha256(token)]);
// audit_logs 只读不动（api 角色也无 DELETE 权）。

const residue = (await db.query("select (select count(*)::int from stakeholders where id = any($1::uuid[])) as stakeholders, (select count(*)::int from project_stakeholders where project_id = $2) as links, (select count(*)::int from projects where id = $2) as projects, (select count(*)::int from sessions where token_hash = any($3::text[]) and revoked_at is null) as sessions", [createdIds, projectId, tokenHashes])).rows[0];
check("⑦c 零残留：测试干系人 / 项目关联 / 项目 / 会话全 0 行",
  Number(residue.stakeholders) === 0 && Number(residue.links) === 0 && Number(residue.projects) === 0 && Number(residue.sessions) === 0,
  JSON.stringify(residue));

// ---------- 收尾 ----------
const failed = checks.filter((ok) => ok !== true).length;
console.log("—— 合计 " + String(checks.length) + " 项：" + String(checks.length - failed) + " 通过 / " + String(failed) + " 失败 ——");
const pageEvents = page.events.filter((line) => line.indexOf("EVT ") === 0);
console.log("页面控制台 / 异常：" + String(pageEvents.length) + " 条");
for (const line of pageEvents.slice(0, 8)) { console.log("  " + line.slice(0, 240)); }
try { page.ws.close(); } catch (error) { /* 忽略 */ }
chrome.kill();
await db.end();
process.exit(failed === 0 ? 0 : 1);
