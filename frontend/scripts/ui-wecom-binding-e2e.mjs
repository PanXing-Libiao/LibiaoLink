/**
 * LibiaoLink 前端 · 回放：企微单聊绑定（站内信未绑定红点 + 设置页绑定 / 解绑 · Push 250 / 540）
 *
 * 最新业务口径（2026-10-27）：取消登录后自动浮卡；未绑定时顶栏「站内信」显示无数字红点，
 * 点开后由弹窗底部「当前用户未绑定企业微信」+「前往企微绑定」承接，绑定 / 解绑后红点即时收口。
 *
 * 契约 = shared/src/modules/notifications.ts 末段「企业微信单聊绑定」；口径 = docs/M5-03-5-绑定码方案设计口径(企微单聊).md
 * v1.4 §3 / §6 / §9 / §10（D2 · D3 · D5 · D6）。
 *
 * 本脚本用真机浏览器（无头 Chrome + CDP）验：
 *   ① 未绑定：登录后不出现任何企微绑定浮卡，顶栏站内信出现无数字红点；
 *   ② 头像菜单「企微绑定」→ #/settings；设置页标题 / 步骤 / 复制机器人链接；
 *   ③ 未绑定态取码：6 位码 + 倒计时递减 + 库内 pending 行；诊断块与复制通道回放；
 *   ④ 频率口径（D3 修订 v1.8）：连取 5 次 → 第 6 次 429：按钮置灰 + 罚时倒计时，库内不增行；
 *   ④b 刷新不丢取码 / 罚时状态（读面回填）；
 *   ⑤ 已绑定夹具：面板 5 秒轮询切「已绑定」、掩码 + 绑定时间、页面不出现完整 open_userid、
 *      顶栏不再显示绑定提示红点；消息开关默认开启且可关闭 / 恢复；
 *   ⑥ 解绑：二次确认 + 库内绑定行去址 + 操作记录恰一条且只带掩码；顶栏绑定红点恢复；
 *   ⑦ 设置页手点「刷新绑定状态」读入绑定夹具后：面板切「已绑定」+ 顶栏红点消失；移除夹具后恢复；
 *   ⑧ 未绑定提示：站内信弹窗底部「当前用户未绑定企业微信」+「前往设置补绑」→ 点它落 #/settings；
 *   ⑨ 控制台零报错；跑完撤销会话 / 清绑定码行 / 清绑定夹具行
 *      （audit_logs 只读留痕 —— api 角色无 DELETE 权，同 m6-stakeholder 先例，不算残留）。
 *
 * 前置（三件都在本机跑着）：
 *   1. 前端 dev：cd frontend && npm run dev（默认 3000）
 *   2. api：cd server && npm run start:api（默认 3001，需先 npm run build）
 *   3. 数据库：本地沙箱 PG
 *   4. 本机装了 Chrome（脚本 headless 起一个调试实例；路径可用 CHROME_PATH 覆盖）
 *
 * 用法：node scripts/ui-wecom-binding-e2e.mjs
 *   可覆盖的环境变量：FRONTEND_BASE / DATABASE_URL / CHROME_PATH / CDP_PORT / REPLAY_USER / PG_MODULE / SHOT_DIR / WECOM_BOT_ID
 *
 * 夹具：一条临时会话（跑完撤销）+ 一条绑定行（跑完清掉）+ 绑定码行走真实取码接口（跑完清掉）。
 * 环境限制：本地沙箱没有内网翻译引擎 → 页面自动翻译的 POST /api/v1/translate 会 500（既有环境限制，与本刀无关），
 * 断言里按 URL 放行这一类；CDP 端口默认取系统空闲端口并杀整棵浏览器进程树（残留实例会被下一轮误连）。
 * 机器人维度（bot_id）默认读 server/.env 的 WECOM_BOT_ID —— 绑定态判定与解绑都按当前机器人成立（口径 §8）。
 */

import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes } from "node:crypto";
const PG_MODULE = process.env.PG_MODULE ?? new URL("../../server/node_modules/pg/lib/index.js", import.meta.url).href;
const { default: pg } = await import(PG_MODULE);

const { Client } = pg;
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const FRONTEND = process.env.FRONTEND_BASE ?? "http://localhost:3000";
const CHROME = process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const EXPLICIT_CDP_PORT = process.env.CDP_PORT === undefined || process.env.CDP_PORT === "" ? null : Number(process.env.CDP_PORT);
const DB = process.env.DATABASE_URL ?? "postgres://libiaolink_api@127.0.0.1:5433/libiaolink";
const REPLAY_USER = process.env.REPLAY_USER ?? "px-replay";
const SHOTS = process.env.SHOT_DIR ?? join(tmpdir(), "px-wecom-binding-shots");

const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const j = (value) => JSON.stringify(value);
const checks = [];
const check = (name, ok, detail) => { checks.push({ name: name, ok: ok === true }); console.log((ok === true ? "  PASS  " : "  FAIL  ") + name + (ok === true || detail === undefined ? " " : "  —— " + detail)); };

/** 机器人维度：env 优先，其次读 server/.env 的 WECOM_BOT_ID（绑定行 / 绑定态判定都按它成立）。 */
function resolveBotId() {
  const fromEnv = process.env.WECOM_BOT_ID;
  if (fromEnv !== undefined && fromEnv.trim() !== "") {
    return fromEnv.trim();
  }
  try {
    const line = readFileSync(join(ROOT, "server", ".env"), "utf8").split(/\r?\n/).find((item) => item.startsWith("WECOM_BOT_ID="));
    if (line !== undefined) {
      return line.slice("WECOM_BOT_ID=".length).trim();
    }
  } catch (error) {
    // 读不到就按下面的报错退出（绑定态 / 解绑断言需要机器人维度）
  }
  return "";
}

const BOT_ID = resolveBotId();
if (BOT_ID === "") {
  console.error("读不到机器人维度 WECOM_BOT_ID（server/.env 缺失 / 该行缺失）：绑定态与解绑断言没有夹具，先补齐再跑。");
  process.exit(2);
}

/**
 * CDP 端口：默认取系统空闲端口。
 * 踩坑（本刀实测）：固定端口 + 无头浏览器残留（Edge 的 launcher 退出后子进程仍在监听固定端口）会让下一轮直接连到
 * **上一轮那个实例**（profile 里已存绑定态）→ 红点 / 设置页断言会假失败。故：默认空闲端口 + 显式端口占用即报错退出。
 */
async function pickCdpPort() {
  if (EXPLICIT_CDP_PORT !== null) { return EXPLICIT_CDP_PORT; }
  return await new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = address !== null && typeof address === "object" ? address.port : 0;
      probe.close(() => { resolve(port); });
    });
  });
}
async function cdpAlive(port) {
  try {
    await (await fetch("http://127.0.0.1:" + String(port) + "/json/version")).json();
    return true;
  } catch (error) {
    return false;
  }
}
const PORT = await pickCdpPort();
if (await cdpAlive(PORT)) {
  console.error("CDP 端口 " + String(PORT) + " 已被占用（上一轮无头浏览器残留）：先清残留（或换 CDP_PORT）再跑。");
  process.exit(2);
}

mkdirSync(SHOTS, { recursive: true });
const db = new Client({ connectionString: DB });
await db.connect();
const userRow = (await db.query("select id, casdoor_id, username, display_name from users where username = $1 and status = 'active'", [REPLAY_USER])).rows[0];
if (userRow === undefined) { console.error("回放用户不存在：" + REPLAY_USER); process.exit(1); }
const token = "pxwecombind-" + randomBytes(16).toString("hex");
const csrf = randomBytes(16).toString("hex");
const openUserid = "replay-px-" + randomBytes(6).toString("hex");
const openUseridMasked = "****" + openUserid.slice(-4);
await db.query("insert into sessions (token_hash, user_id, id_token, expires_at) values ($1, $2, $3, now() + make_interval(mins => 30))", [sha256(token), userRow.id, "ui-wecom-binding-e2e"]);
console.log("临时会话：" + userRow.username + "（" + userRow.display_name + "）· 机器人 " + BOT_ID);
console.log("夹具 open_userid（密文占位）：" + openUseridMasked + "（末 4 位）");

// 跑前兜底：清掉本用户残留的绑定码行 + 本机器人下本夹具 userid / 本用户的绑定行（上一轮异常中断留下的）
await db.query("delete from wecom_id_binding_codes where user_id = $1", [userRow.id]);
await db.query("delete from wecom_aibot_dm_activations where bot_id = $1 and (user_id = $2 or wecom_userid = $3)", [BOT_ID, userRow.id, openUserid]);

const auditBaseline = Number((await db.query("select count(*)::int n from audit_logs where object_type = 'user' and object_id = $1 and summary like $2", [userRow.id, "%解绑企业微信单聊%"])).rows[0].n);

const profile = mkdtempSync(join(tmpdir(), "pxwecombind-"));
let chrome = null;
/** 兜底收尾：按 launcher PID 杀整棵进程树（Edge 的 launcher 退出后子进程仍在 —— 不清会让下一轮连到残留实例）。 */
function killTree() {
  if (chrome === null) { return; }
  if (process.platform === "win32") {
    try { spawnSync("taskkill", ["/PID", String(chrome.pid), "/T", "/F"], { stdio: "ignore" }); } catch (error) { /* 已退出 */ }
    return;
  }
  try { chrome.kill(); } catch (error) { /* 已退出 */ }
}
process.on("exit", killTree);
/** 优雅收尾（优先）：走 CDP 的 Browser.close 让浏览器自己退干净，再兜底杀树。 */
async function teardownBrowser() {
  try {
    const version = await (await fetch("http://127.0.0.1:" + String(PORT) + "/json/version")).json();
    const socket = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise((resolve) => {
      socket.addEventListener("open", () => { socket.send(JSON.stringify({ id: 1, method: "Browser.close" })); resolve(); });
      socket.addEventListener("error", () => { resolve(); });
      setTimeout(resolve, 1500);
    });
    try { socket.close(); } catch (error) { /* 忽略 */ }
  } catch (error) {
    // CDP 已不可达：直接走兜底
  }
  await new Promise((resolve) => { setTimeout(resolve, 800); });
  killTree();
}
chrome = spawn(CHROME, ["--headless=new", "--remote-debugging-port=" + PORT, "--user-data-dir=" + profile, "--no-first-run", "--no-default-browser-check", "--disable-gpu", "about:blank"], { stdio: "ignore" });

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
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error("cdp timeout: " + method)); }, 15000);
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
/** 4xx / 5xx 响应（本刀刻意触发的 429 除外 —— 见收口断言）。 */
const httpErrors = [];
page.ws.addEventListener("message", (event) => {
  const msg = JSON.parse(typeof event.data === "string" ? event.data : String(event.data));
  if (msg.method === "Network.responseReceived" && msg.params !== undefined && msg.params.response !== undefined && msg.params.response.status >= 400) {
    httpErrors.push(String(msg.params.response.status) + " " + String(msg.params.response.url));
  }
  if (msg.method === "Log.entryAdded" && msg.params !== undefined && msg.params.entry !== undefined && msg.params.entry.level === "error") {
    consoleErrors.push(String(msg.params.entry.text));
  }
  if (msg.method === "Runtime.exceptionThrown") { consoleErrors.push("exceptionThrown"); }
  if (msg.method === "Runtime.consoleAPICalled" && msg.params !== undefined && msg.params.type === "error") {
    consoleErrors.push((msg.params.args ?? []).map((item) => String(item.value ?? item.description ?? " ")).join(" "));
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
const exists = (selector) => "document.querySelector(" + j(selector) + ") !== null";
async function waitFor(expression, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await ev(expression)) === true) { return true; }
    await sleep(250);
  }
  return false;
}
async function goto(hash, waitSelector) {
  await page.send("Page.navigate", { url: "about:blank" });
  await sleep(280);
  await page.send("Page.navigate", { url: FRONTEND + "/" + hash });
  const ok = waitSelector === undefined ? true : await waitFor(exists(waitSelector));
  await sleep(900);
  return ok;
}
async function reload(waitSelector) {
  await page.send("Page.reload", { ignoreCache: false });
  const ok = waitSelector === undefined ? true : await waitFor(exists(waitSelector));
  await sleep(900);
  return ok;
}
async function click(selector) {
  const box = await ev("(function(){var el=document.querySelector(" + j(selector) + ");if(el===null){return null;}el.scrollIntoView({block:" + j("center") + "});var r=el.getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2),disabled:el.hasAttribute(" + j("disabled") + ")};})()");
  if (box === null) { return null; }
  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x, y: box.y, button: "none" });
  await sleep(140);
  await page.send("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button: "left", clickCount: 1 });
  await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x, y: box.y, button: "left", clickCount: 1 });
  await sleep(260);
  return box;
}
const hashOf = () => ev("String(window.location.hash)");
const panelState = (scope) => "(function(){var root=" + (scope === undefined ? "document" : "document.querySelector(" + j(scope) + ")") + ";if(root===null){return null;}var el=root.querySelector(" + j("[data-wecom-binding]") + ");return el===null?null:el.getAttribute(" + j("data-wecom-binding") + ");})()";
const textOf = (selector) => "(function(){var el=document.querySelector(" + j(selector) + ");return el===null?null:String(el.textContent||" + j("") + ").trim();})()";
const inboxBindingUiExpr = "(function(){var trigger=document.querySelector(" + j("[data-inbox-trigger]") + ");if(trigger===null){return null;}var badge=trigger.querySelector(" + j(".inbox-badge") + ");var dot=badge===null?null:badge.querySelector(" + j(".inbox-badge-dot") + ");return {hint:trigger.getAttribute(" + j("data-inbox-binding-hint") + "),open:badge===null?null:badge.getAttribute(" + j("data-open") + "),kind:badge===null?null:badge.getAttribute(" + j("data-kind") + "),shape:dot===null?null:dot.getAttribute(" + j("data-shape") + "),text:dot===null?null:String(dot.textContent||" + j("") + ").trim()};})()";
const insertBindingFixture = () => db.query("insert into wecom_aibot_dm_activations (bot_id, wecom_userid, user_id, first_activated_at, last_message_at, bound_at, created_at, updated_at) values ($1, $2, $3, now() - interval '2 hours', now() - interval '2 hours', now() - interval '90 minutes', now() - interval '2 hours', now() - interval '90 minutes') on conflict (bot_id, wecom_userid) do update set user_id = excluded.user_id, last_message_at = excluded.last_message_at, bound_at = excluded.bound_at, messages_enabled = true, updated_at = excluded.updated_at", [BOT_ID, openUserid, userRow.id]);
const removeBindingFixture = () => db.query("delete from wecom_aibot_dm_activations where bot_id = $1 and wecom_userid = $2", [BOT_ID, openUserid]);

await page.send("Emulation.setDeviceMetricsOverride", { width: 1500, height: 1000, deviceScaleFactor: 1, mobile: false });
const shots = [];

// ── ① 未绑定：不自动浮卡；站内信图标显示无数字绑定红点 ───────────────────────────────────────
await goto("#/projects", "[data-topnav]");
const initialBindingHintReady = await waitFor("(function(){var el=document.querySelector(" + j("[data-inbox-trigger]") + ");return el!==null && el.getAttribute(" + j("data-inbox-binding-hint") + ") === " + j("true") + ";})()", 15000);
await sleep(1200);
const initialGuideGone = await ev(exists("[data-wecom-binding-guide]"));
const initialBindingUi = await ev(inboxBindingUiExpr);
check("登录后不再自动弹出企微绑定浮卡", initialGuideGone === false);
check(
  "未绑定时站内信显示无数字绑定红点（若另有未读则保留未读数字角标）",
  initialBindingHintReady === true && initialBindingUi !== null && initialBindingUi.hint === "true" && initialBindingUi.open === "true" && (initialBindingUi.kind === "binding" ? initialBindingUi.shape === "dot" && initialBindingUi.text === "" : initialBindingUi.kind === "unread" && initialBindingUi.shape === "count"),
  JSON.stringify(initialBindingUi),
);
shots.push(await shot("wecom-inbox-binding-dot-1"));

// ── ② 头像菜单首项「企微绑定」→ #/settings ────────────────────────────────────────────────────────────────
const avatarSel = "(function(){var list=document.querySelectorAll(" + j("button[aria-haspopup=menu]") + ");if(list.length===0){return null;}var el=list[list.length-1];var r=el.getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2),label:el.getAttribute(" + j("aria-label") + ")};})()";
const avatar = await ev(avatarSel);
check("账号头像按钮在位（aria-label = 账号菜单）", avatar !== null && avatar.label === "账号菜单", JSON.stringify(avatar));
await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: avatar.x, y: avatar.y, button: "none" });
await page.send("Input.dispatchMouseEvent", { type: "mousePressed", x: avatar.x, y: avatar.y, button: "left", clickCount: 1 });
await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: avatar.x, y: avatar.y, button: "left", clickCount: 1 });
await sleep(500);
const menuExpr = "(function(){var menu=document.querySelector(" + j("[role=menu]") + ");if(menu===null){return null;}var items=menu.querySelectorAll(" + j("[role=menuitem]") + ");var out=[];for(var i=0;i<items.length;i+=1){out.push({label:String(items[i].textContent||" + j("") + ").trim(),href:items[i].getAttribute(" + j("href") + "),settings:items[i].hasAttribute(" + j("data-account-settings") + ")});}return out;})()";
const menu = await ev(menuExpr);
const first = menu === null || menu.length === 0 ? null : menu[0];
check("账号菜单首项 = 「企微绑定」（业务口径 2026-10-16「在点击用户右上角头像后的列表中添加一个设置页」）", first !== null && first.settings === true && first.label === "企微绑定" && first.href === "#/settings", JSON.stringify(menu));
check("企微绑定项在「退出登录」之前、其余入口（操作记录 / 文件库）仍在", menu !== null && menu.findIndex((item) => item.label === "退出登录") > 0 && menu.findIndex((item) => item.label === "企微绑定") < menu.findIndex((item) => item.label === "退出登录"), JSON.stringify(menu === null ? null : menu.map((item) => item.label)));
shots.push(await shot("wecom-account-menu-2", { x: 1000, y: 0, width: 500, height: 320, scale: 1 }));
await click("[data-account-settings]");
check("点「企微绑定」→ 地址到 #/settings 且设置页渲染（data-settings）", (await waitFor("window.location.hash === " + j("#/settings"), 8000)) === true && (await waitFor(exists("[data-settings-card=wecom-binding]"), 8000)) === true, String(await hashOf()));
check("企微绑定页标题 =「企微绑定」", String(await ev(textOf("[data-settings]")) ?? "").indexOf("企微绑定") >= 0);
await reload("[data-settings-card=wecom-binding]");
check("设置页地址即状态：直接刷新 #/settings 仍在设置页", String(await hashOf()) === "#/settings" && (await ev(exists("[data-settings-card=wecom-binding]"))) === true, String(await hashOf()));

// ── ③ 未绑定态 + 取码（6 位 / TTL 倒计时 / 库内 pending 行）────────────────────────────────────────────
check("未绑定态：设置页面板 = unbound（共用两步绑定引导）", (await ev(panelState())) === "unbound", String(await ev(panelState())));
const settingsGuideExpr = "(function(){var card=document.querySelector(" + j("[data-settings-card=wecom-binding]") + ");var intro=card===null?null:card.querySelector(" + j("[data-wecom-binding-guide-content]") + ");var steps=intro===null?[]:Array.prototype.slice.call(intro.querySelectorAll(" + j("[data-wecom-binding-step]") + "));var copy=card===null?null:card.querySelector(" + j("[data-wecom-binding-guide-copy-link]") + ");var notesGone=card===null?false:card.querySelector(" + j("[data-settings-binding-notes]") + ")===null;return {intro:intro!==null,text:intro===null?null:String(intro.textContent||" + j("") + ").trim(),steps:steps.length,tops:steps.map(function(el){return Math.round(el.getBoundingClientRect().top);}),copy:copy===null?null:String(copy.textContent||" + j("") + ").trim(),notesGone:notesGone};})()";
const settingsGuide = await ev(settingsGuideExpr);
check("设置页绑定卡与提醒同款：标题 / 副标题 / 2 条步骤 / 复制机器人链接，且无底部说明块", settingsGuide !== null && settingsGuide.intro === true && settingsGuide.steps === 2 && settingsGuide.tops[1] - settingsGuide.tops[0] > 10 && settingsGuide.copy === "复制机器人链接" && settingsGuide.notesGone === true && settingsGuide.text.indexOf("绑定企微") >= 0 && settingsGuide.text.indexOf("帮助你及时收到/跟进相关任务") >= 0 && settingsGuide.text.indexOf("work.weixin.qq.com") < 0 && settingsGuide.text.indexOf("当前用户未绑定企业微信") < 0, JSON.stringify(settingsGuide));
await click("[data-settings-card=wecom-binding] [data-wecom-binding-guide-copy-link]");
const settingsLinkToast = await waitFor("(function(){var el=document.querySelector(" + j("[data-toast]") + ");return el!==null && String(el.textContent||" + j("") + ").indexOf(" + j("机器人链接已复制") + ") >= 0;})()", 6000);
check("设置页点「复制机器人链接」→ 成功提示（链接本体不直出）", settingsLinkToast === true);
check("取码按钮在位且可点（按钮文案 =「获取绑定码」）", String(await ev(textOf("[data-wecom-binding-get-code]"))) === "获取绑定码");

// ③-诊断（Push 255）：设置页显示的机器人 ID / Secret 必须是本机 server/.env 实际读取的值（核对凭据用）
const diagExpr = "(function(){var el=document.querySelector(" + j("[data-wecom-binding-diagnostics]") + ");if(el===null){return null;}var id=el.querySelector(" + j("[data-wecom-binding-diagnostics-bot-id]") + ");var sec=el.querySelector(" + j("[data-wecom-binding-diagnostics-secret]") + ");var toggle=el.querySelector(" + j("[data-wecom-binding-diagnostics-secret-toggle]") + ");var inbound=el.querySelector(" + j("[data-wecom-binding-diagnostics-inbound]") + ");return {count:Number(el.getAttribute(" + j("data-wecom-binding-diagnostics") + ")),botId:id===null?null:String(id.textContent||" + j("") + ").trim(),secret:sec===null?null:String(sec.textContent||" + j("") + ").trim(),visible:sec===null?null:sec.getAttribute(" + j("data-wecom-binding-diagnostics-secret-visible") + "),toggle:toggle===null?null:String(toggle.textContent||" + j("") + ").trim(),inbound:inbound===null?null:String(inbound.textContent||" + j("") + ").trim()};})()";
await waitFor(exists("[data-wecom-binding-diagnostics]"), 10000);
const diagMasked = await ev(diagExpr);
check("机器人诊断块出现：机器人 ID = server/.env 的 WECOM_BOT_ID", diagMasked !== null && String(diagMasked.botId) === BOT_ID, JSON.stringify(diagMasked));
check("机器人诊断：Secret 默认掩码（含 **** · 显示钮 =「显示」）+ 回调统计行在位", diagMasked !== null && String(diagMasked.secret).indexOf("****") >= 0 && diagMasked.visible === "false" && diagMasked.toggle === "显示" && diagMasked.inbound !== null, JSON.stringify(diagMasked));
await click("[data-wecom-binding-diagnostics-secret-toggle]");
const diagPlain = await ev(diagExpr);
check("点「显示」→ Secret 切明文（长度 > 掩码 · 不含 **** · 显示钮 =「隐藏」）", diagPlain !== null && diagPlain.visible === "true" && String(diagPlain.secret).indexOf("****") < 0 && String(diagPlain.secret).length > 8 && diagPlain.toggle === "隐藏", JSON.stringify({ visible: diagPlain === null ? null : diagPlain.visible, length: diagPlain === null ? null : String(diagPlain.secret).length }));
await click("[data-wecom-binding-diagnostics-secret-toggle]");
shots.push(await shot("wecom-settings-unbound-3"));
const codeExpr = "(function(){var el=document.querySelector(" + j("[data-wecom-binding-code]") + ");if(el===null){return null;}var cd=el.querySelector(" + j("[data-wecom-binding-countdown]") + ");return {code:el.getAttribute(" + j("data-wecom-binding-code") + "),state:el.getAttribute(" + j("data-wecom-binding-code-state") + "),countdown:cd===null?null:Number(cd.getAttribute(" + j("data-wecom-binding-countdown") + ")),text:String(cd===null?" + j("") + ":cd.textContent||" + j("") + ").trim()};})()";
await click("[data-wecom-binding-get-code]");
const code1 = await waitFor(exists("[data-wecom-binding-code]"), 12000) ? await ev(codeExpr) : null;
check("点「获取绑定码」→ 出 6 位码（^[0-9]{6}$）+ 有效态 + 倒计时（≤ 180 秒 —— 2026-10-20 安全修订 TTL 3 分钟）", code1 !== null && /^[0-9]{6}$/.test(String(code1.code)) && code1.state === "active" && code1.countdown <= 180 && code1.countdown >= 150, JSON.stringify(code1));
const dbCode1 = (await db.query("select code, status, expires_at > now() as live, user_id from wecom_id_binding_codes where user_id = $1 order by id desc limit 1", [userRow.id])).rows[0];
check("库内落 pending 行且码与界面一致（TTL 3 分钟未过期）", dbCode1 !== undefined && dbCode1.code === code1.code && dbCode1.status === "pending" && dbCode1.live === true && dbCode1.user_id === userRow.id, JSON.stringify(dbCode1));
shots.push(await shot("wecom-code-4"));
await sleep(2600);
const code1b = await ev(codeExpr);
check("倒计时按秒递减（1 秒计时器）", code1b !== null && Number(code1b.countdown) < Number(code1.countdown) && String(code1b.text).indexOf("秒后失效") >= 0, JSON.stringify([code1.countdown, code1b === null ? null : code1b.countdown]));
// ③a 刷新不丢状态（Push 254 · 读面回填 bindingCode）：刷新页面 → 码面与倒计时按库内 pending 码原样恢复
const dbPending1 = (await db.query("select code from wecom_id_binding_codes where user_id = $1 and status = 'pending'", [userRow.id])).rows[0];
await reload("[data-wecom-binding]");
const codeAfterReload = (await waitFor(exists("[data-wecom-binding-code]"), 12000)) === true ? await ev(codeExpr) : null;
check("刷新页面后绑定码仍在（读面回填 bindingCode）：码 = 库内 pending 行 + 有效态 + 倒计时续算（≤ 180 秒）", codeAfterReload !== null && dbPending1 !== undefined && codeAfterReload.code === dbPending1.code && codeAfterReload.state === "active" && codeAfterReload.countdown > 0 && codeAfterReload.countdown <= 180, JSON.stringify({ ui: codeAfterReload, db: dbPending1 === undefined ? null : dbPending1.code }));
shots.push(await shot("wecom-code-reload-4b"));
// ③b 复制通道（Push 253 修「复制一直失败」）：模拟非安全上下文（http + 局域网 IP = 无 navigator.clipboard）
const codeText = await ev("(function(){var el=document.querySelector(" + j("[data-wecom-binding-code-text]") + ");if(el===null){return null;}var cs=window.getComputedStyle(el);return {text:String(el.textContent||" + j("") + ").trim(),selectable:String(cs.userSelect||cs.webkitUserSelect||" + j("") + "),cls:String(el.className)};})()");
check("码面可全选（复制兜底：data-wecom-binding-code-text + select-all）", codeText !== null && String(codeText.cls).indexOf("select-all") >= 0 && String(codeText.selectable).indexOf("none") < 0, JSON.stringify(codeText));
await ev("(function(){window.__llClipboard=navigator.clipboard;try{Object.defineProperty(window.navigator," + j("clipboard") + ",{value:undefined,configurable:true});}catch(e){}return true;})()");
await click("[data-wecom-binding-copy]");
const copyToast = await waitFor("(function(){var el=document.querySelector(" + j("[data-toast]") + ");return el!==null && String(el.textContent||" + j("") + ").indexOf(" + j("绑定码已复制") + ") >= 0;})()", 6000);
const strayTextarea = await ev("document.querySelectorAll(" + j("textarea") + ").length");
await ev("(function(){try{Object.defineProperty(window.navigator," + j("clipboard") + ",{value:window.__llClipboard,configurable:true});}catch(e){}return true;})()");
check("无 navigator.clipboard（http 非安全上下文）时「复制」仍成功：回退 execCommand + 临时 textarea 已清理", copyToast === true && Number(strayTextarea) === 0, JSON.stringify({ copyToast: copyToast, textarea: strayTextarea }));
await click("[data-wecom-binding-get-code]");
await sleep(1500);
const code2 = await ev(codeExpr);
await click("[data-wecom-binding-get-code]");
await sleep(1500);
const code3 = await ev(codeExpr);
check("重复取码 = 以最新响应为准（第 2 / 3 次的码都不沿用上一条）", code2 !== null && code3 !== null && code3.code !== code2.code && code2.code !== code1.code, JSON.stringify([code1.code, code2 === null ? null : code2.code, code3 === null ? null : code3.code]));
await click("[data-wecom-binding-get-code]");
await sleep(1500);
const code4 = await ev(codeExpr);
await click("[data-wecom-binding-get-code]");
await sleep(1500);
const code5 = await ev(codeExpr);
check("第 4 / 5 次取码仍成功（D3 修订 v1.8：上限 = 5 次 / 3 分钟）", code4 !== null && code5 !== null && /^[0-9]{6}$/.test(String(code5.code)) && code5.state === "active" && code5.code !== code4.code, JSON.stringify([code4 === null ? null : code4.code, code5 === null ? null : code5.code]));
const dbCodes5 = (await db.query("select status, count(*)::int n from wecom_id_binding_codes where user_id = $1 group by status order by status", [userRow.id])).rows;
const pending5 = (await db.query("select code from wecom_id_binding_codes where user_id = $1 and status = 'pending'", [userRow.id])).rows;
check("库内 5 行 = 4 条 expired（旧 pending 已作废）+ 1 条 pending，且 pending = 界面最新码", Number((await db.query("select count(*)::int n from wecom_id_binding_codes where user_id = $1", [userRow.id])).rows[0].n) === 5 && pending5.length === 1 && pending5[0].code === code5.code, JSON.stringify(dbCodes5));

// ── ④ 频率口径（D3 修订 v1.8：5 次 / 3 分钟）—— 第 6 次 429 → 置灰 + 倒计时（details[].meta.retryAt）──────
const limitExpr = "(function(){var box=document.querySelector(" + j("[data-wecom-binding-rate-limit]") + ");var btn=document.querySelector(" + j("[data-wecom-binding-get-code]") + ");return {seconds:box===null?null:Number(box.getAttribute(" + j("data-wecom-binding-rate-limit") + ")),text:String(box===null?" + j("") + ":box.textContent||" + j("") + ").trim(),disabled:btn===null?null:btn.hasAttribute(" + j("disabled") + ")};})()";
const beforeLimit = await ev("(function(){var el=document.querySelector(" + j("[data-wecom-binding-get-code]") + ");return el===null?null:{disabled:el.hasAttribute(" + j("disabled") + ")};})()");
await click("[data-wecom-binding-get-code]");
const rateLimited = await waitFor(exists("[data-wecom-binding-rate-limit]"), 10000);
const limit = await ev(limitExpr);
check("第 6 次取码（5 次 / 3 分钟到顶）→ 429：按钮置灰 + 「N 分 N 秒后可再次获取」倒计时（最长 ≤ 180 秒）", rateLimited === true && beforeLimit !== null && beforeLimit.disabled === false && limit.disabled === true && limit.seconds > 0 && limit.seconds <= 180 && String(limit.text).indexOf("后可再次获取") >= 0 && String(limit.text).indexOf("分") >= 0, JSON.stringify(limit));
const afterLimitCount = Number((await db.query("select count(*)::int n from wecom_id_binding_codes where user_id = $1", [userRow.id])).rows[0].n);
check("429 不落码：库内仍是 5 行", afterLimitCount === 5, String(afterLimitCount));
shots.push(await shot("wecom-ratelimit-5"));
// ④b 刷新不丢罚时（Push 254 · 读面回填 retryAt）：刷新页面 → 按钮仍置灰 + 倒计时续算
await reload("[data-wecom-binding]");
const limitAfterReload = (await waitFor(exists("[data-wecom-binding-rate-limit]"), 12000)) === true ? await ev(limitExpr) : null;
check("刷新页面后罚时仍在（读面回填 retryAt）：按钮仍置灰 +「N 分 N 秒后可再次获取」倒计时 ≤ 180 秒", limitAfterReload !== null && limitAfterReload.disabled === true && limitAfterReload.seconds > 0 && limitAfterReload.seconds <= 180 && String(limitAfterReload.text).indexOf("后可再次获取") >= 0, JSON.stringify(limitAfterReload));

// ── ⑤ 已绑定（夹具绑定行）：掩码 + 绑定时间；页面不出现完整 open_userid；已绑定 = 不弹引导 ────────────────
await insertBindingFixture();
// ⑤-a 自动刷新（Push 253 修「企微已回执绑定成功、设置页仍显示未绑定」）：**不刷新页面** —— 面板 5 秒轮询自行切态
const autoBound = await waitFor("(function(){var el=document.querySelector(" + j("[data-wecom-binding]") + ");return el!==null && el.getAttribute(" + j("data-wecom-binding") + ") === " + j("bound") + ";})()", 15000);
check("绑定行落库后不刷新页面 → 面板轮询自动切「已绑定」（Push 253 修）", autoBound === true, String(await ev(panelState())));

await reload("[data-wecom-binding]");
const boundWaited = await waitFor("(function(){var el=document.querySelector(" + j("[data-wecom-binding]") + ");return el!==null && el.getAttribute(" + j("data-wecom-binding") + ") === " + j("bound") + ";})()", 12000);
const boundText = String(await ev(textOf("[data-wecom-binding]")) ?? "");
check("已绑定态：面板 = bound + 掩码（末 4 位）+ 绑定时间（口径 §6 / §9）", boundWaited === true && boundText.indexOf(openUseridMasked) >= 0 && boundText.indexOf("绑定时间") >= 0 && boundText.indexOf("已绑定") >= 0, boundText.slice(0, 160));
const messageToggleExpr = "(function(){var el=document.querySelector(" + j("[data-wecom-binding-messages]") + ");var btn=document.querySelector(" + j("[data-wecom-binding-messages-toggle]") + ");return el===null?null:{value:el.getAttribute(" + j("data-wecom-binding-messages") + "),checked:btn===null?null:btn.getAttribute(" + j("aria-checked") + ")};})()";
const toggleDefault = await ev(messageToggleExpr);
check("企微单聊消息开关：绑定后默认开启", toggleDefault !== null && toggleDefault.value === "true" && toggleDefault.checked === "true", JSON.stringify(toggleDefault));
await click("[data-wecom-binding-messages-toggle]");
const toggleOff = await waitFor("(function(){var el=document.querySelector(" + j("[data-wecom-binding-messages-toggle]") + ");return el!==null && el.getAttribute(" + j("data-wecom-binding-messages-toggle") + ") === " + j("false") + ";})()", 8000);
const toggleOffRow = (await db.query("select messages_enabled from wecom_aibot_dm_activations where bot_id = $1 and wecom_userid = $2", [BOT_ID, openUserid])).rows[0];
check("关闭消息开关：界面关闭 + 落库 messages_enabled=false", toggleOff === true && toggleOffRow !== undefined && toggleOffRow.messages_enabled === false, JSON.stringify(toggleOffRow));
await reload("[data-wecom-binding-messages]");
const togglePersisted = await waitFor("(function(){var el=document.querySelector(" + j("[data-wecom-binding-messages-toggle]") + ");return el!==null && el.getAttribute(" + j("data-wecom-binding-messages-toggle") + ") === " + j("false") + ";})()", 12000);
check("消息开关刷新后保持关闭", togglePersisted === true, String(await ev(messageToggleExpr)));
await click("[data-wecom-binding-messages-toggle]");
const toggleOn = await waitFor("(function(){var el=document.querySelector(" + j("[data-wecom-binding-messages-toggle]") + ");return el!==null && el.getAttribute(" + j("data-wecom-binding-messages-toggle") + ") === " + j("true") + ";})()", 8000);
const toggleOnRow = (await db.query("select messages_enabled from wecom_aibot_dm_activations where bot_id = $1 and wecom_userid = $2", [BOT_ID, openUserid])).rows[0];
check("重新开启消息开关：界面开启 + 落库 messages_enabled=true", toggleOn === true && toggleOnRow !== undefined && toggleOnRow.messages_enabled === true, JSON.stringify(toggleOnRow));
const pageHtml = String(await ev("String(document.body.innerHTML)"));
check("最小暴露（§9）：设置页不出现完整密文 open_userid（只有掩码）", pageHtml.indexOf(openUserid) < 0 && pageHtml.indexOf(openUseridMasked) >= 0, "含掩码 " + String(pageHtml.indexOf(openUseridMasked) >= 0) + " / 含完整值 " + String(pageHtml.indexOf(openUserid) >= 0));
const boundHintGone = await waitFor("(function(){var el=document.querySelector(" + j("[data-inbox-trigger]") + ");return el!==null && el.getAttribute(" + j("data-inbox-binding-hint") + ") === " + j("false") + ";})()", 15000);
check("已绑定 = 顶栏站内信不再显示绑定提示红点，且始终无自动浮卡", boundHintGone === true && (await ev(exists("[data-wecom-binding-guide]"))) === false, JSON.stringify(await ev(inboxBindingUiExpr)));
shots.push(await shot("wecom-bound-6"));

// ── ⑥ 解绑：二次确认（取消不回退 / 确认回未绑定）+ 库内去址 + audit_logs 一条（只带掩码）───────────────
await click("[data-wecom-binding-unbind]");
const confirmShown = await waitFor(exists("[data-wecom-binding-unbind-confirm]"), 8000);
const confirmUi = await ev("(function(){var yes=document.querySelector(" + j("[data-wecom-binding-unbind-confirm]") + ");var no=document.querySelector(" + j("[data-wecom-binding-unbind-cancel]") + ");var body=document.querySelector(" + j("[data-wecom-binding]") + ");return {yes:yes===null?null:String(yes.textContent||" + j("") + ").trim(),no:no===null?null:String(no.textContent||" + j("") + ").trim(),ask:body===null?" + j("") + ":String(body.textContent||" + j("") + ")};})()");
check("点「解绑」→ 出二次确认（确认解绑 / 取消 两枚按钮）", confirmShown === true && confirmUi !== null && confirmUi.yes === "确认解绑" && confirmUi.no === "取消", JSON.stringify(confirmUi === null ? null : [confirmUi.yes, confirmUi.no]));
check("二次确认文案 =「解绑后不再接收企微单聊推送，确认解绑？」", confirmUi !== null && confirmUi.ask.indexOf("解绑后不再接收企微单聊推送，确认解绑？") >= 0, String(confirmUi === null ? "" : confirmUi.ask).slice(0, 160));
shots.push(await shot("wecom-unbind-confirm-7"));
await click("[data-wecom-binding-unbind-cancel]");
await sleep(900);
const afterCancel = (await db.query("select bound_at, user_id from wecom_aibot_dm_activations where bot_id = $1 and wecom_userid = $2", [BOT_ID, openUserid])).rows[0];
check("点「取消」→ 仍是已绑定（界面不回退 + 库内绑定行未动）", (await ev(panelState())) === "bound" && afterCancel !== undefined && afterCancel.bound_at !== null && afterCancel.user_id === userRow.id, JSON.stringify(afterCancel));
await click("[data-wecom-binding-unbind]");
await waitFor(exists("[data-wecom-binding-unbind-confirm]"), 8000);
await click("[data-wecom-binding-unbind-confirm]");
const unboundWaited = await waitFor("(function(){var el=document.querySelector(" + j("[data-wecom-binding]") + ");return el!==null && el.getAttribute(" + j("data-wecom-binding") + ") === " + j("unbound") + ";})()", 12000);
const afterUnbind = (await db.query("select wecom_userid, user_id, bound_at from wecom_aibot_dm_activations where bot_id = $1 and wecom_userid = $2", [BOT_ID, openUserid])).rows[0];
check("点「确认解绑」→ 回未绑定态（面板 unbound）", unboundWaited === true, String(await ev(panelState())));
check("库内绑定行去址：bound_at / user_id 置空、激活登记行仍在（口径 §4）", afterUnbind !== undefined && afterUnbind.bound_at === null && afterUnbind.user_id === null && afterUnbind.wecom_userid === openUserid, JSON.stringify(afterUnbind));
const auditCount = Number((await db.query("select count(*)::int n from audit_logs where object_type = 'user' and object_id = $1 and summary like $2", [userRow.id, "%解绑企业微信单聊%"])).rows[0].n);
const auditRow = (await db.query("select id, occurred_at, actor_id, action, object_type, object_id, result, summary, changes, metadata from audit_logs where object_type = 'user' and object_id = $1 and summary like $2 order by id desc limit 1", [userRow.id, "%解绑企业微信单聊%"])).rows[0];
check("解绑写操作记录：恰一条新行（objectType user / action delete / result succeeded / actor = 本人）", auditCount === auditBaseline + 1 && auditRow !== undefined && auditRow.action === "delete" && auditRow.object_type === "user" && auditRow.result === "succeeded" && auditRow.actor_id === userRow.id, JSON.stringify({ before: auditBaseline, after: auditCount }) + " / " + JSON.stringify(auditRow === undefined ? null : [auditRow.action, auditRow.object_type, auditRow.result, auditRow.actor_id]));
check("操作记录只带掩码（§9）：summary 含掩码、changes.from = 掩码 / to = null、元数据记机器人维度", auditRow !== undefined && String(auditRow.summary).indexOf(openUseridMasked) >= 0 && String(auditRow.changes[0].field) === "wecomDmBinding" && String(auditRow.changes[0].from) === openUseridMasked && auditRow.changes[0].to === null && String(auditRow.metadata.botId) === BOT_ID, JSON.stringify(auditRow === undefined ? null : [auditRow.summary, auditRow.changes, auditRow.metadata]));
check("操作记录不含完整密文 open_userid（最小暴露）", auditRow !== undefined && JSON.stringify(auditRow).indexOf(openUserid) < 0, String(auditRow !== undefined && JSON.stringify(auditRow).indexOf(openUserid) >= 0));
shots.push(await shot("wecom-unbound-after-8"));

// ── ⑦ 解绑后红点恢复 + 设置页手动刷新绑定成功 ─────────────────────────────────────────────────────
await reload("[data-settings-card=wecom-binding]");
const unboundAfterReload = await waitFor(panelState() + " === " + j("unbound"), 12000);
const unboundHintRestored = await waitFor("(function(){var el=document.querySelector(" + j("[data-inbox-trigger]") + ");return el!==null && el.getAttribute(" + j("data-inbox-binding-hint") + ") === " + j("true") + ";})()", 12000);
const unboundUi = await ev(inboxBindingUiExpr);
check("解绑后站内信绑定提示红点恢复（仍无自动浮卡）", unboundAfterReload === true && unboundHintRestored === true && (await ev(exists("[data-wecom-binding-guide]"))) === false, JSON.stringify(unboundUi));

await insertBindingFixture();
const manualRefreshClick = await click("[data-wecom-binding-refresh]");
const manualBound = await waitFor(panelState() + " === " + j("bound"), 10000);
const manualBoundHintGone = await waitFor("(function(){var el=document.querySelector(" + j("[data-inbox-trigger]") + ");return el!==null && el.getAttribute(" + j("data-inbox-binding-hint") + ") === " + j("false") + ";})()", 10000);
check("手点「刷新绑定状态」：设置页切「已绑定」且顶栏绑定红点消失", manualRefreshClick !== null && manualBound === true && manualBoundHintGone === true && (await ev(exists("[data-wecom-binding-guide]"))) === false, JSON.stringify(await ev(inboxBindingUiExpr)));
shots.push(await shot("wecom-settings-manual-bound-7a"));
await removeBindingFixture();
await reload("[data-settings-card=wecom-binding]");
const unboundRestored = await waitFor(panelState() + " === " + j("unbound"), 12000);
const hintRestored = await waitFor("(function(){var el=document.querySelector(" + j("[data-inbox-trigger]") + ");return el!==null && el.getAttribute(" + j("data-inbox-binding-hint") + ") === " + j("true") + ";})()", 12000);
check("移除绑定夹具后站内信绑定红点再次恢复", unboundRestored === true && hintRestored === true, JSON.stringify(await ev(inboxBindingUiExpr)));

// ── ⑧ 未绑定提示：站内信弹窗底部提示 + 「前往企微绑定」────────────────────────────────────────────────
await goto("#/projects", "[data-topnav]");
await waitFor("(function(){var el=document.querySelector(" + j("[data-inbox-trigger]") + ");return el!==null && el.getAttribute(" + j("data-inbox-binding-hint") + ") === " + j("true") + ";})()", 12000);
const inboxUiBeforeOpen = await ev(inboxBindingUiExpr);
await click("[data-inbox-trigger]");
const inboxHint = await waitFor(exists("[data-inbox-wecom-unbound]"), 12000);
const inboxText = String(await ev(textOf("[data-inbox-wecom-unbound]")) ?? "");
check("点站内信红点后出未绑定提示（D6）：「当前用户未绑定企业微信」+「前往企微绑定」", inboxUiBeforeOpen !== null && inboxUiBeforeOpen.open === "true" && inboxHint === true && inboxText.indexOf("当前用户未绑定企业微信") >= 0 && inboxText.indexOf("前往企微绑定") >= 0, JSON.stringify({ ui: inboxUiBeforeOpen, text: inboxText }));
shots.push(await shot("wecom-inbox-unbound-9"));
await click("[data-inbox-wecom-settings]");
check("点「前往企微绑定」→ 落 #/settings", (await waitFor("window.location.hash === " + j("#/settings"), 8000)) === true && (await waitFor(exists("[data-settings-card=wecom-binding]"), 8000)) === true, String(await hashOf()));

// ── ⑨ 收口：控制台零报错 + 清夹具 ──────────────────────────────────────────────────────────────────
// 放行两类**已知**项：① 本刀刻意触发的取码 429；② 本地沙箱没有内网翻译引擎（HY-MT1.5-1.8B）→ 页面自动翻译
// POST /api/v1/translate 必然 500（既有环境限制，与本刀无关：Push 301 的通道，本刀不碰翻译）。其余 4xx / 5xx 一律算失败。
const allowList = (item) => (item.indexOf("429 ") === 0 && item.indexOf("/wecom-dm-binding/codes") > 0) || (item.indexOf("500 ") === 0 && item.indexOf("/api/v1/translate") > 0);
const unexpected = httpErrors.filter((item) => allowList(item) !== true);
const deliberate429 = httpErrors.filter((item) => item.indexOf("429 ") === 0 && item.indexOf("/wecom-dm-binding/codes") > 0);
check("接口面：除刻意触发的取码 429（" + String(deliberate429.length) + " 条）与本地无翻译引擎的 translate 500 外零 4xx / 5xx", unexpected.length === 0 && deliberate429.length >= 1, JSON.stringify({ unexpected: unexpected.slice(0, 3), deliberate429: deliberate429.length, all: httpErrors.slice(0, 6) }));
const resourceLogs = consoleErrors.filter((item) => item.indexOf("Failed to load resource") >= 0);
const otherConsole = consoleErrors.filter((item) => item.indexOf("Failed to load resource") < 0);
check("控制台零脚本异常 / 零业务报错（资源级 4xx / 5xx 已按 URL 逐条断言）", otherConsole.length === 0, otherConsole.slice(0, 3).join(" ;; "));
const cleanedCodes = await db.query("delete from wecom_id_binding_codes where user_id = $1", [userRow.id]);
const cleanedBinding = await db.query("delete from wecom_aibot_dm_activations where bot_id = $1 and wecom_userid = $2", [BOT_ID, openUserid]);
await db.query("update sessions set revoked_at = now() where token_hash = $1", [sha256(token)]);
const codesLeft = Number((await db.query("select count(*)::int n from wecom_id_binding_codes where user_id = $1", [userRow.id])).rows[0].n);
const activationLeft = Number((await db.query("select count(*)::int n from wecom_aibot_dm_activations where bot_id = $1 and (user_id = $2 or wecom_userid = $3)", [BOT_ID, userRow.id, openUserid])).rows[0].n);
const sessionLeft = Number((await db.query("select count(*)::int n from sessions where token_hash = $1 and revoked_at is null", [sha256(token)])).rows[0].n);
check("清理：绑定码行 / 绑定夹具行 / 临时会话零残留（操作记录按只读留痕保留一条）", codesLeft === 0 && activationLeft === 0 && sessionLeft === 0, JSON.stringify({ codesLeft, activationLeft, sessionLeft, cleanedCodes: cleanedCodes.rowCount, cleanedBinding: cleanedBinding.rowCount }));
console.log("截图：" + shots.join(" / "));

const failed = checks.filter((item) => item.ok !== true).length;
console.log("—— 合计 " + String(checks.length) + " 项：" + String(checks.length - failed) + " 通过 / " + String(failed) + " 失败 ——");
try { page.ws.close(); } catch (error) { /* 忽略 */ }
await teardownBrowser();
await db.end();
process.exit(failed === 0 ? 0 : 1);
