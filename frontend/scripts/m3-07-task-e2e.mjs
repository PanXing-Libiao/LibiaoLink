/**
 * LibiaoLink 前端 · M3-07 刀 1 后半回放（任务域接线：服务端读写 + 状态五态 + 汇总卡两阶段）
 *
 * 前置（三件都在本机跑着）：
 *   1. 前端 dev：cd frontend && npm run dev（默认 3000）
 *   2. api：cd server && npm run start:api（默认 3001，需先 npm run build）
 *   3. 数据库：本地沙箱 PG（默认 127.0.0.1:5433/libiaolink）
 *   4. 本机装了 Chrome（脚本 headless 起一个调试实例；路径可用 CHROME_PATH 覆盖）
 *
 * 用法：node scripts/m3-07-task-e2e.mjs
 *   可覆盖的环境变量：FRONTEND_BASE / API_BASE / DATABASE_URL / CHROME_PATH / CDP_PORT / REPLAY_USER / PG_MODULE
 *
 * 它做什么：用一条**临时会话**（跑完撤销）+ 一个**临时项目**（跑完硬删、读面零残留）在真机浏览器里跑一遍前端任务域口径：
 *   汇总卡两阶段（最慢 / 最新）随写入推进、紧急重要度三档、四格进度写入、状态下拉五态与覆盖边界（已完成写 overdue 不生效 /
 *   未完成写 overdue 生效）、添加卡片落库与「已添加」判重、409 版本冲突提示条 + 自动整表重取后重试可写、三块视图
 *   （项目总览 / 人员任务分配 / 任务进展 / 甘特图）与收尾清理。
 * 证据：docs/m3-07-回放证据(五态与汇总卡·前端).md
 */

import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
// pg 只用来读一处库内口径（tasks.status_override 的落库值，契约不暴露该字段）—— 前端不新装依赖，复用 server 的依赖解析。
const PG_MODULE = process.env.PG_MODULE ?? new URL("../../server/node_modules/pg/lib/index.js", import.meta.url).href;
const { default: pg } = await import(PG_MODULE);

const { Client } = pg;
const FRONTEND = process.env.FRONTEND_BASE ?? "http://localhost:3000";
const CHROME = process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PORT = Number(process.env.CDP_PORT ?? 9398);
const DB = process.env.DATABASE_URL ?? "postgres://libiaolink_api@127.0.0.1:5433/libiaolink";
const REPLAY_USER = process.env.REPLAY_USER ?? "px-replay";
const sha256 = (t) => createHash("sha256").update(t).digest("hex");
const SEL = "[aria-label=" + String.fromCharCode(34) + "排序方式（维度 × 方向）" + String.fromCharCode(34) + "]";
const GROUP = JSON.stringify(SEL);
const PROBE = "(function(){var out={buttons:[],cards:[],groupText:\"\"};var g=document.querySelector(" + GROUP + ");if(g!==null)out.groupText=g.textContent;var bs=g===null?[]:g.querySelectorAll(\"button\");for(var i=0;i<bs.length;i++){var b=bs[i];out.buttons.push(b.textContent.trim()+\":\"+b.getAttribute(\"aria-pressed\"));}var cs=document.querySelectorAll(\"[role=link]\");for(var j=0;j<cs.length;j++){out.cards.push(cs[j].textContent.indexOf(\"物流分拣\")>=0?\"A\":(cs[j].textContent.indexOf(\"展厅\")>=0?\"B\":\"?\"));}return out;})()";

const db = new Client({ connectionString: DB });
await db.connect();
const userRow = (await db.query("select id, username, display_name from users where username = $1 and status = 'active'", [REPLAY_USER])).rows[0];
const token = "pxe2e-" + randomBytes(16).toString("hex");
const csrf = randomBytes(16).toString("hex");
await db.query("insert into sessions (token_hash, user_id, id_token, expires_at) values ($1, $2, $3, now() + make_interval(mins => 30))", [sha256(token), userRow.id, "px-e2e"]);
console.log("临时会话：" + userRow.username + "（" + userRow.display_name + "）");

const profile = mkdtempSync(join(tmpdir(), "pxe2e-"));
const chrome = spawn(CHROME, ["--headless=new", "--remote-debugging-port=" + PORT, "--user-data-dir=" + profile, "--no-first-run", "--no-default-browser-check", "--disable-gpu", "about:blank"], { stdio: "ignore" });

async function waitTarget() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const list = await (await fetch("http://127.0.0.1:" + PORT + "/json/list")).json();
      const target = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (target) return target;
    } catch (error) { /* 未就绪 */ }
    await new Promise((r) => setTimeout(r, 500));
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
    this.ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(typeof ev.data === "string" ? ev.data : String(ev.data));
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const item = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) item.reject(new Error(JSON.stringify(msg.error))); else item.resolve(msg.result);
        return;
      }
      if (msg.method === "Network.requestWillBeSent") { this.events.push(msg.params.request.url); return; }
      if (msg.method === "Runtime.exceptionThrown" || msg.method === "Log.entryAdded" || msg.method === "Runtime.consoleAPICalled") this.events.push("EVT " + msg.method + " " + JSON.stringify(msg.params).slice(0, 400));
    });
  }
  send(method, params = {}) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error("cdp timeout: " + method)); }, 15000);
      this.pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
}


const API = process.env.API_BASE ?? "http://127.0.0.1:3001";
const COOKIE = "ll_sid=" + token + "; ll_csrf=" + csrf;
const stageNames = { presale: "售前规划", design: "设计开发", purchase: "加工采购", assembly: "组装发货", install: "硬件实施", deploy: "软件部署", trial: "试运行", production: "投产阶段", acceptance: "验收" };

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
const statusOptionLabels = [];

function check(name, ok, detail) {
  checks.push(ok === true);
  console.log((ok === true ? "PASS  " : "FAIL  ") + name + (detail === undefined ? "" : "   [" + detail + "]"));
}

// ---------- 夹具：临时项目 + 两条任务 ----------
const fixtureCode = "PX-M307B-" + randomBytes(3).toString("hex").toUpperCase();
const projRes = await api("/api/v1/projects", "POST", { code: fixtureCode, name: "M3-07刀1后半回放", managerIds: [userRow.id] });
check("夹具：建临时项目（201）", projRes.status === 201, String(projRes.status) + " " + projRes.text.slice(0, 140));
const projectId = projRes.json === null ? "" : projRes.json.id;
const taskA = await api("/api/v1/projects/" + projectId + "/tasks", "POST", { stageKey: "presale", title: "回放任务·售前", ownerIds: [userRow.id], plannedStart: "2026-09-01", plannedEnd: "2026-09-10", priority: "高" });
// 负责人缺省口径（2026-09-24 修订，回到 ADR-021）：不传 ownerIds = 「待分配」空数组（不再兜底项目经理）；本夹具仍显式传值以固定数据。
const taskB = await api("/api/v1/projects/" + projectId + "/tasks", "POST", { stageKey: "design", title: "回放任务·设计", ownerIds: [] });
check("夹具：建两条任务（201 / 201）", taskA.status === 201 && taskB.status === 201, taskA.status + " / " + taskB.status);
const summary0 = (await api("/api/v1/projects/" + projectId + "/summary")).json;
console.log("夹具汇总：" + JSON.stringify(summary0));

// ---------- 浏览器 ----------
const target = await waitTarget();
const page = new Cdp(target.webSocketDebuggerUrl);
await page.ready;
await page.send("Network.enable");
await page.send("Page.enable");
await page.send("Runtime.enable");
await page.send("Log.enable");
await page.send("Network.setCookie", { name: "ll_sid", value: token, url: FRONTEND + "/", path: "/", httpOnly: true, secure: false });
await page.send("Network.setCookie", { name: "ll_csrf", value: csrf, url: FRONTEND + "/", path: "/", httpOnly: false, secure: false });
await page.send("Emulation.setDeviceMetricsOverride", { width: 1500, height: 1000, deviceScaleFactor: 1, mobile: false });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ev = async (expression) => (await page.send("Runtime.evaluate", { expression, returnByValue: true })).result.value;
const bodyText = async () => String(await ev("document.body.innerText"));
const flat = (t) => t.split(String.fromCharCode(10)).join(" | ");
async function openView(view) {
  await page.send("Page.navigate", { url: FRONTEND + "/#/project/" + projectId + "?view=" + view });
  await sleep(4500);
}
async function tasksOf() {
  const res = await api("/api/v1/projects/" + projectId + "/tasks?limit=200");
  return res.json === null ? [] : res.json.items;
}
function byTitle(items, title) { return items.filter((item) => item.title === title)[0]; }

await openView("overview");
let text = await bodyText();
console.log("正文首段：" + flat(text).slice(0, 800));
const cardText = String(await ev("(function(){var els=document.querySelectorAll(\"main div\");for(var i=0;i<els.length;i++){var t=els[i].innerText||\"\";if(t.indexOf(\"最慢阶段\")===0){return t;}}return \"\";})()"));
console.log("汇总卡：" + flat(cardText));
check("汇总卡 = 最慢阶段 / 最新阶段（「当前阶段」已下线）", text.indexOf("最慢阶段") >= 0 && text.indexOf("最新阶段") >= 0 && text.indexOf("当前阶段") < 0);
check("最慢阶段 = 服务端 slowestStage（" + stageNames[summary0.slowestStage] + "）", cardText.indexOf(stageNames[summary0.slowestStage]) >= 0, flat(cardText));
check("最新阶段 = —（尚无任务动工 / latestStage=null）", summary0.latestStage !== null || cardText.indexOf("—") >= 0, flat(cardText));
check("任务列表来自接口（两条夹具都在）", text.indexOf("回放任务·售前") >= 0 && text.indexOf("回放任务·设计") >= 0);
check("紧急重要度三档渲染（高）", text.indexOf("高") >= 0);
check("输出成果文件列不再有演示值（空 → —）", text.indexOf("物料总清单") < 0 && text.indexOf("CAD 图纸") < 0);

/**
 * 任务行定位：表格的行容器把整张表包在一起 —— 从别的行的格子往上走也能碰到目标标题，
 * 所以命中条件收紧成「这一层里同名格子只有 1 个」（= 任务行），不满足就继续找下一格。
 */
function rowProbe(exactLabel, title) {
  return "(function(){function countIn(root,ex){var all=root.querySelectorAll(\"[aria-label]\");var n=0;for(var j=0;j<all.length;j++){if((all[j].getAttribute(\"aria-label\")||\"\")===ex){n+=1;}}return n;}"
    + "var t=" + JSON.stringify(title) + ";var ex=" + JSON.stringify(exactLabel) + ";var cells=document.querySelectorAll(\"[aria-label]\");"
    + "for(var i=0;i<cells.length;i++){if((cells[i].getAttribute(\"aria-label\")||\"\")!==ex){continue;}var el=cells[i].parentElement;var row=null;"
    + "while(el!==null){if((el.textContent||\"\").indexOf(t)>=0){if(countIn(el,ex)===1){row=el;}break;}el=el.parentElement;}"
    + "if(row!==null){cells[i].click();return true;}}return false;})()";
}
/** 点某一行四格进度里的第 N 格（档位名同 TRACKER_LABELS）。 */
async function clickTracker(title, step) {
  return await ev(rowProbe("设置进度 " + step, title));
}
/** 点某一行的状态下拉并选一个档位（顺手记下选项列表，供「五态齐备」断言）。 */
async function pickStatus(title, label) {
  const opened = await ev(rowProbe("修改任务状态", title));
  await sleep(700);
  const labels = await ev("(function(){var opts=document.querySelectorAll(\"[role=option]\");var out=[];for(var i=0;i<opts.length;i++){out.push((opts[i].textContent||\"\").trim());}return out;})()");
  for (const each of labels) { statusOptionLabels.push(each); }
  const picked = await ev("(function(){var opts=document.querySelectorAll(\"[role=option]\");for(var i=0;i<opts.length;i++){if((opts[i].textContent||\"\").indexOf(" + JSON.stringify(label) + ")>=0){opts[i].click();return true;}}return false;})()");
  await sleep(2600);
  return opened === true && picked === true;
}

// ---------- 四格进度 ----------
check("点四格进度「已完成」（售前行）触发写入", (await clickTracker("回放任务·售前", "已完成")) === true);
await sleep(2600);
let items = await tasksOf();
let rowA = byTitle(items, "回放任务·售前");
check("进度写回服务端：status=done / progress=1 / 实际完成日期有值", rowA.status === "done" && rowA.progress === 1 && rowA.actualEnd !== null, JSON.stringify({ s: rowA.status, p: rowA.progress, a: rowA.actualEnd }));
check("汇总卡随写入变（done=1）", ((await api("/api/v1/projects/" + projectId + "/summary")).json || {}).done === 1);

// ---------- 状态五态（覆盖边界）----------
check("已完成的售前行写「已延期」", (await pickStatus("回放任务·售前", "已延期")) === true);

check("状态下拉五态齐备（已延期 / 进行中 / 已完成 / 待开始 / 提前完成）", statusOptionLabels.slice(-5).join(",") === "已延期,进行中,已完成,待开始,提前完成", statusOptionLabels.join(" / "));
await sleep(1600);
items = await tasksOf();
rowA = byTitle(items, "回放任务·售前");
check("覆盖边界：已完成任务写 overdue → 展示态仍「已完成」（基础态 / 进度不动）", rowA.displayStatus === "done" && rowA.status === "done" && rowA.progress === 1, JSON.stringify({ d: rowA.displayStatus, s: rowA.status, p: rowA.progress }));
const overrideA = await db.query("select status_override from tasks where id = $1", [rowA.id]);
check("覆盖值仍落库（status_override=overdue，只按边界不生效）", overrideA.rows[0] !== undefined && overrideA.rows[0].status_override === "overdue", JSON.stringify(overrideA.rows[0]));
check("未完成的设前行写「已延期」", (await pickStatus("回放任务·设计", "已延期")) === true);
await sleep(1600);
items = await tasksOf();
let rowB = byTitle(items, "回放任务·设计");
check("未完成 + 覆盖 → 展示态「已延期」（基础态仍 pending / 进度 0）", rowB.displayStatus === "overdue" && rowB.status === "pending" && rowB.progress === 0, JSON.stringify({ d: rowB.displayStatus, s: rowB.status, p: rowB.progress }));

// ---------- 刷新后仍是服务端数据 ----------
await openView("overview");
text = await bodyText();
check("刷新：两处写入都在（已完成 + 已延期）→ 不是内存态", text.indexOf("已完成") >= 0 && text.indexOf("已延期") >= 0);

// ---------- 添加任务卡片（预设节点 → POST）----------
const beforeList = (await api("/api/v1/projects/" + projectId + "/tasks?limit=200")).json;
const beforeIds = beforeList.items.map((item) => item.id);
const totalBefore = beforeList.total;
const pill = await ev("(function(){var pills=document.querySelectorAll(\"[data-stage-pill]\");for(var i=0;i<pills.length;i++){if((pills[i].textContent||\"\").indexOf(\"设计开发\")>=0){pills[i].click();return true;}}return false;})()");
await sleep(1500);
check("点阶段标签打开添加卡片", pill === true);
const nodeLabel = await ev("(function(){var bs=document.querySelectorAll(\"button\");for(var i=0;i<bs.length;i++){var b=bs[i];var t=(b.textContent||\"\").trim();if(b.disabled!==true && t.slice(-4)===\"＋ 添加\"){b.click();return t.slice(0,24);}}return \"\";})()");
check("卡片里点第一条「＋ 添加」（" + String(nodeLabel) + "…）", nodeLabel !== "");
await sleep(4200);
const afterAdd = await api("/api/v1/projects/" + projectId + "/tasks?limit=200");
const freshRows = (afterAdd.json.items || []).filter((item) => beforeIds.indexOf(item.id) < 0);
check("卡片添加 → 落库（total +1）", afterAdd.json.total === totalBefore + 1 && freshRows.length === 1, totalBefore + " -> " + afterAdd.json.total + " · 新行 " + String(freshRows.length));
const addedTitle = freshRows.length === 0 ? "" : freshRows[0].title;
const addedStage = freshRows.length === 0 ? "" : freshRows[0].stageKey;
check("新任务落库：阶段 = design、标题 = " + addedTitle, addedStage === "design" && addedTitle !== "", addedStage + " / " + addedTitle);
const dedupe = await ev("(function(){var bs=document.querySelectorAll(\"button\");for(var i=0;i<bs.length;i++){var t=(bs[i].textContent||\"\").trim();if(t.indexOf(" + JSON.stringify(addedTitle) + ")>=0 && t.slice(-3)===\"已添加\"){return bs[i].disabled===true?\"disabled\":\"enabled\";}}return \"missing\";})()");
check("已加的节点在卡片里显示「已添加」且点不动（判重口径）", dedupe === "disabled", String(dedupe));

// ---------- 409 版本冲突：页面拿着过期版本 → 提示条 + 自动整表重取 ----------
const staleRow = byTitle(await tasksOf(), "回放任务·设计");
const bumped = await api("/api/v1/projects/" + projectId + "/tasks/" + staleRow.id, "PATCH", { headcount: 7, version: staleRow.version });
check("夹具：后台改「施工人数」把页面这份顶成旧版本（200）", bumped.status === 200 && bumped.json !== null && bumped.json.version === staleRow.version + 1, bumped.status + " → v" + (bumped.json === null ? "?" : String(bumped.json.version)));
check("页面点四格（页面这份还是旧版本）", (await clickTracker("回放任务·设计", "刚开工")) === true);
// Push 276 口径更新：提示条已改全局 Toast（Push 261：role=status + data-toast、2s 自动消失）——
// 原「sleep 3.2s 后读 [role=alert]」在 Toast 化后必然扑空；改为 2s 窗口内轮询抓取。
let conflictText = "";
for (let i = 0; i < 16; i += 1) {
  conflictText = String(await ev("(function(){var el=document.querySelector(\"[data-toast]\");return el===null?\"\":el.innerText;})()"));
  if (conflictText.indexOf("版本冲突") >= 0) { break; }
  await sleep(140);
}
check("409 → 提示条出现（含「版本冲突」）", conflictText.indexOf("版本冲突") >= 0, flat(conflictText).slice(0, 200));
// Push 276：等自动整表重取（reloadAll）落定，再做下一段「重取后重试」。
await sleep(1400);
const afterConflict = byTitle(await tasksOf(), "回放任务·设计");
check("冲突写入被拒：进度没动（仍 0）、后台改的施工人数已是 7", afterConflict.progress === 0 && afterConflict.headcount === 7, JSON.stringify({ p: afterConflict.progress, h: afterConflict.headcount }));
await ev("(function(){var el=document.querySelector(\"[data-toast]\");if(el===null){return false;}var bs=el.querySelectorAll(\"button\");for(var i=0;i<bs.length;i++){if((bs[i].textContent||\"\").trim()===\"关闭\"){bs[i].click();return true;}}return false;})()");
await sleep(500);
check("自动重取到新版本后，再点一次能写进去", (await clickTracker("回放任务·设计", "刚开工")) === true);
await sleep(3200);
const afterRetry = byTitle(await tasksOf(), "回放任务·设计");
check("重试写入成功：progress = 0.25（施工人数仍是后台的 7）", afterRetry.progress === 0.25 && afterRetry.headcount === 7, JSON.stringify({ p: afterRetry.progress, h: afterRetry.headcount }));

// ---------- 汇总卡随写入推进 ----------
await openView("overview");
const summaryNow = (await api("/api/v1/projects/" + projectId + "/summary")).json;
const cardText2 = String(await ev("(function(){var els=document.querySelectorAll(\"main div\");for(var i=0;i<els.length;i++){var t=els[i].innerText||\"\";if(t.indexOf(\"最慢阶段\")===0){return t;}}return \"\";})()"));
const stageText = (key) => (key === null || key === undefined ? "—" : stageNames[key]);
check("服务端 summary：最慢 = design（售前已收口）、最新 = design（设计已动工）、done = 1", summaryNow.slowestStage === "design" && summaryNow.latestStage === "design" && summaryNow.done === 1, JSON.stringify(summaryNow));
check("汇总卡 = 服务端 summary（最慢 " + stageText(summaryNow.slowestStage) + " / 最新 " + stageText(summaryNow.latestStage) + "）", cardText2.indexOf(stageText(summaryNow.slowestStage)) >= 0 && cardText2.indexOf(stageText(summaryNow.latestStage)) >= 0, flat(cardText2));
check("售前已收口：最慢阶段这一格不再是「售前规划」", cardText2.slice(0, 24).indexOf("售前规划") < 0, flat(cardText2).slice(0, 60));

// ---------- 三块视图（同一份服务端数据）----------
const COLUMNS_PROBE = "(function(){var out={};var secs=document.querySelectorAll(\"[data-kanban-column]\");for(var i=0;i<secs.length;i++){var k=String(secs[i].getAttribute(\"data-kanban-column\"));out[k]=(secs[i].innerText||\"\").split(String.fromCharCode(10)).join(\" | \");}return out;})()";
const colTextOf = (cols, key) => (cols[key] === undefined ? "" : String(cols[key]));
await openView("owners");
const ownerCols = await ev(COLUMNS_PROBE);
const ownerText = Object.keys(ownerCols).map((key) => String(ownerCols[key]));
check("人员任务分配：售前卡在「潘兴」列、设计卡在「待分配」列", ownerText.some((t) => t.indexOf(userRow.display_name) >= 0 && t.indexOf("回放任务·售前") >= 0) && ownerText.some((t) => t.indexOf("待分配") >= 0 && t.indexOf("回放任务·设计") >= 0), ownerText.join(" ／ ").slice(0, 320));
await openView("progress");
const progressCols = await ev(COLUMNS_PROBE);
check("任务进展：五态列齐（已延期 / 进行中 / 已完成 / 提前完成 / 待开始）", ["已延期", "进行中", "已完成", "提前完成", "待开始"].every((key) => progressCols[key] !== undefined), Object.keys(progressCols).join(" / "));
check("任务进展：售前在「已完成」列、设计在「进行中」列", colTextOf(progressCols, "已完成").indexOf("回放任务·售前") >= 0 && colTextOf(progressCols, "进行中").indexOf("回放任务·设计") >= 0, "已完成 → " + colTextOf(progressCols, "已完成").slice(0, 60) + " ／ 进行中 → " + colTextOf(progressCols, "进行中").slice(0, 60));
await openView("gantt");
text = await bodyText();
check("甘特图：左表两条任务都在", text.indexOf("回放任务·售前") >= 0 && text.indexOf("回放任务·设计") >= 0);
const ownerFilter = await ev("(function(){var els=document.querySelectorAll(\"[aria-label]\");for(var i=0;i<els.length;i++){if((els[i].getAttribute(\"aria-label\")||\"\")===\"按负责人筛选\"){return true;}}return false;})()");
check("甘特图：负责人筛选控件在（按 ownerId 筛）", ownerFilter === true, String(ownerFilter));
const barTitle = await ev("(function(){var els=document.querySelectorAll(\"[title]\");for(var i=0;i<els.length;i++){var t=els[i].getAttribute(\"title\")||\"\";if(t.indexOf(\"回放任务·售前\")===0&&t.indexOf(\"开始 \")>0){return t;}}return \"\";})()");
check("甘特条：开始 9月1日 / 预计完成 9月10日（ISO 直接落点）", barTitle.indexOf("9月1日") >= 0 && barTitle.indexOf("9月10日") >= 0, flat(String(barTitle)).slice(0, 200));

// ---------- 清理 ----------
const leftovers = (await api("/api/v1/projects/" + projectId + "/tasks?limit=200")).json.items;
let deleted = 0;
for (const item of leftovers) {
  const res = await api("/api/v1/projects/" + projectId + "/tasks/" + item.id, "DELETE", undefined, { "If-Match": String(item.version) });
  if (res.status === 200 || res.status === 204) { deleted += 1; }
}
check("清理：逐条软删任务", deleted === leftovers.length && leftovers.length >= 2, String(deleted) + "/" + String(leftovers.length));
const emptyList = await api("/api/v1/projects/" + projectId + "/tasks?limit=200");
check("清理：任务读面归零", emptyList.json !== null && emptyList.json.total === 0, emptyList.json === null ? emptyList.text.slice(0, 120) : String(emptyList.json.total));
const projRow = await api("/api/v1/projects/" + projectId);
const delProj = await api("/api/v1/projects/" + projectId, "DELETE", undefined, { "If-Match": String(projRow.json.version) });
check("清理：删临时项目（200 / 204）", delProj.status === 200 || delProj.status === 204, String(delProj.status) + " " + delProj.text.slice(0, 120));
const gone = await api("/api/v1/projects/" + projectId);
check("清理：项目读面 404（物理删、行不存在）", gone.status === 404, String(gone.status));
await db.query("update sessions set revoked_at = now() where token_hash = $1", [sha256(token)]);
console.log("已撤销临时会话：" + userRow.username);

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
