#!/usr/bin/env node
/**
 * LibiaoLink 前端 · 回放：操作记录页（C7-04 管理员查询页 · u12）
 *
 * 业务口径（2026-10-08 / 09）：「点击右上角头像 退出登录下面加一个操作记录 可以看到所有人的操作记录 可以筛选」+「增加搜索功能」。
 *
 * 本脚本用真机浏览器（无头 Chrome + CDP）验：
 *   ① 头像菜单：「操作记录」在「退出登录」下方、href = #/audit（audit.view 画像在场才渲染）；
 *   ② 点入口 → 地址到 #/audit（缺省无 query）、页面就位；首屏 50 条封顶、时间倒序、右上角「共 N 条」；
 *   ③ 列口径：时间 YYYY-MM-DD HH:mm（Asia/Shanghai）、操作人姓名快照、动作 / 对象类型中文标签、结果签、项目码；
 *   ④ 筛选（地址即状态 · 多选追订「别的筛选也是同理 要支持多选」+「操作记录里面也是」）：动作 = 修改 + 新增（2026-10-23：下拉含「访问」「预览」、撤「推进」「回退」—— 选项 10 项）
 *      （action=update,create，再点取消）、点选不关浮层、触发器 = 筛选名称 + 浅灰数量；结果 = 越权拒绝（result=denied）→ 行全为
 *      「越权拒绝」（再累加 成功 → result=denied,succeeded）；操作人 = 潘兴（actor=<id>，叠加 result=denied）→ 行操作人全为潘兴、计数 = 交集；时间 = 今天（from / to，Asia/Shanghai 含端点，
 *      请求串里 from = 当天 00:00:00+08 的 ISO，行数 = 库内「今日 ∩ 潘兴 ∩ 越权拒绝」交集对账 —— 当天无记录时断言空态，日期无关）；
 *   ⑤ 分页：下一页 → page=2（请求同步）、首行换行；
 *   ⑥ 清除筛选 → 地址回 #/audit、请求无筛选参数；
 *   ⑦ 关键字搜索（Push 260）：深链 #/audit?q=… 刷新直接打开同款；输入「定档」→ 250ms 防抖后地址 / 请求同步
 *      q=（page 重置 1）、计数与首屏 50 条 = 库内「摘要 ∪ 操作人姓名 ∪ 变化明细」三路命中逐一对账；
 *      无命中 → 空态 + 计数 0；清空（×）→ 地址回 #/audit、请求无 q=、首行还原；
 *   ⑧ 控制台零报错；跑完会话撤销、零残留（只读页，不写业务数据）。
 *
 * 前置（三件都在本机跑着）：
 *   1. 前端 dev：cd frontend && npm run dev（默认 3000）
 *   2. api：cd server && npm run start:api（默认 3001）
 *   3. 数据库：本地沙箱 PG（默认 127.0.0.1:5433/libiaolink）
 *   4. 本机装了 Chrome（headless；路径可用 CHROME_PATH 覆盖）
 *
 * 用法：node scripts/ui-audit-log-e2e.mjs
 *   可覆盖的环境变量：FRONTEND_BASE / DATABASE_URL / CHROME_PATH / CDP_PORT / REPLAY_USER / PG_MODULE / SHOT_DIR
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
const CHROME = process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PORT = Number(process.env.CDP_PORT ?? 9416);
const DB = process.env.DATABASE_URL ?? "postgres://libiaolink_api@127.0.0.1:5433/libiaolink";
const REPLAY_USER = process.env.REPLAY_USER ?? "px-replay";
const SHOTS = process.env.SHOT_DIR ?? join(tmpdir(), "px-audit-shots");
const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const j = (value) => JSON.stringify(value);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const checks = [];
const check = (name, ok, detail) => { checks.push({ name: name, ok: ok === true }); console.log((ok === true ? "  PASS  " : "  FAIL  ") + name + (ok === true || detail === undefined ? " " : "  —— " + detail)); };

mkdirSync(SHOTS, { recursive: true });
const db = new Client({ connectionString: DB });
await db.connect();
const userRow = (await db.query("select id, username, display_name from users where username = $1 and status = 'active'", [REPLAY_USER])).rows[0];
if (userRow === undefined) { console.error("回放用户不存在：" + REPLAY_USER); process.exit(1); }
const token = "pxaudit-" + randomBytes(16).toString("hex");
const csrf = randomBytes(16).toString("hex");
await db.query("insert into sessions (token_hash, user_id, id_token, expires_at) values ($1, $2, $3, now() + make_interval(mins => 30))", [sha256(token), userRow.id, "ui-audit-log-e2e"]);
console.log("临时会话：" + userRow.username + "（" + userRow.display_name + "）");

const profile = mkdtempSync(join(tmpdir(), "pxaudit-"));
const chrome = spawn(CHROME, ["--headless=new", "--remote-debugging-port=" + PORT, "--user-data-dir=" + profile, "--no-first-run", "--no-default-browser-check", "--disable-gpu", "about:blank"], { stdio: "ignore" });

async function waitTarget() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch("http://127.0.0.1:" + String(PORT) + "/json/list");
      const list = await res.json();
      const hit = list.find((item) => item.type === "page" && item.webSocketDebuggerUrl !== undefined);
      if (hit !== undefined) {
        return hit;
      }
    } catch (error) {
      // 调试端口还没起来：继续等
    }
    await sleep(400);
  }
  throw new Error("Chrome 调试端口未就绪");
}

class Cdp {
  constructor(url) {
    this.nextId = 0;
    this.pending = new Map();
    this.ws = new WebSocket(url);
    this.ready = new Promise((resolve, reject) => {
      this.ws.addEventListener("open", () => { resolve(); });
      this.ws.addEventListener("error", (error) => { reject(error); });
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
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error("cdp timeout: " + method)); }, 20000);
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
const consoleErrors = [];
const auditRequests = [];
page.ws.addEventListener("message", (event) => {
  const msg = JSON.parse(typeof event.data === "string" ? event.data : String(event.data));
  if (msg.method === "Log.entryAdded" && msg.params !== undefined && msg.params.entry !== undefined && msg.params.entry.level === "error") {
    consoleErrors.push(String(msg.params.entry.text));
  }
  if (msg.method === "Runtime.exceptionThrown") { consoleErrors.push("exceptionThrown"); }
  if (msg.method === "Runtime.consoleAPICalled" && msg.params !== undefined && msg.params.type === "error") {
    consoleErrors.push((msg.params.args ?? []).map((item) => String(item.value ?? item.description ?? " ")).join(" "));
  }
  if (msg.method === "Network.requestWillBeSent" && msg.params !== undefined && msg.params.request !== undefined && String(msg.params.request.url).indexOf("/api/v1/audit-logs") !== -1) {
    auditRequests.push(String(msg.params.request.url));
  }
});
await page.send("Network.setCookie", { name: "ll_sid", value: token, url: FRONTEND + "/", path: "/", httpOnly: true, secure: false });
await page.send("Network.setCookie", { name: "ll_csrf", value: csrf, url: FRONTEND + "/", path: "/", secure: false });
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
  await sleep(500);
}
async function clickSelector(selector) {
  const point = await ev("(function(){var b=document.querySelector(" + j(selector) + ");if(b===null){return null;}b.scrollIntoView({block:" + j("center") + ",inline:" + j("nearest") + "});var r=b.getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};})()");
  if (point === null || point === undefined) { return false; }
  await clickAt(point);
  return true;
}
async function pickOption(optionText) {
  const point = await ev("(function(){var p=document.querySelector(" + j("[data-select-popover]") + ");if(p===null){return null;}var os=p.querySelectorAll(" + j("[role=option]") + ");for(var i=0;i<os.length;i+=1){var o=os[i];if(String(o.textContent).trim()===" + j(optionText) + "){o.scrollIntoView({block:" + j("center") + "});var r=o.getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};}}return null;})()");
  if (point === null || point === undefined) { return false; }
  await clickAt(point);
  return true;
}
/** 触发器探针：筛选名称 / 浅灰数量（data-select-trigger-*）+ 浮层是否打开。 */
const triggerProbe = (selector) =>
  "(function(){var t=document.querySelector(" + j(selector) + ");var p=document.querySelector(" + j("[data-select-popover]") + ");return {label:t===null?null:t.getAttribute(" + j("data-select-trigger-label") + "),count:t===null?null:t.getAttribute(" + j("data-select-trigger-count") + "),open:p!==null};})()";
async function bail(message) {
  console.log("中止：" + message);
  checks.push({ name: "中止：" + message, ok: false });
  try { page.ws.close(); } catch (error) { /* 忽略 */ }
  chrome.kill();
  await db.end();
  process.exit(1);
}

const countOf = async (sql, params = []) => Number((await db.query(sql, params)).rows[0].n);
const totalAll = await countOf("select count(*)::int n from audit_logs");
const totalUpdate = await countOf("select count(*)::int n from audit_logs where action = $1", ["update"]);
const totalDenied = await countOf("select count(*)::int n from audit_logs where result = $1", ["denied"]);
const totalActor = await countOf("select count(*)::int n from audit_logs where actor_id = $1 and result = $2", [userRow.id, "denied"]);
const totalToday = await countOf("select count(*)::int n from audit_logs where actor_id = $1 and result = $2 and occurred_at >= (date_trunc($3, now() at time zone $4) at time zone $4)", [userRow.id, "denied", "day", "Asia/Shanghai"]);
console.log("库内计数：总 " + String(totalAll) + " / 修改 " + String(totalUpdate) + " / 越权拒绝 " + String(totalDenied) + " / 潘兴∩越权拒绝 " + String(totalActor) + " / 今日∩潘兴∩越权拒绝 " + String(totalToday));

const rowExpr = "(function(){var rows=document.querySelectorAll(" + j("[data-audit-row]") + ");var out=[];for(var i=0;i<rows.length;i+=1){var tr=rows[i];var tds=tr.querySelectorAll(" + j("td") + ");var chip=tr.querySelector(" + j("[data-audit-action]") + ");var res=tr.querySelector(" + j("[data-audit-result]") + ");var chs=tr.querySelectorAll(" + j("[data-audit-change]") + ");out.push({id:tr.getAttribute(" + j("data-audit-row") + "),time:String(tds[0].textContent).trim(),actor:String(tds[1].textContent).trim(),action:chip===null?null:chip.getAttribute(" + j("data-audit-action") + "),actionText:chip===null?null:String(chip.textContent).trim(),object:String(tds[3].textContent).trim(),result:res===null?null:res.getAttribute(" + j("data-audit-result") + "),resultText:res===null?null:String(res.textContent).trim(),project:String(tds[6].textContent).trim(),summary:String(tds[4].textContent).trim(),changeCount:chs.length});}var count=document.querySelector(" + j("[data-audit-count]") + ");var info=document.querySelector(" + j("[data-audit-page-info]") + ");var empty=document.querySelector(" + j("[data-audit-empty]") + ");return {rows:out,rowCount:rows.length,count:count===null?null:String(count.textContent).trim(),pageInfo:info===null?null:String(info.textContent).trim(),empty:empty===null?null:String(empty.textContent).trim(),hash:window.location.hash};})()";
const timeOk = (value) => value.length === 16 && value.charAt(4) === "-" && value.charAt(7) === "-" && value.charAt(10) === " " && value.charAt(13) === ":";
const lastReq = () => auditRequests.length === 0 ? "" : auditRequests[auditRequests.length - 1];
const dayText = (iso) => { const d = new Date(iso); return String(d.getFullYear()) + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); };
const todayKey = dayText(new Date().toISOString());

await page.send("Emulation.setDeviceMetricsOverride", { width: 1500, height: 1000, deviceScaleFactor: 1, mobile: false });
await page.send("Page.navigate", { url: "about:blank" });
await sleep(300);
await page.send("Page.navigate", { url: FRONTEND + "/#/" });
let hubReady = false;
for (let i = 0; i < 50 && hubReady !== true; i += 1) {
  hubReady = (await ev("document.querySelector(" + j("[data-topnav]") + ") !== null")) === true;
  if (hubReady !== true) { await sleep(400); }
}
await sleep(1200);

// 登录后不再自动弹企微绑定浮卡；若出现即视为回归（并会挡住头像菜单）。
if ((await ev("document.querySelector(" + j("[data-wecom-binding-guide]") + ") !== null")) === true) {
  await bail("登录后不应再自动出现企微绑定浮卡");
}

// ① 头像菜单：「操作记录」在「退出登录」下方（audit.view 画像在场）
const avatarPoint = await ev("(function(){var b=document.querySelector(" + j("[data-account-trigger]") + ");if(b===null){return null;}var r=b.getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};})()");
if (avatarPoint === null || avatarPoint === undefined) { await bail("头像按钮找不到"); }
await clickAt(avatarPoint);
let menuReady = await waitFor("document.querySelector(" + j("[data-account-audit]") + ") !== null", 8000);
if (menuReady !== true) { await bail("头像菜单里没有「操作记录」入口"); }
const menuInfo = await ev("(function(){var a=document.querySelector(" + j("[data-account-audit]") + ");var box=a.parentElement;var items=box.querySelectorAll(" + j("[role=menuitem]") + ");var list=[];for(var i=0;i<items.length;i+=1){var it=items[i];var r=it.getBoundingClientRect();list.push({text:String(it.textContent).trim(),href:it.getAttribute(" + j("href") + "),y:Math.round(r.top),h:Math.round(r.height)});}var ra=a.getBoundingClientRect();return {items:list,auditText:String(a.textContent).trim(),auditHref:a.getAttribute(" + j("href") + "),auditY:Math.round(ra.top)};})()");
const menuShot = await shot("audit-menu", { x: 900, y: 0, width: 600, height: 220, scale: 1 });
console.log("截图：" + menuShot);
check("头像菜单：四枚菜单项、设置 / 退出登录 / 操作记录（href = #/audit）/ 文件库（href = #/files）", menuInfo !== null && menuInfo.items.length === 4 && menuInfo.items[0].text === "设置" && menuInfo.items[1].text === "退出登录" && menuInfo.auditText === "操作记录" && menuInfo.auditHref === "#/audit" && menuInfo.items[3].text === "文件库" && menuInfo.items[3].href === "#/files", JSON.stringify(menuInfo));
check("「操作记录」在「退出登录」下方（同一菜单内、纵向相邻）", menuInfo !== null && menuInfo.auditY > menuInfo.items[1].y && menuInfo.auditY - menuInfo.items[1].y < 48, menuInfo === null ? "null" : "auditY " + String(menuInfo.auditY) + " / logoutY " + String(menuInfo.items[1].y));

// ② 点入口 → #/audit（缺省无 query）、首屏 50 条封顶 + 总数
const clicked = await clickSelector("[data-account-audit]");
if (clicked !== true) { await bail("点「操作记录」失败"); }
const pageReady = await waitFor("document.querySelector(" + j("[data-audit-page]") + ") !== null && document.querySelectorAll(" + j("[data-audit-row]") + ").length > 0", 20000);
if (pageReady !== true) { await bail("操作记录页没就位 / 首屏没有行"); }
await sleep(800);
const first = await ev(rowExpr);
const firstShot = await shot("audit-page-default", { x: 0, y: 0, width: 1500, height: 1000, scale: 1 });
console.log("截图：" + firstShot);
check("点入口 → 地址 #/audit（缺省筛选不落参数）", first !== null && first.hash === "#/audit", first === null ? "null" : String(first.hash));
check("首屏 50 条 + 全文计数「共 " + String(totalAll) + " 条」", first !== null && first.rowCount === 50 && first.count === "共 " + String(totalAll) + " 条", JSON.stringify({ rowCount: first === null ? null : first.rowCount, count: first === null ? null : first.count }));
check("分页信息在场（第 1 / N 页）", first !== null && first.pageInfo !== null && first.pageInfo.indexOf("第 1 / ") !== -1, first === null ? "null" : String(first.pageInfo));
check("时间列口径 YYYY-MM-DD HH:mm（Asia/Shanghai）+ 倒序", first !== null && first.rows.length > 0 && first.rows.every((row) => timeOk(row.time)) && first.rows.length > 1 && first.rows[0].time >= first.rows[1].time, first === null ? "null" : JSON.stringify(first.rows.slice(0, 2).map((row) => row.time)));
check("行口径齐备：操作人 / 动作标签 / 对象 / 结果签 / 项目列非空", first !== null && first.rows.every((row) => row.actor !== "" && row.action !== null && row.actionText !== "" && row.object !== "" && row.result !== null && row.resultText !== "" && row.project !== ""), first === null ? "null" : JSON.stringify(first.rows[0]));
check("首屏请求无筛选参数（只有 page / limit）", lastReq().indexOf("page=1") !== -1 && lastReq().indexOf("limit=50") !== -1 && lastReq().indexOf("action=") === -1 && lastReq().indexOf("actorId=") === -1 && lastReq().indexOf("objectType=") === -1 && lastReq().indexOf("result=") === -1 && lastReq().indexOf("projectId=") === -1 && lastReq().indexOf("from=") === -1 && lastReq().indexOf("to=") === -1, lastReq());
const firstRowId = first === null || first.rows.length === 0 ? null : first.rows[0].id;

// Push 276 加固（修数据漂移 flaky）：首屏 50 行可能全被「已删临时项目」行占据（回放批次产物），或项目映射未就绪 ——
// 改为按「库内最新一条项目仍存活的行」页位直达（±1 页内顺扫），断言后地址回第 1 页（后续分页用例从第 1 页起步）。
const auditProjectProbe = "(function(){var cs=document.querySelectorAll(" + j("[data-audit-project]") + ");var c=null;for(var i=0;i<cs.length;i+=1){if((cs[i].getAttribute(" + j("data-audit-project-name") + ")||'')!==''&&(cs[i].getAttribute(" + j("data-audit-project-code") + ")||'')!==''){c=cs[i];break;}}if(c===null){return null;}var spans=c.querySelectorAll(" + j("span") + ");return {name:c.getAttribute(" + j("data-audit-project-name") + "),code:c.getAttribute(" + j("data-audit-project-code") + "),rows:spans.length,direction:getComputedStyle(c).flexDirection,first:spans.length>0?String(spans[0].textContent).trim():null,second:spans.length>1?String(spans[1].textContent).trim():null};})()";
let auditProjectCell = null;
const liveIdxRow = (await db.query("select idx from (select a.id, row_number() over (order by a.occurred_at desc, a.id desc) - 1 as idx from audit_logs a where a.project_id in (select id from projects)) t order by idx asc limit 1")).rows[0];
const livePage = liveIdxRow === undefined ? 1 : Math.floor(Number(liveIdxRow.idx) / 50) + 1;
if (livePage !== 1) {
  await ev("window.location.hash = " + j("#/audit?page=" + String(livePage)) + ";");
  await waitFor("window.location.hash.indexOf(" + j("page=" + String(livePage)) + ") !== -1", 8000);
  await sleep(900);
}
for (let round = 0; round < 2 && auditProjectCell === null; round += 1) {
  for (let i = 0; i < 12 && auditProjectCell === null; i += 1) {
    auditProjectCell = await ev(auditProjectProbe);
    if (auditProjectCell !== null) { break; }
    await sleep(150);
  }
  if (auditProjectCell !== null || round === 1) { break; }
  await clickSelector("[data-audit-next]");
  await sleep(900);
}
check("项目列排版 = 中文名在上、编号在下（两行；与文件库同款 —— 追订「中文和编号的位置反一下」）", auditProjectCell !== null && auditProjectCell.rows === 2 && auditProjectCell.direction === "column" && auditProjectCell.first === auditProjectCell.name && auditProjectCell.second === auditProjectCell.code, JSON.stringify(auditProjectCell));
await ev("(function(){if(window.location.hash.indexOf(" + j("page=") + ") !== -1){window.location.hash = " + j("#/audit") + ";}})()");
await waitFor("window.location.hash.indexOf(\"page=\") === -1", 8000);
await sleep(900);

// 人话护栏（2026-10-09 业务口径：「不要这种太机器的操作记录 要让人可以看懂的 那些路由还有具体的代码不要显示」）
const pageText = await ev("(function(){var t=document.querySelector(" + j("[data-audit-page]") + ");if(t===null){return null;}return String(t.textContent);})()");
check("人话护栏：表格里不出现接口路径（/api/）", pageText !== null && pageText.indexOf("/api/") === -1, pageText === null ? "null" : pageText.slice(0, 80));
const uuidHit = pageText === null ? null : /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.exec(pageText);
check("人话护栏：表格里不出现 36 位 UUID（内部 id 不上屏）", pageText !== null && uuidHit === null, uuidHit === null ? "" : uuidHit[0]);
const changeInfo = await ev("(function(){var ups=document.querySelectorAll(" + j("[data-audit-change-kind=update]") + ");return {updateLines:ups.length,first:ups.length===0?null:String(ups[0].textContent).trim()};})()");
check("变化明细：首屏有变化行；有真实更新时逐条出「修改前 → 修改后」", first !== null && first.rows.some((row) => row.changeCount > 0) && (changeInfo === null || changeInfo.updateLines === 0 || (changeInfo.first.indexOf("修改前") !== -1 && changeInfo.first.indexOf("修改后") !== -1)), JSON.stringify(changeInfo !== null && changeInfo.updateLines > 0 ? { first: changeInfo.first } : { changeRows: first === null ? null : first.rows.filter((row) => row.changeCount > 0).length }));

// ③ 分页：下一页 → page=2（请求同步）、首行换行；上一页 → 回第 1 页
await clickSelector("[data-audit-next]");
const pageTwoReady = await waitFor("window.location.hash.indexOf(" + j("page=2") + ") !== -1", 8000);
await sleep(1200);
const second = await ev(rowExpr);
check("下一页：地址 page=2、请求 page=2、首行换行", pageTwoReady === true && lastReq().indexOf("page=2") !== -1 && second !== null && second.rowCount === 50 && second.rows.length > 0 && second.rows[0].id !== firstRowId, JSON.stringify({ hash: second === null ? null : second.hash, req: lastReq(), id: second === null || second.rows.length === 0 ? null : second.rows[0].id }) + " / 首行 " + String(firstRowId));
await clickSelector("[data-audit-prev]");
const backReady = await waitFor("window.location.hash === " + j("#/audit"), 8000);
await sleep(1200);
const back = await ev(rowExpr);
check("上一页：地址回 #/audit、请求 page=1、首行还原", backReady === true && lastReq().indexOf("page=1") !== -1 && back !== null && back.rows.length > 0 && back.rows[0].id === firstRowId, JSON.stringify({ hash: back === null ? null : back.hash, req: lastReq() }));

// ④ 动作筛选 = 修改（action=update）：行全为「修改」、计数收窄、URL 与请求同步
await clickSelector("[data-audit-filter=action] button");
await sleep(400);
const actionOptionTexts = await ev("(function(){var p=document.querySelector(" + j("[data-select-popover]") + ");if(p===null){return null;}var os=p.querySelectorAll(" + j("[role=option]") + ");var out=[];for(var i=0;i<os.length;i+=1){out.push(String(os[i].textContent).trim());}return out;})()");
check("④0 动作下拉：含「访问」「预览」、撤「推进」「回退」—— 选项 10 项", actionOptionTexts !== null && actionOptionTexts.length === 10 && actionOptionTexts.indexOf("访问") !== -1 && actionOptionTexts.indexOf("预览") !== -1 && actionOptionTexts.indexOf("推进") === -1 && actionOptionTexts.indexOf("回退") === -1, JSON.stringify(actionOptionTexts));
const pickedAction = await pickOption("修改");
const actionReady = await waitFor("window.location.hash.indexOf(" + j("action=update") + ") !== -1 && document.querySelectorAll(" + j("[data-audit-row]") + ").length > 0", 10000);
await sleep(1000);
const byAction = await ev(rowExpr);
const actionUi = await ev(triggerProbe("[data-audit-filter=action] button"));
const actionShot = await shot("audit-filter-action", { x: 0, y: 0, width: 1500, height: 700, scale: 1 });
console.log("截图：" + actionShot);
check("④ 动作筛选 = 多选第一项（修改）：点选不关浮层 + 触发器「动作 + 浅灰 1」、地址 action=update", pickedAction === true && actionReady === true && actionUi.open === true && actionUi.label === "动作" && actionUi.count === "1" && byAction !== null && byAction.hash.indexOf("action=update") !== -1, byAction === null ? "null" : JSON.stringify({ hash: byAction.hash, ui: actionUi }));
check("④b 动作筛选后：行全部为「修改」、计数「共 " + String(totalUpdate) + " 条」、请求同步（action=update + page=1）", byAction !== null && byAction.rowCount === Math.min(totalUpdate, 50) && byAction.rows.every((row) => row.action === "update" && row.actionText === "修改") && byAction.count === "共 " + String(totalUpdate) + " 条" && lastReq().indexOf("action=update") !== -1 && lastReq().indexOf("page=1") !== -1, JSON.stringify({ count: byAction === null ? null : byAction.count, req: lastReq() }));
const pickedCreate = await pickOption("新增");
const actionMultiReady = await waitFor("window.location.hash.indexOf(" + j("action=update,create") + ") !== -1 && document.querySelectorAll(" + j("[data-audit-row]") + ").length > 0", 10000);
await sleep(1000);
const byActionTwo = await ev(rowExpr);
const actionMultiUi = await ev(triggerProbe("[data-audit-filter=action] button"));
const totalUpdateCreate = await countOf("select count(*)::int n from audit_logs where action = any($1::text[])", [["update", "create"]]);
check("④c 动作多选累加（修改 + 新增）：地址 action=update,create、触发器「动作 + 浅灰 2」、行全为「修改 / 新增」、计数 = 两动作并集", pickedCreate === true && actionMultiReady === true && actionMultiUi.label === "动作" && actionMultiUi.count === "2" && byActionTwo !== null && byActionTwo.count === "共 " + String(totalUpdateCreate) + " 条" && byActionTwo.rows.every((row) => (row.action === "update" && row.actionText === "修改") || (row.action === "create" && row.actionText === "新增")), JSON.stringify({ count: byActionTwo === null ? null : byActionTwo.count, db: totalUpdateCreate, ui: actionMultiUi }));
const unpickUpdate = await pickOption("修改");
const createOnlyReady = await waitFor("window.location.hash.indexOf(" + j("action=create") + ") !== -1 && window.location.hash.indexOf(" + j("action=update") + ") === -1 && document.querySelectorAll(" + j("[data-audit-row]") + ").length > 0", 10000);
await sleep(1000);
const byCreate = await ev(rowExpr);
const totalCreate = await countOf("select count(*)::int n from audit_logs where action = $1", ["create"]);
check("④d 再次点击修改 = 取消选择：地址只剩 action=create、行全为「新增」、计数 = 新增", unpickUpdate === true && createOnlyReady === true && byCreate !== null && byCreate.count === "共 " + String(totalCreate) + " 条" && byCreate.rows.every((row) => row.action === "create" && row.actionText === "新增"), JSON.stringify({ count: byCreate === null ? null : byCreate.count, db: totalCreate }));
await clickSelector("[data-audit-filter=action] button");
await waitFor("document.querySelector(" + j("[data-select-popover]") + ") === null", 8000);
await sleep(400);

// ⑤ 结果筛选 = 多选（与动作=新增 交集为空 → 空态；取消动作 → 只剩「越权拒绝」；再累加 / 取消「成功」）
await clickSelector("[data-audit-filter=result] button");
await sleep(400);
const pickedDenied = await pickOption("越权拒绝");
const comboReady = await waitFor("window.location.hash.indexOf(" + j("result=denied") + ") !== -1", 10000);
await sleep(1000);
const combo = await ev(rowExpr);
const comboUi = await ev(triggerProbe("[data-audit-filter=result] button"));
check("⑤ 结果筛选 = 越权拒绝（与动作=新增 叠加）：触发器「结果 + 浅灰 1」、命中空集 → 空态文案 + 请求带两参", pickedDenied === true && comboReady === true && comboUi.label === "结果" && comboUi.count === "1" && combo !== null && combo.rowCount === 0 && combo.empty !== null && combo.empty.indexOf("没有操作记录") !== -1 && lastReq().indexOf("action=create") !== -1 && lastReq().indexOf("result=denied") !== -1, JSON.stringify({ empty: combo === null ? null : combo.empty, req: lastReq() }));
await clickSelector("[data-audit-filter=action] button");
await sleep(400);
const unpickCreate = await pickOption("新增");
const deniedReady = await waitFor("window.location.hash.indexOf(" + j("action=") + ") === -1 && document.querySelectorAll(" + j("[data-audit-row]") + ").length > 0", 10000);
await sleep(1000);
const byDenied = await ev(rowExpr);
const deniedShot = await shot("audit-filter-denied", { x: 0, y: 0, width: 1500, height: 700, scale: 1 });
console.log("截图：" + deniedShot);
check("⑤b 取消动作（再点新增 = 取消选择）后：行全部为「越权拒绝」、计数「共 " + String(totalDenied) + " 条」", unpickCreate === true && deniedReady === true && byDenied !== null && byDenied.rows.every((row) => row.result === "denied" && row.resultText === "越权拒绝") && byDenied.count === "共 " + String(totalDenied) + " 条", JSON.stringify({ count: byDenied === null ? null : byDenied.count, first: byDenied === null || byDenied.rows.length === 0 ? null : byDenied.rows[0].resultText }));
await clickSelector("[data-audit-filter=action] button");
await waitFor("document.querySelector(" + j("[data-select-popover]") + ") === null", 8000);
await sleep(400);
await clickSelector("[data-audit-filter=result] button");
await sleep(400);
const pickedSucceeded = await pickOption("成功");
const resultMultiReady = await waitFor("window.location.hash.indexOf(" + j("result=denied,succeeded") + ") !== -1 && document.querySelectorAll(" + j("[data-audit-row]") + ").length > 0", 10000);
await sleep(1000);
const byResultTwo = await ev(rowExpr);
const resultMultiUi = await ev(triggerProbe("[data-audit-filter=result] button"));
const totalDeniedSucceeded = await countOf("select count(*)::int n from audit_logs where result = any($1::text[])", [["denied", "succeeded"]]);
check("⑤c 结果多选累加（越权拒绝 + 成功）：地址 result=denied,succeeded、触发器「结果 + 浅灰 2」、行全为两种结果、计数 = 两结果并集", pickedSucceeded === true && resultMultiReady === true && resultMultiUi.label === "结果" && resultMultiUi.count === "2" && byResultTwo !== null && byResultTwo.count === "共 " + String(totalDeniedSucceeded) + " 条" && byResultTwo.rows.every((row) => (row.result === "denied" && row.resultText === "越权拒绝") || (row.result === "succeeded" && row.resultText === "成功")), JSON.stringify({ count: byResultTwo === null ? null : byResultTwo.count, db: totalDeniedSucceeded, ui: resultMultiUi }));
const unpickSucceeded = await pickOption("成功");
const deniedOnlyReady = await waitFor("window.location.hash.indexOf(" + j("result=denied") + ") !== -1 && window.location.hash.indexOf(" + j("result=denied,succeeded") + ") === -1", 10000);
check("⑤d 再点成功 = 取消选择：地址回 result=denied（只剩越权拒绝）", unpickSucceeded === true && deniedOnlyReady === true, JSON.stringify({}));

// ⑥ 操作人筛选 = 潘兴（actor=<id>）；再叠时间 = 今天（from / to，Asia/Shanghai）
await clickSelector("[data-audit-filter=actor] button");
await sleep(400);
const pickedActor = await pickOption(userRow.display_name);
const actorReady = await waitFor("window.location.hash.indexOf(" + j("actor=") + ") !== -1 && document.querySelectorAll(" + j("[data-audit-row]") + ").length > 0", 10000);
await sleep(1000);
const byActor = await ev(rowExpr);
const actorShot = await shot("audit-filter-actor", { x: 0, y: 0, width: 1500, height: 700, scale: 1 });
console.log("截图：" + actorShot);
const actorUi = await ev(triggerProbe("[data-audit-filter=actor] button"));
check("⑥ 操作人筛选 = " + userRow.display_name + "（叠加 result=denied）：触发器「操作人 + 浅灰 1」、行操作人全为本人、计数「共 " + String(totalActor) + " 条」", pickedActor === true && actorReady === true && actorUi.label === "操作人" && actorUi.count === "1" && byActor !== null && byActor.rows.every((row) => row.actor === userRow.display_name) && byActor.count === "共 " + String(totalActor) + " 条", JSON.stringify({ count: byActor === null ? null : byActor.count, ui: actorUi }));
check("⑥b 操作人筛选请求同步（actorId=<id>）", lastReq().indexOf("actorId=" + encodeURIComponent(userRow.id)) !== -1, lastReq());
check("⑥c 操作人 / 结果 两筛叠加也同步进请求", lastReq().indexOf("result=denied") !== -1, lastReq());
await clickSelector("[data-audit-filter=actor] button");
await waitFor("document.querySelector(" + j("[data-select-popover]") + ") === null", 8000);
await sleep(400);

await clickSelector("[data-audit-filter=time] button");
await sleep(500);
const dayNumber = String(new Date().getDate());
const dayPoint = await ev("(function(){var ps=document.querySelectorAll(" + j("div.fixed.z-50") + ");if(ps.length===0){return null;}var p=ps[ps.length-1];var bs=p.querySelectorAll(" + j("button") + ");for(var i=0;i<bs.length;i+=1){var b=bs[i];if(b.disabled===false&&String(b.textContent).trim()===" + j(dayNumber) + "){var r=b.getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};}}return null;})()");
if (dayPoint === null || dayPoint === undefined) { await bail("日历里找不到今天（" + dayNumber + " 号）的按钮"); }
await clickAt(dayPoint);
await sleep(300);
const okPoint = await ev("(function(){var ps=document.querySelectorAll(" + j("div.fixed.z-50") + ");if(ps.length===0){return null;}var p=ps[ps.length-1];var bs=p.querySelectorAll(" + j("button") + ");for(var i=0;i<bs.length;i+=1){var b=bs[i];if(String(b.textContent).trim()===" + j("确定") + "){var r=b.getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};}}return null;})()");
if (okPoint === null || okPoint === undefined) { await bail("日历里找不到「确定」"); }
await clickAt(okPoint);
const timeReady = await waitFor("window.location.hash.indexOf(" + j("from=") + ") !== -1", 10000);
await sleep(1200);
const byTime = await ev(rowExpr);
const timeShot = await shot("audit-filter-time", { x: 0, y: 0, width: 1500, height: 700, scale: 1 });
console.log("截图：" + timeShot);
const expectedFrom = "from=" + encodeURIComponent(new Date(todayKey + "T00:00:00+08:00").toISOString());
const expectedTo = "to=" + encodeURIComponent(new Date(todayKey + "T23:59:59.999+08:00").toISOString());
check("时间筛选 = 今天（" + todayKey + "）：地址带 from / to、请求为 Asia/Shanghai 当日端点 ISO", timeReady === true && byTime !== null && byTime.hash.indexOf("from=" + todayKey) !== -1 && byTime.hash.indexOf("to=" + todayKey) !== -1 && lastReq().indexOf(expectedFrom) !== -1 && lastReq().indexOf(expectedTo) !== -1, JSON.stringify({ hash: byTime === null ? null : byTime.hash, req: lastReq() }));
check("时间筛选 = 今天（叠加 操作人+结果 两筛）：行数与库内交集一致、行全为潘兴", byTime !== null && byTime.count === "共 " + String(totalToday) + " 条" && (totalToday === 0 ? byTime.rowCount === 0 && byTime.empty !== null : byTime.rowCount === Math.min(totalToday, 50) && byTime.rows.every((row) => row.actor === userRow.display_name)), JSON.stringify({ db: totalToday, count: byTime === null ? null : byTime.count, rows: byTime === null ? null : byTime.rowCount }));

// ⑦ 清除筛选 → 地址回 #/audit、请求无筛选参数、首行还原
await clickSelector("[data-audit-clear]");
const clearReady = await waitFor("window.location.hash === " + j("#/audit") + " && document.querySelectorAll(" + j("[data-audit-row]") + ").length > 0", 10000);
await sleep(1000);
const cleared = await ev(rowExpr);
check("清除筛选：地址回 #/audit、请求无筛选参数、首行还原", clearReady === true && lastReq().indexOf("action=") === -1 && lastReq().indexOf("actorId=") === -1 && lastReq().indexOf("result=") === -1 && lastReq().indexOf("from=") === -1 && cleared !== null && cleared.rows[0].id === firstRowId, JSON.stringify({ req: lastReq(), first: cleared === null || cleared.rows.length === 0 ? null : cleared.rows[0].id }));

// ⑧ 关键字搜索（Push 260 · 业务口径 2026-10-09「增加搜索功能」）：深链（刷新不丢）→ 输入防抖 → 无命中 → 清空
const KW = "定档";
const KW_ENC = encodeURIComponent(KW);
const kwPattern = "%" + KW + "%";
const kwTotal = await countOf("select count(*)::int n from audit_logs where summary ilike $1 or actor_name ilike $1 or changes::text ilike $1", [kwPattern]);
const kwIds = (await db.query("select id from audit_logs where summary ilike $1 or actor_name ilike $1 or changes::text ilike $1 order by occurred_at desc, id desc limit 50", [kwPattern])).rows.map((row) => String(row.id));
console.log("搜索「" + KW + "」库内三路命中：" + String(kwTotal) + " 条（top" + String(kwIds.length) + " 参与对账）");
await ev("window.location.hash = " + j("#/audit?q=" + KW_ENC));
await page.send("Page.reload");
const kwDeepReady = await waitFor("window.location.hash.indexOf(" + j("q=" + KW_ENC) + ") !== -1 && document.querySelectorAll(" + j("[data-audit-row]") + ").length > 0", 20000);
await sleep(1200);
const byDeep = await ev(rowExpr);
const kwShot = await shot("audit-search-keyword", { x: 0, y: 0, width: 1500, height: 700, scale: 1 });
console.log("截图：" + kwShot);
check("搜索深链 + 刷新：#/audit?q=「" + KW + "」直接打开 = 请求带 q、计数「共 " + String(kwTotal) + " 条」、首屏行 top50 同序", kwDeepReady === true && byDeep !== null && lastReq().indexOf("q=" + KW_ENC) !== -1 && byDeep.count === "共 " + String(kwTotal) + " 条" && byDeep.rows.map((row) => row.id).join(",") === kwIds.join(","), JSON.stringify({ req: lastReq(), count: byDeep === null ? null : byDeep.count, rows: byDeep === null ? null : byDeep.rows.length }));
await clickSelector("[data-audit-filter=keyword] button");
const kwCleared = await waitFor("window.location.hash === " + j("#/audit") + " && document.querySelectorAll(" + j("[data-audit-row]") + ").length > 0", 12000);
await sleep(1200);
const afterClear = await ev(rowExpr);
check("清空搜索（×）：地址回 #/audit、请求无 q=、首行 / 全文计数还原", kwCleared === true && afterClear !== null && lastReq().indexOf("q=") === -1 && afterClear.rows[0].id === firstRowId && afterClear.count === "共 " + String(totalAll) + " 条", JSON.stringify({ req: lastReq(), first: afterClear === null || afterClear.rows.length === 0 ? null : afterClear.rows[0].id }));
await clickSelector("[data-audit-filter=keyword] input");
await page.send("Input.insertText", { text: KW });
const kwReady = await waitFor("window.location.hash.indexOf(" + j("q=" + KW_ENC) + ") !== -1 && document.querySelectorAll(" + j("[data-audit-row]") + ").length > 0", 12000);
await sleep(1200);
const byKeyword = await ev(rowExpr);
check("输入搜索「" + KW + "」：地址 / 请求同步（q= + page=1，防抖后真查）", kwReady === true && byKeyword !== null && byKeyword.hash.indexOf("q=" + KW_ENC) !== -1 && lastReq().indexOf("q=" + KW_ENC) !== -1 && lastReq().indexOf("page=1") !== -1, JSON.stringify({ hash: byKeyword === null ? null : byKeyword.hash, req: lastReq() }));
check("搜索「" + KW + "」计数 / 首屏行与库内三路命中逐一对账", byKeyword !== null && byKeyword.count === "共 " + String(kwTotal) + " 条" && byKeyword.rows.map((row) => row.id).join(",") === kwIds.join(","), JSON.stringify({ count: byKeyword === null ? null : byKeyword.count, db: kwTotal, rows: byKeyword === null ? null : byKeyword.rows.length }));
const NO_MATCH = "ZZZ不存在关键字ZZZ";
const NO_MATCH_ENC = encodeURIComponent(NO_MATCH);
await clickSelector("[data-audit-filter=keyword] button");
await sleep(600);
await clickSelector("[data-audit-filter=keyword] input");
await page.send("Input.insertText", { text: NO_MATCH });
const kwEmptyReady = await waitFor("window.location.hash.indexOf(" + j("q=" + NO_MATCH_ENC) + ") !== -1 && document.querySelector(" + j("[data-audit-empty]") + ") !== null", 12000);
await sleep(800);
const kwEmpty = await ev(rowExpr);
check("搜索无命中（" + NO_MATCH + "）：空态「没有匹配」+ 计数 0 + 请求带 q", kwEmptyReady === true && kwEmpty !== null && kwEmpty.count === "共 0 条" && kwEmpty.empty !== null && kwEmpty.empty.indexOf("没有匹配") !== -1 && lastReq().indexOf("q=" + NO_MATCH_ENC) !== -1, JSON.stringify({ empty: kwEmpty === null ? null : kwEmpty.empty, req: lastReq() }));
await clickSelector("[data-audit-filter=keyword] button");
await sleep(600);
check("控制台零报错 / 零异常", consoleErrors.length === 0, consoleErrors.slice(0, 3).join(" ;; "));
await db.query("update sessions set revoked_at = now() where token_hash = $1", [sha256(token)]);
const residue = (await countOf("select count(*)::int n from sessions where token_hash = $1 and revoked_at is null", [sha256(token)]));
check("清理：临时会话已撤销、零残留", residue === 0, String(residue));
const failed = checks.filter((item) => item.ok !== true).length;
console.log("—— 合计 " + String(checks.length) + " 项：" + String(checks.length - failed) + " 通过 / " + String(failed) + " 失败 ——");
try { page.ws.close(); } catch (error) { /* 忽略 */ }
chrome.kill();
await db.end();
process.exit(failed === 0 ? 0 : 1);
