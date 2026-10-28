#!/usr/bin/env node
/**
 * LibiaoLink 前端 · 回放：顶部导航栏（四个纯文字项 —— 蓝图 / 项目空间 / 任务模板 / 我的任务）
 *
 * 业务口径（2026-09-30）：「我要做顶部导航栏 分别是首页 项目空间 任务模版 我的任务」（UI 参考业务给的
 * styled-components 玻璃胶囊样张）→ 同日四轮收口：「把阴影去除」→「黑很明显的黑边去除」→「字的阴影也不要」
 * →「去除这个液态效果 只保留文字」。
 * 追加口径（2026-10-12）：「登录后默认进入项目空间 首页名称改成蓝图」—— 导航首项由「首页」改名「蓝图」
 * （落点不变，仍是顶层 `#/`）；登录默认入口改落项目空间（裸根 `/` → `#/projects`）。
 *
 * 本脚本用真机浏览器（无头 Chrome + CDP）验：
 *   ① 六个落点（登录默认入口（裸根 `/`）/ 蓝图页 / 列表页 / 任务模板页 / 我的任务 / 项目详情）上导航都是四项、
 *      文案与落点一一对应；
 *   ② 当前项恰好一项：蓝图页亮「蓝图」、列表页与项目详情亮「项目空间」、任务模板页亮「任务模板」、工作台亮「我的任务」；
 *   ③ 纯文字护栏（液态效果已下架）：四项都没有面（背景）、没有 box-shadow（含描边环内衬与字阴影）、没有 backdrop-filter、
 *      没有 ::after 伪元素（描边环 / 高光扫过）；悬停与按下都没有 transform（缩放 / rotate3d）；
 *   ④ 当前项 = 深色加粗、未选 = 中灰（取值同一套：rgb(24, 24, 27) 700 / rgb(82, 82, 82) 400）；
 *   ⑤ 窄屏（<1024px）顶栏整排隐藏，竖屏出现底部四项图标导航；手机横屏 844×390 改为左侧竖向导航、顶栏紧凑且全部入口可用（当前项 / 最小命中高度一并验）；
 *   ⑥ 点项即走（真机鼠标点「任务模板」/「我的任务」→ 地址随之为 #/templates / #/my-tasks）；
 *   ⑦ 控制台零报错；跑完会话撤销、库内零残留；
 *   ⑧ 登录默认入口（2026-10-12 口径）：裸根 `/`（无 hash）落项目空间、地址规范化成 `#/projects`；`#/`（显式）仍是蓝图页。
 *
 * 前置（三件都在本机跑着）：
 *   1. 前端 dev：cd frontend && npm run dev（默认 3000）
 *   2. api：cd server && npm run start:api（默认 3001，需先 npm run build）
 *   3. 数据库：本地沙箱 PG（默认 127.0.0.1:5433/libiaolink）
 *   4. 本机装了 Chrome（脚本 headless 起一个调试实例；路径可用 CHROME_PATH 覆盖）
 *
 * 用法：node scripts/ui-topnav-e2e.mjs
 *   可覆盖的环境变量：FRONTEND_BASE / DATABASE_URL / CHROME_PATH / CDP_PORT / REPLAY_USER / PG_MODULE / SHOT_DIR
 *
 * 夹具：一条临时会话（跑完撤销）+ 库内已有一个项目（项目详情落点用，只读）。不改任何业务数据，跑完零残留。
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
const PORT = Number(process.env.CDP_PORT ?? 9412);
const DB = process.env.DATABASE_URL ?? "postgres://libiaolink_api@127.0.0.1:5433/libiaolink";
const REPLAY_USER = process.env.REPLAY_USER ?? "px-replay";
const SHOTS = process.env.SHOT_DIR ?? join(tmpdir(), "px-topnav-shots");
const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const Q = String.fromCharCode(34);
const j = (value) => JSON.stringify(value);
const checks = [];
const check = (name, ok, detail) => { checks.push({ name: name, ok: ok === true }); console.log((ok === true ? "  PASS  " : "  FAIL  ") + name + (ok === true || detail === undefined ? " " : "  —— " + detail)); };

mkdirSync(SHOTS, { recursive: true });
const db = new Client({ connectionString: DB });
await db.connect();
const userRow = (await db.query("select id, username, display_name from users where username = $1 and status = 'active'", [REPLAY_USER])).rows[0];
if (userRow === undefined) { console.error("回放用户不存在：" + REPLAY_USER); process.exit(1); }
const token = "pxtopnav-" + randomBytes(16).toString("hex");
const csrf = randomBytes(16).toString("hex");
await db.query("insert into sessions (token_hash, user_id, id_token, expires_at) values ($1, $2, $3, now() + make_interval(mins => 30))", [sha256(token), userRow.id, "ui-topnav-e2e"]);
console.log("临时会话：" + userRow.username + "（" + userRow.display_name + "）");

const liveRows = (await db.query("select code, seq_no from projects where deleted_at is null")).rows;
const seqByCode = new Map(liveRows.map((row) => [row.code, Number(row.seq_no)]));
const headTotal = Number((await db.query("select count(*)::int as total from projects where deleted_at is null")).rows[0].total);

const profile = mkdtempSync(join(tmpdir(), "pxseq-"));
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
page.ws.addEventListener("message", (event) => {
  const msg = JSON.parse(typeof event.data === "string" ? event.data : String(event.data));
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

await page.send("Emulation.setDeviceMetricsOverride", { width: 1500, height: 1000, deviceScaleFactor: 1, mobile: false });
const projectRow = (await db.query("select id, code, seq_no from projects where deleted_at is null order by seq_no desc limit 1")).rows[0];
if (projectRow === undefined) { console.error("库内没有项目：项目详情落点的断言没有夹具"); process.exit(1); }
const routes = [
  { name: "登录默认入口（裸根）", hash: "", expect: "projects", label: "项目空间" },
  { name: "蓝图页", hash: "#/", expect: "hub", label: "蓝图" },
  { name: "项目空间列表", hash: "#/projects", expect: "projects", label: "项目空间" },
  { name: "任务模板页", hash: "#/templates", expect: "templates", label: "任务模板" },
  { name: "我的任务工作台", hash: "#/my-tasks", expect: "workspace", label: "我的任务" },
  { name: "项目详情", hash: "#/project/" + projectRow.id, expect: "projects", label: "项目空间" },
];
const navExpr = "(function(){var nav=document.querySelector(" + j("[data-topnav]") + ");if(nav===null){return null;}var ns=getComputedStyle(nav);var as=nav.querySelectorAll(" + j("[data-topnav-item]") + ");var items=[];for(var i=0;i<as.length;i+=1){var a=as[i];var r=a.getBoundingClientRect();var s=getComputedStyle(a);var af=getComputedStyle(a," + j("::after") + ");items.push({key:a.getAttribute(" + j("data-topnav-item") + "),label:String(a.textContent||" + j("") + ").trim(),href:a.getAttribute(" + j("href") + "),current:String(a.getAttribute(" + j("aria-current") + ")),x:Math.round(r.left),y:Math.round(r.top),w:Math.round(r.width),h:Math.round(r.height),fontSize:s.fontSize,fontWeight:s.fontWeight,color:s.color,bgImage:s.backgroundImage,bgColor:s.backgroundColor,boxShadow:s.boxShadow,textShadow:s.textShadow,backdrop:s.backdropFilter||s.webkitBackdropFilter||" + j("none") + ",transform:s.transform,borderRadius:s.borderRadius,padding:s.padding,afterContent:af.content,afterBg:af.backgroundImage,afterShadow:af.boxShadow});}var h=document.querySelector(" + j("header") + ");var out={display:ns.display,items:items,labelSpans:nav.querySelectorAll(" + j(".topnav-btn__label") + ").length,shadowEls:nav.querySelectorAll(" + j(".topnav-btn__shadow") + ").length,headerH:h===null?null:Math.round(h.getBoundingClientRect().height)};var nr=nav.getBoundingClientRect();out.navRect={x:Math.round(nr.left),y:Math.round(nr.top),w:Math.round(nr.width),h:Math.round(nr.height)};return out;})()";
const seen = {};
const routeHashes = {};
const shots = [];
for (const route of routes) {
  await page.send("Page.navigate", { url: "about:blank" });
  await sleep(300);
  await page.send("Page.navigate", { url: FRONTEND + "/" + route.hash });
  let ready = false;
  for (let i = 0; i < 50 && ready !== true; i += 1) {
    ready = (await ev("document.querySelector(" + j("[data-topnav]") + ") !== null")) === true;
    if (ready !== true) await sleep(400);
  }
  await sleep(2200);
  seen[route.hash] = await ev(navExpr);
  routeHashes[route.hash] = String(await ev("window.location.hash"));
  const strip = { x: 0, y: 0, width: 1500, height: 96, scale: 1 };
  shots.push(await shot("topnav-" + route.expect + "-" + String(shots.length + 1), strip));
}
console.log("截图：" + shots.join(" / "));
for (const route of routes) {
  const info = seen[route.hash];
  const items = info === null || info === undefined ? [] : info.items;
  const labels = items.map((item) => item.label).join("|");
  const hrefOk = items.length === 4 && items[0].href === "#/" && items[1].href.indexOf("#/projects") === 0 && items[2].href === "#/templates" && items[3].href === "#/my-tasks";
  check("顶栏四项 + 文案与落点对得上（" + route.name + "）", items.length === 4 && labels === "蓝图|项目空间|任务模板|我的任务" && hrefOk === true, JSON.stringify(items.map((item) => item.label + "=" + item.href)));
  const current = items.filter((item) => item.current === "page");
  check("当前项恰好一项、且是「" + route.label + "」（" + route.name + "）", current.length === 1 && current[0].key === route.expect, JSON.stringify(current.map((item) => item.key + "/" + item.current)));
}
check("登录后默认入口：裸根 `/` 落项目空间、地址规范化成 #/projects（业务口径 2026-10-12「登录后默认进入项目空间」）", routeHashes[""] === "#/projects", String(routeHashes[""]));
check("蓝图页地址 `#/` 照常（显式进入、刷新 / 分享不丢）", routeHashes["#/"] === "#/", String(routeHashes["#/"]));

// 登录默认入口 × 本地筛选记忆（A1-18 恢复口径不变）：记忆里的筛选在裸根入口原样恢复并写回地址
const memoryStore = { v: 1, filters: { regions: [], projectTypes: [], managerIds: [], statuses: [], timeFrom: null, timeTo: null, sortDesc: false }, sidebarOpen: null };
await ev("window.localStorage.setItem(" + j("libiaolink.home.prefs.v1") + "," + j(JSON.stringify(memoryStore)) + ")");
await page.send("Page.navigate", { url: "about:blank" });
await sleep(300);
await page.send("Page.navigate", { url: FRONTEND + "/" });
let memoryReady = false;
for (let i = 0; i < 50 && memoryReady !== true; i += 1) {
  memoryReady = (await ev("document.querySelector(" + j("[data-topnav]") + ") !== null")) === true;
  if (memoryReady !== true) await sleep(400);
}
await sleep(1600);
const memoryHash = String(await ev("window.location.hash"));
check("裸根入口按本地记忆恢复筛选（记忆 sortDesc=false → #/projects?sort=createdAt:asc）", memoryHash === "#/projects?sort=createdAt:asc", memoryHash);
await ev("window.localStorage.removeItem(" + j("libiaolink.home.prefs.v1") + ")");
const hub = seen["#/"];
const hubItems = hub === null || hub === undefined ? [] : hub.items;
const badStyle = hubItems.filter((item) => item.bgImage !== "none" || item.bgColor !== "rgba(0, 0, 0, 0)" || item.boxShadow !== "none" || item.textShadow !== "none" || item.backdrop !== "none" || item.transform !== "none" || item.afterBg !== "none" || (item.afterContent !== "none" && item.afterContent !== "normal"));
check("纯文字护栏：四项无面 / 无描边环 / 无高光 / 无阴影（含字阴影）/ 无 backdrop / 无 transform，也没有 __shadow 落影层与 __label 文字面", hubItems.length === 4 && badStyle.length === 0 && hub.labelSpans === 0 && hub.shadowEls === 0, JSON.stringify(badStyle.slice(0, 2)) + " / labelSpans " + String(hub === null ? -1 : hub.labelSpans) + " / shadowEls " + String(hub === null ? -1 : hub.shadowEls));
const cur = hubItems.filter((item) => item.current === "page")[0] ?? null;
const rest = hubItems.filter((item) => item.current !== "page");
check("配色：当前项 = " + j("rgb(24, 24, 27)") + " 700、未选 = " + j("rgb(82, 82, 82)") + " 400（蓝图页）", cur !== null && cur.color === "rgb(24, 24, 27)" && cur.fontWeight === "700" && rest.length === 3 && rest.every((item) => item.color === "rgb(82, 82, 82)" && item.fontWeight === "400"), JSON.stringify(hubItems.map((item) => [item.key, item.color, item.fontWeight])));
check("字号 13px、命中区在顶栏内（不探头）", hubItems.length === 4 && hubItems.every((item) => item.fontSize === "13px") && hub.headerH !== null && hubItems.every((item) => item.y + item.h <= hub.headerH), "字号 " + String(hubItems[0] === undefined ? "?" : hubItems[0].fontSize) + " / 顶栏高 " + String(hub === null ? -1 : hub.headerH));
const hit = hubItems.filter((item) => item.key === "templates")[0] ?? null;
const hoverExpr = "(function(){var a=document.querySelector(" + j("[data-topnav-item=templates]") + ");if(a===null){return null;}var s=getComputedStyle(a);return {transform:s.transform,boxShadow:s.boxShadow,textShadow:s.textShadow,color:s.color,bgImage:s.backgroundImage};})()";
let hovered = null;
let pressed = null;
if (hit !== null) {
  const cx = Math.round(hit.x + hit.w / 2);
  const cy = Math.round(hit.y + hit.h / 2);
  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: cx, y: cy, button: "none" });
  await sleep(700);
  hovered = await ev(hoverExpr);
  await page.send("Input.dispatchMouseEvent", { type: "mousePressed", x: cx, y: cy, button: "left", clickCount: 1 });
  await sleep(600);
  pressed = await ev(hoverExpr);
  await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: cx, y: cy, button: "left", clickCount: 1 });
  await sleep(1400);
}
check("悬停：只变色（中灰 → 深色）、没有缩放 / 没有阴影 / 没有面", hovered !== null && hovered.color === "rgb(24, 24, 27)" && hovered.transform === "none" && hovered.boxShadow === "none" && hovered.textShadow === "none" && hovered.bgImage === "none", JSON.stringify(hovered));
check("按下：没有 rotate3d 抬起（transform 恒为 none）", pressed !== null && pressed.transform === "none", JSON.stringify(pressed));
check("点「任务模板」：地址随之到 #/templates", String(await ev("window.location.hash")) === "#/templates", String(await ev("window.location.hash")));
const afterTemplates = await ev(navExpr);
const wsItem = afterTemplates === null ? null : afterTemplates.items.filter((item) => item.key === "workspace")[0] ?? null;
const tmplCurrent = afterTemplates === null ? [] : afterTemplates.items.filter((item) => item.current === "page");
check("跳转后当前项跟着走（任务模板页亮「任务模板」）", tmplCurrent.length === 1 && tmplCurrent[0].key === "templates", JSON.stringify(tmplCurrent.map((item) => item.key)));
if (wsItem !== null) {
  const wx = Math.round(wsItem.x + wsItem.w / 2);
  const wy = Math.round(wsItem.y + wsItem.h / 2);
  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: wx, y: wy, button: "none" });
  await sleep(300);
  await page.send("Input.dispatchMouseEvent", { type: "mousePressed", x: wx, y: wy, button: "left", clickCount: 1 });
  await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: wx, y: wy, button: "left", clickCount: 1 });
  await sleep(1600);
}
check("再点「我的任务」：地址随之到 #/my-tasks", String(await ev("window.location.hash")) === "#/my-tasks", String(await ev("window.location.hash")));
await page.send("Emulation.setDeviceMetricsOverride", { width: 700, height: 900, deviceScaleFactor: 1, mobile: false });
await page.send("Page.navigate", { url: "about:blank" });
await sleep(300);
await page.send("Page.navigate", { url: FRONTEND + "/#/" });
let narrowReady = false;
for (let i = 0; i < 50 && narrowReady !== true; i += 1) {
  narrowReady = (await ev("document.querySelector(" + j("[data-topnav]") + ") !== null")) === true;
  if (narrowReady !== true) await sleep(400);
}
await sleep(2000);
const narrow = await ev(navExpr);
const narrowShot = await shot("topnav-narrow-700", { x: 0, y: 0, width: 700, height: 96, scale: 1 });
check("窄屏 700px：整排隐藏（display none）、窄屏截图 " + narrowShot, narrow !== null && narrow.display === "none", narrow === null ? "null" : String(narrow.display));
const mobileNavExpr = "(function(){var nav=document.querySelector(" + j("[data-mobile-nav]") + ");if(nav===null){return null;}var ns=getComputedStyle(nav);var as=nav.querySelectorAll(" + j("[data-mobile-nav-item]") + ");var items=[];for(var i=0;i<as.length;i+=1){var a=as[i];var r=a.getBoundingClientRect();items.push({key:a.getAttribute(" + j("data-mobile-nav-item") + "),label:String(a.textContent||" + j("") + ").trim(),current:String(a.getAttribute(" + j("aria-current") + ")),h:Math.round(r.height),svg:a.querySelectorAll(" + j("svg") + ").length,paths:a.querySelectorAll(" + j("path") + ").length});}var nr=nav.getBoundingClientRect();return {display:ns.display,position:ns.position,items:items,x:Math.round(nr.left),y:Math.round(nr.top),w:Math.round(nr.width),h:Math.round(nr.height),viewportW:window.innerWidth,viewportH:window.innerHeight};})()";
const mobileNav = await ev(mobileNavExpr);
const mobileKeys = mobileNav === null ? [] : mobileNav.items.map((item) => item.key);
const mobileCurrent = mobileNav === null ? [] : mobileNav.items.filter((item) => item.current === "page").map((item) => item.key);
const mobileLabels = mobileNav === null ? [] : mobileNav.items.map((item) => item.label);
const mobileShot = mobileNav === null ? null : await shot("mobile-nav-700", { x: 0, y: Math.max(0, mobileNav.viewportH - mobileNav.h - 4), width: 700, height: mobileNav.h + 4, scale: 1 });
check("窄屏 700px：底部导航固定显示、四项齐全、当前项仅「仪表盘」、图标与命中高度达标 " + String(mobileShot), mobileNav !== null && mobileNav.display === "block" && mobileNav.position === "fixed" && Math.abs(mobileNav.y + mobileNav.h - mobileNav.viewportH) <= 1 && mobileKeys.join("|") === "hub|projects|templates|workspace" && mobileLabels.join("|") === "仪表盘|项目空间|任务模板|我的任务" && mobileCurrent.length === 1 && mobileCurrent[0] === "hub" && mobileNav.items.every((item) => item.h >= 44 && item.svg === 1 && item.paths > 0), JSON.stringify(mobileNav));
await page.send("Emulation.setDeviceMetricsOverride", { width: 844, height: 390, deviceScaleFactor: 2, mobile: true, screenOrientation: { type: "landscapePrimary", angle: 90 } });
await sleep(600);
const landscapeExpr = "(function(){var nav=document.querySelector(" + j("[data-mobile-nav]") + ");var header=document.querySelector(" + j("[data-app-header]") + ");if(nav===null||header===null){return null;}var ns=getComputedStyle(nav);var as=nav.querySelectorAll(" + j("[data-mobile-nav-item]") + ");var items=[];for(var i=0;i<as.length;i+=1){var a=as[i];var r=a.getBoundingClientRect();var label=a.querySelector(" + j(".mobile-nav__label") + ");items.push({key:a.getAttribute(" + j("data-mobile-nav-item") + "),label:String(a.textContent||" + j("") + ").trim(),current:String(a.getAttribute(" + j("aria-current") + ")),w:Math.round(r.width),h:Math.round(r.height),labelOverflow:label===null?0:Math.max(0,label.scrollWidth-label.clientWidth),svg:a.querySelectorAll(" + j("svg") + ").length,paths:a.querySelectorAll(" + j("path") + ").length});}var nr=nav.getBoundingClientRect();var hr=header.getBoundingClientRect();var actions=header.querySelector(" + j(".app-header__actions") + ");var ar=actions===null?null:actions.getBoundingClientRect();var brand=header.querySelector(" + j(".app-header__brand-copy") + ");var prefix=header.querySelector(" + j(".app-header__control-prefix") + ");var inbox=document.querySelector(" + j("[data-inbox-trigger]") + ");var lang=document.querySelector(" + j("[data-lang-trigger]") + ");var bg=document.querySelector(" + j("[data-bg-tier-trigger]") + ");var account=document.querySelector(" + j("[data-account-trigger]") + ");var controls=[inbox,lang,bg,account].map(function(el){if(el===null){return false;}var s=getComputedStyle(el);var r=el.getBoundingClientRect();return s.display!==" + j("none") + "&&r.width>0&&r.height>0;});return {display:ns.display,position:ns.position,x:Math.round(nr.left),y:Math.round(nr.top),w:Math.round(nr.width),h:Math.round(nr.height),viewportW:window.innerWidth,viewportH:window.innerHeight,headerH:Math.round(hr.height),headerRight:Math.round(hr.right),actionsRight:ar===null?null:Math.round(ar.right),brandDisplay:brand===null?null:getComputedStyle(brand).display,prefixDisplay:prefix===null?null:getComputedStyle(prefix).display,controls:controls,items:items};})()";
const landscape = await ev(landscapeExpr);
const landscapeKeys = landscape === null ? [] : landscape.items.map((item) => item.key);
const landscapeCurrent = landscape === null ? [] : landscape.items.filter((item) => item.current === "page").map((item) => item.key);
const landscapeShot = await shot("mobile-nav-landscape-844x390", { x: 0, y: 0, width: 844, height: 390, scale: 1 });
check("手机横屏 844x390：主导航固定为左侧竖栏、顶栏紧凑、四项与全部顶栏入口可用、无标签截断 " + String(landscapeShot), landscape !== null && landscape.display === "block" && landscape.position === "fixed" && landscape.viewportW === 844 && landscape.viewportH === 390 && landscape.x === 0 && landscape.w >= 60 && landscape.w <= 80 && Math.abs(landscape.y - landscape.headerH) <= 1 && Math.abs(landscape.y + landscape.h - landscape.viewportH) <= 1 && landscape.headerH >= 44 && landscape.headerH <= 52 && landscape.headerRight <= landscape.viewportW && landscape.actionsRight !== null && landscape.actionsRight <= landscape.headerRight && landscape.brandDisplay === "none" && landscape.prefixDisplay === "none" && landscapeKeys.join("|") === "hub|projects|templates|workspace" && landscapeCurrent.length === 1 && landscapeCurrent[0] === "hub" && landscape.controls.every(Boolean) && landscape.items.every((item) => item.h >= 48 && item.labelOverflow === 0 && item.svg === 1 && item.paths > 0), JSON.stringify(landscape));
await page.send("Emulation.setDeviceMetricsOverride", { width: 1500, height: 1000, deviceScaleFactor: 1, mobile: false });
check("桌面 1500px：底部导航隐藏", String(await ev("getComputedStyle(document.querySelector(" + j("[data-mobile-nav]") + ")).display")) === "none", String(await ev("getComputedStyle(document.querySelector(" + j("[data-mobile-nav]") + ")).display")));
check("控制台零报错 / 零警告", consoleErrors.length === 0, consoleErrors.slice(0, 3).join(" ;; "));
await db.query("update sessions set revoked_at = now() where token_hash = $1", [sha256(token)]);
const residue = (await db.query("select count(*)::int as n from sessions where token_hash = $1 and revoked_at is null", [sha256(token)])).rows[0];
check("清理：临时会话已撤销、零残留", Number(residue.n) === 0, JSON.stringify(residue));
const failed = checks.filter((item) => item.ok !== true).length;
console.log("—— 合计 " + String(checks.length) + " 项：" + String(checks.length - failed) + " 通过 / " + String(failed) + " 失败 ——");
try { page.ws.close(); } catch (error) { /* 忽略 */ }
chrome.kill();
await db.end();
process.exit(failed === 0 ? 0 : 1);
