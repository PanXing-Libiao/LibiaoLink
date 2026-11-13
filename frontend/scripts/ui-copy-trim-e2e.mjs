/**
 * LibiaoLink 前端 · 全局文案体检回放（2026-11-13）
 *
 * 前置（与同目录 m3-05 脚本同口径）：前端 dev（3000）+ api（3001）+ 本地沙箱 PG + 本机 Chrome。
 * 环境变量：DATABASE_URL / REPLAY_USER / CHROME_PATH / CDP_PORT / SHOT_DIR
 *
 * 验什么（8 项）：权限管理删了 3 处说明且脚注长解释进了悬停 title；设置页企微引导句已删；
 * 甘特图长口诀已删；项目空间「未选择筛选条件」已删；入库审核「通过前可改中英文名…」已删而工作台仍在；
 * 文件库顶部说明按标签分流；模型管理说明已改短。同时把 8 张页面截图落到 SHOT_DIR（默认 /tmp/after-shots）。
 * 说明：会建一条临时会话（跑完撤销）；沙箱库专用，不要指向正式 / 测试环境。
 */
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
const { default: pg } = await import(process.env.PG_MODULE ?? new URL("../../server/node_modules/pg/lib/index.js", import.meta.url).href);
const { Client } = pg;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OUT = process.env.SHOT_DIR ?? "/tmp/after-shots"; mkdirSync(OUT, { recursive: true });
const DB_URL = process.env.DATABASE_URL ?? "postgres://libiaolink_api@127.0.0.1:5433/libiaolink";
const REPLAY_USER = process.env.REPLAY_USER ?? "px-replay";
const CHROME_PATH = process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const db = new Client({ connectionString: DB_URL });
await db.connect();
const userRow = (await db.query("select id from users where username=$1 and status='active'", [REPLAY_USER])).rows[0];
if (userRow === undefined) { console.error("回放用户不存在：" + REPLAY_USER); process.exit(1); }
await db.query("update sessions set revoked_at=now() where id_token='ui-after'");
const token = "after-" + randomBytes(12).toString("hex");
await db.query("insert into sessions (token_hash,user_id,id_token,expires_at) values ($1,$2,'ui-after', now()+make_interval(mins=>40))", [createHash("sha256").update(token).digest("hex"), userRow.id]);
const PORT = Number(process.env.CDP_PORT ?? 9421);
const profile = mkdtempSync(join(tmpdir(), "after-"));
const chrome = spawn(CHROME_PATH, ["--headless=new","--remote-debugging-port="+PORT,"--user-data-dir="+profile,"--no-first-run","--disable-gpu","--window-size=1440,1000","about:blank"], { stdio: "ignore" });
let wsUrl = null;
for (let i = 0; i < 60 && wsUrl === null; i += 1) {
  try { const l = await (await fetch("http://127.0.0.1:" + PORT + "/json/list")).json(); const t = l.find((x) => x.type === "page" && x.webSocketDebuggerUrl); if (t) wsUrl = t.webSocketDebuggerUrl; } catch {}
  if (wsUrl === null) await sleep(500);
}
const ws = new WebSocket(wsUrl); let id = 0; const pend = new Map();
await new Promise((res) => ws.addEventListener("open", () => res()));
ws.addEventListener("message", (ev) => { const m = JSON.parse(typeof ev.data === "string" ? ev.data : String(ev.data)); if (m.id !== undefined && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
const send = (m, p = {}) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
const get = async (e) => { const r = await send("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true }); if (r && r.result && r.result.exceptionDetails) return undefined; return r && r.result ? r.result.result.value : undefined; };
await send("Page.enable"); await send("Network.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });
await send("Network.setCookie", { name: "ll_sid", value: token, url: "http://localhost:3000/", path: "/", httpOnly: true, secure: false });
await send("Network.setCookie", { name: "ll_csrf", value: "after", url: "http://localhost:3000/", path: "/", httpOnly: false, secure: false });
const P = "dd2be8f8-9978-451f-8aab-06bb4af1b7c7";
const checks = [];
function check(name, ok, detail) { checks.push(ok === true); console.log((ok === true ? "PASS  " : "FAIL  ") + name + (detail === undefined ? "" : "   [" + detail + "]")); }
async function shot(file, selector) {
  await get("window.scrollTo(0,0)");
  if (selector !== undefined) await get("(function(){var e=document.querySelector(" + JSON.stringify(selector) + ");if(e){e.scrollIntoView({block:'start'});return true;}return false;})()");
  await sleep(500);
  const clip = selector === undefined ? { x: 0, y: 0, width: 1440, height: 900, scale: 1.4 } : JSON.parse(await get("(function(){var e=document.querySelector(" + JSON.stringify(selector) + ");if(!e)return JSON.stringify(null);var r=e.getBoundingClientRect();return JSON.stringify({x:Math.max(0,r.x-20),y:Math.max(0,r.y+window.scrollY-20),width:Math.min(r.width+40,1440),height:Math.min(r.height+40,1200),scale:1.5});})()")) ?? { x: 0, y: 0, width: 1440, height: 900, scale: 1.4 };
  const s = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip });
  writeFileSync(join(OUT, file), Buffer.from(s.result.data, "base64"));
  console.log("SHOT " + file);
}
async function page(route, waitMs) { await send("Page.navigate", { url: "http://localhost:3000/" + route }); await sleep(waitMs ?? 3200); }
const has = async (s) => (await get("document.body.innerText.indexOf(" + JSON.stringify(s) + ")>=0")) === true;

await page("#/access");
check("权限管理：3 处说明已删", (await has("部门较多时按层级分组显示")) === false && (await has("拥有全部页面与数据权限")) === false && (await has("部门默认作用于全体直属成员")) === false);
check("权限管理：脚注改短句且长解释进了悬停 title", (await has("同一项目命中多个范围时取最高权限")) === true && (await get("(function(){var es=document.querySelectorAll('[title]');for(var i=0;i<es.length;i++){if(es[i].getAttribute('title').indexOf('不会降级项目经理的自动编辑权')>=0)return true;}return false;})()")) === true);
await shot("1-权限管理.png");
await page("#/settings");
check("设置：企微引导句已删、步骤保留", (await has("帮助你及时收到")) === false && (await has("复制机器人链接")) === true);
await shot("2-设置-企微.png");
await page("#/project/" + P + "?view=gantt");
check("甘特图：长口诀已删、悬停短句仍在", (await has("条上操作（对齐参考样例）")) === false);
await shot("3-甘特图.png", "[data-gantt-toolbar]");
await page("#/projects");
check("项目空间：「未选择筛选条件」已删", (await has("未选择筛选条件")) === false);
await shot("4-常用筛选.png");
await page("#/templates?section=inbound-review");
check("入库审核：审核说明已删、工作台仍在", (await has("通过前可改中英文名")) === false && (await get("document.querySelector('[data-node-requests-workbench]')!==null")) === true);
await shot("5-入库审核.png", "[data-node-requests-workbench]");
await page("#/files");
const r1 = await has("文件回收站：默认保留 30 天，可恢复");
await shot("6-文件库-文件回收站.png");
await page("#/files?tab=project-recycled");
const r2 = await has("项目回收站：默认保留 30 天，到期自动彻底删除");
check("文件库：说明按标签分流（两个标签各一句）", r1 === true && r2 === true && (await has("文件回收站（默认保留 30 天，可恢复）与项目回收站")) === false);
await shot("7-文件库-项目回收站.png");
await page("#/model-settings");
check("模型管理：说明已改短", (await has("保存后自动读取可用模型列表")) === true && (await has("保存后将自动读取可用模型")) === false);
await shot("8-模型管理.png");
await db.query("update sessions set revoked_at=now() where id_token='ui-after'");
chrome.kill("SIGKILL");
const failed = checks.filter((c) => c !== true).length;
console.log("—— 合计 " + checks.length + " 项：" + (checks.length - failed) + " 通过 / " + failed + " 失败 ——");
process.exit(0);
