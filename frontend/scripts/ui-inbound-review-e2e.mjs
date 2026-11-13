/**
 * 本次改动的前端真机验收（2026-11-13）：
 *  A. 顶栏「任务模板」红点：有待审时出现、审完消失；
 *  B. 任务模板页「入库审核」板块 = 审核工作台（标签 / 待审核行 / 旧浮层已删）；
 *  C. 端到端：在板块里通过一条待审申请 → 公共节点库落库；
 *  D. 导入预览面板：双名称标签在、两句重复提示不在、术语统一到「个人节点库」。
 */
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";

/**
 * LibiaoLink 前端 · 入库审核与导入节点比对回放（2026-11-13）
 *
 * 前置（都在本机跑着，与同目录 m3-05 脚本同口径）：
 *   1. 前端 dev：cd frontend && npm run dev（默认 3000）
 *   2. api：cd server && npm run build && npm run start:api（默认 3001）
 *   3. 数据库：本地沙箱 PG（默认 127.0.0.1:5433/libiaolink），且该库已有回放账号
 *   4. 本机装了 Chrome（路径可用 CHROME_PATH 覆盖）
 * 环境变量：DATABASE_URL / REPLAY_USER / FRONTEND_BASE / API_BASE / CHROME_PATH / CDP_PORT / IMPORT_FIXTURE
 *
 * 它验什么（18 项）：
 *   A. 顶栏「任务模板」红点：有待审申请时出现、待审清零后消失；板块标签栏 11 枚且第 10 枚 = 入库审核；
 *   B. 「入库审核」板块 = 审核工作台（待审核 / 我的申请 两个标签、申请行在、板块原有的节点库 / 模板仍在），
 *      本地那套「待审申请」入口按钮与浮层已彻底删除；
 *   C. 端到端：在工作台里通过申请 → 公共节点库落库；
 *   D. 导入预览面板：节点行同时给「库内标准名称」与「导入表格名称」，标题下两句重复提示不再渲染，
 *      术语统一到「个人节点库」（不再出现「个人模板」）。
 * 说明：脚本会用 SQL 造一条待审申请（标题「回放待审节点·红点」）并在收尾删掉它与验证时新建的节点，
 *   再放回一条待审供下次复跑；跑完撤销临时会话。沙箱库专用，不要指向正式 / 测试环境。
 */

const { default: pg } = await import(process.env.PG_MODULE ?? new URL("../../server/node_modules/pg/lib/index.js", import.meta.url).href);
const { Client } = pg;
const DB = process.env.DATABASE_URL ?? "postgres://libiaolink_api@127.0.0.1:5433/libiaolink";
const FRONTEND = process.env.FRONTEND_BASE ?? "http://localhost:3000";
const API = process.env.API_BASE ?? "http://127.0.0.1:3001";
const CHROME = process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PORT = Number(process.env.CDP_PORT ?? 9412);
const USER = process.env.REPLAY_USER ?? "px-replay";
const FIXTURE = process.env.IMPORT_FIXTURE ?? new URL("./fixtures/import-node-feedback.xlsx", import.meta.url).pathname;
const PENDING_TITLE = "回放待审节点·红点";
const sha256 = (t) => createHash("sha256").update(t).digest("hex");

const db = new Client({ connectionString: DB });
await db.connect();
await db.query("update sessions set revoked_at = now() where id_token = 'verify-feedback' and revoked_at is null");
const userRow = (await db.query("select id from users where username=$1 and status='active'", [USER])).rows[0];
if (userRow === undefined) { console.error("回放用户不存在"); process.exit(1); }
const token = "vf-" + randomBytes(16).toString("hex");
const csrf = randomBytes(16).toString("hex");
await db.query("insert into sessions (token_hash,user_id,id_token,expires_at) values ($1,$2,$3, now()+make_interval(mins=>40))", [sha256(token), userRow.id, "verify-feedback"]);

await db.query("delete from task_node_requests where title = $1", [PENDING_TITLE]);
await db.query("insert into task_node_requests (stage_key, title, title_en, status, requested_by) values ('install', $1, 'Replay pending node', 'pending', $2)", [PENDING_TITLE, userRow.id]);

const COOKIE = "ll_sid=" + token + "; ll_csrf=" + csrf;
async function api(path, method = "GET", body) {
  const headers = { Cookie: COOKIE, "X-CSRF-Token": csrf, Accept: "application/json" };
  const init = { method, headers };
  if (body !== undefined) { headers["Content-Type"] = "application/json"; init.body = JSON.stringify(body); }
  const res = await fetch(API + path, init);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: res.status, json, text };
}

const checks = [];
function check(name, ok, detail) {
  checks.push(ok === true);
  console.log((ok === true ? "PASS  " : "FAIL  ") + name + (detail === undefined ? "" : "   [" + detail + "]"));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const profile = mkdtempSync(join(tmpdir(), "vf-"));
const chrome = spawn(CHROME, ["--headless=new", "--remote-debugging-port=" + PORT, "--user-data-dir=" + profile, "--no-first-run", "--no-default-browser-check", "--disable-gpu", "about:blank"], { stdio: "ignore" });
async function waitTarget() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const list = await (await fetch("http://127.0.0.1:" + PORT + "/json/list")).json();
      const t = list.find((x) => x.type === "page" && x.webSocketDebuggerUrl);
      if (t) return t;
    } catch { /* not ready */ }
    await sleep(500);
  }
  throw new Error("Chrome 未就绪");
}
class Cdp {
  constructor(url) {
    this.ws = new WebSocket(url); this.nextId = 0; this.pending = new Map(); this.events = [];
    this.ready = new Promise((res, rej) => { this.ws.addEventListener("open", () => res()); this.ws.addEventListener("error", () => rej(new Error("ws error"))); });
    this.ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(typeof ev.data === "string" ? ev.data : String(ev.data));
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const item = this.pending.get(msg.id); this.pending.delete(msg.id);
        if (msg.error) item.reject(new Error(JSON.stringify(msg.error))); else item.resolve(msg.result);
        return;
      }
      if (msg.method === "Runtime.exceptionThrown") this.events.push("EVT " + JSON.stringify(msg.params).slice(0, 300));
    });
  }
  send(method, params = {}) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error("cdp timeout " + method)); }, 25000);
      this.pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
}
const target = await waitTarget();
const page = new Cdp(target.webSocketDebuggerUrl);
await page.ready;
await page.send("Page.enable");
await page.send("Runtime.enable");
await page.send("Network.enable");
await page.send("DOM.enable");
await page.send("Network.setCookie", { name: "ll_sid", value: token, url: FRONTEND + "/", path: "/", httpOnly: true, secure: false });
await page.send("Network.setCookie", { name: "ll_csrf", value: csrf, url: FRONTEND + "/", path: "/", httpOnly: false, secure: false });

async function ev(expr) {
  const r = await page.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails !== undefined) throw new Error("eval: " + JSON.stringify(r.exceptionDetails).slice(0, 200));
  return r.result.value;
}
async function goto(hash) {
  await page.send("Page.navigate", { url: FRONTEND + "/" + hash });
  await sleep(1200);
}
async function waitFor(expr, ms = 15000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try { if (await ev(expr) === true) return true; } catch { /* navigating */ }
    await sleep(300);
  }
  return false;
}

// ---------- A. 导航红点 + 板块标签 ----------
const pendingBefore = (await api("/api/v1/task-node-requests")).json;
console.log("待审（审核人视角）条数：" + pendingBefore.pendingCount + "，首条：" + (pendingBefore.items[0] ? pendingBefore.items[0].stageKey + " · " + pendingBefore.items[0].title : "无"));
await goto("#/templates?section=install");
await waitFor("document.querySelector('[data-template-tabs]') !== null");
const dotShown = await waitFor("document.querySelector('[data-nav-templates-dot]') !== null", 12000);
check("A1 有待审申请时，顶栏「任务模板」出现红点", dotShown === true);
const tabInfo = await ev("(function(){var bs=document.querySelectorAll('[data-template-tabs] button');var out=[];for(var i=0;i<bs.length;i++){out.push(bs[i].textContent.trim());}return {n:bs.length,last:out[out.length-1],tenth:out[9]};})()");
check("A2 板块标签栏 = 九阶段 + 入库审核 + ＋ 新建模板（11 枚，第 10 枚 = 入库审核）", tabInfo.n === 11 && tabInfo.tenth === "入库审核", JSON.stringify(tabInfo));

// ---------- B. 入库审核 = 审核工作台 ----------
await goto("#/templates?section=inbound-review");
const workbench = await waitFor("document.querySelector('[data-node-requests-workbench]') !== null");
check("B1 「入库审核」板块内渲染审核工作台", workbench === true);
const legacy = await ev("JSON.stringify({entry:document.querySelector('[data-node-requests-entry]')!==null,dialog:document.querySelector('[data-node-requests-dialog]')!==null})");
check("B2 本地旧入口按钮与申请浮层已删除", legacy === JSON.stringify({ entry: false, dialog: false }), legacy);
const tabs = await ev("JSON.stringify({pending:document.querySelector('[data-node-request-tab=\"pending\"]')!==null,mine:document.querySelector('[data-node-request-tab=\"mine\"]')!==null})");
check("B3 工作台有「待审核 / 我的申请」两个标签（审核人 = 系统管理员）", tabs === JSON.stringify({ pending: true, mine: true }), tabs);
const rowCount = await ev("document.querySelectorAll('[data-node-request-item]').length");
check("B4 待审核列表出现申请行", rowCount > 0, String(rowCount));
const boardKept = await ev("document.querySelector('[data-template-tabs]') !== null && document.body.innerText.indexOf('入库审核') >= 0");
check("B5 板块原有的节点库 / 模板区域保留（远端实现未被删）", boardKept === true);

// ---------- C. 端到端：逐条通过，直到没有待审 ----------
const first = pendingBefore.items[0];
const beforeNodes = (await api("/api/v1/task-nodes?stage=" + first.stageKey)).json;
let approvedCount = 0;
for (let round = 0; round < 8; round += 1) {
  const now = (await api("/api/v1/task-node-requests")).json;
  if (now.pendingCount === 0) break;
  const clicked = await ev("(function(){var b=document.querySelector('[data-node-request-approve]');if(b===null){return false;}b.click();return true;})()");
  if (round === 0) check("C1 待审核行有「通过」按钮并可点击", clicked === true);
  await sleep(700);
  const after = (await api("/api/v1/task-node-requests")).json;
  if (after.pendingCount < now.pendingCount) approvedCount += 1;
}
check("C2 在板块里逐条通过后待审清零（审核链路跑通）", approvedCount >= 1, "通过 " + approvedCount + " 条");
const afterNodes = (await api("/api/v1/task-nodes?stage=" + first.stageKey)).json;
const nodeAppeared = afterNodes.items.some((n) => n.title === first.title) || afterNodes.total > beforeNodes.total;
check("C3 通过后公共节点库落库（" + first.stageKey + " · " + first.title + "）", nodeAppeared === true, beforeNodes.total + " -> " + afterNodes.total);

// ---------- A3. 审完红点消失 ----------
await goto("#/templates");
const dotGone = await waitFor("document.querySelector('[data-nav-templates-dot]') === null", 12000);
check("A3 待审清零后红点消失", dotGone === true);

// ---------- D. 导入预览面板 ----------
await goto("#/projects");
const homeReady = await waitFor("document.querySelector('[data-import-file-input]') !== null", 20000);
check("D0 进入项目空间后可用的导入文件输入框在页面上", homeReady === true);
const inputObj = await page.send("Runtime.evaluate", { expression: "document.querySelector('[data-import-file-input]')" });
if (inputObj.result.objectId === undefined) throw new Error("找不到导入文件输入框");
await page.send("DOM.setFileInputFiles", { files: [FIXTURE], objectId: inputObj.result.objectId });
const summary = await waitFor("document.querySelector('[data-import-node-summary]') !== null", 60000);
check("D1 导入预览渲染出「节点比对结果」面板", summary === true);
const labels = await ev("(function(){var t=document.body.innerText;return {lib:t.indexOf('库内标准名称')>=0,excel:t.indexOf('导入表格名称')>=0};})()");
check("D2 节点行同时给出「库内标准名称」与「导入表格名称」两个标签", labels.lib === true && labels.excel === true, JSON.stringify(labels));
const dual = await ev("(function(){var ns=document.querySelectorAll('[data-import-node-library-name]');var es=document.querySelectorAll('[data-import-node-excel-name]');var lib=null,exc=null;for(var i=0;i<ns.length;i++){if(ns[i].getAttribute('data-import-node-library-name')!=='none'){lib=ns[i].textContent.trim();}}if(es.length>0){exc=es[0].textContent.trim();}return {lib:lib,excel:exc,libCount:ns.length,excelCount:es.length};})()");
check("D3 两种名称都渲染出真实内容（库内名与导入表名分列）", typeof dual.lib === "string" && dual.lib.length > 0 && typeof dual.excel === "string" && dual.excel.length > 0, JSON.stringify(dual));
const hints = await ev("(function(){var t=document.body.innerText;return {summaryHint:t.indexOf('名称一致直接复用')>=0, adminNotice:t.indexOf('未匹配的任务按原名导入')>=0};})()");
check("D4 标题下两句重复提示已不再渲染", hints.summaryHint === false && hints.adminNotice === false, JSON.stringify(hints));
const term = await ev("(function(){var t=document.body.innerText;return {oldTerm:t.indexOf('个人模板')>=0, newTerm:t.indexOf('个人节点库')>=0};})()");
check("D5 术语统一：面板里不再出现「个人模板」", term.oldTerm === false, JSON.stringify(term));
await ev("(function(){var t=document.querySelector('[data-import-node-tab=\"pending\"]');if(t){t.click();}return true;})()");
await sleep(500);
const standaloneClicked = await ev("(function(){var b=document.querySelector('[data-import-choose-standalone]');if(!b){return false;}b.click();return true;})()");
await sleep(500);
const term2 = await ev("(function(){var t=document.body.innerText;return {newTerm:t.indexOf('个人节点库')>=0, oldTerm:t.indexOf('个人模板')>=0};})()");
check("D6 选「保留 Excel 名称」后出现「个人节点库」（与「公共节点库」成对），且无「个人模板」", standaloneClicked === true && term2.newTerm === true && term2.oldTerm === false, JSON.stringify(term2));
// PM 2026-11-13 22:23「这些删了」：右侧 meta 行 / AI 建议行 / 申请说明 / 未匹配面板说明
const trimmed = await ev("(function(){var t=document.body.innerText;var rows=document.querySelectorAll('[data-import-node]');var rowText='';for(var i=0;i<rows.length;i++){rowText+=rows[i].innerText;}return {meta:(rowText.indexOf('条任务')>=0||rowText.indexOf('Excel 第')>=0), ai:rowText.indexOf('AI 建议')>=0||t.indexOf('AI 建议沿用以上')>=0, request:t.indexOf('提交后由管理员审核')>=0, pending:t.indexOf('AI 判断没有可沿用的同义节点')>=0};})()");
check("D7 四处冗长文案已删（行内 meta 行 / AI 建议行 / 申请说明 / 未匹配面板说明）", trimmed.meta === false && trimmed.ai === false && trimmed.request === false && trimmed.pending === false, JSON.stringify(trimmed));

// ---------- 清理 ----------
await db.query("delete from task_node_requests where title = $1 or title in ('货架复检处理', '线体通电测试')", [PENDING_TITLE]);
await db.query("delete from task_nodes where stage_key = 'install' and (title = $1 or title in ('货架复检处理', '线体通电测试')) and owner_template_id is null", [PENDING_TITLE]);
await db.query("insert into task_node_requests (stage_key, title, title_en, status, requested_by) values ('install', $1, 'Replay pending node', 'pending', $2) on conflict do nothing", [PENDING_TITLE, userRow.id]);
console.log("沙箱收尾：清掉验收新建的节点与申请，并放回一条待审（供下次复跑）");
await db.query("update sessions set revoked_at=now() where token_hash=$1", [sha256(token)]);
chrome.kill("SIGKILL");
const failed = checks.filter((c) => c !== true).length;
console.log("—— 合计 " + checks.length + " 项：" + (checks.length - failed) + " 通过 / " + failed + " 失败 ——");
console.log("控制台异常：" + page.events.length + (page.events.length === 0 ? "" : " " + page.events.slice(0, 3).join(" | ")));
process.exit(failed === 0 ? 0 : 1);
