/**
 * LibiaoLink 前端 · M3-05 余（第二段）回放：任务模板落库 + 模板页 / 添加任务卡片吃接口（Push 182）
 *
 * 前置（都在本机跑着）：
 *   1. 前端 dev：cd frontend && npm run dev（默认 3000）
 *   2. api：cd server && npm run start:api（默认 3001，需先 npm run build）
 *   3. 数据库：本地沙箱 PG（默认 127.0.0.1:5433/libiaolink）
 *   4. 本机装了 Chrome（脚本 headless 起一个调试实例；路径可用 CHROME_PATH 覆盖）
 *
 * 用法：node scripts/m3-05-task-templates-e2e.mjs
 *
 * 它做什么：用一条**临时会话**（跑完撤销）+ 一个**临时节点**（跑完删）+ 一份**临时模板**（跑完软删）+ 一个**临时项目**（跑完硬删）在真机浏览器里跑一遍：
 *   ① 模板页右侧面板 = 模板接口（面板数 / 名称 / 节点顺序与 GET /api/v1/task-templates?stage= 一致）；
 *   ② 「＋ 新建模板」→ POST 落库（默认名「未命名模板」、插到最前、焦点在名字上）；
 *   ③ 左列拖一个节点进新面板 → 面板内出现（本地草稿）；「保存」→ PATCH（nodeIds 全量替换 + version 0 → 1）；
 *   ④ **刷新页面**：新模板 / 名字 / 节点都还在（落库 = 刷新后保留）—— 这是第二段的核心验收点；
 *   ⑤ 面板红胶囊删除 → 底部确认条 → DELETE 软删（deleted_at 置位、读面 404、审计 action=delete）；
 *   ⑥ 乐观锁：拿旧 version 再 PATCH → 409 VERSION_CONFLICT；
 *   ⑦ 「项目总览 → 添加任务」卡片的「模板」标签 = 同一份模板接口（名称 / 节点数与接口一致）→ 点一条 → 任务落库；
 *   ⑧ 清理：临时节点删掉、临时任务软删、临时项目硬删、临时模板读面零残留。
 * 说明：任务模板写权限由部门规则裁决；本机 api 在 GROUP_ACCESS_ENFORCED=false 时不执行规则，
 *   因此本脚本不覆盖 403 分支。部门规则下的只读 / 仅登录拒绝由服务端单测与 group-access 回放覆盖。
 * 证据：docs/m3-05-回放证据(模板落库·前端).md
 */

import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
// pg 只用来核对两处落库口径（task_templates / task_template_nodes 行 / audit_logs 留痕）—— 前端不新装依赖，复用 server 的依赖解析。
const PG_MODULE = process.env.PG_MODULE ?? new URL("../../server/node_modules/pg/lib/index.js", import.meta.url).href;
const { default: pg } = await import(PG_MODULE);

const { Client } = pg;
const FRONTEND = process.env.FRONTEND_BASE ?? "http://localhost:3000";
const API = process.env.API_BASE ?? "http://127.0.0.1:3001";
const CHROME = process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PORT = Number(process.env.CDP_PORT ?? 9398);
const DB = process.env.DATABASE_URL ?? "postgres://libiaolink_api@127.0.0.1:5433/libiaolink";
const REPLAY_USER = process.env.REPLAY_USER ?? "px-replay";
const sha256 = (text) => createHash("sha256").update(text).digest("hex");
/** 探针里的引号一律用 String.fromCharCode 生成（这个脚本自己也是被这样写出来的）。 */
const Q = String.fromCharCode(34);
const q = (text) => Q + text + Q;

const db = new Client({ connectionString: DB });
await db.connect();
const userRow = (await db.query("select id, username, display_name from users where username = $1 and status = 'active'", [REPLAY_USER])).rows[0];
if (userRow === undefined) {
  console.error("回放用户不存在：" + REPLAY_USER);
  process.exit(1);
}
const token = "pxtpl-" + randomBytes(16).toString("hex");
const csrf = randomBytes(16).toString("hex");
await db.query("insert into sessions (token_hash, user_id, id_token, expires_at) values ($1, $2, $3, now() + make_interval(mins => 30))", [sha256(token), userRow.id, "px-tpl-e2e"]);
console.log("临时会话：" + userRow.username + "（" + userRow.display_name + "）");

const profile = mkdtempSync(join(tmpdir(), "pxtpl-"));
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
    this.ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(typeof ev.data === "string" ? ev.data : String(ev.data));
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const item = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) item.reject(new Error(JSON.stringify(msg.error))); else item.resolve(msg.result);
        return;
      }
      if (msg.method === "Runtime.exceptionThrown" || msg.method === "Log.entryAdded" || msg.method === "Runtime.consoleAPICalled") {
        this.events.push("EVT " + msg.method + " " + JSON.stringify(msg.params).slice(0, 400));
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
  checks.push(ok === true);
  console.log((ok === true ? "PASS  " : "FAIL  ") + name + (detail === undefined ? "" : "   [" + detail + "]"));
}

// ---------- 探针（引号一律用 q() / JSON.stringify 生成）----------
/** 右侧某一块模板面板（按名字找 section[data-template-panel]）：找不到 = null。 */
const PANEL = (name) => "(function(){var ss=document.querySelectorAll(" + q("[data-template-panel]") + ");for(var i=0;i<ss.length;i++){var a=ss[i].getAttribute(" + q("aria-label") + ")||" + q("") + ";if(a===" + JSON.stringify("模板 " + name) + "){return ss[i];}}return null;})()";
/** 面板标题行 + 卡片标题（面板不存在时 null）。 */
const PANEL_TITLES = (name) => "(function(){var s=" + PANEL(name) + ";if(s===null){return null;}var es=s.querySelectorAll(" + q("article") + ");var out=[];for(var i=0;i<es.length;i++){out.push(es[i].getAttribute(" + q("title") + ")||" + q("") + ");}return out;})()";
/** 全部面板的名字（按 DOM 顺序）。 */
const PANEL_NAMES = "(function(){var ss=document.querySelectorAll(" + q("[data-template-panel]") + ");var out=[];for(var i=0;i<ss.length;i++){var t=ss[i].querySelector(" + q("input") + ");out.push(t===null?" + q("") + ":t.value);}return out;})()";
/** 每块面板的「已选节点数」文本（第 i 块 = 数组第 i 个）。 */
const PANEL_COUNTS = "(function(){var ss=document.querySelectorAll(" + q("[data-template-panel]") + ");var out=[];for(var i=0;i<ss.length;i++){var cs=ss[i].querySelectorAll(" + q("span") + ");var v=" + q("") + ";for(var j=0;j<cs.length;j++){if((cs[j].getAttribute(" + q("aria-label") + ")||" + q("") + ")===" + q("已选节点数") + "){v=(cs[j].textContent||" + q("") + ").trim();}}out.push(v);}return out;})()";
/** 某块面板的「保存 / 已保存 / 保存中…」按钮文案（面板不存在 / 只读 = null）。 */
const PANEL_SAVE_TEXT = (name) => "(function(){var s=" + PANEL(name) + ";if(s===null){return null;}var bs=s.querySelectorAll(" + q("button") + ");for(var i=0;i<bs.length;i++){var t=(bs[i].textContent||" + q("") + ").trim();if(t===" + q("保存") + "||t===" + q("已保存") + "||t===" + q("保存中…") + "){return t;}}return null;})()";
/** 某块面板的名称输入框（用来改名 / 读回名字）。 */
const PANEL_NAME_INPUT = (name) => "(function(){var s=" + PANEL(name) + ";if(s===null){return null;}return s.querySelector(" + q("input") + ");})()";
/** 用 aria-label 点某块面板里的按钮（保存 / 删除模板 X）。 */
const CLICK_BY_LABEL = (label) => "(function(){var bs=document.querySelectorAll(" + q("button") + ");for(var i=0;i<bs.length;i++){if((bs[i].getAttribute(" + q("aria-label") + ")||" + q("") + ")===" + JSON.stringify(label) + "){bs[i].click();return true;}}return false;})()";
/** 左列「任务节点」section（第一段同款：innerText 以「任务节点」开头的 section）。 */
const LEFT_SECTION = "(function(){var ss=document.querySelectorAll(" + q("section") + ");for(var i=0;i<ss.length;i++){if((ss[i].innerText||" + q("") + ").indexOf(" + q("任务节点") + ")===0){return ss[i];}}return null;})()";
/** 左列里某标题的卡片（返回 DOM 元素给 CDP 量坐标；不要交给 returnByValue）。 */
const LEFT_CARD = (title) => "(function(){var s=" + LEFT_SECTION + ";if(s===null){return null;}var es=s.querySelectorAll(" + q("article") + ");for(var i=0;i<es.length;i++){var t=es[i].getAttribute(" + q("title") + ")||" + q("") + ";if(t.indexOf(" + JSON.stringify(title) + ")===0){return es[i];}}return null;})()";
/** 点某块面板里的「保存」按钮（按钮无 aria-label，按文案点）。 */
const CLICK_PANEL_SAVE = (name) => "(function(){var s=" + PANEL(name) + ";if(s===null){return false;}var bs=s.querySelectorAll(" + q("button") + ");for(var i=0;i<bs.length;i++){if((bs[i].textContent||" + q("") + ").trim()===" + q("保存") + "){bs[i].click();return true;}}return false;})()";
/** 按 aria-label 填输入框（React 受控输入：用原生 setter + input 事件）。 */
const FILL_BY_LABEL = (label, value) => "(function(){var el=null;var es=document.querySelectorAll(" + q("input") + ");for(var i=0;i<es.length;i++){if((es[i].getAttribute(" + q("aria-label") + ")||" + q("") + ")===" + JSON.stringify(label) + "){el=es[i];}}if(el===null){return false;}var setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype," + q("value") + ").set;setter.call(el," + JSON.stringify(value) + ");el.dispatchEvent(new Event(" + q("input") + ",{bubbles:true}));return true;})()";
/**
 * 拖拽前置（一个 evaluate 里量完两支坐标，别分两次 —— 量第二次会把页面滚走、第一次量的坐标就失效了）：
 * ① 把**目标面板**滚进视口居中（同一行等高：空面板会被同一行里最长的面板撑高，只滚左列卡片的话落点会掉到屏幕外）；
 * ② 量左列卡片中心；③ 在「拖到这里」那块上取一个**当前视口内**的点；
 * ④ 自检两点真能命中（`elementFromPoint`）—— 落点必须落在这一块面板里，拖动前就知道会不会落空。
 */
const DRAG_PREP = (title, panelName) => "(function(){var s=" + PANEL(panelName) + ";var card=" + LEFT_CARD(title) + ";if(s===null||card===null){return null;}s.scrollIntoView({block:" + q("center") + "});var target=null;var ps=s.querySelectorAll(" + q("p") + ");for(var i=0;i<ps.length;i++){if((ps[i].textContent||" + q("") + ").indexOf(" + q("拖到这里") + ")>=0){target=ps[i];}}var body=target===null?s:target;var br=body.getBoundingClientRect();var px=br.left+br.width/2;var lo=Math.max(br.top,4)+12;var hi=Math.min(br.bottom,window.innerHeight-4)-12;var py=lo<=hi?(lo+hi)/2:Math.min(Math.max(br.top+12,4),window.innerHeight-4);var cr=card.getBoundingClientRect();var cx=cr.left+cr.width/2;var cy=cr.top+cr.height/2;var hitCard=document.elementFromPoint(cx,cy);var hitPanel=document.elementFromPoint(px,py);return {card:{x:cx,y:cy},panel:{x:px,y:py},onCard:hitCard!==null&&card.contains(hitCard),inPanel:hitPanel!==null&&s.contains(hitPanel),viewport:{w:window.innerWidth,h:window.innerHeight}};})()";

/** 点「＋ 新建模板」。 */
const CLICK_NEW_TEMPLATE = "(function(){var bs=document.querySelectorAll(" + q("button") + ");for(var i=0;i<bs.length;i++){if((bs[i].textContent||" + q("") + ").indexOf(" + q("新建模板") + ")>=0){bs[i].click();return true;}}return false;})()";
/** 新建模板按钮还在不在（只读账号不渲染）。 */
const HAS_NEW_TEMPLATE_BUTTON = "(function(){var bs=document.querySelectorAll(" + q("button") + ");for(var i=0;i<bs.length;i++){if((bs[i].textContent||" + q("") + ").indexOf(" + q("新建模板") + ")>=0){return true;}}return false;})()";
const CONFIRM_BAR_TEXT = "(function(){var ds=document.querySelectorAll(" + q("[role=dialog]") + ");for(var i=0;i<ds.length;i++){var t=ds[i].innerText||" + q("") + ";if(t.indexOf(" + q("模板库里的这一份会被删掉") + ")>=0){return t;}}return null;})()";
const CLICK_CONFIRM_DELETE = "(function(){var ds=document.querySelectorAll(" + q("[role=dialog]") + ");for(var i=0;i<ds.length;i++){var t=ds[i].innerText||" + q("") + ";if(t.indexOf(" + q("模板库里的这一份会被删掉") + ")>=0){var bs=ds[i].querySelectorAll(" + q("button") + ");for(var j=0;j<bs.length;j++){if((bs[j].textContent||" + q("") + ").trim()===" + q("删除") + "){bs[j].click();return true;}}}}return false;})()";
/** 添加任务卡片（项目总览）里的标签导航：某个模板标签的按钮。 */
const CARD_TAB = (name) => "(function(){var bs=document.querySelectorAll(" + q("button") + ");for(var i=0;i<bs.length;i++){var t=(bs[i].textContent||" + q("") + ").split(String.fromCharCode(10)).join(String.fromCharCode(32)).trim();if(t.indexOf(" + JSON.stringify(name) + ")===0){bs[i].click();return true;}}return false;})()";
const CARD_ROWS = "(function(){var out=[];var bs=document.querySelectorAll(" + q("button") + ");for(var i=0;i<bs.length;i++){var t=(bs[i].textContent||" + q("") + ").split(String.fromCharCode(10)).join(String.fromCharCode(32)).trim();if(t.indexOf(" + q("＋ 添加") + ")>=0||t.indexOf(" + q("已添加") + ")>=0){out.push(t.slice(0,48));}}return out;})()";
const CARD_ADD_ROW = (title) => "(function(){var bs=document.querySelectorAll(" + q("button") + ");for(var i=0;i<bs.length;i++){var t=(bs[i].textContent||" + q("") + ").split(String.fromCharCode(10)).join(String.fromCharCode(32));if(t.indexOf(" + JSON.stringify(title) + ")>=0&&t.indexOf(" + q("＋ 添加") + ")>=0){bs[i].click();return true;}}return false;})()";
const CLICK_STAGE_PILL = (stage) => "(function(){var ps=document.querySelectorAll(" + q("[data-stage-pill]") + ");for(var i=0;i<ps.length;i++){if((ps[i].textContent||" + q("") + ").indexOf(" + JSON.stringify(stage) + ")>=0){ps[i].click();return true;}}return false;})()";
/** 卡片里「节点 N 个 · 模板 M 块」那一行。 */
const CARD_COUNTS = "(function(){var ps=document.querySelectorAll(" + q("p") + ");for(var i=0;i<ps.length;i++){var t=(ps[i].textContent||" + q("") + ").trim();if(t.indexOf(" + q("模板") + ")>=0&&t.indexOf(" + q("块") + ")>=0){return t;}}return null;})()";

/** Push 235 吸顶断言：元素几何 / 样式读数（不存在 = null）。 */
const RECT_OF = (selector) => "(function(){var el=document.querySelector(" + JSON.stringify(selector) + ");if(el===null){return null;}var r=el.getBoundingClientRect();var cs=getComputedStyle(el);return {top:Math.round(r.top*100)/100,left:Math.round(r.left*100)/100,right:Math.round(r.right*100)/100,height:Math.round(r.height*100)/100,position:cs.position,zIndex:cs.zIndex,bg:String(cs.backgroundColor),blur:String(cs.backdropFilter||cs.webkitBackdropFilter)};})()";
const TABS_RECT = RECT_OF("[data-template-tabs]");
const LEFT_SECTION_RECT = "(function(){var ss=document.querySelectorAll(" + q("section") + ");for(var i=0;i<ss.length;i++){if((ss[i].innerText||" + q("") + ").indexOf(" + q("任务节点") + ")===0){var cs=getComputedStyle(ss[i]);var r=ss[i].getBoundingClientRect();var p=ss[i].parentElement;var pz=p===null?null:getComputedStyle(p).zIndex;return {position:cs.position,cssTop:cs.top,top:Math.round(r.top*100)/100,height:Math.round(r.height*100)/100,parentZ:pz};}}return null;})()";
const BAR_BUTTONS = "(function(){var bs=document.querySelectorAll(" + q("[data-template-tabs] button") + ");var out=[];for(var i=0;i<bs.length;i++){out.push((bs[i].textContent||" + q("") + ").trim());}return out;})()";
const BAR_HIT = "(function(){var bs=document.querySelectorAll(" + q("[data-template-tabs] button") + ");for(var i=0;i<bs.length;i++){if(bs[i].getAttribute(" + q("aria-current") + ")===" + q("page") + "){var r=bs[i].getBoundingClientRect();var el=document.elementFromPoint(Math.round(r.left+r.width/2),Math.round(r.top+r.height/2));return el!==null&&(el===bs[i]||bs[i].contains(el));}}return null;})()";
const BAR_TITLE_ATTRS = "(function(){var bs=document.querySelectorAll(" + q("[data-template-tabs] button") + ");var out=[];for(var i=0;i<bs.length;i++){out.push(bs[i].getAttribute(" + q("title") + "));}return out;})()";
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
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ev = async (expression) => (await page.send("Runtime.evaluate", { expression, returnByValue: true })).result.value;
/** 取元素中心坐标（拖拽用）：元素不存在 = null。 */
const centerOf = async (expression) => {
  const box = (await page.send("Runtime.evaluate", { expression: "(function(){var el=" + expression + ";if(el===null){return null;}var r=el.getBoundingClientRect();return { x: r.left + r.width / 2, y: r.top + r.height / 2 };})()", returnByValue: true })).result.value;
  return box === null || box === undefined ? null : box;
};
/** 真鼠标拖拽（走 Chrome 输入通道 = 真指针事件，落点判定用 elementFromPoint 也成立）。 */
const drag = async (from, to) => {
  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: from.x, y: from.y, buttons: 0 });
  await page.send("Input.dispatchMouseEvent", { type: "mousePressed", x: from.x, y: from.y, button: "left", buttons: 1, clickCount: 1 });
  for (let step = 1; step <= 6; step += 1) {
    const x = from.x + ((to.x - from.x) * step) / 6;
    const y = from.y + ((to.y - from.y) * step) / 6;
    await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "left", buttons: 1 });
    await sleep(60);
  }
  await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: to.x, y: to.y, button: "left", buttons: 0, clickCount: 1 });
};
const flat = (text) => String(text).split(String.fromCharCode(10)).join(" | ");

const TEMPLATES_URL = FRONTEND + "/#/templates?section=hardware";
const stageName = "硬件实施";
const stageKey = "install";
const nodeTitle = "回放节点·模板-" + randomBytes(3).toString("hex");
const templateName = "回放模板-" + randomBytes(3).toString("hex");
let nodeId = "";
let templateId = "";
let baselineTotal = -1;
let baselineFirst = null;
let projectId = "";
let createdTaskId = "";

try {
  // ---------- 夹具 ----------
  const me = await api("/api/v1/permissions/me");
  const keys = me.json === null ? [] : me.json.permissions.permissionKeys;
  check("夹具：回放账号持有 blueprint.manage（新建 / 保存 / 删除入口才渲染）", keys.indexOf("blueprint.manage") >= 0, keys.length + " 个权限位");

  const baseline = await api("/api/v1/task-templates?stage=" + stageKey);
  check("夹具：GET /api/v1/task-templates?stage=install 可用", baseline.status === 200, String(baseline.status) + " " + baseline.text.slice(0, 120));
  baselineTotal = baseline.json === null ? -1 : baseline.json.total;
  baselineFirst = baseline.json === null || baseline.json.items.length === 0 ? null : baseline.json.items[0];
  check("夹具：该阶段种子模板已入库（>0 份）", baselineTotal > 0, String(baselineTotal) + " 份");

  // 临时节点（拖进模板的那一条；跑完物理删掉）
  const createdNode = await api("/api/v1/task-nodes", "POST", { stageKey, title: nodeTitle, titleEn: "Replay node for template" });
  check("夹具：建临时节点（201）", createdNode.status === 201, String(createdNode.status) + " " + createdNode.text.slice(0, 140));
  nodeId = createdNode.json === null ? "" : createdNode.json.id;

  // ---------- ① 模板页 = 模板接口 ----------
  await page.send("Page.navigate", { url: TEMPLATES_URL });
  await sleep(5000);
  const names = await ev(PANEL_NAMES);
  check("面板数 = 服务端 total（" + String(baselineTotal) + "）", names !== null && names.length === baselineTotal, "页面 " + String(names === null ? -1 : names.length));
  check("面板名 = 服务端下发（第一块 = " + String(baselineFirst === null ? "" : baselineFirst.name) + "）", names !== null && baselineFirst !== null && names[0] === baselineFirst.name, flat(names === null ? "" : names.join(" / ")));
  const counts = await ev(PANEL_COUNTS);
  check("第一块面板节点数 = 服务端 nodes 长度（" + String(baselineFirst === null ? -1 : baselineFirst.nodes.length) + "）", counts !== null && baselineFirst !== null && counts[0] === baselineFirst.nodes.length + " 个", flat(counts === null ? "" : counts.join(" / ")));
  const firstNodes = await ev(PANEL_TITLES(baselineFirst === null ? "" : baselineFirst.name));
  const expectTitles = baselineFirst === null ? [] : baselineFirst.nodes.slice(0, 3).map((node) => node.title);
  check("面板内卡片顺序 = 服务端 seq 顺序（前 3 条）", firstNodes !== null && expectTitles.every((title, index) => String(firstNodes[index]).indexOf(title) === 0), flat(firstNodes === null ? "" : firstNodes.slice(0, 3).join(" / ")));
  check("「＋ 新建模板」入口在（写权限账号）", (await ev(HAS_NEW_TEMPLATE_BUTTON)) === true);

  // ---------- ② 新建模板（POST）----------
  check("点「＋ 新建模板」", (await ev(CLICK_NEW_TEMPLATE)) === true);
  await sleep(2600);
  const afterCreate = await api("/api/v1/task-templates?stage=" + stageKey);
  check("新建落库：total +1", afterCreate.json !== null && afterCreate.json.total === baselineTotal + 1, String(baselineTotal) + " -> " + String(afterCreate.json === null ? -1 : afterCreate.json.total));
  const namesAfterCreate = await ev(PANEL_NAMES);
  check("新面板插到最前（默认名「未命名模板」）", namesAfterCreate !== null && namesAfterCreate[0] === "未命名模板" && namesAfterCreate.length === baselineTotal + 1, flat(namesAfterCreate === null ? "" : namesAfterCreate.join(" / ")));
  const created = afterCreate.json === null ? undefined : afterCreate.json.items.filter((item) => item.name === "未命名模板")[0];
  templateId = created === undefined ? "" : created.id;
  check("服务端那份是新模板（version 0 / nodes 空）", created !== undefined && created.version === 0 && created.nodes.length === 0, created === undefined ? "未找到" : JSON.stringify({ id: created.id, version: created.version, nodes: created.nodes.length }));
  const focusProbe = await ev("(function(){var el=document.activeElement;if(el===null){return null;}return {tag:el.tagName,label:el.getAttribute(" + q("aria-label") + ")||" + q("") + ",value:el.value===undefined?" + q("") + ":el.value,sel:typeof el.selectionStart===" + q("number") + "?el.selectionStart:-1,end:typeof el.selectionEnd===" + q("number") + "?el.selectionEnd:-1};})()");
  check("焦点落在新面板的名字输入框上（名字处于全选态）", focusProbe !== null && focusProbe.label === "模板名称" && focusProbe.value === "未命名模板" && focusProbe.sel === 0 && focusProbe.end === focusProbe.value.length, JSON.stringify(focusProbe));

  // 改名（本地草稿）
  check("改名为「" + templateName + "」", (await ev("(function(){var el=" + PANEL_NAME_INPUT("未命名模板") + ";if(el===null){return false;}var setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype," + q("value") + ").set;setter.call(el," + JSON.stringify(templateName) + ");el.dispatchEvent(new Event(" + q("input") + ",{bubbles:true}));return true;})()")) === true);
  await sleep(400);
  check("改完是未保存态（按钮显示「保存」）", (await ev(PANEL_SAVE_TEXT(templateName))) === "保存", String(await ev(PANEL_SAVE_TEXT(templateName))));

  // ---------- ③ 拖节点进面板 + 保存（PATCH）----------
  check("左列搜索框筛出临时节点（拖拽前置）", (await ev(FILL_BY_LABEL("搜索任务节点", nodeTitle))) === true);
  await sleep(600);
  const prep = await ev(DRAG_PREP(nodeTitle, templateName));
  check("拖拽前置：卡片与面板落点都能命中（落点必须在同一块面板内）", prep !== null && prep.onCard === true && prep.inPanel === true, JSON.stringify(prep));
  if (prep !== null && prep.onCard === true && prep.inPanel === true) {
    await drag(prep.card, prep.panel);
    await sleep(900);
  }
  const nodesInPanel = await ev(PANEL_TITLES(templateName));
  check("拖入后节点出现在面板里", nodesInPanel !== null && nodesInPanel.length === 1 && String(nodesInPanel[0]).indexOf(nodeTitle) === 0, flat(nodesInPanel === null ? "" : nodesInPanel.join(" / ")));
  check("面板计数变 1 个", (await ev(PANEL_COUNTS))[0] === "1 个", String((await ev(PANEL_COUNTS))[0]));
  check("有改动 = 未保存态（按钮仍是「保存」）", (await ev(PANEL_SAVE_TEXT(templateName))) === "保存");
  check("点「保存」", (await ev(CLICK_PANEL_SAVE(templateName))) === true);
  await sleep(2600);
  const savedList = await api("/api/v1/task-templates?stage=" + stageKey);
  const saved = savedList.json === null ? undefined : savedList.json.items.filter((item) => item.id === templateId)[0];
  check("PATCH 落库：名字 = 改后的名字", saved !== undefined && saved.name === templateName, saved === undefined ? "未找到" : saved.name);
  check("PATCH 落库：nodes = 拖进去的那一条（seq 10）", saved !== undefined && saved.nodes.length === 1 && saved.nodes[0].nodeId === nodeId && saved.nodes[0].seq === 10, saved === undefined ? "" : JSON.stringify(saved.nodes));
  check("乐观锁 version 0 -> 1", saved !== undefined && saved.version === 1, saved === undefined ? "" : "v" + String(saved.version));
  check("按钮回到「已保存」", (await ev(PANEL_SAVE_TEXT(templateName))) === "已保存", String(await ev(PANEL_SAVE_TEXT(templateName))));
  const dbTemplate = templateId === "" ? { rows: [] } : await db.query("select name, stage_key, version, deleted_at from task_templates where id = $1", [templateId]);
  check("DB 行：task_templates 有名字 / 阶段 / version=1 / 未软删", dbTemplate.rows.length === 1 && dbTemplate.rows[0].name === templateName && dbTemplate.rows[0].stage_key === stageKey && dbTemplate.rows[0].version === 1 && dbTemplate.rows[0].deleted_at === null, JSON.stringify(dbTemplate.rows[0]));
  const dbLinks = templateId === "" ? { rows: [] } : await db.query("select seq from task_template_nodes where template_id = $1 order by seq", [templateId]);
  check("DB 引用行：task_template_nodes 一条（seq=10）", dbLinks.rows.length === 1 && dbLinks.rows[0].seq === 10, JSON.stringify(dbLinks.rows));
  const dbAudit = templateId === "" ? { rows: [] } : await db.query("select action, object_type, summary, changes from audit_logs where object_type = $1 and object_id = $2 order by id", ["task_template", templateId]);
  check("审计：create + update 各一条（object_type = task_template）", dbAudit.rows.length === 2 && dbAudit.rows[0].action === "create" && dbAudit.rows[1].action === "update", dbAudit.rows.map((row) => row.action).join(" / "));
  check("审计 update 记了节点名变化（changes.nodes）", dbAudit.rows.length === 2 && JSON.stringify(dbAudit.rows[1].changes).indexOf(nodeTitle) >= 0, JSON.stringify(dbAudit.rows[1].changes).slice(0, 160));

  // ---------- ④ 硬刷新后保留（落库的核心验收点）----------
  // 先做一处**不保存**的本地改名：硬刷新后它必须消失 —— 否则说明页面根本没重载，"刷新后还在"就是假的
  check("刷新前先留一处未保存的本地改名", (await ev("(function(){var el=" + PANEL_NAME_INPUT(templateName) + ";if(el===null){return false;}var setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype," + q("value") + ").set;setter.call(el," + JSON.stringify(templateName + "-未保存") + ");el.dispatchEvent(new Event(" + q("input") + ",{bubbles:true}));return true;})()")) === true);
  await sleep(400);
  check("未保存态：按钮显示「保存」", (await ev(PANEL_SAVE_TEXT(templateName + "-未保存"))) === "保存", String(await ev(PANEL_SAVE_TEXT(templateName + "-未保存"))));
  // Page.reload = 真重载文档（Page.navigate 到同一个带 hash 的地址属于同文档跳转，不会重载 —— 那一步验不出落库）
  await page.send("Page.reload", { ignoreCache: true });
  await sleep(5500);
  const namesAfterReload = await ev(PANEL_NAMES);
  check("硬刷新后新模板还在（名字 = 库里那份，未保存的本地改名已消失）", namesAfterReload !== null && namesAfterReload.indexOf(templateName) >= 0 && namesAfterReload.indexOf(templateName + "-未保存") < 0, flat(namesAfterReload === null ? "" : namesAfterReload.join(" / ")));
  const orderAfterReload = await api("/api/v1/task-templates?stage=" + stageKey);
  const expectOrder = orderAfterReload.json === null ? [] : orderAfterReload.json.items.map((item) => item.name);
  check("硬刷新后：面板顺序与名字 = 接口下发（页面不留任何内存草稿）", namesAfterReload !== null && JSON.stringify(namesAfterReload) === JSON.stringify(expectOrder), flat(namesAfterReload === null ? "" : namesAfterReload.join(" / ")) + " ↔ " + expectOrder.join(" / "));
  const nodesAfterReload = await ev(PANEL_TITLES(templateName));
  check("刷新后节点还在面板里（落库 + 读面 join 节点库）", nodesAfterReload !== null && nodesAfterReload.length === 1 && String(nodesAfterReload[0]).indexOf(nodeTitle) === 0, flat(nodesAfterReload === null ? "" : nodesAfterReload.join(" / ")));
  check("刷新后是已保存态", (await ev(PANEL_SAVE_TEXT(templateName))) === "已保存", String(await ev(PANEL_SAVE_TEXT(templateName))));

  // ---------- ⑤ 乐观锁：旧 version → 409 ----------
  const stale = templateId === "" ? { status: 0, json: null, text: "（模板未建出，跳过）" } : await api("/api/v1/task-templates/" + templateId, "PATCH", { name: "过期写入", version: 0 });
  check("旧 version 再 PATCH → 409 VERSION_CONFLICT", stale.status === 409 && stale.json !== null && stale.json.code === "VERSION_CONFLICT", String(stale.status) + " " + stale.text.slice(0, 120));
  const staleDelete = templateId === "" ? { status: 0, json: null, text: "（模板未建出，跳过）" } : await api("/api/v1/task-templates/" + templateId, "DELETE", { version: 0 });
  check("旧 version DELETE → 409 VERSION_CONFLICT（模板还在）", staleDelete.status === 409, String(staleDelete.status));

  // ---------- ⑥ 添加任务卡片的「模板」标签 = 同一份接口 ----------
  const projectCode = "PX-TPL-" + randomBytes(3).toString("hex").toUpperCase();
  const project = await api("/api/v1/projects", "POST", { code: projectCode, name: "模板回放", managerIds: [userRow.id] });
  check("夹具：建临时项目（201）", project.status === 201, String(project.status) + " " + project.text.slice(0, 140));
  projectId = project.json === null ? "" : project.json.id;
  await page.send("Page.navigate", { url: FRONTEND + "/#/project/" + projectId });
  await sleep(4500);
  check("点「" + stageName + "」阶段标签打开添加卡片", (await ev(CLICK_STAGE_PILL(stageName))) === true);
  await sleep(1800);
  const cardCounts = await ev(CARD_COUNTS);
  check("卡片计数行 = 接口模板数（模板 " + String(baselineTotal + 1) + " 块）", cardCounts !== null && String(cardCounts).indexOf("模板 " + String(baselineTotal + 1) + " 块") >= 0, String(cardCounts));
  check("卡片里有「" + templateName + "」标签（模板接口同源）", (await ev(CARD_TAB(templateName))) === true);
  await sleep(900);
  const rows = await ev(CARD_ROWS);
  check("模板标签里 = 该模板的节点（拖进去的那一条）", rows !== null && rows.some((row) => String(row).indexOf(nodeTitle) >= 0), (rows === null ? [] : rows).join(" ／ ").slice(0, 200));
  check("点这一行「＋ 添加」", (await ev(CARD_ADD_ROW(nodeTitle))) === true);
  await sleep(4200);
  const taskList = await api("/api/v1/projects/" + projectId + "/tasks?limit=200");
  const createdTask = taskList.json === null ? undefined : taskList.json.items.filter((item) => item.title === nodeTitle)[0];
  check("任务落库（阶段 = 硬件实施）", createdTask !== undefined && createdTask.stageKey === stageKey, createdTask === undefined ? "未找到" : JSON.stringify({ title: createdTask.title, stageKey: createdTask.stageKey }));
  createdTaskId = createdTask === undefined ? "" : createdTask.id;

  // ---------- ⑦ 删除模板（红胶囊 → 确认条 → 软删）----------
  await page.send("Page.navigate", { url: TEMPLATES_URL });
  await sleep(5000);
  check("点面板上的红胶囊删除按钮", (await ev(CLICK_BY_LABEL("删除模板 " + templateName))) === true);
  await sleep(700);
  const barText = await ev(CONFIRM_BAR_TEXT);
  check("底部确认条出现（写着「模板库里的这一份会被删掉」）", barText !== null && String(barText).indexOf(templateName) >= 0, flat(barText === null ? "" : barText).slice(0, 200));
  check("点确认条上的「删除」", (await ev(CLICK_CONFIRM_DELETE)) === true);
  await sleep(2600);
  check("面板消失（DOM）", (await ev(PANEL(templateName))) === null);
  const afterDelete = await api("/api/v1/task-templates?stage=" + stageKey);
  check("接口 total 回到基线（读面零残留）", afterDelete.json !== null && afterDelete.json.total === baselineTotal, String(afterDelete.json === null ? -1 : afterDelete.json.total));
  const detail = templateId === "" ? { status: 0, json: null, text: "" } : await api("/api/v1/task-templates/" + templateId);
  check("已软删的模板详情 → 404 NOT_FOUND", detail.status === 404 && detail.json !== null && detail.json.code === "NOT_FOUND", String(detail.status));
  const dbDeleted = templateId === "" ? { rows: [] } : await db.query("select deleted_at is not null as soft, deleted_by = $2 as by_actor, version from task_templates where id = $1", [templateId, userRow.id]);
  check("DB 软删：deleted_at 置位 + deleted_by = 回放账号 + version 前进到 2", dbDeleted.rows.length === 1 && dbDeleted.rows[0].soft === true && dbDeleted.rows[0].by_actor === true && dbDeleted.rows[0].version === 2, JSON.stringify(dbDeleted.rows[0]));
  const linksAfterDelete = templateId === "" ? { rows: [{ c: -1 }] } : await db.query("select count(*)::int as c from task_template_nodes where template_id = $1", [templateId]);
  check("引用行保留（软删只打标、不连带清子表：task_template_nodes 仍 1 条，读面靠 deleted_at 过滤）", linksAfterDelete.rows[0].c === 1, String(linksAfterDelete.rows[0].c));
  const auditDelete = templateId === "" ? { rows: [] } : await db.query("select action, changes from audit_logs where object_type = $1 and object_id = $2 order by id", ["task_template", templateId]);
  check("审计：删模板再记一条 action=delete（快照含节点名）", auditDelete.rows.length === 3 && auditDelete.rows[2].action === "delete" && JSON.stringify(auditDelete.rows[2].changes).indexOf(nodeTitle) >= 0, auditDelete.rows.map((row) => row.action).join(" / "));
  // ---------- ⑨ 板块标签栏吸顶（Push 235 · 业务口径「任务模版和我的任务都要做吸顶效果」） ----------
  // 口径（同项目详情主标签栏 Push 201 一套）：滚动时停在应用顶栏（h-16 = 64px）正下方；左列「任务节点」的吸顶位顺延到它下面（122 = 64 + 59 − 1 防缝）。
  await page.send("Page.navigate", { url: TEMPLATES_URL });
  await sleep(4500);
  const tabsSlot0 = await ev(TABS_RECT);
  check("⑨a 板块标签栏 = sticky / z 20 / 站灰底（α 0.95）+ 毛玻璃 / 自然位在顶栏下沿（top 64~65.5，滚动后钉到 64）", tabsSlot0 !== null && tabsSlot0.position === "sticky" && tabsSlot0.top >= 64 && tabsSlot0.top <= 65.5 && tabsSlot0.zIndex === "20" && tabsSlot0.bg.indexOf("0.95") >= 0 && tabsSlot0.blur.indexOf("blur") >= 0, tabsSlot0 === null ? "null" : JSON.stringify(tabsSlot0));
  const room235 = await ev("(function(){return Math.round((document.documentElement.scrollHeight - window.innerHeight)*100)/100;})()");
  check("⑨b 页面可滚动量足够（≥ 400px —— 吸顶要真滚起来才验得到）", typeof room235 === "number" && room235 >= 400, String(room235));
  await ev("window.scrollTo(0, 420)");
  await sleep(400);
  const scrolled235 = await ev("window.scrollY");
  check("⑨c 滚动实际发生（scrollY ≥ 400）", scrolled235 >= 400, String(scrolled235));
  const tabsSlot1 = await ev(TABS_RECT);
  check("⑨d 滚动后标签栏钉在顶栏正下方（top = 64；栏高 = 59 = pt-3 12 + 标签 46 + 底边 1）", tabsSlot1 !== null && Math.abs(tabsSlot1.top - 64) <= 0.5 && Math.abs(tabsSlot1.height - 59) <= 1, tabsSlot1 === null ? "null" : JSON.stringify([tabsSlot1.top, tabsSlot1.height]));
  const clientW = await ev("document.documentElement.clientWidth");
  check("⑨e 横幅铺满行宽（-mx-6 抵消后 left = 0 / right = 视口可用宽 clientWidth，扣纵向滚动条；页面不因此横向滚动）", tabsSlot1 !== null && Math.abs(tabsSlot1.left) <= 0.5 && Math.abs(tabsSlot1.right - clientW) <= 0.5 && (await ev("document.documentElement.scrollWidth")) <= clientW + 1, tabsSlot1 === null ? "null" : JSON.stringify([tabsSlot1.left, tabsSlot1.right, clientW]));
  const leftCol1 = await ev(LEFT_SECTION_RECT);
  check("⑨f 左列「任务节点」吸顶位顺延到标签栏下沿（position=sticky、CSS top = 122px = 64 + 59 − 1 防缝）", leftCol1 !== null && leftCol1.position === "sticky" && leftCol1.cssTop === "122px", leftCol1 === null ? "null" : JSON.stringify(leftCol1));
  check("⑨g 层级：标签栏 z 20 > 左列容器 z 10（左列滚动时从栏下滑过、不盖住栏；真机内容里左列与右侧模板区等高、钉住位移趋近 0，口径为右侧更高时生效）", leftCol1 !== null && leftCol1.parentZ === "10" && tabsSlot1 !== null && Number(tabsSlot1.zIndex) > Number(leftCol1.parentZ), leftCol1 === null ? "null" : JSON.stringify([tabsSlot1 === null ? null : tabsSlot1.zIndex, leftCol1.parentZ]));
  const barButtons = await ev(BAR_BUTTONS);
  check("⑨h 滚动后栏内九枚板块 + 「＋ 新建模板」都在（10 枚按钮、无吞字）", barButtons !== null && barButtons.length === 10 && barButtons[0] === "售前规划" && barButtons[9].indexOf("新建模板") >= 0, barButtons === null ? "null" : JSON.stringify(barButtons));
  const barTitleAttrs = await ev(BAR_TITLE_ATTRS);
  check("⑨h-2 板块标签悬停不暴露内部路由（九枚阶段按钮均无 title）", barTitleAttrs !== null && barTitleAttrs.slice(0, 9).every((value) => value === null), barTitleAttrs === null ? "null" : JSON.stringify(barTitleAttrs));
  const barHit = await ev(BAR_HIT);
  check("⑨i 滚动后选中标签仍是命中元素（可点，不被任何浮层盖住）", barHit === true, String(barHit));
} catch (error) {
  console.log("回放异常：" + String(error && error.stack ? error.stack : error).slice(0, 600));
  checks.push(false);
} finally {
  // ---------- ⑧ 清理 ----------
  try {
    if (templateId !== "") {
      const leftovers = await api("/api/v1/task-templates?stage=" + stageKey);
      const still = leftovers.json === null ? [] : leftovers.json.items.filter((item) => item.id === templateId);
      for (const item of still) {
        await api("/api/v1/task-templates/" + item.id, "DELETE", { version: item.version });
      }
      check("清理：临时模板读面零残留", still.length === 0, still.length === 0 ? "已软删" : "补删 " + String(still.length) + " 份");
    }
    if (nodeId !== "") {
      const res = await api("/api/v1/task-nodes/" + nodeId, "DELETE");
      check("清理：临时节点物理删行", res.status === 200 && res.json !== null && res.json.deleted === true, String(res.status));
      const gone = await api("/api/v1/task-nodes?stage=" + stageKey);
      const hit = gone.json === null ? [] : gone.json.items.filter((item) => item.id === nodeId);
      check("清理：节点库读面零残留", hit.length === 0, "剩 " + String(hit.length) + " 条");
    }
    if (projectId !== "") {
      const tasks = await api("/api/v1/projects/" + projectId + "/tasks?limit=200");
      let deletedTasks = 0;
      for (const item of tasks.json === null ? [] : tasks.json.items) {
        const res = await api("/api/v1/projects/" + projectId + "/tasks/" + item.id, "DELETE", undefined, { "If-Match": String(item.version) });
        if (res.status === 200 || res.status === 204) deletedTasks += 1;
      }
      if (createdTaskId !== "") {
        const taskSoftRow = await db.query("select deleted_at is not null as soft from tasks where id = $1", [createdTaskId]);
        check("清理：临时任务软删（tasks.deleted_at 置位；项目硬删前先验）", taskSoftRow.rows.length === 1 && taskSoftRow.rows[0].soft === true, JSON.stringify(taskSoftRow.rows[0]));
      }
      const projectRow = await api("/api/v1/projects/" + projectId);
      const delProject = await api("/api/v1/projects/" + projectId, "DELETE", undefined, { "If-Match": String(projectRow.json === null ? 0 : projectRow.json.version) });
      check("清理：临时任务逐条软删 + 临时项目硬删", (delProject.status === 200 || delProject.status === 204) && deletedTasks >= 1, String(deletedTasks) + " 条任务 / 项目 " + String(delProject.status));
    }
    if (createdTaskId !== "") {
      const taskGoneRow = await db.query("select count(*)::int as n from tasks where id = $1", [createdTaskId]);
      check("清理：任务随项目硬删一并物理删（行不存在）", Number(taskGoneRow.rows[0].n) === 0, JSON.stringify(taskGoneRow.rows[0]));
    }
    if (projectId !== "") {
      const projectGoneRow = await db.query("select count(*)::int as n from projects where id = $1", [projectId]);
      check("清理：临时项目硬删（projects 行不存在）", Number(projectGoneRow.rows[0].n) === 0, JSON.stringify(projectGoneRow.rows[0]));
    }
  } catch (error) {
    console.log("清理异常：" + String(error && error.message ? error.message : error));
    checks.push(false);
  }
  await db.query("update sessions set revoked_at = now() where token_hash = $1", [sha256(token)]);
  console.log("已撤销临时会话：" + userRow.username);
}

// ---------- 收尾 ----------
const failed = checks.filter((ok) => ok !== true).length;
console.log("—— 合计 " + String(checks.length) + " 项：" + String(checks.length - failed) + " 通过 / " + String(failed) + " 失败 ——");
const pageEvents = page.events.filter((line) => line.indexOf("EVT ") === 0);
console.log("页面控制台 / 异常：" + String(pageEvents.length) + " 条");
for (const line of pageEvents.slice(0, 8)) {
  console.log("  " + line.slice(0, 240));
}
try { page.ws.close(); } catch (error) { /* 忽略 */ }
chrome.kill();
await db.end();
process.exit(failed === 0 ? 0 : 1);
