#!/usr/bin/env node
/**
 * LibiaoLink 前端 · 回放：工作台「我的任务」页（Push 230 · M6-06 前端接线 · A6-01 / A6-03）
 *
 * 业务口径（2026-09-30）：「改成 我提出的问题」「同样做标签导航栏 我的任务 我提出的问题先做这两个」
 *   「我的任务 是折叠面板 未展开是项目名称和编号 下拉是具体我的任务」「我提出的问题就参考日报的问题追踪即可
 *   也是折叠面板」「开始做前端」「表格内容要全」「直接把这个搬到我的任务不就好了」（任务表行口径照项目页任务表搬）→
 *   「这些字段一个不能少懂吗」（Push 231：任务表列补齐项目页任务表全 15 列，「预计所需天数」窄列也在）→
 *   「增加进入项目按钮」（Push 232：折叠面板头常驻「进入项目」深链 → 项目详情缺省标签「项目总览」）→
 *   「这个下拉要有记忆」（Push 233：折叠面板展开态按账号存偏好 workspaceOpenProjects，刷新 / 换标签保持）→
 *   「增加一个我的计划页面」+「你只要把导航栏设计好 后续详细设计再说」（Push 234：导航栏第三枚标签「我的计划」+
 *   路由 `?tab=plan` 就位；页面内容待详细设计，暂落登记卡 —— 数据面 / 契约本刀不动）→
 *   2026-10-10「照 minimemo3 便签页融入系统」+「ui直接照搬可以吗 背景颜色也搬过去 卡片的尺寸也要」+「导出导入功能不要」
 *   （Push 266：便签墙页面落地并照 MiniMemo 参考页照搬 —— 奶白背景 / 左侧分类栏 / 198 高圆角卡片 / 7 色 hex 调色板；
 *   新建 / 编辑 / 删除 / 搜索 / 分类 / 排序，本机 localStorage 保存；导出 / 导入不做）→「填写也要一样」
 *   （Push 267：编辑（填写）弹窗照参考页 NoteEditor 照搬 —— 便签底色整卡铺底 / 顶栏关闭 X + 7 色圆点 + 字体 Aa 分段器 /
 *   大标题 + 记录区 / 分类胶囊（＋ 新分类）/ 底栏「更新于」+ 删除 + 保存；本脚本「⑪」段含两道弹窗照搬对账）→
 *   「这个也不需要（排序）· 背景换成白色 · 数据接入数据库 · 新增完成按钮 · 完成后只显示在已完成里面」
 *   （Push 268：页面底改纯白、排序下架；便签墙整面按账号存 user_preferences.prefs.myPlanBoard（跨设备可见）；
 *   旧 localStorage 键首次打开自动迁移上云；编辑弹窗底栏加「完成 / 恢复」+ 侧栏「已完成」视图（完成后只出现在其中）；
 *   本脚本「⑪」段另含 落库 / 首次预置 / 旧键迁移 / 完成态 对账）。
 *   「不要这个完成 在这个分类旁边增加完成区域 拖动便签到完成区域则完成」
 *   （Push 269：编辑弹窗底栏撤「完成 / 恢复」（改拖拽完成）；侧栏分类卡下方新增「完成」拖放区 —— 把便签拖进去即完成（拖动中悬浮小卡 + 落点高亮）；
 *   「已完成」视图里的便签拖回「全部便签」即恢复；本脚本「⑪」段含 拖拽完成 / 拖拽恢复 对账）。
 *   「我要分类的左侧全部作为完成区 虚线框起来 然后便签拖动应该脱离原来的位置」
 *   （Push 270：完成区放大成整条左栏（虚线框裹住分类卡，左栏拉满视口高）；拖动中便签从原位脱离（原槽位留虚线占位框，本体只以悬浮小卡示人）；
 *   本脚本「⑪」段 ⑪c4 / ⑪l0 随之强化对账）。
 *   「卡片拖动大小不要改变要原尺寸」
 *   （Push 271：悬浮小卡改成被拖便签 1:1 原尺寸复刻（同款便签卡 + 抓取点偏移跟手）；⑪l0 加 ghost 与占位框同尺寸对账）。
 *   「在如图的位置增加背景颜色切换 默认是和别的页面统一颜色 第二个颜色是minimemo的默认颜色」
 *   （Push 271：工具条左端 = 「背景颜色」箭头钮（照参考组件 1:1：深色圆 + 白箭头 + 文字，悬停 / 展开圆铺满成胶囊、箭头右移、文字转白），点击弹出 11 色面板（不常驻：再点 / 点外 / Esc 收起；从按钮右侧滑出、不下滑；统一白（默认）/ 奶白（参考页默认底色）/ 9 色板 · 玫红下架），搜索框右靠贴「新建便签」；收起只露圆 + 箭头，「背景颜色」文字悬停 / 展开才浮现；悬停照参考组件 1:1（悬停块 1.5 + 邻居联动 1.3/1.15 + 冒名签）、悬停「已选中」块自身不放大、点击完毕落回原位且无焦点残留、选择后面板保持打开、随账号落库；分类删除 = 项目同款删除胶囊 —— 本脚本「⑪」段 ⑪l5a / ⑪l5b / ⑪l10 ~ ⑪l13b 对账）。
 *
 * 口径复评（2026-09-30 · 业务：「明明有四个 为什么只显示了两个」→「不能有 7 天内时间限制」→「时间不限制 另外
 *   项目经理是我也要算在我的任务」）：我的任务 = 任务负责人含我 或 项目项目经理含我 + 未完成、不限完成日期窗口；
 *   未排期（无预计完成日期）单列一组 —— 本脚本 ① 对账 / ②④ 任务表 / ⑩ 记忆段的行数断言随新口径重算（四组 / 6 项）。
 *
 * 口径追订（2026-10-08）：「删除在项目中查看 进入项目直接进入日报记录页面 替代在项目中查看」（Push 242：行尾入口下架、
 *   入口收敛到面板头「进入项目」）→「我提出的问题点击进入项目直接进入到问题追踪页面」（Push 253：「我提出的问题」的
 *   「进入项目」落点由该项目「日报记录」改**「问题追踪」**（`?view=daily&sub=issues`）；「我的任务」落点照旧 = 项目总览）。
 *
 * 前置（三件都在本机跑着）：
 *   1. 前端 dev：cd frontend && npm run dev（默认 3000）
 *   2. api：cd server && npm run start:api（默认 3001）
 *   3. 数据库：本地沙箱 PG（默认 127.0.0.1:5433/libiaolink）
 *   4. 本机装了 Chrome（脚本 headless 起一个调试实例；路径可用 CHROME_PATH 覆盖）
 *
 * 用法：node scripts/m6-06-workspace-e2e.mjs
 *   可覆盖的环境变量：FRONTEND_BASE / API_BASE / DATABASE_URL / CHROME_PATH / CDP_PORT / REPLAY_USER / PG_MODULE / SCREENSHOT_DIR
 *
 * 它做什么：用**两条临时会话**（px-replay = 我；wmj-replay = 反例提出人；跑完撤销）+ **三个临时项目**
 * （PX-M6WS-*；跑完物理删、零残留）在真机浏览器里跑一遍工作台接线后的读写口径 ——
 *   ① 接口先行对账（夹具落库后 GET /api/v1/workspace）：跨项目四组任务 + 「我提出的」不含他人提的问题；
 *   ② 页面骨架：两枚下划线标签（我的任务 / 我提出的问题；文字 + 选中下划线）+ 默认选中「我的任务」+ 地址不带 `?tab=`；
 *   ③ 「我的任务」折叠面板：收起 = 项目名称 + 编号（最急的项目在最上）+ 摘要签 + 「进入项目」按钮；展开 = 该项目下的任务表；
 *   ④ 任务表口径（Push 231 扩列 · Push 302 起聚合面全字段直出：列口径照项目页任务表全 15 列 ——「直接把这个搬到我的任务不就好了」+
 *      「这些字段一个不能少懂吗」；Push 279 起**行换成项目页那枚可编辑行** —— 行内逐列可点 + 点行开右侧抽屉，
 *      见本段「④-2 / ④v ~ ④z2」）：任务描述 + 四格进度点（不含分组签 —— 业务口径「这个不要展示」，
 *      组序由行序体现）/ 项目经理 / 负责人 / 状态 / 紧急重要度 /
 *      逾期未交付 / 输出成果文件 / 文件 / 进展描述 / 开始·实际日期 / 天数 / 人数 / 变更关联；
 *      命中口径 = 负责人含我 或 项目经理含我、不限完成日期（远期照收 + 未排期单列）；他人项目（我既非负责人也非项目经理）与已完成不进；
 *   ⑤ 切标签：真实鼠标点「我提出的问题」→ 地址写回 `?tab=raised`、aria-current 转移；
 *   ⑥ 「我提出的问题」折叠面板：七列（Push 260 补「问题处理人 / 责任人」）——「问题是否处理」是**行内下拉**
 *      （Push 260：与项目页「问题追踪」共用同一枚 IssueStateCell，点色签改三态、乐观锁 version、失败回滚）；
 *      照「问题追踪」的（日期 / 问题描述 / 问题归类 /
 *      解决方案或建议 / 问题附图 / 问题是否处理；后两列 Push 302 起并入聚合面随行下发（此前按项目向源接口回填），真 PNG 直传夹具保证有值）；
 *      未关闭在前、不是我提的不进（Push 260 起「已完成不显示」）；Push 242 起行尾「在项目中查看」下架、六列 `table-fixed` 固定列宽（跨面板对齐）；
 *   ⑦ 深链：`#/my-tasks?tab=raised` 直接打开仍停在该标签；`?tab=` 不认识的值落回「我的任务」；
 *      「进入项目」按钮 =「我的任务」落项目总览、切到「我提出的问题」落该项目「问题追踪」（Push 232 / Push 242 / Push 253），
 *      浏览器后退回工作台；
 *   ⑨ 背景档位（Push 290 · 业务口径「醒目模式可以删除了 统一用背景改 我的任务那边也要适配」）：原醒目模式开关下架，
 *      观感 = 顶栏「背景 · 档位」（简约 / 适中 / 炫彩），工作台任务表 / 「我提出的问题」表都随档位；真点菜单切档逐档对账
 *      （data-workspace-task-tint / data-workspace-issue-tint + 行色 computed + 状态列 oklch 深色字）；Push 291 起切档 = 单键 PATCH
 *      「user_preferences.prefs.backgroundTier」（按账号记住）—— 切档落库 / 刷新保持 / 收尾恢复账号原值（不留痕）；同日 Push 292 起同菜单
 *      第四行 =「水印」开关（账号偏好 cardWatermark：点击落库 / 刷新保持 / 收尾恢复，⑨j 组对账；Push 313 起账号默认 false = 无水印）；点档 / 点开关都不收弹层
 *      （Push 292 追订「选择后不要退出 用户点别的地方再退出」：点外 / Esc / 再点触发钮才收，⑨a2 对账）；同日 Push 293 起「炫彩」档实装（同色相高饱和兑白 —— 底色 ×0.62 / 悬停 ×0.82）：⑨d2 / ⑨f2 对账（行色 computed 换高饱和值、状态列 oklch 深色字照旧）；同日追订「炫彩模式文字不明显 看不出来」：行 / 卡挂 .tint-vivid 把次要灰字提深一档（⑨d2 / ⑨f2 顺带对账类名）；同日再追订「炫彩下点这个进度条看不清」→「背景留白」→「带弧度的」→「胶囊的绿回到之前的版本」：炫彩档四格进度点底挖出胶囊白槽（rounded-full + bg-white），点回标配绿（emerald-500 / zinc-200），适中 / 简约不动：⑨c2 / ⑨f3 对账类名；
 *   ⑩ 折叠面板展开态记忆（Push 233 ·「这个下拉要有记忆」）：偏好归零 = 全收起 → 展开 A → 刷新仍展开 / B 仍收起 →
 *      切「我提出的问题」两面板全收起（两标签各自独立记忆）→ raised 展开 B → 切回 tasks 的 A 不受影响 →
 *      收起 A → 刷新仍全收起 → GET preferences 逐段落库核对 → 收尾恢复账号偏好原值（不留痕）；
 *   ⑪ 「我的计划」便签墙（Push 234 标签 / 路由就位 → Push 266 页面落地 · 2026-10-10「照 minimemo3 便签页融入系统」+
 *       「ui直接照搬可以吗 背景颜色也搬过去 卡片的尺寸也要」+「导出导入功能不要」→「填写也要一样」（Push 267 编辑（填写）弹窗照搬）→
 *       Push 268「这个也不需要（排序）· 背景换成白色 · 数据接入数据库 · 新增完成按钮 · 完成后只显示在已完成里面」）：
 *      第三枚标签在导航栏 → 点击写回 `?tab=plan` + 选中态转移 → 页内 = 便签墙（照 MiniMemo 参考页照搬：Push 268 起纯白背景 +
 *      左侧分类栏（全部便签 / 已完成 / 各分类）/ 198 高圆角卡片 / 7 色 hex 调色板；账号落库 —— 首次进入预置 6 条示例并上云，
 *      旧 localStorage 键首次打开自动迁移上云）：照搬口径对账（白底 / 卡片尺寸 / 网格 / 无排序）→ 新建（标题与
 *      内容都空时保存置灰）/ 编辑 / 搜索 / 分类过滤 / 完成 →「已完成」（只显示在这里）/ 恢复 / 删除（二次确认）/
 *      刷新持久化（GET preferences 对账）/ 首次预置 / 旧键迁移 → 深链 `#/my-tasks?tab=plan` 直接打开仍停在该标签 →
 *      点回「我的任务」地址回到不带参数的原口径 → 收尾账号偏好恢复原值（不留痕）；
 *   ⑬ 问题子视图（Push 260）：「提出/负责的问题」标签带下拉子菜单（悬停 / 点击展开，同项目页「日报及问题」；
 *      面板见 components/WorkspaceIssueSubMenu.tsx）—— 地址 ?tab=raised&sub=、缺省 raised 不落参数；「待我处理的问题」
 *      页与「我提出的问题」同构（同一张七列表 / 同一套归类色签）；色签与项目页「问题追踪」逐 token 相等；「已完成不显示」= 两栏同一过滤（A2 完成态不出现）；
 *      深链 ?sub=handling 直达、未知值回落；跑完恢复账号偏好原值（截图：submenu / handling 两张，见 SCREENSHOT_DIR）。
 *   ⑧ 收尾：删三个临时项目（A / B / C，物理删）→ 读面 404；撤销两条临时会话；库内零残留；控制台 0 异常。
 * 证据：docs/m6-回放证据(工作台我的任务·前端).md（Push 231 扩列 + Push 232「进入项目」/ Push 290 背景档位适配（原醒目模式下架） + Push 291 档位按账号落库 + Push 292 水印开关 + Push 233 展开态记忆 +
 *   Push 266 便签墙 / Push 268 便签墙落库 + 完成态小节）
 */

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
/** 反例提出人（「我提出的问题」不认他提的问题）。 */
const OTHER_USER = process.env.OTHER_USER ?? "wmj-replay";
const TZ = "Asia/Shanghai";
/** 截图落盘目录（口径同其它回放脚本：默认系统临时目录，可用 SCREENSHOT_DIR 覆盖）。 */
const SCREENSHOT_DIR = process.env.SCREENSHOT_DIR ?? tmpdir();
const Q = String.fromCharCode(34);
const j = (value) => JSON.stringify(value);

const db = new Client({ connectionString: DB });
await db.connect();
const sha256 = (text) => createHash("sha256").update(text).digest("hex");
async function makeSession(username) {
  const row = (await db.query("select id, username, display_name from users where username = $1 and status = 'active'", [username])).rows[0];
  if (row === undefined) {
    console.error("回放用户不存在：" + username);
    process.exit(1);
  }
  const token = "pxm6ws-" + randomBytes(16).toString("hex");
  const csrf = randomBytes(16).toString("hex");
  await db.query("insert into sessions (token_hash, user_id, id_token, expires_at) values ($1, $2, $3, now() + make_interval(mins => 30))", [sha256(token), row.id, "px-m6-workspace-replay"]);
  return { id: row.id, username: row.username, displayName: row.display_name, token, csrf };
}
const me = await makeSession(REPLAY_USER);
const other = await makeSession(OTHER_USER);
console.log("临时会话：" + me.username + "（" + me.displayName + "）+ " + other.username + "（" + other.displayName + "）");

function sessionApi(session) {
  return async function api(path, method = "GET", body, extra) {
    const headers = Object.assign({ Cookie: "ll_sid=" + session.token + "; ll_csrf=" + session.csrf, "X-CSRF-Token": session.csrf, Accept: "application/json" }, extra || {});
    const init = { method, headers };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    const res = await fetch(API + path, init);
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch (error) {
      json = null;
    }
    return { status: res.status, json, text };
  };
}
const api = sessionApi(me);
const apiOther = sessionApi(other);

const checks = [];
function check(name, ok, detail) {
  checks.push(ok === true);
  console.log((ok === true ? "PASS  " : "FAIL  ") + name + (detail === undefined ? "" : "   [" + detail + "]"));
}
const isoOf = (date) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
const shiftIso = (iso, days) => new Date(Date.parse(iso + "T00:00:00Z") + days * 86400000).toISOString().slice(0, 10);
/** ISO（YYYY-MM-DD）→「YYYY年M月D日」（与页面日期列同口径，用来对账展示文案）。 */
const cnDate = (iso) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return match === null ? iso : String(Number(match[1])) + "年" + String(Number(match[2])) + "月" + String(Number(match[3])) + "日";
};
/** ISO（YYYY-MM-DD）→「M月D日」（与项目页任务表日期格同口径，用来对账展示文案）。 */
const mdDate = (iso) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return match === null ? iso : String(Number(match[2])) + "月" + String(Number(match[3])) + "日";
};
const TODAY = isoOf(new Date());
const DUE_OVERDUE = shiftIso(TODAY, -2);
const DUE_UPCOMING = shiftIso(TODAY, 3);
const DUE_FAR = shiftIso(TODAY, 20);
/** Push 231 扩列夹具：开始日期（逾期任务 -4 天 → 与预计完成日含首尾 5 天；今日任务 -2 天 → 推算 3 天）。 */
const START_OVERDUE = shiftIso(DUE_OVERDUE, -4);
const START_TODAY = shiftIso(TODAY, -2);

// ---------- 清场：上一轮崩在中途留下的同名临时项目 ----------
/** 清项目里的文件（回收 → 彻底删除）：项目物理删的顺序里没有先清 files.current_version_id，
 *  带版本的文件会让 DELETE /projects/{id} 500 —— 收尾先清文件再删项目（证据文档「已知边界」有记）。 */
async function purgeProjectFiles(projectId) {
  const rows = (await db.query("select id, name, status, version from files where project_id = $1", [projectId])).rows;
  for (const file of rows) {
    let version = file.version;
    if (file.status !== "recycled") {
      const recycled = await api("/api/v1/files/" + file.id + "/recycle", "POST", { version });
      if (recycled.status !== 200 || recycled.json === null) {
        console.log("清文件·回收失败：" + file.name + " → " + String(recycled.status));
        continue;
      }
      version = recycled.json.version;
    }
    const purged = await api("/api/v1/files/" + file.id + "/purge", "POST", { version });
    console.log("清文件：" + file.name + " → " + String(purged.status));
  }
}
const staleProjects = (await db.query("select id, version from projects where code like $1 and deleted_at is null", ["PX-M6WS-%"])).rows;
for (const row of staleProjects) {
  await purgeProjectFiles(row.id);
  const gone = await api("/api/v1/projects/" + row.id, "DELETE", undefined, { "If-Match": String(row.version) });
  console.log("清场：删残留临时项目 " + row.id + " → " + String(gone.status));
}

// ---------- 夹具：两个临时项目 ----------
const suffix = randomBytes(3).toString("hex").toUpperCase();
const codeA = "PX-M6WS-A" + suffix;
const codeB = "PX-M6WS-B" + suffix;
const projA = await api("/api/v1/projects", "POST", { code: codeA, name: "回放·工作台A", description: "回放·工作台A", managerIds: [me.id] });
check("夹具：建临时项目 A（201）", projA.status === 201, String(projA.status) + " " + projA.text.slice(0, 140));
const projectA = projA.json === null ? "" : projA.json.id;
const projB = await api("/api/v1/projects", "POST", { code: codeB, name: "回放·工作台B", description: "回放·工作台B", managerIds: [me.id, other.id] });
check("夹具：建临时项目 B（201；成员 = 我 + 反例提出人）", projB.status === 201, String(projB.status) + " " + projB.text.slice(0, 140));
const projectB = projB.json === null ? "" : projB.json.id;
const codeC = "PX-M6WS-C" + suffix;
const projC = await api("/api/v1/projects", "POST", { code: codeC, name: "回放·工作台C（非我管理）", description: "回放·工作台C", managerIds: [other.id] });
check("夹具：建临时项目 C（201；经理 = 反例提出人 —— 我既非负责人也非项目经理，反例面）", projC.status === 201, String(projC.status) + " " + projC.text.slice(0, 140));
const projectC = projC.json === null ? "" : projC.json.id;

async function addTask(projectId, body, request = api) {
  const res = await request("/api/v1/projects/" + projectId + "/tasks", "POST", body);
  if (res.status !== 201 || res.json === null) {
    console.error("建任务失败：" + res.status + " " + res.text.slice(0, 200));
    process.exit(1);
  }
  return res.json;
}
// A：逾期 / 今日 / 即将 三条（我的）+ 远期（负责人是别人 —— 新口径经「项目经理含我」命中）+ 未排期（新组）+ 已完成反例；
// C：他人项目他人任务（我既非负责人也非项目经理 —— 反例面）；B：跨项目今日一条。
// Push 231 扩列：逾期 / 今日两条在创建时补齐任务表扩展列（成果文件只能建时给；开始日期 / 天数 / 人数 / 进展描述随行落库）
const tOverdue = await addTask(projectA, { stageKey: "design", title: "回放·逾期任务", titleEn: "Replay overdue", ownerIds: [me.id], plannedStart: START_OVERDUE, plannedEnd: DUE_OVERDUE, priority: "高", estimatedDays: 5, headcount: 6, deliverableTypes: ["CAD图纸", "合同"], note: "回放·进展描述：图纸已出，等待评审" });
const tToday = await addTask(projectA, { stageKey: "design", title: "回放·今日任务", ownerIds: [me.id], plannedStart: START_TODAY, plannedEnd: TODAY, priority: "中", headcount: 3, deliverableTypes: ["验收单"] });
const tUpcoming = await addTask(projectA, { stageKey: null, title: "回放·即将任务", ownerIds: [me.id], plannedEnd: DUE_UPCOMING, priority: "低" });
const tDone = await addTask(projectA, { stageKey: "design", title: "回放·已完成任务", ownerIds: [me.id], plannedEnd: TODAY });
const tFar = await addTask(projectA, { stageKey: "design", title: "回放·远期任务", ownerIds: [other.id], plannedEnd: DUE_FAR });
const tUnscheduled = await addTask(projectA, { stageKey: "design", title: "回放·未排期任务", ownerIds: [me.id], plannedEnd: null });
const tStranger = await addTask(projectC, { stageKey: "presale", title: "回放·他人项目任务", ownerIds: [other.id], plannedEnd: TODAY }, apiOther);
// B：今日一条（我的）—— 跨项目聚合的第二块面板
const tB = await addTask(projectB, { stageKey: "presale", title: "回放·B项目今日任务", ownerIds: [me.id], plannedEnd: TODAY });
const progressRes = await api("/api/v1/projects/" + projectA + "/tasks/" + tUpcoming.id + "/progress", "PATCH", { progress: 0.5, version: tUpcoming.version });
check("夹具：即将任务改进度到 50%（PATCH progress）", progressRes.status === 200, String(progressRes.status));
const doneRes = await api("/api/v1/projects/" + projectA + "/tasks/" + tDone.id, "PATCH", { status: "done", version: tDone.version });
check("夹具：反例任务置「已完成」（PATCH status=done）", doneRes.status === 200, String(doneRes.status) + " " + doneRes.text.slice(0, 140));
// Push 231 扩列夹具 ①：「变更关联」列 —— change_requests 只追加 + 任务 change_refs 回写（页面读面走真实任务列表接口；
// 这里落库等价于「变更生效 R01 回写」后的状态，收尾时随项目物理删一起清）
const changeRow = (await db.query(
  "insert into change_requests (project_id, stage_key, reason, status, applied_by) values ($1, $2, $3, 'applied', $4) returning id",
  [projectA, "design", "回放·变更原因：设计调整", me.id],
)).rows[0];
const changeId = changeRow === undefined ? "" : changeRow.id;
const changeRefsRes = changeId === "" ? { rowCount: 0 } : await db.query("update tasks set change_refs = array[$2]::uuid[] where id = $1", [tToday.id, changeId]);
check("夹具：今日任务挂 1 条变更关联（change_requests + tasks.change_refs）", changeId !== "" && changeRefsRes.rowCount === 1, changeId);
// Push 231 扩列夹具 ②：「文件」列 —— 任务文件走真实直传链路（draft 关联本任务 → fileSummary 1 份 / 未定档 1）
const taskFileName = "回放-任务文件.txt";
const taskFileBytes = Buffer.from("LibiaoLink 回放任务文件（Push 231 扩列）", "utf8");
const taskFileHash = sha256(taskFileBytes);
const tfInit = await api("/api/v1/files/uploads", "POST", { projectId: projectA, taskId: tOverdue.id, name: taskFileName, sizeBytes: taskFileBytes.length, mime: "text/plain", contentHash: taskFileHash, intent: "version" });
const tfFileId = tfInit.json === null ? "" : tfInit.json.file.id;
const tfSession = tfInit.json === null ? "" : tfInit.json.upload.id;
check("夹具：任务文件发起直传（201，taskId 挂到逾期任务）", tfInit.status === 201 && tfFileId !== "" && tfSession !== "", String(tfInit.status) + " " + tfInit.text.slice(0, 140));
const tfSigned = await api("/api/v1/files/" + tfFileId + "/uploads/" + tfSession + "/parts", "POST", { partNumbers: [1] });
const tfUrl = tfSigned.json === null ? "" : tfSigned.json.parts[0].url;
const tfPut = tfUrl === "" ? { ok: false, status: 0 } : await fetch(tfUrl, { method: "PUT", body: taskFileBytes });
const tfDone = tfPut.ok ? await api("/api/v1/files/" + tfFileId + "/uploads/" + tfSession + "/complete", "POST", { contentHash: taskFileHash }) : { status: 0 };
check("夹具：任务文件直传完成（PUT 200 → complete 200 落 draft 版本）", tfPut.status === 200 && tfDone.status === 200, String(tfPut.status) + " / " + String(tfDone.status));

async function addIssue(projectId, session, title, categories, dueLabel) {
  const report = await sessionApi(session)("/api/v1/projects/" + projectId + "/reports", "POST", {
    date: TODAY,
    state: "submitted",
    doneWork: "回放·" + dueLabel + "的日报",
    foundIssue: title,
    issueCategories: categories,
  });
  if (report.status !== 201 || report.json === null) {
    console.error("建日报 / 问题失败：" + report.status + " " + report.text.slice(0, 200));
    process.exit(1);
  }
  const issues = await sessionApi(session)("/api/v1/projects/" + projectId + "/issues?limit=200");
  const issueItems = issues.json === null || issues.json.items === undefined ? [] : issues.json.items;
  const found = issueItems.find((item) => item.title === title);
  if (found === undefined) {
    console.error("日报没有派生问题：" + title);
    process.exit(1);
  }
  return { reportId: report.json.id, issue: found };
}
// A：我提出的两条（一条未解决、一条已完成）
const issueA1 = await addIssue(projectA, me, "回放问题·我提出的未解决", ["机械部"], "A 未解决");
const issueA2 = await addIssue(projectA, me, "回放问题·我提出的已完成", ["采购部", "项目部"], "A 已完成");
const closeRes = await api("/api/v1/projects/" + projectA + "/issues/" + issueA2.issue.id, "PATCH", { state: "done", version: issueA2.issue.version });
check("夹具：A 的第二条问题置「已完成」（PATCH state=done）", closeRes.status === 200, String(closeRes.status) + " " + closeRes.text.slice(0, 140));
// A1：补「解决方案或建议 + 问题附图」两列（Push 302 起聚合读面随行下发，夹具直落库即对账）。
// 附图走真直传链路：发起 → 签名分片 → PUT → 完成。
const issueSolution = "回放·解决方案：先抽水，复测后再装货架";
const pngName = "回放-问题附图.png";
const pngBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const pngHash = sha256(pngBytes);
const upInit = await api("/api/v1/files/uploads", "POST", { projectId: projectA, name: pngName, sizeBytes: pngBytes.length, mime: "image/png", contentHash: pngHash, intent: "version" });
const pngFileId = upInit.json === null ? "" : upInit.json.file.id;
const pngSession = upInit.json === null ? "" : upInit.json.upload.id;
check("夹具：问题附图发起直传（201）", upInit.status === 201 && pngFileId !== "" && pngSession !== "", String(upInit.status) + " " + upInit.text.slice(0, 140));
const pngSigned = await api("/api/v1/files/" + pngFileId + "/uploads/" + pngSession + "/parts", "POST", { partNumbers: [1] });
const pngPartUrl = pngSigned.json === null ? "" : pngSigned.json.parts[0].url;
const pngPut = pngPartUrl === "" ? { ok: false, status: 0 } : await fetch(pngPartUrl, { method: "PUT", body: pngBytes });
const pngDone = pngPut.ok ? await api("/api/v1/files/" + pngFileId + "/uploads/" + pngSession + "/complete", "POST", { contentHash: pngHash }) : { status: 0, json: null, text: "PUT 失败 " + String(pngPut.status) };
check("夹具：问题附图直传完成（PUT 200 → complete 200 落版本）", pngPut.status === 200 && pngDone.status === 200 && pngDone.json !== null && pngDone.json.version !== undefined, String(pngPut.status) + " / " + String(pngDone.status) + " " + pngDone.text.slice(0, 140));
const issuePatchRes = await api("/api/v1/projects/" + projectA + "/issues/" + issueA1.issue.id, "PATCH", { solution: issueSolution, photoFileIds: [pngFileId], version: issueA1.issue.version });
check("夹具：A1 问题补「解决方案或建议 + 问题附图」（PATCH solution + photoFileIds）", issuePatchRes.status === 200, String(issuePatchRes.status) + " " + issuePatchRes.text.slice(0, 140));
// B：我提出的一条 + 反例（wmj 提出、但处理人 = 我）
const issueB = await addIssue(projectB, me, "回放问题·B项目我提出的", ["客观原因"], "B 我提出的");
const issueOther = await addIssue(projectB, other, "回放问题·他人提出的", ["物流原因"], "B 他人提出的");
const otherRead = await api("/api/v1/projects/" + projectB + "/issues/" + issueOther.issue.id);
check("夹具：B 的反例问题可读（wmj 提出）", otherRead.status === 200, String(otherRead.status));
// Push 260（「待我处理的问题」栏夹具）：把三条问题分派给「我」（ownerId = 我）—— A1（我提出 · 未解决）、
// A2（我提出 · 已完成）、issueOther（wmj 提出）；issueB 故意不派 = 反例（我提出、但处理人不是我 → 只进「我提出的」）。
async function issueVersionOf(projectId, issueId) {
  const res = await api("/api/v1/projects/" + projectId + "/issues/" + issueId);
  return res.json === null ? "" : res.json.version;
}
const ownA1 = await api("/api/v1/projects/" + projectA + "/issues/" + issueA1.issue.id, "PATCH", { ownerId: me.id, version: await issueVersionOf(projectA, issueA1.issue.id) });
check("夹具：A1（我提出 · 未解决）分派给我（PATCH ownerId = 我）", ownA1.status === 200, String(ownA1.status) + " " + ownA1.text.slice(0, 140));
const ownA2 = await api("/api/v1/projects/" + projectA + "/issues/" + issueA2.issue.id, "PATCH", { ownerId: me.id, version: await issueVersionOf(projectA, issueA2.issue.id) });
check("夹具：A2（我提出 · 已完成）分派给我", ownA2.status === 200, String(ownA2.status) + " " + ownA2.text.slice(0, 140));
const ownOther = await api("/api/v1/projects/" + projectB + "/issues/" + issueOther.issue.id, "PATCH", { ownerId: me.id, version: await issueVersionOf(projectB, issueOther.issue.id) });
check("夹具：B 的 wmj 提出那条分派给我（「我处理的」含、但非我提出 → 不进「我提出的」）", ownOther.status === 200, String(ownOther.status) + " " + ownOther.text.slice(0, 140));

// ---------- ⓪b 展开态偏好（A31 · Push 233）：先记原值 → 归零 ----------
// Push 233 起折叠面板展开态按账号存服务端（「这个下拉要有记忆」）—— 本脚本的「页面打开 = 全收起 / 点一下 = 展开」口径
// 依赖起点归零；跑完由 ⑩ 恢复原值（不留痕）。原值先记，早于任何页面交互。
const prefBeforeMemory = await api("/api/v1/users/me/preferences");
const memoryOriginal = prefBeforeMemory.status === 200 && prefBeforeMemory.json !== null && typeof prefBeforeMemory.json.workspaceOpenProjects === "object" && prefBeforeMemory.json.workspaceOpenProjects !== null
  ? prefBeforeMemory.json.workspaceOpenProjects
  : { tasks: [], raised: [] };
/** 等展开态落库回读（服务端收敛后与期望值一致才算落库；最多 ~6s）。 */
async function waitOpenProjects(value) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const now = await api("/api/v1/users/me/preferences");
    if (now.status === 200 && now.json !== null && JSON.stringify(now.json.workspaceOpenProjects) === JSON.stringify(value)) {
      return now;
    }
    await sleep(300);
  }
  return null;
}
async function patchOpenProjects(value) {
  await api("/api/v1/users/me/preferences", "PATCH", { workspaceOpenProjects: value });
  return await waitOpenProjects(value);
}
/** 面板读数：data-open（字符串 "true" / "false"）+ 面板内表格行数（展开才 > 0）。 */
const panelOpenOf = (projectId) => "(function(){var p=document.querySelector(" + j('[data-workspace-panel="' + projectId + '"]') + ");return p===null?null:{open:String(p.getAttribute(" + j("data-open") + ")),rows:p.querySelectorAll(" + j("[data-workspace-task],[data-workspace-issue]") + ").length};})()";
/** 确保某面板为指定展开态（展开态按账号记忆后，点面板头前必须先对齐状态，回放才与运行顺序无关）。 */
async function ensurePanelOpen(projectId, wantOpen) {
  const current = await ev(panelOpenOf(projectId));
  if (current === null) throw new Error("面板不存在：" + projectId);
  if (current.open === String(wantOpen)) return;
  await clickSelector('[data-workspace-panel="' + projectId + '"] [data-workspace-panel-toggle]');
  await waitFor(panelOpenOf(projectId) + ".open === " + j(String(wantOpen)), 25000);
}

// ---------- ① 接口先行对账（页面口径的服务端真相） ----------
const wsRes = await api("/api/v1/workspace");
check("①a GET /api/v1/workspace 200（仅会话、跨项目）", wsRes.status === 200 && wsRes.json !== null, String(wsRes.status));
const ws = wsRes.json === null ? { myTasks: { today: [], upcoming: [], overdue: [], unscheduled: [] }, myIssues: { handling: [], raised: [] } } : wsRes.json;
const idsOf = (list) => (list === undefined ? [] : list).map((item) => item.id);
/** 我是项目经理的既有项目（本机库里就有）在办任务也会进读面 —— 夹具断言按测试项目 id 收窄，
 *  页面级计数（②d / ③a / ⑫a）一律与接口读面逐项对账，别被历史数据带偏。 */
const TEST_PROJECTS = [projectA, projectB, projectC];
const inTest = (list) => (list === undefined ? [] : list).filter((item) => TEST_PROJECTS.indexOf(item.projectId) >= 0);
const todayTest = idsOf(inTest(ws.myTasks.today));
const upcomingTest = idsOf(inTest(ws.myTasks.upcoming));
const overdueTest = idsOf(inTest(ws.myTasks.overdue));
const unscheduledTest = idsOf(inTest(ws.myTasks.unscheduled));
const ambientTotal = idsOf(ws.myTasks.today).length + idsOf(ws.myTasks.upcoming).length + idsOf(ws.myTasks.overdue).length + idsOf(ws.myTasks.unscheduled).length;
// Push 302 拆根：工作台聚合面（GET /api/v1/workspace）直出任务表全 15 列数据源 + 问题七列（solution / photos）+
// 项目卡 projects —— 前端不再逐项目回填（useTaskFull / useIssueFull / fallbackTaskOf 整段下架），刷新一次到位；
// 这里先在接口层对账全字段随行，再往下走页面级断言。
const wsTaskOf = (id) => {
  for (const list of [ws.myTasks.overdue, ws.myTasks.today, ws.myTasks.upcoming, ws.myTasks.unscheduled]) {
    const hit = (list === undefined ? [] : list).find((item) => item.id === id);
    if (hit !== undefined) return hit;
  }
  return undefined;
};
const wsIssueOf = (id) => {
  for (const list of [ws.myIssues.handling, ws.myIssues.raised]) {
    const hit = (list === undefined ? [] : list).find((item) => item.id === id);
    if (hit !== undefined) return hit;
  }
  return undefined;
};
const wsTaskOverdue302 = wsTaskOf(tOverdue.id);
check("①b（Push 302）聚合面任务行随行全字段：项目编号 / 名称 + 成果文件 2 类 + 天数 5 + 人数 6 + 进展描述 + files 1 份（页面零回填）",
  wsTaskOverdue302 !== undefined && wsTaskOverdue302.projectId === projectA && wsTaskOverdue302.projectCode === codeA && wsTaskOverdue302.projectName === "回放·工作台A" && wsTaskOverdue302.estimatedDays === 5 && wsTaskOverdue302.headcount === 6 && (wsTaskOverdue302.deliverableTypes === undefined ? [] : wsTaskOverdue302.deliverableTypes).join("|") === "CAD图纸|合同" && wsTaskOverdue302.note === "回放·进展描述：图纸已出，等待评审" && (wsTaskOverdue302.files === undefined ? [] : wsTaskOverdue302.files).length === 1 && wsTaskOverdue302.files[0].name === taskFileName,
  JSON.stringify(wsTaskOverdue302));
const wsTaskToday302 = wsTaskOf(tToday.id);
check("①c（Push 302）「变更关联」随行：今日任务 changeLinks 1 条、id 对齐", wsTaskToday302 !== undefined && (wsTaskToday302.changeLinks === undefined ? [] : wsTaskToday302.changeLinks).length === 1 && wsTaskToday302.changeLinks[0].id === changeId, JSON.stringify(wsTaskToday302 === undefined ? null : wsTaskToday302.changeLinks));
const wsIssueA1Full = wsIssueOf(issueA1.issue.id);
check("①d（Push 302）聚合面问题行随行 solution + photos 1 枚（文件名对齐）", wsIssueA1Full !== undefined && wsIssueA1Full.solution === issueSolution && (wsIssueA1Full.photos === undefined ? [] : wsIssueA1Full.photos).length === 1 && wsIssueA1Full.photos[0].name === pngName, JSON.stringify(wsIssueA1Full === undefined ? null : { solution: wsIssueA1Full.solution, photos: wsIssueA1Full.photos }));
check("①e（Push 302）聚合面随盘下发项目卡：三个测试项目都在 projects 里（项目经理列 / 回写不再逐项目回查）", (ws.projects === undefined ? [] : ws.projects).filter((item) => TEST_PROJECTS.indexOf(item.id) >= 0).length === 3, JSON.stringify((ws.projects === undefined ? [] : ws.projects).map((item) => item.id)));
const expectPanelOrder = [];
for (const group of ["overdue", "today", "upcoming", "unscheduled"]) {
  for (const task of ws.myTasks[group]) {
    if (expectPanelOrder.indexOf(task.projectId) === -1) expectPanelOrder.push(task.projectId);
  }
}
console.log("读面：全量 " + String(ambientTotal) + " 项 / " + String(expectPanelOrder.length) + " 个项目；测试项目收窄后 " + String(todayTest.length + upcomingTest.length + overdueTest.length + unscheduledTest.length) + " 项");
check("①b 基准日 = Asia/Shanghai 今天（" + TODAY + "）", ws.today === TODAY, String(ws.today));
check("①c 我的任务四组：今日 2 条（A 的今日 + B 的今日；按测试项目收窄）", todayTest.length === 2 && todayTest.indexOf(tToday.id) >= 0 && todayTest.indexOf(tB.id) >= 0, JSON.stringify(todayTest));
check("①d 我的任务四组：即将 2 条（A 的 +3 天与 +20 天 —— 原 7 天窗口已取消）、已逾期 1 条（A 的 -2 天）", upcomingTest.join(",") === [tUpcoming.id, tFar.id].join(",") && overdueTest.join(",") === tOverdue.id, JSON.stringify([upcomingTest, overdueTest]));
check("①d1 未排期单列一组：无预计完成日期照收（不再丢弃）", unscheduledTest.join(",") === tUnscheduled.id, JSON.stringify(unscheduledTest));
check("①d2 项目经理口径：远期那条负责人不是我（" + other.displayName + "）—— 因我是 A 项目项目经理而命中 upcoming", (ws.myTasks.upcoming.find((item) => item.id === tFar.id)?.ownerIds ?? []).indexOf(other.id) >= 0, JSON.stringify(ws.myTasks.upcoming.find((item) => item.id === tFar.id)?.ownerIds ?? null));
const myTaskIds = idsOf(ws.myTasks.today).concat(idsOf(ws.myTasks.upcoming), idsOf(ws.myTasks.overdue), idsOf(ws.myTasks.unscheduled));
check("①e 反例不进：他人项目任务（C —— 我既非负责人也非项目经理）与已完成任务都不进工作台", [tStranger.id, tDone.id].every((id) => myTaskIds.indexOf(id) === -1), JSON.stringify(myTaskIds));
const raisedTest = idsOf(inTest(ws.myIssues.raised));
check("①f 「我提出的」测试项目内 = 3 条（A 两条 + B 一条），不含 wmj 提出的那条（历史数据按测试项目收窄）", raisedTest.length === 3 && raisedTest.indexOf(issueA1.issue.id) >= 0 && raisedTest.indexOf(issueA2.issue.id) >= 0 && raisedTest.indexOf(issueB.issue.id) >= 0 && raisedTest.indexOf(issueOther.issue.id) === -1, JSON.stringify(raisedTest));
check("①g 「我提出的」未关闭在前：A 的未解决排在已完成那条之前", idsOf(ws.myIssues.raised).indexOf(issueA1.issue.id) < idsOf(ws.myIssues.raised).indexOf(issueA2.issue.id), JSON.stringify(idsOf(ws.myIssues.raised)));
const handlingTest = idsOf(inTest(ws.myIssues.handling));
const handlingAll = idsOf(ws.myIssues.handling);
check("①h（Push 260）「我处理的」测试项目内 = 3 条（A1 未解决 + A2 已完成 + B 的 wmj 提出那条），不含「我提出但未分派给我」的 issueB", handlingTest.length === 3 && [issueA1.issue.id, issueA2.issue.id, issueOther.issue.id].every((id) => handlingTest.indexOf(id) >= 0) && handlingTest.indexOf(issueB.issue.id) === -1, JSON.stringify(handlingTest));
check("①i（Push 260）「我处理的」未关闭在前：A2（已完成）排在 A1 之后（末位收尾）", handlingAll.indexOf(issueA1.issue.id) >= 0 && handlingAll.indexOf(issueA1.issue.id) < handlingAll.indexOf(issueA2.issue.id), JSON.stringify(handlingAll));

// ---------- 真机浏览器 ----------
const profile = mkdtempSync(join(tmpdir(), "pxm6ws-"));
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
await page.send("Log.enable");
await page.send("Network.setCookie", { name: "ll_sid", value: me.token, url: FRONTEND + "/", path: "/", httpOnly: true, secure: false });
await page.send("Network.setCookie", { name: "ll_csrf", value: me.csrf, url: FRONTEND + "/", path: "/", httpOnly: false, secure: false });
await page.send("Emulation.setDeviceMetricsOverride", { width: 1500, height: 1000, deviceScaleFactor: 1, mobile: false });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ev = async (expression) => {
  const reply = await page.send("Runtime.evaluate", { expression, returnByValue: true });
  if (reply.exceptionDetails !== undefined) throw new Error("页面表达式抛异常：" + JSON.stringify(reply.exceptionDetails).slice(0, 300) + " | " + expression.slice(0, 160));
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
async function open(path, waitSelector) {
  await page.send("Page.navigate", { url: "about:blank" });
  await sleep(400);
  await page.send("Page.navigate", { url: FRONTEND + "/" + path });
  const ok = await waitFor("document.querySelector(" + j(waitSelector) + ") !== null", 20000);
  if (!ok) throw new Error("页面没等到元素：" + waitSelector + "（" + path + "）");
  await sleep(600);
}
/** 悬停（Push 271）：把指针移到元素中心，触发 :hover（行悬停浮现 / 胶囊展开这类 hover 态断言用）。 */
async function hoverSelector(selector) {
  const point = await ev("(function(){var node=document.querySelector(" + j(selector) + ");if(node===null){return null;}var box=node.getBoundingClientRect();if(box.width<=0||box.height<=0){return null;}return {x:Math.round(box.left+box.width/2),y:Math.round(box.top+box.height/2)};})()");
  if (point === null) throw new Error("悬停定位失败：" + selector);
  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y, button: "none" });
  await sleep(160);
  return point;
}
async function rectOf(selector) {
  return await ev("(function(){var node=document.querySelector(" + j(selector) + ");if(node===null){return null;}var box=node.getBoundingClientRect();if(box.width<=0||box.height<=0){return null;}return {x:Math.round(box.left+box.width/2),y:Math.round(box.top+box.height/2)};})()");
}
async function clickSelector(selector) {
  const point = await rectOf(selector);
  if (point === null || point === undefined) throw new Error("点不到（元素不存在或不可见）：" + selector);
  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y, button: "none" });
  await page.send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1 });
  await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1 });
  await sleep(700);
}
/** Push 260：把鼠标停到「提出/负责的问题」标签上（悬停即展开下拉面板 —— 与项目页「日报及问题」同款交互）。 */
async function hoverRaisedTab() {
  const point = await rectOf("[data-workspace-tab=" + Q + "raised" + Q + "]");
  if (point === null || point === undefined) throw new Error("hover 不到 raised 标签");
  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y, button: "none" });
  await sleep(250);
}
/** Push 260：把鼠标挪到页面左侧空白（触发父标签 mouseleave → 下拉面板 160ms 后自动收起），免得面板盖住下一处点击目标。 */
async function parkMouse() {
  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 4, y: 300, button: "none" });
  await sleep(300);
}
/** 截图（Push 260：下拉子菜单 / 「待我处理的问题」页的形态证据；与其它回放脚本同一套落盘口径）。 */
async function shot(name) {
  await ev("window.scrollTo(0, 0)");
  await sleep(250);
  const result = await page.send("Page.captureScreenshot", { format: "png" });
  const file = join(SCREENSHOT_DIR, name);
  writeFileSync(file, Buffer.from(result.data, "base64"));
  console.log("截图：" + file);
  return file;
}
/** 先把元素滚进视口再点（面板列表长时，目标可能在首屏之外）—— Push 253 新增的「进入项目」点击穿透断言用。 */
async function scrollSelectorIntoView(selector) {
  await ev("(function(){var node=document.querySelector(" + j(selector) + ");if(node!==null){node.scrollIntoView({block:" + j("center") + "});}})()");
  await sleep(350);
}

/** Push 235 吸顶断言：元素几何 / 样式读数（不存在 = null）。 */
const stickyRect = (selector) => "(function(){var el=document.querySelector(" + j(selector) + ");if(el===null){return null;}var r=el.getBoundingClientRect();var cs=getComputedStyle(el);return {top:Math.round(r.top*100)/100,left:Math.round(r.left*100)/100,right:Math.round(r.right*100)/100,height:Math.round(r.height*100)/100,position:cs.position,zIndex:cs.zIndex,bg:String(cs.backgroundColor),blur:String(cs.backdropFilter||cs.webkitBackdropFilter)};})()";
/** 页头 + 标签栏读数。 */
const headExpr = () => "(function(){var tabs=document.querySelectorAll(" + j("[data-workspace-tab]") + ");var out=[];for(var i=0;i<tabs.length;i+=1){out.push({key:String(tabs[i].getAttribute(" + j("data-workspace-tab") + ")),text:tabs[i].textContent.trim(),current:tabs[i].getAttribute(" + j("aria-current") + ")});}var headerNode=document.querySelector(" + j("header") + ");return {page:document.querySelector(" + j("[data-workspace-page]") + ")!==null,tabs:out,hash:window.location.hash,header:headerNode===null?" + j("") + ":headerNode.textContent.trim()};})()";
/** 折叠面板读数（顺序即 DOM 顺序）。 */
const panelsExpr = () => "(function(){var root=document.querySelector(" + j("[data-workspace-page]") + ");if(root===null){return null;}var ps=root.querySelectorAll(" + j("[data-workspace-panel]") + ");var out=[];for(var i=0;i<ps.length;i+=1){var p=ps[i];var t=p.querySelector(" + j("[data-workspace-panel-toggle]") + ");out.push({id:String(p.getAttribute(" + j("data-workspace-panel") + ")),open:String(p.getAttribute(" + j("data-open") + ")),expanded:t===null?null:t.getAttribute(" + j("aria-expanded") + "),text:t===null?String(" + j("") + ") :t.textContent.trim(),rows:p.querySelectorAll(" + j("[data-workspace-task],[data-workspace-issue]") + ").length,link:(function(){var a=p.querySelector(" + j("[data-workspace-project-link]") + ");return a===null?null:String(a.getAttribute(" + j("href") + "));})(),linkText:(function(){var a=p.querySelector(" + j("[data-workspace-project-link]") + ");return a===null?String(" + j("") + ") :a.textContent.trim();})(),linkInToggle:p.querySelector(" + j("[data-workspace-panel-toggle] [data-workspace-project-link]") + ")!==null});}return out;})()";
/** 项目页任务表 15 列（TaskBoard.TABLE_COLUMNS 同序；「预计所需天数」窄列表头为空）——Push 231 扩列对账口径。 */
const TASK_HEAD_EXPECTED = ["任务描述", "项目经理", "任务负责人", "任务状态", "紧急重要度", "是否按时交付", "输出成果文件", "文件", "项目进展描述", "开始日期", "", "预计完成日期", "预计所需施工人数", "实际完成日期", "变更关联"];
/** 任务表读数（按项目面板）：表头（15 列）+ 每行按 data-column 列名取数（不按下标，列序调整不再连坐）。 */
const taskRowsExpr = (projectId) =>
  "(function(){var panel=document.querySelector(" + j('[data-workspace-panel="' + projectId + '"]') + ");if(panel===null){return null;}var table=panel.querySelector(" + j("[data-workspace-task-table]") + ");if(table===null){return {table:false};}var heads=table.querySelectorAll(" + j("[data-workspace-task-head] [data-column]") + ");var headTexts=[];for(var h=0;h<heads.length;h+=1){headTexts.push(heads[h].textContent.trim());}var rows=table.querySelectorAll(" + j("[data-workspace-task]") + ");var out=[];for(var i=0;i<rows.length;i+=1){var row=rows[i];var cell=function(key){var node=row.querySelector('[data-column=' + JSON.stringify(key) + ']');return node===null?'':node.textContent.trim();};var attr=function(name){var node=row.getAttribute(name)!==null?row:row.querySelector('[' + name + ']');return node===null?'':String(node.getAttribute(name));};var titleNode=row.querySelector('[data-column=\"title\"] p');var groupNode=null;var rowNode=row.querySelector('[role=button]');out.push({id:String(row.getAttribute(" + j("data-workspace-task") + ")),title:cell(" + j("title") + "),titleText:titleNode===null?'':titleNode.textContent.trim(),group:attr(" + j("data-workspace-task-group") + "),groupText:groupNode===null?'':groupNode.textContent.trim(),manager:cell(" + j("manager") + "),owners:cell(" + j("owner") + "),status:cell(" + j("status") + "),statusKey:attr(" + j("data-workspace-task-status") + "),priority:cell(" + j("priority") + "),onTime:cell(" + j("onTime") + "),deliverable:cell(" + j("deliverable") + "),files:cell(" + j("files") + "),note:cell(" + j("note") + "),start:cell(" + j("start") + "),days:cell(" + j("days") + "),due:cell(" + j("due") + "),headcount:cell(" + j("headcount") + "),doneDate:cell(" + j("doneDate") + "),change:cell(" + j("change") + "),changeCount:attr(" + j("data-workspace-task-change") + "),dots:attr(" + j("data-workspace-task-dots") + "),rowClass:rowNode===null?String(row.getAttribute(" + j("class") + ")):String(rowNode.getAttribute(" + j("class") + ")),statusClass:(function(){var n=row.querySelector('[data-column=\"status\"]');if(n===null){return '';}var b=n.querySelector('button');return String((b===null?n:b).getAttribute(" + j("class") + "));})(),rowInteractive:rowNode!==null});}return {table:true,heads:headTexts,rows:out};})()";
/** 问题表读数（按项目面板）。 */
/** Push 242 列对齐断言用：问题表表头每列的 [left, width]（四舍五入到整数像素）。 */
const issueHeadRectsExpr = (projectId) => "(function(){var panel=document.querySelector(" + j('[data-workspace-panel="' + projectId + '"]') + ");if(panel===null){return null;}var table=panel.querySelector(" + j("[data-workspace-issue-table]") + ");if(table===null){return null;}var heads=table.querySelectorAll(" + j("thead th") + ");var out=[];for(var i=0;i<heads.length;i+=1){var r=heads[i].getBoundingClientRect();out.push([Math.round(r.left),Math.round(r.width)]);}return out;})()";
/** Push 293 追订「炫彩下点这个进度条看不清」→「背景留白」「带弧度的」「绿回标配」：任务行四格进度点读数（第一行 4 颗按钮 + 点底槽 class；类名断口径 —— Tailwind v4 的斜杠透明度计算色不稳）。 */
const taskTrackerDotsExpr = (projectId) =>
  "(function(){var ps=document.querySelectorAll(" + j("[data-workspace-panel]") + ");var panel=null;for(var k=0;k<ps.length;k+=1){if(String(ps[k].getAttribute(" + j("data-workspace-panel") + "))===" + j(projectId) + "){panel=ps[k];break;}}if(panel===null){return null;}var table=panel.querySelector(" + j("[data-workspace-task-table]") + ");if(table===null){return {table:false};}var row=table.querySelector(" + j("[data-workspace-task]") + ");if(row===null){return {row:false};}var btns=row.querySelectorAll(" + j("button[aria-label]") + ");var out=[];var wrap=null;for(var i=0;i<btns.length;i+=1){var label=String(btns[i].getAttribute(" + j("aria-label") + "));if(label.indexOf(" + j("设置进度") + ")===0){out.push(String(btns[i].getAttribute(" + j("class") + ")));if(wrap===null&&btns[i].parentElement!==null){wrap=String(btns[i].parentElement.getAttribute(" + j("class") + "));}}}return {row:true,count:out.length,dots:out,wrap:wrap};})()";
const issueRowsExpr = (projectId) => "(function(){var panel=document.querySelector(" + j('[data-workspace-panel="' + projectId + '"]') + ");if(panel===null){return null;}var table=panel.querySelector(" + j("[data-workspace-issue-table]") + ");if(table===null){return {table:false};}var heads=table.querySelectorAll(" + j("thead th") + ");var headTexts=[];for(var h=0;h<heads.length;h+=1){headTexts.push(heads[h].textContent.trim());}var rows=table.querySelectorAll(" + j("tbody tr") + ");var out=[];for(var i=0;i<rows.length;i+=1){var cells=rows[i].querySelectorAll(" + j("td") + ");var link=rows[i].querySelector(" + j("a") + ");var photoNodes=rows[i].querySelectorAll(" + j("[data-issue-photo]") + ");var photoNames=[];for(var p=0;p<photoNodes.length;p+=1){photoNames.push(String(photoNodes[p].getAttribute(" + j("data-issue-photo") + ")));}out.push({id:String(rows[i].getAttribute(" + j("data-workspace-issue") + ")),date:cells[0].textContent.trim(),title:cells[1].textContent.trim(),categories:cells[2].textContent.trim(),owner:cells[3].textContent.trim(),solution:cells[4].textContent.trim(),photosText:cells[5].textContent.trim(),photos:photoNodes.length,photoNames:photoNames,state:cells[6].textContent.trim(),href:link===null?" + j("") + ":link.getAttribute(" + j("href") + "),rowClass:String(rows[i].getAttribute(" + j("class") + ")),stateClass:(function(){var n=rows[i].querySelector(" + j("[data-issue-state]") + ");return n===null?String(" + j("") + "):String(n.getAttribute(" + j("class") + "));})()});}return {table:true,heads:headTexts,rows:out};})()";
/** Push 260「要居中这个状态」几何读数：「问题是否处理」列表头 / 单元格 text-align + 色签与单元格的水平中心差 / 左右留白差。 */
const issueStateGeomExpr = (projectId) => "(function(){var panel=document.querySelector(" + j("[data-workspace-panel=" + Q + projectId + Q + "]") + ");if(panel===null){return null;}var table=panel.querySelector(" + j("[data-workspace-issue-table]") + ");if(table===null){return {table:false};}var heads=table.querySelectorAll(" + j("thead th") + ");var head=heads[6];var headAlign=getComputedStyle(head).textAlign;var headText=String(head.textContent.trim());var rows=table.querySelectorAll(" + j("tbody tr") + ");var out=[];for(var i=0;i<rows.length;i+=1){var cells=rows[i].querySelectorAll(" + j("td") + ");var cell=cells[6];var tag=cell.querySelector(" + j("[data-issue-state]") + ");var cr=cell.getBoundingClientRect();var tr=tag===null?null:tag.getBoundingClientRect();out.push({align:getComputedStyle(cell).textAlign,tag:tag===null?null:String(tag.textContent.trim()),cellCenter:Math.round((cr.left+cr.right)/2*100)/100,tagCenter:tr===null?null:Math.round((tr.left+tr.right)/2*100)/100,leftGap:tr===null?null:Math.round((tr.left-cr.left)*100)/100,rightGap:tr===null?null:Math.round((cr.right-tr.right)*100)/100,tagWidth:tr===null?null:Math.round(tr.width)});}return {table:true,headAlign:headAlign,headText:headText,rows:out};})()";
/** Push 260：工作台问题表某一行（状态列行内改的断言用）。 */
const wsIssueRow = (projectId, issueId) => "[data-workspace-panel=" + Q + projectId + Q + "] [data-workspace-issue=" + Q + issueId + Q + "]";
/** Push 260：「问题是否处理」行内下拉读数（触发器 / 展开态 / 色签 / 列对齐 / 浮层在不在）。 */
const stateCellExpr = (projectId, issueId) => "(function(){var row=document.querySelector(" + j(wsIssueRow(projectId, issueId)) + ");if(row===null){return null;}var trigger=row.querySelector(" + j("button[data-inline-cell]") + ");var tag=row.querySelector(" + j("[data-issue-state]") + ");var cell=tag===null?null:tag.closest(" + j("td") + ");return {trigger:trigger!==null,bare:trigger===null?null:trigger.getAttribute(" + j("data-inline-cell") + "),aria:trigger===null?null:String(trigger.getAttribute(" + j("aria-label") + ")),expanded:trigger===null?null:trigger.getAttribute(" + j("aria-expanded") + "),tagText:tag===null?null:String(tag.textContent.trim()),tagState:tag===null?null:String(tag.getAttribute(" + j("data-issue-state") + ")),tagClass:tag===null?null:String(tag.getAttribute(" + j("class") + ")),cellAlign:cell===null?null:String(getComputedStyle(cell).textAlign),popover:document.querySelector(" + j("[data-inline-popover]") + ")!==null};})()";
/** Push 260：行内下拉浮层的选项读数（浮层 portal 到 body）。 */
const popoverOptionsExpr = () => "(function(){var box=document.querySelector(" + j("[data-inline-popover]") + ");if(box===null){return null;}var items=box.querySelectorAll(" + j("[role=" + Q + "option" + Q + "]") + ");var out=[];for(var i=0;i<items.length;i+=1){out.push({text:String(items[i].textContent.trim()),selected:items[i].getAttribute(" + j("aria-selected") + ")});}return {listbox:box.querySelector(" + j("[role=" + Q + "listbox" + Q + "]") + ")!==null,count:items.length,items:out};})()";
const openStatePopover = (projectId, issueId) => "(document.querySelector(" + j("[data-inline-popover] [role=" + Q + "listbox" + Q + "]") + ") !== null)";
/** Push 279：「我的任务」任务行的外壳（data-workspace-task = 任务 id；内里 = 项目页同款 TaskRow）。 */
const taskRowSel = (projectId, taskId) => "[data-workspace-panel=" + Q + projectId + Q + "] [data-workspace-task=" + Q + taskId + Q + "]";
/** Push 279：任务详情抽屉（右侧滑出，与项目页同一枚 TaskRow 抽屉）。 */
const DRAWER = "aside[role=dialog]";
/** Push 279：按文案点行内下拉（data-inline-popover）里的选项（找不到直接报错）。 */
async function clickRowOption(text) {
  const point = await ev("(function(){var box=document.querySelector(" + j("[data-inline-popover]") + ");if(box===null){return null;}var items=box.querySelectorAll(" + j("[role=option]") + ");for(var i=0;i<items.length;i+=1){if(items[i].textContent.trim()===" + j(text) + "){var r=items[i].getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};}}return null;})()");
  if (point === null || point === undefined) throw new Error("行内下拉选项点不到：" + text);
  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y, button: "none" });
  await page.send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1 });
  await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1 });
  await sleep(700);
}

/** 空态 / 汇总行读数。 */
const totalExpr = () => "(function(){var node=document.querySelector(" + j("[data-workspace-task-total]") + ");return node===null?null:node.textContent.trim();})()";

// 浏览器辅助函数就绪后、首次开页前：把展开态偏好归零（保证 ③ 的「页面打开 = 全收起」口径成立）
const memoryResetAtStart = await patchOpenProjects({ tasks: [], raised: [] });
console.log("前置：展开态偏好归零 → " + (memoryResetAtStart === null ? "失败（后续断言会暴露）" : JSON.stringify(memoryResetAtStart.json.workspaceOpenProjects)));
// ---------- ② 页面骨架 ----------
await open("#/my-tasks", "[data-workspace-page]");
const head0 = await ev(headExpr());
check("②a 页面渲染出「我的任务」页（data-workspace-page）+ 顶栏页名", head0 !== null && head0.page === true && head0.header.indexOf("我的任务") >= 0, head0 === null ? "null" : JSON.stringify(head0.header.slice(0, 60)));
check("②b 标签导航栏 = 三枚下划线标签（我的任务 / 提出·负责的问题 / 我的计划 —— 第二枚 Push 260 由「我提出的问题」改名；文字，无图标）", head0 !== null && head0.tabs.length === 3 && head0.tabs.map((item) => item.text).join("|") === "我的任务|提出/负责的问题|我的计划" && head0.tabs.map((item) => item.key).join("|") === "tasks|raised|plan", head0 === null ? "null" : JSON.stringify([head0.tabs.map((item) => item.text), head0.tabs.map((item) => item.key)]));
check("②c 缺省选中「我的任务」、地址不带 ?tab=", head0 !== null && head0.tabs[0].current === "page" && head0.tabs[1].current === null && head0.tabs[2].current === null && head0.hash === "#/my-tasks", head0 === null ? "null" : JSON.stringify([head0.tabs.map((item) => item.current), head0.hash]));
const total0 = await ev(totalExpr());
check("②d 汇总行「共 " + String(ambientTotal) + " 项 · 跨 " + String(expectPanelOrder.length) + " 个项目 · 基准日 …」（N / M 与接口读面逐项对账）", typeof total0 === "string" && total0.indexOf("共 " + String(ambientTotal) + " 项") >= 0 && total0.indexOf("跨 " + String(expectPanelOrder.length) + " 个项目") >= 0 && total0.indexOf(cnDate(TODAY)) >= 0, String(total0));

// ---------- ③ 「我的任务」折叠面板 ----------
const panels0 = await ev(panelsExpr());
const panelsTest = panels0 === null ? null : panels0.filter((item) => TEST_PROJECTS.indexOf(item.id) >= 0);
const panelA0 = panels0 === null ? null : panels0.find((item) => item.id === projectA);
const panelB0 = panels0 === null ? null : panels0.find((item) => item.id === projectB);
check("③a 折叠面板 = 接口读面命中的项目、顺序 = 组序首次出现顺序（全量 " + String(expectPanelOrder.length) + " 块）", panels0 !== null && panels0.map((item) => item.id).join(",") === expectPanelOrder.join(","), panels0 === null ? "null" : JSON.stringify(panels0.map((item) => item.id)));
check("③b 测试项目 A / B 成块、C 无命中任务不成块", panelsTest !== null && panelsTest.length === 2 && panelsTest.map((item) => item.id).sort().join(",") === [projectA, projectB].sort().join(",") && panels0.every((item) => item.id !== projectC), panelsTest === null ? "null" : JSON.stringify(panelsTest.map((item) => item.id)));
check("③c 收起态 = 项目名称 + 编号（+ 摘要），且未展开时表体不在 DOM", panelA0 !== null && panelA0.open === "false" && panelA0.expanded === "false" && panelA0.rows === 0 && panelA0.text.indexOf("回放·工作台A") >= 0 && panelA0.text.indexOf(codeA) >= 0 && panelA0.text.indexOf("共 5 项") >= 0 && panelA0.text.indexOf("已逾期 1") >= 0 && panelA0.text.indexOf("今日 1") >= 0 && panelA0.text.indexOf("未排期 1") >= 0, panelA0 === null ? "null" : JSON.stringify(panelA0));
check("③d B 面板收起态：项目名 + 编号 + 共 1 项", panelB0 !== null && panelB0.text.indexOf("回放·工作台B") >= 0 && panelB0.text.indexOf(codeB) >= 0 && panelB0.text.indexOf("共 1 项") >= 0, panelB0 === null ? "null" : JSON.stringify(panelB0));

check("③e 面板头常驻「进入项目」按钮（Push 232 · 业务口径「增加进入项目按钮」）：A / B 各一枚、href = #/project/{id}、不在展开收起的子节点里", panelA0 !== null && panelB0 !== null && panelA0.link === "#/project/" + projectA && panelB0.link === "#/project/" + projectB && panelA0.linkText === "进入项目" && panelB0.linkText === "进入项目" && panelA0.linkInToggle === false && panelB0.linkInToggle === false, panelA0 === null || panelB0 === null ? "null" : JSON.stringify([panelA0, panelB0].map((item) => [item.link, item.linkText, item.linkInToggle])));

// ---------- ④ 展开 A：任务表口径（Push 231：项目页任务表全 15 列） ----------
await clickSelector('[data-workspace-panel="' + projectA + '"] [data-workspace-panel-toggle]');
const expanded = await ev(panelsExpr());
const expandedA = expanded === null ? null : expanded.find((item) => item.id === projectA);
check("④a 点一下面板头 = 展开（data-open=true / aria-expanded=true / 表体出现）", expandedA !== null && expandedA.open === "true" && expandedA.expanded === "true" && expandedA.rows === 5, expandedA === null ? "null" : JSON.stringify(expandedA));
const fullReady = await waitFor("(function(){var node=document.querySelector(" + j('[data-workspace-task-table][data-workspace-task-full="true"]') + ");return node!==null;})()", 25000);
check("④a1 全字段直出就绪（data-workspace-task-full=true 常真；15 列数据源来自聚合面，不再逐项目回填）", fullReady === true, String(fullReady));
const rowsA = await ev(taskRowsExpr(projectA));
const expectedOrder = [tOverdue.id, tToday.id, tUpcoming.id, tFar.id, tUnscheduled.id].join(",");
check("④b 任务表 5 行、顺序 = 已逾期 → 今日 → 即将（+3 → +20 远期）→ 未排期（最急在前、未排期收尾）", rowsA !== null && rowsA.table === true && rowsA.rows.map((item) => item.id).join(",") === expectedOrder, rowsA === null ? "null" : JSON.stringify(rowsA.rows.map((item) => item.id)));
check("④c 分组签不展示（业务口径「这个不要展示」：行里不再挂已逾期 / 今日待办 / 即将到期色签；组序改由行序体现）", rowsA !== null && rowsA.rows.every((item) => item.group === "" && item.groupText === "" && item.title.indexOf("已逾期") < 0 && item.title.indexOf("今日待办") < 0 && item.title.indexOf("即将到期") < 0), rowsA === null ? "null" : JSON.stringify(rowsA.rows.map((item) => [item.group, item.groupText])));
check("④d 状态签 = 项目页同款胶囊（服务端展示态：已延期 / 待开始 / 进行中；远期与未排期 = 待开始）", rowsA !== null && rowsA.rows.map((item) => item.status).join("|") === "已延期|待开始|进行中|待开始|待开始" && rowsA.rows.map((item) => item.statusKey).join("|") === "overdue|pending|active|pending|pending", rowsA === null ? "null" : JSON.stringify(rowsA.rows.map((item) => [item.status, item.statusKey])));
check("④e 日期三列 = 项目页同款短日期胶囊（开始 / 预计 / 实际；空值落「—」）", rowsA !== null && rowsA.rows.map((item) => item.start).join("|") === [mdDate(START_OVERDUE), mdDate(START_TODAY), "—", "—", "—"].join("|") && rowsA.rows.map((item) => item.due).join("|") === [DUE_OVERDUE, TODAY, DUE_UPCOMING, DUE_FAR].map(mdDate).concat("—").join("|") && rowsA.rows.every((item) => item.doneDate === "—"), rowsA === null ? "null" : JSON.stringify(rowsA.rows.map((item) => [item.start, item.due, item.doneDate])));
check("④f 四格进度点 = 项目页同款（0 / 0 / 0.5 —— 即将任务 50% 档）", rowsA !== null && rowsA.rows.map((item) => item.dots).join("|") === "0|0|0.5|0|0", rowsA === null ? "null" : JSON.stringify(rowsA.rows.map((item) => item.dots)));
check("④g 紧急重要度列 = 高 / 中 / 低", rowsA !== null && rowsA.rows.map((item) => item.priority).join("|") === "高|中|低|—|—", rowsA === null ? "null" : JSON.stringify(rowsA.rows.map((item) => item.priority)));
check("④h 任务主列 = 名称 + 阶段 / 英文名小行（B 项目面板块段落不串行）", rowsA !== null && rowsA.rows[0].titleText === "回放·逾期任务" && rowsA.rows[0].title.indexOf("设计开发") >= 0 && rowsA.rows[2].title.indexOf("临时任务") >= 0 && rowsA.rows[3].titleText === "回放·远期任务" && rowsA.rows[3].title.indexOf("设计开发") >= 0 && rowsA.rows[4].titleText === "回放·未排期任务", rowsA === null ? "null" : JSON.stringify(rowsA.rows.map((item) => item.titleText)));
check("④j 任务负责人列 = 我（" + me.displayName + "；远期那条为项目经理口径带入的 " + other.displayName + "）", rowsA !== null && rowsA.rows.map((item) => item.owners).join("|") === [me.displayName, me.displayName, me.displayName, other.displayName, me.displayName].join("|"), rowsA === null ? "null" : JSON.stringify(rowsA.rows.map((item) => item.owners)));
check("④k 「是否按时交付」列 = 逾期未交付 / — / —（displayStatus=overdue 的红签）", rowsA !== null && rowsA.rows.map((item) => item.onTime).join("|") === "逾期未交付|—|—|—|—", rowsA === null ? "null" : JSON.stringify(rowsA.rows.map((item) => item.onTime)));
check("④i 反例不出现：他人项目任务（C）与已完成任务不进；远期 / 未排期按新口径照进（服务端裁决，页面照单渲染）", rowsA !== null && [tStranger.id, tDone.id].every((id) => rowsA.rows.every((item) => item.id !== id)) && rowsA.rows.some((item) => item.id === tFar.id) && rowsA.rows.some((item) => item.id === tUnscheduled.id), rowsA === null ? "null" : JSON.stringify(rowsA.rows.map((item) => item.id)));
// —— Push 231 扩列（业务口径「这些字段一个不能少」）：表头 15 列与项目页 TABLE_COLUMNS 全对齐 + 新列逐列对账
check("④l 表头 = 项目页任务表全 15 列（同序；「预计所需天数」窄列表头为空）", rowsA !== null && rowsA.heads.join("|") === TASK_HEAD_EXPECTED.join("|"), rowsA === null ? "null" : JSON.stringify(rowsA.heads));
check("④m 项目经理列 = 项目主数据责任人（A 项目 = 我 —— " + me.displayName + "）", rowsA !== null && rowsA.rows.every((item) => item.manager === me.displayName), rowsA === null ? "null" : JSON.stringify(rowsA.rows.map((item) => item.manager)));
check("④n 输出成果文件列 = 首枚名 + 「+N」（CAD图纸+1 / 验收单 / —）", rowsA !== null && rowsA.rows.map((item) => item.deliverable).join("|") === "CAD图纸+1|验收单|—|—|—", rowsA === null ? "null" : JSON.stringify(rowsA.rows.map((item) => item.deliverable)));
check("④o（Push 279 起 = 项目页同款）文件列 = 文件名胶囊（逾期任务直传 1 份 → 首份文件名；无文件落「—」）", rowsA !== null && rowsA.rows[0].files.indexOf(taskFileName) >= 0 && rowsA.rows.slice(1).every((item) => item.files === "—"), rowsA === null ? "null" : JSON.stringify(rowsA.rows.map((item) => item.files)));
check("④p 项目进展描述列 = note 原文 / 「—」", rowsA !== null && rowsA.rows[0].note === "回放·进展描述：图纸已出，等待评审" && rowsA.rows.slice(1).every((item) => item.note === "—"), rowsA === null ? "null" : JSON.stringify(rowsA.rows.map((item) => item.note)));
check("④q 预计所需天数窄列 = 显式 5 / 推算 3（含首尾）/ 无开始日期落 0（项目页同口径）", rowsA !== null && rowsA.rows.map((item) => item.days).join("|") === "5|3|0|0|0", rowsA === null ? "null" : JSON.stringify(rowsA.rows.map((item) => item.days)));
check("④r 预计所需施工人数列 = 6 人 / 3 人 / —", rowsA !== null && rowsA.rows.map((item) => item.headcount).join("|") === "6 人|3 人|—|—|—", rowsA === null ? "null" : JSON.stringify(rowsA.rows.map((item) => item.headcount)));
check("④s 变更关联列 = 空单元格 / 「变更」琥珀签（今日任务挂 1 条）/ 空", rowsA !== null && rowsA.rows.map((item) => item.change).join("|") === "|变更|||" && rowsA.rows.map((item) => item.changeCount).join("|") === "0|1|0|0|0", rowsA === null ? "null" : JSON.stringify(rowsA.rows.map((item) => [item.change, item.changeCount])));
check("④t 扩列降级横幅整段下架（Push 302：聚合面全字段直出，partial 标记不再存在）", (await ev("document.querySelector(" + j("[data-workspace-task-partial]") + ") !== null")) === false, "partial=false");
await clickSelector('[data-workspace-panel="' + projectB + '"] [data-workspace-panel-toggle]');
const rowsB = await ev(taskRowsExpr(projectB));
check("④u 跨项目 B：1 行、项目经理 = " + me.displayName + "、" + other.displayName + "（多值「、」连接）、其余扩列落「—」", rowsB !== null && rowsB.table === true && rowsB.rows.length === 1 && rowsB.rows[0].id === tB.id && rowsB.rows[0].manager === me.displayName + "、" + other.displayName && rowsB.rows[0].deliverable === "—" && rowsB.rows[0].files === "—" && rowsB.rows[0].note === "—" && rowsB.rows[0].headcount === "—" && rowsB.rows[0].changeCount === "0", rowsB === null ? "null" : JSON.stringify(rowsB.rows));

// ---------- ④-2 任务行内编辑 + 点行开抽屉（Push 279 · 业务口径「做我的任务页面也可以点击编辑即可 编辑行 也在右侧出现抽屉」→「不用点开抽屉也要可以编辑」→「和项目总览一样」） ----------
const rowAnatomy279 = await ev("(function(){var row=document.querySelector(" + j(taskRowSel(projectA, tOverdue.id)) + ");if(row===null){return null;}var inner=row.querySelector(" + j("[role=button]") + ");var cell=function(key){return row.querySelector('[data-column=' + JSON.stringify(key) + ']');};var aria=function(key){var c=cell(key);if(c===null){return null;}var b=c.querySelector('button[data-inline-cell]');return b===null?null:String(b.getAttribute('aria-label'));};var titleCell=cell('title');var dotButtons=titleCell===null?[]:titleCell.querySelectorAll('button[aria-label]');var dots=0;for(var d=0;d<dotButtons.length;d+=1){if(String(dotButtons[d].getAttribute('aria-label')).indexOf('设置进度')===0){dots+=1;}}var fileCell=cell('files');return {row:inner!==null,status:aria('status'),priority:aria('priority'),owner:aria('owner'),manager:aria('manager'),note:aria('note'),dots:dots,filesPopover:fileCell!==null&&fileCell.querySelector(" + j("[data-cell-action=task-files]") + ")!==null};})()");
check("④v（Push 279）任务行 = 项目页同款可编辑行：整行 role=button、四格进度 = 4 枚可点按钮、「项目经理 / 负责人 / 状态 / 紧急重要度 / 进展描述」各有行内触发器、「文件」列是下拉入口", rowAnatomy279 !== null && rowAnatomy279.row === true && rowAnatomy279.manager === "修改项目经理" && rowAnatomy279.owner === "修改任务负责人" && rowAnatomy279.status === "修改任务状态" && rowAnatomy279.priority === "修改紧急重要度" && rowAnatomy279.note === "修改项目进展描述" && rowAnatomy279.dots === 4 && rowAnatomy279.filesPopover === true, JSON.stringify(rowAnatomy279));
await shot("m6-06-workspace-row-inline-edit.png");
await clickSelector(taskRowSel(projectA, tOverdue.id) + " [data-cell-action=task-files]");
const rowFilesPop279 = await waitFor("document.querySelector(" + j("[data-task-files-popover=true]") + ") !== null", 10000);
const rowFilesInfo279 = await ev("(function(){var p=document.querySelector(" + j("[data-task-files-popover=true]") + ");if(p===null){return null;}var items=p.querySelectorAll(" + j("[data-task-files-item]") + ");return {count:items.length,name:items.length===0?false:String(items[0].textContent).indexOf(" + j(taskFileName) + ")>=0,add:p.querySelector(" + j("[data-task-files-add]") + ")!==null};})()");
check("④v2（Push 279）「文件」列下拉 = 项目页同款（本任务那 1 份文件名在场 + 「＋ 添加文件」入口）—— 行内就能传文件", rowFilesPop279 === true && rowFilesInfo279 !== null && rowFilesInfo279.count === 1 && rowFilesInfo279.name === true && rowFilesInfo279.add === true, JSON.stringify(rowFilesInfo279));
const priorityCellSel279 = taskRowSel(projectA, tOverdue.id) + " [data-column=priority] button[data-inline-cell]";
const tasksBefore279 = await api("/api/v1/projects/" + projectA + "/tasks?limit=200");
const versionBefore279 = tasksBefore279.json === null ? -1 : tasksBefore279.json.items.filter((item) => item.id === tOverdue.id)[0].version;
await clickSelector(priorityCellSel279);
const priOpen279 = await waitFor("document.querySelector(" + j("[data-inline-popover] [role=listbox]") + ") !== null", 15000);
const priOpts279 = await ev(popoverOptionsExpr());
check("④w（Push 279）点「紧急重要度」胶囊 = 弹三档下拉（高 / 中 / 低，当前项「高」aria-selected=true）—— 与项目页下拉逐项同款", priOpen279 === true && priOpts279 !== null && priOpts279.count === 3 && priOpts279.items.map((item) => item.text).join("|") === "高|中|低" && priOpts279.items.map((item) => item.selected).join("|") === "true|false|false", JSON.stringify(priOpts279));
await clickRowOption("低");
const priChanged279 = await waitFor("(function(){var c=document.querySelector(" + j(taskRowSel(projectA, tOverdue.id) + " [data-column=priority]") + ");return c!==null&&c.textContent.trim()===" + j("低") + "&&document.querySelector(" + j("[data-inline-popover]") + ")===null;})()", 20000);
const tasksAfterPri279 = await api("/api/v1/projects/" + projectA + "/tasks?limit=200");
const overdueAfterPri279 = tasksAfterPri279.json === null ? undefined : tasksAfterPri279.json.items.filter((item) => item.id === tOverdue.id)[0];
check("④x（Push 279）行内改「紧急重要度」高 → 低：格子当场翻「低」、下拉收起；接口回读已落库（priority=低、version 涨 1）", priChanged279 === true && overdueAfterPri279 !== undefined && overdueAfterPri279.priority === "低" && overdueAfterPri279.version === versionBefore279 + 1, JSON.stringify([priChanged279, overdueAfterPri279 === undefined ? null : [overdueAfterPri279.priority, overdueAfterPri279.version, versionBefore279]]));
await clickSelector(priorityCellSel279);
await waitFor("document.querySelector(" + j("[data-inline-popover]") + ") !== null", 15000);
await clickRowOption("高");
const priRevert279 = await waitFor("(function(){var c=document.querySelector(" + j(taskRowSel(projectA, tOverdue.id) + " [data-column=priority]") + ");return c!==null&&c.textContent.trim()===" + j("高") + ";})()", 20000);
const tasksRevert279 = await api("/api/v1/projects/" + projectA + "/tasks?limit=200");
const overdueRevert279 = tasksRevert279.json === null ? undefined : tasksRevert279.json.items.filter((item) => item.id === tOverdue.id)[0];
check("④y（Push 279）再改回「高」复位（后面 ⑨ 的列断言不连坐）：页面 + 接口都是「高」", priRevert279 === true && overdueRevert279 !== undefined && overdueRevert279.priority === "高", JSON.stringify([priRevert279, overdueRevert279 === undefined ? null : overdueRevert279.priority]));
await clickSelector(taskRowSel(projectA, tOverdue.id) + " [data-column=title] p");
const drawerOpen279 = await waitFor("document.querySelector(" + j(DRAWER) + ") !== null", 20000);
const drawerInfo279 = await ev("(function(){var d=document.querySelector(" + j(DRAWER) + ");return d===null?null:{title:String(d.textContent).indexOf(" + j("回放·逾期任务") + ")>=0,noteField:d.querySelector(" + j("textarea") + ")!==null};})()");
check("④z（Push 279）不点编辑格、直接点任务描述 → 右侧任务抽屉滑出（标题 = 该任务、抽屉内「项目进展描述」可编辑）—— 行内编辑不挤掉点行开抽屉", drawerOpen279 === true && drawerInfo279 !== null && drawerInfo279.title === true && drawerInfo279.noteField === true, JSON.stringify(drawerInfo279));
await shot("m6-06-workspace-row-drawer.png");
await clickSelector("aside[role=dialog] button[aria-label=" + Q + "关闭任务详情" + Q + "]");
const drawerClosed279 = await waitFor("document.querySelector(" + j(DRAWER) + ")===null", 15000);
check("④z2（Push 279）抽屉「关闭任务详情」收口", drawerClosed279 === true, String(drawerClosed279));
await clickSelector('[data-workspace-panel="' + projectB + '"] [data-workspace-panel-toggle]');

// ---------- ⑤ 切标签 ----------
await clickSelector('[data-workspace-tab="raised"]');
await parkMouse(); // Push 260：点父标签顺带展开了下拉面板，先把鼠标挪开（面板自动收起）再做页内点击
const head1 = await ev(headExpr());
check("⑤a 点「我提出的问题」→ 地址写回 ?tab=raised（replace，可刷新 / 可分享）", head1 !== null && head1.hash === "#/my-tasks?tab=raised", head1 === null ? "null" : String(head1.hash));
check("⑤b 选中态转移（aria-current=page 只在「我提出的问题」上）", head1 !== null && head1.tabs[0].current === null && head1.tabs[1].current === "page", head1 === null ? "null" : JSON.stringify(head1.tabs.map((item) => item.current)));
const panels1 = await ev(panelsExpr());
const panelsIssues = panels1 === null ? null : panels1.filter((item) => TEST_PROJECTS.indexOf(item.id) >= 0);
check("⑤c 折回「我提出的问题」：面板按项目分组（A 共 1 条 / B 共 1 条 —— 已完成不显示，A2 不计；同日并列的项目序不作断言；历史数据按测试项目收窄）", panelsIssues !== null && panelsIssues.length === 2 && panelsIssues.every((item) => item.open === "false") && panelsIssues.map((item) => item.id).sort().join(",") === [projectA, projectB].sort().join(",") && panelsIssues.some((item) => item.id === projectA && item.text.indexOf("共 1 条") >= 0) && panelsIssues.some((item) => item.id === projectB && item.text.indexOf("共 1 条") >= 0), JSON.stringify(panels1));
const issueTotal = await ev("(function(){var node=document.querySelector(" + j("[data-workspace-issue-total]") + ");return node===null?null:node.textContent.trim();})()");
const raisedAll = idsOf(ws.myIssues.raised);
const raisedShown = ws.myIssues.raised.filter((item) => item.state !== "done");
const raisedShownIds = idsOf(raisedShown);
const raisedProjects = {};
for (const item of raisedShown) { raisedProjects[item.projectId] = true; }
check("⑤d 汇总行「共 N 条 · 跨 M 个项目 · 已完成不显示」（N / M = 接口读面剔除已完成后逐项对账）", typeof issueTotal === "string" && issueTotal.indexOf("共 " + String(raisedShownIds.length) + " 条") >= 0 && issueTotal.indexOf("跨 " + String(Object.keys(raisedProjects).length) + " 个项目") >= 0 && issueTotal.indexOf("已完成不显示") >= 0, String(issueTotal) + " | api " + String(raisedShownIds.length) + "/" + String(Object.keys(raisedProjects).length));

// ---------- ⑥ 问题表口径（参考「问题追踪」） ----------
await clickSelector('[data-workspace-panel="' + projectA + '"] [data-workspace-panel-toggle]');
const photoTileOk = await waitFor("document.querySelector(" + j('[data-workspace-panel="' + projectA + '"] [data-issue-photo]') + ") !== null", 25000);
check("⑥a0 问题附图瓦片懒取预览签名后出现（真 PNG 直传 → 预览就绪）", photoTileOk === true, String(photoTileOk));
const rowsIssueA = await ev(issueRowsExpr(projectA));
check("⑥a 表头 = 「问题追踪」完整七列（日期 / 问题描述 / 问题归类 / 问题处理人 / 责任人 / 解决方案或建议 / 问题附图 / 问题是否处理；Push 260 补处理人列）· 无行尾动作列（Push 242 下架）", rowsIssueA !== null && rowsIssueA.heads.length === 7 && rowsIssueA.heads.join("|") === "日期|问题描述|问题归类|问题处理人 / 责任人|解决方案或建议|问题附图|问题是否处理", rowsIssueA === null ? "null" : JSON.stringify(rowsIssueA.heads));
check("⑥b A 项目只显示 1 条（我提出的；A2 已完成 → 已完成不显示），行的 id = A1", rowsIssueA !== null && rowsIssueA.rows.length === 1 && rowsIssueA.rows[0].id === issueA1.issue.id && rowsIssueA.rows.every((item) => item.id !== issueA2.issue.id), rowsIssueA === null ? "null" : JSON.stringify(rowsIssueA.rows.map((item) => item.id)));
check("⑥c 日期列 = 提出日（年月日）", rowsIssueA !== null && rowsIssueA.rows.every((item) => item.date === cnDate(TODAY)), rowsIssueA === null ? "null" : JSON.stringify(rowsIssueA.rows.map((item) => item.date)));
check("⑥d 问题描述列 = 问题原文；归类列 = 色签（机械部）", rowsIssueA !== null && rowsIssueA.rows[0].title.indexOf("回放问题·我提出的未解决") >= 0 && rowsIssueA.rows[0].categories.indexOf("机械部") >= 0, rowsIssueA === null ? "null" : JSON.stringify(rowsIssueA.rows.map((item) => item.categories)));
check("⑥e 状态列 = 未解决（三态中文）；「已完成」的 A2 整行不显示（已完成不显示）", rowsIssueA !== null && rowsIssueA.rows.length === 1 && rowsIssueA.rows[0].state === "未解决" && rowsIssueA.rows.every((item) => item.id !== issueA2.issue.id), rowsIssueA === null ? "null" : JSON.stringify(rowsIssueA.rows.map((item) => [item.id, item.state])));
check("⑥d2（Push 260）「问题处理人 / 责任人」列 = 分派到人出姓名（A1 由我处理 = " + me.displayName + "）、未分派落灰杠「—」", rowsIssueA !== null && rowsIssueA.rows.length === 1 && rowsIssueA.rows[0].owner === me.displayName, rowsIssueA === null ? "null" : JSON.stringify(rowsIssueA.rows.map((item) => item.owner)));
check("⑥e0（Push 260）「问题是否处理」色签壳体 = 项目页同一档（rounded-lg + px-3 + py-1.5 + text-[11px]；底色 / 字色 = ISSUE_TAG_CLASS 同源）", rowsIssueA !== null && rowsIssueA.rows[0].stateClass.indexOf("rounded-lg") >= 0 && rowsIssueA.rows[0].stateClass.indexOf("px-3") >= 0 && rowsIssueA.rows[0].stateClass.indexOf("py-1.5") >= 0 && rowsIssueA.rows[0].stateClass.indexOf("text-[11px]") >= 0 && rowsIssueA.rows[0].stateClass.indexOf("bg-sky-100") >= 0 && rowsIssueA.rows[0].stateClass.indexOf("text-sky-700") >= 0 && rowsIssueA.rows.length === 1, rowsIssueA === null ? "null" : JSON.stringify(rowsIssueA.rows.map((item) => item.stateClass)));
const geomA260 = await ev(issueStateGeomExpr(projectA));
check("⑥e0b（Push 260）「要居中这个状态」：「问题是否处理」列表头 / 单元格一律 text-align=center，色签水平中心与单元格中心一致（±2px）、左右留白差 ≤4px", geomA260 !== null && geomA260.table === true && geomA260.headAlign === "center" && geomA260.headText === "问题是否处理" && geomA260.rows.length === 1 && geomA260.rows.every((item) => item.align === "center") && geomA260.rows.every((item) => item.tagCenter !== null && Math.abs(item.tagCenter - item.cellCenter) <= 2) && geomA260.rows.every((item) => Math.abs(item.leftGap - item.rightGap) <= 4), JSON.stringify(geomA260));
// Push 260：状态列行内可改（业务口径「我提出 我处理的问题这里的状态都要和项目内部一样可以点击」）
const cellIdle260 = await ev(stateCellExpr(projectA, issueA1.issue.id));
check("⑥e0c（Push 260）「问题是否处理」是行内下拉（与项目页「问题追踪」共用同一枚 IssueStateCell）：色签外套裸框触发器、aria 名 = 「修改问题状态（提出日）」、收起态 aria-expanded=false 且浮层不在 DOM 里；列内仍居中", cellIdle260 !== null && cellIdle260.trigger === true && cellIdle260.bare === "bare" && cellIdle260.aria.indexOf("修改问题状态") >= 0 && cellIdle260.aria.indexOf(cnDate(TODAY)) >= 0 && cellIdle260.expanded === "false" && cellIdle260.popover === false && cellIdle260.tagState === "open" && cellIdle260.tagText === "未解决" && cellIdle260.cellAlign === "center", JSON.stringify(cellIdle260));
await clickSelector(wsIssueRow(projectA, issueA1.issue.id) + " button[data-inline-cell]");
const popOpen260 = await waitFor(openStatePopover(projectA, issueA1.issue.id), 15000);
const popOptions260 = await ev(popoverOptionsExpr());
check("⑥e0d（Push 260）点状态色签 = 弹三态下拉（未解决 / 处理中 / 已完成，当前项 aria-selected=true）—— 与项目页下拉逐项同款", popOpen260 === true && popOptions260 !== null && popOptions260.listbox === true && popOptions260.count === 3 && popOptions260.items.map((item) => item.text).join("|") === "未解决|处理中|已完成" && popOptions260.items.map((item) => item.selected).join("|") === "true|false|false", JSON.stringify(popOptions260));
await shot("m6-06-workspace-state-dropdown.png");
const version260Before = await issueVersionOf(projectA, issueA1.issue.id);
await clickSelector("[data-inline-popover] [role=" + Q + "option" + Q + "]:nth-child(2)");
const moved260 = await waitFor("(function(){var row=document.querySelector(" + j(wsIssueRow(projectA, issueA1.issue.id)) + ");if(row===null){return false;}var tag=row.querySelector(" + j("[data-issue-state]") + ");return tag!==null&&String(tag.textContent.trim())===" + j("处理中") + "&&String(tag.getAttribute(" + j("class") + ")).indexOf(" + j("bg-amber-100") + ")>=0&&document.querySelector(" + j("[data-inline-popover]") + ")===null;})()", 20000);
const issuesAfter260 = await api("/api/v1/projects/" + projectA + "/issues");
const issueA1After260 = issuesAfter260.json === null ? undefined : (issuesAfter260.json.items === undefined ? [] : issuesAfter260.json.items).filter((item) => item.id === issueA1.issue.id)[0];
check("⑥e0e（Push 260）选「处理中」→ 色签当场翻 amber（乐观更新）、浮层关掉；接口回读已落库（state=in_progress、version 涨 1）", moved260 === true && issueA1After260 !== undefined && issueA1After260.state === "in_progress" && issueA1After260.version === version260Before + 1, JSON.stringify([moved260, issueA1After260 === undefined ? null : [issueA1After260.state, issueA1After260.version, version260Before]]));
await clickSelector(wsIssueRow(projectA, issueA1.issue.id) + " button[data-inline-cell]");
await waitFor(openStatePopover(projectA, issueA1.issue.id), 15000);
await clickSelector("[data-inline-popover] [role=" + Q + "option" + Q + "]:nth-child(1)");
const back260 = await waitFor("(function(){var row=document.querySelector(" + j(wsIssueRow(projectA, issueA1.issue.id)) + ");if(row===null){return false;}var tag=row.querySelector(" + j("[data-issue-state]") + ");return tag!==null&&String(tag.textContent.trim())===" + j("未解决") + "&&String(tag.getAttribute(" + j("class") + ")).indexOf(" + j("bg-sky-100") + ")>=0;})()", 20000);
const restoredRes260 = await api("/api/v1/projects/" + projectA + "/issues");
const issueA1Restored260 = restoredRes260.json === null ? undefined : (restoredRes260.json.items === undefined ? [] : restoredRes260.json.items).filter((item) => item.id === issueA1.issue.id)[0];
check("⑥e0f（Push 260）选回「未解决」→ 色签回 sky、接口回读 state=open（夹具复位，后面的断言基线不变）", back260 === true && issueA1Restored260 !== undefined && issueA1Restored260.state === "open", JSON.stringify([back260, issueA1Restored260 === undefined ? null : issueA1Restored260.state]));
check("⑥e1 「解决方案或建议」列 = 聚合面直出的解决方案原文", rowsIssueA !== null && rowsIssueA.rows.length === 1 && rowsIssueA.rows[0].solution.indexOf("回放·解决方案") >= 0, rowsIssueA === null ? "null" : JSON.stringify(rowsIssueA.rows.map((item) => item.solution)));
check("⑥e2 「问题附图」列 = A1 一枚真图瓦片（文件名对齐）", rowsIssueA !== null && rowsIssueA.rows.length === 1 && rowsIssueA.rows[0].photos === 1 && rowsIssueA.rows[0].photoNames[0] === pngName, rowsIssueA === null ? "null" : JSON.stringify(rowsIssueA.rows.map((item) => [item.photos, item.photoNames, item.photosText])));
const partialBanner = await ev("document.querySelector(" + j("[data-workspace-issue-partial]") + ") !== null");
check("⑥e3 七列无 partial 降级横幅（Push 302：问题行随行 solution / photos，partial 标记不再存在）", partialBanner === false, String(partialBanner));
const issuePanelLink = await ev("(function(){var a=document.querySelector(" + j('[data-workspace-panel="' + projectA + '"] [data-workspace-project-link]') + ");return a===null?null:String(a.getAttribute(" + j("href") + "));})()");
check("⑥f（Push 242 / Push 253）行尾「在项目中查看」下架（行内无链接）+ 入口 = 面板头「进入项目」→ 该项目「问题追踪」深链", rowsIssueA !== null && rowsIssueA.rows.every((item) => item.href === "") && issuePanelLink === "#/project/" + projectA + "?view=daily&sub=issues", JSON.stringify({ rowHref: rowsIssueA === null ? "null" : rowsIssueA.rows[0].href, panelLink: issuePanelLink }));
check("⑥g 不是我提出的（wmj 提的）不进这张表", rowsIssueA !== null && rowsIssueA.rows.every((item) => item.id !== issueOther.issue.id), rowsIssueA === null ? "null" : JSON.stringify(rowsIssueA.rows.map((item) => item.id)));
await clickSelector('[data-workspace-panel="' + projectB + '"] [data-workspace-panel-toggle]');
const rowsIssueB = await ev(issueRowsExpr(projectB));
const headRectsA = await ev(issueHeadRectsExpr(projectA));
const headRectsB = await ev(issueHeadRectsExpr(projectB));
check("⑥i（Push 242 / Push 260）列对齐：两个项目面板的问题表七列逐列同 x 同宽（table-fixed + colgroup）", headRectsA !== null && headRectsB !== null && headRectsA.length === 7 && JSON.stringify(headRectsA) === JSON.stringify(headRectsB), JSON.stringify({ a: headRectsA, b: headRectsB }));
check("⑥h 跨项目：B 面板 1 条（我提出的；处理人未分派落「—」、无解决方案 / 无附图落「—」）", rowsIssueB !== null && rowsIssueB.rows.length === 1 && rowsIssueB.rows[0].id === issueB.issue.id && rowsIssueB.rows[0].categories.indexOf("客观原因") >= 0 && rowsIssueB.rows[0].owner === "—" && rowsIssueB.rows[0].solution === "—" && rowsIssueB.rows[0].photos === 0 && rowsIssueB.rows[0].photosText === "—", rowsIssueB === null ? "null" : JSON.stringify(rowsIssueB.rows));

// Push 260：乐观锁冲突路径 —— 页内 version 落后时（别处刚改过）改状态要「失败 + 回滚 + 出提示条」，不静默丢
// 服务端「空更新」守卫：patch 无实际变化 → 400（issue.service.ts）—— 顶 version 要走一次真变化：
// open → in_progress → open（净状态仍是未解决、version +2，页面手里还是旧 version）。
const bump260a = await api("/api/v1/projects/" + projectA + "/issues/" + issueA1.issue.id, "PATCH", { state: "in_progress", version: await issueVersionOf(projectA, issueA1.issue.id) });
const bump260b = await api("/api/v1/projects/" + projectA + "/issues/" + issueA1.issue.id, "PATCH", { state: "open", version: await issueVersionOf(projectA, issueA1.issue.id) });
check("⑥j（Push 260）夹具：经接口把 A1 的 version 顶两格（先→处理中、再→未解决；模拟别处改过、页内 version 落后）", bump260a.status === 200 && bump260b.status === 200, String(bump260a.status) + "/" + String(bump260b.status));
await clickSelector(wsIssueRow(projectA, issueA1.issue.id) + " button[data-inline-cell]");
await waitFor(openStatePopover(projectA, issueA1.issue.id), 15000);
await clickSelector("[data-inline-popover] [role=" + Q + "option" + Q + "]:nth-child(2)");
const conflict260 = await waitFor("document.querySelector(" + j("[data-workspace-issue-error]") + ") !== null", 20000);
const cellAfterConflict260 = await ev(stateCellExpr(projectA, issueA1.issue.id));
const errorText260 = await ev("(function(){var n=document.querySelector(" + j("[data-workspace-issue-error]") + ");return n===null?null:String(n.textContent.trim());})()");
const stillRes260 = await api("/api/v1/projects/" + projectA + "/issues");
const issueA1Still260 = stillRes260.json === null ? undefined : (stillRes260.json.items === undefined ? [] : stillRes260.json.items).filter((item) => item.id === issueA1.issue.id)[0];
check("⑥k（Push 260）乐观锁冲突（409）：页面回滚成「未解决」（色签不假改）+ 出提示条（服务端文案）+ 接口回读没被改掉（state 仍 open）", conflict260 === true && cellAfterConflict260 !== null && cellAfterConflict260.tagText === "未解决" && cellAfterConflict260.tagState === "open" && cellAfterConflict260.popover === false && typeof errorText260 === "string" && errorText260.length > 0 && issueA1Still260 !== undefined && issueA1Still260.state === "open", JSON.stringify([conflict260, errorText260, cellAfterConflict260 === null ? null : cellAfterConflict260.tagText, issueA1Still260 === undefined ? null : issueA1Still260.state]));

// ---------- ⑦ 深链 / 未知参数 ----------
await open("#/my-tasks?tab=raised", "[data-workspace-page]");
const head2 = await ev(headExpr());
check("⑦a 深链 #/my-tasks?tab=raised 直接打开 = 「我提出的问题」选中（刷新 / 收藏 / 分享同款）", head2 !== null && head2.tabs[1].current === "page" && head2.hash === "#/my-tasks?tab=raised", head2 === null ? "null" : JSON.stringify([head2.tabs.map((item) => item.current), head2.hash]));
await open("#/my-tasks?tab=zzz", "[data-workspace-page]");
const head3 = await ev(headExpr());
check("⑦b ?tab= 不认识的值落回缺省「我的任务」（地址不纠正，与 ?view= 同口径）", head3 !== null && head3.tabs[0].current === "page" && head3.tabs[1].current === null && head3.tabs[2].current === null, head3 === null ? "null" : JSON.stringify(head3.tabs.map((item) => item.current)));
await open("#/my-tasks", "[data-workspace-page]");
await clickSelector('[data-workspace-tab="tasks"]');
const head4 = await ev(headExpr());
check("⑦c 从「我提出的问题」点回「我的任务」→ 地址回到不带参数的 #/my-tasks", head4 !== null && head4.hash === "#/my-tasks" && head4.tabs[0].current === "page", head4 === null ? "null" : String(head4.hash));

// —— Push 232：「进入项目」按钮（面板头深链 → 项目详情「项目总览」）
const linkHref = await ev("(function(){var a=document.querySelector(" + j('[data-workspace-panel="' + projectA + '"] [data-workspace-project-link]') + ");return a===null?null:String(a.getAttribute(" + j("href") + "));})()");
check("⑦d 「进入项目」href = 该项目详情「项目总览」深链（#/project/{id}，缺省标签不落参数）", linkHref === "#/project/" + projectA, String(linkHref));
await clickSelector('[data-workspace-panel="' + projectA + '"] [data-workspace-project-link]');
const enteredDetail = await waitFor("window.location.hash === " + j("#/project/" + projectA) + " && document.querySelector(" + j("[data-maintabs]") + ") !== null", 25000);
check("⑦e 点「进入项目」= 打开项目详情（地址 #/project/{id}、顶部标签栏出现）", enteredDetail === true, String(enteredDetail));
await ev("window.history.back()");
const backToWorkspace = await waitFor("document.querySelector(" + j("[data-workspace-page]") + ") !== null && window.location.hash === " + j("#/my-tasks"), 25000);
check("⑦f 浏览器后退回工作台（#/my-tasks 原样恢复、页面还在）", backToWorkspace === true, String(backToWorkspace));

// —— Push 253（业务口径 2026-10-08「我提出的问题点击进入项目直接进入到问题追踪页面」）：
// 「我提出的问题」面板头「进入项目」落点由该项目「日报记录」改「问题追踪」—— 真点一下：落该项目「日报及问题 → 问题追踪」。
await clickSelector("[data-workspace-tab=" + Q + "raised" + Q + "]");
await waitFor("window.location.hash === " + j("#/my-tasks?tab=raised") + " && document.querySelector(" + j("[data-workspace-panel=\"" + projectA + "\"] [data-workspace-panel-toggle]") + ") !== null", 25000);
await scrollSelectorIntoView("[data-workspace-panel=" + Q + projectA + Q + "] [data-workspace-project-link]");
const raisedLinkHref = await ev("(function(){var a=document.querySelector(" + j("[data-workspace-panel=\"" + projectA + "\"] [data-workspace-project-link]") + ");return a===null?null:String(a.getAttribute(" + j("href") + "));})()");
check("⑦g（Push 253）「我提出的问题」面板头「进入项目」href = 该项目「问题追踪」深链（?view=daily&sub=issues）", raisedLinkHref === "#/project/" + projectA + "?view=daily&sub=issues", String(raisedLinkHref));
await clickSelector("[data-workspace-panel=" + Q + projectA + Q + "] [data-workspace-project-link]");
const enteredIssueView = await waitFor("window.location.hash === " + j("#/project/" + projectA + "?view=daily&sub=issues") + " && document.querySelector(" + j("[data-issue-search]") + ") !== null", 25000);
check("⑦h（Push 253）点「进入项目」= 直达项目「日报及问题 → 问题追踪」（地址 ?view=daily&sub=issues、问题视图搜索框在场）", enteredIssueView === true, String(enteredIssueView));
const issueMainTab = await ev("(function(){var t=document.querySelector(" + j("[data-maintabs-item=\"日报及问题\"]") + ");return t===null?null:t.getAttribute(" + j("aria-current") + ");})()");
check("⑦i（Push 253）顶部标签停在「日报及问题」（主标签选中态）", issueMainTab === "page", String(issueMainTab));
await ev("window.history.back()");
const backToRaised = await waitFor("document.querySelector(" + j("[data-workspace-issues]") + ") !== null && window.location.hash === " + j("#/my-tasks?tab=raised"), 25000);
check("⑦j（Push 253）浏览器后退回工作台「我提出的问题」（?tab=raised 原样恢复）", backToRaised === true, String(backToRaised));
// ⑦ 段收尾：切回「我的任务」（与 Push 242 前的落点一致 —— ⑨ 背景档位段从任务表读起）
await clickSelector("[data-workspace-tab=" + Q + "tasks" + Q + "]");
await waitFor("window.location.hash === " + j("#/my-tasks") + " && document.querySelector(" + j("[data-workspace-page]") + ") !== null", 25000);
await ev("window.scrollTo(0, 0)");

// ---------- ⑨ 背景档位（Push 290 · 原「醒目模式」下架：观感统一走顶栏「背景 · 档位」；任务表 / 「我提出的问题」表随档位） ----------
/** 打开顶栏「背景 · 档位」弹层（没开才点开）。 */
async function openBgMenu() {
  const menuOpen = await ev("document.querySelector(" + j("[data-bg-tier-menu]") + ") !== null");
  if (menuOpen !== true) {
    await clickSelector("[data-bg-tier-trigger]");
    const opened = await waitFor("document.querySelector(" + j("[data-bg-tier-menu]") + ") !== null", 15000);
    if (opened !== true) throw new Error("背景档位菜单没打开");
  }
}
/** 点顶栏「背景 · 档位」里的一档：触发钮 →（菜单没开先点开）→ 选档 → 等触发钮文案落位。 */
async function setBgTier(tier, label) {
  await openBgMenu();
  await clickSelector("[data-bg-tier=" + Q + tier + Q + "]");
  const landed = await waitFor("(function(){var t=document.querySelector(" + j("[data-bg-tier-trigger]") + ");return t!==null&&String(t.textContent).indexOf(" + j(label) + ") >= 0;})()", 15000);
  if (landed !== true) throw new Error("背景档位没切到：" + tier);
}
const bgTriggerExpr = "(function(){var t=document.querySelector(" + j("[data-bg-tier-trigger]") + ");var nav=document.querySelector(" + j("[data-workspace-tabs]") + ");return t===null?null:{text:String(t.textContent.trim()),expanded:String(t.getAttribute(" + j("aria-expanded") + ")),inNav:nav!==null&&nav.contains(t)};})()";
// Push 291：档位改按账号落库 —— 起点先把账号值归一为「简约」作对照基线（Push 313 起账号默认 =「适中」；起点归一 + bgPrefStart 收尾恢复都不留痕、上次中断遗留也能自愈）
const bgLabelOf = { simple: "简约", medium: "适中", vivid: "炫彩" };
const bgPrefSnap = await api("/api/v1/users/me/preferences");
const bgPrefStart = bgPrefSnap.status === 200 && bgPrefSnap.json !== null && (bgPrefSnap.json.backgroundTier === "simple" || bgPrefSnap.json.backgroundTier === "vivid") ? bgPrefSnap.json.backgroundTier : "medium";
if (bgPrefStart !== "simple") {
  await api("/api/v1/users/me/preferences", "PATCH", { backgroundTier: "simple" });
  await open("#/my-tasks", "[data-workspace-page]");
  await waitFor("document.querySelector(" + j("[data-bg-tier-trigger]") + ") !== null", 25000);
}
const bg0 = await ev(bgTriggerExpr);
check("⑨a 观感开关 = 顶栏「背景 · 档位」（Push 290 原「醒目模式」开关下架：标签导航栏里不再有它）；回放基线「简约」（Push 291 起按账号落库；Push 313 起账号默认「适中」，本组起点先归一为「简约」作对照）", bg0 !== null && bg0.text.indexOf("背景") >= 0 && bg0.text.indexOf("简约") >= 0 && bg0.expanded === "false" && bg0.inNav === false, bg0 === null ? "null" : JSON.stringify(bg0));
/** 任务行 computed 底色（前 3 行 · 内层 role=button —— 适中档的行色铺在这层）。 */
const taskRowBgExpr = (projectId) => "(function(){var panel=document.querySelector(" + j("[data-workspace-panel=" + Q + projectId + Q + "]") + ");if(panel===null){return null;}var table=panel.querySelector(" + j("[data-workspace-task-table]") + ");if(table===null){return {table:false};}var rows=table.querySelectorAll(" + j("[data-workspace-task]") + ");var out=[];for(var i=0;i<3&&i<rows.length;i+=1){var node=rows[i].querySelector(" + j("[role=button]") + ");out.push(node===null?null:getComputedStyle(node).backgroundColor);}return {table:true,bgs:out};})()";
/** 问题行 computed 底色（逐行 tr）。 */
const issueRowBgExpr = (projectId) => "(function(){var panel=document.querySelector(" + j("[data-workspace-panel=" + Q + projectId + Q + "]") + ");if(panel===null){return null;}var table=panel.querySelector(" + j("[data-workspace-issue-table]") + ");if(table===null){return {table:false};}var rows=table.querySelectorAll(" + j("tbody tr") + ");var out=[];for(var i=0;i<rows.length;i+=1){out.push(getComputedStyle(rows[i]).backgroundColor);}return {table:true,bgs:out};})()";
const taskTintExpr = (projectId) => "(function(){var t=document.querySelector(" + j("[data-workspace-panel=" + Q + projectId + Q + "] [data-workspace-task-table]") + ");return t===null?null:String(t.getAttribute(" + j("data-workspace-task-tint") + "));})()";
const issueTintExpr = (projectId) => "(function(){var t=document.querySelector(" + j("[data-workspace-panel=" + Q + projectId + Q + "] [data-workspace-issue-table]") + ");return t===null?null:String(t.getAttribute(" + j("data-workspace-issue-tint") + "));})()";
await setBgTier("simple", "简约");
// Push 292 追订「选择后不要退出 用户点别的地方再退出」：切档后弹层保持打开；再点触发钮 / 点外才收起
const tierMenuKept = await ev("document.querySelector(" + j("[data-bg-tier-menu]") + ") !== null");
check("⑨a2 选档不收起弹层（Push 292 追订「选择后不要退出 用户点别的地方再退出」）：切「简约」后菜单仍开着", tierMenuKept === true, String(tierMenuKept));
await clickSelector("[data-bg-tier-trigger]");
const tierMenuClosed = await waitFor("document.querySelector(" + j("[data-bg-tier-menu]") + ") === null", 15000);
if (tierMenuClosed !== true) throw new Error("再点触发钮没收起弹层");
await waitFor("document.querySelector(" + j("[data-workspace-panel=" + Q + projectA + Q + "] [data-workspace-panel-toggle]") + ") !== null", 25000);
await ensurePanelOpen(projectA, true);
await waitFor("document.querySelector(" + j("[data-workspace-panel=" + Q + projectA + Q + "] [data-workspace-task]") + ") !== null", 25000);
const simpleTint = await ev(taskTintExpr(projectA));
const simpleRows = await ev(taskRowsExpr(projectA));
const simpleBgs = await ev(taskRowBgExpr(projectA));
check("⑨b 简约档 = 原系统观感：任务行白底（hover 档）+ 状态胶囊照旧（data-workspace-task-tint=false）", simpleTint === "false" && simpleRows !== null && simpleRows.rows[0].rowClass.indexOf("hover:bg-zinc-50/80") >= 0 && simpleRows.rows[0].statusClass.indexOf("bg-rose-100") >= 0 && simpleBgs !== null && simpleBgs.bgs[0] === "rgba(0, 0, 0, 0)", simpleRows === null ? "null" : JSON.stringify([simpleTint, simpleRows.rows[0].rowClass, simpleRows.rows[0].statusClass, simpleBgs === null ? null : simpleBgs.bgs]));
await setBgTier("medium", "适中");
const mediumAttr = await waitFor(taskTintExpr(projectA) + " === " + j("true"), 20000);
const mediumRows = await ev(taskRowsExpr(projectA));
const mediumBgs = await ev(taskRowBgExpr(projectA));
check("⑨c 适中档：任务表整行铺状态色（便签同款兑白 —— 已延期 rgb(253, 226, 231) / 待开始 rgb(219, 242, 252) / 进行中 rgb(254, 240, 218)）+ 状态列收口成深色字（oklch 自定色 · 无胶囊底）", mediumAttr === true && mediumRows !== null && mediumRows.rows.slice(0, 3).every((item) => item.rowClass.indexOf("task-row-tint") >= 0) && mediumRows.rows[0].statusClass.indexOf("oklch(52%_.26_16.44)") >= 0 && mediumRows.rows[1].statusClass.indexOf("oklch(53%_.18_237.32)") >= 0 && mediumRows.rows[2].statusClass.indexOf("oklch(58%_.20_70.08)") >= 0 && mediumRows.rows[0].statusClass.indexOf("bg-rose-100") < 0 && mediumBgs !== null && mediumBgs.bgs.join("|") === "rgb(253, 226, 231)|rgb(219, 242, 252)|rgb(254, 240, 218)", mediumRows === null ? "null" : JSON.stringify([mediumBgs === null ? null : mediumBgs.bgs, mediumRows.rows.slice(0, 3).map((item) => item.statusClass)]));
const mediumTrackerDots = await ev(taskTrackerDotsExpr(projectA));
check("⑨c2 进度点口径回归（Push 293 追订「炫彩下点这个进度条看不清」）：适中档四格点仍 = 点亮 emerald-500 / 空格 zinc-200，点底无白槽（炫彩背景留白不外溢）", mediumTrackerDots !== null && mediumTrackerDots.row === true && mediumTrackerDots.count === 4 && mediumTrackerDots.dots.every((cls) => cls.indexOf("bg-emerald-500") >= 0 || cls.indexOf("bg-zinc-200") >= 0) && mediumTrackerDots.dots.every((cls) => cls.indexOf("bg-emerald-700") < 0 && cls.indexOf("bg-zinc-900") < 0) && mediumTrackerDots.wrap !== null && mediumTrackerDots.wrap.indexOf("bg-white") < 0, mediumTrackerDots === null ? "null" : JSON.stringify([mediumTrackerDots.dots, mediumTrackerDots.wrap]));
await clickSelector("[data-workspace-tab=" + Q + "raised" + Q + "]");
await waitFor("document.querySelector(" + j("[data-workspace-panel=" + Q + projectA + Q + "] [data-workspace-panel-toggle]") + ") !== null", 25000);
await ensurePanelOpen(projectA, true);
await waitFor("document.querySelector(" + j("[data-workspace-panel=" + Q + projectA + Q + "] [data-workspace-issue]") + ") !== null", 25000);
const mediumIssueTint = await ev(issueTintExpr(projectA));
const mediumIssueRows = await ev(issueRowsExpr(projectA));
const mediumIssueBgs = await ev(issueRowBgExpr(projectA));
check("⑨d 切「我提出的问题」同款（档位跨标签、两表同源）：未解决行铺 sky 兑白 + 状态字 oklch 深蓝；已完成行不出现（已完成不显示）", mediumIssueTint === "true" && mediumIssueRows !== null && mediumIssueRows.rows.length === 1 && mediumIssueRows.rows[0].id === issueA1.issue.id && mediumIssueRows.rows[0].rowClass.indexOf("issue-row-tint") >= 0 && mediumIssueRows.rows[0].stateClass.indexOf("oklch(53%_.18_237.32)") >= 0 && mediumIssueRows.rows[0].stateClass.indexOf("bg-sky-100") < 0 && mediumIssueBgs !== null && mediumIssueBgs.bgs.join("|") === "rgb(219, 242, 252)", mediumIssueRows === null ? "null" : JSON.stringify([mediumIssueTint, mediumIssueRows.rows.map((item) => [item.id, item.rowClass, item.stateClass]), mediumIssueBgs === null ? null : mediumIssueBgs.bgs]));
// ⑨d2 炫彩档问题表（Push 293 · 业务口径「ok现在我们做炫彩 颜色饱和度偏高的色彩」）：同色相高饱和铺色 —— 未解决行 = sky 500 ×0.62 兑白
await setBgTier("vivid", "炫彩");
const vividIssueAttr = await waitFor(issueTintExpr(projectA) + " === " + j("true"), 20000);
const vividIssueRows2 = await ev(issueRowsExpr(projectA));
const vividIssueBgs2 = await ev(issueRowBgExpr(projectA));
check("⑨d2 炫彩档：问题表同色相高饱和铺色（未解决 = sky 500 ×0.62 兑白 = rgb(106, 199, 241)）+ 文字加深作用域（tint-vivid）挂上，状态列 oklch 深色字照旧", vividIssueAttr === true && vividIssueRows2 !== null && vividIssueRows2.rows.length === 1 && vividIssueRows2.rows[0].rowClass.indexOf("issue-row-tint") >= 0 && vividIssueRows2.rows[0].rowClass.indexOf("tint-vivid") >= 0 && vividIssueRows2.rows[0].stateClass.indexOf("oklch(53%_.18_237.32)") >= 0 && vividIssueBgs2 !== null && vividIssueBgs2.bgs.join("|") === "rgb(106, 199, 241)", vividIssueBgs2 === null ? "null" : JSON.stringify(vividIssueBgs2.bgs));
await setBgTier("simple", "简约");
const simpleIssueAttr = await waitFor(issueTintExpr(projectA) + " === " + j("false"), 20000);
const simpleIssueRows = await ev(issueRowsExpr(projectA));
const simpleIssueBgs = await ev(issueRowBgExpr(projectA));
check("⑨e 回切简约：问题表回白底行 + 状态签胶囊原样（仍只 1 行 —— 档位回切双向生效）", simpleIssueAttr === true && simpleIssueRows !== null && simpleIssueRows.rows.length === 1 && simpleIssueRows.rows[0].rowClass.indexOf("hover:bg-zinc-50/80") >= 0 && simpleIssueRows.rows[0].stateClass.indexOf("bg-sky-100") >= 0 && simpleIssueBgs !== null && simpleIssueBgs.bgs[0] === "rgba(0, 0, 0, 0)", simpleIssueRows === null ? "null" : JSON.stringify([simpleIssueRows.rows[0].rowClass, simpleIssueRows.rows[0].stateClass, simpleIssueBgs === null ? null : simpleIssueBgs.bgs]));
await clickSelector("[data-workspace-tab=" + Q + "tasks" + Q + "]");
await waitFor("document.querySelector(" + j("[data-workspace-panel=" + Q + projectA + Q + "] [data-workspace-panel-toggle]") + ") !== null", 25000);
await ensurePanelOpen(projectA, true);
await waitFor("document.querySelector(" + j("[data-workspace-panel=" + Q + projectA + Q + "] [data-workspace-task-table]") + ") !== null", 25000);
const backSimpleTint = await ev(taskTintExpr(projectA));
check("⑨f 切回「我的任务」：任务表也回简约档（data-workspace-task-tint=false —— 观感随档位、切标签不重置档位）", backSimpleTint === "false", String(backSimpleTint));
// ⑨f2 炫彩档任务表（Push 293）：同色相高饱和铺色 —— 已延期 / 待开始 / 进行中 三行 = 500 档 ×0.62 兑白
await setBgTier("vivid", "炫彩");
const vividTaskLanded = await waitFor(taskTintExpr(projectA) + " === " + j("true"), 20000);
const vividTaskRows = await ev(taskRowsExpr(projectA));
const vividTaskBgs = await ev(taskRowBgExpr(projectA));
check("⑨f2 炫彩档：任务表整行铺同色相高饱和色（= rgb(248, 136, 155)|rgb(106, 199, 241)|rgb(249, 195, 104)）+ 文字加深作用域（tint-vivid）挂上，状态列 oklch 深色字照旧", vividTaskLanded === true && vividTaskRows !== null && vividTaskRows.rows.slice(0, 3).every((item) => item.rowClass.indexOf("task-row-tint") >= 0 && item.rowClass.indexOf("tint-vivid") >= 0) && vividTaskRows.rows[0].statusClass.indexOf("oklch(52%_.26_16.44)") >= 0 && vividTaskRows.rows[1].statusClass.indexOf("oklch(53%_.18_237.32)") >= 0 && vividTaskRows.rows[2].statusClass.indexOf("oklch(58%_.20_70.08)") >= 0 && vividTaskBgs !== null && vividTaskBgs.bgs.join("|") === "rgb(248, 136, 155)|rgb(106, 199, 241)|rgb(249, 195, 104)", vividTaskBgs === null ? "null" : JSON.stringify(vividTaskBgs.bgs));
const vividTrackerDots = await ev(taskTrackerDotsExpr(projectA));
check("⑨f3 炫彩档进度点 = 胶囊白槽 + 标配绿（Push 293 追订「炫彩下点这个进度条看不清」→「背景留白」→「带弧度的」→「胶囊的绿回到之前的版本」）：四格点底 = 胶囊白槽（rounded-full + bg-white、无 backdrop-blur），点 = 点亮 emerald-500 / 空格 zinc-200（深配色 emerald-700 / zinc-900 已退场）", vividTrackerDots !== null && vividTrackerDots.row === true && vividTrackerDots.count === 4 && vividTrackerDots.dots.every((cls) => cls.indexOf("bg-emerald-500") >= 0 || cls.indexOf("bg-zinc-200") >= 0) && vividTrackerDots.dots.every((cls) => cls.indexOf("bg-emerald-700") < 0 && cls.indexOf("bg-zinc-900") < 0 && cls.indexOf("bg-white") < 0) && vividTrackerDots.wrap !== null && vividTrackerDots.wrap.indexOf("bg-white") >= 0 && vividTrackerDots.wrap.indexOf("rounded-full") >= 0 && vividTrackerDots.wrap.indexOf("backdrop-blur") < 0, vividTrackerDots === null ? "null" : JSON.stringify([vividTrackerDots.dots, vividTrackerDots.wrap]));
await setBgTier("simple", "简约");
// Push 291：切档 = 单键 PATCH backgroundTier（按账号记住）—— 切档落库 → 刷新保持 → 收尾恢复账号原值（不留痕）
await setBgTier("medium", "适中");
let bgPrefOn = null;
for (let i = 0; i < 30; i += 1) {
  bgPrefOn = await api("/api/v1/users/me/preferences");
  if (bgPrefOn.status === 200 && bgPrefOn.json !== null && bgPrefOn.json.backgroundTier === "medium") break;
  await sleep(500);
}
check("⑨g 切档落库（Push 291 · 业务口径「当前背景选择后刷新就没了 要按账号记住」）：切「适中」= 单键 PATCH backgroundTier=medium（GET 回读，按账号跨设备记忆）", bgPrefOn !== null && bgPrefOn.status === 200 && bgPrefOn.json !== null && bgPrefOn.json.backgroundTier === "medium", bgPrefOn === null ? "null" : JSON.stringify(bgPrefOn.json === null ? bgPrefOn.status : bgPrefOn.json.backgroundTier));
await open("#/my-tasks", "[data-workspace-page]");
const bgReloadLanded = await waitFor("(function(){var t=document.querySelector(" + j("[data-bg-tier-trigger]") + ");return t!==null&&String(t.textContent).indexOf(" + j("适中") + ") >= 0;})()", 15000);
const bgReload = await ev(bgTriggerExpr);
check("⑨h 刷新保持：重开页仍是「适中」（档位 = 账号偏好读面回填，不再是内存 store 刷新回默认）", bgReloadLanded === true && bgReload !== null && bgReload.text.indexOf("适中") >= 0, bgReload === null ? "null" : JSON.stringify(bgReload));
await setBgTier(bgPrefStart, bgLabelOf[bgPrefStart]);
let bgPrefBack = null;
for (let i = 0; i < 30; i += 1) {
  bgPrefBack = await api("/api/v1/users/me/preferences");
  if (bgPrefBack.status === 200 && bgPrefBack.json !== null && bgPrefBack.json.backgroundTier === bgPrefStart) break;
  await sleep(500);
}
await open("#/my-tasks", "[data-workspace-page]");
const bgBackLanded = await waitFor("(function(){var t=document.querySelector(" + j("[data-bg-tier-trigger]") + ");return t!==null&&String(t.textContent).indexOf(" + j(bgLabelOf[bgPrefStart]) + ") >= 0;})()", 15000);
const bgTierBack = await ev(bgTriggerExpr);
check("⑨i 回放收尾：账号偏好 backgroundTier 恢复原值（不留痕）且重开页档位与账号一致", bgPrefBack !== null && bgPrefBack.status === 200 && bgPrefBack.json !== null && bgPrefBack.json.backgroundTier === bgPrefStart && bgBackLanded === true && bgTierBack !== null && bgTierBack.text.indexOf(bgLabelOf[bgPrefStart]) >= 0, JSON.stringify([bgPrefBack === null ? null : bgPrefBack.json === null ? bgPrefBack.status : bgPrefBack.json.backgroundTier, bgTierBack]));
// ⑨j 卡片水印开关（Push 292 · 业务口径「增加一个水印选项 可以选择是否要水印」；Push 313 起默认关）：背景菜单第四行 =「水印」开关；点击 = 单键 PATCH cardWatermark、刷新保持、收尾恢复原值
const wmRowExpr = "(function(){var n=document.querySelector(" + j("[data-bg-watermark]") + ");return n===null?null:{state:String(n.getAttribute(" + j("data-bg-watermark") + ")),checked:String(n.getAttribute(" + j("aria-checked") + ")),label:String(n.textContent.trim())};})()";
const wmStateExpr = "(function(){var n=document.querySelector(" + j("[data-bg-watermark]") + ");return n===null?null:String(n.getAttribute(" + j("data-bg-watermark") + "));})()";
const wmPrefSnap = await api("/api/v1/users/me/preferences");
const wmPrefStart = wmPrefSnap.status === 200 && wmPrefSnap.json !== null && wmPrefSnap.json.cardWatermark === true;
const wmFlip = wmPrefStart === false;
await openBgMenu();
await waitFor("document.querySelector(" + j("[data-bg-watermark]") + ") !== null", 15000);
const wm0 = await ev(wmRowExpr);
check("⑨j 水印开关在场：背景菜单第四行 =「水印」（开关态 = 账号偏好 cardWatermark；Push 313 起账号默认 = 关）", wm0 !== null && wm0.label.indexOf("水印") >= 0 && wm0.state === (wmPrefStart ? "on" : "off") && wm0.checked === String(wmPrefStart), wm0 === null ? "null" : JSON.stringify([wm0, wmPrefStart]));
await clickSelector("[data-bg-watermark]");
const wmMenuStillOpen = await ev("document.querySelector(" + j("[data-bg-tier-menu]") + ") !== null");
let wmPrefOn = null;
for (let i = 0; i < 30; i += 1) {
  wmPrefOn = await api("/api/v1/users/me/preferences");
  if (wmPrefOn.status === 200 && wmPrefOn.json !== null && wmPrefOn.json.cardWatermark === wmFlip) break;
  await sleep(500);
}
check("⑨j2 点「水印」= 单键 PATCH cardWatermark（GET 回读翻转值；开关行是设定项、菜单保持打开）", wmPrefOn !== null && wmPrefOn.status === 200 && wmPrefOn.json !== null && wmPrefOn.json.cardWatermark === wmFlip && wmMenuStillOpen === true, wmPrefOn === null ? "null" : JSON.stringify([wmPrefOn.json === null ? wmPrefOn.status : wmPrefOn.json.cardWatermark, wmMenuStillOpen]));
await open("#/my-tasks", "[data-workspace-page]");
await openBgMenu();
const wmLanded = await waitFor(wmStateExpr + " === " + j(wmFlip ? "on" : "off"), 15000);
check("⑨j3 刷新保持：重开页开关态 = 账号值（水印设置随账号记住）", wmLanded === true, String(await ev(wmStateExpr)));
await clickSelector("[data-bg-watermark]");
let wmPrefBack = null;
for (let i = 0; i < 30; i += 1) {
  wmPrefBack = await api("/api/v1/users/me/preferences");
  if (wmPrefBack.status === 200 && wmPrefBack.json !== null && wmPrefBack.json.cardWatermark === wmPrefStart) break;
  await sleep(500);
}
check("⑨j4 回放收尾：cardWatermark 恢复原值（不留痕）", wmPrefBack !== null && wmPrefBack.status === 200 && wmPrefBack.json !== null && wmPrefBack.json.cardWatermark === wmPrefStart, wmPrefBack === null ? "null" : JSON.stringify(wmPrefBack.json === null ? wmPrefBack.status : wmPrefBack.json.cardWatermark));
await open("#/my-tasks", "[data-workspace-page]");

// ---------- ⑩ 折叠面板展开态记忆（Push 233 · 业务口径「这个下拉要有记忆」） ----------
const resetMemory = await patchOpenProjects({ tasks: [], raised: [] });
check("⑩a 前置：展开态偏好归零（GET 回读两个空数组）", resetMemory !== null && resetMemory.json.workspaceOpenProjects.tasks.length === 0 && resetMemory.json.workspaceOpenProjects.raised.length === 0, resetMemory === null ? "null" : JSON.stringify(resetMemory.json.workspaceOpenProjects));
await open("#/my-tasks", "[data-workspace-page]");
await waitFor("document.querySelector(" + j('[data-workspace-panel="' + projectA + '"]') + ") !== null", 25000);
const memory0A = await ev(panelOpenOf(projectA));
const memory0B = await ev(panelOpenOf(projectB));
check("⑩b 偏好为空：两个折叠面板默认全收起（data-open=false、无表格行）", memory0A !== null && memory0A.open === "false" && memory0A.rows === 0 && memory0B !== null && memory0B.open === "false" && memory0B.rows === 0, JSON.stringify([memory0A, memory0B]));
await clickSelector('[data-workspace-panel="' + projectA + '"] [data-workspace-panel-toggle]');
await waitFor("document.querySelector(" + j('[data-workspace-panel="' + projectA + '"] [data-workspace-task]') + ") !== null", 25000);
const memory1A = await ev(panelOpenOf(projectA));
const memory1B = await ev(panelOpenOf(projectB));
check("⑩c 点开 A：A 展开（任务行出现）、B 仍收起", memory1A !== null && memory1A.open === "true" && memory1A.rows === 5 && memory1B !== null && memory1B.open === "false" && memory1B.rows === 0, JSON.stringify([memory1A, memory1B]));
const savedTasks = await waitOpenProjects({ tasks: [projectA], raised: [] });
check("⑩d 展开即单键 PATCH 落库：workspaceOpenProjects.tasks = [A]、raised 仍空（按账号跨设备记忆）", savedTasks !== null && savedTasks.json.workspaceOpenProjects.tasks.length === 1 && savedTasks.json.workspaceOpenProjects.tasks[0] === projectA && savedTasks.json.workspaceOpenProjects.raised.length === 0, savedTasks === null ? "null" : JSON.stringify(savedTasks.json.workspaceOpenProjects));
await open("#/my-tasks", "[data-workspace-page]");
await waitFor("document.querySelector(" + j('[data-workspace-panel="' + projectA + '"] [data-workspace-task]') + ") !== null", 25000);
const memory2A = await ev(panelOpenOf(projectA));
const memory2B = await ev(panelOpenOf(projectB));
check("⑩e 刷新（about:blank 后整页重开）后记忆生效：A 仍展开、B 仍收起", memory2A !== null && memory2A.open === "true" && memory2A.rows === 5 && memory2B !== null && memory2B.open === "false" && memory2B.rows === 0, JSON.stringify([memory2A, memory2B]));
await clickSelector('[data-workspace-tab="raised"]');
await waitFor("document.querySelector(" + j("[data-workspace-issues]") + ") !== null", 25000);
const memory3A = await ev(panelOpenOf(projectA));
const memory3B = await ev(panelOpenOf(projectB));
check("⑩f 切「我提出的问题」：两面板全收起（tasks 的展开不串到 raised —— 两标签各自独立记忆）", memory3A !== null && memory3A.open === "false" && memory3A.rows === 0 && memory3B !== null && memory3B.open === "false" && memory3B.rows === 0, JSON.stringify([memory3A, memory3B]));
await clickSelector('[data-workspace-panel="' + projectB + '"] [data-workspace-panel-toggle]');
await waitFor("document.querySelector(" + j('[data-workspace-panel="' + projectB + '"] [data-workspace-issue]') + ") !== null", 25000);
const savedRaised = await waitOpenProjects({ tasks: [projectA], raised: [projectB] });
check("⑩g 展开 raised 的 B：落库 tasks 仍 [A]、raised = [B]（同一对象两键互不覆盖）", savedRaised !== null && JSON.stringify(savedRaised.json.workspaceOpenProjects) === JSON.stringify({ tasks: [projectA], raised: [projectB] }), savedRaised === null ? "null" : JSON.stringify(savedRaised.json.workspaceOpenProjects));
await clickSelector('[data-workspace-tab="tasks"]');
await waitFor("document.querySelector(" + j('[data-workspace-panel="' + projectA + '"] [data-workspace-task]') + ") !== null", 25000);
const memory4B = await ev(panelOpenOf(projectB));
check("⑩h 切回「我的任务」：A 仍展开（记忆未丢）、B 仍收起（raised 的展开不串台）", memory4B !== null && memory4B.open === "false" && memory4B.rows === 0, JSON.stringify(memory4B));
await clickSelector('[data-workspace-panel="' + projectA + '"] [data-workspace-panel-toggle]');
await waitFor(panelOpenOf(projectA) + ".open === " + j("false"), 20000);
const memory5A = await ev(panelOpenOf(projectA));
const collapsedSaved = await waitOpenProjects({ tasks: [], raised: [projectB] });
check("⑩i 收起 A：界面立即收起 + 落库 tasks 清空、raised 仍保留 [B]（「收起」也被记住）", memory5A !== null && memory5A.open === "false" && memory5A.rows === 0 && collapsedSaved !== null && JSON.stringify(collapsedSaved.json.workspaceOpenProjects) === JSON.stringify({ tasks: [], raised: [projectB] }), JSON.stringify([memory5A, collapsedSaved === null ? "null" : collapsedSaved.json.workspaceOpenProjects]));
await open("#/my-tasks", "[data-workspace-page]");
await waitFor("document.querySelector(" + j('[data-workspace-panel="' + projectA + '"]') + ") !== null", 25000);
const memory6A = await ev(panelOpenOf(projectA));
const memory6B = await ev(panelOpenOf(projectB));
check("⑩j 收起后刷新：两面板保持全收起（空数组 = 全收起，不是「无记录 = 默认展开」）", memory6A !== null && memory6A.open === "false" && memory6A.rows === 0 && memory6B !== null && memory6B.open === "false" && memory6B.rows === 0, JSON.stringify([memory6A, memory6B]));
const memoryRestored = await patchOpenProjects(memoryOriginal);
check("⑩k 回放收尾：账号偏好 workspaceOpenProjects 恢复原值（不留痕）", memoryRestored !== null && JSON.stringify(memoryRestored.json.workspaceOpenProjects) === JSON.stringify(memoryOriginal), memoryRestored === null ? "null" : JSON.stringify([memoryRestored.json.workspaceOpenProjects, memoryOriginal]));

// ---------- ⑪ 「我的计划」便签墙（Push 234 标签 / 路由就位 → Push 266 页面落地 → Push 268 纯白底 + 排序下架 + 完成态 + 账号落库） ----------
// 本刀验：第三枚标签 / 点击 / 深链照旧；页内 = 便签墙（账号落库：GET/PATCH prefs.myPlanBoard —— 前置重置为确定性 6 条示例、收尾恢复账号快照）——
// 照搬口径（白底 / 卡片尺寸 / 调色板 + 编辑（填写）弹窗：⑪c3 新建态 / ⑪g2 编辑态 / ⑪n2 关闭 X）对账 + 新建（空标题 / 空内容保存置灰）/ 编辑 /
// 搜索 / 分类过滤 / 拖拽完成 + 「已完成」视图 / 拖拽恢复 / 删除（二次确认）/ 刷新持久化（GET preferences 对账）/ 首次预置上云 / 旧键迁移；导出 / 导入不做。
const NOTE_CREATED_TITLE = "回放·便签甲改";
const LEGACY_PLAN_KEY = "libiaolink.plan.board.v1";
// Push 268 前置：便签墙已落库 —— 先快照账号偏好整行（收尾原样放回，⑪ 段不留痕），再把 myPlanBoard 重置为确定性 6 条示例 + 默认六类 + 背景默认白（Push 271，保证复跑确定性）；
// 页面读的就是这份确定性数据（时间固定 → 固定「最近更新」序 = 本周重点 → 随手记 稳定）。
const planPrefSnapshot = (await db.query("select prefs, updated_at, (prefs -> 'myPlanBoard') as board from user_preferences where user_id = $1", [me.id])).rows[0] ?? null;
const planBoardBefore = planPrefSnapshot === null || planPrefSnapshot.board === null ? null : planPrefSnapshot.board;
const PLAN_FIXED_SEEDS = {
  notes: [
    { id: "pn-seed-1", title: "本周重点", content: "1: 跟进印度项目的任务排期；2: 整理周五评审材料", category: "待办", colorId: "yellow", fontId: "sans", done: false, createdAt: "2026-10-10T02:00:00.000Z", updatedAt: "2026-10-10T07:00:00.000Z" },
    { id: "pn-seed-2", title: "想法速记", content: "便签墙：颜色分类 + 搜索；做完的收进「已完成」。", category: "想法", colorId: "blue", fontId: "sans", done: false, createdAt: "2026-10-09T06:00:00.000Z", updatedAt: "2026-10-10T05:00:00.000Z" },
    { id: "pn-seed-3", title: "会议要点", content: "周一例会：验收节点提前到月底。", category: "工作", colorId: "white", fontId: "sans", done: false, createdAt: "2026-10-08T06:00:00.000Z", updatedAt: "2026-10-09T10:00:00.000Z" },
    { id: "pn-seed-4", title: "采购清单", content: "A4 打印纸 / 标签机色带 / 白板笔", category: "采购", colorId: "green", fontId: "mono", done: false, createdAt: "2026-10-07T06:00:00.000Z", updatedAt: "2026-10-09T02:00:00.000Z" },
    { id: "pn-seed-5", title: "读书清单", content: "《人月神话》《凤凰项目》《持续交付》", category: "个人", colorId: "pink", fontId: "serif", done: false, createdAt: "2026-10-06T06:00:00.000Z", updatedAt: "2026-10-08T02:00:00.000Z" },
    { id: "pn-seed-6", title: "随手记", content: "便签跟着账号走；重要内容自己留个底。", category: "其他", colorId: "purple", fontId: "sans", done: false, createdAt: "2026-10-05T06:00:00.000Z", updatedAt: "2026-10-07T02:00:00.000Z" },
  ],
  categories: ["待办", "工作", "想法", "采购", "个人", "其他"],
  bg: "white",
};
const planReset = await api("/api/v1/users/me/preferences", "PATCH", { myPlanBoard: PLAN_FIXED_SEEDS });
check("⑪a0 前置：便签墙重置为确定性 6 条示例 + 默认六类 + 背景默认白（账号已落库；快照已存、收尾恢复）", planReset !== null && planReset.status === 200 && planReset.json !== null && planReset.json.myPlanBoard.notes.length === 6 && planReset.json.myPlanBoard.updatedAt !== null, planReset === null ? "null" : JSON.stringify([planReset.status, planReset.json === null ? null : planReset.json.myPlanBoard.notes.length]));
/** 便签墙读数：计数文案 + 卡片（DOM 顺序 = 当前排序；带卡片 class 供颜色 / 字体对账）+ 网格 / 空态 / 任务·问题表 + 提示条文案。 */
const planExpr = () => "(function(){var root=document.querySelector(" + j("[data-workspace-plan]") + ");if(root===null){return null;}var count=root.querySelector(" + j("[data-plan-count]") + ");var cards=root.querySelectorAll(" + j("[data-plan-note]") + ");var out=[];for(var i=0;i<cards.length;i+=1){var t=cards[i].querySelector(" + j("[data-plan-note-title]") + ");var c=cards[i].querySelector(" + j("[data-plan-note-category]") + ");out.push({id:String(cards[i].getAttribute(" + j("data-plan-note") + ")),title:t===null?String(" + j("") + "):t.textContent.trim(),category:c===null?String(" + j("") + "):c.textContent.trim(),className:String(cards[i].getAttribute(" + j("class") + ")),bg:String(cards[i].style.backgroundColor),done:cards[i].querySelector(" + j("[data-plan-note-done]") + ")!==null});}var toast=document.querySelector(" + j("[data-plan-toast]") + ");return {count:count===null?String(" + j("") + "):count.textContent.trim(),cards:out,grid:root.querySelector(" + j("[data-plan-grid]") + ")!==null,empty:root.querySelector(" + j("[data-plan-empty]") + ")!==null,tables:root.querySelectorAll(" + j("[data-workspace-task-table],[data-workspace-issue-table]") + ").length,toast:toast===null?String(" + j("") + "):toast.textContent.trim()};})()";
/** 按表达式点元素（下拉选项这类没有稳定选择器的目标用；找不到 / 不可见即抛错）。 */
async function clickExpr(expression, what) {
  const point = await ev("(function(){var node=" + expression + ";if(node===null||node===undefined){return null;}var box=node.getBoundingClientRect();if(box.width<=0||box.height<=0){return null;}return {x:Math.round(box.left+box.width/2),y:Math.round(box.top+box.height/2)};})()");
  if (point === null || point === undefined) throw new Error("点不到（表达式定位失败）：" + what);
  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y, button: "none" });
  await page.send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1 });
  await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1 });
  await sleep(500);
}
/** 拖拽（Push 269）：按住源元素中心，按步长移到目标中心（不松手）—— 超过 6px 才进入拖拽态。 */
async function dragHold(sourceSelector, targetSelector, steps = 10) {
  const from = await ev("(function(){var node=document.querySelector(" + j(sourceSelector) + ");if(node===null){return null;}var box=node.getBoundingClientRect();if(box.width<=0||box.height<=0){return null;}return {x:Math.round(box.left+box.width/2),y:Math.round(box.top+box.height/2)};})()");
  const to = await ev("(function(){var node=document.querySelector(" + j(targetSelector) + ");if(node===null){return null;}var box=node.getBoundingClientRect();if(box.width<=0||box.height<=0){return null;}return {x:Math.round(box.left+box.width/2),y:Math.round(box.top+box.height/2)};})()");
  if (from === null || to === null) throw new Error("拖拽定位失败：" + sourceSelector + " → " + targetSelector);
  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: from.x, y: from.y, button: "none" });
  await page.send("Input.dispatchMouseEvent", { type: "mousePressed", x: from.x, y: from.y, button: "left", clickCount: 1 });
  await sleep(120);
  for (let i = 1; i <= steps; i += 1) {
    const x = Math.round(from.x + ((to.x - from.x) * i) / steps);
    const y = Math.round(from.y + ((to.y - from.y) * i) / steps);
    await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "left", buttons: 1 });
    await sleep(45);
  }
  await sleep(220);
  return { from, to };
}
/** 拖拽松手（落点 = 目标中心）。 */
async function dragRelease(targetSelector) {
  const to = await ev("(function(){var node=document.querySelector(" + j(targetSelector) + ");if(node===null){return null;}var box=node.getBoundingClientRect();if(box.width<=0||box.height<=0){return null;}return {x:Math.round(box.left+box.width/2),y:Math.round(box.top+box.height/2)};})()");
  if (to === null) throw new Error("松手落点定位失败：" + targetSelector);
  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: to.x, y: to.y, button: "left", buttons: 1 });
  await sleep(140);
  await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: to.x, y: to.y, button: "left", clickCount: 1 });
  await sleep(560);
}
async function pressKey(key, code, vk, modifiers = 0) {
  await page.send("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers });
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers });
  await sleep(120);
}
/** 覆盖式输入（先 Ctrl+A 再插字；换行 = 真回车键）—— 便签标题 / 内容 / 搜索都用它。 */
async function typeInto(selector, text) {
  await clickSelector(selector);
  await pressKey("a", "KeyA", 65, 2);
  const parts = String(text).split("\n");
  for (let i = 0; i < parts.length; i += 1) {
    if (i > 0) {
      await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: String.fromCharCode(13), unmodifiedText: String.fromCharCode(13) });
      await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
      await sleep(160);
    }
    if (parts[i] !== "") {
      await page.send("Input.insertText", { text: parts[i] });
    }
    await sleep(160);
  }
  await sleep(360);
}

await open("#/my-tasks", "[data-workspace-page]");
await waitFor("document.querySelector(" + j("[data-workspace-panel=\"" + projectA + "\"]") + ") !== null", 25000);
const headPlan0 = await ev(headExpr());
check("⑪a 「我的计划」是第三枚标签（三枚都在：我的任务 / 提出·负责的问题 / 我的计划；无图标）", headPlan0 !== null && headPlan0.tabs.length === 3 && headPlan0.tabs[2].key === "plan" && headPlan0.tabs[2].text === "我的计划", headPlan0 === null ? "null" : JSON.stringify([headPlan0.tabs.length, headPlan0.tabs[2].text]));
await clickSelector("[data-workspace-tab=" + Q + "plan" + Q + "]");
await waitFor("document.querySelector(" + j("[data-plan-grid]") + ") !== null", 15000);
const headPlan1 = await ev(headExpr());
check("⑪b 点「我的计划」→ 地址写回 ?tab=plan + 选中态转移（replace、可刷新 / 可分享）", headPlan1 !== null && headPlan1.hash === "#/my-tasks?tab=plan" && headPlan1.tabs[2].current === "page" && headPlan1.tabs[0].current === null && headPlan1.tabs[1].current === null, headPlan1 === null ? "null" : JSON.stringify([headPlan1.hash, headPlan1.tabs.map((item) => item.current)]));
const plan0 = await ev(planExpr());
check("⑪c 「我的计划」页 = 便签墙（不是登记卡）：账号里 6 条示例、侧栏计数「共 6 条便签」、有网格无空态、无任务 / 问题表；固定「最近更新」序首尾 =「本周重点」/「随手记」", plan0 !== null && plan0.cards.length === 6 && plan0.count === "共 6 条便签" && plan0.grid === true && plan0.empty === false && plan0.tables === 0 && plan0.cards[0] !== undefined && plan0.cards[0].title === "本周重点" && plan0.cards[5] !== undefined && plan0.cards[5].title === "随手记", plan0 === null ? "null" : JSON.stringify([plan0.count, plan0.cards.map((item) => item.title)]));
const planSkin = await ev("(function(){var root=document.querySelector(" + j("[data-workspace-plan]") + ");if(root===null){return null;}var card=root.querySelector(" + j("[data-plan-note]") + ");var grid=root.querySelector(" + j("[data-plan-grid]") + ");if(card===null||grid===null){return null;}var rs=getComputedStyle(root);var cs=getComputedStyle(card);return {bgImage:rs.backgroundImage,bgColor:rs.backgroundColor,radius:cs.borderTopLeftRadius,padding:cs.paddingTop,minHeight:cs.minHeight,cols:getComputedStyle(grid).gridTemplateColumns};})()");
const planSkinCols = planSkin === null ? [] : planSkin.cols.split(" ").map((item) => Math.round(parseFloat(item)));
check("⑪c2 照搬口径对账（Push 268：页面底改纯白）：页面背景 = 纯白 #ffffff、无径向渐变；卡片圆角 18 / 内衬 18 / 最小高 198、网格列宽 ≥ 228（auto-fill）", planSkin !== null && planSkin.bgImage === "none" && planSkin.bgColor === "rgb(255, 255, 255)" && planSkin.radius === "18px" && planSkin.padding === "18px" && planSkin.minHeight === "198px" && planSkinCols.length >= 3 && Math.min.apply(null, planSkinCols) >= 228, planSkin === null ? "null" : JSON.stringify({ bgColor: planSkin.bgColor, radius: planSkin.radius, padding: planSkin.padding, minHeight: planSkin.minHeight, cols: planSkinCols }));
const planToolbar = await ev("(function(){var root=document.querySelector(" + j("[data-workspace-plan]") + ");if(root===null){return null;}var done=root.querySelector(" + j("[data-plan-category=" + Q + "done" + Q + "]") + ");var doneCount=done===null?null:done.querySelector(" + j("span:last-child") + ");var zone=root.querySelector(" + j("[data-plan-done-zone]") + ");return {hasSort:root.querySelector(" + j("[data-plan-sort]") + ")!==null,hasDone:done!==null,doneCount:doneCount===null?null:doneCount.textContent.trim(),hasZone:zone!==null,zoneText:zone===null?null:zone.textContent.trim(),zoneDashed:zone===null?null:getComputedStyle(zone).borderTopStyle,zoneHasAll:zone===null?null:zone.querySelector(" + j("[data-plan-category=all]") + ")!==null,footnote:zone===null?null:zone.textContent.indexOf(" + j("数据保存在账号里") + ")>=0};})()");
check("⑪c4 排序已下架（「最近更新」按钮不在 DOM）+ 侧栏有「已完成」入口（当前计数 0）+ 有「完成」拖放区（整条左栏 = 拖放区：虚线框裹住分类卡 + 文案「拖动便签到此处完成」+ 脚注「数据保存在账号里（换设备可见）」已撤）", planToolbar !== null && planToolbar.hasSort === false && planToolbar.hasDone === true && planToolbar.doneCount === "0" && planToolbar.hasZone === true && planToolbar.zoneText !== null && planToolbar.zoneDashed === "dashed" && planToolbar.zoneHasAll === true && planToolbar.footnote === false && planToolbar.zoneText.indexOf("拖动便签") >= 0, planToolbar === null ? "null" : JSON.stringify(planToolbar));
// ⑪c3 「填写」弹窗照搬（新建态 · 2026-10-10「填写也要一样」）：整卡 = 便签底色（缺省黄）+ 24 圆角 / 680 宽；
// 顶栏 = 关闭 X + 7 色圆点（选中 = 墨色描边）+ 3 枚字体 Aa（选中 = 墨底奶白字）；底栏 =「新建便签」+ 墨黑「保存」（空内容置灰）+ 删除缺席；
// 对账复用 ⑪d 打开的新建弹窗（不关不合、数据不动）；关闭 X 另由 ⑪n2 覆盖。
await clickSelector("[data-plan-new]");
await waitFor("document.querySelector(" + j("[data-plan-editor]") + ") !== null", 8000);
const editSkinNew = await ev("(function(){var overlay=document.querySelector(" + j("[data-plan-editor]") + ");if(overlay===null){return null;}var card=overlay.firstElementChild;var cs=getComputedStyle(card);var activeSwatch=card.querySelector(" + j("[data-plan-color][aria-pressed=true]") + ");var activeFont=card.querySelector(" + j("[data-plan-font][aria-pressed=true]") + ");var title=card.querySelector(" + j("[data-plan-editor-title]") + ");var save=card.querySelector(" + j("[data-plan-editor-save]") + ");var meta=card.querySelector(" + j("footer span") + ");return {bg:cs.backgroundColor,border:cs.borderTopColor,radius:cs.borderTopLeftRadius,width:Math.round(card.getBoundingClientRect().width),headX:card.querySelector(" + j("[data-plan-editor-close]") + ")!==null,swatchCount:card.querySelectorAll(" + j("[data-plan-color]") + ").length,activeSwatchBg:activeSwatch===null?null:getComputedStyle(activeSwatch).backgroundColor,activeSwatchBorder:activeSwatch===null?null:getComputedStyle(activeSwatch).borderTopColor,fontCount:card.querySelectorAll(" + j("[data-plan-font]") + ").length,activeFontBg:activeFont===null?null:getComputedStyle(activeFont).backgroundColor,activeFontColor:activeFont===null?null:getComputedStyle(activeFont).color,titleSize:getComputedStyle(title).fontSize,titlePlaceholder:title.getAttribute(" + j("placeholder") + "),saveBg:getComputedStyle(save).backgroundColor,saveText:save.textContent.trim(),saveDisabled:save.disabled,hasDelete:card.querySelector(" + j("[data-plan-editor-delete]") + ")!==null,hasDone:card.querySelector(" + j("[data-plan-editor-done]") + ")!==null,metaText:meta===null?null:meta.textContent.trim()};})()");
check("⑪c3 「填写」弹窗照搬（新建态）：整卡 = 便签底色（缺省黄 #fef8d5 / 描边 #f2e3a4）+ 24 圆角 / 680 宽；顶栏 = 关闭 X + 7 色圆点（选中 = 墨色描边）+ 3 枚字体 Aa（选中 = 墨底奶白）；底栏 =「新建便签」+ 墨黑「保存」（空内容置灰）+ 删除缺席 + 完成键缺席（Push 269：完成改拖拽）", editSkinNew !== null && editSkinNew.bg === "rgb(254, 248, 213)" && editSkinNew.border === "rgb(242, 227, 164)" && editSkinNew.radius === "24px" && editSkinNew.width === 680 && editSkinNew.headX === true && editSkinNew.swatchCount === 7 && editSkinNew.activeSwatchBg === "rgb(253, 230, 138)" && editSkinNew.activeSwatchBorder === "rgb(28, 25, 23)" && editSkinNew.fontCount === 3 && editSkinNew.activeFontBg === "rgb(28, 25, 23)" && editSkinNew.activeFontColor === "rgb(253, 251, 247)" && editSkinNew.titleSize === "25px" && editSkinNew.titlePlaceholder === "标题" && editSkinNew.saveBg === "rgb(28, 25, 23)" && editSkinNew.saveText === "保存" && editSkinNew.saveDisabled === true && editSkinNew.hasDelete === false && editSkinNew.hasDone === false && editSkinNew.metaText === "新建便签", editSkinNew === null ? "null" : JSON.stringify(editSkinNew));
await waitFor("document.querySelector(" + j("[data-plan-editor]") + ") !== null", 8000);
const editor0 = await ev("(function(){var root=document.querySelector(" + j("[data-plan-editor]") + ");if(root===null){return null;}var save=root.querySelector(" + j("[data-plan-editor-save]") + ");var title=root.querySelector(" + j("[data-plan-editor-title]") + ");return {saveDisabled:save===null?null:save.disabled,titleValue:title===null?null:title.value};})()");
check("⑪d 新建便签弹窗：标题 / 内容都空时「保存便签」置灰（至少填一项才可保存）", editor0 !== null && editor0.saveDisabled === true && editor0.titleValue === "", editor0 === null ? "null" : JSON.stringify(editor0));
await typeInto("[data-plan-editor-title]", "回放·便签甲");
await typeInto("[data-plan-editor-content]", "第一行\n第二行");
await clickSelector("[data-plan-editor-category=" + Q + "想法" + Q + "]");
await clickSelector("[data-plan-color=" + Q + "blue" + Q + "]");
await clickSelector("[data-plan-font=" + Q + "mono" + Q + "]");
const editor1 = await ev("(function(){var root=document.querySelector(" + j("[data-plan-editor]") + ");if(root===null){return null;}var save=root.querySelector(" + j("[data-plan-editor-save]") + ");return {saveDisabled:save===null?null:save.disabled,colorPressed:String(root.querySelector(" + j("[data-plan-color=" + Q + "blue" + Q + "]") + ").getAttribute(" + j("aria-pressed") + ")),fontPressed:String(root.querySelector(" + j("[data-plan-font=" + Q + "mono" + Q + "]") + ").getAttribute(" + j("aria-pressed") + ")),categoryPressed:String(root.querySelector(" + j("[data-plan-editor-category=" + Q + "想法" + Q + "]") + ").getAttribute(" + j("aria-pressed") + "))};})()");
check("⑪e 选项联动：标题 / 内容有了 → 保存可点；分类「想法」、颜色「蓝色」、字体「等宽」选中（aria-pressed=true）", editor1 !== null && editor1.saveDisabled === false && editor1.colorPressed === "true" && editor1.fontPressed === "true" && editor1.categoryPressed === "true", editor1 === null ? "null" : JSON.stringify(editor1));
await clickSelector("[data-plan-editor-save]");
await waitFor("document.querySelector(" + j("[data-plan-editor]") + ") === null", 8000);
const plan1 = await ev(planExpr());
const createdCard = plan1 === null ? undefined : plan1.cards.find((item) => item.title === "回放·便签甲");
const createdId = createdCard === undefined ? "" : createdCard.id;
check("⑪f 保存 → 弹窗关、便签墙 +1（共 7 条）：新卡按「最近更新」排第一，带蓝色底（#e3eefe）+ 等宽字体（font-mono）+ 分类「想法」", plan1 !== null && plan1.cards.length === 7 && plan1.count === "共 7 条便签" && plan1.cards[0] !== undefined && plan1.cards[0].title === "回放·便签甲" && createdCard !== undefined && createdCard.bg === "rgb(227, 238, 254)" && createdCard.className.indexOf("font-mono") >= 0 && createdCard.category === "想法", plan1 === null ? "null" : JSON.stringify([plan1.count, createdCard === undefined ? null : createdCard.bg]));
await shot("16-我的计划-便签墙（新建后7条）.png");
await clickSelector("[data-plan-note=" + Q + createdId + Q + "]");
await waitFor("document.querySelector(" + j("[data-plan-editor]") + ") !== null", 8000);
const editPrefill = await ev("(function(){var t=document.querySelector(" + j("[data-plan-editor-title]") + ");return t===null?null:t.value;})()");
check("⑪g 点卡片 = 编辑弹窗且已带出现值（标题「回放·便签甲」）", editPrefill === "回放·便签甲", String(editPrefill));
const editSkinEdit = await ev("(function(){var overlay=document.querySelector(" + j("[data-plan-editor]") + ");if(overlay===null){return null;}var card=overlay.firstElementChild;var cs=getComputedStyle(card);var foot=card.querySelector(" + j("footer") + ");var spans=foot===null?[]:foot.querySelectorAll(" + j("span") + ");var meta=spans.length>0?spans[0].textContent.trim():null;var del=card.querySelector(" + j("[data-plan-editor-delete]") + ");return {bg:cs.backgroundColor,border:cs.borderTopColor,meta:meta,metaColor:spans.length>0?getComputedStyle(spans[0]).color:null,hasDelete:del!==null,deleteColor:del===null?null:getComputedStyle(del).color,hasDone:card.querySelector(" + j("[data-plan-editor-done]") + ")!==null};})()");
check("⑪g2 「填写」弹窗跟着便签色（编辑态）：整卡 = 蓝 #e3eefe / 描边 #c5daf7 + 底栏「更新于 YYYY年M月D日 HH:MM」（灰）+ 白底红图标删除键在场 + 完成键缺席（Push 269：完成改拖拽）", editSkinEdit !== null && editSkinEdit.bg === "rgb(227, 238, 254)" && editSkinEdit.border === "rgb(197, 218, 247)" && editSkinEdit.meta !== null && /^更新于 \d{4}年\d{1,2}月\d{1,2}日 \d{2}:\d{2}$/.test(editSkinEdit.meta) && editSkinEdit.metaColor === "rgb(120, 113, 108)" && editSkinEdit.hasDelete === true && editSkinEdit.deleteColor === "rgb(220, 38, 38)" && editSkinEdit.hasDone === false, editSkinEdit === null ? "null" : JSON.stringify(editSkinEdit));
await shot("17-我的计划-编辑弹窗.png");
await typeInto("[data-plan-editor-title]", NOTE_CREATED_TITLE);
await clickSelector("[data-plan-editor-save]");
await waitFor("document.querySelector(" + j("[data-plan-editor]") + ") === null", 8000);
const plan2 = await ev(planExpr());
check("⑪h 改名保存 → 卡片标题即时更新，且因「最近更新」仍排第一（共 7 条不变）", plan2 !== null && plan2.cards.length === 7 && plan2.cards[0] !== undefined && plan2.cards[0].title === NOTE_CREATED_TITLE, plan2 === null ? "null" : JSON.stringify([plan2.count, plan2.cards[0] === undefined ? null : plan2.cards[0].title]));
await typeInto("[data-plan-search] input", "甲改");
await sleep(300);
const planSearch = await ev(planExpr());
check("⑪i 搜索「甲改」→ 只剩 1 张卡（标题命中）", planSearch !== null && planSearch.cards.length === 1 && planSearch.cards[0] !== undefined && planSearch.cards[0].title === NOTE_CREATED_TITLE, planSearch === null ? "null" : JSON.stringify(planSearch.cards.map((item) => item.title)));
await clickSelector("[aria-label=" + Q + "清空搜索" + Q + "]");
await sleep(300);
const planSearchCleared = await ev(planExpr());
check("⑪j 清空搜索 → 7 张卡全回来", planSearchCleared !== null && planSearchCleared.cards.length === 7, planSearchCleared === null ? "null" : String(planSearchCleared.cards.length));
await clickSelector("[data-plan-category=" + Q + "想法" + Q + "]");
await sleep(250);
const planCat = await ev(planExpr());
check("⑪k 分类过滤「想法」→ 2 张卡（新便签 + 预置「想法速记」）", planCat !== null && planCat.cards.length === 2 && planCat.cards.every((item) => item.category === "想法"), planCat === null ? "null" : JSON.stringify(planCat.cards.map((item) => item.title)));
await clickSelector("[data-plan-category=" + Q + "all" + Q + "]");
await sleep(250);
// ⑪l 拖拽完成（Push 269）：把便签卡拖到侧栏「完成」拖放区 → 便签收进「已完成」（便签墙 7 → 6、侧栏「已完成」计数 1）
await ev("window.scrollTo(0, 0)");
await sleep(250);
await dragHold("[data-plan-note=" + Q + createdId + Q + "]", "[data-plan-done-zone]");
const dragMid = await ev("(function(){var zone=document.querySelector(" + j("[data-plan-done-zone]") + ");var ghost=document.querySelector(" + j("[data-plan-drag-ghost]") + ");var hidden=0;var cards=document.querySelectorAll(" + j("[data-plan-note]") + ");for(var i=0;i<cards.length;i+=1){if(getComputedStyle(cards[i]).visibility===" + j("hidden") + "){hidden+=1;}}return {over:zone===null?null:zone.getAttribute(" + j("data-plan-done-zone-over") + "),hint:zone===null?null:zone.textContent.trim(),lift:document.querySelector(" + j("[data-plan-note-lift]") + ")!==null,liftW:(function(){var el=document.querySelector(" + j("[data-plan-note-lift]") + ");return el===null?null:el.offsetWidth;})(),liftH:(function(){var el=document.querySelector(" + j("[data-plan-note-lift]") + ");return el===null?null:el.offsetHeight;})(),ghostW:ghost===null?null:ghost.offsetWidth,ghostH:ghost===null?null:ghost.offsetHeight,srcHidden:hidden,ghost:ghost!==null,ghostText:ghost===null?null:ghost.textContent.trim(),editor:document.querySelector(" + j("[data-plan-editor]") + ")!==null};})()");
check("⑪l0 拖动中态：拖到「完成」区上方 = 完成区高亮（over=true / 文案「松手，收进「已完成」」）+ 悬浮小卡 = 原卡 1:1 尺寸（≈ 原槽位）+ 原槽位脱离（虚线占位框 + 源卡隐去）+ 编辑弹窗不弹", dragMid !== null && dragMid.over === "true" && dragMid.hint !== null && dragMid.hint.indexOf("松手") >= 0 && dragMid.ghost === true && dragMid.lift === true && dragMid.srcHidden === 1 && Math.abs(dragMid.ghostW - dragMid.liftW) <= 2 && Math.abs(dragMid.ghostH - dragMid.liftH) <= 2 && dragMid.editor === false, dragMid === null ? "null" : JSON.stringify([dragMid.over, dragMid.hint, dragMid.ghost, dragMid.editor, dragMid.ghostW, dragMid.liftW, dragMid.ghostH, dragMid.liftH]));
await shot("19-我的计划-拖动完成.png");
await dragRelease("[data-plan-done-zone]");
await sleep(900);
let planDone = await ev(planExpr());
for (let i = 0; i < 15 && (planDone === null || planDone.toast.indexOf("已完成") < 0); i += 1) {
  await sleep(200);
  planDone = await ev(planExpr());
}
const planDoneCountText = await ev("(function(){var b=document.querySelector(" + j("[data-plan-category=" + Q + "done" + Q + "]") + ");if(b===null){return null;}var n=b.querySelector(" + j("span:last-child") + ");return n===null?null:n.textContent.trim();})()");
check("⑪l 拖拽完成：便签卡拖进侧栏「完成」区 → 便签墙 6 条（该便签离开便签墙）、侧栏「已完成」计数 1、拖完不误触编辑弹窗", planDone !== null && planDone.cards.length === 6 && !planDone.cards.some((item) => item.id === createdId) && planDoneCountText === "1" && planDone.toast.indexOf("已完成") >= 0, JSON.stringify([planDone === null ? null : planDone.cards.length, planDoneCountText, planDone === null ? null : planDone.toast]));
// ⑪l2 「已完成」视图：只见完成态（右上角常显绿勾；未完成卡仍是悬停铅笔）+ 标题「已完成」
await clickSelector("[data-plan-category=" + Q + "done" + Q + "]");
await sleep(300);
const planDoneView = await ev(planExpr());
const planDoneHeading = await ev("(function(){var h=document.querySelector(" + j("[data-workspace-plan] h1") + ");return h===null?null:h.textContent.trim();})()");
const planDoneHint = await ev("(function(){var h=document.querySelector(" + j("[data-plan-done-hint]") + ");return h===null?null:h.textContent.trim();})()");
check("⑪l2 点侧栏「已完成」= 只显示完成态（1 张卡 = 刚完成的便签、[data-plan-note-done] 绿勾在场）+ 标题「已完成」+ 头部提示「把便签拖回「全部便签」即可恢复」", planDoneView !== null && planDoneView.cards.length === 1 && planDoneView.cards[0] !== undefined && planDoneView.cards[0].id === createdId && planDoneView.cards[0].done === true && planDoneHeading !== null && planDoneHeading.indexOf("已完成") === 0 && planDoneHint !== null && planDoneHint.indexOf("全部便签") >= 0, planDoneView === null ? "null" : JSON.stringify([planDoneView.cards.length, planDoneHeading, planDoneHint]));
await shot("18-我的计划-已完成.png");
// ⑪l3 「已完成」里把便签拖回「全部便签」→ 回到未完成（本视图空态；切回「全部便签」7 条）
await ev("window.scrollTo(0, 0)");
await sleep(250);
await dragHold("[data-plan-note=" + Q + createdId + Q + "]", "[data-plan-category=" + Q + "all" + Q + "]");
const restoreMid = await ev("(function(){var all=document.querySelector(" + j("[data-plan-category=" + Q + "all" + Q + "]") + ");var ghost=document.querySelector(" + j("[data-plan-drag-ghost]") + ");return {active:all===null?null:all.getAttribute(" + j("data-plan-drop-active") + "),ghost:ghost!==null,ghostText:ghost===null?null:ghost.textContent.trim()};})()");
check("⑪l3a 拖动中态：已完成便签拖到「全部便签」上方 = 该项高亮（drop-active=true）+ 悬浮小卡提示「松手，恢复为未完成」", restoreMid !== null && restoreMid.active === "true" && restoreMid.ghost === true && restoreMid.ghostText !== null && restoreMid.ghostText.indexOf("恢复") >= 0, restoreMid === null ? "null" : JSON.stringify(restoreMid));
await dragRelease("[data-plan-category=" + Q + "all" + Q + "]");
await sleep(900);
const planDoneEmpty = await ev(planExpr());
check("⑪l3b 拖回恢复：便签拖回「全部便签」→ 回到未完成：本视图空态（0 张卡 + 空态卡）", planDoneEmpty !== null && planDoneEmpty.cards.length === 0 && planDoneEmpty.empty === true, planDoneEmpty === null ? "null" : JSON.stringify([planDoneEmpty.cards.length, planDoneEmpty.empty]));
await clickSelector("[data-plan-category=" + Q + "all" + Q + "]");
await sleep(300);
const planBackAll = await ev(planExpr());
check("⑪l4 切回「全部便签」：7 条全回来（恢复的便签在场）", planBackAll !== null && planBackAll.cards.length === 7 && planBackAll.cards.some((item) => item.id === createdId), planBackAll === null ? "null" : JSON.stringify(planBackAll.cards.map((item) => item.title)));
await clickSelector("[data-plan-note=" + Q + createdId + Q + "]");
await waitFor("document.querySelector(" + j("[data-plan-editor]") + ") !== null", 8000);
await clickSelector("[data-plan-editor-delete]");
const delConfirmShown = await ev("document.querySelector(" + j("[data-plan-editor-delete-confirm]") + ") !== null");
await clickSelector("[data-plan-editor-delete-cancel]");
const delCancelled = await ev("(function(){return {confirm:document.querySelector(" + j("[data-plan-editor-delete-confirm]") + ")!==null,editor:document.querySelector(" + j("[data-plan-editor]") + ")!==null};})()");
check("⑪m 删除要二次确认：第一下只出确认条 → 点「取消」回到普通底栏、弹窗仍在（便签没删）", delConfirmShown === true && delCancelled !== null && delCancelled.confirm === false && delCancelled.editor === true, delCancelled === null ? "null" : JSON.stringify(delCancelled));
await clickSelector("[data-plan-editor-delete]");
await clickSelector("[data-plan-editor-delete-do]");
await waitFor("document.querySelector(" + j("[data-plan-editor]") + ") === null", 8000);
const plan3 = await ev(planExpr());
check("⑪n 再删一次 + 「确认删除」→ 弹窗关、回到 6 条（真删该便签）+ 出「已删除便签。」提示条", plan3 !== null && plan3.cards.length === 6 && !plan3.cards.some((item) => item.id === createdId) && plan3.toast.indexOf("已删除便签") >= 0, plan3 === null ? "null" : JSON.stringify([plan3.count, plan3.toast]));
const closeId = plan3 !== null && plan3.cards[0] !== undefined ? plan3.cards[0].id : "";
await clickSelector("[data-plan-note=" + Q + closeId + Q + "]");
await waitFor("document.querySelector(" + j("[data-plan-editor]") + ") !== null", 8000);
const closePre = await ev("(function(){var dlg=document.querySelector(" + j("[data-plan-editor]") + ");if(dlg===null){return null;}return {confirm:dlg.querySelector(" + j("[data-plan-editor-delete-confirm]") + ")===null,meta:dlg.querySelector(" + j("footer span") + ")===null?null:dlg.querySelector(" + j("footer span") + ").textContent.indexOf(" + j("更新于") + ")===0};})()");
await clickSelector("[data-plan-editor-close]");
await waitFor("document.querySelector(" + j("[data-plan-editor]") + ") === null", 8000);
const planClose = await ev(planExpr());
check("⑪n2 「填写」弹窗关闭 X：点 X = 直接关（无删除确认、底栏带「更新于」）+ 数据不动（仍 6 条）", closePre !== null && closePre.confirm === true && closePre.meta === true && planClose !== null && planClose.cards.length === 6, closePre === null ? "null" : JSON.stringify([closePre, planClose === null ? null : planClose.cards.length]));
// ⑪l5 ~ ⑪l9 分类删除（Push 271 · 业务口径 2026-10-10「除了已完成其他分类要可以删除」）：用户分类行有 ×（全部便签 / 已完成 没有 ×）；
// 空分类 = 行内两步确认后直接删；非空分类删 = 便签整批移入「其他」，便签本身不删（清理后回到 6 条，供 ⑪o 落库对账）。
await clickSelector("[data-plan-category-add]");
await waitFor("document.querySelector(" + j("[data-plan-category-new]") + ") !== null", 8000);
await typeInto("[data-plan-category-new]", "回放·待删");
await pressKey("Enter", "Enter", 13);
await sleep(600);
const catRows = await ev("(function(){return {row:document.querySelector(" + j("[data-plan-category=" + Q + "回放·待删" + Q + "]") + ")!==null,hasDel:document.querySelector(" + j("[data-plan-category-delete=" + Q + "回放·待删" + Q + "]") + ")!==null,allDel:document.querySelector(" + j("[data-plan-category-delete=" + Q + "all" + Q + "]") + ")!==null,doneDel:document.querySelector(" + j("[data-plan-category-delete=" + Q + "done" + Q + "]") + ")!==null};})()");
// ⑪l5a / ⑪l5b 删除胶囊（Push 271 · 业务口径「删除分类用同款项目的删除胶囊即可」）：行悬停 → 幽灵垃圾桶浮现（24px 透明底）；
// 悬停胶囊 → 展开成 48px 红底「删除」胶囊（与项目卡片 / 任务行 / 模板面板同一个 RowDeleteButton 组件）。
await hoverSelector("[data-plan-category=" + Q + "回放·待删" + Q + "]");
await sleep(450);
const catPillIdle = await ev("(function(){var w=document.querySelector(" + j("[data-plan-category-delete=" + Q + "回放·待删" + Q + "]") + ");var b=w===null?null:w.querySelector(" + j("button") + ");if(b===null){return null;}var cs=getComputedStyle(b);var s=b.querySelector(" + j("span") + ");return {opacity:cs.opacity,w:b.offsetWidth,bg:cs.backgroundColor,textOpacity:s===null?null:getComputedStyle(s).opacity};})()");
check("⑪l5a 分类删除 = 项目同款删除胶囊（RowDeleteButton）：行悬停浮现幽灵垃圾桶（24px、透明底、文案「删除」藏在层里 = opacity 0）", catPillIdle !== null && catPillIdle.opacity === "1" && catPillIdle.w === 24 && catPillIdle.textOpacity === "0", JSON.stringify(catPillIdle));
// ⑪l5c 行悬停时右侧计数淡出让位（Push 271 · 业务口径「删除和数字叠起来了不好看」）：数字与删除胶囊不同时出现在行右端（悬停行 → 计数 opacity 0）
const catCountVeiled = await ev("(function(){var c=document.querySelector(" + j("[data-plan-category=" + Q + "回放·待删" + Q + "] span:last-child") + ");if(c===null){return null;}return {text:c.textContent.trim(),opacity:getComputedStyle(c).opacity};})()");
check("⑪l5c 行悬停时右侧计数淡出让位（不叠删除胶囊）：分类「回放·待删」计数 opacity 0（数字让位、胶囊浮现）", catCountVeiled !== null && catCountVeiled.opacity === "0" && catCountVeiled.text.length > 0, JSON.stringify(catCountVeiled));
await hoverSelector("[data-plan-category-delete=" + Q + "回放·待删" + Q + "] button");
await sleep(520);
const catPillOpen = await ev("(function(){var w=document.querySelector(" + j("[data-plan-category-delete=" + Q + "回放·待删" + Q + "]") + ");var b=w===null?null:w.querySelector(" + j("button") + ");if(b===null){return null;}var cs=getComputedStyle(b);var s=b.querySelector(" + j("span") + ");return {w:b.offsetWidth,bg:cs.backgroundColor,textOpacity:s===null?null:getComputedStyle(s).opacity,text:s===null?null:s.textContent.trim()};})()");
check("⑪l5b 胶囊悬停展开：48px 红底（red-500；Tailwind v4 计算值 oklch）+「删除」文案浮现（与项目删除同一套动效）", catPillOpen !== null && catPillOpen.w === 48 && (catPillOpen.bg.indexOf("oklch") === 0 || catPillOpen.bg.indexOf("239, 68, 68") >= 0) && catPillOpen.textOpacity === "1" && catPillOpen.text === "删除", JSON.stringify(catPillOpen));
await clickSelector("[data-plan-category-delete=" + Q + "回放·待删" + Q + "] button");
await sleep(400);
const catConfirmEmpty = await ev("(function(){var c=document.querySelector(" + j("[data-plan-category-confirm=" + Q + "回放·待删" + Q + "]") + ");return {block:c!==null,text:c===null?null:c.textContent.trim()};})()");
check("⑪l5 分类可删（Push 271）：用户分类行带删除胶囊（全部便签 / 已完成 没有）；点胶囊 = 行内确认块「删除「回放·待删」？」+「空分类，可直接删除」", catRows !== null && catRows.row === true && catRows.hasDel === true && catRows.allDel === false && catRows.doneDel === false && catConfirmEmpty !== null && catConfirmEmpty.block === true && catConfirmEmpty.text !== null && catConfirmEmpty.text.indexOf("删除「回放·待删」") >= 0 && catConfirmEmpty.text.indexOf("空分类") >= 0, JSON.stringify([catRows, catConfirmEmpty]));
await clickSelector("[data-plan-category-confirm-delete]");
await sleep(700);
const catGone = await ev("(function(){var t=document.querySelector(" + j("[data-plan-toast]") + ");return {row:document.querySelector(" + j("[data-plan-category=" + Q + "回放·待删" + Q + "]") + ")===null,toast:t===null?null:t.textContent.trim()};})()");
check("⑪l6 删除空分类：点确认「删除」→ 分类行消失 + toast「已删除分类「回放·待删」。」", catGone !== null && catGone.row === true && catGone.toast !== null && catGone.toast.indexOf("已删除分类") >= 0 && catGone.toast.indexOf("回放·待删") >= 0, JSON.stringify(catGone));
await clickSelector("[data-plan-category-add]");
await waitFor("document.querySelector(" + j("[data-plan-category-new]") + ") !== null", 8000);
await typeInto("[data-plan-category-new]", "回放·待删乙");
await pressKey("Enter", "Enter", 13);
await sleep(600);
await clickSelector("[data-plan-new]");
await waitFor("document.querySelector(" + j("[data-plan-editor]") + ") !== null", 8000);
await typeInto("[data-plan-editor-title]", "回放·待删便签");
await clickSelector("[data-plan-editor-category=" + Q + "回放·待删乙" + Q + "]");
await clickSelector("[data-plan-editor-save]");
await waitFor("document.querySelector(" + j("[data-plan-editor]") + ") === null", 8000);
await sleep(700);
const delCatCount = await ev("(function(){var b=document.querySelector(" + j("[data-plan-category=" + Q + "回放·待删乙" + Q + "]") + ");if(b===null){return null;}var n=b.querySelector(" + j("span:last-child") + ");return n===null?null:n.textContent.trim();})()");
const catNotePlan = await ev(planExpr());
const catNoteCard = catNotePlan === null ? undefined : catNotePlan.cards.find((item) => item.title === "回放·待删便签");
const catNoteId = catNoteCard === undefined ? "" : catNoteCard.id;
await clickSelector("[data-plan-category-delete=" + Q + "回放·待删乙" + Q + "] button");
await sleep(400);
const catConfirmMove = await ev("(function(){var c=document.querySelector(" + j("[data-plan-category-confirm=" + Q + "回放·待删乙" + Q + "]") + ");return {block:c!==null,text:c===null?null:c.textContent.trim()};})()");
check("⑪l7 非空分类：便签挂「回放·待删乙」→ 侧栏计数 1；点 × = 确认块提示「分类下 1 条便签将移入「其他」」", delCatCount === "1" && catNoteId !== "" && catConfirmMove !== null && catConfirmMove.block === true && catConfirmMove.text !== null && catConfirmMove.text.indexOf("1 条便签将移入「其他」") >= 0, JSON.stringify([delCatCount, catConfirmMove]));
await clickSelector("[data-plan-category-confirm-delete]");
await sleep(900);
const catMoveAfter = await ev(planExpr());
const movedCard = catMoveAfter === null ? undefined : catMoveAfter.cards.find((item) => item.id === catNoteId);
const catRowGone = await ev("document.querySelector(" + j("[data-plan-category=" + Q + "回放·待删乙" + Q + "]") + ")===null");
check("⑪l8 删分类不删便签：确认删除 → 分类行消失 + 便签保留并移入「其他」（卡片分类签 =「其他」）+ toast「1 条便签移入「其他」」", catMoveAfter !== null && movedCard !== undefined && movedCard.category === "其他" && catMoveAfter.toast.indexOf("移入「其他」") >= 0 && catRowGone === true, catMoveAfter === null ? "null" : JSON.stringify([movedCard === undefined ? null : movedCard.category, catMoveAfter.toast]));
await clickSelector("[data-plan-note=" + Q + catNoteId + Q + "]");
await waitFor("document.querySelector(" + j("[data-plan-editor]") + ") !== null", 8000);
await clickSelector("[data-plan-editor-delete]");
await clickSelector("[data-plan-editor-delete-do]");
await waitFor("document.querySelector(" + j("[data-plan-editor]") + ") === null", 8000);
const planAfterCatDelete = await ev(planExpr());
check("⑪l9 分类删改收尾：清掉临时便签 → 回到 6 条（后续落库对账状态不变）", planAfterCatDelete !== null && planAfterCatDelete.cards.length === 6 && !planAfterCatDelete.cards.some((item) => item.title === "回放·待删便签"), planAfterCatDelete === null ? "null" : String(planAfterCatDelete.cards.length));
// ⑪l10 ~ ⑪l13b 背景颜色（Push 271 · 业务口径 2026-10-10「在如图的位置增加背景颜色切换 默认是和别的页面统一颜色 第二个颜色是minimemo的默认颜色」→
//   「还有很多种颜色啊为什么不写了 而且为什么选中的效果也不一样」→「效果不一样啊 另外选中是不用浮起来的」→「点击不要有变化即可」→「点击完毕还是弹起来了啊 没有回到原来的位置」→
//   「你完全参考这个代码不行吗」→「把玫红颜色删除掉」→「颜色选择组件要弹出选择 不要常驻 箭头旁边名称叫 背景颜色」）：
// 工具条左端 = 「背景颜色」箭头钮（照参考组件 1:1：深色圆 + 白箭头 + 文字；悬停 / 展开时圆铺满成胶囊、箭头右移、文字转白），点击弹出颜色面板（不常驻：再点钮 / 点面板外 / Esc 收起；追订「搜索往右靠然后颜色选择不要下滑 要向右滑」= 从按钮右侧滑出、不下滑 + 搜索框右靠；收起只露圆 + 箭头，文字悬停 / 展开才浮现（追订「背景颜色文字一开始不显示 鼠标触碰按钮才显示」））；
// 面板内 = 11 枚色块（统一白（默认）/ 奶白（参考页默认底色）/ 9 色板 · 玫红已下架；-6px 叠角）；悬停照参考组件（styled-components 版）1:1 = 悬停块 1.5 + 左右邻居联动 1.3 / 1.15 + 冒色名签（500ms 弹性缓动）；
// 悬停「已选中」块 = 该块自身不放大；点击 / 选中不改变色块外观（只切画布背景）、点击完毕落回原位且无焦点残留、选择后面板保持打开；选中随账号落库（换设备可见）。
await scrollSelectorIntoView("[data-plan-bg-trigger]");
const bgDefault = await ev("(function(){var root=document.querySelector(" + j("[data-workspace-plan]") + ");var trig=document.querySelector(" + j("[data-plan-bg-trigger]") + ");var panel=document.querySelector(" + j("[data-plan-bg-panel]") + ");var spans=trig===null?[]:trig.querySelectorAll(" + j("span") + ");var circle=spans.length>0?spans[0]:null;var cs=root===null?null:getComputedStyle(root);var search=document.querySelector(" + j("[data-plan-search]") + ");var newBtn=document.querySelector(" + j("[data-plan-new]") + ");return {trig:trig!==null,text:trig===null?null:trig.textContent.trim(),expanded:trig===null?null:trig.getAttribute(" + j("aria-expanded") + "),panel:panel!==null,circleW:circle===null?null:getComputedStyle(circle).width,trigW:trig===null?null:Math.round(trig.getBoundingClientRect().width),labelOpacity:spans.length>2?getComputedStyle(spans[2]).opacity:null,searchGap:(search!==null&&newBtn!==null)?Math.round(newBtn.getBoundingClientRect().left-search.getBoundingClientRect().right):null,searchOffset:(search!==null&&trig!==null)?Math.round(search.getBoundingClientRect().left-trig.getBoundingClientRect().right):null,bg:cs===null?null:cs.backgroundColor,img:cs===null?null:cs.backgroundImage};})()");
check("⑪l10 背景颜色钮在场（Push 271 · 弹出式不常驻）：工具条左端 =「背景颜色」箭头钮（文案 = 背景颜色；默认收起 = 无面板 + aria-expanded false；黑色圆收成 48px）；收起只露圆 + 箭头（文字 opacity 0）；搜索框右靠（贴「新建便签」，间隙 ≈12px）；画布默认「统一白」= 与全站页面一致（纯白、无渐变）", bgDefault !== null && bgDefault.trig === true && bgDefault.text === "背景颜色" && bgDefault.expanded === "false" && bgDefault.panel === false && bgDefault.circleW === "48px" && bgDefault.trigW === 192 && bgDefault.labelOpacity === "0" && bgDefault.searchGap !== null && bgDefault.searchGap >= 8 && bgDefault.searchGap <= 20 && bgDefault.searchOffset !== null && bgDefault.searchOffset >= 100 && bgDefault.bg === "rgb(255, 255, 255)" && bgDefault.img === "none", JSON.stringify(bgDefault));
// ⑪l10a 悬停箭头钮 = 参考组件同款：黑圆铺满成胶囊（48px → 192px）+ 箭头右移 16px + 文字转白（450ms 缓动）
await hoverSelector("[data-plan-bg-trigger]");
await sleep(650);
const bgTriggerHover = await ev("(function(){var trig=document.querySelector(" + j("[data-plan-bg-trigger]") + ");if(trig===null){return null;}var spans=trig.querySelectorAll(" + j("span") + ");var circle=spans.length>0?spans[0]:null;var arrow=spans.length>1?spans[1]:null;var label=spans.length>2?spans[2]:null;return {circleW:circle===null?null:getComputedStyle(circle).width,arrowMove:arrow===null?null:getComputedStyle(arrow).translate,labelColor:label===null?null:getComputedStyle(label).color,labelOpacity:label===null?null:getComputedStyle(label).opacity};})()");
check("⑪l10a 悬停「背景颜色」钮 = 参考组件同款：黑圆铺满成胶囊（48px → 192px）+ 箭头右移 16px + 文字浮现转白（450ms 缓动）", bgTriggerHover !== null && bgTriggerHover.circleW === "192px" && bgTriggerHover.arrowMove !== null && bgTriggerHover.arrowMove.indexOf("16px") >= 0 && bgTriggerHover.labelColor === "rgb(253, 251, 247)" && bgTriggerHover.labelOpacity === "1", JSON.stringify(bgTriggerHover));
// ⑪l10b 点钮 → 弹出颜色面板（不常驻）：11 枚色块（34×34 · -6px 叠角）+ 默认选中「统一白」（截图留档）
await clickSelector("[data-plan-bg-trigger]");
await sleep(400);
const bgOpen = await ev("(function(){var trig=document.querySelector(" + j("[data-plan-bg-trigger]") + ");var panel=document.querySelector(" + j("[data-plan-bg-panel]") + ");var sw=document.querySelector(" + j("[data-plan-bg-switch]") + ");var all=document.querySelectorAll(" + j("[data-plan-bg-option]") + ");var white=document.querySelector(" + j("[data-plan-bg-option=" + Q + "white" + Q + "]") + ");var box=all.length>0?all[0].getBoundingClientRect():null;return {panel:panel!==null,switch:sw!==null,gap:(trig!==null&&panel!==null)?Math.round(panel.getBoundingClientRect().left-trig.getBoundingClientRect().right):null,topDelta:(trig!==null&&panel!==null)?Math.round(panel.getBoundingClientRect().top-trig.getBoundingClientRect().top):null,expanded:trig===null?null:trig.getAttribute(" + j("aria-expanded") + "),count:all.length,w:box===null?null:Math.round(box.width),h:box===null?null:Math.round(box.height),active:white===null?null:white.getAttribute(" + j("aria-pressed") + ")};})()");
check("⑪l10b 点「背景颜色」钮 → 弹出颜色面板（不常驻）：面板 / 色条在场 + 11 枚色块（34×34 · -6px 叠角）+ 默认选中「统一白」（aria-pressed true）+ 面板从按钮右侧滑出（左缘 = 按钮右缘 + 12px · 顶对齐；不下滑）", bgOpen !== null && bgOpen.panel === true && bgOpen.switch === true && bgOpen.expanded === "true" && bgOpen.count === 11 && bgOpen.w === 34 && bgOpen.h === 34 && bgOpen.gap !== null && bgOpen.gap >= 8 && bgOpen.gap <= 16 && bgOpen.topDelta !== null && Math.abs(bgOpen.topDelta) <= 2 && bgOpen.active === "true", JSON.stringify(bgOpen));
await shot("20-我的计划-背景切换.png");
// ⑪l10c 悬停态照参考组件（styled-components 版）1:1：悬停块 1.5 + 左右邻居联动（±1 邻 1.3 / ±2 邻 1.15）+ 远端不动 + 冒奶白色名签「黄」；纯缩放（无 translateY 上浮）
await hoverSelector("[data-plan-bg-option=" + Q + "yellow" + Q + "]");
await sleep(650);
const bgHover = await ev("(function(){var all=document.querySelectorAll(" + j("[data-plan-bg-option]") + ");var byId=function(id){for(var i=0;i<all.length;i++){if(all[i].getAttribute(" + j("data-plan-bg-option") + ")===id){return all[i];}}return null;};var y=byId(" + j("yellow") + ");if(y===null){return null;}var s=y.parentElement===null?null:y.parentElement.querySelector(" + j("[data-plan-bg-tip]") + ");var sc=function(id){var b=byId(id);return b===null?null:getComputedStyle(b).scale;};return {scale:getComputedStyle(y).scale,translate:getComputedStyle(y).translate,tip:s===null?null:s.textContent.trim(),tipOpacity:s===null?null:getComputedStyle(s).opacity,orange:sc(" + j("orange") + "),lime:sc(" + j("lime") + "),pink:sc(" + j("pink") + "),emerald:sc(" + j("emerald") + "),white:sc(" + j("white") + ")};})()");
check("⑪l10c 悬停色块 = 参考组件同款（纯缩放联动）：悬停「黄」放大 1.5 + 左右 1 邻（橙 / 青柠）1.3 + 2 邻（粉 / 翡翠）1.15 + 远端（统一白）不动 + 无 translateY 上浮 + 冒色名签「黄」（奶白签可见）", bgHover !== null && bgHover.scale !== null && bgHover.scale.indexOf("1.5") >= 0 && bgHover.translate !== null && (bgHover.translate === "none" || bgHover.translate === "0px" || bgHover.translate === "0px 0px") && bgHover.orange !== null && bgHover.orange.indexOf("1.3") >= 0 && bgHover.lime !== null && bgHover.lime.indexOf("1.3") >= 0 && bgHover.pink !== null && bgHover.pink.indexOf("1.15") >= 0 && bgHover.emerald !== null && bgHover.emerald.indexOf("1.15") >= 0 && (bgHover.white === "none" || bgHover.white === "1") && bgHover.tip === "黄" && bgHover.tipOpacity === "1", JSON.stringify(bgHover));
// ⑪l10d 悬停「已选中」块：自身不放大、邻居联动照常（口径「选中是不用浮起来的」→「点击完毕…没有回到原来的位置」→「右边那个全压下去 源码不会这样」）
await hoverSelector("[data-plan-bg-option=" + Q + "white" + Q + "]");
await sleep(650);
const bgHoverActive = await ev("(function(){var all=document.querySelectorAll(" + j("[data-plan-bg-option]") + ");var byId=function(id){for(var i=0;i<all.length;i++){if(all[i].getAttribute(" + j("data-plan-bg-option") + ")===id){return all[i];}}return null;};var w=byId(" + j("white") + ");if(w===null){return null;}var s=w.parentElement===null?null:w.parentElement.querySelector(" + j("[data-plan-bg-tip]") + ");var sc=function(id){var b=byId(id);return b===null?null:getComputedStyle(b).scale;};return {white:sc(" + j("white") + "),cream:sc(" + j("cream") + "),pink:sc(" + j("pink") + "),tipOpacity:s===null?null:getComputedStyle(s).opacity};})()");
check("⑪l10d 悬停「已选中」块：统一白自身不放大（scale 1）、邻居（奶白 / 粉）联动照常（1.3 / 1.15）+ 只冒名签", bgHoverActive !== null && (bgHoverActive.white === "none" || bgHoverActive.white === "1") && bgHoverActive.cream !== null && bgHoverActive.cream.indexOf("1.3") >= 0 && bgHoverActive.pink !== null && bgHoverActive.pink.indexOf("1.15") >= 0 && bgHoverActive.tipOpacity === "1", JSON.stringify(bgHoverActive));
// ⑪l10e 收起机制一（Esc）：Esc → 面板收起 → 再点钮 → 面板重开（面板不常驻口径）
await pressKey("Escape", "Escape", 27);
await sleep(300);
const bgEsc = await ev("(function(){var panel=document.querySelector(" + j("[data-plan-bg-panel]") + ");var trig=document.querySelector(" + j("[data-plan-bg-trigger]") + ");return {panel:panel!==null,expanded:trig===null?null:trig.getAttribute(" + j("aria-expanded") + ")};})()");
await clickSelector("[data-plan-bg-trigger]");
await sleep(400);
const bgReopenByClick = await ev("(function(){var panel=document.querySelector(" + j("[data-plan-bg-panel]") + ");var trig=document.querySelector(" + j("[data-plan-bg-trigger]") + ");return {panel:panel!==null,expanded:trig===null?null:trig.getAttribute(" + j("aria-expanded") + ")};})()");
check("⑪l10e 收起机制（Esc）：Esc → 面板收起（aria-expanded false）→ 再点钮 → 面板重开", bgEsc !== null && bgEsc.panel === false && bgEsc.expanded === "false" && bgReopenByClick !== null && bgReopenByClick.panel === true && bgReopenByClick.expanded === "true", JSON.stringify([bgEsc, bgReopenByClick]));
// ⑪l10f 收起机制二（点面板外）：点搜索框 → 面板收起 → 再点钮重开（供后续试色）
await clickSelector("[data-plan-search]");
await sleep(300);
const bgOutside = await ev("(function(){return {panel:document.querySelector(" + j("[data-plan-bg-panel]") + ")!==null};})()");
await clickSelector("[data-plan-bg-trigger]");
await sleep(400);
const bgReopen3 = await ev("(function(){var panel=document.querySelector(" + j("[data-plan-bg-panel]") + ");return {panel:panel!==null,count:document.querySelectorAll(" + j("[data-plan-bg-option]") + ").length};})()");
check("⑪l10f 收起机制（点面板外）：点搜索框 → 面板收起 → 再点钮 → 面板重开（11 枚在场）", bgOutside !== null && bgOutside.panel === false && bgReopen3 !== null && bgReopen3.panel === true && bgReopen3.count === 11, JSON.stringify([bgOutside, bgReopen3]));
// ⑪l11 切「奶白」：画布 = 奶白 #fdfbf7 + 左上暖色径向渐变（照 Push 266 参考页原样）+ 选择后面板保持打开 + 点击 / 选中不改变色块外观（奶白与统一白投影一致）+ toast「已切换背景：奶白。」
await clickSelector("[data-plan-bg-option=" + Q + "cream" + Q + "]");
await sleep(700);
const bgCream = await ev("(function(){var root=document.querySelector(" + j("[data-workspace-plan]") + ");var cs=root===null?null:getComputedStyle(root);var t=document.querySelector(" + j("[data-plan-toast]") + ");var cream=document.querySelector(" + j("[data-plan-bg-option=" + Q + "cream" + Q + "]") + ");var white=document.querySelector(" + j("[data-plan-bg-option=" + Q + "white" + Q + "]") + ");var panel=document.querySelector(" + j("[data-plan-bg-panel]") + ");var tipOf=function(b){if(b===null){return null;}var s=b.parentElement===null?null:b.parentElement.querySelector(" + j("[data-plan-bg-tip]") + ");return s===null?null:{text:s.textContent.trim(),opacity:getComputedStyle(s).opacity};};return {bg:cs===null?null:cs.backgroundColor,img:cs===null?null:cs.backgroundImage,panel:panel!==null,active:cream===null?null:cream.getAttribute(" + j("aria-pressed") + "),white:white===null?null:white.getAttribute(" + j("aria-pressed") + "),tipCream:tipOf(cream),creamShadow:cream===null?null:getComputedStyle(cream).boxShadow,whiteShadow:white===null?null:getComputedStyle(white).boxShadow,toast:t===null?null:t.textContent.trim()};})()");
check("⑪l11 切「奶白」：画布 = 奶白 #fdfbf7 + 左上暖色径向渐变（照 Push 266 参考页原样）+ 选择后面板保持打开 + 点击 / 选中不改变色块外观（奶白与统一白投影一致）+ toast「已切换背景：奶白。」", bgCream !== null && bgCream.bg === "rgb(253, 251, 247)" && bgCream.img !== null && bgCream.img.indexOf("radial-gradient") >= 0 && bgCream.panel === true && bgCream.active === "true" && bgCream.white === "false" && bgCream.creamShadow !== null && bgCream.creamShadow.indexOf("3.5px 3.5px") >= 0 && bgCream.whiteShadow !== null && bgCream.whiteShadow.indexOf("3.5px 3.5px") >= 0 && bgCream.toast.indexOf("已切换背景") >= 0 && bgCream.toast.indexOf("奶白") >= 0, JSON.stringify(bgCream));
// ⑪l11c 点击完毕：点击块自身落回原位、邻居联动不塌陷、点击不带焦点残留（口径「点击完毕回到原来的位置」+「右边那个全压下去 源码不会这样」+「点击过的块保持放大、要点击别的地方才恢复」）：点击后指针仍停在奶白色块上（已转「选中」）→ 该块落回（scale 1）、两侧邻居联动保持（统一白 / 粉 1.3 + 橙 1.15）、焦点不在色块上（无持久放大态）
const bgCreamLanded = await ev("(function(){var all=document.querySelectorAll(" + j("[data-plan-bg-option]") + ");var byId=function(id){for(var i=0;i<all.length;i++){if(all[i].getAttribute(" + j("data-plan-bg-option") + ")===id){return all[i];}}return null;};var sc=function(id){var b=byId(id);return b===null?null:getComputedStyle(b).scale;};var cr=byId(" + j("cream") + ");var ae=document.activeElement;return {cream:sc(" + j("cream") + "),white:sc(" + j("white") + "),pink:sc(" + j("pink") + "),orange:sc(" + j("orange") + "),focus:(ae!==null&&ae.getAttribute)?ae.getAttribute(" + j("data-plan-bg-option") + "):null,fv:cr===null?null:cr.matches(" + j(":focus-visible") + ")};})()");
check("⑪l11c 点击完毕（点击块自身落回 · 邻居联动不塌陷 · 无焦点残留）：奶白落回（scale 1）、两侧 1 邻（统一白 / 粉）保持 1.3、（橙）2 邻 1.15、点击后活动焦点不在色块上且不匹配 :focus-visible", bgCreamLanded !== null && (bgCreamLanded.cream === "none" || bgCreamLanded.cream === "1") && bgCreamLanded.white !== null && bgCreamLanded.white.indexOf("1.3") >= 0 && bgCreamLanded.pink !== null && bgCreamLanded.pink.indexOf("1.3") >= 0 && bgCreamLanded.orange !== null && bgCreamLanded.orange.indexOf("1.15") >= 0 && (bgCreamLanded.focus === null || bgCreamLanded.focus === "") && bgCreamLanded.fv === false, JSON.stringify(bgCreamLanded));
// ⑪l11b 参考组件色板可用：切「粉」（#f472b6）→ 画布实色铺底 + 面板保持打开（业务口径「还有很多种颜色啊为什么不写了」全量落地；玫红已下架）
await clickSelector("[data-plan-bg-option=" + Q + "pink" + Q + "]");
await sleep(700);
const bgPink = await ev("(function(){var root=document.querySelector(" + j("[data-workspace-plan]") + ");var cs=root===null?null:getComputedStyle(root);var t=document.querySelector(" + j("[data-plan-toast]") + ");var pink=document.querySelector(" + j("[data-plan-bg-option=" + Q + "pink" + Q + "]") + ");var panel=document.querySelector(" + j("[data-plan-bg-panel]") + ");return {bg:cs===null?null:cs.backgroundColor,panel:panel!==null,active:pink===null?null:pink.getAttribute(" + j("aria-pressed") + "),shadow:pink===null?null:getComputedStyle(pink).boxShadow,toast:t===null?null:t.textContent.trim()};})()");
check("⑪l11b 参考组件色板可用：切「粉」→ 画布 = #f472b6 实色 + 面板保持打开 + 点击 / 选中不改变色块外观（粉投影仍常态）+ toast「已切换背景：粉。」", bgPink !== null && bgPink.bg === "rgb(244, 114, 182)" && bgPink.panel === true && bgPink.active === "true" && bgPink.shadow !== null && bgPink.shadow.indexOf("3.5px 3.5px") >= 0 && bgPink.toast.indexOf("粉") >= 0, JSON.stringify(bgPink));
await shot("21-我的计划-背景粉色.png");
let bgDbRow = null;
for (let i = 0; i < 20; i += 1) {
  bgDbRow = (await db.query("select (prefs -> 'myPlanBoard' ->> 'bg') as bg from user_preferences where user_id = $1", [me.id])).rows[0] ?? null;
  if (bgDbRow !== null && bgDbRow.bg === "pink") break;
  await sleep(300);
}
check("⑪l12 背景落库（换设备可见口径）：myPlanBoard.bg = pink 已写进账号偏好（user_preferences.prefs）", bgDbRow !== null && bgDbRow.bg === "pink", JSON.stringify(bgDbRow));
// 重开页（整页导航 = 换设备拉账号数据的同款读面）：仍是粉（实色）+「背景颜色」钮默认收起；再切回统一白（收尾，供 ⑪o 对账 / ⑪r / ⑪s / ⑪t 不受影响）
await open("#/my-tasks?tab=plan", "[data-workspace-plan]");
await waitFor("document.querySelector(" + j("[data-plan-grid]") + ") !== null", 15000);
const bgReopen = await ev("(function(){var root=document.querySelector(" + j("[data-workspace-plan]") + ");var cs=root===null?null:getComputedStyle(root);var trig=document.querySelector(" + j("[data-plan-bg-trigger]") + ");var panel=document.querySelector(" + j("[data-plan-bg-panel]") + ");return {bg:cs===null?null:cs.backgroundColor,img:cs===null?null:cs.backgroundImage,trig:trig!==null,panel:panel!==null};})()");
check("⑪l13 重开页仍是粉（账号读面带回 · 换设备可见）且「背景颜色」钮默认收起（面板不常驻）", bgReopen !== null && bgReopen.bg === "rgb(244, 114, 182)" && bgReopen.img === "none" && bgReopen.trig === true && bgReopen.panel === false, JSON.stringify(bgReopen));
await scrollSelectorIntoView("[data-plan-bg-trigger]");
await clickSelector("[data-plan-bg-trigger]");
await sleep(400);
await clickSelector("[data-plan-bg-option=" + Q + "cream" + Q + "]");
await sleep(700);
await clickSelector("[data-plan-bg-option=" + Q + "white" + Q + "]");
await sleep(700);
const bgBack = await ev("(function(){var root=document.querySelector(" + j("[data-workspace-plan]") + ");var cs=root===null?null:getComputedStyle(root);var t=document.querySelector(" + j("[data-plan-toast]") + ");var white=document.querySelector(" + j("[data-plan-bg-option=" + Q + "white" + Q + "]") + ");var panel=document.querySelector(" + j("[data-plan-bg-panel]") + ");return {bg:cs===null?null:cs.backgroundColor,active:white===null?null:white.getAttribute(" + j("aria-pressed") + "),shadow:white===null?null:getComputedStyle(white).boxShadow,toast:t===null?null:t.textContent.trim(),panel:panel!==null};})()");
check("⑪l13b 收尾跨色切回「统一白」（先「奶白」再「统一白」：防「本来就是白」的空切换无 toast，Run20 曾因此崩）：画布回纯白 + 面板保持打开 + 点击 / 选中不改变色块外观 + toast「已切换背景：统一白。」", bgBack !== null && bgBack.bg === "rgb(255, 255, 255)" && bgBack.active === "true" && bgBack.panel === true && bgBack.shadow !== null && bgBack.shadow.indexOf("3.5px 3.5px") >= 0 && bgBack.toast.indexOf("统一白") >= 0, JSON.stringify(bgBack));
await open("#/my-tasks?tab=plan", "[data-workspace-plan]");
await waitFor("document.querySelector(" + j("[data-plan-grid]") + ") !== null", 15000);
const plan4 = await ev(planExpr());
let prefsAfterPlan = null;
for (let i = 0; i < 20; i += 1) {
  const res = await api("/api/v1/users/me/preferences");
  prefsAfterPlan = res.json === null ? null : res.json.myPlanBoard;
  if (prefsAfterPlan !== null && prefsAfterPlan.notes.length === 6) break;
  await sleep(300);
}
check("⑪o 刷新 / 深链重开（#/my-tasks?tab=plan）→ 仍是账号里那 6 条（新建再删除的不复现；GET preferences.myPlanBoard 落库对账 6 条 / updatedAt 非 null）", plan4 !== null && plan4.cards.length === 6 && !plan4.cards.some((item) => item.id === createdId) && prefsAfterPlan !== null && prefsAfterPlan.notes.length === 6 && prefsAfterPlan.updatedAt !== null, plan4 === null ? "null" : JSON.stringify([plan4.cards.length, prefsAfterPlan === null ? null : prefsAfterPlan.notes.length]));
const headPlan2 = await ev(headExpr());
check("⑪p 深链直接打开 = 「我的计划」选中（刷新 / 收藏 / 分享同款）", headPlan2 !== null && headPlan2.tabs[2].current === "page" && headPlan2.hash === "#/my-tasks?tab=plan", headPlan2 === null ? "null" : JSON.stringify([headPlan2.tabs.map((item) => item.current), headPlan2.hash]));
await clickSelector("[data-workspace-tab=" + Q + "tasks" + Q + "]");
const headPlan3 = await ev(headExpr());
check("⑪q 点回「我的任务」→ 地址回到不带参数的 #/my-tasks（原口径不变）", headPlan3 !== null && headPlan3.hash === "#/my-tasks" && headPlan3.tabs[0].current === "page", headPlan3 === null ? "null" : JSON.stringify([headPlan3.hash, headPlan3.tabs.map((item) => item.current)]));

// ⑪r 首次进入（账号里从未保存过 myPlanBoard）：SQL 摘键 → 重开页 → 预置 6 条示例并上云（updatedAt 非 null）、本机不落旧键
await db.query("update user_preferences set prefs = prefs - 'myPlanBoard' where user_id = $1", [me.id]);
await open("#/my-tasks?tab=plan", "[data-workspace-plan]");
await waitFor("document.querySelector(" + j("[data-plan-grid]") + ") !== null", 15000);
const planFresh = await ev(planExpr());
let freshPrefs = null;
for (let i = 0; i < 20; i += 1) {
  const res = await api("/api/v1/users/me/preferences");
  freshPrefs = res.json === null ? null : res.json.myPlanBoard;
  if (freshPrefs !== null && freshPrefs.updatedAt !== null) break;
  await sleep(300);
}
const legacyAfterFresh = await ev("window.localStorage.getItem(" + j(LEGACY_PLAN_KEY) + ")");
check("⑪r 首次进入（账号里从未保存）：预置 6 条示例并上云（updatedAt 非 null / 6 条）+ 本机不落旧键", planFresh !== null && planFresh.cards.length === 6 && freshPrefs !== null && freshPrefs.updatedAt !== null && freshPrefs.notes.length === 6 && legacyAfterFresh === null, JSON.stringify([planFresh === null ? null : planFresh.cards.length, freshPrefs === null ? null : freshPrefs.updatedAt]));
// ⑪s 本机旧键（Push ≤ 267 的 localStorage）迁移：SQL 摘键 + 往页面 localStorage 塞 2 条旧便签 → 重开页 → 迁移上云、旧键清除、页面 = 迁移后 2 条
const legacyBoard = {
  v: 1,
  notes: [
    { id: "pn-legacy-1", title: "回放·旧键甲", content: "从本机迁上去", category: "待办", colorId: "green", fontId: "sans", createdAt: "2026-10-09T01:00:00.000Z", updatedAt: "2026-10-09T02:00:00.000Z" },
    { id: "pn-legacy-2", title: "回放·旧键乙", content: "迁移后清键", category: "想法", colorId: "orange", fontId: "mono", createdAt: "2026-10-08T01:00:00.000Z", updatedAt: "2026-10-08T02:00:00.000Z" },
  ],
  categories: ["待办", "想法"],
};
await db.query("update user_preferences set prefs = prefs - 'myPlanBoard' where user_id = $1", [me.id]);
await ev("window.localStorage.setItem(" + j(LEGACY_PLAN_KEY) + ", " + j(JSON.stringify(legacyBoard)) + ")");
await open("#/my-tasks?tab=plan", "[data-workspace-plan]");
await waitFor("document.querySelector(" + j("[data-plan-grid]") + ") !== null", 15000);
const planMigrated = await ev(planExpr());
let migratedPrefs = null;
for (let i = 0; i < 20; i += 1) {
  const res = await api("/api/v1/users/me/preferences");
  migratedPrefs = res.json === null ? null : res.json.myPlanBoard;
  if (migratedPrefs !== null && migratedPrefs.updatedAt !== null && migratedPrefs.notes.length === 2) break;
  await sleep(300);
}
const legacyAfterMigrate = await ev("window.localStorage.getItem(" + j(LEGACY_PLAN_KEY) + ")");
check("⑪s 本机旧键迁移（Push ≤ 267 的 localStorage 便签）：重开页自动上云（2 条、标题甲 / 乙）+ 旧键清除 + 页面 = 迁移后数据", planMigrated !== null && planMigrated.cards.length === 2 && planMigrated.cards[0] !== undefined && planMigrated.cards[0].title === "回放·旧键甲" && planMigrated.cards[1] !== undefined && planMigrated.cards[1].title === "回放·旧键乙" && migratedPrefs !== null && migratedPrefs.notes.length === 2 && legacyAfterMigrate === null, JSON.stringify([planMigrated === null ? null : planMigrated.cards.map((item) => item.title), migratedPrefs === null ? null : migratedPrefs.notes.length, legacyAfterMigrate]));
// ⑪t 收尾：账号偏好快照原样放回（⑪ 段不留痕）
const canonPlanNotes = (list) => JSON.stringify(list.map((note) => [note.id, note.title, note.content, note.category, note.colorId, note.fontId, note.done === true, note.createdAt, note.updatedAt]));
if (planPrefSnapshot === null) {
  await db.query("delete from user_preferences where user_id = $1", [me.id]);
} else {
  await db.query("update user_preferences set prefs = $2::jsonb, updated_at = $3::timestamptz where user_id = $1", [me.id, JSON.stringify(planPrefSnapshot.prefs), planPrefSnapshot.updated_at.toISOString()]);
}
const planRestoredPrefs = await api("/api/v1/users/me/preferences");
const planRestoredBoard = planRestoredPrefs.json === null ? null : planRestoredPrefs.json.myPlanBoard;
const planExpectBoard = planBoardBefore === null ? { notes: [], categories: [], updatedAt: null } : { notes: planBoardBefore.notes, categories: planBoardBefore.categories, updatedAt: planBoardBefore.updatedAt ?? null };
check("⑪t 回放收尾：账号偏好恢复快照（myPlanBoard 原样放回 / 原不存在 = 空 + updatedAt null；⑪ 段不留痕）", planRestoredBoard !== null && canonPlanNotes(planRestoredBoard.notes) === canonPlanNotes(planExpectBoard.notes) && JSON.stringify(planRestoredBoard.categories) === JSON.stringify(planExpectBoard.categories) && planRestoredBoard.updatedAt === planExpectBoard.updatedAt, planRestoredBoard === null ? "null" : JSON.stringify([planRestoredBoard.notes.length, planRestoredBoard.updatedAt]));
await parkMouse();

// ---------- ⑫ 标签导航栏吸顶（Push 235 · 业务口径「任务模版和我的任务都要做吸顶效果」） ----------
// 工作台默认内容不足一屏、吸顶滚不起来 —— 先补 16 条「今日」任务把 A 面板撑高，再把视口压到 560 当滚动空间；
// 收尾 ⑧ 照旧逐条软删任务、随项目物理删清零（本段不留痕：展开态偏好跑完再恢复原值）。
for (let index = 1; index <= 16; index += 1) {
  await addTask(projectA, { stageKey: "design", title: "回放·吸顶撑高-" + String(index), ownerIds: [me.id], plannedEnd: TODAY, priority: "低" });
}
const wsSticky = await api("/api/v1/workspace");
const stickyTodayTest = wsSticky.json === null ? -1 : inTest(wsSticky.json.myTasks.today).length;
const stickyTodayAll = wsSticky.json === null ? -1 : wsSticky.json.myTasks.today.length;
check("⑫a 夹具：16 条「今日」任务进工作台读面（测试项目今日组 2 + 16 = 18）", stickyTodayTest === 18, String(stickyTodayTest) + "（全读面今日 " + String(stickyTodayAll) + " 条）");
await page.send("Emulation.setDeviceMetricsOverride", { width: 1500, height: 560, deviceScaleFactor: 1, mobile: false });
await open("#/my-tasks", "[data-workspace-page]");
await waitFor("document.querySelector(" + j('[data-workspace-panel="' + projectA + '"]') + ") !== null", 25000);
await ensurePanelOpen(projectA, true);
const navSlot0 = await ev(stickyRect("[data-workspace-tabs]"));
check("⑫b 标签导航栏 = sticky / z 20 / 站灰底（α 0.95）+ 毛玻璃 / 自然位在顶栏下沿（top 64~65.5，滚动后钉到 64）", navSlot0 !== null && navSlot0.position === "sticky" && navSlot0.top >= 64 && navSlot0.top <= 65.5 && navSlot0.zIndex === "20" && navSlot0.bg.indexOf("0.95") >= 0 && navSlot0.blur.indexOf("blur") >= 0, navSlot0 === null ? "null" : JSON.stringify(navSlot0));
const room235 = await ev("(function(){return Math.round((document.documentElement.scrollHeight - window.innerHeight)*100)/100;})()");
check("⑫c 页面可滚动量足够（≥ 300px —— 吸顶要真滚起来才验得到；可滚量随夹具条数浮动，Push 260 起按实际可滚量滚）", typeof room235 === "number" && room235 >= 300, String(room235));
const scrollTarget235 = Math.max(0, Math.min(420, Math.round(room235) - 20));
await ev("window.scrollTo(0, " + String(scrollTarget235) + ")");
await sleep(400);
const scrolled235 = await ev("window.scrollY");
check("⑫d 滚动实际发生（scrollY ≥ 300）", scrolled235 >= 300, String(scrolled235));
const navSlot1 = await ev(stickyRect("[data-workspace-tabs]"));
check("⑫e 滚动后导航栏钉在顶栏正下方（top = 64；栏高 = 59 = pt-3 12 + 标签 46 + 底边 1）", navSlot1 !== null && Math.abs(navSlot1.top - 64) <= 0.5 && Math.abs(navSlot1.height - 59) <= 1, navSlot1 === null ? "null" : JSON.stringify([navSlot1.top, navSlot1.height]));
const clientW235 = await ev("document.documentElement.clientWidth");
check("⑫f 横幅铺满行宽（-mx-6 抵消后 left = 0 / right = 视口可用宽 clientWidth，扣纵向滚动条；页面不因此横向滚动）", navSlot1 !== null && Math.abs(navSlot1.left) <= 0.5 && Math.abs(navSlot1.right - clientW235) <= 0.5 && (await ev("document.documentElement.scrollWidth")) <= clientW235 + 1, navSlot1 === null ? "null" : JSON.stringify([navSlot1.left, navSlot1.right, clientW235]));
const inBar = await ev("(function(){var nav=document.querySelector(" + j("[data-workspace-tabs]") + ");if(nav===null){return null;}var r=nav.getBoundingClientRect();var tabs=nav.querySelectorAll(" + j("[data-workspace-tab]") + ");var ok=true;for(var i=0;i<tabs.length;i+=1){var b=tabs[i].getBoundingClientRect();if(b.height<=0||b.top<r.top-0.5||b.bottom>r.bottom+0.5){ok=false;}}return {ok:ok,tabs:tabs.length};})()");
check("⑫g 滚动后三枚标签都还在栏内（栏高兜得住、不吞字；Push 290 起栏内不再挂开关）", inBar !== null && inBar.ok === true && inBar.tabs === 3, JSON.stringify(inBar));
const hit235 = await ev("(function(){var tabs=document.querySelectorAll(" + j("[data-workspace-tab]") + ");for(var i=0;i<tabs.length;i+=1){if(tabs[i].getAttribute(" + j("aria-current") + ")===" + j("page") + "){var r=tabs[i].getBoundingClientRect();var el=document.elementFromPoint(Math.round(r.left+r.width/2),Math.round(r.top+r.height/2));return el!==null&&(el===tabs[i]||tabs[i].contains(el));}}return null;})()");
check("⑫h 吸顶状态下选中标签仍是命中元素（可点、不被浮层盖住）", hit235 === true, String(hit235));
await clickSelector('[data-workspace-tab="raised"]');
await waitFor("window.location.hash === " + j("#/my-tasks?tab=raised"), 15000);
check("⑫i 吸顶状态下点「我提出的问题」→ 路由照常写回（点击穿透到按钮本体）", (await ev("window.location.hash")) === "#/my-tasks?tab=raised", String(await ev("window.location.hash")));
await clickSelector('[data-workspace-tab="tasks"]');
await waitFor("window.location.hash === " + j("#/my-tasks"), 15000);
await waitFor("(function(){return document.documentElement.scrollHeight - window.innerHeight >= 300;})()", 20000);
const roomBack235 = await ev("(function(){return Math.round((document.documentElement.scrollHeight - window.innerHeight)*100)/100;})()");
const scrollTargetBack235 = Math.max(0, Math.min(420, Math.round(roomBack235) - 20));
await ev("window.scrollTo(0, " + String(scrollTargetBack235) + ")");
await sleep(400);
const scrolledBack = await ev("window.scrollY");
const navSlot3 = await ev(stickyRect("[data-workspace-tabs]"));
check("⑫j 切回「我的任务」再滚动：导航栏重新钉在 64（切标签不破坏吸顶）", scrolledBack >= 300 && navSlot3 !== null && Math.abs(navSlot3.top - 64) <= 0.5, JSON.stringify([scrolledBack, navSlot3 === null ? null : navSlot3.top]));
await ev("window.scrollTo(0, 0)");
await sleep(300);
const navSlot4 = await ev(stickyRect("[data-workspace-tabs]"));
check("⑫k 滚回顶部：导航栏回到自然位（top 64~65.5，滚动全程零跳变 / 零接缝）", navSlot4 !== null && navSlot4.top >= 64 && navSlot4.top <= 65.5, navSlot4 === null ? "null" : JSON.stringify(navSlot4.top));
await page.send("Emulation.setDeviceMetricsOverride", { width: 1500, height: 1000, deviceScaleFactor: 1, mobile: false });
const restored235 = await patchOpenProjects(memoryOriginal);
check("⑫l 回放收尾：账号偏好 workspaceOpenProjects 恢复原值（⑫ 的展开操作不留痕）", restored235 !== null && JSON.stringify(restored235.json.workspaceOpenProjects) === JSON.stringify(memoryOriginal), restored235 === null ? "null" : JSON.stringify(restored235.json.workspaceOpenProjects));
// ---------- ⑬（Push 260）「提出/负责的问题」下拉子菜单 + 「待我处理的问题」页 ----------
// 业务口径 2026-10-09「在我提出的问题增加子标签导航栏 和日报那样 增加待我处理的问题」+「页面中的信息要包括图二的人员信息」
// +「问题是否解决的颜色要统一和项目里面的一致」+「我处理的问题就是提出问题里面分类的问题」+「改成 提出/负责的问题」
// +「要居中这个状态」+「然后导航栏还是改成这样的吧」（图 = 项目页「日报及问题」的下拉子菜单）：两枚子视图收进主标签
// 「提出/负责的问题」的下拉面板（components/WorkspaceIssueSubMenu.tsx），地址口径仍是 ?tab=raised&sub=。
const subMenuExpr = () => "(function(){var panel=document.querySelector(" + j("[data-workspace-submenu]") + ");var items=panel===null?[]:panel.querySelectorAll(" + j("[data-workspace-subtab]") + ");var picked=[];for(var i=0;i<items.length;i+=1){picked.push({key:String(items[i].getAttribute(" + j("data-workspace-subtab") + ")),text:String(items[i].textContent.trim()),current:items[i].getAttribute(" + j("aria-current") + ")});}var nodes=document.querySelectorAll(" + j("[data-workspace-tab]") + ");var main={};var tabs=[];var raisedTab=null;for(var m=0;m<nodes.length;m+=1){var node=nodes[m];var key=String(node.getAttribute(" + j("data-workspace-tab") + "));main[key]=node.getAttribute(" + j("aria-current") + ");tabs.push({key:key,text:String(node.textContent.trim()),current:node.getAttribute(" + j("aria-current") + "),haspopup:node.getAttribute(" + j("aria-haspopup") + "),isParent:node.getAttribute(" + j("data-workspace-tab-parent") + "),expanded:node.getAttribute(" + j("aria-expanded") + "),chevron:node.querySelector(" + j("svg") + ")!==null});if(key===" + j("raised") + "){raisedTab=node;}}var view=document.querySelector(" + j("[data-workspace-issues]") + ");var head=view===null?null:view.querySelector(" + j("h2") + ");var total=document.querySelector(" + j("[data-workspace-issue-total]") + ");var geom=null;if(panel!==null&&raisedTab!==null){var pr=panel.getBoundingClientRect();var tr=raisedTab.getBoundingClientRect();var cs=getComputedStyle(panel);geom={inNav:panel.closest(" + j("[data-workspace-tabs]") + ")!==null,role:panel.getAttribute(" + j("role") + "),leftGap:Math.round((pr.left-tr.left)*100)/100,topGap:Math.round((pr.top-tr.bottom)*100)/100,width:Math.round(pr.width),height:Math.round(pr.height),bg:String(cs.backgroundColor),radius:String(cs.borderRadius),itemCount:items.length};}return {open:panel!==null,items:picked,tabs:tabs,main:main,geom:geom,hash:window.location.hash,view:view===null?null:String(view.getAttribute(" + j("data-workspace-issues-view") + ")),title:head===null?null:String(head.textContent.trim()),total:total===null?null:String(total.textContent.trim())};})()";
const chipClassExpr = (selector) => "(function(){var n=document.querySelector(" + j(selector) + ");return n===null?null:String(n.getAttribute(" + j("class") + "));})()";
const classTokensOf = (value) => (value === null ? [] : value.trim().split(/\s+/).sort());
const tabOf = (snapshot, key) => (snapshot === null ? null : snapshot.tabs.filter((item) => item.key === key)[0]);
// 前置：展开态归零（本节「页面打开 = 全收起」断言的基线；跑完 ⑬n 恢复原值）
const memoryReset260 = await patchOpenProjects({ tasks: [], raised: [] });
check("⑬a0 前置：展开态偏好归零", memoryReset260 !== null, memoryReset260 === null ? "null" : JSON.stringify(memoryReset260.json.workspaceOpenProjects));
await parkMouse();
await open("#/my-tasks?tab=raised", "[data-workspace-page]");
const closed260 = await ev(subMenuExpr());
const closedTab260 = tabOf(closed260, "raised");
check("⑬a 页面打开：下拉面板默认收起（主标签「提出/负责的问题」带 ▾、aria-haspopup=menu、aria-expanded=false）；标题 / 数据栏 = raised、地址不带 ?sub=", closed260 !== null && closed260.open === false && closedTab260 !== null && closedTab260.text.indexOf("提出/负责的问题") >= 0 && closedTab260.current === "page" && closedTab260.haspopup === "menu" && closedTab260.isParent === "true" && closedTab260.expanded === "false" && closedTab260.chevron === true && closed260.view === "raised" && closed260.title === "我提出的问题" && closed260.hash === "#/my-tasks?tab=raised", JSON.stringify(closed260));
await hoverRaisedTab();
const hover260 = await ev(subMenuExpr());
check("⑬b 悬停父标签即展开（同项目页「日报及问题」）：白色圆角面板挂在主标签栏内、左缘对齐父标签、两枚子项（我提出的问题 / 待我处理的问题）、缺省选中「我提出的问题」", hover260 !== null && hover260.open === true && hover260.geom !== null && hover260.geom.inNav === true && hover260.geom.role === "menu" && Math.abs(hover260.geom.leftGap) <= 2 && hover260.geom.topGap >= 0 && hover260.geom.topGap <= 16 && hover260.geom.bg === "rgb(255, 255, 255)" && hover260.geom.itemCount === 2 && hover260.items.map((item) => item.text).join("|") === "我提出的问题|待我处理的问题" && hover260.items.map((item) => item.key).join("|") === "raised|handling" && hover260.items[0].current === "page" && hover260.items[1].current === null && tabOf(hover260, "raised").expanded === "true" && hover260.main.raised === "page", JSON.stringify(hover260));
await shot("m6-06-workspace-submenu.png");
await parkMouse();
const parked260 = await ev(subMenuExpr());
check("⑬c 鼠标移开：面板自动收起（160ms 延迟），页面回到无面板态、aria-expanded=false", parked260 !== null && parked260.open === false && tabOf(parked260, "raised").expanded === "false", JSON.stringify([parked260 === null ? null : parked260.open, parked260 === null ? null : tabOf(parked260, "raised").expanded]));
// 下拉只挂在「提出/负责的问题」这枚标签上（「我的任务」/「我的计划」没有 ▾、没有面板）
await clickSelector("[data-workspace-tab=" + Q + "tasks" + Q + "]");
await waitFor("window.location.hash === " + j("#/my-tasks") + " && document.querySelector(" + j("[data-workspace-tasks]") + ") !== null", 25000);
const tasks260 = await ev(subMenuExpr());
await clickSelector("[data-workspace-tab=" + Q + "plan" + Q + "]");
await waitFor("window.location.hash === " + j("#/my-tasks?tab=plan") + " && document.querySelector(" + j("[data-workspace-plan]") + ") !== null", 25000);
const plan260 = await ev(subMenuExpr());
const withPopups260 = (snapshot) => (snapshot === null ? null : snapshot.tabs.filter((item) => item.haspopup !== null).map((item) => item.key).join("|"));
const withChevrons260 = (snapshot) => (snapshot === null ? null : snapshot.tabs.filter((item) => item.chevron).length);
check("⑬d 下拉只在「提出/负责的问题」标签上挂：「我的任务」/「我的计划」没有 aria-haspopup、没有 ▾、DOM 里没有面板（haspopup 全栏只有 raised 一枚）", tasks260 !== null && tasks260.open === false && plan260 !== null && plan260.open === false && withPopups260(tasks260) === "raised" && withPopups260(plan260) === "raised" && withChevrons260(tasks260) === 1 && tabOf(tasks260, "tasks").haspopup === null && tabOf(tasks260, "plan").haspopup === null && tabOf(plan260, "tasks").haspopup === null && tabOf(plan260, "plan").haspopup === null, JSON.stringify([tasks260 === null ? null : withPopups260(tasks260), plan260 === null ? null : withPopups260(plan260)]));
// 点父标签 = 切回 raised 并展开面板；再点子项「待我处理的问题」→ 地址 + 数据栏切换 + 自动收起
await clickSelector("[data-workspace-tab=" + Q + "raised" + Q + "]");
const raisedOn260 = await waitFor("window.location.hash === " + j("#/my-tasks?tab=raised") + " && document.querySelector(" + j("[data-workspace-submenu]") + ") !== null", 25000);
const reopened260 = await ev(subMenuExpr());
check("⑬e 点父标签 = 切回「提出/负责的问题」并保持展开（鼠标先到必然先 hover，点击不切换成收起）", raisedOn260 === true && reopened260 !== null && reopened260.open === true && tabOf(reopened260, "raised").expanded === "true" && tabOf(reopened260, "raised").current === "page" && reopened260.view === "raised", JSON.stringify(reopened260));
const handlingShown = ws.myIssues.handling.filter((item) => item.state !== "done");
const handlingShownIds = idsOf(handlingShown);
const handlingProjects = {};
for (const item of handlingShown) { handlingProjects[item.projectId] = true; }
await clickSelector("[data-workspace-submenu] [data-workspace-subtab=" + Q + "handling" + Q + "]");
const handlingOn = await waitFor("window.location.hash === " + j("#/my-tasks?tab=raised&sub=handling") + " && document.querySelector(" + j("[data-workspace-issues-view=" + Q + "handling" + Q + "]") + ") !== null", 25000);
const handling260 = await ev(subMenuExpr());
check("⑬f 选「待我处理的问题」→ 地址写回 ?tab=raised&sub=handling、面板自动收起、标题切「待我处理的问题」、汇总行与接口 handling 栏（剔已完成）逐项对账（共 N 条 · 跨 M 个项目 · 已完成不显示）", handlingOn === true && handling260 !== null && handling260.open === false && handling260.view === "handling" && handling260.title === "待我处理的问题" && handling260.main.raised === "page" && typeof handling260.total === "string" && handling260.total.indexOf("共 " + String(handlingShownIds.length) + " 条") >= 0 && handling260.total.indexOf("跨 " + String(Object.keys(handlingProjects).length) + " 个项目") >= 0 && handling260.total.indexOf("已完成不显示") >= 0, JSON.stringify([handlingOn, handling260]));
await parkMouse();
const panelsHandling = await ev(panelsExpr());
const panelsHandlingTest = panelsHandling === null ? null : panelsHandling.filter((item) => TEST_PROJECTS.indexOf(item.id) >= 0);
check("⑬g 「待我处理的问题」按项目分组（A / B 两个面板；归零后默认全收起 —— 两枚子视图共用同一组展开记忆）", panelsHandlingTest !== null && panelsHandlingTest.length === 2 && panelsHandlingTest.every((item) => item.open === "false") && panelsHandlingTest.map((item) => item.id).sort().join(",") === [projectA, projectB].sort().join(","), JSON.stringify(panelsHandling));
await clickSelector("[data-workspace-panel=" + Q + projectA + Q + "] [data-workspace-panel-toggle]");
const rowsHandlingA = await ev(issueRowsExpr(projectA));
check("⑬h 「待我处理的问题」表 = 与「我提出的问题」同一张表（七列同构、同一套问题归类色签）：A 面板 1 条（A1 未解决；A2 已完成 → 不显示）、处理人列 = 我（" + me.displayName + "）、未解决 sky 色签", rowsHandlingA !== null && rowsHandlingA.table === true && rowsHandlingA.heads.length === 7 && rowsHandlingA.rows.length === 1 && rowsHandlingA.rows[0].id === issueA1.issue.id && rowsHandlingA.rows.every((item) => item.id !== issueA2.issue.id) && rowsHandlingA.rows[0].owner === me.displayName && rowsHandlingA.rows[0].categories.indexOf("机械部") >= 0 && rowsHandlingA.rows[0].state === "未解决" && rowsHandlingA.rows[0].stateClass.indexOf("bg-sky-100") >= 0, rowsHandlingA === null ? "null" : JSON.stringify(rowsHandlingA.rows));
await shot("m6-06-workspace-handling.png");
await clickSelector("[data-workspace-panel=" + Q + projectB + Q + "] [data-workspace-panel-toggle]");
const rowsHandlingB = await ev(issueRowsExpr(projectB));
check("⑬i 跨项目：B 面板 1 条 = 反例用户提出、处理人是我那条（「我处理的」含、「我提出的」不含 —— 两栏口径互不串台）", rowsHandlingB !== null && rowsHandlingB.table === true && rowsHandlingB.rows.length === 1 && rowsHandlingB.rows[0].id === issueOther.issue.id && rowsHandlingB.rows[0].owner === me.displayName, rowsHandlingB === null ? "null" : JSON.stringify(rowsHandlingB.rows));
// 共用展开记忆：从下拉切回「我提出的问题」，刚才展开的 A / B 仍展开（偏好键 workspaceOpenProjects.raised）
await clickSelector("[data-workspace-tab=" + Q + "raised" + Q + "]");
const submenuBack260 = await waitFor("document.querySelector(" + j("[data-workspace-submenu]") + ") !== null", 15000);
await clickSelector("[data-workspace-submenu] [data-workspace-subtab=" + Q + "raised" + Q + "]");
const raisedBack = await waitFor("window.location.hash === " + j("#/my-tasks?tab=raised") + " && document.querySelector(" + j("[data-workspace-issues-view=" + Q + "raised" + Q + "]") + ") !== null", 25000);
const panelsBack = await ev(panelsExpr());
const panelsBackTest = panelsBack === null ? null : panelsBack.filter((item) => TEST_PROJECTS.indexOf(item.id) >= 0);
check("⑬j 两枚子视图共用同一组展开记忆：从下拉切回「我提出的问题」刚才展开的 A / B 仍展开（偏好键 workspaceOpenProjects.raised）", submenuBack260 === true && raisedBack === true && panelsBackTest !== null && panelsBackTest.length === 2 && panelsBackTest.every((item) => item.open === "true") && panelsBackTest.every((item) => item.rows > 0), JSON.stringify(panelsBack));
await parkMouse();
// 色签硬核对：工作台问题表 ↔ 项目页「问题追踪」逐 token 相等（业务口径「问题是否解决的颜色要统一和项目里面的一致」）
const wsChipClass = await ev(chipClassExpr("[data-workspace-issue=" + Q + issueA1.issue.id + Q + "] [data-issue-state]"));
await open("#/project/" + projectA + "?view=daily&sub=issues", "[data-issue-search]");
const projChipOk = await waitFor("document.querySelector(" + j("[data-issue-row=" + Q + issueA1.issue.id + Q + "] [data-issue-state]") + ") !== null", 25000);
const projChipClass = await ev(chipClassExpr("[data-issue-row=" + Q + issueA1.issue.id + Q + "] [data-issue-state]"));
const wsChipTokens = classTokensOf(wsChipClass);
check("⑬k 色签统一硬核对：工作台「问题是否处理」与项目页「问题追踪」class token 集合完全相等（壳体 rounded-lg / px-3 / py-1.5 / text-[11px] + 底色 / 字色）", projChipOk === true && wsChipClass !== null && projChipClass !== null && wsChipTokens.length > 0 && JSON.stringify(wsChipTokens) === JSON.stringify(classTokensOf(projChipClass)) && wsChipTokens.indexOf("rounded-lg") >= 0 && wsChipTokens.indexOf("px-3") >= 0 && wsChipTokens.indexOf("py-1.5") >= 0, JSON.stringify([wsChipClass, projChipClass]));
// 深链 / 未知子视图：?sub=handling 直接打开停在该子视图（下拉里选中态跟着走）；不认识的值落回缺省 raised（地址不纠正）
await parkMouse();
await open("#/my-tasks?tab=raised&sub=handling", "[data-workspace-page]");
await hoverRaisedTab();
const deepHandling = await ev(subMenuExpr());
check("⑬l 深链 #/my-tasks?tab=raised&sub=handling 直接打开 = 「待我处理的问题」选中（下拉点开即见 aria-current=page；刷新 / 收藏 / 分享同款）", deepHandling !== null && deepHandling.hash === "#/my-tasks?tab=raised&sub=handling" && deepHandling.open === true && deepHandling.items[1].current === "page" && deepHandling.items[0].current === null && deepHandling.view === "handling", JSON.stringify(deepHandling));
await parkMouse();
await open("#/my-tasks?tab=raised&sub=zzz", "[data-workspace-page]");
await hoverRaisedTab();
const deepUnknown = await ev(subMenuExpr());
check("⑬m ?sub= 不认识的值落回缺省「我提出的问题」（下拉里选中第一枚；地址不纠正，与 ?tab= / ?view= 同口径）", deepUnknown !== null && deepUnknown.open === true && deepUnknown.items[0].current === "page" && deepUnknown.items[1].current === null && deepUnknown.view === "raised", JSON.stringify(deepUnknown));
await parkMouse();
const restored260 = await patchOpenProjects(memoryOriginal);
check("⑬n 回放收尾：账号偏好 workspaceOpenProjects 恢复原值（⑬ 的展开操作不留痕）", restored260 !== null && JSON.stringify(restored260.json.workspaceOpenProjects) === JSON.stringify(memoryOriginal), restored260 === null ? "null" : JSON.stringify(restored260.json.workspaceOpenProjects));
// ---------- ⑧ 收尾：清理 + 控制台 ----------
// ⑥k 的乐观锁冲突（409）是刻意造的：浏览器把这次失败请求记一条 network error —— 精确豁免这一条
// （文案含「status of 409」；至多 1 条，多出来的 / 别的一律照旧判失败），其余控制台 / 未捕获异常必须 0 条。
const consoleLines = page.events.filter((line) => line.indexOf("EVT Runtime.exceptionThrown") >= 0 || line.indexOf("EVT Log.entryAdded") >= 0);
const conflictNoise260 = consoleLines.filter((line) => line.indexOf("status of 409") >= 0);
const consoleLinesReal = consoleLines.filter((line) => line.indexOf("status of 409") < 0);
check("⑧a 页面控制台 / 未捕获异常 0 条（⑥k 刻意造的 409 冲突响应记 1 条 network error，属预期、豁免）", consoleLinesReal.length === 0 && conflictNoise260.length <= 1, JSON.stringify([consoleLinesReal.slice(0, 3), conflictNoise260.length]));

page.ws.close();
chrome.kill();
await sleep(400);
try { rmSync(profile, { recursive: true, force: true }); } catch (error) { /* 收尾不阻塞 */ }

await purgeProjectFiles(projectA);
const delA = (await db.query("select version from projects where id = $1", [projectA])).rows[0];
const goneA = delA === undefined ? { status: 0 } : await api("/api/v1/projects/" + projectA, "DELETE", undefined, { "If-Match": String(delA.version) });
check("⑧b 删临时项目 A（物理删 200）", goneA.status === 200, String(goneA.status));
await purgeProjectFiles(projectB);
const delB = (await db.query("select version from projects where id = $1", [projectB])).rows[0];
const goneB = delB === undefined ? { status: 0 } : await api("/api/v1/projects/" + projectB, "DELETE", undefined, { "If-Match": String(delB.version) });
check("⑧c 删临时项目 B（物理删 200）", goneB.status === 200, String(goneB.status));
await purgeProjectFiles(projectC);
const delC = (await db.query("select version from projects where id = $1", [projectC])).rows[0];
const goneC = delC === undefined ? { status: 0 } : await api("/api/v1/projects/" + projectC, "DELETE", undefined, { "If-Match": String(delC.version) });
check("⑧c2 删临时项目 C（物理删 200）", goneC.status === 200, String(goneC.status));
const goneRead = await api("/api/v1/projects/" + projectA);
check("⑧d 删完读面 404（真删，不是软删留档）", goneRead.status === 404, String(goneRead.status));
await db.query("update sessions set revoked_at = now() where token_hash = any($1) or id_token = $2", [[sha256(me.token), sha256(other.token)], "px-m6-workspace-replay"]);
const residue = (await db.query(
  "select (select count(*) from projects where code like $1) as projects, (select count(*) from tasks where project_id = any($2)) as tasks, (select count(*) from daily_reports where project_id = any($2)) as reports, (select count(*) from issues where project_id = any($2)) as issues, (select count(*) from sessions where id_token = $3 and revoked_at is null) as sessions",
  ["PX-M6WS-%", [projectA, projectB, projectC], "px-m6-workspace-replay"],
)).rows[0];
check("⑧e 库内零残留（项目 / 任务 / 日报 / 问题 / 未撤销会话 全 0）", Number(residue.projects) === 0 && Number(residue.tasks) === 0 && Number(residue.reports) === 0 && Number(residue.issues) === 0 && Number(residue.sessions) === 0, JSON.stringify(residue));
await db.end();

const failed = checks.filter((ok) => ok !== true).length;
console.log("");
console.log("—— 汇总：" + String(checks.length - failed) + " / " + String(checks.length) + " 通过" + (failed === 0 ? "（全过）" : "（" + String(failed) + " 项失败）"));
process.exitCode = failed === 0 ? 0 : 1;
