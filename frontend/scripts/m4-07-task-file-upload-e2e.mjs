#!/usr/bin/env node
/**
 * LibiaoLink 前端 · 回放：任务「文件」列下拉（Push 246：添加 / 预览 / 删除；Push 248：替换 → Push 251 撤销）/ 任务详情抽屉「文件」行上传接真（Push 226 · 「文件」那一刀前端接线）/ 抽屉头部「定档」开关（Push 252：二次确认 → 任务定档）/ 表格外「定档」侧签（Push 252）
 *
 * 前置（都在本机跑着）：
 *   1. 前端 dev：cd frontend && npm run dev（默认 3000）
 *   2. api：cd server && npm run start:api（默认 3001，需先 npm run build）
 *   3. 数据库：本地沙箱 PG（默认 127.0.0.1:5433/libiaolink）
 *   4. 对象存储：deploy/minio 沙箱（默认 127.0.0.1:9000；storage:init 已建桶）
 *   5. 本机装了 Chrome（脚本 headless 起一个调试实例；路径可用 CHROME_PATH 覆盖）
 *
 * 用法：node scripts/m4-07-task-file-upload-e2e.mjs
 *   可覆盖的环境变量：FRONTEND_BASE / API_BASE / DATABASE_URL / CHROME_PATH / CDP_PORT / REPLAY_USER / PG_MODULE / SCREENSHOT_DIR
 *
 * 它做什么：一条临时会话（跑完撤销）+ 一个临时项目（跑完先 purge 文件、再物理删）在真机浏览器里跑一遍：
 *   ① 「文件」列空态 = 与任务表其它行内可编辑单元格同款的「液态玻璃」描边胶囊 + 「—」；点开 = 右侧下拉（顶部一行「＋ 添加文件」/「＋ 添加定档文件」（Push 251 改版：点哪个直接开选文件框、不再出一问；添加文件在前、定档文件在后）、空清单「暂无文件」、隐藏文件框在下拉内）；
 *   ② 下拉内真实文件选择（CDP DOM.setFileInputFiles）→ 分片直传文件库（带 taskId）→ 下拉清单与单元格同步回流（最新一份 + 「+N」）；
 *   ③ 库面：files.task_id 落行 + file_links(task) 建链 + TaskListItem.fileSummary 1（draft 1）；
 *   ④ 抽屉「文件」行：文件名清单随详情接口下发（**不显示「未定档 / 已定档」** —— 定档是项目级安排）+ 上传入口在位；
 *   ⑤ 抽屉内再传（txt / 真 PNG）→ 清单与「文件」列同步（文件名 + 「+N」；同一条直传链路）；
 *   ⑥ 图片行 40×40 缩略图 → 大图预览浮层（短时签名 URL）；Esc 先关浮层、抽屉仍在；
 *   ⑦ 文件名可改：点名字进编辑，只改主名（后缀保留）；Enter 提交 / Esc 取消 / 空名不写回；
 *   ⑧ 抽屉内「删除」= 二次确认 → 移入回收站（清单 / 计数回落，recycled 不进读面）；
 *   ⑨ PDF：点「预览」→ 浏览器内置查看器浮层（iframe 短时签名 URL，PDF 源直通）；Esc 先关浮层；
 *   ⑩ 下载 = 原文件（抽屉每行「下载」+ 预览浮层「下载原文件」；attachment 签名落盘 + download 审计）；
 *   ⑪ 「文件」列下拉交互（Push 246 · 业务口径 2026-10-08「点击后出现右侧下拉框 / 点文件名预览 / 删除按钮」）：
 *      点文件名 = 预览浮层（Esc 先关浮层）；Esc 先关下拉（任务行 / 详情抽屉不被连带）；行尾「删除」= 红胶囊按钮 → 行内二次确认 → 移入回收站（清单 / 单元格回落）；
 *   ⑫ 行尾「替换」（Push 248）已在 Push 251 按业务口径「取消这个替换按钮」整体撤除：下拉清单查不到替换入口 /
 *      替换输入框 / 变更原因区 / 替换提示（④r0 断言）；接口层保留（fileApi.replaceFileContent 未接线，服务端变更通道不动）；
 *   ⑬ 定档入口（Push 249 → Push 251 改版 · 业务口径「这里直接取消按钮 直接在最上方改 改成 添加定档文件 和添加文件 在一行上」）：
 *      顶部「＋ 添加文件」/「＋ 添加定档文件」一行两个按钮（添加文件在前、定档文件在后）= 点哪个直接开选文件框、不出定档一问（无取消按钮）——定档版传完即定档
 *      （任务随定档锁定：任务 / 文件写口全 409 TASK_FINALIZED、下拉顶常驻提示、两个添加入口关闭；
 *      Push 260 补漏 · 业务口径「定档后还能删除是bug 不能删除定档后」——下拉 / 抽屉的删除入口整体下架 + recycle 409，④s2b / ④s6 / ④s7）；
 *   ⑭ 抽屉定档开关（Push 252 · 业务口径「在抽屉中每个任务在任务状态旁边加一个定档按钮状态 有二次提示的」）：
 *      开关在状态签旁（未定档 = 灰底「未」；已定档 = logo 黄底「已」）；点开 = 就地二次确认条（不落库）、取消 = 收条（③d 段）；
 *      确认定档 = POST …/tasks/{taskId}/finalize → tasks.finalized_at 置位（幂等 + 此后写口 409 TASK_FINALIZED，第二个任务端到端 · ④t 段）；
 *      Push 260 改版（业务口径「点击定档按钮应该也要计入操作记录」+「把现在的定档改成 再次点击取消定档吧」）：定档后「已」开关可**再次点击** →
 *      二段确认 → POST …/tasks/{taskId}/unfinalize 清位重开（version+1、审计「任务定档」/「取消定档」各一条；文件级定档不回退）—— ④t9~④t14 段；
 *   ⑮ 「定档」侧签（Push 252 · 业务口径演进：「不是在表格内 要在表格外部懂吗 延伸出一个小标签」→「黄色变淡」→「竖排／横排」→ 定稿「竖着的定档二字的在表格外」）：
 *      定档任务的签不落行内 / 表内 —— 在**表格左边缘外侧**挂一颗竖排小签（2 字 · amber-50 底 + amber-700 字）；#task-board-scroll 会裁越界内容，
 *      所以签画在卡片外这一层、y 按行中心量出；定档前无签、定档后才有（④t0b / ④t8 段）；
 *   ⑯ 抽屉页标签导航（Push 254 · 业务口径「抽屉上方增加 页面标签导航栏 任务详情 变更申请 变更记录三个页面」）：
 *      抽屉头部下出三页标签（默认「任务详情」= 原内容）；「变更申请」= A4-13 十三列字段面 —— 变更时间（只读：提交即记）/
 *      变更阶段（九阶段下拉）/ 变更文件（已定档可选、未定档置灰 + 行尾「定档」就地补门）/ 变更内容描述（必填，落契约 reason）/ 变更前 /
 *      变更后（文本摘要）/ 变更原因（选填，合并记入 reason）/ 变更申请人（只读 = 当前登录人）/ 变更后文件版本（只读：
 *      系统递增）/ 变更后文件（必传）/ 关联（只读：R01 回写任务变更关联）→ 提交即生效（intent=change 分片直传）；
 *      「变更记录」= 任务 changeLinks 逐条回溯（最新在前）+ 详情全文（Push 255 起进页即预取 · ④u 段）；
 *   ⑯b 变更记录 / 关联回写（Push 255 · 业务反馈「文件显示 已变更 不如直接替换成变更后的啊 直接显示变更后添加的文件 不要显示已变更」+
 *      「同时相关的关联也没有显示啊 变更记录也要显示 之前是什么文件 这次是什么文件 按照时间排序上下 文件可以预览在变更里面 变更可以看到详细内容」）：
 *      ① 任务详情文件行不再挂「已变更」签（行内显示的就是变更后的文件本身，④u6）；
 *      ② 变更记录每条直接出「变更前 v(n-1) → 变更后 v(n)」两个版本行（名称 / 版本号 / 大小）+ 各自「预览 / 下载」
 *      （版本态 A4-06：变更前点预览 = 历史版本预览浮层，④u7b / ④u8b / ④u8c）；「详情」仍出全文（阶段 / 原因 / 前后摘要 / 申请人 / 审批状态，④u8）；
 *      ③ 变更回写任务「变更关联」= 「变更文件所属任务」∪ R01 成果类型命中（去重）—— 无成果类型文件（doc_type 空、
 *      前端上传口默认口径）的变更也必回写所属任务（④v4 端到端：任务 change_refs 含该变更）；
 *   ⑯a 变更「变更前 / 变更后」可填图（Push 314 · 业务口径「这个变更要可以填图片」）：两栏文本摘要下挂与日报同款贴图区
 *      （选图 / 粘贴 → 站内文件库直传；各 ≤ 30 张）——选图各传一张真 PNG → 提交随会话落 change_requests
 *      before_summary_file_ids / after_summary_file_ids → 变更记录详情与「变更管理」弹窗按 id 出缩略图（④u3c / ④u4 / ④u6b / ④u8d）；
 *   ⑰ 「变更文件」就地定档（Push 254 续 · 业务反馈「这个选择不了啊」）：未定档文件行不可选但不再死路 ——
 *      行尾「定档」→ 就地二次确认（锁版 + 任务一并锁定）→ POST /files/{id}/finalize → 该行转「已定档」随即可选、
 *      自动选中 + 绿字指引（④v 段：阻断说明 / 二次确认 / 定档转可选 + 写面 files.status=final、tasks.finalized_at 非空）；
 *   ⑱ 任务已定档 → 其文件视为已定档（Push 254 续之二 · 业务反馈「不是已经定档了吗 为什么变更申请里面还是未定档」）：
 *      任务定档是业务可见的定档动作（抽屉开关 / 表格侧签）—— 任务已定档时，其名下 draft 文件在「变更文件」里
 *      显示「已定档」、直接可选可提交（服务端 change 闸同口径放行：final / changed 或所属任务已定档；
 *      ④w 段：可选面 + 全链路提交 + 写面 files.status=changed / 版本 v2 / R01）；
 *   ⑲ 变更 = 替换（Push 256 · 业务反馈「懂不懂变更啊 我要的是替换的效果」+「变更后文件的名字后后缀为什么还要用原来的啊 要用变更选择的 不然都不能预览」）：
 *      变更后文件 = **变更选择的文件本身**（不再要求与目标同名）—— 完成变更时把文件更名为「变更后文件名」
 *      （base 名 + 扩展名全随上传文件）；对象键 / 预览通道 / 下载名按该版本对象键的扩展名（变更后版本 = 新扩展名，
 *      历史版本保持各自旧扩展名）；「变更记录」的「变更前」行显示更名前名称（读面 filePreviousName = 变更审计 name.from）
 *      —— ④u0 夹具（.txt → .pdf 真换扩展名）/ ④u4（写面更名 + 对象键 .pdf）/ ④u7b（前后行各自名称）/ ④u8d（新扩展名可预览）；
 *   ⑳ 变更关联点击 = 居中「变更管理」详情弹窗（Push 256 · 业务口径「变更关联点击后要显示一个这样的内容在中间」）：
 *      任务详情「变更关联」行 / 任务表「变更关联」列点击 → 屏幕中央弹窗（来自 ▦变更管理 + 大日期 + 13 行：变更时间 / 变更阶段 /
 *      变更文件 / 变更内容描述 / 变更前 / 变更后 / 变更原因 / 变更申请人 / 填写者 / 进度 / 变更后文件版本 / 变更后文件 / 关联）；
 *      Esc / 点遮罩只关弹窗（抽屉 / 页面仍在 · ④u6b 段）；
 *   ⑳b 弹窗两个可点击（Push 256 续 · 业务反馈「这两个要可以点击 点击文件预览 点击布局定档抽屉显示」）：
 *      ①「变更后文件」卡 → 弹内版本态预览（浮层 z 高于弹窗；Esc 先关预览、弹窗仍在 —— ④u6c / ④u6d 段）；
 *      Push 350 追订：弹窗「变更前 / 变更后」摘要缩略图点开的大图预览同口径 —— z 压过弹窗 + Esc 先关预览、弹窗仍在（④u6b3 / ④u6b4 段）；
 *      ②「关联」→ 关弹窗打开回写任务抽屉（任务表 chip 路径 = 选中该行开抽屉，④u6g / ④u6h；抽屉内路径 = 露出抽屉本身，④u6f）；
 *      ③「变更文件」行 = 输出成果文件类型（业务口径「变更文件就是输出文件成果这个类型」）：文件 doc_type 空 → 回退任务输出成果文件（④v5）；
 *   ㉑ 收尾：定档任务先取消定档（recycle 闸不绕过）→ 八份文件回收 + purge → 临时项目物理删、会话撤销 → 零残留。
 * 证据：docs/m4-07-回放证据(任务文件上传·前端).md
 */

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";

const PG_MODULE = process.env.PG_MODULE ?? new URL("../../server/node_modules/pg/lib/index.js", import.meta.url).href;
const { default: pg } = await import(PG_MODULE);
const { Client } = pg;

const FRONTEND = process.env.FRONTEND_BASE ?? "http://localhost:3000";
const API = process.env.API_BASE ?? "http://127.0.0.1:3001";
const CHROME = process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PORT = Number(process.env.CDP_PORT ?? 9414);
const DB = process.env.DATABASE_URL ?? "postgres://libiaolink_api@127.0.0.1:5433/libiaolink";
const REPLAY_USER = process.env.REPLAY_USER ?? "px-replay";
const SCREENSHOT_DIR = process.env.SCREENSHOT_DIR ?? tmpdir();
const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const Q = String.fromCharCode(34);
const j = (value) => JSON.stringify(value);
const TASK_TITLE = "回放任务·文件上传";

const db = new Client({ connectionString: DB });
await db.connect();
const userRow = (await db.query("select id, username, display_name from users where username = $1 and status = 'active'", [REPLAY_USER])).rows[0];
if (userRow === undefined) {
  console.error("回放用户不存在：" + REPLAY_USER);
  process.exit(1);
}
const token = "pxm4fu-" + randomBytes(16).toString("hex");
const csrf = randomBytes(16).toString("hex");
await db.query("insert into sessions (token_hash, user_id, id_token, expires_at) values ($1, $2, $3, now() + make_interval(mins => 30))", [sha256(token), userRow.id, "px-m4-file-e2e"]);
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

/** 项目清场前把项目内文件先「回收站 → purge」清掉（与 m6 回放同一绕行：files.current_version_id 外键）。
 *  Push 260 补：定档任务的文件不可回收（recycle 409 TASK_FINALIZED · 业务口径「定档后还能删除是bug」）——
 *  先经 POST …/unfinalize 取消定档（真实接口路径、不绕过闸门），再逐份回收 → purge。 */
async function purgeProjectFiles(projectId) {
  const lockedTasks = (await db.query("select id, version from tasks where project_id = $1 and finalized_at is not null and deleted_at is null", [projectId])).rows;
  for (const task of lockedTasks) {
    await api("/api/v1/projects/" + projectId + "/tasks/" + task.id + "/unfinalize", "POST", { version: Number(task.version) });
  }
  const rows = (await db.query("select id, version, status from files where project_id = $1", [projectId])).rows;
  let purged = 0;
  for (const row of rows) {
    let version = Number(row.version);
    if (row.status !== "recycled") {
      const recycled = await api("/api/v1/files/" + row.id + "/recycle", "POST", { version });
      if (recycled.status !== 200 || recycled.json === null) continue;
      version = Number(recycled.json.version);
    }
    const done = await api("/api/v1/files/" + row.id + "/purge", "POST", { version });
    if (done.status === 200) purged += 1;
  }
  return { total: rows.length, purged };
}

// ---------- 清场：上一轮崩在中途留下的同名临时项目 ----------
const stale = (await db.query("select id from projects where code like $1 and deleted_at is null", ["PX-M4FU-%"])).rows;
for (const row of stale) {
  const staleRow = await api("/api/v1/projects/" + row.id);
  if (staleRow.json === null) continue;
  await purgeProjectFiles(row.id);
  const gone = await api("/api/v1/projects/" + row.id, "DELETE", undefined, { "If-Match": String(staleRow.json.version) });
  console.log("清场：删残留临时项目 " + row.id + " → " + String(gone.status));
}

/** 生成一份结构合法的最小 PDF（单页 + 一行 Helvetica 文本；xref 偏移按实际字节算）。 */
function minimalPdf(text) {
  const stream = "BT /F1 12 Tf 20 100 Td (" + text + ") Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    "<< /Length " + String(Buffer.byteLength(stream, "latin1")) + " >>\nstream\n" + stream + "\nendstream",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [];
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(Buffer.byteLength(pdf, "latin1"));
    pdf += String(index + 1) + " 0 obj\n" + objects[index] + "\nendobj\n";
  }
  const xref = Buffer.byteLength(pdf, "latin1");
  pdf += "xref\n0 " + String(objects.length + 1) + "\n0000000000 65535 f \n";
  for (const offset of offsets) {
    pdf += String(offset).padStart(10, "0") + " 00000 n \n";
  }
  pdf += "trailer\n<< /Size " + String(objects.length + 1) + " /Root 1 0 R >>\nstartxref\n" + String(xref) + "\n%%EOF\n";
  return Buffer.from(pdf, "latin1");
}

// ---------- 夹具：临时项目 + 一条任务 + 四个真文件 ----------
const fixtureCode = "PX-M4FU-" + randomBytes(3).toString("hex").toUpperCase();
const projRes = await api("/api/v1/projects", "POST", { code: fixtureCode, name: "M4回放·任务文件上传", description: "M4回放·任务文件上传", managerIds: [userRow.id] });
check("夹具：建临时项目（201）", projRes.status === 201, String(projRes.status) + " " + projRes.text.slice(0, 140));
const projectId = projRes.json === null ? "" : projRes.json.id;
const taskRes = await api("/api/v1/projects/" + projectId + "/tasks", "POST", { stageKey: "design", title: TASK_TITLE, ownerIds: [userRow.id] });
check("夹具：建一条任务（201）", taskRes.status === 201, String(taskRes.status) + " " + taskRes.text.slice(0, 140));
const taskId = taskRes.json === null ? "" : taskRes.json.id;

const fileDir = mkdtempSync(join(tmpdir(), "pxm4fu-files-"));
const fileAName = "回放-任务文件-A.txt";
const fileBName = "回放-任务文件-B.txt";
const filePngName = "回放-现场图-A.png";
const fileAPath = join(fileDir, fileAName);
const fileBPath = join(fileDir, fileBName);
const filePngPath = join(fileDir, filePngName);
const filePdfName = "回放-文档-A.pdf";
const filePdfPath = join(fileDir, filePdfName);
writeFileSync(fileAPath, "LibiaoLink 回放 A " + fixtureCode + "\n", "utf8");
writeFileSync(fileBPath, "LibiaoLink 回放 B " + fixtureCode + "\n", "utf8");
// 真图片（1×1 红点 PNG）：验「图片行缩略图 → 大图预览」；预览产物由 worker + converter 生成。
writeFileSync(filePngPath, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));
// 第二张真图（1×1 透明点 PNG，内容与 A 不同；Push 314 变更摘要附图用）——两张图各自沉淀一条附件域文件记录。
const filePng2Name = "回放-现场图-B.png";
const filePng2Path = join(fileDir, filePng2Name);
writeFileSync(filePng2Path, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64"));
// 真 PDF（结构合法的最小单页文档）：验「PDF 点预览 → 内置查看器浮层」（PDF 源直通产物）。
writeFileSync(filePdfPath, minimalPdf("LibiaoLink replay pdf " + fixtureCode));

// ---------- 无头 Chrome（CDP） ----------
const profile = mkdtempSync(join(tmpdir(), "pxm4fu-"));
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
await page.send("DOM.enable");
await page.send("Log.enable");
await page.send("Network.setCookie", { name: "ll_sid", value: token, url: FRONTEND + "/", path: "/", httpOnly: true, secure: false });
await page.send("Network.setCookie", { name: "ll_csrf", value: csrf, url: FRONTEND + "/", path: "/", httpOnly: false, secure: false });
await page.send("Emulation.setDeviceMetricsOverride", { width: 1560, height: 1000, deviceScaleFactor: 1, mobile: false });
await page.send("Emulation.setFocusEmulationEnabled", { enabled: true });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ev = async (expression) => {
  const reply = await page.send("Runtime.evaluate", { expression, returnByValue: true });
  if (reply.exceptionDetails !== undefined) throw new Error("页面表达式抛异常：" + JSON.stringify(reply.exceptionDetails).slice(0, 300));
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
async function waitForAsync(fn, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if ((await fn()) === true) return true; } catch (error) { /* 重试 */ }
    await sleep(300);
  }
  return false;
}
/** 按行内文本定位抽屉文件行里的某个按钮，返回中心点（预览入口 / 删除按钮共用）。 */
async function fileRowPoint(fileName, selector) {
  return await ev("(function(){var items=document.querySelectorAll(" + j("[data-drawer-file-item]") + ");"
    + "for(var i=0;i<items.length;i++){if(items[i].textContent.indexOf(" + j(fileName) + ")>=0){"
    + "var b=items[i].querySelector(" + j(selector) + ");if(b===null){return null;}"
    + "var r=b.getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};}}return null;})()");
}

async function clickAt(point) {
  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y, button: "none" });
  await page.send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1 });
  await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1 });
  await sleep(500);
}
/** 改名输入：Ctrl+A 全选 → Input.insertText 覆盖（走真实输入事件，React onChange 生效）。 */
async function typeRenameInput(text) {
  await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 2 });
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 2 });
  await page.send("Input.insertText", { text });
  await sleep(150);
}

/** 发一次按键（改名提交用回车 / 取消用 Esc）。 */
async function pressKey(key, code, keyCode) {
  await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: key, code: code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode });
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: key, code: code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode });
  await sleep(350);
}

/** 真选文件：CDP 直接把磁盘文件塞进隐藏输入框（等价原生文件框选完）。 */
async function setFileInput(selector, filePath) {
  const doc = await page.send("DOM.getDocument", {});
  const found = await page.send("DOM.querySelector", { nodeId: doc.root.nodeId, selector });
  if (found === undefined || found.nodeId === 0) throw new Error("找不到文件输入框：" + selector);
  await page.send("DOM.setFileInputFiles", { nodeId: found.nodeId, files: [filePath] });
}
/** 点一处按钮（按选择器取中心点）；不在 / 量不到返回 false（Push 249 定档确认与拦截提示用）。 */
async function clickSelector(selector) {
  const point = await ev("(function(){var b=document.querySelector(" + j(selector) + ");if(b===null){return null;}var r=b.getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};})()");
  if (point === null || point === undefined) return false;
  await clickAt(point);
  return true;
}
async function bail(message) {
  console.log("中止：" + message);
  checks.push(false);
  try { page.ws.close(); } catch (error) { /* 忽略 */ }
  chrome.kill();
  await db.end();
  process.exit(1);
}

const FILE_CELL_BUTTON = "[data-cell-action=task-files]";
const TASK_FILES_POPOVER = "[data-task-files-popover=true]";
const POPOVER_INPUT = "[data-task-files-input=true]";
const FINALIZE_PROMPT = "[data-task-files-finalize-prompt=true]";
const FINALIZE_NOTE = "[data-task-files-note-finalized=true]";
const FINALIZE_BLOCK_NOTE = "[data-task-files-note-finalize=true]";
const DRAWER = "aside[role=dialog]";
const DRAWER_INPUT = "aside[role=dialog] [data-file-upload-input=true]";
const CELL_TEXT_PROBE = "(function(){var b=document.querySelector(" + j(FILE_CELL_BUTTON) + ");return b===null?null:b.textContent.trim();})()";
async function waitCellHas(parts, timeoutMs) {
  const cond = parts.map((part) => "t.indexOf(" + j(part) + ")<0").join("||");
  return await waitFor("(function(){var b=document.querySelector(" + j(FILE_CELL_BUTTON) + ");if(b===null){return false;}var t=b.textContent.trim();return !(" + cond + ");})()", timeoutMs);
}
const DRAWER_FILES_PROBE = "(function(){var d=document.querySelector(" + j(DRAWER) + ");if(d===null){return {open:false};}"
  + "var items=d.querySelectorAll(" + j("[data-drawer-file-item]") + ");var names=[];for(var i=0;i<items.length;i++){names.push(items[i].innerText.replace(String.fromCharCode(10), " + j(" ") + ").trim());}"
  + "var up=d.querySelector(" + j("[data-drawer-upload]") + ");"
  + "return {open:true,count:items.length,names:names.join(" + j("|") + "),upload:up===null?null:up.textContent.trim(),input:d.querySelector(" + j("[data-file-upload-input]") + ")!==null};})()";
async function waitDrawerFiles(count, timeoutMs) {
  return await waitFor("(function(){var d=document.querySelector(" + j(DRAWER) + ");return d!==null&&d.querySelectorAll(" + j("[data-drawer-file-item]") + ").length===" + String(count) + ";})()", timeoutMs);
}

/** 点「文件」列胶囊 → 打开下拉（Push 246 起上传 / 预览 / 删除都从下拉进；先把单元格滚进可视区）。 */
async function openTaskFilesPopover() {
  await ev("(function(){var b=document.querySelector(" + j(FILE_CELL_BUTTON) + ");if(b!==null){b.scrollIntoView({block:" + j("center") + ",inline:" + j("center") + "});}return true;})()");
  await sleep(400);
  const point = await ev("(function(){var b=document.querySelector(" + j(FILE_CELL_BUTTON) + ");if(b===null){return null;}var r=b.getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};})()");
  if (point === null || point === undefined) await bail("「文件」列胶囊不在（列表没渲染 / 被抽屉挡住）");
  await clickAt(point);
  return await waitFor("document.querySelector(" + j(TASK_FILES_POPOVER) + ")!==null", 6000);
}

// ---------- 打开项目总览 ----------
await page.send("Page.navigate", { url: FRONTEND + "/#/project/" + projectId });
const boardReady = await waitFor("document.querySelector(" + j(FILE_CELL_BUTTON) + ")!==null", 15000);
if (boardReady !== true) await bail("项目总览没渲染出「文件」列上传单元（检查前端 dev / api / 会话）");

// ① 空态胶囊（与行内可编辑单元格同款）+ 点开右侧下拉（Push 246）
const pill = await ev("(function(){var b=document.querySelector(" + j(FILE_CELL_BUTTON) + ");if(b===null){return {exists:false};}"
  + "var s=getComputedStyle(b);var row=b.closest(" + j("[role=button]") + ");var ref=null;var all=document.querySelectorAll(" + j("[data-inline-cell=editor]") + ");"
  + "for(var i=0;i<all.length;i++){if(row!==null&&!row.contains(all[i])){continue;}ref=all[i];break;}"
  + "var f=function(x){return x===null?null:[x.borderRadius,x.backgroundColor,x.borderTopWidth,x.paddingTop,x.paddingLeft,x.fontSize,x.backdropFilter,x.boxShadow].join(" + j("~") + ");};"
  + "return {exists:true,text:b.textContent.trim(),title:b.getAttribute(" + Q + "title" + Q + "),"
  + "mine:f(s),refLabel:ref===null?null:String(ref.getAttribute(" + Q + "aria-label" + Q + ")),ref:f(ref===null?null:getComputedStyle(ref))};})()");
check("①a 「文件」列空态 = 与同一行其它行内可编辑单元格同款的「液态玻璃」胶囊 + 「—」（逐项样式比对）",
  pill.exists === true && pill.text === "—" && pill.ref !== null && pill.ref !== undefined && pill.mine === pill.ref, JSON.stringify(pill));
check("①b 胶囊 title = 点击添加文件（关联到本任务）", typeof pill.title === "string" && pill.title.indexOf("点击添加文件") === 0, String(pill.title));
const popoverOpened = await openTaskFilesPopover();
const popoverInfo = popoverOpened === true ? await ev("(function(){var p=document.querySelector(" + j(TASK_FILES_POPOVER) + ");if(p===null){return null;}var t=document.querySelector(" + j(FILE_CELL_BUTTON) + ");var pr=p.getBoundingClientRect();var tr=t===null?null:t.getBoundingClientRect();var add=p.querySelector(" + j("[data-task-files-add]") + ");var af=p.querySelector(" + j("[data-task-files-add-finalize]") + ");return {add:add===null?null:add.textContent.trim(),af:af===null?null:af.textContent.trim(),sameRow:add!==null&&af!==null&&Math.abs(add.getBoundingClientRect().top-af.getBoundingClientRect().top)<2,firstAdd:add!==null&&af!==null&&add.getBoundingClientRect().left<af.getBoundingClientRect().left,input:p.querySelector(" + j(POPOVER_INPUT) + ")!==null,right:tr===null?false:pr.left>=tr.right-2,text:p.innerText.replace(String.fromCharCode(10)," + j(" / ") + ").slice(0,140)};})()") : null;
check("①c 点胶囊 → 出下拉（顶部一行「＋ 添加文件」/「＋ 添加定档文件」两钮（添加在前）+ 空清单「暂无文件」+ 隐藏文件框在下拉内）", popoverOpened === true && popoverInfo !== null && popoverInfo.add === "＋ 添加文件" && popoverInfo.af === "＋ 添加定档文件" && popoverInfo.sameRow === true && popoverInfo.firstAdd === true && popoverInfo.input === true && popoverInfo.text.indexOf("暂无文件") >= 0, JSON.stringify(popoverInfo));
check("①d 下拉优先贴触发器右侧展开（placement right 口径）", popoverInfo !== null && popoverInfo.right === true, JSON.stringify({ right: popoverInfo === null ? null : popoverInfo.right }));

// ② 列表上传：真选文件 → 分片直传（带 taskId）
// ②a0（Push 251 改版 · 业务口径「这里直接取消按钮 直接在最上方改 改成 添加定档文件 和添加文件 在一行上」）：
//   点「＋ 添加文件」直接开选文件框（不再出定档确认 / 无取消按钮）；定档走顶部「＋ 添加定档文件」直点（④s 段）。
const addDirectPoint = await clickSelector("[data-task-files-add]");
await sleep(400);
const addNoAsk = await ev("document.querySelector(" + j(FINALIZE_PROMPT) + ")===null");
check("②a0 点「＋ 添加文件」= 直接进取文件框（不出定档确认 / 无取消按钮）", addDirectPoint === true && addNoAsk === true, JSON.stringify({ clicked: addDirectPoint, noPrompt: addNoAsk }));
const addFinalizeBtnInfo = await ev("(function(){var b=document.querySelector(" + j("[data-task-files-add-finalize]") + ");return b===null?null:{text:b.textContent.trim(),title:String(b.getAttribute(" + Q + "title" + Q + "))};})()");
check("②a0b 顶部「＋ 添加定档文件」在位且 title = 定档说明（定档后该任务不支持任何修改）", addFinalizeBtnInfo !== null && addFinalizeBtnInfo !== undefined && addFinalizeBtnInfo.text === "＋ 添加定档文件" && addFinalizeBtnInfo.title.indexOf("不支持任何修改") >= 0, JSON.stringify(addFinalizeBtnInfo));
await setFileInput(POPOVER_INPUT, fileAPath);
const firstLanded = await waitForAsync(async () => (await db.query("select count(*)::int as c from files where task_id = $1", [taskId])).rows[0].c === 1, 30000);
const fileRows1 = (await db.query("select f.id, f.name, f.status, v.mime from files f left join file_versions v on v.id = f.current_version_id where f.task_id = $1 order by f.created_at", [taskId])).rows;
check("②a 选文件 → 分片直传落库（files.task_id = 本任务 · draft）", firstLanded === true && fileRows1.length === 1 && fileRows1[0].name === fileAName && fileRows1[0].status === "draft", JSON.stringify(fileRows1));
const links1 = (await db.query("select object_type, object_id from file_links where file_id = $1", [fileRows1[0].id])).rows;
const taskLinks1 = links1.filter((row) => row.object_type === "task" && row.object_id === taskId);
check("②b file_links 建链：任务链 1 条（object_type=task · object_id=本任务）", taskLinks1.length === 1, JSON.stringify(links1));
const cellOne = await waitCellHas([fileAName], 20000);
const cellOneText = String(await ev(CELL_TEXT_PROBE));
check("②c 单元格回流 = 文件名（A · 无「N 份」计数 / 无未定档签 · 口径 2026-09-29 续）", cellOne === true && cellOneText === fileAName, cellOneText);
const popoverListOne = await waitFor("(function(){var p=document.querySelector(" + j(TASK_FILES_POPOVER) + ");return p!==null&&p.querySelectorAll(" + j("[data-task-files-item]") + ").length===1;})()", 15000);
const popoverNamesOne = String(await ev("(function(){var p=document.querySelector(" + j(TASK_FILES_POPOVER) + ");return p===null?" + j("") + ":p.innerText.replace(String.fromCharCode(10)," + j(" / ") + ");})()"));
check("②c2 下拉清单随上传回流 = 1 行 A（上传不关下拉、完成后自动重取）", popoverListOne === true && popoverNamesOne.indexOf(fileAName) >= 0, popoverNamesOne.slice(0, 140));
const list1 = await api("/api/v1/projects/" + projectId + "/tasks");
const item1 = list1.json === null ? undefined : list1.json.items.find((row) => row.id === taskId);
check("②d 列表随行 fileSummary = total 1 / draft 1 / final 0", item1 !== undefined && item1.fileSummary.total === 1 && item1.fileSummary.draft === 1 && item1.fileSummary.final === 0, JSON.stringify(item1 === undefined ? null : item1.fileSummary));

const drawerAfterUpload = await ev("document.querySelector(" + j(DRAWER) + ")===null");
check("②e 上传完成后详情抽屉仍未被连带打开（点击气泡修正）", drawerAfterUpload === true, String(drawerAfterUpload));
// 探针：临时把 type 切成 text，避免无 user activation 的合成 click 去开原生选择框（只验冒泡链路）。
const bubbleProbe = "(function(){var i=document.querySelector(" + j(POPOVER_INPUT) + ");if(i===null){return " + j("no-input") + ";}"
  + "var saved=i.type;i.type=" + j("text") + ";"
  + "i.dispatchEvent(new MouseEvent(" + j("click") + ",{bubbles:true}));"
  + "i.type=saved;"
  + "return document.querySelector(" + j(DRAWER) + ")===null?" + j("ok") + ":" + j("drawer-opened") + ";})()";
const bubbleResult = await ev(bubbleProbe);
check("②f 从 input 冒泡上来的 click 被拦住（回归 Push 226 修正）", bubbleResult === "ok", String(bubbleResult));

// ②g-②i 下拉交互（Push 246）：点文件名 = 预览浮层；Esc 先关浮层、再关下拉（任务行 / 抽屉不被连带）
const namePoint = await ev("(function(){var p=document.querySelector(" + j(TASK_FILES_POPOVER) + ");if(p===null){return null;}var b=p.querySelector(" + j("[data-task-files-preview]") + ");if(b===null){return null;}var r=b.getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};})()");
if (namePoint === null || namePoint === undefined) await bail("下拉里没有文件名按钮（data-task-files-preview）");
await clickAt(namePoint);
const popPreviewShown = await waitFor("document.querySelector(" + j("[data-file-preview]") + ")!==null", 25000);
const popPreviewInfo = popPreviewShown === true ? await ev("(function(){var el=document.querySelector(" + j("[data-file-preview]") + ");return {open:el!==null,kind:el===null?null:el.getAttribute(" + Q + "data-file-preview-kind" + Q + "),popoverClosed:document.querySelector(" + j(TASK_FILES_POPOVER) + ")===null};})()") : { open: false, kind: null, popoverClosed: false };
check("②g 点下拉文件名 = 预览浮层（kind=" + String(popPreviewInfo.kind) + " · 开预览即收下拉）", popPreviewInfo.open === true && popPreviewInfo.kind === "office" && popPreviewInfo.popoverClosed === true, JSON.stringify(popPreviewInfo));
const popPreviewClosed = await waitForAsync(async () => {
  await ev("(function(){if(document.activeElement&&document.activeElement.blur){document.activeElement.blur();}return true;})()");
  await pressKey("Escape", "Escape", 27);
  return (await ev("document.querySelector(" + j("[data-file-preview]") + ")===null&&document.querySelector(" + j(DRAWER) + ")===null")) === true;
}, 20000);
check("②h Esc 关预览浮层（下拉保持收起、详情抽屉不出现 —— 「Esc 先关内层」）", popPreviewClosed === true, String(popPreviewClosed));
const popoverReopenForEsc = await openTaskFilesPopover();
await pressKey("Escape", "Escape", 27);
const escPopover = await waitFor("(function(){return document.querySelector(" + j(TASK_FILES_POPOVER) + ")===null&&document.querySelector(" + j(DRAWER) + ")===null;})()", 6000);
check("②i Esc 先关下拉（任务行 / 详情抽屉不被连带打开）", popoverReopenForEsc === true && escPopover === true, JSON.stringify({ reopened: popoverReopenForEsc, closed: escPopover }));

// ③ 抽屉「文件」行：清单 + 上传入口（先把任务行滚回视口 —— ① 的居中滚动可能把行首推出屏）
await ev("(function(){var rows=document.querySelectorAll(" + j("[role=button]") + ");for(var i=0;i<rows.length;i++){if(rows[i].textContent.indexOf(" + j(TASK_TITLE) + ")>=0){rows[i].scrollIntoView({block:" + j("center") + ",inline:" + j("start") + "});return true;}}return false;})()");
await sleep(400);
const rowPoint = await ev("(function(){var rows=document.querySelectorAll(" + j("[role=button]") + ");for(var i=0;i<rows.length;i++){if(rows[i].textContent.indexOf(" + j(TASK_TITLE) + ")>=0){var b=rows[i].getBoundingClientRect();return {x:Math.round(b.left+60),y:Math.round(b.top+b.height/2)};}}return null;})()");
if (rowPoint === null || rowPoint === undefined) await bail("点不到任务行（行没渲染）");
await clickAt(rowPoint);
const drawerOpen = await waitFor("document.querySelector(" + j(DRAWER) + ")!==null", 8000);
check("③a 点任务行打开详情抽屉", drawerOpen === true, JSON.stringify({ drawerOpen: drawerOpen }));
const drawer1 = await waitDrawerFiles(1, 12000) === true ? await ev(DRAWER_FILES_PROBE) : { open: false, count: 0, names: "", upload: null, input: false };
check("③b 抽屉「文件」清单 = 详情接口下发的 1 行（只出文件名，无「未定档」签）", drawer1.count === 1 && drawer1.names.indexOf(fileAName) >= 0 && drawer1.names.indexOf("未定档") < 0 && drawer1.names.indexOf("已定档") < 0, JSON.stringify(drawer1));
check("③c 抽屉上传入口在位（＋ 上传文件 + 隐藏输入框）", drawer1.upload === "＋ 上传文件" && drawer1.input === true, JSON.stringify({ upload: drawer1.upload, input: drawer1.input }));

// ③d 抽屉头部「定档」开关（Push 252 · 业务口径「在抽屉中每个任务在任务状态旁边加一个定档按钮状态 有二次提示的」）：
//   开关在状态签旁（未定档 = data-task-finalize=off · 旋钮「未」）；点开 = 就地二次确认条（不落库）、取消 = 收条；
//   确认路径（POST /finalize / 幂等 / 定档后 409）在第二个任务上端到端 —— 见 ④t 段（本任务要保持可写直到 ④s）。
const finalizeProbe = await ev("(function(){var d=document.querySelector(" + j(DRAWER) + ");if(d===null){return null;}"
  + "var sw=d.querySelector(" + j("[data-task-finalize]") + ");var chip=d.querySelector(" + j("[data-task-status-chip]") + ");"
  + "if(sw===null||chip===null){return {sw:false,chip:false};}"
  + "var rs=sw.getBoundingClientRect();var rc=chip.getBoundingClientRect();"
  + "return {sw:true,state:sw.getAttribute(" + Q + "data-task-finalize" + Q + "),knob:sw.textContent.trim(),"
  + "sameRow:Math.abs(Math.round(rs.top+rs.height/2)-Math.round(rc.top+rc.height/2))<=6,rightOf:rs.left>=rc.right-2};})()");
check("③d 定档开关在任务状态签旁（未定档 = off · 旋钮「未」 · 同一行、状态签右侧）",
  finalizeProbe !== null && finalizeProbe !== undefined && finalizeProbe.sw === true && finalizeProbe.state === "off" && finalizeProbe.knob === "未" && finalizeProbe.sameRow === true && finalizeProbe.rightOf === true,
  JSON.stringify(finalizeProbe));
const finalizeClicked = await clickSelector("[data-task-finalize]");
const finalizeConfirmShown = await waitFor("document.querySelector(" + j("[data-task-finalize-confirm]") + ")!==null", 6000);
const finalizeDbBefore = (await db.query("select finalized_at from tasks where id = $1", [taskId])).rows[0];
check("③d2 点开关 = 就地二次确认条（data-task-finalize-confirm · 确认前不落库）",
  finalizeClicked === true && finalizeConfirmShown === true && finalizeDbBefore.finalized_at === null,
  JSON.stringify({ clicked: finalizeClicked, confirm: finalizeConfirmShown, finalizedAt: finalizeDbBefore.finalized_at }));
const finalizeCancelClicked = await clickSelector("[data-task-finalize-cancel]");
const finalizeConfirmGone = await waitFor("document.querySelector(" + j("[data-task-finalize-confirm]") + ")===null", 6000);
const finalizeDbAfterCancel = (await db.query("select finalized_at from tasks where id = $1", [taskId])).rows[0];
check("③d3 取消 = 收确认条、不落库（开关仍 off）",
  finalizeCancelClicked === true && finalizeConfirmGone === true && finalizeDbAfterCancel.finalized_at === null,
  JSON.stringify({ cancel: finalizeCancelClicked, gone: finalizeConfirmGone, finalizedAt: finalizeDbAfterCancel.finalized_at }));
// ④ 抽屉内再传一份
await setFileInput(DRAWER_INPUT, fileBPath);
const secondLanded = await waitForAsync(async () => (await db.query("select count(*)::int as c from files where task_id = $1", [taskId])).rows[0].c === 2, 30000);
const fileRows2 = (await db.query("select name, status from files where task_id = $1 order by created_at", [taskId])).rows;
check("④a 抽屉内选文件 → 第二份落库（两条 draft）", secondLanded === true && fileRows2.length === 2 && fileRows2[0].name === fileAName && fileRows2[1].name === fileBName, JSON.stringify(fileRows2));
const drawer2 = await waitDrawerFiles(2, 12000) === true ? await ev(DRAWER_FILES_PROBE) : { count: 0, names: "" };
check("④b 抽屉清单自动重取 = 两行（A / B 都在）", drawer2.count === 2 && drawer2.names.indexOf(fileAName) >= 0 && drawer2.names.indexOf(fileBName) >= 0, JSON.stringify({ count: drawer2.count, names: drawer2.names }));
const drawerIconKinds = await ev("(function(){var d=document.querySelector(" + j(DRAWER) + ");if(d===null){return null;}var icons=d.querySelectorAll(" + j("[data-file-icon]") + ");var out=[];for(var i=0;i<icons.length;i++){out.push(icons[i].getAttribute(" + j("data-file-icon") + "));}return out;})()");
check("④b2 抽屉清单非图片行行首文件类型图标（A / B 两份 txt = text · FA 同族）", Array.isArray(drawerIconKinds) === true && drawerIconKinds.length === 2 && drawerIconKinds[0] === "text" && drawerIconKinds[1] === "text", JSON.stringify(drawerIconKinds));
const cellTwo = await waitCellHas([fileBName, "+1"], 20000);
const cellTwoText = String(await ev(CELL_TEXT_PROBE));
check("④c 任务表「文件」列 = 最新文件名 + 「+1」（两份 · 无未定档签）", cellTwo === true && cellTwoText === fileBName + "+1", cellTwoText);
const list2 = await api("/api/v1/projects/" + projectId + "/tasks");
const item2 = list2.json === null ? undefined : list2.json.items.find((row) => row.id === taskId);
check("④d 列表随行 fileSummary = total 2 / draft 2", item2 !== undefined && item2.fileSummary.total === 2 && item2.fileSummary.draft === 2, JSON.stringify(item2 === undefined ? null : item2.fileSummary));

// ⑤（续）抽屉去定档签 + 图片预览 + 删除（回收站）
const drawerText = String(await ev("(function(){var d=document.querySelector(" + j(DRAWER) + ");return d===null?" + j("") + ":d.innerText;})()"));
check("④e 抽屉里不再出现「未定档 / 已定档」（定档是项目级安排，不在文件上区分）", drawerText.indexOf("未定档") < 0 && drawerText.indexOf("已定档") < 0, drawerText.replace(/\n/g, " / ").slice(0, 100));

await setFileInput(DRAWER_INPUT, filePngPath);
const thirdLanded = await waitForAsync(async () => (await db.query("select count(*)::int as c from files where task_id = $1", [taskId])).rows[0].c === 3, 30000);
const pngRow = (await db.query("select id, name, status from files where task_id = $1 and name = $2", [taskId, filePngName])).rows[0];
check("④f 抽屉内再传一张真 PNG → 第三份落库", thirdLanded === true && pngRow !== undefined && pngRow.name === filePngName, JSON.stringify(pngRow === undefined ? null : pngRow));
const drawer3 = await waitDrawerFiles(3, 15000);
check("④g 抽屉清单 = 三行（A txt / B txt / PNG）", drawer3 === true, String(drawer3));

const thumbReady = await waitFor("(function(){var items=document.querySelectorAll(" + j("[data-drawer-file-item]") + ");"
  + "for(var i=0;i<items.length;i++){if(items[i].textContent.indexOf(" + j(filePngName) + ")>=0){"
  + "var t=items[i].querySelector(" + j("[data-file-thumb=true]") + ");if(t===null){return false;}"
  + "var img=t.querySelector(" + j("img") + ");var src=img===null?null:img.getAttribute(" + j("src") + ");"
  + "return src!==null&&src.indexOf(" + j("http") + ")==0;}}return false;})()", 30000);
check("④g2 图片行内直接出小缩略图（40×40 · img src = 短时签名 http · 同日报附图口径）", thumbReady === true, String(thumbReady));
const txtNoThumb = String(await ev("(function(){var items=document.querySelectorAll(" + j("[data-drawer-file-item]") + ");for(var i=0;i<items.length;i++){if(items[i].textContent.indexOf(" + j(fileAName) + ")>=0){return items[i].querySelector(" + j("[data-file-thumb=true]") + ")===null;}}return false;})()"));
check("④g3 非图片（txt）行不出缩略图", txtNoThumb === "true", txtNoThumb);

const previewPoint = await fileRowPoint(filePngName, "[data-file-thumb=true]");
if (previewPoint === null || previewPoint === undefined) await bail("PNG 行没有预览入口（图片判定 / 渲染没接上）");
await clickAt(previewPoint);
const previewShown = await waitFor("document.querySelector(" + j("[data-file-preview]") + ")!==null", 30000);
const previewInfo = previewShown === true ? await ev("(function(){var el=document.querySelector(" + j("[data-file-preview]") + ");var img=el===null?null:el.querySelector(" + j("img") + ");var src=img===null?null:img.getAttribute(" + j("src") + ");return {open:el!==null,http:src!==null&&src.indexOf(" + j("http") + ")==0,drawer:document.querySelector(" + j(DRAWER) + ")!==null};})()") : { open: false, http: false, drawer: false };
check("④h 点小缩略图 → 大图预览浮层（img src = 短时签名 http 地址）", previewInfo.open === true && previewInfo.http === true && previewInfo.drawer === true, JSON.stringify(previewInfo));

await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
const escInner = await waitFor("(function(){return document.querySelector(" + j("[data-file-preview]") + ")===null&&document.querySelector(" + j(DRAWER) + ")!==null;})()", 8000);
check("④i Esc 先关预览浮层、抽屉仍在（「Esc 先关内层」）", escInner === true, String(escInner));

// ⑤（续二）文件名可修改（业务口径 2026-09-29「名称要可以修改」）：点名字进编辑、只改主名（后缀保留）、回车提交
const pngDbRow = (await db.query("select id, name from files where task_id = $1 and name = $2", [taskId, filePngName])).rows[0];
const renamePoint = await fileRowPoint(filePngName, "[data-file-rename=true]");
if (renamePoint === null || renamePoint === undefined) await bail("PNG 行没有改名入口（data-file-rename）");
await clickAt(renamePoint);
const renameBox = await ev("(function(){var i=document.querySelector(" + j("[data-file-rename-input=true]") + ");return i===null?null:{value:i.value,focused:document.activeElement===i};})()");
check("④n1 点文件名进编辑：输入框只含主名（后缀 .png 原位保留、不参与编辑）", renameBox !== null && renameBox !== undefined && renameBox.value === "回放-现场图-A" && renameBox.focused === true, JSON.stringify(renameBox));
const filePngRenamed = "回放-现场图-A-改名.png";
await typeRenameInput("回放-现场图-A-改名");
await pressKey("Enter", "Enter", 13);
const renamedOk = await waitForAsync(async () => (await db.query("select name from files where id = $1", [pngDbRow.id])).rows[0].name === filePngRenamed, 20000);
check("④n2 回车提交落库：新主名 + 原后缀 = 「" + filePngRenamed + "」", renamedOk === true, String(renamedOk));
const drawerRenamed = await waitDrawerFiles(3, 15000);
const drawerRenamedNames = String(await ev("(function(){return Array.prototype.map.call(document.querySelectorAll(" + j("[data-drawer-file-item]") + "),function(el){return el.innerText;}).join(" + j("|") + ");})()"));
const cellRenamed = await waitCellHas([filePngRenamed, "+2"], 20000);
const cellRenamedText = String(await ev(CELL_TEXT_PROBE));
check("④n3 改名回流：抽屉清单与「文件」列都出新名（列 = 新名 + 「+2」）", drawerRenamed === true && drawerRenamedNames.indexOf(filePngRenamed) >= 0 && cellRenamed === true && cellRenamedText === filePngRenamed + "+2", JSON.stringify({ drawer: drawerRenamedNames.slice(0, 130), cell: cellRenamedText }));
// Esc 取消：不写库、不关抽屉（与预览浮层同一条「Esc 先关内层」口径）
const renamePoint2 = await fileRowPoint(filePngRenamed, "[data-file-rename=true]");
if (renamePoint2 === null || renamePoint2 === undefined) await bail("改名后 PNG 行没有改名入口");
await clickAt(renamePoint2);
await typeRenameInput("不该落库");
await pressKey("Escape", "Escape", 27);
const escNameOk = (await db.query("select name from files where id = $1", [pngDbRow.id])).rows[0].name === filePngRenamed;
const escDrawerOk = await waitFor("(function(){return document.querySelector(" + j(DRAWER) + ")!==null&&document.querySelector(" + j("[data-file-rename-input=true]") + ")==null;})()", 8000);
check("④n4 Esc 取消：不写库、输入框收起、抽屉仍在（「Esc 先关内层」）", escNameOk === true && escDrawerOk === true, JSON.stringify({ name: escNameOk, drawer: escDrawerOk }));
// 空主名不写回：清空后回车 = 保持原名
const renamePoint3 = await fileRowPoint(filePngRenamed, "[data-file-rename=true]");
if (renamePoint3 === null || renamePoint3 === undefined) await bail("空名校验前 PNG 行改名入口不在");
await clickAt(renamePoint3);
await typeRenameInput("");
await pressKey("Enter", "Enter", 13);
await sleep(400);
const emptyKeep = (await db.query("select name from files where id = $1", [pngDbRow.id])).rows[0].name === filePngRenamed;
check("④n5 空主名回车：不写回（保持原名）", emptyKeep === true, String(emptyKeep));

const fileBId = (await db.query("select id from files where task_id = $1 and name = $2", [taskId, fileBName])).rows[0].id;
const deletePoint = await fileRowPoint(fileBName, "[data-file-delete=true] button");
if (deletePoint === null || deletePoint === undefined) await bail("B 行没有删除入口");
await clickAt(deletePoint);
const confirmShown = await waitFor("document.querySelector(" + j("[data-file-delete-confirm]") + ")!==null", 6000);
if (confirmShown !== true) {
  console.log("诊断·抽屉文本：" + String(await ev("(function(){var d=document.querySelector(" + j(DRAWER) + ");return d===null?" + j("(抽屉不在)") + ":d.innerText.replace(/\\n/g," + j(" | ") + ");})()")).slice(0, 400));
  console.log("诊断·B 行 HTML：" + String(await ev("(function(){var items=document.querySelectorAll(" + j("[data-drawer-file-item]") + ");for(var i=0;i<items.length;i++){if(items[i].textContent.indexOf(" + j(fileBName) + ")>=0){return items[i].outerHTML;}}return " + j("(没找到 B 行)") + ";})()")).slice(0, 700));
}
const statusBeforeConfirm = (await db.query("select status from files where id = $1", [fileBId])).rows[0].status;
check("④j 「删除」第一下 = 二次确认条（此时未落库）", confirmShown === true && statusBeforeConfirm === "draft", "confirm=" + String(confirmShown) + " status=" + statusBeforeConfirm);
const confirmPoint = await ev("(function(){var strip=document.querySelector(" + j("[data-file-delete-confirm]") + ");if(strip===null){return null;}var b=strip.querySelector(" + j("button") + ");if(b===null){return null;}var r=b.getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};})()");
if (confirmPoint === null || confirmPoint === undefined) await bail("找不到确认删除按钮");
await clickAt(confirmPoint);
const recycledOk = await waitForAsync(async () => (await db.query("select status from files where id = $1", [fileBId])).rows[0].status === "recycled", 20000);
check("④k 二次确认后落库 = 回收站（status recycled · 30 天内可恢复）", recycledOk === true, String(recycledOk));
const drawerBack2 = await waitDrawerFiles(2, 15000);
check("④l 清单回到 2 行（回收站不进任务详情清单）", drawerBack2 === true, String(drawerBack2));
const cellBack2 = await waitCellHas([filePngRenamed, "+1"], 20000);
const cellBack2Text = String(await ev(CELL_TEXT_PROBE));
check("④m 表格「文件」列 = 改名后的 PNG + 「+1」（recycled 不进列 / 无「N 份」）", cellBack2 === true && cellBack2Text === filePngRenamed + "+1", cellBack2Text);

// ⑤（续三）PDF 点击预览（业务口径 2026-09-29「这个pdf我也打不开啊」）：PDF 源直通 → 内置查看器 iframe
await setFileInput(DRAWER_INPUT, filePdfPath);
const fourthLanded = await waitForAsync(async () => (await db.query("select count(*)::int as c from files where task_id = $1", [taskId])).rows[0].c === 4, 30000);
const pdfRow = (await db.query("select id, name, status from files where task_id = $1 and name = $2", [taskId, filePdfName])).rows[0];
check("④o1 抽屉内再传一份真 PDF → 第四份落库（draft）", fourthLanded === true && pdfRow !== undefined && pdfRow.name === filePdfName && pdfRow.status === "draft", JSON.stringify(pdfRow === undefined ? null : pdfRow));
const drawer4 = await waitDrawerFiles(3, 15000);
const cellPdf = await waitCellHas([filePdfName, "+2"], 20000);
const cellPdfText = String(await ev(CELL_TEXT_PROBE));
check("④o2 清单三行 + 「文件」列 = 最新 PDF 名 + 「+2」", drawer4 === true && cellPdf === true && cellPdfText === filePdfName + "+2", JSON.stringify({ drawer: drawer4, cell: cellPdfText }));
const pdfPoint = await fileRowPoint(filePdfName, "[data-file-preview-open=true]");
if (pdfPoint === null || pdfPoint === undefined) await bail("PDF 行没有预览入口（data-file-preview-open）");
await clickAt(pdfPoint);
const pdfPreviewShown = await waitFor("(function(){return document.querySelector(" + j("[data-file-preview-kind=pdf]") + ")!==null&&document.querySelector(" + j("[data-oo-status=ready]") + ")!==null;})()", 60000);
const pdfPreviewInfo = pdfPreviewShown === true ? await ev("(function(){var el=document.querySelector(" + j("[data-file-preview]") + ");if(el===null){return {open:false};}var v=el.querySelector(" + j("[data-onlyoffice-viewer=true]") + ");var dl=el.querySelector(" + j("[data-file-preview-download=true]") + ");return {open:true,viewer:v!==null,status:v===null?null:v.getAttribute(" + j("data-oo-status") + "),frames:v===null?0:v.querySelectorAll(" + j("iframe") + ").length,download:dl!==null,drawer:document.querySelector(" + j(DRAWER) + ")!==null};})()") : { open: false, viewer: false, status: null, frames: 0, download: false, drawer: false };
check("④o3 点「预览」→ PDF 走 ONLYOFFICE 查看器（data-oo-status=ready + 编辑器 iframe 在位；caption 带「下载原文件」入口）", pdfPreviewInfo.open === true && pdfPreviewInfo.viewer === true && pdfPreviewInfo.status === "ready" && pdfPreviewInfo.frames >= 1 && pdfPreviewInfo.download === true && pdfPreviewInfo.drawer === true, JSON.stringify(pdfPreviewInfo));
const pdfShot = await page.send("Page.captureScreenshot", { format: "png" });
writeFileSync(join(SCREENSHOT_DIR, "m4-07-pdf-preview.png"), Buffer.from(pdfShot.data, "base64"));
console.log("截图：" + join(SCREENSHOT_DIR, "m4-07-pdf-preview.png"));
const escPdf = await waitForAsync(async () => {
  // 编辑器 iframe 会抢焦点：先 blur 回上层文档再发 Esc（与 ④q2 同一对抗手法）
  await ev("(function(){if(document.activeElement&&document.activeElement.blur){document.activeElement.blur();}return true;})()");
  await pressKey("Escape", "Escape", 27);
  return (await ev("(function(){return document.querySelector(" + j("[data-file-preview]") + ")===null&&document.querySelector(" + j(DRAWER) + ")!==null;})()")) === true;
}, 20000);
check("④o4 Esc 先关 PDF 查看器浮层、抽屉仍在（「Esc 先关内层」）", escPdf === true, String(escPdf));

// ⑤（续四）下载 = 原文件（业务口径 2026-09-30「下载为什么都是pdf 你是不是签名调用错了」）
const downloadDir = mkdtempSync(join(tmpdir(), "pxm4fu-dl-"));
try {
  await page.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: downloadDir });
} catch (error) {
  await page.send("Page.setDownloadBehavior", { behavior: "allow", downloadPath: downloadDir });
}
const rowsWithDownload = String(await ev("(function(){var items=document.querySelectorAll(" + j("[data-drawer-file-item]") + ");if(items.length===0){return " + j("no-rows") + ";}for(var i=0;i<items.length;i++){if(items[i].querySelector(" + j("[data-file-download=true]") + ")===null){return " + j("missing") + ";}}return " + j("ok") + ";})()"));
check("④p1 抽屉每行都有「下载」入口（原文件下载）", rowsWithDownload === "ok", rowsWithDownload);
async function waitDownloaded(name) {
  for (let i = 0; i < 40; i += 1) {
    const path = join(downloadDir, name);
    if (existsSync(path)) return path;
    await sleep(300);
  }
  return null;
}
const pdfDownloadPoint = await fileRowPoint(filePdfName, "[data-file-download=true]");
if (pdfDownloadPoint === null || pdfDownloadPoint === undefined) await bail("PDF 行没有下载入口");
await clickAt(pdfDownloadPoint);
const pdfDownloaded = await waitDownloaded(filePdfName);
const pdfBytesOk = pdfDownloaded !== null && readFileSync(pdfDownloaded).equals(readFileSync(filePdfPath));
check("④p2 点「下载」→ 落盘原 PDF（字节与上传件全等；不是预览转换件）", pdfDownloaded !== null && pdfBytesOk, String(pdfDownloaded));
const pdfDownloadAudit = (await db.query("select count(*)::int as c from audit_logs where object_id = $1 and action = $2", [pdfRow.id, "download"])).rows[0].c;
check("④p3 下载写 download 审计（A4-10：一次下载一条）", Number(pdfDownloadAudit) >= 1, "audit=" + String(pdfDownloadAudit));
const pngDownloadPoint = await fileRowPoint(filePngRenamed, "[data-file-download=true]");
if (pngDownloadPoint === null || pngDownloadPoint === undefined) await bail("PNG 行没有下载入口");
await clickAt(pngDownloadPoint);
const pngDownloaded = await waitDownloaded(filePngRenamed);
const pngBytesOk = pngDownloaded !== null && readFileSync(pngDownloaded).equals(readFileSync(filePngPath));
check("④p4 图片行「下载」= 改名后的原名落盘 + 原 PNG 字节（非预览转换件）", pngDownloaded !== null && pngBytesOk, String(pngDownloaded));

// 失败时留一张现场截图（排障用；正常跑不写）。
if (checks.filter((ok) => ok !== true).length > 0) {
  const shotFail = await page.send("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(SCREENSHOT_DIR, "m4-07-fail.png"), Buffer.from(shotFail.data, "base64"));
  console.log("失败现场截图：" + join(SCREENSHOT_DIR, "m4-07-fail.png"));
}

// ---------- 截图（本地目视证据） ----------
const shotDrawer = await page.send("Page.captureScreenshot", { format: "png" });
writeFileSync(join(SCREENSHOT_DIR, "m4-07-drawer.png"), Buffer.from(shotDrawer.data, "base64"));
await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
await waitFor("document.querySelector(" + j(DRAWER) + ")===null", 8000);

// ④p5（Push 249 修正 · 业务口径「当我修改别的信息 文件一栏的内容就消失了 要刷新才能回来」）：
//   行内改别的字段（PATCH / 进度写入只回契约 Task、不带 fileSummary）后「文件」列必须就地保持 ——
//   toUiTask 从旧行继承文件摘要（原来漏接 previous.files → 摘要归零、「文件」列退回「—」，刷新才回来）。
await ev("(function(){var rows=document.querySelectorAll(" + j("[role=button]") + ");for(var i=0;i<rows.length;i++){if(rows[i].textContent.indexOf(" + j(TASK_TITLE) + ")>=0){rows[i].scrollIntoView({block:" + j("center") + ",inline:" + j("start") + "});return true;}}return false;})()");
await sleep(400);
const cellBeforeNoteEdit = String(await ev(CELL_TEXT_PROBE));
const noteCellPoint = await ev("(function(){var rows=document.querySelectorAll(" + j("[role=button]") + ");for(var i=0;i<rows.length;i++){if(rows[i].textContent.indexOf(" + j(TASK_TITLE) + ")>=0){var b=rows[i].querySelector(" + j("button[aria-label=修改项目进展描述]") + ");if(b===null){return null;}var r=b.getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};}}return null;})()");
if (noteCellPoint === null || noteCellPoint === undefined) await bail("任务行里找不到「项目进展描述」行内编辑格（改别的字段用）");
await clickAt(noteCellPoint);
const noteEditorShown = await waitFor("document.querySelector(" + j("textarea[aria-label=修改项目进展描述]") + ")!==null", 6000);
await typeRenameInput("回放改别的字段 " + fixtureCode);
const noteSaved = await waitForAsync(async () => {
  await clickSelector("[data-inline-save=true]");
  const rows = (await db.query("select note from tasks where id = $1", [taskId])).rows;
  return rows.length === 1 && rows[0].note === "回放改别的字段 " + fixtureCode;
}, 20000);
const cellAfterNoteEdit = String(await ev(CELL_TEXT_PROBE));
check("④p5 行内改别的字段（项目进展描述）落库后「文件」列就地保持（PATCH 只回契约 Task：文件摘要从旧行继承 · 不消失、不用刷新）",
  noteEditorShown === true && noteSaved === true && cellBeforeNoteEdit === cellAfterNoteEdit
  && cellAfterNoteEdit.indexOf(filePdfName) >= 0 && cellAfterNoteEdit.indexOf("+2") >= 0,
  JSON.stringify({ before: cellBeforeNoteEdit, after: cellAfterNoteEdit, editor: noteEditorShown, saved: noteSaved }));

// ④q（Push 246）「文件」列下拉收口：点文件名 = 预览（开预览即收下拉 / Esc 先关浮层）；行尾「删除」= 红胶囊 + 行内二次确认 → 回收站
const popoverReopened = await openTaskFilesPopover();
check("④q0 关抽屉后点「文件」列胶囊 = 下拉重开（3 行：PDF / 改名 PNG / A 都在）", popoverReopened === true, String(popoverReopened));
const popoverIconPairs = await ev("(function(){var items=document.querySelectorAll(" + j("[data-task-files-item]") + ");var out=[];for(var i=0;i<items.length;i++){var icon=items[i].querySelector(" + j("[data-file-icon]") + ");var name=items[i].querySelector(" + j("[data-task-files-preview]") + ");out.push({icon:icon===null?null:icon.getAttribute(" + j("data-file-icon") + "),name:name===null?null:name.textContent.trim()});}return out;})()");
const popoverIconMap = {};
if (Array.isArray(popoverIconPairs)) { for (const pair of popoverIconPairs) { if (pair !== null && pair.name !== null && pair.name !== undefined) { popoverIconMap[pair.name] = pair.icon; } } }
check("④q0b 下拉清单行首文件类型图标（PDF=pdf / 改名 PNG=image / A=txt · FA 同族）", popoverIconMap[filePdfName] === "pdf" && popoverIconMap[filePngRenamed] === "image" && popoverIconMap[fileAName] === "text", JSON.stringify(popoverIconMap));
// ④q0c（2026-10-08 · 业务口径「点击这部分内容现在抽屉也会出来 是bug」）：portal 的点击按 React 树冒泡 —— 点下拉里的空白 / 图标区不得冒到任务行
const popoverBlankPoint = await ev("(function(){var p=document.querySelector(" + j(TASK_FILES_POPOVER) + ");if(p===null){return null;}var li=p.querySelector(" + j("[data-task-files-item]") + ");if(li===null){return null;}var r=li.getBoundingClientRect();return {x:Math.round(r.left+3),y:Math.round(r.top+r.height/2)};})()");
if (popoverBlankPoint === null || popoverBlankPoint === undefined) await bail("下拉里没有文件行（定位空白点失败）");
await clickAt(popoverBlankPoint);
const popoverBlankSafe = await ev("(function(){return {drawer:document.querySelector(" + j(DRAWER) + ")!==null,popover:document.querySelector(" + j(TASK_FILES_POPOVER) + ")!==null};})()");
check("④q0c 点下拉里的空白 / 图标区不冒泡到任务行（详情抽屉不出现、下拉保持打开）", popoverBlankSafe !== null && popoverBlankSafe.drawer === false && popoverBlankSafe.popover === true, JSON.stringify(popoverBlankSafe));
const listNamePoint = await ev("(function(){var p=document.querySelector(" + j(TASK_FILES_POPOVER) + ");if(p===null){return null;}var b=p.querySelector(" + j("[data-task-files-preview]") + ");if(b===null){return null;}var r=b.getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};})()");
if (listNamePoint === null || listNamePoint === undefined) await bail("下拉里没有文件名按钮（data-task-files-preview）");
await clickAt(listNamePoint);
const listPreviewShown = await waitFor("document.querySelector(" + j("[data-file-preview]") + ")!==null", 25000);
const listPreviewInfo = listPreviewShown === true ? await ev("(function(){var el=document.querySelector(" + j("[data-file-preview]") + ");return {open:el!==null,kind:el===null?null:el.getAttribute(" + Q + "data-file-preview-kind" + Q + "),popoverClosed:document.querySelector(" + j(TASK_FILES_POPOVER) + ")===null,drawer:document.querySelector(" + j(DRAWER) + ")!==null};})()") : { open: false, kind: null, popoverClosed: false, drawer: false };
check("④q1 点下拉里最新一份（PDF）文件名 = 预览浮层（kind=" + String(listPreviewInfo.kind) + " · 开预览即收下拉 · 不连带开详情抽屉）", listPreviewInfo.open === true && listPreviewInfo.kind === "pdf" && listPreviewInfo.popoverClosed === true && listPreviewInfo.drawer === false, JSON.stringify(listPreviewInfo));
const listPreviewClosed = await waitForAsync(async () => {
  await ev("(function(){if(document.activeElement&&document.activeElement.blur){document.activeElement.blur();}return true;})()");
  await pressKey("Escape", "Escape", 27);
  return (await ev("document.querySelector(" + j("[data-file-preview]") + ")===null&&document.querySelector(" + j(DRAWER) + ")===null")) === true;
}, 20000);
check("④q2 Esc 关预览浮层（下拉保持收起、详情抽屉不出现 —— 「Esc 先关内层」）", listPreviewClosed === true, String(listPreviewClosed));
const popoverForDelete = await openTaskFilesPopover();
const popRowProbe = await ev("(function(){var items=document.querySelectorAll(" + j("[data-task-files-item]") + ");for(var i=0;i<items.length;i++){if(items[i].textContent.indexOf(" + j(filePdfName) + ")>=0){var b=items[i].querySelector(" + j("[data-task-files-delete] button") + ");var n=items[i].querySelector(" + j("[data-task-files-preview]") + ");if(b===null||n===null){return null;}var rb=b.getBoundingClientRect();var rn=n.getBoundingClientRect();return {bx:Math.round(rb.left+rb.width/2),by:Math.round(rb.top+rb.height/2),nx:Math.round(rn.left+10),ny:Math.round(rn.top+rn.height/2)};}}return null;})()");
if (popoverForDelete !== true || popRowProbe === null || popRowProbe === undefined) await bail("下拉里 PDF 行没有删除入口（data-task-files-delete）");
const capsuleMeasure = "(function(){var items=document.querySelectorAll(" + j("[data-task-files-item]") + ");for(var i=0;i<items.length;i++){if(items[i].textContent.indexOf(" + j(filePdfName) + ")>=0){var b=items[i].querySelector(" + j("[data-task-files-delete] button") + ");if(b===null){return null;}var r=b.getBoundingClientRect();var s=getComputedStyle(b);return {w:Math.round(r.width),h:Math.round(r.height),opacity:s.opacity,bg:s.backgroundColor};}}return null;})()";
const capsuleRest = await ev(capsuleMeasure);
await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: popRowProbe.nx, y: popRowProbe.ny });
await sleep(400);
const capsuleGhost = await ev(capsuleMeasure);
await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: popRowProbe.bx, y: popRowProbe.by });
await sleep(600);
const capsuleHover = await ev(capsuleMeasure);
check("④q3a 行尾删除 = 胶囊同款动效（静止隐 → 随行悬停浮现 24px 幽灵态 → 悬停按钮展开 48px 红胶囊）", capsuleRest !== null && capsuleRest.opacity === "0" && capsuleGhost !== null && capsuleGhost.opacity === "1" && capsuleGhost.w === 24 && capsuleGhost.h === 24 && capsuleHover !== null && capsuleHover.w === 48 && (capsuleHover.bg.indexOf("239, 68, 68") >= 0 || capsuleHover.bg.indexOf("0.637 0.237 25.331") >= 0), JSON.stringify({ rest: capsuleRest, ghost: capsuleGhost, hover: capsuleHover }));
await clickAt({ x: popRowProbe.bx, y: popRowProbe.by });
const popConfirmShown = await waitFor("document.querySelector(" + j("[data-task-files-delete-confirm]") + ")!==null", 6000);
const pdfBeforePopDelete = (await db.query("select status from files where id = $1", [pdfRow.id])).rows[0].status;
check("④q3 下拉「删除」（红胶囊）第一下 = 行内二次确认（此时未落库）", popConfirmShown === true && pdfBeforePopDelete === "draft", "confirm=" + String(popConfirmShown) + " status=" + pdfBeforePopDelete);
const popConfirmPoint = await ev("(function(){var strip=document.querySelector(" + j("[data-task-files-delete-confirm]") + ");if(strip===null){return null;}var b=strip.querySelector(" + j("button") + ");if(b===null){return null;}var r=b.getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};})()");
if (popConfirmPoint === null || popConfirmPoint === undefined) await bail("下拉里找不到确认删除按钮");
await clickAt(popConfirmPoint);
const popRecycled = await waitForAsync(async () => (await db.query("select status from files where id = $1", [pdfRow.id])).rows[0].status === "recycled", 20000);
check("④q4 二次确认后落库 = 回收站（status recycled · 30 天内可恢复）", popRecycled === true, String(popRecycled));
const popListAfterDelete = await waitFor("(function(){var p=document.querySelector(" + j(TASK_FILES_POPOVER) + ");return p!==null&&p.querySelectorAll(" + j("[data-task-files-item]") + ").length===2;})()", 15000);
const cellAfterPopDelete = await waitCellHas([filePngRenamed, "+1"], 20000);
const cellAfterPopDeleteText = String(await ev(CELL_TEXT_PROBE));
check("④q5 下拉清单回落 2 行、「文件」列 = 改名后的 PNG + 「+1」（recycled 不进读面）", popListAfterDelete === true && cellAfterPopDelete === true && cellAfterPopDeleteText === filePngRenamed + "+1", JSON.stringify({ list: popListAfterDelete, cell: cellAfterPopDeleteText }));
// ④r（Push 248 → Push 251 撤销 · 业务口径「取消这个替换按钮」）：
//   行尾「替换」入口与整套替换流程（草稿直替 / 替换前定档一问 / 已定档变更原因）整体从 UI 撤除，
//   接口层保留（fileApi.replaceFileContent 未接线，服务端变更通道不动）。
const fileAId = (await db.query("select id from files where task_id = $1 and name = $2", [taskId, fileAName])).rows[0].id;
const aVersionsBefore = (await db.query("select seq, content_hash from file_versions where file_id = $1 order by seq", [fileAId])).rows;
const replaceGoneInfo = await ev("(function(){var p=document.querySelector(" + j(TASK_FILES_POPOVER) + ");if(p===null){return null;}"
  + "return {rowEntry:p.querySelector(" + j("[data-task-files-replace]") + ")===null,rowReplacing:p.querySelector(" + j("[data-task-files-replacing]") + ")===null,input:p.querySelector(" + j("[data-task-files-replace-input]") + ")===null,reason:p.querySelector(" + j("[data-task-files-replace-prompt]") + ")===null,note:p.querySelector(" + j("[data-task-files-note-replace]") + ")===null,text:p.innerText.indexOf(" + j("替换") + ")<0};})()");
check("④r0 下拉里替换入口整体撤除（无 data-task-files-replace / 无替换输入框 / 无变更原因区 / 无替换提示 / 文本不含「替换」）",
  replaceGoneInfo !== null && replaceGoneInfo !== undefined && replaceGoneInfo.rowEntry === true && replaceGoneInfo.rowReplacing === true && replaceGoneInfo.input === true && replaceGoneInfo.reason === true && replaceGoneInfo.note === true && replaceGoneInfo.text === true, JSON.stringify(replaceGoneInfo));
const versionCountNoReplace = (await db.query("select count(*)::int as c from file_versions where file_id = $1", [fileAId])).rows[0].c;
check("④r1 无替换路径 → A 版本链保持初版一行（file_versions 1 · 草稿替换已随入口撤除）",
  aVersionsBefore.length === 1 && Number(versionCountNoReplace) === 1, JSON.stringify({ before: aVersionsBefore.length, now: versionCountNoReplace }));

// ④s（Push 249 · 业务口径「添加和替换文件要提示是否为定档文件，若是则上传文件后该任务定档不支持任何修改」）：
//   「＋ 添加定档文件」直点 → 传完即定档（POST /files/{id}/finalize）→ files final + tasks.finalized_at 同事务置位 + 任务定档审计；
//   此后任务写口全 409 TASK_FINALIZED（编辑 / 删除 / 新增上传 / 改名 / 直替），下拉顶常驻提示、两个添加入口关闭（替换入口已随 Push 251 整体撤除）。
const fileCFinalName = "回放-任务文件-C-定档.txt";
const fileCFinalPath = join(fileDir, fileCFinalName);
writeFileSync(fileCFinalPath, "LibiaoLink 回放 C 定档内容 " + fixtureCode + String.fromCharCode(10), "utf8");
const addFinalPoint = await clickSelector("[data-task-files-add-finalize]");
await sleep(400);
const addFinalNoAsk = await ev("document.querySelector(" + j(FINALIZE_PROMPT) + ")===null");
if (addFinalPoint !== true || addFinalNoAsk !== true) await bail("下拉「＋ 添加定档文件」点不开或仍出定档确认");
check("④s0 点「＋ 添加定档文件」= 直接进取文件框（不出定档确认）", addFinalPoint === true && addFinalNoAsk === true, JSON.stringify({ clicked: addFinalPoint, noPrompt: addFinalNoAsk }));
await setFileInput(POPOVER_INPUT, fileCFinalPath);
const cFinalLanded = await waitForAsync(async () => {
  const rows = (await db.query("select status from files where task_id = $1 and name = $2", [taskId, fileCFinalName])).rows;
  return rows.length === 1 && rows[0].status === "final";
}, 40000);
const cFinalRow = (await db.query("select id, status, finalized_at, finalized_by from files where task_id = $1 and name = $2", [taskId, fileCFinalName])).rows[0];
const taskFinalRow = (await db.query("select finalized_at, finalized_by from tasks where id = $1", [taskId])).rows[0];
const taskFinalAudit = (await db.query("select count(*)::int as c, max(summary) as summary from audit_logs where object_type = $1 and object_id = $2 and summary like $3", ["task", taskId, "%任务定档%"])).rows[0];
check("④s1 「＋ 添加定档文件」→ 上传完成即定档：files.status = final（finalized_at / finalized_by 成对）+ 任务随文件定档同事务置位（tasks.finalized_at 非空 · 操作人一致）+ 任务定档审计行",
  cFinalLanded === true && cFinalRow !== undefined && cFinalRow.status === "final" && cFinalRow.finalized_at !== null && cFinalRow.finalized_by !== null
  && taskFinalRow !== undefined && taskFinalRow.finalized_at !== null && taskFinalRow.finalized_by === cFinalRow.finalized_by
  && Number(taskFinalAudit.c) === 1 && String(taskFinalAudit.summary).indexOf("随文件定档") >= 0,
  JSON.stringify({ file: cFinalRow, task: taskFinalRow, audit: taskFinalAudit }));
const finalNoteShown = await waitFor("document.querySelector(" + j(FINALIZE_NOTE) + ")!==null", 20000);
const finalNoteText = finalNoteShown === true ? String(await ev("(function(){var n=document.querySelector(" + j(FINALIZE_NOTE) + ");return n===null?" + j("") + ":n.textContent.trim();})()")) : "";
check("④s2 定档后下拉顶出常驻提示（整表重取后随任务定档态出现：不支持新增 / 改名 / 删除等修改）",
  finalNoteShown === true && finalNoteText.indexOf("任务已定档") >= 0 && finalNoteText.indexOf("不支持新增") >= 0 && finalNoteText.indexOf("删除") >= 0, finalNoteText.slice(0, 120));
// ④s2b（Push 260 · 业务口径「定档后还能删除是bug 不能删除定档后」）：定档任务的下拉里，文件行尾「删除」入口
// 整体下架（幽灵胶囊 / 确认删除条都不出现）—— 删除走不了，修改走变更（服务端 recycle 同闸，见 ④s6）。
const finalDeleteGone = await ev("(function(){var p=document.querySelector(" + j(TASK_FILES_POPOVER) + ");if(p===null){return null;}var n=p.querySelector(" + j(FINALIZE_NOTE) + ");return {deletes:p.querySelectorAll(" + j("[data-task-files-delete]") + ").length,confirms:p.querySelectorAll(" + j("[data-task-files-delete-confirm]") + ").length,noteDelete:n!==null&&n.textContent.indexOf(" + j("删除") + ")>=0};})()");
check("④s2b 定档后下拉里「删除」入口整体下架（无幽灵胶囊 / 无确认删除条；常驻提示点明「删除」）",
  finalDeleteGone !== null && finalDeleteGone.deletes === 0 && finalDeleteGone.confirms === 0 && finalDeleteGone.noteDelete === true, JSON.stringify(finalDeleteGone));
const blockAddFinalizePoint = await clickSelector("[data-task-files-add-finalize]");
const blockAddNoteFinalize = await waitFor("(function(){var n=document.querySelector(" + j(FINALIZE_BLOCK_NOTE) + ");return n!==null&&n.textContent.indexOf(" + j("不支持新增文件") + ")>=0;})()", 6000);
const blockAddPoint = await clickSelector("[data-task-files-add]");
const blockAddInfo = await ev("(function(){var n=document.querySelector(" + j(FINALIZE_BLOCK_NOTE) + ");return {note:n===null?null:n.textContent.trim(),prompt:document.querySelector(" + j(FINALIZE_PROMPT) + ")!==null};})()");
check("④s3 已定档再点「＋ 添加定档文件」/「＋ 添加文件」= 不出定档确认、不开选文件框，改出一行提示（服务端同口径 409 TASK_FINALIZED）",
  blockAddFinalizePoint === true && blockAddNoteFinalize === true && blockAddPoint === true && blockAddInfo.prompt === false && blockAddInfo.note !== null && blockAddInfo.note.indexOf("不支持新增文件") >= 0, JSON.stringify(blockAddInfo));
const finalReplaceGone = await ev("(function(){var p=document.querySelector(" + j(TASK_FILES_POPOVER) + ");if(p===null){return null;}return {rowEntry:p.querySelector(" + j("[data-task-files-replace]") + ")===null,reason:p.querySelector(" + j("[data-task-files-replace-prompt]") + ")===null,text:p.innerText.indexOf(" + j("替换") + ")<0};})()");
check("④s4 已定档任务下拉里同样无替换入口 / 无变更原因区（替换流程整体撤除 · 定档拦截提示口径不变）",
  finalReplaceGone !== null && finalReplaceGone !== undefined && finalReplaceGone.rowEntry === true && finalReplaceGone.reason === true && finalReplaceGone.text === true, JSON.stringify(finalReplaceGone));
const taskVerNow = (await db.query("select version from tasks where id = $1", [taskId])).rows[0];
const patchBlocked = await api("/api/v1/projects/" + projectId + "/tasks/" + taskId, "PATCH", { version: Number(taskVerNow.version), progress: 60 });
const deleteBlocked = await api("/api/v1/projects/" + projectId + "/tasks/" + taskId, "DELETE", undefined, { "If-Match": String(taskVerNow.version) });
check("④s5 定档后任务写口全拦（服务端）：PATCH 编辑 409 TASK_FINALIZED + DELETE 删除 409 TASK_FINALIZED",
  patchBlocked.status === 409 && patchBlocked.json !== null && patchBlocked.json.code === "TASK_FINALIZED"
  && deleteBlocked.status === 409 && deleteBlocked.json !== null && deleteBlocked.json.code === "TASK_FINALIZED",
  JSON.stringify({ patch: patchBlocked.status + " " + patchBlocked.text.slice(0, 90), del: deleteBlocked.status + " " + deleteBlocked.text.slice(0, 90) }));
const uploadBlocked = await api("/api/v1/files/uploads", "POST", { projectId, name: "回放-定档拦截-新增.txt", sizeBytes: 12, contentHash: sha256("blocked-add-" + fixtureCode), intent: "version", taskId });
const aDetailForBlock = await api("/api/v1/files/" + fileAId);
const renameBlocked = await api("/api/v1/files/" + fileAId, "PATCH", { name: "回放-任务文件-A-改名尝试.txt", version: aDetailForBlock.json.version });
const directReplaceBlocked = await api("/api/v1/files/uploads", "POST", { projectId, name: fileAName, sizeBytes: 12, contentHash: sha256("blocked-replace-" + fixtureCode), intent: "version", fileId: fileAId });
const recycleBlocked260 = await api("/api/v1/files/" + fileAId + "/recycle", "POST", { version: aDetailForBlock.json.version });
check("④s6 定档后文件直接写口全拦（服务端）：挂本任务新增上传（intent=version）409 + 改名 409 + 直替（fileId=A）409 + 删除（recycle）409（全为 TASK_FINALIZED）",
  uploadBlocked.status === 409 && uploadBlocked.json !== null && uploadBlocked.json.code === "TASK_FINALIZED"
  && renameBlocked.status === 409 && renameBlocked.json !== null && renameBlocked.json.code === "TASK_FINALIZED"
  && directReplaceBlocked.status === 409 && directReplaceBlocked.json !== null && directReplaceBlocked.json.code === "TASK_FINALIZED"
  && recycleBlocked260.status === 409 && recycleBlocked260.json !== null && recycleBlocked260.json.code === "TASK_FINALIZED",
  JSON.stringify({ upload: uploadBlocked.status + " " + uploadBlocked.text.slice(0, 60), rename: renameBlocked.status + " " + renameBlocked.text.slice(0, 60), replace: directReplaceBlocked.status + " " + directReplaceBlocked.text.slice(0, 60), recycle: recycleBlocked260.status + " " + recycleBlocked260.text.slice(0, 60) }));
// ④s7（Push 260 · 同 ④s2b 口径）：抽屉「文件」行 = 删除入口整体下架（幽灵胶囊 / 确认条都不出现）+ 顶一行定档提示。
await page.send("Page.reload", { ignoreCache: true });
await waitFor("document.querySelector(" + j(FILE_CELL_BUTTON) + ")!==null", 20000);
await ev("(function(){var rows=document.querySelectorAll(" + j("[role=button]") + ");for(var i=0;i<rows.length;i++){if(rows[i].textContent.indexOf(" + j(TASK_TITLE) + ")>=0){rows[i].scrollIntoView({block:" + j("center") + ",inline:" + j("start") + "});return true;}}return false;})()");
await sleep(400);
const row1FinalPoint = await ev("(function(){var rows=document.querySelectorAll(" + j("[role=button]") + ");for(var i=0;i<rows.length;i++){if(rows[i].textContent.indexOf(" + j(TASK_TITLE) + ")>=0){var b=rows[i].getBoundingClientRect();return {x:Math.round(b.left+60),y:Math.round(b.top+b.height/2)};}}return null;})()");
if (row1FinalPoint === null || row1FinalPoint === undefined) await bail("定档任务行没渲染出来（抽屉删除入口用例）");
await clickAt(row1FinalPoint);
await waitFor("document.querySelector(" + j(DRAWER) + ")!==null", 8000);
await waitFor("document.querySelectorAll(" + j("[data-drawer-file-item]") + ").length > 0", 15000);
const drawerDeleteGone = await ev("(function(){var d=document.querySelector(" + j(DRAWER) + ");if(d===null){return null;}var n=d.querySelector(" + j("[data-drawer-files-note-finalized]") + ");return {items:d.querySelectorAll(" + j("[data-drawer-file-item]") + ").length,deletes:d.querySelectorAll(" + j("[data-file-delete]") + ").length,confirms:d.querySelectorAll(" + j("[data-file-delete-confirm]") + ").length,note:n===null?null:n.textContent.trim()};})()");
check("④s7 定档任务的抽屉「文件」行：删除入口整体下架（幽灵胶囊 / 确认条都不出现）+ 顶一行定档提示（不支持新增 / 改名 / 删除）",
  drawerDeleteGone !== null && drawerDeleteGone.items > 0 && drawerDeleteGone.deletes === 0 && drawerDeleteGone.confirms === 0 && typeof drawerDeleteGone.note === "string" && drawerDeleteGone.note.indexOf("删除") >= 0, JSON.stringify(drawerDeleteGone));
// ④t 抽屉「定档」开关端到端（Push 252 · 业务口径「在抽屉中每个任务在任务状态旁边加一个定档按钮状态 有二次提示的」）：
//   第二条任务（本任务已随文件定档锁定，确认路径要在未定档任务上验证）—— 建任务 → 重载 → 开抽屉 → 点开关 → 二次确认「确认定档」
//   → tasks.finalized_at / finalized_by 置位（version+1）+ 任务定档审计 + 开关转「已（on）」并置灰；接口幂等（重复 POST 原样返回）+ 定档后写口 409。
const task2Title = "回放任务·抽屉定档开关";
const task2Res = await api("/api/v1/projects/" + projectId + "/tasks", "POST", { stageKey: "design", title: task2Title, ownerIds: [userRow.id] });
check("④t0 夹具：第二条任务（抽屉定档开关端到端用）", task2Res.status === 201, String(task2Res.status) + " " + task2Res.text.slice(0, 140));
const task2Id = task2Res.json === null ? "" : task2Res.json.id;
const task2Ver0 = task2Res.json === null ? 0 : Number(task2Res.json.version);
const finalizeStale = await api("/api/v1/projects/" + projectId + "/tasks/" + task2Id + "/finalize", "POST", { version: task2Ver0 + 5 });
check("④t1 未定档路径 version 不匹配 → 409 VERSION_CONFLICT",
  finalizeStale.status === 409 && finalizeStale.json !== null && finalizeStale.json.code === "VERSION_CONFLICT",
  String(finalizeStale.status) + " " + finalizeStale.text.slice(0, 90));
await page.send("Page.reload", { ignoreCache: true });
const boardForFinalize = await waitFor("document.querySelector(" + j(FILE_CELL_BUTTON) + ")!==null", 20000);
await ev("(function(){var rows=document.querySelectorAll(" + j("[role=button]") + ");for(var i=0;i<rows.length;i++){if(rows[i].textContent.indexOf(" + j(task2Title) + ")>=0){rows[i].scrollIntoView({block:" + j("center") + ",inline:" + j("start") + "});return true;}}return false;})()");
await sleep(400);
const row2Point = await ev("(function(){var rows=document.querySelectorAll(" + j("[role=button]") + ");for(var i=0;i<rows.length;i++){if(rows[i].textContent.indexOf(" + j(task2Title) + ")>=0){var b=rows[i].getBoundingClientRect();return {x:Math.round(b.left+60),y:Math.round(b.top+b.height/2)};}}return null;})()");
if (boardForFinalize !== true || row2Point === null || row2Point === undefined) await bail("第二条任务行没渲染出来（定档开关用例）");
const scanFinalizedTags = () => ev("(function(){var all=document.querySelectorAll(" + j("[data-task-finalized-badge]") + ");var wrap=document.querySelector(" + j("[data-board-wrap]") + ");var wl=wrap===null?null:Math.round(wrap.getBoundingClientRect().left);var cv=document.createElement('canvas');cv.width=1;cv.height=1;var cx=cv.getContext('2d',{willReadFrequently:true});var toRgb=function(css){cx.clearRect(0,0,1,1);cx.fillStyle=css;cx.fillRect(0,0,1,1);var d=cx.getImageData(0,0,1,1).data;return [Number(d[0]),Number(d[1]),Number(d[2])];};var out=[];for(var i=0;i<all.length;i++){var b=all[i].getBoundingClientRect();var cs=getComputedStyle(all[i]);out.push({text:all[i].textContent.trim(),bg:cs.backgroundColor,fg:cs.color,bgRgb:toRgb(cs.backgroundColor),fgRgb:toRgb(cs.color),wm:cs.writingMode,left:Math.round(b.left),right:Math.round(b.right),top:Math.round(b.top),bottom:Math.round(b.bottom),wrapLeft:wl});}return out;})()");
const rowBoxOf = (title) => ev("(function(){var rows=document.querySelectorAll(" + j("[role=button]") + ");for(var i=0;i<rows.length;i++){if(rows[i].textContent.indexOf(" + j(title) + ")>=0){var r=rows[i].getBoundingClientRect();return {top:Math.round(r.top),bottom:Math.round(r.bottom)};}}return null;})()");
// 颜色比对走 sRGB：Tailwind v4 的 getComputedStyle 在 Chrome 里回 oklch(...)，不能直接和 rgb 串比 —— 用 canvas 画一格再读像素换算（oklch→sRGB 有 1~2 档取整，容差放到 12；量级仍足以排除 logo 黄 / amber-500 这类饱和黄）。
const nearRgb = (value, r, g, b) => Array.isArray(value) && Math.abs(Number(value[0]) - r) <= 12 && Math.abs(Number(value[1]) - g) <= 12 && Math.abs(Number(value[2]) - b) <= 12;
const tagStyled = (tag) => tag !== undefined && tag !== null && tag.text === "定档" && nearRgb(tag.bgRgb, 255, 251, 235) && nearRgb(tag.fgRgb, 187, 77, 0) && String(tag.wm).indexOf("vertical") >= 0 && Number(tag.right) - Number(tag.left) <= 24;
const tagOutside = (tag) => tag !== undefined && tag !== null && Number(tag.right) <= Number(tag.wrapLeft) + 1;
// 行与行上下相邻（无间隙），按「签的竖向中心落在这一行的高度区间内」判定归属，避免 ±容差同时命中两行。
const tagOnRow = (tag, row) => tag !== undefined && tag !== null && row !== undefined && row !== null && (Number(tag.top) + Number(tag.bottom)) / 2 >= Number(row.top) && (Number(tag.top) + Number(tag.bottom)) / 2 <= Number(row.bottom);
// ④t0b 定档前（负向）：整表只有第一个任务（已随文件定档）挂侧签 —— 第二条任务还没有（④t8 确认定档后才有）。
// ④t8 「定档」侧签 = 竖排 2 字 · 很淡的黄底（amber-50）+ 琥珀字（amber-700）· 整颗在表格左边缘外（竖排一颗字宽，放得下）。
const tagsBefore = (await scanFinalizedTags()) ?? [];
const row1Box = await rowBoxOf(TASK_TITLE);
check("④t0b 定档前：整表只有已随文件定档的第一个任务挂「定档」侧签（竖排 · 淡黄 · 整颗在表格外 · 纵向对齐）",
  Array.isArray(tagsBefore) && tagsBefore.length === 1 && tagStyled(tagsBefore[0]) && tagOutside(tagsBefore[0]) && tagOnRow(tagsBefore[0], row1Box),
  JSON.stringify({ tags: tagsBefore, row1: row1Box }));
await clickAt(row2Point);
const drawer2Open = await waitFor("document.querySelector(" + j(DRAWER) + ")!==null", 8000);
const sw2Off = drawer2Open === true ? await ev("(function(){var s=document.querySelector(" + j("[data-task-finalize]") + ");return s===null?null:s.getAttribute(" + Q + "data-task-finalize" + Q + ");})()") : null;
check("④t2 第二条任务抽屉打开、开关 = off（未定档）", drawer2Open === true && sw2Off === "off", JSON.stringify({ open: drawer2Open, state: sw2Off }));
const sw2Clicked = await clickSelector("[data-task-finalize]");
const confirm2Shown = await waitFor("document.querySelector(" + j("[data-task-finalize-confirm]") + ")!==null", 6000);
const task2BeforeConfirm = (await db.query("select finalized_at from tasks where id = $1", [task2Id])).rows[0];
check("④t3 点开关出二次确认条（确认前不落库）",
  sw2Clicked === true && confirm2Shown === true && task2BeforeConfirm.finalized_at === null,
  JSON.stringify({ clicked: sw2Clicked, confirm: confirm2Shown, finalizedAt: task2BeforeConfirm.finalized_at }));
const confirm2Clicked = await clickSelector("[data-task-finalize-confirm-btn]");
const task2Finalized = await waitForAsync(async () => (await db.query("select finalized_at from tasks where id = $1", [task2Id])).rows[0].finalized_at !== null, 20000);
const task2Row = (await db.query("select finalized_at, finalized_by, version from tasks where id = $1", [task2Id])).rows[0];
const task2Audit = (await db.query("select count(*)::int as c, max(summary) as summary from audit_logs where object_type = $1 and object_id = $2 and summary like $3", ["task", task2Id, "%任务定档%"])).rows[0];
check("④t4 二次确认「确认定档」→ tasks.finalized_at / finalized_by 置位（version+1 · 操作人一致）+ 任务定档审计",
  confirm2Clicked === true && task2Finalized === true && task2Row.finalized_at !== null && task2Row.finalized_by === userRow.id && Number(task2Row.version) === task2Ver0 + 1
  && Number(task2Audit.c) === 1 && String(task2Audit.summary).indexOf("任务定档") >= 0,
  JSON.stringify({ row: task2Row, audit: task2Audit, version0: task2Ver0 }));
const sw2On = await waitFor("(function(){var s=document.querySelector(" + j("[data-task-finalize]") + ");return s!==null&&s.getAttribute(" + Q + "data-task-finalize" + Q + ")===" + j("on") + "&&s.disabled!==true;})()", 15000);
const sw2After = await ev("(function(){var s=document.querySelector(" + j("[data-task-finalize]") + ");return s===null?null:{state:s.getAttribute(" + Q + "data-task-finalize" + Q + "),knob:s.textContent.trim(),disabled:s.disabled===true,title:s.getAttribute(" + Q + "title" + Q + ")};})()");
check("④t5 确认后开关转「已（on）」且可再点（旋钮「已」· 不置灰 · title 提示取消定档 —— Push 260 改版）",
  sw2On === true && sw2After !== null && sw2After !== undefined && sw2After.state === "on" && sw2After.knob === "已" && sw2After.disabled === false && String(sw2After.title).indexOf("取消定档") >= 0,
  JSON.stringify(sw2After));
const shotFinalized = await page.send("Page.captureScreenshot", { format: "png" });
writeFileSync(join(SCREENSHOT_DIR, "m4-07-drawer-finalized.png"), Buffer.from(shotFinalized.data, "base64"));
const finalizeAgain = await api("/api/v1/projects/" + projectId + "/tasks/" + task2Id + "/finalize", "POST", { version: task2Ver0 });
const task2RowAfter = (await db.query("select version, finalized_at from tasks where id = $1", [task2Id])).rows[0];
const task2AuditAgain = (await db.query("select count(*)::int as c from audit_logs where object_type = $1 and object_id = $2 and summary like $3", ["task", task2Id, "%任务定档%"])).rows[0];
check("④t6 重复 POST /finalize 幂等（200 原样返回 · version 不再递增 · 审计不重复）",
  finalizeAgain.status === 200 && finalizeAgain.json !== null && Number(finalizeAgain.json.version) === task2Ver0 + 1
  && new Date(task2RowAfter.finalized_at).toISOString() === finalizeAgain.json.finalizedAt
  && Number(task2RowAfter.version) === task2Ver0 + 1 && Number(task2AuditAgain.c) === 1,
  JSON.stringify({ status: finalizeAgain.status, version: finalizeAgain.json === null ? null : finalizeAgain.json.version, dbVersion: task2RowAfter.version, audit: task2AuditAgain.c }));
const patch2Blocked = await api("/api/v1/projects/" + projectId + "/tasks/" + task2Id, "PATCH", { version: task2Ver0 + 1, progress: 40 });
check("④t7 定档后任务写口拦（PATCH 409 TASK_FINALIZED）",
  patch2Blocked.status === 409 && patch2Blocked.json !== null && patch2Blocked.json.code === "TASK_FINALIZED",
  String(patch2Blocked.status) + " " + patch2Blocked.text.slice(0, 90));
await pressKey("Escape", "Escape", 27);
await waitFor("document.querySelector(" + j(DRAWER) + ")===null", 8000);
// ④t8 「定档」侧签（Push 252 · 业务口径演进：「不是在表格内 要在表格外部懂吗 延伸出一个小标签」→「改成定档两个字 黄色变淡」→「竖排的改横排」→ 定稿「竖着的定档二字的在表格外」）：
//   关掉抽屉后：两个已定档任务（第一个随文件定档 + 第二个刚确认）各在**表格左边缘外侧**挂一颗竖排小签
//   （amber-50 底 + amber-700 字 · writing-mode vertical-rl · 整颗在表格左边缘外 —— 右缘不超过卡片左边界），纵向与各自行中心对齐。
const tagsAfter = (await scanFinalizedTags()) ?? [];
const row1After = await rowBoxOf(TASK_TITLE);
const row2After = await rowBoxOf(task2Title);
check("④t8 两个定档任务各挂一颗表格外的竖排「定档」侧签（淡黄 · 整颗在表格左边缘外 · 纵向对齐各自行）",
  tagsAfter.length === 2 && tagsAfter.every(tagStyled) && tagsAfter.every(tagOutside)
  && tagsAfter.filter((tag) => tagOnRow(tag, row1After)).length === 1 && tagsAfter.filter((tag) => tagOnRow(tag, row2After)).length === 1,
  JSON.stringify({ tags: tagsAfter, row1: row1After, row2: row2After }));
// ④t9 取消定档（Push 260 · 业务口径「点击定档按钮应该也要计入操作记录」+「把现在的定档改成 再次点击取消定档吧」）：
//   抽屉「已（on）」开关再次点击 = 就地二次确认（确认前仍定档、不落库）→「确认取消定档」→ tasks.finalized_at / finalized_by 清空
//   （version+1、留痕「取消定档」—— 定档 / 取消定档都进操作记录）→ 开关回「未（off）」+ 任务写口恢复（PATCH 200）；
//   表格外「定档」侧签随之消失；接口幂等（未定档重复 POST → 200 原样返回、审计不重复）。
await ev("(function(){var rows=document.querySelectorAll(" + j("[role=button]") + ");for(var i=0;i<rows.length;i++){if(rows[i].textContent.indexOf(" + j(task2Title) + ")>=0){rows[i].scrollIntoView({block:" + j("center") + ",inline:" + j("start") + "});return true;}}return false;})()");
await sleep(400);
const row2PointAgain = await ev("(function(){var rows=document.querySelectorAll(" + j("[role=button]") + ");for(var i=0;i<rows.length;i++){if(rows[i].textContent.indexOf(" + j(task2Title) + ")>=0){var b=rows[i].getBoundingClientRect();return {x:Math.round(b.left+60),y:Math.round(b.top+b.height/2)};}}return null;})()");
if (row2PointAgain === null || row2PointAgain === undefined) await bail("取消定档用例：第二条任务行没渲染出来");
await clickAt(row2PointAgain);
const drawer2Reopen = await waitFor("document.querySelector(" + j(DRAWER) + ")!==null&&document.querySelector(" + j("[data-task-finalize]") + ")!==null", 8000);
const sw2CancelClicked = await clickSelector("[data-task-finalize]");
const cancel2ConfirmShown = await waitFor("document.querySelector(" + j("[data-task-unfinalize-confirm]") + ")!==null", 6000);
const task2BeforeCancel = (await db.query("select finalized_at from tasks where id = $1", [task2Id])).rows[0];
check("④t9 已定档开关再次点击 = 就地二次确认（确认前仍定档 · 不落库）",
  drawer2Reopen === true && sw2CancelClicked === true && cancel2ConfirmShown === true && task2BeforeCancel.finalized_at !== null,
  JSON.stringify({ open: drawer2Reopen, clicked: sw2CancelClicked, confirm: cancel2ConfirmShown, finalizedAt: task2BeforeCancel.finalized_at }));
const cancel2ConfirmClicked = await clickSelector("[data-task-unfinalize-confirm-btn]");
const task2Unfinalized = await waitForAsync(async () => (await db.query("select finalized_at from tasks where id = $1", [task2Id])).rows[0].finalized_at === null, 20000);
const task2RowAfterCancel = (await db.query("select finalized_at, finalized_by, version from tasks where id = $1", [task2Id])).rows[0];
const task2UnfinalAudit = (await db.query("select count(*)::int as c, max(summary) as summary from audit_logs where object_type = $1 and object_id = $2 and summary like $3", ["task", task2Id, "%取消定档%"])).rows[0];
check("④t10 确认取消定档：finalized_at / finalized_by 清空（version+1）+ 审计「取消定档」（定档 / 取消定档都计入操作记录）",
  cancel2ConfirmClicked === true && task2Unfinalized === true && task2RowAfterCancel.finalized_at === null && task2RowAfterCancel.finalized_by === null
  && Number(task2RowAfterCancel.version) === task2Ver0 + 2 && Number(task2UnfinalAudit.c) === 1 && String(task2UnfinalAudit.summary).indexOf("取消定档") >= 0,
  JSON.stringify({ row: task2RowAfterCancel, audit: task2UnfinalAudit, version0: task2Ver0 }));
const sw2OffAgain = await waitFor("(function(){var s=document.querySelector(" + j("[data-task-finalize]") + ");return s!==null&&s.getAttribute(" + Q + "data-task-finalize" + Q + ")===" + j("off") + "&&s.disabled!==true;})()", 15000);
check("④t11 取消定档后开关回「未（off）」（旋钮「未」· 可再次定档）", sw2OffAgain === true, JSON.stringify({ off: sw2OffAgain }));
const patch2Allowed = await api("/api/v1/projects/" + projectId + "/tasks/" + task2Id, "PATCH", { version: task2Ver0 + 2, note: "取消定档后写口恢复（回放）" });
const task2RowAfterPatch = (await db.query("select version, note from tasks where id = $1", [task2Id])).rows[0];
check("④t12 取消定档后任务写口恢复：PATCH 200（version+1 · note 落库；与 ④t7 定档态 409 对照）",
  patch2Allowed.status === 200 && task2RowAfterPatch.note === "取消定档后写口恢复（回放）" && Number(task2RowAfterPatch.version) === task2Ver0 + 3,
  String(patch2Allowed.status) + " " + JSON.stringify(task2RowAfterPatch));
await pressKey("Escape", "Escape", 27);
await waitFor("document.querySelector(" + j(DRAWER) + ")===null", 8000);
const tagsAfterCancel = (await scanFinalizedTags()) ?? [];
const row1AfterCancel = await rowBoxOf(TASK_TITLE);
const row2AfterCancel = await rowBoxOf(task2Title);
check("④t13 取消定档后该任务的「定档」侧签消失（只剩第一个任务的 1 颗 · 竖排淡黄仍在）",
  tagsAfterCancel.length === 1 && tagStyled(tagsAfterCancel[0]) && tagOnRow(tagsAfterCancel[0], row1AfterCancel) && tagsAfterCancel.filter((tag) => tagOnRow(tag, row2AfterCancel)).length === 0,
  JSON.stringify({ tags: tagsAfterCancel, row1: row1AfterCancel, row2: row2AfterCancel }));
const cancel2Again = await api("/api/v1/projects/" + projectId + "/tasks/" + task2Id + "/unfinalize", "POST", { version: task2Ver0 + 3 });
const task2UnfinalAuditAgain = (await db.query("select count(*)::int as c from audit_logs where object_type = $1 and object_id = $2 and summary like $3", ["task", task2Id, "%取消定档%"])).rows[0];
check("④t14 未定档重复 POST /unfinalize 幂等（200 原样返回 · 不递增版本 · 审计不重复）",
  cancel2Again.status === 200 && cancel2Again.json !== null && Number(cancel2Again.json.version) === task2Ver0 + 3 && Number(task2UnfinalAuditAgain.c) === 1,
  JSON.stringify({ status: cancel2Again.status, version: cancel2Again.json === null ? null : cancel2Again.json.version, audit: task2UnfinalAuditAgain.c }));
const aDetail = await api("/api/v1/files/" + fileAId);
const finalized = await api("/api/v1/files/" + fileAId + "/finalize", "POST", { version: aDetail.json.version });
const aStatusFinal = (await db.query("select status from files where id = $1", [fileAId])).rows[0].status;
check("④r2a 夹具：A 经 API 定档（draft → final）", finalized.status === 200 && aStatusFinal === "final", String(finalized.status) + " " + aStatusFinal);
await page.send("Page.reload", { ignoreCache: true });
const boardReloadedForChange = await waitFor("document.querySelector(" + j(FILE_CELL_BUTTON) + ")!==null&&document.querySelector(" + j(TASK_FILES_POPOVER) + ")===null", 20000);
const filesRefetchedForChange = boardReloadedForChange === true ? await waitCellHas([fileCFinalName], 20000) : false;
const popoverForChange = filesRefetchedForChange === true ? await openTaskFilesPopover() : false;
const replaceGoneFinal = popoverForChange === true ? await ev("(function(){var p=document.querySelector(" + j(TASK_FILES_POPOVER) + ");if(p===null){return null;}return {rowEntry:p.querySelector(" + j("[data-task-files-replace]") + ")===null,input:p.querySelector(" + j("[data-task-files-replace-input]") + ")===null,note:p.querySelector(" + j("[data-task-files-note-finalized]") + ")!==null,text:p.innerText.indexOf(" + j("替换") + ")<0};})()") : null;
check("④r2b 重载后（A 已定档 + 任务已定档）下拉仍无替换入口（替换流程整体撤除 · 定档常驻提示仍在 · 清单已回流 C）",
  filesRefetchedForChange === true && popoverForChange === true && replaceGoneFinal !== null && replaceGoneFinal !== undefined && replaceGoneFinal.rowEntry === true && replaceGoneFinal.input === true && replaceGoneFinal.note === true && replaceGoneFinal.text === true, JSON.stringify(replaceGoneFinal));


// ---------- ④u 抽屉页标签导航（Push 254）----------
// 夹具（变更须落在「有变更关联」的任务上才好验「变更记录」）：第三条任务（输出成果文件 = CAD图纸）+
// 经 API 直传一份 docType=CAD图纸 的成果文件并定档 —— R01 按「变更文件成果类型 ∈ 任务输出成果文件」回写 change_refs。
const changeTaskTitle = "回放任务·变更申请与记录";
const task3Res = await api("/api/v1/projects/" + projectId + "/tasks", "POST", { stageKey: "design", title: changeTaskTitle, ownerIds: [userRow.id], deliverableTypes: ["CAD图纸"] });
check("④u0 夹具：建第三条任务（输出成果文件 = CAD图纸）", task3Res.status === 201, String(task3Res.status) + " " + task3Res.text.slice(0, 140));
const task3Id = task3Res.json === null ? "" : task3Res.json.id;
const changedTargetName = "回放-变更目标-图纸.txt";
const changeAfterName = "回放-变更后-图纸-v2.pdf";
const changedTargetPath = join(fileDir, changedTargetName);
const changeAfterPath = join(fileDir, changeAfterName);
const changedTargetBuf = Buffer.from("LibiaoLink 回放变更目标 v1 " + fixtureCode + String.fromCharCode(10), "utf8");
// Push 256：变更后文件 = 变更选择的文件本身（换扩展名 .txt → .pdf，真 PDF 字节 —— 通道 / 下载名 / 对象键按新扩展名）。
const changeAfterBuf = minimalPdf("LibiaoLink 回放变更后 v2 " + fixtureCode);
writeFileSync(changedTargetPath, changedTargetBuf);
writeFileSync(changeAfterPath, changeAfterBuf);
/** 经 API 分片直传一份文件（带 docType / taskId；变更夹具）→ finalize=true 时完成即定档（file final + 任务随定档锁定）；
 *  finalize=false = 只传成 draft（「变更前先定档」用例的未定档夹具）。 */
async function uploadViaApi(name, buffer, docType, taskIdArg, finalize = true) {
  const hash = sha256(buffer);
  const created = await api("/api/v1/files/uploads", "POST", { projectId, name, sizeBytes: buffer.byteLength, contentHash: hash, intent: "version", taskId: taskIdArg, docType });
  if (created.status !== 201 || created.json === null) return { ok: false, detail: "create " + String(created.status) + " " + created.text.slice(0, 120) };
  const fileId = created.json.file.id;
  const uploadId = created.json.upload.id;
  const partSize = Number(created.json.upload.partSizeBytes);
  const totalParts = Number(created.json.upload.totalParts);
  const partNumbers = [];
  for (let index = 1; index <= totalParts; index += 1) partNumbers.push(index);
  const signed = await api("/api/v1/files/" + fileId + "/uploads/" + uploadId + "/parts", "POST", { partNumbers });
  if (signed.status !== 200 || signed.json === null) return { ok: false, detail: "parts " + String(signed.status) };
  for (const part of signed.json.parts) {
    const start = (Number(part.partNumber) - 1) * partSize;
    const slice = buffer.subarray(start, Math.min(start + partSize, buffer.byteLength));
    const put = await fetch(part.url, { method: "PUT", body: slice });
    if (!put.ok) return { ok: false, detail: "put " + String(put.status) };
  }
  const done = await api("/api/v1/files/" + fileId + "/uploads/" + uploadId + "/complete", "POST", { contentHash: hash });
  if (done.status !== 200) return { ok: false, detail: "complete " + String(done.status) + " " + done.text.slice(0, 120) };
  if (finalize === false) return { ok: true, fileId, detail: "complete 200（未定档 · 保持 draft）" };
  const detail = await api("/api/v1/files/" + fileId);
  const finalized = await api("/api/v1/files/" + fileId + "/finalize", "POST", { version: detail.json.version });
  return { ok: finalized.status === 200, fileId, detail: "finalize " + String(finalized.status) + " " + finalized.text.slice(0, 120) };
}
const dUpload = await uploadViaApi(changedTargetName, changedTargetBuf, "CAD图纸", task3Id);
check("④u0b 夹具：变更目标文件（docType=CAD图纸）分片直传 + 定档（final · 任务随定档锁定）", dUpload.ok === true, String(dUpload.detail));

// 第四条任务夹具（就地定档用例 · ④v）：一份未定档文件 —— 变更文件行不可选但行尾有「定档」入口。
const draftTaskTitle = "回放任务·变更前先定档";
const task4Res = await api("/api/v1/projects/" + projectId + "/tasks", "POST", { stageKey: "design", title: draftTaskTitle, ownerIds: [userRow.id], deliverableTypes: ["CAD图纸"] });
check("④v0 夹具：建第四条任务（含未定档文件 —— 就地定档用例）", task4Res.status === 201, String(task4Res.status) + " " + task4Res.text.slice(0, 140));
const task4Id = task4Res.json === null ? "" : task4Res.json.id;
const draftName = "回放-先定档-草图.txt";
const draftBuf = Buffer.from("LibiaoLink 回放先定档 v0 " + fixtureCode + String.fromCharCode(10), "utf8");
writeFileSync(join(fileDir, draftName), draftBuf);
// Push 255：本文件**不带成果类型**（doc_type 空，与业务真机口径一致）—— 变更后只能靠「所属任务」回写变更关联（R01 匹配不到）。
const draftUpload = await uploadViaApi(draftName, draftBuf, undefined, task4Id, false);
check("④v0b 夹具：未定档文件（不带成果类型）分片直传（不定档 · 任务保持未定档）", draftUpload.ok === true, String(draftUpload.detail));

// 第五条任务夹具（任务定档后变更用例 · ④w · 业务反馈「不是已经定档了吗 为什么变更申请里面还是未定档」）：
// 任务经定档端点置位（与抽屉开关同端点），文件保持 draft —— 变更申请里该文件应显示「已定档」、直接可变更。
const taskFinalizedTitle = "回放任务·任务定档后变更";
const task5Res = await api("/api/v1/projects/" + projectId + "/tasks", "POST", { stageKey: "design", title: taskFinalizedTitle, ownerIds: [userRow.id], deliverableTypes: ["CAD图纸"] });
check("④w0 夹具：建第五条任务（任务定档后变更用例）", task5Res.status === 201, String(task5Res.status) + " " + task5Res.text.slice(0, 140));
const task5Id = task5Res.json === null ? "" : task5Res.json.id;
const taskLockedName = "回放-任务定档后-目标.txt";
const taskLockedAfterName = "回放-任务定档后-变更后-v2.txt";
const taskLockedBuf = Buffer.from("LibiaoLink 回放任务定档后变更 v1 " + fixtureCode + String.fromCharCode(10), "utf8");
const taskLockedAfterBuf = Buffer.from("LibiaoLink 回放任务定档后变更 v2 " + fixtureCode + String.fromCharCode(10), "utf8");
writeFileSync(join(fileDir, taskLockedName), taskLockedBuf);
writeFileSync(join(fileDir, taskLockedAfterName), taskLockedAfterBuf);
const taskLockedUpload = await uploadViaApi(taskLockedName, taskLockedBuf, "CAD图纸", task5Id, false);
check("④w0b 夹具：未定档文件分片直传（file 保持 draft）", taskLockedUpload.ok === true, String(taskLockedUpload.detail));
const task5Finalize = await api("/api/v1/projects/" + projectId + "/tasks/" + task5Id + "/finalize", "POST", { version: 0 });
check("④w0c 夹具：任务经定档端点置位（任务已定档 · 文件仍为 draft —— 复现业务场景）", task5Finalize.status === 200, String(task5Finalize.status) + " " + task5Finalize.text.slice(0, 140));
const task5FileRow = (await db.query("select status from files where id = $1", [taskLockedUpload.fileId])).rows[0];
check("④w0d 夹具核对：任务已定档而文件状态确为 draft（不是场景写错）", task5FileRow !== undefined && task5FileRow.status === "draft", JSON.stringify(task5FileRow));

/** 抽屉局部截图（回放证据用：变更申请 / 变更记录两页）。 */
async function shotDrawerClip(name) {
  const box = await ev("(function(){var d=document.querySelector(" + j(DRAWER) + ");if(d===null){return null;}var r=d.getBoundingClientRect();return {x:Math.max(0,Math.round(r.left)),y:Math.max(0,Math.round(r.top)),width:Math.round(r.width),height:Math.round(r.height)};})()");
  if (box === null || box === undefined) return;
  const shot = await page.send("Page.captureScreenshot", { format: "png", clip: { x: box.x, y: box.y, width: box.width, height: box.height, scale: 1 } });
  writeFileSync(join(SCREENSHOT_DIR, name), Buffer.from(shot.data, "base64"));
  console.log("截图：" + join(SCREENSHOT_DIR, name));
}

/** 抽屉内点击（先把目标滚进可视区再量点，避免 ScrollArea 内按钮在视口外点空）。 */
async function clickScrolled(selector) {
  await ev("(function(){var b=document.querySelector(" + j(selector) + ");if(b!==null){b.scrollIntoView({block:" + j("center") + ",inline:" + j("nearest") + "});}return true;})()");
  await sleep(300);
  return await clickSelector(selector);
}
/** 聚焦 + 全选 + 输入（React 受控控件走 input 事件）。 */
async function fillField(selector, text) {
  await ev("(function(){var n=document.querySelector(" + j(selector) + ");if(n!==null){n.focus();n.select();}return true;})()");
  await sleep(150);
  await page.send("Input.insertText", { text });
  await sleep(250);
}

await page.send("Page.reload", { ignoreCache: true });
const row3Ready = await waitFor("(function(){var rows=document.querySelectorAll(" + j("[role=button]") + ");for(var i=0;i<rows.length;i++){if(rows[i].textContent.indexOf(" + j(changeTaskTitle) + ")>=0){return true;}}return false;})()", 20000);
if (row3Ready !== true) await bail("第三条任务行没渲染出来（抽屉页标签用例）");
await ev("(function(){var rows=document.querySelectorAll(" + j("[role=button]") + ");for(var i=0;i<rows.length;i++){if(rows[i].textContent.indexOf(" + j(changeTaskTitle) + ")>=0){rows[i].scrollIntoView({block:" + j("center") + ",inline:" + j("start") + "});return true;}}return false;})()");
await sleep(400);
const row3Point = await ev("(function(){var rows=document.querySelectorAll(" + j("[role=button]") + ");for(var i=0;i<rows.length;i++){if(rows[i].textContent.indexOf(" + j(changeTaskTitle) + ")>=0){var b=rows[i].getBoundingClientRect();return {x:Math.round(b.left+60),y:Math.round(b.top+b.height/2)};}}return null;})()");
if (row3Point === null || row3Point === undefined) await bail("第三条任务行坐标量不到");
await clickAt(row3Point);
const drawer3Open = await waitFor("document.querySelector(" + j(DRAWER) + ")!==null", 8000);
const tabsInfo = drawer3Open === true ? await ev("(function(){var bar=document.querySelector(" + j("[data-drawer-tabs=true]") + ");if(bar===null){return null;}var bs=bar.querySelectorAll(" + j("[data-drawer-tab]") + ");var out=[];for(var i=0;i<bs.length;i++){out.push({key:bs[i].getAttribute(" + j("data-drawer-tab") + "),label:bs[i].textContent.trim(),selected:bs[i].getAttribute(" + j("aria-selected") + ")});}return {count:bs.length,items:out,detailShown:document.querySelector(" + j("[data-drawer-file-item]") + ")!==null};})()") : null;
check("④u1 抽屉头部下出页标签导航栏（任务详情 / 变更申请 / 变更记录 三页 · 默认选中「任务详情」= 原内容在位）",
  tabsInfo !== null && tabsInfo !== undefined && tabsInfo.count === 3
  && tabsInfo.items[0].key === "detail" && tabsInfo.items[0].label === "任务详情" && tabsInfo.items[0].selected === "true"
  && tabsInfo.items[1].key === "change" && tabsInfo.items[1].label === "变更申请"
  && tabsInfo.items[2].key === "history" && tabsInfo.items[2].label === "变更记录"
  && tabsInfo.detailShown === true,
  JSON.stringify(tabsInfo));

const changeTabPoint = await clickScrolled("[data-drawer-tab=change]");
const changePageShown = await waitFor("(function(){return document.querySelector(" + j("[data-drawer-page=change]") + ")!==null&&document.querySelector(" + j("[data-drawer-file-item]") + ")==null;})()", 8000);
const changeFormInfo = changePageShown === true ? await ev("(function(){var p=document.querySelector(" + j("[data-drawer-page=change]") + ");if(p===null){return null;}var targets=p.querySelectorAll(" + j("[data-change-target]") + ");var out=[];for(var i=0;i<targets.length;i++){out.push({disabled:targets[i].disabled===true,text:targets[i].innerText});}var t=function(s){var n=p.querySelector(s);return n===null?null:n.textContent.trim();};return {targets:out,time:t(" + j("[data-change-time]") + "),stage:p.querySelector(" + j("[data-change-stage]") + ")!==null,content:p.querySelector(" + j("[data-change-reason]") + ")!==null,before:p.querySelector(" + j("[data-change-before]") + ")!==null,after:p.querySelector(" + j("[data-change-after]") + ")!==null,cause:p.querySelector(" + j("[data-change-cause]") + ")!==null,applicant:t(" + j("[data-change-applicant]") + "),version:t(" + j("[data-change-version]") + "),link:t(" + j("[data-change-link]") + "),pick:p.querySelector(" + j("[data-change-pick]") + ")!==null};})()") : null;
check("④u2 点「变更申请」= 切页（详情清单收起）+ A4-13 字段面在位（变更时间只读 / 变更阶段 / 变更文件 / 变更内容描述 / 变更前 / 变更后 / 变更原因 / 变更申请人 / 变更后文件版本 / 变更后文件 / 关联）",
  changeTabPoint === true && changePageShown === true && changeFormInfo !== null && changeFormInfo !== undefined
  && Array.isArray(changeFormInfo.targets) && changeFormInfo.targets.length === 1 && changeFormInfo.targets[0].disabled === false
  && String(changeFormInfo.targets[0].text).indexOf(changedTargetName) >= 0 && String(changeFormInfo.targets[0].text).indexOf("已定档") >= 0
  && changeFormInfo.time !== null && changeFormInfo.time !== "" && changeFormInfo.stage === true && changeFormInfo.content === true
  && changeFormInfo.before === true && changeFormInfo.after === true && changeFormInfo.cause === true
  && String(changeFormInfo.applicant).indexOf("潘兴") >= 0 && String(changeFormInfo.version).indexOf("版本") >= 0 && String(changeFormInfo.link).indexOf("系统") >= 0 && changeFormInfo.pick === true,
  JSON.stringify(changeFormInfo));
await shotDrawerClip("m4-07-drawer-change.png");

const submitNoTarget = await clickScrolled("[data-change-submit]");
const errNoTarget = await waitFor("(function(){var n=document.querySelector(" + j("[data-change-error]") + ");return n!==null&&n.textContent.indexOf(" + j("请选择变更文件") + ")>=0;})()", 6000);
const pickTarget = await clickScrolled("[data-change-target]");
const submitNoContent = await clickScrolled("[data-change-submit]");
const errNoContent = await waitFor("(function(){var n=document.querySelector(" + j("[data-change-error]") + ");return n!==null&&n.textContent.indexOf(" + j("请填写变更内容描述") + ")>=0;})()", 6000);
const contentText = "回放变更内容：图纸尺寸调整 " + fixtureCode;
await fillField("[data-change-reason]", contentText);
const submitNoFile = await clickScrolled("[data-change-submit]");
const errNoFile = await waitFor("(function(){var n=document.querySelector(" + j("[data-change-error]") + ");return n!==null&&n.textContent.indexOf(" + j("请选择变更后文件") + ")>=0;})()", 6000);
check("④u3 提交三道前拦（A4-13 提交校验）：未选变更文件「请选择变更文件」→ 未填变更内容描述「请填写变更内容描述」→ 未选变更后文件「请选择变更后文件」",
  submitNoTarget === true && errNoTarget === true && pickTarget === true && submitNoContent === true && errNoContent === true && submitNoFile === true && errNoFile === true,
  JSON.stringify({ noTarget: errNoTarget, noContent: errNoContent, noFile: errNoFile }));
const noChangeRowYet = (await db.query("select count(*)::int as c from change_requests where project_id = $1", [projectId])).rows[0].c;
check("④u3b 被拦下的提交没有落库（change_requests 0 行）", Number(noChangeRowYet) === 0, String(noChangeRowYet));

const causeText = "客户现场复测要求";
const beforeText = "调整前：旧尺寸";
const afterText = "调整后：新尺寸";
await fillField("[data-change-cause]", causeText);
await fillField("[data-change-before]", beforeText);
await fillField("[data-change-after]", afterText);
// ④u3c（Push 314 · 业务口径「这个变更要可以填图片」）：变更前 / 变更后各挂一张摘要附图（选图入口 → 贴图区直传文件库）；
// 等两张图都上传落定（贴图区各 1 张缩略图 + 无「上传中」标记 + 库面文件行在）再提交。
const changePhotoPickers = await ev("(function(){var b=document.querySelector(" + j("[data-field=change-before]") + ");var a=document.querySelector(" + j("[data-field=change-after]") + ");return {before:b!==null,after:a!==null};})()");
await setFileInput("[data-field=change-before]", filePngPath);
await setFileInput("[data-field=change-after]", filePng2Path);
const changePhotosSettled = await waitFor("(function(){var b=document.querySelector(" + j("[data-attachment-strip=change-before]") + ");var a=document.querySelector(" + j("[data-attachment-strip=change-after]") + ");if(b===null||a===null){return false;}if(b.querySelectorAll(" + j("[data-attachment-thumb]") + ").length!==1||a.querySelectorAll(" + j("[data-attachment-thumb]") + ").length!==1){return false;}return b.innerText.indexOf(" + j("上传中") + ")<0&&a.innerText.indexOf(" + j("上传中") + ")<0;})()", 30000);
const changeBeforeFileId = (await db.query("select id from files where project_id = $1 and task_id is null and name = $2 order by created_at desc limit 1", [projectId, filePngName])).rows[0]?.id ?? null;
const changeAfterFileId = (await db.query("select id from files where project_id = $1 and task_id is null and name = $2 order by created_at desc limit 1", [projectId, filePng2Name])).rows[0]?.id ?? null;
check("④u3c 变更「变更前 / 变更后」可填图（Push 314）：与日报同款贴图区（选图入口）各传一张真 PNG → 站内文件库落两条附件域记录 + 贴图区缩略图（上传中标记已清）",
  changePhotoPickers !== null && changePhotoPickers.before === true && changePhotoPickers.after === true && changePhotosSettled === true && changeBeforeFileId !== null && changeAfterFileId !== null && changeBeforeFileId !== changeAfterFileId,
  JSON.stringify({ pickers: changePhotoPickers, settled: changePhotosSettled, before: changeBeforeFileId, after: changeAfterFileId }));
await shotDrawerClip("m4-07-drawer-change-photos.png");
await setFileInput("[data-change-upload-input=true]", changeAfterPath);
const pickedName = await waitFor("(function(){var n=document.querySelector(" + j("[data-change-file]") + ");return n!==null&&n.textContent.indexOf(" + j(changeAfterName) + ")>=0;})()", 6000);
const expectedReason = contentText + "；变更原因：" + causeText;
const submitPoint = await clickScrolled("[data-change-submit]");
const changeLanded = await waitForAsync(async () => {
  const rows = (await db.query("select status from files where id = $1", [dUpload.fileId])).rows;
  return rows.length === 1 && rows[0].status === "changed";
}, 30000);
const changeRow = (await db.query("select id, reason, before_summary, after_summary, before_summary_file_ids, after_summary_file_ids, stage_key, status, applied_by from change_requests where project_id = $1", [projectId])).rows[0];
const dVersions = (await db.query("select seq, change_request_id, object_key from file_versions where file_id = $1 order by seq", [dUpload.fileId])).rows;
const dFileRow = (await db.query("select name from files where id = $1", [dUpload.fileId])).rows[0];
const task3Refs = (await db.query("select change_refs from tasks where id = $1", [task3Id])).rows[0].change_refs;
// Push 256「替换的效果」：完成变更 = 文件更名为变更选择的文件（base 名 + 扩展名全替换）；读面回捞更名前名称。
const dDetailApi = changeRow === undefined ? null : await api("/api/v1/change-requests/" + changeRow.id);
check("④u4 提交变更（申请即通过）：files.status=changed + 变更记录（内容+原因合并 / 前后摘要 / 阶段 design / status=applied / 申请人）+ 版本 v2 挂 change_request_id + R01 回写任务变更关联 + 替换效果（name/扩展名 = 变更选择：files.name 更名 + 新版本对象键 .pdf + 读面 filePreviousName = 更名前 + 摘要附图 before/after file id 落库）",
  pickedName === true && submitPoint === true && changeLanded === true
  && changeRow !== undefined && changeRow.reason === expectedReason && changeRow.before_summary === beforeText && changeRow.after_summary === afterText
  && Array.isArray(changeRow.before_summary_file_ids) && changeRow.before_summary_file_ids.length === 1 && changeRow.before_summary_file_ids[0] === changeBeforeFileId
  && Array.isArray(changeRow.after_summary_file_ids) && changeRow.after_summary_file_ids.length === 1 && changeRow.after_summary_file_ids[0] === changeAfterFileId
  && changeRow.stage_key === "design" && changeRow.status === "applied" && changeRow.applied_by === userRow.id
  && dVersions.length === 2 && Number(dVersions[1].seq) === 2 && dVersions[1].change_request_id === changeRow.id
  && String(dVersions[1].object_key).slice(-4) === ".pdf" && String(dVersions[0].object_key).slice(-4) === ".txt"
  && dFileRow !== undefined && dFileRow.name === changeAfterName
  && dDetailApi !== null && dDetailApi.status === 200 && dDetailApi.json.file.name === changeAfterName && dDetailApi.json.filePreviousName === changedTargetName
  && Array.isArray(dDetailApi.json.beforeSummaryFileIds) && dDetailApi.json.beforeSummaryFileIds[0] === changeBeforeFileId
  && Array.isArray(dDetailApi.json.afterSummaryFileIds) && dDetailApi.json.afterSummaryFileIds[0] === changeAfterFileId
  && Array.isArray(task3Refs) && task3Refs.indexOf(changeRow.id) >= 0,
  JSON.stringify({ change: { reason: changeRow === undefined ? null : changeRow.reason, stage: changeRow === undefined ? null : changeRow.stage_key }, file: dFileRow, keys: dVersions.map((v) => v.object_key), detail: dDetailApi === null ? null : { name: dDetailApi.json === null ? null : dDetailApi.json.file.name, prev: dDetailApi.json === null ? null : dDetailApi.json.filePreviousName }, refs: task3Refs }));
const doneShown = await waitFor("document.querySelector(" + j("[data-change-done]") + ")!==null", 15000);
check("④u5 提交成功 = 页面绿条「变更已提交生效」", doneShown === true, String(doneShown));

const backToDetail = await clickScrolled("[data-drawer-tab=detail]");
// Push 255（业务口径「文件显示 已变更 不如直接替换成变更后的啊 直接显示变更后添加的文件 不要显示已变更」）：
// 变更后清单行直接显示变更后的文件本身，不再挂「已变更」色签；Push 256：显示的就是 **变更选择的文件**（名称/扩展名已替换）。
const changedRowShown = await waitFor("(function(){var items=document.querySelectorAll(" + j("[data-drawer-file-item]") + ");for(var i=0;i<items.length;i++){if(items[i].textContent.indexOf(" + j(changeAfterName) + ")>=0&&items[i].textContent.indexOf(" + j("已变更") + ")<0){return true;}}return false;})()", 20000);
const changedRowText = changedRowShown === true ? await ev("(function(){var items=document.querySelectorAll(" + j("[data-drawer-file-item]") + ");for(var i=0;i<items.length;i++){if(items[i].textContent.indexOf(" + j(changeAfterName) + ")>=0){return items[i].innerText;}}return null;})()") : null;
const linkedShown = await waitFor("(function(){var d=document.querySelector(" + j(DRAWER) + ");return d!==null&&d.innerText.indexOf(" + j(contentText) + ")>=0;})()", 20000);
check("④u6 回「任务详情」：文件行直接显示变更后的文件（Push 255：不再挂「已变更」签；Push 256：名称/扩展名 = 变更选择的文件）+ 「变更关联」行回流（整表重取）",
  backToDetail === true && changedRowShown === true && linkedShown === true,
  JSON.stringify({ back: backToDetail, row: changedRowText === null ? null : String(changedRowText).slice(0, 120), linked: linkedShown }));

// ④u6b（Push 256 · 业务口径「变更关联点击后要显示一个这样的内容在中间」）：点「变更关联」行 → 屏幕中央弹「变更管理」详情弹窗
// （对齐源表版式：来自 ▦变更管理 + 大日期 + 13 行明细）。选择器限定抽屉内（任务表「变更关联」列同一 data 标记 —— 表格 chip 在抽屉遮罩之后）。
const linkPoint = await clickScrolled(DRAWER + " [data-change-link-open]");
// 等详情取回（大日期行 = 详情就绪标记；加载中只有「加载中…」）再读行。
const modalShown = await waitFor("(function(){var m=document.querySelector(" + j("[data-change-modal]") + ");return m!==null&&m.querySelector(" + j("[data-change-modal-date]") + ")!==null;})()", 15000);
const modalInfo = modalShown === true ? await ev("(function(){var m=document.querySelector(" + j("[data-change-modal]") + ");if(m===null){return null;}var row=function(k){var n=m.querySelector(\"[data-change-modal-row=\\\"\"+k+\"\\\"]\");return n===null?null:n.innerText;};var h=m.querySelector(\"header\");var d=m.querySelector(" + j("[data-change-modal-date]") + ");var dt=m.querySelector(" + j("[data-change-modal-doc-type]") + ");return {head:h===null?null:h.innerText,date:d===null?null:d.textContent.trim(),docType:dt===null?null:dt.textContent.trim(),stage:row(\"stage\"),content:row(\"content\"),cause:row(\"cause\"),applicant:row(\"applicant\"),writer:row(\"writer\"),version:row(\"version\"),file:row(\"after-file\"),link:row(\"links\"),card:m.querySelector(" + j("[data-change-modal-file-card]") + ")!==null};})()") : null;
// ④u6b2（Push 314）：弹窗「变更前 / 变更后」行 = 摘要文本 + 摘要附图缩略图（各 1 张；懒取签名后出图）。
const modalSummaryThumbs = await waitFor("(function(){var m=document.querySelector(" + j("[data-change-modal]") + ");if(m===null){return false;}return m.querySelectorAll(" + j("[data-change-modal-row=before] [data-attachment-thumb]") + ").length===1&&m.querySelectorAll(" + j("[data-change-modal-row=after] [data-attachment-thumb]") + ").length===1;})()", 20000);
check("④u6b2 变更管理弹窗「变更前 / 变更后」出摘要附图缩略图（各 1 张 · Push 314）", modalSummaryThumbs === true, String(modalSummaryThumbs));
// ④u6b3 / ④u6b4（Push 350 · 业务反馈「图片怎么能在弹窗后面 是bug」）：弹窗内缩略图点开的大图预览必须浮于弹窗之上
// （修复前 PhotoPreview 硬编码 z-[60] < 弹窗 z-[70]，大图被压在弹窗后面）；Esc 先关预览、弹窗仍在（弹窗 Esc 让位）。
const modalThumbPoint = await clickScrolled("[data-change-modal-row=before] [data-attachment-thumb]");
const modalThumbPreviewShown = await waitFor("document.querySelector(" + j("[data-photo-preview]") + ")!==null&&document.querySelector(" + j("[data-change-modal]") + ")!==null", 20000);
const modalThumbPreviewLift = modalThumbPreviewShown === true ? await ev("(function(){var p=document.querySelector(" + j("[data-photo-preview]") + ");var m=document.querySelector(" + j("[data-change-modal]") + ");if(p===null||m===null){return null;}var pz=Number(getComputedStyle(p).zIndex);var mz=Number(getComputedStyle(m).zIndex);var r=p.getBoundingClientRect();var el=document.elementFromPoint(Math.round(r.left+r.width/2),Math.round(r.top+r.height/2));return {pz:pz,mz:mz,onTop:p.contains(el)};})()") : null;
check("④u6b3 弹窗「变更前」缩略图点开 = 大图预览浮于弹窗之上（z 压过弹窗 · elementFromPoint 命中预览层 · Push 350）",
  modalThumbPoint === true && modalThumbPreviewShown === true && modalThumbPreviewLift !== null && modalThumbPreviewLift !== undefined
  && modalThumbPreviewLift.pz > modalThumbPreviewLift.mz && modalThumbPreviewLift.onTop === true,
  JSON.stringify(modalThumbPreviewLift));
const shotModalThumbPreview = await page.send("Page.captureScreenshot", { format: "png" });
writeFileSync(join(SCREENSHOT_DIR, "m4-07-modal-thumb-preview.png"), Buffer.from(shotModalThumbPreview.data, "base64"));
console.log("截图：" + join(SCREENSHOT_DIR, "m4-07-modal-thumb-preview.png"));
await pressKey("Escape", "Escape", 27);
const modalThumbPreviewClosed = await waitFor("(function(){return document.querySelector(" + j("[data-photo-preview]") + ")===null&&document.querySelector(" + j("[data-change-modal]") + ")!==null;})()", 5000);
check("④u6b4 关缩略图预览（Esc）= 预览浮层关、变更管理弹窗仍在（Esc 先关内层）", modalThumbPreviewClosed === true, String(modalThumbPreviewClosed));

check("④u6b 点「变更关联」= 居中「变更管理」详情弹窗（来自 ▦变更管理 / 大日期 / 变更文件=输出成果文件类型 CAD图纸 / 阶段=设计开发 / 内容+原因 / 申请人=潘兴 / 变更后文件版本=变更名（v2） / 文件卡 / 关联=本任务）",
  linkPoint === true && modalShown === true && modalInfo !== null && modalInfo !== undefined
  && String(modalInfo.head).indexOf("来自") >= 0 && String(modalInfo.head).indexOf("变更管理") >= 0 && String(modalInfo.date).indexOf("/") >= 0
  && String(modalInfo.docType) === "CAD图纸"
  && String(modalInfo.stage).indexOf("设计开发") >= 0 && String(modalInfo.content).indexOf(contentText) >= 0 && String(modalInfo.cause).indexOf(causeText) >= 0
  && String(modalInfo.applicant).indexOf("潘兴") >= 0 && String(modalInfo.writer).indexOf("潘兴") >= 0
  && String(modalInfo.version).indexOf(changeAfterName) >= 0 && String(modalInfo.version).indexOf("v2") >= 0
  && modalInfo.card === true && String(modalInfo.file).indexOf(changeAfterName) >= 0 && String(modalInfo.link).indexOf(changeTaskTitle) >= 0,
  JSON.stringify(modalInfo));
const shotChangeModal = await page.send("Page.captureScreenshot", { format: "png" });
writeFileSync(join(SCREENSHOT_DIR, "m4-07-drawer-change-modal.png"), Buffer.from(shotChangeModal.data, "base64"));
console.log("截图：" + join(SCREENSHOT_DIR, "m4-07-drawer-change-modal.png"));

// ④u6c（Push 256 续 · 业务口径「这两个要可以点击 点击文件预览」）：点弹窗「变更后文件」卡 → 弹内版本态预览（z 高于弹窗）；
// Esc 先关预览浮层（弹窗仍在 —— 「Esc 先关内层」两层）。
const modalCardPoint = await clickScrolled("[data-change-modal] [data-change-modal-file-open]");
const modalPreviewShown = await waitFor("document.querySelector(" + j("[data-file-preview]") + ")!==null&&document.querySelector(" + j("[data-change-modal]") + ")!==null", 25000);
const modalPreviewInfo = modalPreviewShown === true ? await ev("(function(){var el=document.querySelector(" + j("[data-file-preview]") + ");if(el===null){return null;}return {kind:el.getAttribute(" + j("data-file-preview-kind") + "),oo:el.querySelector(" + j("[data-oo-status]") + ")!==null,frame:el.querySelector(" + j("[data-file-preview-frame]") + ")!==null,caption:el.innerText.slice(0,120)};})()") : null;
check("④u6c 弹窗「变更后文件」卡可点击 = 预览（查看器外壳 / iframe 在位 + 标题 = 变更选择的文件名；PDF 自 2026-10-08 统一 ONLYOFFICE）",
  modalCardPoint === true && modalPreviewShown === true && modalPreviewInfo !== null && modalPreviewInfo !== undefined
  && (modalPreviewInfo.oo === true || modalPreviewInfo.frame === true) && String(modalPreviewInfo.caption).indexOf(changeAfterName) >= 0,
  JSON.stringify(modalPreviewInfo));
// 关弹内预览：先 Esc；若按键被 ONLYOFFICE 编辑器 iframe 吞掉（DocServer 在线时焦点在编辑器内）→ 点遮罩关闭。
// 两种关法都要求「弹窗 + 抽屉仍在」（Esc 先关内层）。
await pressKey("Escape", "Escape", 27);
let modalKeptAfterEsc = await waitFor("(function(){return document.querySelector(" + j("[data-file-preview]") + ")===null&&document.querySelector(" + j("[data-change-modal]") + ")!==null&&document.querySelector(" + j(DRAWER) + ")!==null;})()", 2500);
let modalPreviewClosedBy = modalKeptAfterEsc === true ? "esc" : "backdrop";
if (modalKeptAfterEsc !== true) {
  // 点浮层左上角空白（遮罩区）——避开居中查看器自身的 stopPropagation。
  const backdropPoint = await ev("(function(){var el=document.querySelector(" + j("[data-file-preview]") + ");if(el===null){return null;}var r=el.getBoundingClientRect();return {x:Math.round(r.left+12),y:Math.round(r.top+12)};})()");
  if (backdropPoint !== null && backdropPoint !== undefined) {
    await clickAt(backdropPoint);
  }
  modalKeptAfterEsc = await waitFor("(function(){return document.querySelector(" + j("[data-file-preview]") + ")===null&&document.querySelector(" + j("[data-change-modal]") + ")!==null&&document.querySelector(" + j(DRAWER) + ")!==null;})()", 8000);
}
check("④u6d 关弹内预览（Esc；ONLYOFFICE 编辑器持焦吞键时点遮罩）= 变更管理弹窗 + 抽屉都仍在（Esc 先关内层）",
  modalKeptAfterEsc === true, JSON.stringify({ closedBy: modalPreviewClosedBy }));

// ④u6e Esc 再关弹窗本身（抽屉「任务详情」仍在）；随后重开弹窗验证「关联」口径。
await pressKey("Escape", "Escape", 27);
const modalClosed = await waitFor("(function(){return document.querySelector(" + j("[data-change-modal]") + ")===null&&document.querySelector(" + j(DRAWER) + ")!==null;})()", 8000);
check("④u6e Esc 只关弹窗（抽屉「任务详情」仍在 —— 「Esc 先关内层」）", modalClosed === true, String(modalClosed));
const linkPoint2 = await clickScrolled(DRAWER + " [data-change-link-open]");
const modalShown2 = await waitFor("document.querySelector(" + j("[data-change-modal]") + ")!==null", 12000);
const linkedPoint = await clickScrolled("[data-change-modal] [data-change-modal-link-open]");
const linkedBackToDrawer = await waitFor("(function(){return document.querySelector(" + j("[data-change-modal]") + ")===null&&document.querySelector(" + j(DRAWER) + ")!==null;})()", 8000);
check("④u6f 弹窗「关联」可点击（点击布局定档抽屉显示）：点关联 = 关弹窗露出回写任务抽屉（抽屉内 任务详情 仍在）",
  linkPoint2 === true && modalShown2 === true && linkedPoint === true && linkedBackToDrawer === true,
  JSON.stringify({ reopen: modalShown2, link: linkedPoint, back: linkedBackToDrawer }));

// ④u6g（Push 256 续 · 任务表口径）：关抽屉 → 点任务表行内「变更关联」列 chip → 同一弹窗（表格行的 stopPropagation 不连带开抽屉）；
// 点「关联」→ 选中该行开抽屉（「点击布局定档抽屉显示」）。
await pressKey("Escape", "Escape", 27);
await waitFor("document.querySelector(" + j(DRAWER) + ")===null", 8000);
const boardChipPoint = await clickScrolled("[data-change-link-open]");
const boardModalShown = await waitFor("document.querySelector(" + j("[data-change-modal]") + ")!==null&&document.querySelector(" + j(DRAWER) + ")==null", 12000);
const boardModalInfo = boardModalShown === true ? await ev("(function(){var m=document.querySelector(" + j("[data-change-modal]") + ");if(m===null){return null;}var r=m.querySelector(\"[data-change-modal-row=\\\"links\\\"]\");return {link:r===null?null:r.innerText};})()") : null;
check("④u6g 任务表「变更关联」列 chip 可点击 = 同一「变更管理」弹窗（未连带开抽屉）；关联行 = 本任务",
  boardChipPoint === true && boardModalShown === true && boardModalInfo !== null && boardModalInfo !== undefined && String(boardModalInfo.link).indexOf(changeTaskTitle) >= 0,
  JSON.stringify(boardModalInfo));
const boardLinkedPoint = await clickScrolled("[data-change-modal] [data-change-modal-link-open]");
const boardDrawerShown = await waitFor("(function(){var d=document.querySelector(" + j(DRAWER) + ");return d!==null&&d.innerText.indexOf(" + j(changeTaskTitle) + ")>=0;})()", 10000);
check("④u6h 表格弹窗点「关联」= 打开该任务抽屉（布局定档抽屉显示 · 标题 = 关联任务）",
  boardLinkedPoint === true && boardDrawerShown === true,
  JSON.stringify({ link: boardLinkedPoint, drawer: boardDrawerShown }));
// 抽屉保持打开（表格路径开的就是本任务抽屉 · 任务详情页）——下一段 ④u7 直接点「变更记录」页签继续。

const historyTabPoint = await clickScrolled("[data-drawer-tab=history]");
const historyShown = await waitFor("(function(){var p=document.querySelector(" + j("[data-drawer-page=history]") + ");return p!==null&&p.querySelectorAll(" + j("[data-change-item]") + ").length===1;})()", 10000);
const historyItemInfo = historyShown === true ? await ev("(function(){var p=document.querySelector(" + j("[data-drawer-page=history]") + ");var it=p.querySelector(" + j("[data-change-item]") + ");if(it===null){return null;}var b=it.querySelector(" + j("[data-change-item-open]") + ");return {text:it.innerText,open:b===null?null:b.textContent.trim()};})()") : null;
check("④u7 点「变更记录」= 本任务一条变更（日期签 + 短原因 · 最新在前 · 「详情」入口）",
  historyTabPoint === true && historyShown === true && historyItemInfo !== null && historyItemInfo !== undefined
  && String(historyItemInfo.text).indexOf(contentText) >= 0 && String(historyItemInfo.text).indexOf("变更") >= 0 && historyItemInfo.open === "详情",
  JSON.stringify(historyItemInfo));

// ④u7b（Push 255 · 业务口径「变更记录也要显示 之前是什么文件 这次是什么文件」；Push 256 起更名口径）：
// 列表行直接出「变更前 v1 → 变更后 v2」两行，各自带「预览 / 下载」入口（不必先点「详情」）——
// 变更前 = **更名前名称**（filePreviousName）+ v1；变更后 = **变更选择的文件名**（含新扩展名）+ v2。
const historyFilesShown = await waitFor("(function(){var f=document.querySelector(" + j("[data-change-item-files]") + ");if(f===null){return false;}var b=f.querySelector(" + j("[data-change-file=before]") + ");var a=f.querySelector(" + j("[data-change-file=after]") + ");if(b===null||a===null){return false;}return b.innerText.indexOf(" + j("变更前") + ")>=0&&b.innerText.indexOf(" + j(changedTargetName) + ")>=0&&b.innerText.indexOf(" + j(changeAfterName) + ")<0&&b.innerText.indexOf(" + j("v1") + ")>=0&&a.innerText.indexOf(" + j("变更后") + ")>=0&&a.innerText.indexOf(" + j(changeAfterName) + ")>=0&&a.innerText.indexOf(" + j("v2") + ")>=0&&b.querySelector(" + j("[data-change-preview=before]") + ")!==null&&b.querySelector(" + j("[data-change-download=before]") + ")!==null&&a.querySelector(" + j("[data-change-preview=after]") + ")!==null&&a.querySelector(" + j("[data-change-download=after]") + ")!==null;})()", 15000);
const historyFilesText = historyFilesShown === true ? await ev("(function(){var f=document.querySelector(" + j("[data-change-item-files]") + ");return f===null?null:f.innerText;})()") : null;
check("④u7b 变更记录行显示「变更前 v1（更名前名称）→ 变更后 v2（变更选择的文件名）」+ 各自「预览 / 下载」入口（进页即取，不必先点详情）",
  historyFilesShown === true, JSON.stringify({ shown: historyFilesShown, text: historyFilesText === null ? null : String(historyFilesText).slice(0, 200) }));

const detailOpenPoint = await clickScrolled("[data-change-item-open]");
// 变更后文件 = 目标文件本体（变更 = 同一文件的新版本）；Push 256：更名后读面 file.name = 变更选择的文件名。
const itemDetailShown = await waitFor("(function(){var d=document.querySelector(" + j("[data-change-item-detail]") + ");return d!==null&&d.innerText.indexOf(" + j(changeAfterName) + ")>=0&&d.innerText.indexOf(" + j("v2") + ")>=0;})()", 10000);
const itemDetailText = await ev("(function(){var d=document.querySelector(" + j("[data-change-item-detail]") + ");return d===null?" + j("") + ":d.innerText;})()");
const historyText = await ev("(function(){var p=document.querySelector(" + j("[data-drawer-page=history]") + ");return p===null?" + j("") + ":p.innerText;})()");
check("④u8 点「详情」按需取全文（13 列读面）：变更后文件 + 版本 v2 + 变更阶段（设计开发）+ 原因全文 + 前后摘要 + 申请人（潘兴）+ 审批状态（已通过）",
  detailOpenPoint === true && itemDetailShown === true
  && String(itemDetailText).indexOf(changeAfterName) >= 0 && String(itemDetailText).indexOf("v2") >= 0 && String(itemDetailText).indexOf("设计开发") >= 0
  && String(itemDetailText).indexOf(expectedReason) >= 0 && String(itemDetailText).indexOf(beforeText) >= 0 && String(itemDetailText).indexOf(afterText) >= 0
  && String(itemDetailText).indexOf("潘兴") >= 0 && String(itemDetailText).indexOf("已通过") >= 0,
  JSON.stringify({ clicked: detailOpenPoint, shown: itemDetailShown, detail: String(itemDetailText).slice(0, 220), page: String(historyText).slice(0, 120) }));
await shotDrawerClip("m4-07-drawer-history.png");

// ④u8d（Push 314）：展开的变更详情里「变更前 / 变更后」摘要附图 = 各 1 张缩略图（懒取预览签名后出图）。
const historySummaryThumbs = await waitFor("(function(){var p=document.querySelector(" + j("[data-drawer-page=history]") + ");if(p===null){return false;}return p.querySelectorAll(" + j("[data-change-item-detail] [data-attachment-strip=change-before] [data-attachment-thumb]") + ").length===1&&p.querySelectorAll(" + j("[data-change-item-detail] [data-attachment-strip=change-after] [data-attachment-thumb]") + ").length===1;})()", 20000);
check("④u8d 变更记录详情「变更前 / 变更后」出摘要附图缩略图（各 1 张 · Push 314）", historySummaryThumbs === true, String(historySummaryThumbs));

// ④u8b（Push 255 · 业务口径「文件可以预览在变更里面」）：变更记录里的「变更前」文件可预览 —— 版本态预览（A4-06 历史版本）；
// 点「预览」→ 查看器浮层打开且抽屉仍在；Esc 先关浮层、抽屉（变更记录页）仍在。
const beforePreviewPoint = await clickScrolled("[data-change-preview=before]");
const beforePreviewShown = await waitFor("document.querySelector(" + j("[data-file-preview]") + ")!==null&&document.querySelector(" + j("[data-drawer-page=history]") + ")!==null", 25000);
const beforePreviewInfo = beforePreviewShown === true ? await ev("(function(){var el=document.querySelector(" + j("[data-file-preview]") + ");if(el===null){return null;}return {open:true,kind:el.getAttribute(" + j("data-file-preview-kind") + "),caption:el.innerText.slice(0,120)};})()") : null;
check("④u8b 变更记录「变更前」版本可预览（版本态预览浮层打开 + 变更记录页仍在）",
  beforePreviewPoint === true && beforePreviewShown === true && beforePreviewInfo !== null && beforePreviewInfo !== undefined && String(beforePreviewInfo.caption).indexOf(changedTargetName) >= 0,
  JSON.stringify(beforePreviewInfo));
await pressKey("Escape", "Escape", 27);
let beforePreviewClosed = await waitFor("(function(){return document.querySelector(" + j("[data-file-preview]") + ")===null&&document.querySelector(" + j(DRAWER) + ")!==null;})()", 2500);
if (beforePreviewClosed !== true) {
  // DocServer 在线时 ONLYOFFICE 编辑器 iframe 持焦会吞 Esc —— 回退点遮罩左上角空白（两种关法都要求抽屉仍在）。
  const beforeBackdropPoint = await ev("(function(){var el=document.querySelector(" + j("[data-file-preview]") + ");if(el===null){return null;}var r=el.getBoundingClientRect();return {x:Math.round(r.left+12),y:Math.round(r.top+12)};})()");
  if (beforeBackdropPoint !== null && beforeBackdropPoint !== undefined) {
    await clickAt(beforeBackdropPoint);
  }
  beforePreviewClosed = await waitFor("(function(){return document.querySelector(" + j("[data-file-preview]") + ")===null&&document.querySelector(" + j(DRAWER) + ")!==null;})()", 8000);
}
check("④u8c 关预览浮层（Esc；编辑器持焦时点遮罩）= 变更记录页仍在（「Esc 先关内层」）", beforePreviewClosed === true, String(beforePreviewClosed));

// ④u8d（Push 256 · 业务口径「变更后文件的名字后后缀要用变更选择的 不然都不能预览」）：变更后版本按**新扩展名**预览 ——
// v2 对象键 = .pdf → 预览通道 = pdf（浏览器内置查看器 iframe；不再因沿用旧扩展名被 ONLYOFFICE 判「扩展名不一致」拒开）；
// 浮层标题 = 变更选择的文件名（当前名 + v2 扩展名）。Esc 关浮层后抽屉仍在。
const afterPreviewPoint = await clickScrolled("[data-change-preview=after]");
const afterPreviewShown = await waitFor("document.querySelector(" + j("[data-file-preview]") + ")!==null&&document.querySelector(" + j("[data-drawer-page=history]") + ")!==null", 25000);
const afterPreviewInfo = afterPreviewShown === true ? await ev("(function(){var el=document.querySelector(" + j("[data-file-preview]") + ");if(el===null){return null;}return {open:true,kind:el.getAttribute(" + j("data-file-preview-kind") + "),oo:el.querySelector(" + j("[data-oo-status]") + ")!==null,frame:el.querySelector(" + j("[data-file-preview-frame]") + ")!==null,caption:el.innerText.slice(0,120)};})()") : null;
check("④u8d 变更记录「变更后」版本按新扩展名预览（查看器外壳 / iframe 在位 + 标题 = 变更选择的文件名 .pdf —— 替换效果生效，不再被「扩展名不一致」拒开）",
  afterPreviewPoint === true && afterPreviewShown === true && afterPreviewInfo !== null && afterPreviewInfo !== undefined
  && (afterPreviewInfo.oo === true || afterPreviewInfo.frame === true) && String(afterPreviewInfo.caption).indexOf(changeAfterName) >= 0,
  JSON.stringify(afterPreviewInfo));
await pressKey("Escape", "Escape", 27);
let afterPreviewClosed = await waitFor("(function(){return document.querySelector(" + j("[data-file-preview]") + ")===null&&document.querySelector(" + j(DRAWER) + ")!==null;})()", 2500);
if (afterPreviewClosed !== true) {
  const afterBackdropPoint = await ev("(function(){var el=document.querySelector(" + j("[data-file-preview]") + ");if(el===null){return null;}var r=el.getBoundingClientRect();return {x:Math.round(r.left+12),y:Math.round(r.top+12)};})()");
  if (afterBackdropPoint !== null && afterBackdropPoint !== undefined) {
    await clickAt(afterBackdropPoint);
  }
  afterPreviewClosed = await waitFor("(function(){return document.querySelector(" + j("[data-file-preview]") + ")===null&&document.querySelector(" + j(DRAWER) + ")!==null;})()", 8000);
}
check("④u8e 关「变更后」预览浮层（Esc；编辑器持焦时点遮罩）= 变更记录页仍在", afterPreviewClosed === true, String(afterPreviewClosed));

// ---------- ④v 「变更文件」就地定档（Push 254 续 · 业务反馈「这个选择不了啊」）----------
// 业务口径：未定档文件不能直接变更（A4-13 前置门）—— 但页面不能死路：行尾「定档」→ 就地二次确认 → 定档后随即可选。
await pressKey("Escape", "Escape", 27);
await waitFor("document.querySelector(" + j(DRAWER) + ")===null", 8000);
const row4Ready = await waitFor("(function(){var rows=document.querySelectorAll(" + j("[role=button]") + ");for(var i=0;i<rows.length;i++){if(rows[i].textContent.indexOf(" + j(draftTaskTitle) + ")>=0){return true;}}return false;})()", 20000);
if (row4Ready !== true) await bail("第四条任务行没渲染出来（就地定档用例）");
await ev("(function(){var rows=document.querySelectorAll(" + j("[role=button]") + ");for(var i=0;i<rows.length;i++){if(rows[i].textContent.indexOf(" + j(draftTaskTitle) + ")>=0){rows[i].scrollIntoView({block:" + j("center") + ",inline:" + j("start") + "});return true;}}return false;})()");
await sleep(400);
const row4Point = await ev("(function(){var rows=document.querySelectorAll(" + j("[role=button]") + ");for(var i=0;i<rows.length;i++){if(rows[i].textContent.indexOf(" + j(draftTaskTitle) + ")>=0){var b=rows[i].getBoundingClientRect();return {x:Math.round(b.left+60),y:Math.round(b.top+b.height/2)};}}return null;})()");
if (row4Point === null || row4Point === undefined) await bail("第四条任务行坐标量不到");
await clickAt(row4Point);
const drawer4Open = await waitFor("document.querySelector(" + j(DRAWER) + ")!==null", 8000);
const changeTabPoint4 = await clickScrolled("[data-drawer-tab=change]");
const blockedShown = await waitFor("(function(){var p=document.querySelector(" + j("[data-drawer-page=change]") + ");if(p===null){return false;}var t=p.querySelector(" + j("[data-change-target]") + ");var f=p.querySelector(" + j("[data-change-finalize]") + ");var h=p.querySelector(" + j("[data-change-none-hint]") + ");return t!==null&&t.disabled===true&&f!==null&&h!==null;})()", 10000);
const blockedInfo = blockedShown === true ? await ev("(function(){var p=document.querySelector(" + j("[data-drawer-page=change]") + ");if(p===null){return null;}var t=p.querySelector(" + j("[data-change-target]") + ");var f=p.querySelector(" + j("[data-change-finalize]") + ");var h=p.querySelector(" + j("[data-change-none-hint]") + ");return {disabled:t===null?null:t.disabled,text:t===null?null:t.innerText,finalize:f===null?null:f.textContent.trim(),hint:h===null?null:h.textContent};})()") : null;
check("④v1 未定档任务：变更文件行不可选（未定档 · 不可变更）+ 行尾「定档」入口 + 空态指引（不再死路）",
  drawer4Open === true && changeTabPoint4 === true && blockedInfo !== null && blockedInfo !== undefined
  && blockedInfo.disabled === true && String(blockedInfo.text).indexOf(draftName) >= 0 && String(blockedInfo.text).indexOf("未定档") >= 0 && String(blockedInfo.text).indexOf("不可变更") >= 0
  && blockedInfo.finalize === "定档" && String(blockedInfo.hint).indexOf("定档后即可发起变更") >= 0,
  JSON.stringify(blockedInfo));

const finalizeOpenPoint = await clickScrolled("[data-change-finalize]");
const draftFinalizeConfirm = await waitFor("(function(){var n=document.querySelector(" + j("[data-change-finalize-confirm]") + ");return n!==null&&n.textContent.indexOf(" + j("确定定档该文件") + ")>=0&&n.textContent.indexOf(" + j("任务一并锁定") + ")>=0;})()", 6000);
const confirmCancel = await clickScrolled("[data-change-finalize-cancel]");
await shotDrawerClip("m4-07-drawer-finalize-inline.png");
const confirmGone = await waitFor("document.querySelector(" + j("[data-change-finalize-confirm]") + ")==null", 6000);
check("④v2 点「定档」= 就地二次确认（锁版 + 任务一并锁定提示；可取消）",
  finalizeOpenPoint === true && draftFinalizeConfirm === true && confirmCancel === true && confirmGone === true,
  JSON.stringify({ open: finalizeOpenPoint, confirm: draftFinalizeConfirm, cancel: confirmCancel, gone: confirmGone }));

await clickScrolled("[data-change-finalize]");
const finalizeOkPoint = await clickScrolled("[data-change-finalize-ok]");
const finalizedRow = await waitFor("(function(){var p=document.querySelector(" + j("[data-drawer-page=change]") + ");if(p===null){return false;}var t=p.querySelector(" + j("[data-change-target]") + ");var done=p.querySelector(" + j("[data-change-finalize-done]") + ");return t!==null&&t.disabled!==true&&t.innerText.indexOf(" + j("已定档") + ")>=0&&t.getAttribute(" + j("aria-pressed") + ")===" + j("true") + "&&done!==null;})()", 20000);
const draftDb = (await db.query("select status from files where id = $1", [draftUpload.fileId])).rows[0];
const task4Row = (await db.query("select finalized_at is not null as locked from tasks where id = $1", [task4Id])).rows[0];
check("④v3 确认定档：行转「已定档」随即可选（自动选中 + 绿字指引）+ 写面 files.status=final / 任务随定档锁定",
  finalizeOkPoint === true && finalizedRow === true
  && draftDb !== undefined && draftDb.status === "final"
  && task4Row !== undefined && task4Row.locked === true,
  JSON.stringify({ row: finalizedRow, db: draftDb, task: task4Row }));

// ④v4（Push 255 · 业务反馈「同时相关的关联也没有显示啊」）：变更文件**不带成果类型**（doc_type 空，R01 匹配不到任何任务）——
// 变更仍必须回写「变更文件所属任务」（task4 由抽屉内变更），任务「变更关联 / 变更记录」不再空白。
const noDocAfterName = "回放-先定档-变更后-v2.txt";
const noDocAfterBuf = Buffer.from("LibiaoLink 回放先定档变更后 v2 " + fixtureCode + String.fromCharCode(10), "utf8");
writeFileSync(join(fileDir, noDocAfterName), noDocAfterBuf);
const noDocContent = "回放变更内容：无成果类型文件变更 " + fixtureCode;
await fillField("[data-change-reason]", noDocContent);
await setFileInput("[data-change-upload-input=true]", join(fileDir, noDocAfterName));
const noDocPicked = await waitFor("(function(){var n=document.querySelector(" + j("[data-change-file]") + ");return n!==null&&n.textContent.indexOf(" + j(noDocAfterName) + ")>=0;})()", 6000);
const noDocSubmit = await clickScrolled("[data-change-submit]");
const noDocLanded = await waitForAsync(async () => {
  const rows = (await db.query("select status from files where id = $1", [draftUpload.fileId])).rows;
  return rows.length === 1 && rows[0].status === "changed";
}, 30000);
const noDocChange = (await db.query("select id, reason, stage_key, status from change_requests where project_id = $1 order by applied_at desc limit 1", [projectId])).rows[0];
const noDocFileRow = (await db.query("select doc_type from files where id = $1", [draftUpload.fileId])).rows[0];
const task4Refs = (await db.query("select change_refs from tasks where id = $1", [task4Id])).rows[0].change_refs;
check("④v4 无成果类型文件的变更（doc_type 空 · R01 零匹配）→ 所属任务 change_refs 直接回写（变更关联 / 变更记录不再空白）",
  noDocPicked === true && noDocSubmit === true && noDocLanded === true
  && noDocFileRow !== undefined && noDocFileRow.doc_type === null
  && noDocChange !== undefined && noDocChange.reason === noDocContent && noDocChange.status === "applied"
  && Array.isArray(task4Refs) && task4Refs.indexOf(noDocChange.id) >= 0,
  JSON.stringify({ change: noDocChange === undefined ? null : noDocChange, file: noDocFileRow, refs: task4Refs }));

// ④v5（Push 256 续 · 业务口径「变更文件就是输出文件成果这个类型」）：无成果类型文件（doc_type 空）的变更 ——
// 弹窗「变更文件」行回退显示任务「输出成果文件」类型（CAD图纸），不再是「—」；「变更后文件」卡 = 变更选择的文件名（替换效果同口径）。
const v5Tab = await clickScrolled("[data-drawer-tab=detail]");
// 抽屉「变更关联」可能有多条变更（R01 会把兄弟任务的变更也回写进来）——按短原因文本选中本用例那条（无成果类型变更）。
const v5ChipReady = await waitFor("(function(){var bs=document.querySelectorAll(" + j(DRAWER + " [data-change-link-open]") + ");for(var i=0;i<bs.length;i++){if(bs[i].innerText.indexOf(" + j(noDocContent) + ")>=0){return true;}}return false;})()", 15000);
const v5Link = await ev("(function(){var bs=document.querySelectorAll(" + j(DRAWER + " [data-change-link-open]") + ");for(var i=0;i<bs.length;i++){if(bs[i].innerText.indexOf(" + j(noDocContent) + ")>=0){bs[i].click();return true;}}return false;})()");
const v5Modal = await waitFor("(function(){var m=document.querySelector(" + j("[data-change-modal]") + ");return m!==null&&m.querySelector(" + j("[data-change-modal-date]") + ")!==null;})()", 15000);
const v5Info = v5Modal === true ? await ev("(function(){var m=document.querySelector(" + j("[data-change-modal]") + ");if(m===null){return null;}var dt=m.querySelector(" + j("[data-change-modal-doc-type]") + ");var r=m.querySelector(\"[data-change-modal-row=\\\"after-file\\\"]\");return {docType:dt===null?null:dt.textContent.trim(),file:r===null?null:r.innerText};})()") : null;
check("④v5 无成果类型文件的变更：弹窗「变更文件」回退显示任务「输出成果文件」类型（CAD图纸）+ 变更后文件 = 变更选择的文件名",
  v5Tab === true && v5ChipReady === true && v5Link === true && v5Modal === true && v5Info !== null && v5Info !== undefined
  && String(v5Info.docType) === "CAD图纸" && String(v5Info.file).indexOf(noDocAfterName) >= 0,
  JSON.stringify(v5Info));
await pressKey("Escape", "Escape", 27);
await waitFor("document.querySelector(" + j("[data-change-modal]") + ")===null", 8000);

// ---------- ④w 任务已定档 → 其文件视为已定档（Push 254 续之二 · 业务口径「不是已经定档了吗 为什么变更申请里面还是未定档」）----------
// 场景：任务经定档开关 / 端点已定档，文件未做文件级定档（保持 draft）—— 变更申请里该文件应显示「已定档」、
// 不再出「定档」按钮 / 空态指引，直接可选；提交走完整链路（服务端 change 闸放行 → files.status=changed + v2 + R01）。
await pressKey("Escape", "Escape", 27);
await waitFor("document.querySelector(" + j(DRAWER) + ")===null", 8000);
const row5Ready = await waitFor("(function(){var rows=document.querySelectorAll(" + j("[role=button]") + ");for(var i=0;i<rows.length;i++){if(rows[i].textContent.indexOf(" + j(taskFinalizedTitle) + ")>=0){return true;}}return false;})()", 20000);
if (row5Ready !== true) await bail("第五条任务行没渲染出来（任务定档后变更用例）");
await ev("(function(){var rows=document.querySelectorAll(" + j("[role=button]") + ");for(var i=0;i<rows.length;i++){if(rows[i].textContent.indexOf(" + j(taskFinalizedTitle) + ")>=0){rows[i].scrollIntoView({block:" + j("center") + ",inline:" + j("start") + "});return true;}}return false;})()");
await sleep(400);
const row5Point = await ev("(function(){var rows=document.querySelectorAll(" + j("[role=button]") + ");for(var i=0;i<rows.length;i++){if(rows[i].textContent.indexOf(" + j(taskFinalizedTitle) + ")>=0){var b=rows[i].getBoundingClientRect();return {x:Math.round(b.left+60),y:Math.round(b.top+b.height/2)};}}return null;})()");
if (row5Point === null || row5Point === undefined) await bail("第五条任务行坐标量不到");
await clickAt(row5Point);
const drawer5Open = await waitFor("document.querySelector(" + j(DRAWER) + ")!==null", 8000);
const changeTabPoint5 = await clickScrolled("[data-drawer-tab=change]");
const taskLockedRowShown = await waitFor("(function(){var p=document.querySelector(" + j("[data-drawer-page=change]") + ");if(p===null){return false;}var t=p.querySelector(" + j("[data-change-target]") + ");if(t===null||t.disabled===true||t.innerText.indexOf(" + j("已定档") + ") < 0){return false;}var f=p.querySelector(" + j("[data-change-finalize]") + ");var h=p.querySelector(" + j("[data-change-none-hint]") + ");return f===null&&h===null;})()", 10000);
const taskLockedRowInfo = taskLockedRowShown === true ? await ev("(function(){var p=document.querySelector(" + j("[data-drawer-page=change]") + ");var t=p.querySelector(" + j("[data-change-target]") + ");return {disabled:t===null?null:t.disabled,text:t===null?null:t.innerText,pressed:t===null?null:t.getAttribute(" + j("aria-pressed") + ")};})()") : null;
check("④w1 任务已定档：变更文件行「已定档」可直接选（不置灰 / 无「定档」按钮 / 无空态指引）",
  drawer5Open === true && changeTabPoint5 === true && taskLockedRowShown === true && taskLockedRowInfo !== null && taskLockedRowInfo !== undefined
  && taskLockedRowInfo.disabled === false && String(taskLockedRowInfo.text).indexOf(taskLockedName) >= 0 && String(taskLockedRowInfo.text).indexOf("已定档") >= 0,
  JSON.stringify(taskLockedRowInfo));
await shotDrawerClip("m4-07-drawer-task-finalized-change.png");

const lockedContent = "回放变更内容：任务定档后直接变更 " + fixtureCode;
const lockedPickTarget = await clickScrolled("[data-change-target]");
await fillField("[data-change-reason]", lockedContent);
await setFileInput("[data-change-upload-input=true]", join(fileDir, taskLockedAfterName));
const lockedPicked = await waitFor("(function(){var n=document.querySelector(" + j("[data-change-file]") + ");return n!==null&&n.textContent.indexOf(" + j(taskLockedAfterName) + ")>=0;})()", 6000);
const lockedSubmit = await clickScrolled("[data-change-submit]");
const lockedLanded = await waitForAsync(async () => {
  const rows = (await db.query("select status from files where id = $1", [taskLockedUpload.fileId])).rows;
  return rows.length === 1 && rows[0].status === "changed";
}, 30000);
const lockedChange = (await db.query("select id, reason, status, applied_by from change_requests where project_id = $1 order by applied_at desc limit 1", [projectId])).rows[0];
const lockedVersions = (await db.query("select seq, change_request_id from file_versions where file_id = $1 order by seq", [taskLockedUpload.fileId])).rows;
const task5Refs = (await db.query("select change_refs from tasks where id = $1", [task5Id])).rows[0].change_refs;
check("④w2 任务已定档 → draft 文件直接变更（服务端放行 · 全链路）：files.status=changed + 版本 v2 挂 change_request_id + 变更记录（内容 / status=applied / 申请人）+ R01 变更关联回写",
  lockedPickTarget === true && lockedPicked === true && lockedSubmit === true && lockedLanded === true
  && lockedChange !== undefined && lockedChange.reason === lockedContent && lockedChange.status === "applied" && lockedChange.applied_by === userRow.id
  && lockedVersions.length === 2 && Number(lockedVersions[1].seq) === 2 && lockedVersions[1].change_request_id === lockedChange.id
  && Array.isArray(task5Refs) && task5Refs.indexOf(lockedChange.id) >= 0,
  JSON.stringify({ change: lockedChange === undefined ? null : { id: lockedChange.id, reason: lockedChange.reason }, versions: lockedVersions, refs: task5Refs }));
const lockedDone = await waitFor("document.querySelector(" + j("[data-change-done]") + ")!==null", 15000);
check("④w3 提交成功 = 绿条「变更已提交生效」（与变更申请页同口径）", lockedDone === true, String(lockedDone));

// 现场还原（给下面的截图段）：关抽屉 → 重开「文件」列下拉（截图段假设下拉是开的）。
await pressKey("Escape", "Escape", 27);
await waitFor("document.querySelector(" + j(DRAWER) + ")===null", 8000);
await ev("(function(){var b=document.querySelector(" + j(FILE_CELL_BUTTON) + ");if(b!==null){b.scrollIntoView({block:" + j("center") + ",inline:" + j("center") + "});}return true;})()");
await sleep(400);
const popoverRestored = await openTaskFilesPopover();
check("④u9 用例收尾：关抽屉、重开「文件」列下拉（截图段现场还原）", popoverRestored === true, String(popoverRestored));

const shotHoverPoint = await ev("(function(){var b=document.querySelector(" + j("[data-task-files-delete] button") + ");if(b===null){return null;}var r=b.getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};})()");
if (shotHoverPoint !== null && shotHoverPoint !== undefined) {
  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: shotHoverPoint.x, y: shotHoverPoint.y });
  await sleep(700);
}
const shotPopover = await page.send("Page.captureScreenshot", { format: "png" });
writeFileSync(join(SCREENSHOT_DIR, "m4-07-task-files-popover.png"), Buffer.from(shotPopover.data, "base64"));
await pressKey("Escape", "Escape", 27);
await waitFor("document.querySelector(" + j(TASK_FILES_POPOVER) + ")===null", 6000);
await ev("(function(){var b=document.querySelector(" + j(FILE_CELL_BUTTON) + ");if(b!==null){b.scrollIntoView({block:" + j("center") + ",inline:" + j("center") + "});}return true;})()");
await sleep(700);
const cellBox = await ev("(function(){var b=document.querySelector(" + j(FILE_CELL_BUTTON) + ");if(b===null){return null;}var r=b.getBoundingClientRect();return {x:r.left,y:r.top,width:r.width,height:r.height};})()");
if (cellBox !== null && cellBox !== undefined) {
  const clip = { x: Math.max(0, cellBox.x - 170), y: Math.max(0, cellBox.y - 26), width: cellBox.width + 340, height: cellBox.height + 52, scale: 2 };
  const shotCell = await page.send("Page.captureScreenshot", { format: "png", clip });
  writeFileSync(join(SCREENSHOT_DIR, "m4-07-file-cell.png"), Buffer.from(shotCell.data, "base64"));
  console.log("截图：" + join(SCREENSHOT_DIR, "m4-07-task-files-popover.png") + " / " + join(SCREENSHOT_DIR, "m4-07-file-cell.png") + " / " + join(SCREENSHOT_DIR, "m4-07-drawer.png") + " / " + join(SCREENSHOT_DIR, "m4-07-drawer-finalized.png"));
}

// ---------- ⑥ 收尾：purge 三份文件 → 物理删临时项目 → 撤销会话 → 零残留 ----------
const purgeResult = await purgeProjectFiles(projectId);
check("⑤a 十份回放文件（含已回收的 B / PDF、定档的 C、已变更的 D、先定档用例的草图与任务定档后变更的目标、变更摘要附图两张）全部 purge（对象真删 + 元数据删 + 留痕）", purgeResult.total === 10 && purgeResult.purged === 10, JSON.stringify(purgeResult));
const projRow = await api("/api/v1/projects/" + projectId);
const delProj = await api("/api/v1/projects/" + projectId, "DELETE", undefined, { "If-Match": String(projRow.json.version) });
check("⑤b 临时项目物理删（200 / 204）", delProj.status === 200 || delProj.status === 204, String(delProj.status) + " " + delProj.text.slice(0, 120));
const projGone = await api("/api/v1/projects/" + projectId);
check("⑤c 项目读面 404（物理删、行不存在）", projGone.status === 404, String(projGone.status));
await db.query("update sessions set revoked_at = now() where token_hash = $1", [sha256(token)]);
const residue = (await db.query("select (select count(*)::int from files where project_id = $1) as files, (select count(*)::int from file_links where object_id = $2) as links, (select count(*)::int from tasks where id = $2) as tasks, (select count(*)::int from projects where id = $1) as projects, (select count(*)::int from change_requests where project_id = $1) as changes, (select count(*)::int from sessions where token_hash = $3 and revoked_at is null) as sessions", [projectId, taskId, sha256(token)])).rows[0];
check("⑤d 零残留：文件 / 关联 / 任务 / 项目 / 变更 / 会话全 0 行", Number(residue.files) === 0 && Number(residue.links) === 0 && Number(residue.tasks) === 0 && Number(residue.projects) === 0 && Number(residue.changes) === 0 && Number(residue.sessions) === 0, JSON.stringify(residue));

rmSync(fileDir, { recursive: true, force: true });
rmSync(downloadDir, { recursive: true, force: true });
const failed = checks.filter((ok) => ok !== true).length;
console.log("—— 合计 " + String(checks.length) + " 项：" + String(checks.length - failed) + " 通过 / " + String(failed) + " 失败 ——");
const pageEvents = page.events.filter((line) => line.indexOf("EVT ") === 0);
console.log("页面控制台 / 异常：" + String(pageEvents.length) + " 条");
for (const line of pageEvents.slice(0, 8)) { console.log("  " + line.slice(0, 240)); }
try { page.ws.close(); } catch (error) { /* 忽略 */ }
chrome.kill();
await db.end();
process.exit(failed === 0 ? 0 : 1);
