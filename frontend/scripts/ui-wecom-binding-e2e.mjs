#!/usr/bin/env node
/**
 * LibiaoLink 前端 · 回放：企微单聊绑定（D5 首登引导弹窗 + 设置页补绑 / 解绑 + 未绑定提示 · Push 250）
 *
 * 业务口径（2026-10-16）：「在点击用户右上角头像后的列表中添加一个设置页」+ 项目组定案：D5 首登引导弹窗
 * （取码 → 在与机器人的单聊里发码 · **可跳过**）+ D6 设置页绑定态（掩码 + 时刻）/ 解绑 + 未绑定提示；
 * D4 未绑定降级话术终稿 =「当前用户未绑定企业微信，请前往设置补绑」。
 * 契约 = shared/src/modules/notifications.ts 末段「企业微信单聊绑定」；口径 = docs/M5-03-5-绑定码方案设计口径(企微单聊).md
 * v1.4 §3 / §6 / §9 / §10（D2 · D3 · D5 · D6）。
 *
 * 本脚本用真机浏览器（无头 Chrome + CDP）验：
 *   ① 首登引导：未绑定 + 本机未跳过 → 弹窗出现（标题 / 两步指引 / 未绑定面板）；点「稍后再说」→ 关闭且落跳过位；
 *      刷新不再弹（跳过位按账号分记 —— 账号键 = `/auth/me` 的 `user.id`（= 库内 `casdoor_id`）· 退出登录清除）；
 *   ② 头像菜单首项 = 「设置」（文案 + `#/settings` 落点），点它 → 地址到 `#/settings`、设置页渲染（`data-settings`）；
 *   ③ 未绑定态：设置页出「未绑定」+ D4 终稿话术；点「获取绑定码」→ 6 位码（`^[0-9]{6}$`）+ 倒计时递减 + 库内落 pending 行；
 *   ③b 复制通道（Push 253）：点「复制」→ 成功提示（`navigator.clipboard`，非安全上下文回退 `execCommand`）；
 *      码面可全选（`data-wecom-binding-code-text` + `select-all`）；
 *   ④ 频率口径（D3 修订 v1.8）：连取 5 次（每次作废旧码 —— 库内 5 行 = 4 expired + 1 pending）→ 第 6 次 429：
 *      按钮置灰 +「N 分 N 秒后可再次获取」倒计时（`details[].meta.retryAt`，最长 ≤ 3 分钟）、库内不增行；
 *   ④b 刷新不丢状态（Push 254 · 读面回填）：取码后刷新 → 码面与倒计时按读面 `bindingCode` 原样恢复；
 *      429 后刷新 → 罚时按读面 `retryAt` 恢复（按钮仍置灰 + 倒计时续算）—— 码失效提醒 toast 需等满 TTL，
 *      回放不覆盖（由码面文案 + 单元口径承担）；
 *   ⑤ 已绑定（夹具落绑定行）：**不刷新页面**、靠面板 5 秒轮询自动切「已绑定」（Push 253 修「企微已回执绑定成功、
 *      设置页仍显示未绑定」）；设置页「已绑定」= 掩码末 4 位 + 绑定时间，页面里不出现完整 open_userid（§9 最小暴露）；
 *      已绑定 = 不弹引导（清掉本机跳过位后刷新仍不弹）；
 *   ⑥ 解绑：二次确认（取消 = 仍是已绑定、确认 = 回未绑定）+ 库内绑定行去址（`bound_at` / `user_id` 置空、行仍在）
 *      + `audit_logs` 恰一条（objectType user / action delete / summary 与 changes 只带掩码）；
 *   ⑦ 解绑后引导恢复（未绑定 + 未跳过 → 再弹），点「前往设置」→ 地址到 `#/settings`；
 *   ⑧ 未绑定提示：站内信弹窗底部「当前用户未绑定企业微信」+「前往设置补绑」→ 点它落 `#/settings`；
 *   ⑨ 控制台零报错；跑完撤销会话 / 清绑定码行 / 清绑定夹具行
 *      （audit_logs 只读留痕 —— api 角色无 DELETE 权，同 m6-stakeholder 先例，不算残留）。
 *
 * 前置（三件都在本机跑着）：
 *   1. 前端 dev：cd frontend && npm run dev（默认 3000）
 *   2. api：cd server && npm run start:api（默认 3001，需先 npm run build；本刀无服务端改动）
 *   3. 数据库：本地沙箱 PG
 *   4. 本机装了 Chrome（脚本 headless 起一个调试实例；路径可用 CHROME_PATH 覆盖）
 *
 * 用法：node scripts/ui-wecom-binding-e2e.mjs
 *   可覆盖的环境变量：FRONTEND_BASE / DATABASE_URL / CHROME_PATH / CDP_PORT / REPLAY_USER / PG_MODULE / SHOT_DIR / WECOM_BOT_ID
 *
 * 夹具：一条临时会话（跑完撤销）+ 一条绑定行（跑完清掉）+ 绑定码行走真实取码接口（跑完清掉）。
 * 环境限制：本地沙箱没有内网翻译引擎 → 页面自动翻译的 `POST /api/v1/translate` 会 500（既有环境限制，与本刀无关），
 * 断言里按 URL 放行这一类；CDP 端口默认取系统空闲端口并杀整棵浏览器进程树（残留实例会被下一轮误连）。
 * 机器人维度（bot_id）默认读 `server/.env` 的 WECOM_BOT_ID —— 绑定态判定与解绑都按当前机器人成立（口径 §8）。
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
const GUIDE_KEY = "libiaolink.wecom.binding.guide.v1";
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
 * **上一轮那个实例**（profile 里已存跳过位 / 已改绑定态）→ 首登引导等断言会假失败。故：默认空闲端口 + 显式端口占用即报错退出。
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

await page.send("Emulation.setDeviceMetricsOverride", { width: 1500, height: 1000, deviceScaleFactor: 1, mobile: false });
const shots = [];

// ── ① 首登引导弹窗（未绑定 + 本机未跳过 → 弹；「稍后再说」→ 落跳过位 + 刷新不再弹）──────────────────────
await goto("#/projects", "[data-topnav]");
await waitFor(exists("[data-wecom-binding-guide]"), 15000);
check("首登引导弹窗出现（未绑定 + 本机未跳过 · 口径 §10 D5）", (await ev(exists("[data-wecom-binding-guide]"))) === true);
const guideText = String(await ev(textOf("[data-wecom-binding-guide]")) ?? "");
const guideRoles = await ev("(function(){var el=document.querySelector(" + j("[data-wecom-binding-guide]") + ");if(el===null){return null;}return {role:el.getAttribute(" + j("role") + "),modal:el.getAttribute(" + j("aria-modal") + "),skip:el.querySelector(" + j("[data-wecom-binding-guide-skip]") + ")===null?null:String(el.querySelector(" + j("[data-wecom-binding-guide-skip]") + ").textContent||" + j("") + ").trim(),go:el.querySelector(" + j("[data-wecom-binding-guide-goto]") + ")===null?null:String(el.querySelector(" + j("[data-wecom-binding-guide-goto]") + ").textContent||" + j("") + ").trim(),panel:el.querySelector(" + j("[data-wecom-binding]") + ")===null?null:el.querySelector(" + j("[data-wecom-binding]") + ").getAttribute(" + j("data-wecom-binding") + ")};})()");
check("引导弹窗是模态框（role=dialog + aria-modal）且内含未绑定面板", guideRoles !== null && guideRoles.role === "dialog" && guideRoles.modal === "true" && guideRoles.panel === "unbound", JSON.stringify(guideRoles));
check("引导弹窗文案 = 标题「绑定企业微信」+ 两步指引（取码 → 单聊发码）", guideText.indexOf("绑定企业微信") >= 0 && guideText.indexOf("获取绑定码") >= 0, guideText.slice(0, 120));
check("引导弹窗可跳过：按钮文案 =「稍后再说」+「前往设置」", guideRoles !== null && guideRoles.skip === "稍后再说" && guideRoles.go === "前往设置", JSON.stringify(guideRoles === null ? null : [guideRoles.skip, guideRoles.go]));
shots.push(await shot("wecom-guide-1"));
await click("[data-wecom-binding-guide-skip]");
check("点「稍后再说」→ 弹窗关闭、页面可继续用（顶栏在位）", (await waitFor("document.querySelector(" + j("[data-wecom-binding-guide]") + ") === null", 8000)) === true && (await ev(exists("[data-topnav]"))) === true);
const storedGuide = String(await ev("String(window.localStorage.getItem(" + j(GUIDE_KEY) + "))"));
check("跳过位落本机记忆（按账号分记 · 账号键 = /auth/me 的 user.id = 库内 casdoor_id）", storedGuide.indexOf(userRow.casdoor_id) >= 0, storedGuide);
await reload("[data-topnav]");
await sleep(2000);
check("跳过位生效：刷新后不再弹引导", (await ev(exists("[data-wecom-binding-guide]"))) === false);

// ── ② 头像菜单首项「设置」→ #/settings ────────────────────────────────────────────────────────────────
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
check("账号菜单首项 = 「设置」（业务口径 2026-10-16「在点击用户右上角头像后的列表中添加一个设置页」）", first !== null && first.settings === true && first.label === "设置" && first.href === "#/settings", JSON.stringify(menu));
check("设置项在「退出登录」之前、其余入口（操作记录 / 文件库）仍在", menu !== null && menu.findIndex((item) => item.label === "退出登录") > 0 && menu.findIndex((item) => item.label === "设置") < menu.findIndex((item) => item.label === "退出登录"), JSON.stringify(menu === null ? null : menu.map((item) => item.label)));
shots.push(await shot("wecom-account-menu-2", { x: 1000, y: 0, width: 500, height: 320, scale: 1 }));
await click("[data-account-settings]");
check("点「设置」→ 地址到 #/settings 且设置页渲染（data-settings）", (await waitFor("window.location.hash === " + j("#/settings"), 8000)) === true && (await waitFor(exists("[data-settings-card=wecom-binding]"), 8000)) === true, String(await hashOf()));
check("设置页标题 =「设置」（标题 + 副标题口径）", String(await ev(textOf("[data-settings]")) ?? "").indexOf("设置") >= 0);
await reload("[data-settings-card=wecom-binding]");
check("设置页地址即状态：直接刷新 #/settings 仍在设置页", String(await hashOf()) === "#/settings" && (await ev(exists("[data-settings-card=wecom-binding]"))) === true, String(await hashOf()));

// ── ③ 未绑定态 + 取码（6 位 / TTL 倒计时 / 库内 pending 行）────────────────────────────────────────────
check("未绑定态：面板 = unbound + D4 终稿话术「当前用户未绑定企业微信，请前往设置补绑。」", (await ev(panelState())) === "unbound" && String(await ev(textOf("[data-wecom-binding]")) ?? "").indexOf("当前用户未绑定企业微信，请前往设置补绑。") >= 0, String(await ev(panelState())));
check("取码按钮在位且可点（按钮文案 =「获取绑定码」）", String(await ev(textOf("[data-wecom-binding-get-code]"))) === "获取绑定码");
shots.push(await shot("wecom-settings-unbound-3"));
const codeExpr = "(function(){var el=document.querySelector(" + j("[data-wecom-binding-code]") + ");if(el===null){return null;}var cd=el.querySelector(" + j("[data-wecom-binding-countdown]") + ");return {code:el.getAttribute(" + j("data-wecom-binding-code") + "),state:el.getAttribute(" + j("data-wecom-binding-code-state") + "),countdown:cd===null?null:Number(cd.getAttribute(" + j("data-wecom-binding-countdown") + ")),text:String(cd===null?" + j("") + ":cd.textContent||" + j("") + ").trim()};})()";
await click("[data-wecom-binding-get-code]");
const code1 = await waitFor(exists("[data-wecom-binding-code]"), 12000) ? await ev(codeExpr) : null;
check("点「获取绑定码」→ 出 6 位码（^[0-9]{6}$）+ 有效态 + 倒计时（≤ 300 秒 —— D3 修订 v1.8 TTL 5 分钟）", code1 !== null && /^[0-9]{6}$/.test(String(code1.code)) && code1.state === "active" && code1.countdown <= 300 && code1.countdown >= 270, JSON.stringify(code1));
const dbCode1 = (await db.query("select code, status, expires_at > now() as live, user_id from wecom_id_binding_codes where user_id = $1 order by id desc limit 1", [userRow.id])).rows[0];
check("库内落 pending 行且码与界面一致（TTL 5 分钟未过期）", dbCode1 !== undefined && dbCode1.code === code1.code && dbCode1.status === "pending" && dbCode1.live === true && dbCode1.user_id === userRow.id, JSON.stringify(dbCode1));
shots.push(await shot("wecom-code-4"));
await sleep(2600);
const code1b = await ev(codeExpr);
check("倒计时按秒递减（1 秒计时器）", code1b !== null && Number(code1b.countdown) < Number(code1.countdown) && String(code1b.text).indexOf("秒后失效") >= 0, JSON.stringify([code1.countdown, code1b === null ? null : code1b.countdown]));
// ③a 刷新不丢状态（Push 254 · 读面回填 bindingCode）：刷新页面 → 码面与倒计时按库内 pending 码原样恢复
const dbPending1 = (await db.query("select code from wecom_id_binding_codes where user_id = $1 and status = 'pending'", [userRow.id])).rows[0];
await reload("[data-wecom-binding]");
const codeAfterReload = (await waitFor(exists("[data-wecom-binding-code]"), 12000)) === true ? await ev(codeExpr) : null;
check("刷新页面后绑定码仍在（读面回填 bindingCode）：码 = 库内 pending 行 + 有效态 + 倒计时续算（≤ 300 秒）", codeAfterReload !== null && dbPending1 !== undefined && codeAfterReload.code === dbPending1.code && codeAfterReload.state === "active" && codeAfterReload.countdown > 0 && codeAfterReload.countdown <= 300, JSON.stringify({ ui: codeAfterReload, db: dbPending1 === undefined ? null : dbPending1.code }));
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
await db.query("insert into wecom_aibot_dm_activations (bot_id, wecom_userid, user_id, first_activated_at, last_message_at, bound_at, created_at, updated_at) values ($1, $2, $3, now() - interval '2 hours', now() - interval '2 hours', now() - interval '90 minutes', now() - interval '2 hours', now() - interval '90 minutes')", [BOT_ID, openUserid, userRow.id]);
// ⑤-a 自动刷新（Push 253 修「企微已回执绑定成功、设置页仍显示未绑定」）：**不刷新页面** —— 面板 5 秒轮询自行切态
const autoBound = await waitFor("(function(){var el=document.querySelector(" + j("[data-wecom-binding]") + ");return el!==null && el.getAttribute(" + j("data-wecom-binding") + ") === " + j("bound") + ";})()", 15000);
check("绑定行落库后不刷新页面 → 面板轮询自动切「已绑定」（Push 253 修）", autoBound === true, String(await ev(panelState())));
await ev("window.localStorage.removeItem(" + j(GUIDE_KEY) + ")");
await reload("[data-wecom-binding]");
const boundWaited = await waitFor("(function(){var el=document.querySelector(" + j("[data-wecom-binding]") + ");return el!==null && el.getAttribute(" + j("data-wecom-binding") + ") === " + j("bound") + ";})()", 12000);
const boundText = String(await ev(textOf("[data-wecom-binding]")) ?? "");
check("已绑定态：面板 = bound + 掩码（末 4 位）+ 绑定时间（口径 §6 / §9）", boundWaited === true && boundText.indexOf(openUseridMasked) >= 0 && boundText.indexOf("绑定时间") >= 0 && boundText.indexOf("已绑定") >= 0, boundText.slice(0, 160));
const pageHtml = String(await ev("String(document.body.innerHTML)"));
check("最小暴露（§9）：设置页不出现完整密文 open_userid（只有掩码）", pageHtml.indexOf(openUserid) < 0 && pageHtml.indexOf(openUseridMasked) >= 0, "含掩码 " + String(pageHtml.indexOf(openUseridMasked) >= 0) + " / 含完整值 " + String(pageHtml.indexOf(openUserid) >= 0));
check("已绑定 = 不弹引导（清掉本机跳过位后刷新仍不弹）", (await ev(exists("[data-wecom-binding-guide]"))) === false);
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

// ── ⑦ 解绑后引导恢复 + 「前往设置」落 #/settings ──────────────────────────────────────────────────────
await reload("[data-settings-card=wecom-binding]");
const guideBack = await waitFor(exists("[data-wecom-binding-guide]"), 12000);
check("解绑后引导恢复（未绑定 + 未跳过 → 再弹一次）", guideBack === true);
const goClick = await click("[data-wecom-binding-guide-goto]");
const gotoHash = await waitFor("window.location.hash === " + j("#/settings"), 8000);
check("点「前往设置」→ 地址到 #/settings、引导关闭（跳过位同时落记）", goClick !== null && gotoHash === true && (await ev(exists("[data-wecom-binding-guide]"))) === false, String(await hashOf()));

// ── ⑧ 未绑定提示：站内信弹窗底部提示 + 「前往设置补绑」────────────────────────────────────────────────
await goto("#/projects", "[data-topnav]");
await click("[data-inbox-trigger]");
const inboxHint = await waitFor(exists("[data-inbox-wecom-unbound]"), 12000);
const inboxText = String(await ev(textOf("[data-inbox-wecom-unbound]")) ?? "");
check("站内信弹窗出未绑定提示（D6）：「当前用户未绑定企业微信」+「前往设置补绑」", inboxHint === true && inboxText.indexOf("当前用户未绑定企业微信") >= 0 && inboxText.indexOf("前往设置补绑") >= 0, inboxText);
shots.push(await shot("wecom-inbox-unbound-9"));
await click("[data-inbox-wecom-settings]");
check("点「前往设置补绑」→ 落 #/settings", (await waitFor("window.location.hash === " + j("#/settings"), 8000)) === true && (await waitFor(exists("[data-settings-card=wecom-binding]"), 8000)) === true, String(await hashOf()));

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