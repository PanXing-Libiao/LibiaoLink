#!/usr/bin/env node
/**
 * LibiaoLink 前端 · 回放：文件库（Push 261 · 系统现有文件 / 文件回收站 / 项目回收站）
 *
 * 业务口径（2026-10-09）：「新增文件库 文件库里面分为 系统现有文件 回收站」（入口 = 右上角头像菜单「文件库」）。
 *
 * 本脚本用真机浏览器（无头 Chrome + CDP）验：
 *   ① 头像菜单四项（设置 / 退出登录 / 操作记录 / 文件库）：「文件库」在「操作记录」下方、href = #/files；
 *   ② 点入口 → #/files：三枚标签（系统现有文件 / 文件回收站 / 项目回收站）、缺省停在「系统现有文件」；计数 / 首屏 50 行 / 行序
 *      与库内逐一对账（同一项目集 + 四档在库状态，created_at desc + id asc）；
 *   ③ 分页：下一页 → page=2、行 = 库内第 51 行起；上一页回第 1 页、地址回 #/files；
 *   ④ 筛选（地址即状态）：状态 = 草稿（status=draft，行全草稿）/ 清除筛选还原；项目筛选 = **可搜索多选下拉**
 *      （打开即列全部选项、列表内部可鼠标滚轮滑动；输入夹具项目编号（Push 274 起按第一条项目动态派生，避免沙箱新增项目即漂移）把选项过滤到命中项 —— 业务口径 2026-10-09
 *      「应该是搜索下拉框加鼠标滑动」）；多选追订「要可以多项选择 再次点击取消选择」：点选不关浮层（再点 = 取消），
 *      地址 project=<idA>[,<idB>…]（去重保序），多选计数 = 选中项目并集，逐个取消后还原 #/files；
 *      状态 / 上传人筛选同理多选（地址 status=draft,final / uploadedBy=<id>[,<id>…]；上传人 = 前端内存过滤）；
 *      ② 另断言项目列排版 = 编号 + 名字两行（追订「项目名称要编号和名字都写在表格里面注意排版」）；
 *      触发器口径（追订「不要这样显示太丑了 可以只显现这个筛选的名称 然后数量淡灰色的」）：只显筛选名称 +
 *      浅灰数量（data-select-trigger-label / -count），空选无数量；
 *   ⑤ 关键字搜索：输入唯一文件名 → 防抖后地址 / 请求同步 q=（page=1）、1 行命中、状态 = 草稿、上传人 = 潘兴、
 *      项目 = 项目码；清空（×）→ 地址回 #/files、行还原；操作列按钮定宽（忙碌文案不改宽 —— 点预览不抖表）。
 *      【2026-10-09 追订】「类型」列与筛选整条撤除（业务口径「文件类型不需要 因为没有明确的绑定机制」），
 *      本脚本不再断言类型列 / 类型筛选（库内 files.doc_type 全空，无绑定机制）；
 *   ⑥ 回收站栏（?tab=recycled）：标签切换 + 地址同步 + 行状态签全 = 回收站 + 计数 / 行序与库内 recycled 对账；
 *   ⑦ 回收站写口（真实接口）：恢复 → 行移出回收站、DB status 回退 draft、通知「已恢复」；
 *      再次回收后深链 #/files?tab=recycled&q=<名> 刷新直接打开同款（输入框带词、1 行命中）；
 *      「彻底删除」：第一下出确认条 → 取消（行仍在）→ 再点 → 确认 → 行消失、通知「已彻底删除」、
 *      DB 文件 / 版本行清零、审计留痕（delete · 彻底删除：…）；
 *   ⑧ 控制台零报错；跑完会话撤销、文件 / 版本零残留（上传会话行是历史台账，保留）。
 *   ⑨ 提示口径（2026-10-23 分层）：普通写口反馈 = 屏幕顶部居中浮空 Toast（position=fixed / top ≤ 48px / 水平居中），
 *      白色圆角卡片自顶部下落，停留 2s 后自动向上收起（无需手动关闭）；验收交付确认仍在底部；
 *      操作列按钮定宽（预览 / 下载忙碌文案不再把自动布局的表格重排 = 抖动）。
 *
 * 前置（都在本机跑着）：前端 dev :3000 / api :3001 / 本地沙箱 PG :5433 / MinIO :9000 / 本机 Chrome。
 * 用法：node scripts/ui-file-library-e2e.mjs
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
const PORT = Number(process.env.CDP_PORT ?? 9418);
const DB = process.env.DATABASE_URL ?? "postgres://libiaolink_api@127.0.0.1:5433/libiaolink";
const REPLAY_USER = process.env.REPLAY_USER ?? "px-replay";
const SHOTS = process.env.SHOT_DIR ?? join(tmpdir(), "px-file-library-shots");
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
const token = "pxfiles-" + randomBytes(16).toString("hex");
const csrf = randomBytes(16).toString("hex");
await db.query("insert into sessions (token_hash, user_id, id_token, expires_at) values ($1, $2, $3, now() + make_interval(mins => 30))", [sha256(token), userRow.id, "ui-file-library-e2e"]);
console.log("临时会话：" + userRow.username + "（" + userRow.display_name + "）");

/** 浏览器同口径的 API 直调（cookie + CSRF，与前端 apiSend 同源）。 */
async function apiCall(method, path, body) {
  const response = await fetch(API + path, {
    method: method,
    headers: Object.assign({ "content-type": "application/json", cookie: "ll_sid=" + token + "; ll_csrf=" + csrf, "x-csrf-token": csrf }),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed = null;
  try { parsed = text === "" ? null : JSON.parse(text); } catch (error) { parsed = null; }
  return { status: response.status, body: parsed };
}

/** 分片直传（D2，与前端 fileApi.uploadFile 同口径）：发起 → 取分片 URL → 原样 PUT → complete。 */
async function uploadTestFile(projectId, name, bytes) {
  const contentHash = createHash("sha256").update(bytes).digest("hex");
  const created = await apiCall("POST", "/api/v1/files/uploads", { projectId: projectId, name: name, sizeBytes: bytes.length, mime: "text/plain", contentHash: contentHash, intent: "version" });
  if ((created.status !== 200 && created.status !== 201) || created.body === null) {
    throw new Error("发起上传失败：" + String(created.status) + " " + JSON.stringify(created.body));
  }
  const fileId = created.body.file.id;
  const upload = created.body.upload;
  const parts = await apiCall("POST", "/api/v1/files/" + fileId + "/uploads/" + upload.id + "/parts", { partNumbers: [1] });
  if (parts.status !== 200 && parts.status !== 201) {
    throw new Error("取分片 URL 失败：" + String(parts.status) + " " + JSON.stringify(parts.body));
  }
  for (const part of parts.body.parts) {
    if (part.partNumber === 1) {
      const put = await fetch(part.url, { method: "PUT", body: bytes });
      if (put.ok !== true) {
        throw new Error("分片直传失败：" + String(put.status));
      }
    }
  }
  const done = await apiCall("POST", "/api/v1/files/" + fileId + "/uploads/" + upload.id + "/complete", { contentHash: contentHash });
  if (done.status !== 200 && done.status !== 201) {
    throw new Error("完成上传失败：" + String(done.status) + " " + JSON.stringify(done.body));
  }
  return fileId;
}

/** 移入回收站（先读详情拿乐观锁 version，与前端 recycleFile 同口径）。 */
async function recycleViaApi(fileId) {
  const detail = await apiCall("GET", "/api/v1/files/" + fileId);
  if (detail.status !== 200) {
    throw new Error("读文件详情失败：" + String(detail.status));
  }
  const done = await apiCall("POST", "/api/v1/files/" + fileId + "/recycle", { version: detail.body.version });
  if (done.status !== 200) {
    throw new Error("回收失败：" + String(done.status) + " " + JSON.stringify(done.body));
  }
}

// —— 测试数据：项目 = 列表第一条（该项目也是「项目筛选」下拉里的第一个选项，见下）——
const projectList = await apiCall("GET", "/api/v1/projects?page=1&limit=200&sort=createdAt:desc");
if (projectList.status !== 200 || projectList.body === null) { console.error("项目列表拉取失败：" + String(projectList.status)); process.exit(1); }
const projectItems = projectList.body.items;
const project = projectItems[0];
const projectLabel = project.code + " · " + project.name;
const stamp = randomBytes(4).toString("hex");
const fileName = "回放-文件库-" + stamp + ".txt";
const contentBytes = Buffer.from("LibiaoLink 文件库回放 " + stamp, "utf8");
const fileId = await uploadTestFile(project.id, fileName, contentBytes);
console.log("测试文件：" + fileName + "（" + fileId + "）@ " + project.code + "（" + project.name + "）");

const profile = mkdtempSync(join(tmpdir(), "pxfiles-"));
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
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error("cdp timeout: " + method)); }, 30000);
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
const fileRequests = [];
const projectRequests = [];
page.ws.addEventListener("message", (event) => {
  const msg = JSON.parse(typeof event.data === "string" ? event.data : String(event.data));
  if (msg.method === "Log.entryAdded" && msg.params !== undefined && msg.params.entry !== undefined && msg.params.entry.level === "error") {
    consoleErrors.push(String(msg.params.entry.text));
  }
  if (msg.method === "Runtime.exceptionThrown") { consoleErrors.push("exceptionThrown"); }
  if (msg.method === "Runtime.consoleAPICalled" && msg.params !== undefined && msg.params.type === "error") {
    consoleErrors.push((msg.params.args ?? []).map((item) => String(item.value ?? item.description ?? " ")).join(" "));
  }
  if (msg.method === "Network.requestWillBeSent" && msg.params !== undefined && msg.params.request !== undefined && String(msg.params.request.url).indexOf("/files?") !== -1) {
    fileRequests.push(String(msg.params.request.url));
  }
  if (msg.method === "Network.requestWillBeSent" && msg.params !== undefined && msg.params.request !== undefined && String(msg.params.request.url).indexOf("/projects?") !== -1) {
    projectRequests.push(String(msg.params.request.url));
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
/** 搜索下拉输入框赋词（React 受控：走原生 setter + input 事件；主要用来清空过滤词看全量列表）。 */
async function setSearchSelectQuery(text) {
  await clickSelector("[data-search-select-input]");
  const done = await ev("(function(){var i=document.querySelector(" + j("[data-search-select-input]") + ");if(i===null){return null;}var set=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype," + j("value") + ").set;set.call(i," + j(text) + ");i.dispatchEvent(new Event(" + j("input") + ",{bubbles:true}));return true;})()");
  await sleep(400);
  return done === true;
}
async function bail(message) {
  console.log("中止：" + message);
  checks.push({ name: "中止：" + message, ok: false });
  try { page.ws.close(); } catch (error) { /* 忽略 */ }
  chrome.kill();
  await db.end();
  process.exit(1);
}

/** 行 / 计数 / 标签 / 通知的一把抓（与 data-file-* 钩子对齐）。 */
const rowExpr = "(function(){var rows=document.querySelectorAll(" + j("[data-file-row]") + ");var out=[];for(var i=0;i<rows.length;i+=1){var tr=rows[i];var tds=tr.querySelectorAll(" + j("td") + ");var st=tr.querySelector(" + j("[data-file-status]") + ");var pj=tds[2].querySelector(" + j("[data-file-project]") + ");out.push({id:tr.getAttribute(" + j("data-file-row") + "),name:String(tds[0].textContent).trim(),status:st===null?null:st.getAttribute(" + j("data-file-status") + "),statusText:st===null?null:String(st.textContent).trim(),project:String(tds[2].textContent).trim(),projectCode:pj===null?null:pj.getAttribute(" + j("data-file-project-code") + "),projectName:pj===null?null:pj.getAttribute(" + j("data-file-project-name") + "),uploader:String(tds[3].textContent).trim(),when:String(tds[4].textContent).trim()});}var count=document.querySelector(" + j("[data-file-count]") + ");var info=document.querySelector(" + j("[data-file-page-info]") + ");var empty=document.querySelector(" + j("[data-file-empty]") + ");var tabs=document.querySelectorAll(" + j("[data-file-tab]") + ");var tabTexts=[];var activeTab=null;for(var k=0;k<tabs.length;k+=1){tabTexts.push(String(tabs[k].textContent).trim());if(tabs[k].getAttribute(" + j("aria-current") + ")===" + j("page") + "){activeTab=tabs[k].getAttribute(" + j("data-file-tab") + ");}}var notice=document.querySelector(" + j("[data-file-notice]") + ");var noticeKind=notice===null?null:notice.getAttribute(" + j("data-file-notice") + ");var kw=document.querySelector(" + j("[data-file-filter=keyword] input") + ");return {rows:out,rowCount:rows.length,count:count===null?null:String(count.textContent).trim(),pageInfo:info===null?null:String(info.textContent).trim(),empty:empty===null?null:String(empty.textContent).trim(),tabTexts:tabTexts,activeTab:activeTab,notice:notice===null?null:String(notice.textContent).trim(),noticeKind:noticeKind,keyword:kw===null?null:kw.value,hash:window.location.hash,headerText:String(document.querySelector(" + j("[data-file-library]") + ").textContent)};})()";

const STATUSES_CURRENT = ["draft", "final", "changed", "archived"];
const STATUSES_RECYCLED = ["recycled"];
const projectIds = projectItems.map((item) => item.id);
const orderedIds = async (statuses, projectId) => {
  const rows = projectId === undefined
    ? await db.query("select id from files where project_id = any($1::uuid[]) and status = any($2::text[]) order by created_at desc, id asc", [projectIds, statuses])
    : await db.query("select id from files where project_id = $1 and status = any($2::text[]) order by created_at desc, id asc", [projectId, statuses]);
  return rows.rows.map((row) => String(row.id));
};
const countRows = async (statuses, projectId) => {
  const rows = projectId === undefined
    ? await db.query("select count(*)::int n from files where project_id = any($1::uuid[]) and status = any($2::text[])", [projectIds, statuses])
    : await db.query("select count(*)::int n from files where project_id = $1 and status = any($2::text[])", [projectId, statuses]);
  return Number(rows.rows[0].n);
};
/** 多选并集（与前端合并排序同口径：created_at desc + id asc）。 */
const unionIds = async (ids) => {
  const rows = await db.query("select id from files where project_id = any($1::uuid[]) and status = any($2::text[]) order by created_at desc, id asc", [ids, STATUSES_CURRENT]);
  return rows.rows.map((row) => String(row.id));
};
/** 多选上传人（created_by）：单人 / 多人的在库文件计数与序（与前端内存过滤同口径）。 */
const countByCreators = async (creatorIds) => Number((await db.query("select count(*)::int n from files where project_id = any($1::uuid[]) and status = any($2::text[]) and created_by = any($3::uuid[])", [projectIds, STATUSES_CURRENT, creatorIds])).rows[0].n);
const orderedByCreators = async (creatorIds) => (await db.query("select id from files where project_id = any($1::uuid[]) and status = any($2::text[]) and created_by = any($3::uuid[]) order by created_at desc, id asc", [projectIds, STATUSES_CURRENT, creatorIds])).rows.map((row) => String(row.id));
const fileStatusOf = async (id) => (await db.query("select status, version from files where id = $1", [id])).rows[0];
const lastFileReq = () => fileRequests.length === 0 ? "" : fileRequests[fileRequests.length - 1];
const lastProjectReq = () => projectRequests.length === 0 ? "" : projectRequests[projectRequests.length - 1];
const hasReq = (needle) => fileRequests.some((url) => url.indexOf(needle) !== -1);
const fileNameEnc = encodeURIComponent(fileName);
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

// 首登「绑定企业微信」引导是遮罩层，先按产品允许的「稍后再说」关闭，避免挡住头像菜单。
const guideSkipPoint = await ev("(function(){var b=document.querySelector(" + j("[data-wecom-binding-guide-skip]") + ");if(b===null){return null;}var r=b.getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};})()");
if (guideSkipPoint !== null && guideSkipPoint !== undefined) {
  await clickAt(guideSkipPoint);
  await waitFor("document.querySelector(" + j("[data-wecom-binding-guide]") + ") === null", 5000);
}

// ---------- ① 头像菜单：「文件库」在「操作记录」下方 ----------
const avatarPoint = await ev("(function(){var b=document.querySelector(" + j("[data-account-trigger]") + ");if(b===null){return null;}var r=b.getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};})()");
if (avatarPoint === null || avatarPoint === undefined) { await bail("头像按钮找不到"); }
await clickAt(avatarPoint);
const menuReady = await waitFor("document.querySelector(" + j("[data-account-files]") + ") !== null", 8000);
if (menuReady !== true) { await bail("头像菜单里没有「文件库」入口"); }
const menuInfo = await ev("(function(){var f=document.querySelector(" + j("[data-account-files]") + ");var box=f.parentElement;var items=box.querySelectorAll(" + j("[role=menuitem]") + ");var out=[];for(var i=0;i<items.length;i+=1){var it=items[i];out.push({text:String(it.textContent).trim(),href:it.getAttribute(" + j("href") + "),y:Math.round(it.getBoundingClientRect().top)});}return {items:out,filesHref:f.getAttribute(" + j("href") + "),filesY:Math.round(f.getBoundingClientRect().top)};})()");
const menuShot = await shot("file-library-menu", { x: 900, y: 0, width: 600, height: 280, scale: 1 });
console.log("截图：" + menuShot);
const auditItem = menuInfo.items.find((item) => item.text === "操作记录");
check("① 头像菜单四项（设置 / 退出登录 / 操作记录 / 文件库）：「文件库」在「操作记录」下方、href = #/files",
  menuInfo.items.length === 4 && menuInfo.items[0].text === "设置" && menuInfo.items[1].text === "退出登录" && auditItem !== undefined && menuInfo.items[3].text === "文件库" && menuInfo.filesHref === "#/files" && auditItem.y < menuInfo.filesY,
  JSON.stringify(menuInfo));

// ---------- ② 入口 → #/files：标签 / 计数 / 行序对账 ----------
await clickSelector("[data-account-files]");
const baseReady = await waitFor("window.location.hash === " + j("#/files") + " && document.querySelectorAll(" + j("[data-file-row]") + ").length > 0", 40000);
if (baseReady !== true) { await bail("#/files 没就位（表格行没出来）"); }
await sleep(1500);
const base = await ev(rowExpr);
const expectCurrentIds = await orderedIds(STATUSES_CURRENT);
const baseShot = await shot("file-library-current", { x: 0, y: 0, width: 1500, height: 950, scale: 1 });
console.log("截图：" + baseShot);
check("② #/files 就位：三枚标签（系统现有文件 / 文件回收站 / 项目回收站）、缺省当前 = 系统现有文件、页头保留 30 天口径",
  base.tabTexts.join(",") === "系统现有文件,文件回收站,项目回收站" && base.activeTab === "current" && base.headerText.indexOf("默认保留 30 天，可恢复") !== -1,
  JSON.stringify({ tabs: base.tabTexts, active: base.activeTab }));
check("②b 计数 / 首屏 50 行 / 行序与库内（四档在库状态）逐一对账、在库行不出现回收站签",
  base.count === "共 " + String(expectCurrentIds.length) + " 条" && base.rowCount === Math.min(50, expectCurrentIds.length) && base.rows.map((row) => row.id).join(",") === expectCurrentIds.slice(0, 50).join(",") && base.rows.every((row) => row.status !== "recycled"),
  JSON.stringify({ count: base.count, db: expectCurrentIds.length, rows: base.rowCount }));
check("②c 请求口径：filter[status]=四档在库状态（显式给全、不含 recycled）+ limit=200&page=1",
  hasReq("filter[status]=draft,final,changed,archived") && hasReq("limit=200&page=1"),
  lastFileReq().slice(0, 200));
const typeGone = await ev("(function(){return {filter:document.querySelector(" + j("[data-file-filter=docType]") + ")!==null,th:document.querySelector(" + j("[data-file-library] thead") + ").textContent.indexOf(" + j("类型") + ") !== -1,ths:document.querySelectorAll(" + j("[data-file-library] thead th") + ").length};})()");
check("②d 无「类型」列与类型筛选（Push 261 追订：文件类型不需要 因为没有明确的绑定机制）+ 表头六列", typeGone.filter === false && typeGone.th === false && typeGone.ths === 6, JSON.stringify(typeGone));

const projectCell = await ev("(function(){var c=document.querySelector(" + j("[data-file-project]") + ");if(c===null){return null;}var spans=c.querySelectorAll(" + j("span") + ");return {code:c.getAttribute(" + j("data-file-project-code") + "),name:c.getAttribute(" + j("data-file-project-name") + "),rows:spans.length,direction:getComputedStyle(c).flexDirection,first:spans.length>0?String(spans[0].textContent).trim():null,second:spans.length>1?String(spans[1].textContent).trim():null};})()");
check("②e 项目列排版 = 中文名 + 编号两行（上行项目名、下行项目编号；首行 = 测试项目，追订「项目名称要编号和名字都写在表格里面注意排版」+「中文和编号的位置反一下」）",
  projectCell !== null && projectCell.rows === 2 && projectCell.direction === "column" && projectCell.code === project.code && projectCell.name === project.name && projectCell.first === project.name && projectCell.second === project.code,
  JSON.stringify(projectCell));

// ---------- ③ 分页 ----------
const totalPages = Math.max(1, Math.ceil(expectCurrentIds.length / 50));
await clickSelector("[data-file-next]");
const page2Ready = await waitFor("window.location.hash.indexOf(" + j("page=2") + ") !== -1 && document.querySelectorAll(" + j("[data-file-row]") + ").length > 0", 40000);
await sleep(1200);
const page2 = await ev(rowExpr);
check("③ 分页：下一页 → 地址 page=2、页脚「第 2 / " + String(totalPages) + " 页」、行 = 库内第 51 行起",
  page2Ready === true && page2.hash.indexOf("page=2") !== -1 && page2.pageInfo === "共 " + String(expectCurrentIds.length) + " 条 · 第 2 / " + String(totalPages) + " 页" && page2.rows.map((row) => row.id).join(",") === expectCurrentIds.slice(50, 100).join(","),
  JSON.stringify({ info: page2.pageInfo, rows: page2.rowCount }));
await clickSelector("[data-file-prev]");
const backReady = await waitFor("window.location.hash === " + j("#/files") + " && document.querySelectorAll(" + j("[data-file-row]") + ").length > 0", 40000);
await sleep(1200);
const back1 = await ev(rowExpr);
check("③b 上一页 → 地址回 #/files（缺省参数不落地址）、首行还原",
  backReady === true && back1.rows[0] !== undefined && back1.rows[0].id === expectCurrentIds[0],
  JSON.stringify({ hash: back1.hash, first: back1.rows[0] === undefined ? null : back1.rows[0].id }));

// ---------- ④ 筛选（地址即状态） ----------
await clickSelector("[data-file-filter=status] button");
const statusPicked = await pickOption("草稿");
const draftReady = await waitFor("window.location.hash.indexOf(" + j("status=draft") + ") !== -1 && document.querySelectorAll(" + j("[data-file-row]") + ").length > 0", 40000);
await sleep(1200);
const draftState = await ev(rowExpr);
const expectDraftIds = await orderedIds(["draft"]);
check("④ 状态筛选 = 草稿：地址 status=draft、计数 / 首屏行与库内草稿对账、行状态签全草稿",
  statusPicked === true && draftReady === true && draftState.count === "共 " + String(expectDraftIds.length) + " 条" && draftState.rows.map((row) => row.id).join(",") === expectDraftIds.slice(0, 50).join(",") && draftState.rows.every((row) => row.status === "draft" && row.statusText === "草稿"),
  JSON.stringify({ picked: statusPicked, hash: draftState.hash, count: draftState.count, db: expectDraftIds.length }));
await clickSelector("[data-file-clear]");
const clearedReady = await waitFor("window.location.hash === " + j("#/files") + " && document.querySelectorAll(" + j("[data-file-row]") + ").length > 0", 40000);
await sleep(1200);
const afterClear = await ev(rowExpr);
check("④b 清除筛选 → 地址回 #/files、计数还原",
  clearedReady === true && afterClear.count === "共 " + String(expectCurrentIds.length) + " 条",
  JSON.stringify({ hash: afterClear.hash, count: afterClear.count }));
// ---------- ④b2 状态筛选 = 多选（点选不关浮层 / 再点取消；追订「别的筛选也是同理 要支持多选」） ----------
const countDraft = await countRows(["draft"]);
const countFinal = await countRows(["final"]);
const expectDraftFinalIds = await orderedIds(["draft", "final"]);
await clickSelector("[data-file-filter=status] button");
const statusBoxReady = await waitFor("document.querySelector(" + j("[data-search-select-input]") + ") !== null", 8000);
const draftPick2 = await pickOption("草稿");
const draftOnlyReady = await waitFor("window.location.hash === " + j("#/files?status=draft") + " && document.querySelector(" + j("[data-file-count]") + ") !== null && document.querySelector(" + j("[data-file-count]") + ").textContent === " + j("共 " + String(countDraft) + " 条"), 40000);
await sleep(1200);
const draftOnly = await ev(rowExpr);
const draftMultiUi = await ev("(function(){var t=document.querySelector(" + j("[data-file-filter=status] button") + ");var p=document.querySelector(" + j("[data-select-popover]") + ");return {label:t===null?null:t.getAttribute(" + j("data-select-trigger-label") + "),count:t===null?null:t.getAttribute(" + j("data-select-trigger-count") + "),open:p!==null};})()");
check("④b2 状态筛选 = 多选第一项（草稿）：点选不关浮层 + 触发器「状态 + 浅灰 1」（新口径：只显名称 + 浅灰数量）、地址 status=draft、计数 / 行全草稿",
  statusBoxReady === true && draftPick2 === true && draftOnlyReady === true && draftMultiUi.open === true && draftMultiUi.label === "状态" && draftMultiUi.count === "1" && draftOnly.count === "共 " + String(countDraft) + " 条" && draftOnly.rows.every((row) => row.status === "draft"),
  JSON.stringify({ picked: draftPick2, hash: draftOnly.hash, count: draftOnly.count, db: countDraft, ui: draftMultiUi }));
const finalPick = await pickOption("已定档");
const draftFinalReady = await waitFor("window.location.hash === " + j("#/files?status=draft,final") + " && document.querySelector(" + j("[data-file-count]") + ") !== null && document.querySelector(" + j("[data-file-count]") + ").textContent === " + j("共 " + String(expectDraftFinalIds.length) + " 条"), 40000);
await sleep(1200);
const draftFinal = await ev(rowExpr);
const draftFinalUi = await ev("(function(){var t=document.querySelector(" + j("[data-file-filter=status] button") + ");return {label:t===null?null:t.getAttribute(" + j("data-select-trigger-label") + "),count:t===null?null:t.getAttribute(" + j("data-select-trigger-count") + ")};})()");
check("④b3 状态多选累加（草稿 + 已定档）：地址 status=draft,final（逗号分隔）、触发器「状态 + 浅灰 2」、计数 / 行 = 两状态并集",
  finalPick === true && draftFinalReady === true && draftFinalUi.label === "状态" && draftFinalUi.count === "2" && draftFinal.count === "共 " + String(expectDraftFinalIds.length) + " 条" && draftFinal.rows.map((row) => row.id).join(",") === expectDraftFinalIds.slice(0, 50).join(",") && draftFinal.rows.every((row) => row.status === "draft" || row.status === "final"),
  JSON.stringify({ picked: finalPick, hash: draftFinal.hash, count: draftFinal.count, db: expectDraftFinalIds.length, ui: draftFinalUi }));
const draftUnpick = await pickOption("草稿");
const finalOnlyReady = await waitFor("window.location.hash === " + j("#/files?status=final") + " && document.querySelector(" + j("[data-file-count]") + ") !== null && document.querySelector(" + j("[data-file-count]") + ").textContent === " + j("共 " + String(countFinal) + " 条"), 40000);
await sleep(1000);
const finalOnly = await ev(rowExpr);
check("④b4 再次点击草稿 = 取消选择：地址只剩 status=final、计数 = 已定档",
  draftUnpick === true && finalOnlyReady === true && finalOnly.count === "共 " + String(countFinal) + " 条" && finalOnly.rows.every((row) => row.status === "final"),
  JSON.stringify({ picked: draftUnpick, hash: finalOnly.hash, count: finalOnly.count, db: countFinal }));
const finalUnpick = await pickOption("已定档");
const statusAllBack = await waitFor("window.location.hash === " + j("#/files") + " && document.querySelector(" + j("[data-file-count]") + ") !== null && document.querySelector(" + j("[data-file-count]") + ").textContent === " + j("共 " + String(expectCurrentIds.length) + " 条"), 40000);
check("④b5 再点已定档 = 清空状态筛选：地址回 #/files、计数还原",
  finalUnpick === true && statusAllBack === true,
  JSON.stringify({ picked: finalUnpick }));
await clickSelector("[data-file-filter=status] button");
await waitFor("document.querySelector(" + j("[data-select-popover]") + ") === null", 8000);
await sleep(600);

// ④c1 搜索词：按第一条项目（= 夹具项目）动态派生 —— 写死词在沙箱新增项目后必漂移（Push 274 修）。
const projectSearchTerm = project.code;

await clickSelector("[data-file-filter=project] button");
const searchBoxReady = await waitFor("document.querySelector(" + j("[data-search-select-input]") + ") !== null", 8000);
const projectListAll = await ev("(function(){var box=document.querySelector(" + j("[data-search-select-list]") + ");if(box===null){return null;}return {count:box.querySelectorAll(" + j("[role=option]") + ").length,scrollable:box.scrollHeight>box.clientHeight,overflow:getComputedStyle(box).overflowY};})()");
await clickSelector("[data-search-select-input]");
await page.send("Input.insertText", { text: projectSearchTerm });
await sleep(400);
const projectSearch = await ev("(function(){var box=document.querySelector(" + j("[data-search-select-list]") + ");if(box===null){return null;}var os=box.querySelectorAll(" + j("[role=option]") + ");var texts=[];for(var i=0;i<os.length;i+=1){texts.push(String(os[i].textContent).trim());}return {count:os.length,texts:texts};})()");
check("④c1 项目筛选 = 搜索下拉框（可输入过滤；打开即见全部选项、列表内部可滚）+ 列表鼠标可滑（overflow-y=auto / scrollHeight > clientHeight）",
  searchBoxReady === true && projectListAll !== null && projectListAll.count > 20 && projectListAll.scrollable === true && projectListAll.overflow === "auto" && projectSearch !== null && projectSearch.count > 0 && projectSearch.count < projectListAll.count && projectSearch.texts.every((text) => text.indexOf(projectSearchTerm) !== -1),
  JSON.stringify({ all: projectListAll, filtered: projectSearch === null ? null : { count: projectSearch.count, first: projectSearch.texts[0] } }));
const projectPicked = await pickOption(projectLabel);
const expectProjectIds = await orderedIds(STATUSES_CURRENT, project.id);
const projectReady = await waitFor("window.location.hash === " + j("#/files?project=" + project.id) + " && document.querySelector(" + j("[data-file-count]") + ") !== null && document.querySelector(" + j("[data-file-count]") + ").textContent === " + j("共 " + String(expectProjectIds.length) + " 条"), 40000);
await sleep(1200);
const byProject = await ev(rowExpr);
const multiPickUi = await ev("(function(){var t=document.querySelector(" + j("[data-file-filter=project] button") + ");var p=document.querySelector(" + j("[data-select-popover]") + ");return {label:t===null?null:t.getAttribute(" + j("data-select-trigger-label") + "),count:t===null?null:t.getAttribute(" + j("data-select-trigger-count") + "),open:p!==null,checked:p===null?0:p.querySelectorAll(" + j("[aria-selected=true]") + ").length};})()");
check("④c 项目筛选 = " + project.code + "（多选第一项）：点选不关浮层 + 触发器「项目 + 浅灰 1」、地址 project=<id>、计数 / 行与库内该项目对账、行列全该项目编号",
  projectPicked === true && projectReady === true && multiPickUi.open === true && multiPickUi.label === "项目" && multiPickUi.count === "1" && multiPickUi.checked === 1 && byProject.count === "共 " + String(expectProjectIds.length) + " 条" && byProject.rows.map((row) => row.id).join(",") === expectProjectIds.slice(0, 50).join(",") && byProject.rows.every((row) => row.projectCode === project.code),
  JSON.stringify({ picked: projectPicked, hash: byProject.hash, count: byProject.count, db: expectProjectIds.length, ui: multiPickUi }));

// —— 多选第二项：第二个有在库文件的项目（下拉选项 = 同一份项目列表，必然存在）——
const fileCountByProject = new Map((await db.query("select project_id, count(*)::int n from files where project_id = any($1::uuid[]) and status = any($2::text[]) group by project_id", [projectIds, STATUSES_CURRENT])).rows.map((row) => [String(row.project_id), Number(row.n)]));
const projectB = projectItems.find((item) => item.id !== project.id && (fileCountByProject.get(item.id) ?? 0) > 0);
if (projectB === undefined) { await bail("找不到第二个有在库文件的项目，多选断言无法回放"); }
const projectBLabel = projectB.code + " · " + projectB.name;
const searchCleared = await setSearchSelectQuery("");
const expectUnionIds = await unionIds([project.id, projectB.id]);
const secondPicked = await pickOption(projectBLabel);
const unionReady = await waitFor("window.location.hash === " + j("#/files?project=" + project.id + "," + projectB.id) + " && document.querySelector(" + j("[data-file-count]") + ") !== null && document.querySelector(" + j("[data-file-count]") + ").textContent === " + j("共 " + String(expectUnionIds.length) + " 条"), 40000);
await sleep(1200);
const byTwo = await ev(rowExpr);
const multiTwoUi = await ev("(function(){var t=document.querySelector(" + j("[data-file-filter=project] button") + ");var p=document.querySelector(" + j("[data-select-popover]") + ");return {label:t===null?null:t.getAttribute(" + j("data-select-trigger-label") + "),count:t===null?null:t.getAttribute(" + j("data-select-trigger-count") + "),open:p!==null,checked:p===null?0:p.querySelectorAll(" + j("[aria-selected=true]") + ").length};})()");
check("④c2 多选第二项（" + projectB.code + "，再点选累加）：地址 project=<idA>,<idB>（逗号分隔）、触发器「项目 + 浅灰 2」、计数 / 行 = 两项目并集",
  searchCleared === true && secondPicked === true && unionReady === true && multiTwoUi.open === true && multiTwoUi.label === "项目" && multiTwoUi.count === "2" && multiTwoUi.checked === 2 && byTwo.count === "共 " + String(expectUnionIds.length) + " 条" && byTwo.rows.map((row) => row.id).join(",") === expectUnionIds.slice(0, 50).join(",") && byTwo.rows.every((row) => row.projectCode === project.code || row.projectCode === projectB.code),
  JSON.stringify({ picked: secondPicked, hash: byTwo.hash, count: byTwo.count, db: expectUnionIds.length, ui: multiTwoUi }));

// —— 再次点击第一项 = 取消选择（只留第二项）——
const countB = await countRows(STATUSES_CURRENT, projectB.id);
const firstUnpicked = await pickOption(projectLabel);
const bOnlyReady = await waitFor("window.location.hash === " + j("#/files?project=" + projectB.id) + " && document.querySelector(" + j("[data-file-count]") + ") !== null && document.querySelector(" + j("[data-file-count]") + ").textContent === " + j("共 " + String(countB) + " 条"), 40000);
await sleep(1200);
const byB = await ev(rowExpr);
const multiBOnlyUi = await ev("(function(){var t=document.querySelector(" + j("[data-file-filter=project] button") + ");return {label:t===null?null:t.getAttribute(" + j("data-select-trigger-label") + "),count:t===null?null:t.getAttribute(" + j("data-select-trigger-count") + ")};})()");
check("④c3 再次点击 " + project.code + " = 取消选择：地址只剩 project=<idB>、触发器「项目 + 浅灰 1」、计数 / 行回该项目单项",
  firstUnpicked === true && bOnlyReady === true && multiBOnlyUi.label === "项目" && multiBOnlyUi.count === "1" && byB.count === "共 " + String(countB) + " 条" && byB.rows.every((row) => row.projectCode === projectB.code),
  JSON.stringify({ picked: firstUnpicked, hash: byB.hash, count: byB.count, db: countB, ui: multiBOnlyUi }));

// —— 再点第二项 = 清空选择（空选择 = 全部项目）——
const secondUnpicked = await pickOption(projectBLabel);
const allBackReady = await waitFor("window.location.hash === " + j("#/files") + " && document.querySelector(" + j("[data-file-count]") + ") !== null && document.querySelector(" + j("[data-file-count]") + ").textContent === " + j("共 " + String(expectCurrentIds.length) + " 条"), 40000);
await sleep(1000);
const allBack = await ev(rowExpr);
check("④c4 再点 " + projectB.code + " = 取消选择：地址回 #/files（空选择 = 全部项目）、计数 / 首屏行还原",
  secondUnpicked === true && allBackReady === true && allBack.rows.map((row) => row.id).join(",") === expectCurrentIds.slice(0, 50).join(","),
  JSON.stringify({ picked: secondUnpicked, hash: allBack.hash, count: allBack.count }));
await clickSelector("[data-file-filter=project] button");
await waitFor("document.querySelector(" + j("[data-select-popover]") + ") === null", 8000);
await sleep(600);

// ---------- ④d 上传人筛选 = 多选（内存过滤；点选 / 再点取消） ----------
const creatorRows = (await db.query("select u.id, u.display_name, count(f.id)::int n from files f join users u on u.id = f.created_by where f.project_id = any($1::uuid[]) and f.status = any($2::text[]) group by u.id, u.display_name order by n desc, u.id asc", [projectIds, STATUSES_CURRENT])).rows;
const creatorA = creatorRows.find((row) => String(row.id) === userRow.id) ?? creatorRows[0];
const creatorB = creatorRows.find((row) => String(row.id) !== String(creatorA === undefined ? "" : creatorA.id));
if (creatorA === undefined || creatorB === undefined) { await bail("上传人多选回放需要至少两个有在库文件的创建者"); }
const expectCreatorAIds = await orderedByCreators([creatorA.id]);
const expectCreatorABIds = await orderedByCreators([creatorA.id, creatorB.id]);
const expectCreatorBIds = await orderedByCreators([creatorB.id]);
await clickSelector("[data-file-filter=uploader] button");
const uploaderBoxReady = await waitFor("document.querySelector(" + j("[data-search-select-input]") + ") !== null", 8000);
const creatorAPick = await pickOption(String(creatorA.display_name));
const creatorAReady = await waitFor("window.location.hash === " + j("#/files?uploadedBy=" + creatorA.id) + " && document.querySelector(" + j("[data-file-count]") + ") !== null && document.querySelector(" + j("[data-file-count]") + ").textContent === " + j("共 " + String(expectCreatorAIds.length) + " 条"), 20000);
await sleep(800);
const byCreatorA = await ev(rowExpr);
const uploaderMultiUi = await ev("(function(){var t=document.querySelector(" + j("[data-file-filter=uploader] button") + ");var p=document.querySelector(" + j("[data-select-popover]") + ");return {label:t===null?null:t.getAttribute(" + j("data-select-trigger-label") + "),count:t===null?null:t.getAttribute(" + j("data-select-trigger-count") + "),open:p!==null};})()");
check("④d 上传人筛选 = 多选第一项（" + creatorA.display_name + "）：点选不关浮层 + 触发器「上传人 + 浅灰 1」、地址 uploadedBy=<id>、计数 / 行 = 该上传人在库文件（内存过滤）",
  uploaderBoxReady === true && creatorAPick === true && creatorAReady === true && uploaderMultiUi.open === true && uploaderMultiUi.label === "上传人" && uploaderMultiUi.count === "1" && byCreatorA.count === "共 " + String(expectCreatorAIds.length) + " 条" && byCreatorA.rows.map((row) => row.id).join(",") === expectCreatorAIds.slice(0, 50).join(",") && byCreatorA.rows.every((row) => row.uploader === creatorA.display_name),
  JSON.stringify({ picked: creatorAPick, hash: byCreatorA.hash, count: byCreatorA.count, db: expectCreatorAIds.length, ui: uploaderMultiUi }));
const creatorBPick = await pickOption(String(creatorB.display_name));
const creatorABReady = await waitFor("window.location.hash === " + j("#/files?uploadedBy=" + creatorA.id + "," + creatorB.id) + " && document.querySelector(" + j("[data-file-count]") + ") !== null && document.querySelector(" + j("[data-file-count]") + ").textContent === " + j("共 " + String(expectCreatorABIds.length) + " 条"), 20000);
await sleep(800);
const byCreatorAB = await ev(rowExpr);
const uploaderABUi = await ev("(function(){var t=document.querySelector(" + j("[data-file-filter=uploader] button") + ");return {label:t===null?null:t.getAttribute(" + j("data-select-trigger-label") + "),count:t===null?null:t.getAttribute(" + j("data-select-trigger-count") + ")};})()");
check("④d2 上传人多选累加（" + creatorA.display_name + " + " + creatorB.display_name + "）：地址 uploadedBy=<idA>,<idB>、触发器「上传人 + 浅灰 2」、计数 / 行 = 两人并集",
  creatorBPick === true && creatorABReady === true && uploaderABUi.label === "上传人" && uploaderABUi.count === "2" && byCreatorAB.count === "共 " + String(expectCreatorABIds.length) + " 条" && byCreatorAB.rows.map((row) => row.id).join(",") === expectCreatorABIds.slice(0, 50).join(",") && byCreatorAB.rows.every((row) => row.uploader === creatorA.display_name || row.uploader === creatorB.display_name),
  JSON.stringify({ picked: creatorBPick, hash: byCreatorAB.hash, count: byCreatorAB.count, db: expectCreatorABIds.length, ui: uploaderABUi }));
const creatorAUnpick = await pickOption(String(creatorA.display_name));
const creatorBOnlyReady = await waitFor("window.location.hash === " + j("#/files?uploadedBy=" + creatorB.id) + " && document.querySelector(" + j("[data-file-count]") + ") !== null && document.querySelector(" + j("[data-file-count]") + ").textContent === " + j("共 " + String(expectCreatorBIds.length) + " 条"), 20000);
await sleep(800);
const byCreatorB = await ev(rowExpr);
check("④d3 再次点击 " + creatorA.display_name + " = 取消选择：地址只剩 uploadedBy=<idB>、计数 / 行回该上传人单项",
  creatorAUnpick === true && creatorBOnlyReady === true && byCreatorB.count === "共 " + String(expectCreatorBIds.length) + " 条" && byCreatorB.rows.every((row) => row.uploader === creatorB.display_name),
  JSON.stringify({ picked: creatorAUnpick, hash: byCreatorB.hash, count: byCreatorB.count, db: expectCreatorBIds.length }));
const creatorBUnpick = await pickOption(String(creatorB.display_name));
const uploaderAllBack = await waitFor("window.location.hash === " + j("#/files") + " && document.querySelector(" + j("[data-file-count]") + ") !== null && document.querySelector(" + j("[data-file-count]") + ").textContent === " + j("共 " + String(expectCurrentIds.length) + " 条"), 20000);
await sleep(600);
check("④d4 再点 " + creatorB.display_name + " = 清空上传人筛选：地址回 #/files、计数还原",
  creatorBUnpick === true && uploaderAllBack === true,
  JSON.stringify({ picked: creatorBUnpick }));
await clickSelector("[data-file-filter=uploader] button");
await waitFor("document.querySelector(" + j("[data-select-popover]") + ") === null", 8000);
await sleep(600);

// ---------- ⑤ 关键字搜索 ----------
await clickSelector("[data-file-filter=keyword] input");
await page.send("Input.insertText", { text: fileName });
const kwReady = await waitFor("window.location.hash.indexOf(" + j("q=" + fileNameEnc) + ") !== -1 && document.querySelectorAll(" + j("[data-file-row]") + ").length === 1", 40000);
await sleep(1200);
const byKeyword = await ev(rowExpr);
check("⑤ 关键字搜索：防抖后地址 / 请求同步 q=、1 行命中",
  kwReady === true && byKeyword.hash.indexOf("q=" + fileNameEnc) !== -1 && lastFileReq().indexOf("q=" + fileNameEnc) !== -1 && byKeyword.rowCount === 1 && byKeyword.rows[0].id === fileId,
  JSON.stringify({ hash: byKeyword.hash, rows: byKeyword.rowCount, req: lastFileReq().slice(0, 200) }));
const previewWidth = await ev("(function(){var b=document.querySelector(" + j("[data-file-preview]") + ");if(b===null){return null;}var w0=Math.round(b.getBoundingClientRect().width*100)/100;var t=b.textContent;b.textContent=" + j("打开中") + ";var w1=Math.round(b.getBoundingClientRect().width*100)/100;b.textContent=t;return {w0:w0,w1:w1};})()");
const downloadWidth = await ev("(function(){var b=document.querySelector(" + j("[data-file-download]") + ");if(b===null){return null;}var w0=Math.round(b.getBoundingClientRect().width*100)/100;var t=b.textContent;b.textContent=" + j("下载中") + ";var w1=Math.round(b.getBoundingClientRect().width*100)/100;b.textContent=t;return {w0:w0,w1:w1};})()");
check("⑤b1 操作列定宽：预览 / 下载按钮换忙碌文案后宽度不变（点击预览不再把整表抖一下）", previewWidth !== null && downloadWidth !== null && previewWidth.w0 === previewWidth.w1 && downloadWidth.w0 === downloadWidth.w1, JSON.stringify({ preview: previewWidth, download: downloadWidth }));
check("⑤b 命中行口径：状态 = 草稿、上传人 = 潘兴、项目列 = 编号 + 名字",
  byKeyword.rows[0].status === "draft" && byKeyword.rows[0].statusText === "草稿" && byKeyword.rows[0].uploader === userRow.display_name && byKeyword.rows[0].projectCode === project.code && byKeyword.rows[0].projectName === project.name,
  JSON.stringify(byKeyword.rows[0] ?? null));
await clickSelector("[data-file-filter=keyword] button");
const kwClearedReady = await waitFor("window.location.hash === " + j("#/files") + " && document.querySelectorAll(" + j("[data-file-row]") + ").length > 0", 40000);
await sleep(1200);
const afterKwClear = await ev(rowExpr);
check("⑤c 清空搜索（×）→ 地址回 #/files、首行 / 计数还原",
  kwClearedReady === true && afterKwClear.rows[0] !== undefined && afterKwClear.rows[0].id === expectCurrentIds[0] && afterKwClear.count === "共 " + String(expectCurrentIds.length) + " 条",
  JSON.stringify({ hash: afterKwClear.hash, count: afterKwClear.count }));

// ---------- ⑥ 回收站栏 ----------
await recycleViaApi(fileId);
console.log("API 回收：" + fileName);
const expectRecycledIds = await orderedIds(STATUSES_RECYCLED);
await clickSelector("[data-file-tab=recycled]");
const recycledReady = await waitFor("window.location.hash.indexOf(" + j("tab=recycled") + ") !== -1 && document.querySelectorAll(" + j("[data-file-row]") + ").length > 0", 40000);
await sleep(1500);
const bin = await ev(rowExpr);
const binShot = await shot("file-library-recycled", { x: 0, y: 0, width: 1500, height: 950, scale: 1 });
console.log("截图：" + binShot);
check("⑥ 回收站栏：地址 tab=recycled、标签当前项 = 回收站、请求 = filter[status]=recycled",
  recycledReady === true && bin.activeTab === "recycled" && lastFileReq().indexOf("filter[status]=recycled") !== -1,
  JSON.stringify({ hash: bin.hash, active: bin.activeTab }));
check("⑥b 回收站计数 / 行序与库内 recycled 逐一对账、行状态签全 = 回收站",
  bin.count === "共 " + String(expectRecycledIds.length) + " 条" && bin.rows.map((row) => row.id).join(",") === expectRecycledIds.slice(0, 50).join(",") && bin.rows.every((row) => row.status === "recycled" && row.statusText === "回收站"),
  JSON.stringify({ count: bin.count, db: expectRecycledIds.length, rows: bin.rowCount }));

// ---------- ⑦ 回收站写口：恢复 ----------
await clickSelector("[data-file-filter=keyword] input");
await page.send("Input.insertText", { text: fileName });
const binKwReady = await waitFor("document.querySelectorAll(" + j("[data-file-row]") + ").length === 1", 40000);
await sleep(1200);
const binKw = await ev(rowExpr);
check("⑥c 回收站搜索命中：1 行 = 测试文件、状态 = 回收站、移入列 = 时间 · 潘兴",
  binKwReady === true && binKw.rows[0].id === fileId && binKw.rows[0].status === "recycled" && binKw.rows[0].when.indexOf(userRow.display_name) !== -1 && binKw.rows[0].when.length > 18,
  JSON.stringify(binKw.rows[0] ?? null));
await clickSelector("[data-file-restore=" + j(fileId) + "]");
const restoredReady = await waitFor("document.querySelector(" + j("[data-file-notice=ok]") + ") !== null", 30000);
const noticeSeenAt = Date.now();
await sleep(420);
const noticeBox = await ev("(function(){var n=document.querySelector(" + j("[data-file-notice=ok]") + ");if(n===null){return null;}var r=n.getBoundingClientRect();return {text:String(n.textContent||" + j("") + ").trim(),top:Math.round(r.top),centerX:Math.round(r.left+r.width/2),vw:window.innerWidth,position:getComputedStyle(n).position};})()");
const restoredRowsGone = await waitFor("document.querySelectorAll(" + j("[data-file-row]") + ").length===0", 6000);
const afterRestore = await ev(rowExpr);
const restoredRow = await fileStatusOf(fileId);
check("⑦ 恢复：通知「已恢复」+ 行移出回收站（空态）+ DB status 回退 draft",
  restoredReady === true && restoredRowsGone === true && noticeBox !== null && noticeBox.text.indexOf("已恢复") !== -1 && noticeBox.text.indexOf("草稿") !== -1 && restoredRow !== undefined && restoredRow.status === "draft",
  JSON.stringify({ notice: noticeBox === null ? null : noticeBox.text, rows: afterRestore.rowCount, status: restoredRow === undefined ? null : restoredRow.status }));
const restoreAudit = Number((await db.query("select count(*)::int n from audit_logs where object_id = $1 and action = $2 and summary like $3", [fileId, "update", "回收站恢复：%"])).rows[0].n);
check("⑦b 恢复审计：audit_logs 一条「回收站恢复：…」（action=update）", restoreAudit === 1, String(restoreAudit));
check("⑦a 浮动提示几何：屏幕顶部居中浮空（position=fixed、0 ≤ top ≤ 48px、水平居中 ±40px）", noticeBox !== null && noticeBox.position === "fixed" && noticeBox.top >= 0 && noticeBox.top <= 48 && Math.abs(noticeBox.centerX - noticeBox.vw / 2) <= 40, JSON.stringify(noticeBox));
const noticeGone = await waitFor("document.querySelector(" + j("[data-file-notice]") + ") === null", 8000);
const noticeMs = Date.now() - noticeSeenAt;
check("⑦d 自动消失：成功提示约 2s 后自行收起（停留 1.5s ~ 5s，无需点关闭）", noticeGone === true && noticeMs >= 1500 && noticeMs <= 5000, noticeMs + "ms");
await clickSelector("[data-file-tab=current]");
const backCurrentReady = await waitFor("window.location.hash.indexOf(" + j("tab=") + ") === -1 && document.querySelectorAll(" + j("[data-file-row]") + ").length === 1", 40000);
await sleep(1200);
const backCurrent = await ev(rowExpr);
check("⑦c 切回系统现有文件栏：恢复的文件回到在库行（关键字仍在、1 行命中、状态 = 草稿）",
  backCurrentReady === true && backCurrent.rows[0] !== undefined && backCurrent.rows[0].id === fileId && backCurrent.rows[0].status === "draft",
  JSON.stringify({ hash: backCurrent.hash, rows: backCurrent.rowCount }));

// ---------- ⑧ 深链刷新 + 彻底删除 ----------
await recycleViaApi(fileId);
await ev("window.location.hash = " + j("#/files?tab=recycled&q=" + fileNameEnc));
await page.send("Page.reload");
const deepReady = await waitFor("document.querySelectorAll(" + j("[data-file-row]") + ").length === 1", 40000);
await sleep(1500);
const deep = await ev(rowExpr);
check("⑧ 深链 #/files?tab=recycled&q=<名> 刷新：回收站栏直接打开、输入框带词、1 行命中",
  deepReady === true && deep.hash.indexOf("tab=recycled") !== -1 && deep.hash.indexOf("q=" + fileNameEnc) !== -1 && deep.activeTab === "recycled" && deep.keyword === fileName && deep.rows[0].id === fileId,
  JSON.stringify({ hash: deep.hash, keyword: deep.keyword, rows: deep.rowCount }));
const purgeBtnReady = await waitFor("document.querySelector(" + j("[data-file-purge=" + j(fileId) + "]") + ") !== null", 15000);
await clickSelector("[data-file-purge=" + j(fileId) + "]");
const confirmShown = await waitFor("document.querySelector(" + j("[data-file-purge-confirm=" + j(fileId) + "]") + ") !== null", 8000);
await sleep(400);
const confirmShot = await shot("file-library-purge-confirm", { x: 0, y: 0, width: 1500, height: 950, scale: 1 });
console.log("截图：" + confirmShot);
check("⑨ 彻底删除入口（admin 渲染）+ 第一下出确认条（不可恢复提示 + 确认 / 取消）、DB 未动",
  purgeBtnReady === true && confirmShown === true && (await fileStatusOf(fileId)) !== undefined);
await clickSelector("[data-file-purge-cancel=" + j(fileId) + "]");
await sleep(600);
const cancelState = await ev("(function(){return {confirm:document.querySelector(" + j("[data-file-purge-confirm=" + j(fileId) + "]") + ") !== null,row:document.querySelector(" + j("[data-file-row=" + j(fileId) + "]") + ") !== null};})()");
check("⑨b 取消：确认条收起、行仍在（DB 未动）",
  cancelState.confirm === false && cancelState.row === true && (await fileStatusOf(fileId)) !== undefined,
  JSON.stringify(cancelState));
await clickSelector("[data-file-purge=" + j(fileId) + "]");
await waitFor("document.querySelector(" + j("[data-file-purge-confirm=" + j(fileId) + "]") + ") !== null", 8000);
await clickSelector("[data-file-purge-confirm=" + j(fileId) + "]");
const purgedReady = await waitFor("document.querySelector(" + j("[data-file-notice=ok]") + ") !== null && document.querySelector(" + j("[data-file-row=" + j(fileId) + "]") + ") === null", 40000);
await sleep(1500);
const afterPurge = await ev(rowExpr);
const purgedRow = await fileStatusOf(fileId);
const purgeAudit = Number((await db.query("select count(*)::int n from audit_logs where object_id = $1 and action = $2 and summary like $3", [fileId, "delete", "彻底删除：%"])).rows[0].n);
check("⑨c 确认彻底删除：通知「已彻底删除」+ 行消失 + DB 文件行清零 + 审计留痕",
  purgedReady === true && afterPurge.notice.indexOf("已彻底删除") !== -1 && purgedRow === undefined && purgeAudit === 1,
  JSON.stringify({ notice: afterPurge.notice, db: purgedRow === undefined ? "purged" : purgedRow, audit: purgeAudit }));

// ---------- ⑩ 项目回收站 ----------
await clickSelector("[data-file-tab=project-recycled]");
const projectBinReady = await waitFor("window.location.hash.indexOf(" + j("tab=project-recycled") + ") !== -1 && (document.querySelector(" + j("[data-project-recycle-card]") + ") !== null || document.querySelector(" + j("[data-project-recycle-empty]") + ") !== null)", 40000);
await sleep(1200);
const projectBin = await ev("(function(){var tabs=document.querySelectorAll(" + j("[data-file-tab]") + ");var active=null;for(var i=0;i<tabs.length;i+=1){if(tabs[i].getAttribute(" + j("aria-current") + ")===" + j("page") + "){active=tabs[i].getAttribute(" + j("data-file-tab") + ");}}return {activeTab:active,cards:document.querySelectorAll(" + j("[data-project-recycle-card]") + ").length,empty:document.querySelector(" + j("[data-project-recycle-empty]") + ")!==null,filters:document.querySelectorAll(" + j("[data-file-filter]") + ").length,hash:window.location.hash};})()");
const projectBinShot = await shot("file-library-project-recycled", { x: 0, y: 0, width: 1500, height: 950, scale: 1 });
console.log("截图：" + projectBinShot);
check("⑩ 项目回收站：地址 tab=project-recycled、当前标签正确、请求 filter[recycled]=true、卡片网格或空态存在、文件筛选条隐藏",
  projectBinReady === true && projectBin.activeTab === "project-recycled" && projectBin.filters === 0 && (projectBin.cards > 0 || projectBin.empty === true) && lastProjectReq().indexOf("filter[recycled]=true") !== -1,
  JSON.stringify({ projectBin: projectBin, req: lastProjectReq().slice(0, 200) }));

// ---------- ⑪ 收尾 ----------
check("⑪ 控制台零报错 / 零异常", consoleErrors.length === 0, consoleErrors.slice(0, 3).join(" ;; "));
await db.query("update sessions set revoked_at = now() where token_hash = $1", [sha256(token)]);
const residue = (await db.query("select (select count(*)::int from files where id = $1) as files, (select count(*)::int from file_versions where file_id = $1) as versions, (select count(*)::int from sessions where token_hash = $2 and revoked_at is null) as sessions", [fileId, sha256(token)])).rows[0];
check("⑪b 零残留：文件 / 版本 / 会话全 0 行（上传会话行是历史台账，保留）",
  Number(residue.files) === 0 && Number(residue.versions) === 0 && Number(residue.sessions) === 0,
  JSON.stringify(residue));
const failed = checks.filter((item) => item.ok !== true).length;
console.log("—— 合计 " + String(checks.length) + " 项：" + String(checks.length - failed) + " 通过 / " + String(failed) + " 失败 ——");
try { page.ws.close(); } catch (error) { /* 忽略 */ }
chrome.kill();
await db.end();
process.exit(failed === 0 ? 0 : 1);
