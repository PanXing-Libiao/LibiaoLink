#!/usr/bin/env node
/**
 * LibiaoLink 前端 · 回放：地区按洲分组（首页筛选侧栏可展开 + 新建 / 编辑项目的地区改「分洲 + 可搜索」选择器）
 *
 * 业务口径（2026-09-28）：「我觉得这里太乱了 要根据各个州分类 可以展开 这边要改那新建项目选择地区应该也要改
 *   是不是要加一个国家地区选择器可搜索的那种」。
 *
 * 本脚本用真机浏览器（无头 Chrome + CDP，真实鼠标坐标 / 真实键盘输入）验：
 *   ① 侧栏「地区」段 = 按洲分组（亚洲 / 欧洲 / 非洲 / 北美洲 / 南美洲 / 大洋洲 / 其他），不再是几十枚胶囊一片平铺；
 *   ② 分组可展开 / 收起：默认只展开「有勾选的洲」（面板打开是干净几行），「全部展开 / 全部收起」一键切换，
 *      组头带「N 个地区」与「已选 N」；分洲后一枚不多一枚不少（与库内 facets 对账）；
 *   ③ 点胶囊照旧按地区筛选（URL 写 filter[region]、卡片计数同步）；
 *   ④ 新建项目弹窗的项目地区 = 贴字段弹出的小窗（Push 195 返工）：「还是要之前的小窗 然后最上方是已有项目地区」
 *      ＋「小窗做分页 已有项目地区 / 全部地区 然后选中标蓝即可 不要这个勾」——两个页签：已有项目地区（有项目在用、
 *      按用量降序、带项目数；Push 304 起按项目落库值聚合 —— 字典外国名也照数）/ 全部地区（标准国家清单 201 条（中国标准地图口径）+ 字典独有条目，按洲分组 —— 字典
 *      没收录的国家也能搜到、选到）；两个页签的小窗同高同位（「两个分页的高度位置要一致」：固定尺寸，切页不跳）；
 *      打开即聚焦搜索框、输入关键词自动切到全部地区页、中英文都能搜（冰岛 / Iceland）、
 *      搜不到给提示行、回车选当前页第一条；选中态 = 标蓝（不带对勾）；纯选择：无「＋ 添加地区」、无行内删除、不支持手填；
 *   ⑤ 洲口径 = 中国口径（与地图同一套国界 / 国名口径）：中国 / 日本 / 新加坡 在亚洲，英国 / 德国 / 俄罗斯 / 冰岛 在欧洲，
 *      南非 / 埃及 在非洲，美国 / 加拿大 在北美洲，巴西 / 秘鲁 在南美洲，澳大利亚 / 新西兰 在大洋洲；
 *      台湾 / 科索沃 / 北塞浦路斯 / 索马里兰 一个都不许出现（中国口径硬护栏），香港 / 澳门 也不在候选里；
 *   ⑥ 整洲筛选（Push 193）：「某一个洲点击可以直接筛选整个洲」—— 勾洲行最右侧的复选框 = 把该洲全部地区
 *      一起勾上（并展开），再点一次取消；URL / 工具条计数 / 复选框状态与库内对账；
 *   ⑦ 地区选择不再承载字典维护（Push 194 / 195）：断言无添加入口、无删除按钮、小窗里只有搜索框 1 个输入框
 *      （不能手填）、地区触发器是 button；Esc / 再点触发器先关小窗、项目弹窗保持打开；库内地区字典前后一行不差；
 *   ⑧ 控制台零报错；跑完会话撤销、库内零残留（全程只读：不建项目、不写字典）。
 *
 * 前置（三件都在本机跑着）：
 *   1. 前端 dev：cd frontend && npm run dev（默认 3000）
 *   2. api：cd server && npm run start:api（默认 3001，需先 npm run build）
 *   3. 数据库：本地沙箱 PG（默认 127.0.0.1:5433/libiaolink）
 *   4. 本机装了 Chrome（脚本 headless 起一个调试实例；路径可用 CHROME_PATH 覆盖）
 *
 * 用法：node scripts/ui-region-continent-e2e.mjs
 *   可覆盖的环境变量：FRONTEND_BASE / DATABASE_URL / CHROME_PATH / CDP_PORT / REPLAY_USER / PG_MODULE / SHOT_DIR
 */

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
const PG_MODULE = process.env.PG_MODULE ?? new URL("../../server/node_modules/pg/lib/index.js", import.meta.url).href;
const { default: pg } = await import(PG_MODULE);
const { Client } = pg;
const FRONTEND = process.env.FRONTEND_BASE ?? "http://localhost:3000";
const CHROME = process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PORT = Number(process.env.CDP_PORT ?? 9403);
const DB = process.env.DATABASE_URL ?? "postgres://libiaolink_api@127.0.0.1:5433/libiaolink";
const REPLAY_USER = process.env.REPLAY_USER ?? "px-replay";
const SHOTS = process.env.SHOT_DIR ?? join(tmpdir(), "px-region-continent-shots");
const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const j = (value) => JSON.stringify(value);
/** 洲名白名单（中国口径）与兜底组 */
const CONTINENTS = ["亚洲", "欧洲", "非洲", "北美洲", "南美洲", "大洋洲"];
const OTHER_GROUP = "其他";
/** 中国口径硬护栏：不许作为国家出现在任何候选里（与地图 e2e 同一份清单） */
const FORBIDDEN = ["台湾", "科索沃", "北塞浦路斯", "索马里兰"];
/** 洲归属抽查（拿库内在用的地区对账；口径 = 中国口径，与地图同一套） */
const CONTINENT_SPOT = [
  ["亚洲", ["中国", "日本", "新加坡"]],
  ["欧洲", ["英国", "德国", "俄罗斯"]],
  ["非洲", ["南非"]],
  ["北美洲", ["美国", "加拿大"]],
  ["南美洲", ["巴西", "秘鲁"]],
  ["大洋洲", ["澳大利亚", "新西兰"]]
];
/**
 * 小窗候选里的洲归属抽查（Push 195：候选 = 标准国家清单，不再依赖字典存量 —— 每条必须找到，不许跳过）：
 * 六大洲各挑代表（含微国新加坡 与 用户原话场景冰岛 / 埃及 —— 后三条沙箱里通常没项目，用来在洲段严格对账）。
 * 有项目在用的国家会被上提到「已有项目地区」段（业务口径），命中该段算通过、计入上提数。
 */
const PICKER_SPOT = [
  ["亚洲", "中国"], ["亚洲", "新加坡"], ["亚洲", "约旦"], ["欧洲", "冰岛"], ["欧洲", "英国"], ["欧洲", "芬兰"],
  ["非洲", "埃及"], ["非洲", "苏丹"], ["北美洲", "美国"], ["南美洲", "巴西"], ["大洋洲", "澳大利亚"], ["大洋洲", "新西兰"]
];

/** 搜索框关键词与预期候选（冰岛 = 用户原话「搜索现在没有的国家」场景 —— 字典里没有、标准清单里必须有） */
const SEARCH_ZH = "冰岛";
const SEARCH_EN = "Iceland";
const SEARCH_ALT_EN = "Brazil";
const SEARCH_MISS = "zzzz";

mkdirSync(SHOTS, { recursive: true });
const db = new Client({ connectionString: DB });
await db.connect();
const userRow = (await db.query("select id, username, display_name from users where username = $1 and status = 'active'", [REPLAY_USER])).rows[0];
if (userRow === undefined) {
  console.error("回放用户不存在：" + REPLAY_USER);
  process.exit(1);
}
const dictRegionRows = (await db.query("select code, name from dict_items where type_code = $1 and enabled order by sort", ["region"])).rows;
const dictRegionCount = dictRegionRows.length;
const projectRows = (await db.query("select region, count(*)::int as n from projects where deleted_at is null group by region")).rows;
const projectTotal = projectRows.reduce((sum, row) => sum + Number(row.n), 0);
const labelOfRegion = new Map(dictRegionRows.map((row) => [row.code, row.name]));
const regionLabel = (region) => (labelOfRegion.get(region) ?? region);
/** 侧栏里该出现的地区胶囊（= 有项目的地区，按字典名归拢） */
const facetLabels = Array.from(new Set(projectRows.map((row) => regionLabel(row.region)))).sort();
console.log("临时会话：" + userRow.username + "（" + userRow.display_name + "）");
console.log("库内：项目 " + String(projectTotal) + " 个 / 用到地区 " + String(facetLabels.length) + " 个 / 地区字典 " + String(dictRegionCount) + " 条");

const token = "pxregion-" + randomBytes(16).toString("hex");
const csrf = randomBytes(16).toString("hex");
await db.query("insert into sessions (token_hash, user_id, id_token, expires_at) values ($1, $2, $3, now() + make_interval(mins => 30))", [sha256(token), userRow.id, "px-region-continent-e2e"]);

const profile = mkdtempSync(join(tmpdir(), "pxregion-"));
const chrome = spawn(CHROME, ["--headless=new", "--remote-debugging-port=" + PORT, "--user-data-dir=" + profile, "--no-first-run", "--no-default-browser-check", "--disable-gpu", "about:blank"], { stdio: "ignore" });

async function waitTarget() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const list = await (await fetch("http://127.0.0.1:" + PORT + "/json/list")).json();
      const target = list.find((item) => item.type === "page" && item.webSocketDebuggerUrl);
      if (target) {
        return target;
      }
    } catch (error) {
      // 未就绪
    }
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
        if (msg.error) {
          item.reject(new Error(JSON.stringify(msg.error)));
        } else {
          item.resolve(msg.result);
        }
        return;
      }
      if (msg.method === "Runtime.exceptionThrown") {
        consoleErrors.push("exception: " + String(msg.params.exceptionDetails.text));
      }
      if (msg.method === "Runtime.consoleAPICalled" && (msg.params.type === "error" || msg.params.type === "warning")) {
        consoleErrors.push(msg.params.type + ": " + msg.params.args.map((arg) => String(arg.value === undefined ? arg.description : arg.value)).join(" "));
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

const consoleErrors = [];
const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok: ok === true, detail });
  console.log((ok === true ? "  PASS  " : "  FAIL  ") + name + (ok === true ? "" : "  —— " + String(detail)));
}

const target = await waitTarget();
const page = new Cdp(target.webSocketDebuggerUrl);
await page.ready;
await page.send("Network.enable");
await page.send("Page.enable");
await page.send("Runtime.enable");
await page.send("Network.setCookie", { name: "ll_sid", value: token, url: FRONTEND + "/", path: "/", httpOnly: true, secure: false });
await page.send("Network.setCookie", { name: "ll_csrf", value: csrf, url: FRONTEND + "/", path: "/", httpOnly: false, secure: false });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ev = async (expression) => (await page.send("Runtime.evaluate", { expression, returnByValue: true })).result.value;
/** 页面里跑一个无闭包的探针函数（toString 送进浏览器，省去手写转义） */
const probe = async (fn) => await ev("(" + fn.toString() + ")()");
/** 等到页面里某个布尔表达式为真（默认 20 秒） */
async function waitFor(expression, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await ev(expression)) === true) {
      return true;
    }
    await sleep(250);
  }
  return false;
}

async function clickAt(point) {
  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y, button: "none" });
  await page.send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1 });
  await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1 });
  await sleep(600);
}

async function rectOf(selector) {
  return await ev(
    "(() => { const node = document.querySelector(" + j(selector) + ");" +
    " if (node === null) { return null; }" +
    " node.scrollIntoView({ block: " + j("nearest") + ", inline: " + j("nearest") + " });" +
    " const box = node.getBoundingClientRect();" +
    " if (box.width === 0 || box.height === 0) { return null; }" +
    " return { x: box.left + box.width / 2, y: box.top + box.height / 2 }; })()"
  );
}

async function clickSelector(selector) {
  const point = await rectOf(selector);
  if (point === null) {
    throw new Error("点不到（元素不存在或不可见）：" + selector);
  }
  await clickAt(point);
}

/** 首屏导航：打开列表页并等侧栏地区分组就绪 */
const SIDEBAR_SECTION = "[data-region-section=true]";
const SIDEBAR_SWITCH = "label:has(input[aria-controls=category-filter-panel])";
const CONTINENT_GROUP_SELECTOR = "[data-continent-group]";
const CONTINENT_ALL_SELECTOR = "[data-continent-all]";
const REGION_TRIGGER = "[aria-label=" + j("选择项目地区") + "]";
const PROJECT_DIALOG = "[role=dialog][aria-label=" + j("新建项目") + "]";
const REGION_POPUP = "[data-region-popover=true]";
const REGION_POPUP_SEARCH = REGION_POPUP + " input";
const REGION_POPUP_OPTION = REGION_POPUP + " [role=listbox] [role=option]";
const CREATE_BUTTON = "button:has(svg path[d=" + j("M12 5v14M5 12h14") + "])";

async function openList(hash, width = 1440, height = 900) {
  await page.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
  await page.send("Page.navigate", { url: "about:blank" });
  await sleep(300);
  await page.send("Page.navigate", { url: FRONTEND + "/" + hash });
  await waitFor("document.querySelector(" + j(SIDEBAR_SECTION) + ")!==null");
  await waitFor("document.querySelectorAll(" + j(CONTINENT_GROUP_SELECTOR) + ").length>0");
  await sleep(500);
}

async function openSidebar() {
  // 幂等：侧栏开合会记进 localStorage（saveSidebarPref），新页面可能**自带打开状态** ——
  // 已打开就不要再去点开关（否则会把它关掉，后面的真实点击全部落空）。
  await sleep(400);
  const opened = await ev(
    "(() => { const panel = document.querySelector(" + j("#category-filter-panel") + ");" +
    " return panel !== null && panel.getBoundingClientRect().left >= 0; })()"
  );
  if (opened !== true) {
    await clickSelector(SIDEBAR_SWITCH);
    await sleep(600);
  }
  await waitFor("document.querySelector(" + j("#category-filter-panel") + ").getBoundingClientRect().left>=0");
}

async function typeText(text) {
  await page.send("Input.insertText", { text });
  await sleep(500);
}

async function pressKey(key, code, vk, modifiers = 0) {
  await page.send("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers });
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers });
  await sleep(350);
}

async function pressEnter() {
  await pressKey("Enter", "Enter", 13);
  await sleep(400);
}

/** 清空搜索框：Ctrl+A 全选 + Backspace（走真实键盘，React 的 onChange 照常触发） */
async function clearSearch() {
  await pressKey("a", "KeyA", 65, 2);
  await pressKey("Backspace", "Backspace", 8);
  await sleep(400);
}

async function shot(name) {
  const result = await page.send("Page.captureScreenshot", { format: "png", fromSurface: true });
  const file = join(SHOTS, name + ".png");
  writeFileSync(file, Buffer.from(result.data, "base64"));
  console.log("截图：" + file);
}

/** 页面探针：读侧栏地区分组（分洲标题 / 展开态 / 组内胶囊） */
const readSidebar = () => {
  const section = document.querySelector("[data-region-section=true]");
  if (section === null) {
    return null;
  }
  const groups = Array.from(section.querySelectorAll("[data-continent-group]")).map((node) => {
    const toggle = node.querySelector("[data-continent-toggle]");
    const check = node.querySelector("input[data-continent-check]");
    const chips = [];
    const chipPressed = {};
    for (const button of Array.from(node.querySelectorAll("button[data-chip]"))) {
      const first = button.childNodes.length > 0 ? button.childNodes[0].nodeValue : null;
      const label = String(first === null ? button.textContent : first).trim();
      chips.push(label);
      chipPressed[label] = button.getAttribute("aria-pressed") === "true";
    }
    return {
      continent: node.getAttribute("data-continent-group"),
      expanded: toggle !== null && toggle.getAttribute("aria-expanded") === "true",
      header: node.textContent.replace(/\s+/g, " ").trim(),
      checked: check !== null && check.checked === true,
      chips: chips,
      chipPressed: chipPressed
    };
  });
  const all = section.querySelector("[data-continent-all]");
  return {
    groups: groups,
    allAction: all === null ? null : all.getAttribute("data-continent-all"),
    allText: all === null ? null : all.textContent.trim(),
    text: section.textContent
  };
};

/** 页面探针：读项目地区小窗（搜索框 / 分组小标题 / 候选行 / 选中态 / 已有项目数） */
const readRegionPopup = () => {
  const dialog = document.querySelector("[data-region-popover=true]");
  if (dialog === null) {
    return null;
  }
  const input = dialog.querySelector("input");
  let deleteButtons = 0;
  for (const button of Array.from(dialog.querySelectorAll("button"))) {
    if (String(button.getAttribute("aria-label") ?? "").indexOf("删除") === 0) {
      deleteButtons += 1;
    }
  }
  const list = dialog.querySelector("[role=listbox]");
  const activeTab = list === null ? null : list.getAttribute("data-region-tab");
  const tabs = Array.from(dialog.querySelectorAll("[role=tab]")).map((node) => ({
    key: node.getAttribute("data-region-tab"),
    selected: node.getAttribute("aria-selected") === "true"
  }));
  const rows = [];
  const groups = [];
  if (list !== null) {
    for (const wrapper of Array.from(list.children)) {
      const header = wrapper.querySelector("[data-option-group]");
      const group = header === null ? (activeTab === "used" ? "已有项目地区" : null) : header.getAttribute("data-option-group");
      if (group !== null && groups.indexOf(group) < 0) {
        groups.push(group);
      }
      const optionNodes = wrapper.getAttribute("role") === "option" ? [wrapper] : Array.from(wrapper.querySelectorAll("[role=option]"));
      for (const option of optionNodes) {
        const nameNode = option.querySelector("[data-region-name]");
        const countMatch = option.textContent.match(/(\d+) 个项目/);
        rows.push({
          group: group,
          name: nameNode === null ? option.textContent.trim() : nameNode.textContent.trim(),
          value: option.getAttribute("data-region-option"),
          selected: option.getAttribute("aria-selected") === "true",
          count: countMatch === null ? null : Number(countMatch[1]),
          text: option.textContent.trim()
        });
      }
    }
  }
  const selected = dialog.querySelector("[role=option][aria-selected=true]");
  const scroller = list === null ? null : list.parentElement;
  let selectedVisible = null;
  if (selected !== null && scroller !== null) {
    const rowBox = selected.getBoundingClientRect();
    const box = scroller.getBoundingClientRect();
    selectedVisible = rowBox.top >= box.top - 1 && rowBox.bottom <= box.bottom + 1;
  }
  const dialogBox = dialog.getBoundingClientRect();
  return {
    /** 小窗盒子（Push 195 追订：两个页签要同高同位 —— 页面里直接量，不靠眼睛看）。 */
    box: { top: Math.round(dialogBox.top), left: Math.round(dialogBox.left), width: Math.round(dialogBox.width), height: Math.round(dialogBox.height) },
    hasInput: input !== null,
    inputValue: input === null ? null : input.value,
    focused: input !== null && document.activeElement === input,
    activeTab: activeTab,
    tabs: tabs,
    rows: rows,
    groups: groups,
    selectedName: selected === null ? null : (selected.querySelector("[data-region-name]") ?? selected).textContent.trim(),
    selectedVisible: selectedVisible,
    /** 纯选择器护栏（Push 194 / 195）：无「添加地区」入口、无删除按钮、只有搜索框 1 个输入框。 */
    hasAddRow: dialog.textContent.indexOf("添加地区") >= 0,
    hasEmptyText: dialog.textContent.indexOf("没有匹配的国家 / 地区") >= 0,
    deleteButtons: deleteButtons,
    inputCount: dialog.querySelectorAll("input").length,
    text: dialog.textContent
  };
};
/** 点某个按钮（按文本精确匹配；rootSelector 缺省 = 整页） */
async function clickByText(rootSelector, text) {
  const point = await ev(
    "(() => { const root = document.querySelector(" + j(rootSelector) + ") ?? document.body;" +
    " const node = Array.from(root.querySelectorAll(" + j("button") + ")).find((item) => item.textContent.trim() === " + j(text) + ");" +
    " if (node === undefined) { return null; }" +
    " node.scrollIntoView({ block: " + j("nearest") + " });" +
    " const box = node.getBoundingClientRect();" +
    " return { x: box.left + box.width / 2, y: box.top + box.height / 2 }; })()"
  );
  if (point === null) {
    throw new Error("找不到按钮：" + text);
  }
  await clickAt(point);
}

/** 点侧栏某洲的展开箭头（展开 / 收起那一组） */
async function clickContinent(name) {
  await clickSelector("[data-continent-toggle=" + j(name) + "]");
  await sleep(400);
}

/** 点侧栏某洲行最右侧的整洲复选框（Push 193：勾上 = 选中该洲全部地区，再点 = 全部取消） */
async function clickContinentFilter(name) {
  await clickSelector("label:has(input[data-continent-check=" + j(name) + "])");
  await sleep(600);
}

/** 从 hash 里解析 filter[region] 的码列表（多值 = 英文逗号分隔，逐段 decodeURIComponent） */
function regionCodesInHash(hash) {
  const marker = "filter[region]=";
  const chunk = hash.split("&").find((piece) => piece.indexOf(marker) >= 0);
  if (chunk === undefined) {
    return [];
  }
  return chunk
    .slice(chunk.indexOf(marker) + marker.length)
    .split(",")
    .filter((piece) => piece !== "")
    .map((piece) => decodeURIComponent(piece));
}

/** 地区码 → 字典名（库内没有的码就当它本身是名字） */
const labelByCode = new Map(dictRegionRows.map((row) => [row.code, row.name]));
const labelOfCode = (code) => labelByCode.get(code) ?? code;
/** 地区名 → 码（侧栏胶囊显示字典名；码 = 筛选值） */
const codeByName = new Map(dictRegionRows.map((row) => [row.name, row.code]));
const codeOfLabel = (label) => codeByName.get(label) ?? label;

/** 点侧栏某枚地区胶囊（按地区名找，不看计数） */
async function clickChip(label) {
  const point = await ev(
    "(() => { const section = document.querySelector(" + j(SIDEBAR_SECTION) + ");" +
    " if (section === null) { return null; }" +
    " const node = Array.from(section.querySelectorAll(" + j("button[data-chip]") + ")).find((button) =>" +
    " String(button.firstChild === null ? " + j("") + " : button.firstChild.nodeValue).trim() === " + j(label) + ");" +
    " if (node === undefined) { return null; }" +
    " node.scrollIntoView({ block: " + j("nearest") + " });" +
    " const box = node.getBoundingClientRect();" +
    " return { x: box.left + box.width / 2, y: box.top + box.height / 2 }; })()"
  );
  if (point === null) {
    throw new Error("找不到地区胶囊：" + label);
  }
  await clickAt(point);
}

const totalByLabel = new Map();
for (const row of projectRows) {
  const label = regionLabel(row.region);
  totalByLabel.set(label, (totalByLabel.get(label) ?? 0) + Number(row.n));
}
/** 分组成块检查：同一个洲的候选必须连在一起（第二次出现 = 被别的洲打断了） */
const contiguityFailures = (rows) => {
  const seen = [];
  const bad = [];
  for (let index = 0; index < rows.length; index += 1) {
    const group = rows[index].group;
    if (index === 0 || rows[index - 1].group !== group) {
      if (seen.indexOf(group) >= 0) {
        bad.push(group);
      } else {
        seen.push(group);
      }
    }
  }
  return bad;
};

/** 打开小窗后点一下搜索框（真实鼠标）—— 保证后面 insertText 有落点 */
async function focusPopupSearch() {
  await clickSelector(REGION_POPUP_SEARCH);
  await sleep(300);
}

const chipsOf = (state) => (state === null ? [] : state.groups.flatMap((group) => group.chips));
const groupOf = (state, name) => (state === null ? undefined : state.groups.find((group) => group.continent === name));
const groupOfChip = (state, chip) => (state === null ? undefined : state.groups.find((group) => group.chips.indexOf(chip) >= 0));

// ── ① 侧栏「地区」：默认按洲分组、无选区时先全部收起 ──
await openList("#/projects");
await openSidebar();
let sidebar = await probe(readSidebar);
const groupNames = sidebar === null ? [] : sidebar.groups.map((group) => group.continent);
const allowed = CONTINENTS.concat([OTHER_GROUP]);
check("侧栏地区段按洲分组：分组 " + String(groupNames.length) + " 个（" + groupNames.join(" / ") + "）", groupNames.length >= 6 && groupNames.every((name) => allowed.indexOf(name) >= 0), JSON.stringify(groupNames));
check("分洲标题覆盖六大洲（亚洲在最前，字典首条「华东」在亚洲）", CONTINENTS.every((name) => groupNames.indexOf(name) >= 0) && groupNames[0] === "亚洲", JSON.stringify(groupNames));
check("默认收起：没勾选任何地区时每一组都是收起的（面板打开是干净几行）", sidebar !== null && sidebar.groups.every((group) => !group.expanded), JSON.stringify(sidebar === null ? null : sidebar.groups.map((group) => group.expanded)));
check("收起时组头报「N 个地区」、组内胶囊不渲染", sidebar !== null && sidebar.groups.every((group) => group.header.indexOf("个地区") >= 0 && group.chips.length === 0), JSON.stringify(sidebar === null ? null : sidebar.groups.map((group) => group.header)));
check("中国口径护栏：洲分组里不出现台湾 / 科索沃 / 北塞浦路斯 / 索马里兰", sidebar !== null && FORBIDDEN.every((name) => String(sidebar.text).indexOf(name) < 0), FORBIDDEN.filter((name) => sidebar !== null && String(sidebar.text).indexOf(name) >= 0).join(","));
await shot("01-sidebar-collapsed");

// ── ② 展开 / 收起：全部展开后能数全每一枚胶囊（与库内 facets 对账） ──
await clickSelector(CONTINENT_ALL_SELECTOR);
await sleep(600);
sidebar = await probe(readSidebar);
const chipList = chipsOf(sidebar).slice().sort();
const missingChips = facetLabels.filter((label) => chipList.indexOf(label) < 0);
const extraChips = chipList.filter((label) => facetLabels.indexOf(label) < 0);
check("「全部展开」：每一组都展开、胶囊一枚不多一枚不少（库内 " + String(facetLabels.length) + " 个在用地区）", sidebar !== null && sidebar.groups.every((group) => group.expanded) && missingChips.length === 0 && extraChips.length === 0, JSON.stringify({ missing: missingChips, extra: extraChips }));
check("组头的「N 个地区」= 组内胶囊数", sidebar !== null && sidebar.groups.every((group) => group.header.indexOf(String(group.chips.length) + " 个地区") >= 0), JSON.stringify(sidebar === null ? null : sidebar.groups.map((group) => group.header)));
const spotFailures = [];
for (const entry of CONTINENT_SPOT) {
  for (const name of entry[1]) {
    const host = groupOfChip(sidebar, name);
    if (host === undefined || host.continent !== entry[0]) {
      spotFailures.push(name + " 应在 " + entry[0] + "，实际 " + String(host === undefined ? "（没找到）" : host.continent));
    }
  }
}
check("洲归属抽查（中国口径，与地图同一套）：" + String(CONTINENT_SPOT.length) + " 洲 / " + String(CONTINENT_SPOT.reduce((sum, entry) => sum + entry[1].length, 0)) + " 个国家", spotFailures.length === 0, spotFailures.join("；"));
await shot("02-sidebar-expanded");
await clickSelector(CONTINENT_ALL_SELECTOR);
await sleep(600);
sidebar = await probe(readSidebar);
check("「全部收起」：全部收起、胶囊全部不渲染（组头仍报数）", sidebar !== null && sidebar.groups.every((group) => !group.expanded && group.chips.length === 0) && sidebar.allText === "全部展开", sidebar === null ? "null" : sidebar.allText);

// ── ③ 单组展开 + 点胶囊筛选（URL 与卡片计数同步） ──
await clickContinent("亚洲");
sidebar = await probe(readSidebar);
check("点「亚洲」展开箭头：只展开这一组，其余仍收起", sidebar !== null && groupOf(sidebar, "亚洲").expanded && sidebar.groups.filter((group) => group.expanded).length === 1, JSON.stringify(sidebar === null ? null : sidebar.groups.map((group) => group.continent + ":" + String(group.expanded))));
await clickChip("日本");
await sleep(1400);
sidebar = await probe(readSidebar);
const hashJapan = String(await ev("window.location.hash"));
const japanTotal = totalByLabel.get("日本") ?? 0;
const bodyText = String(await ev("document.body.textContent"));
check("点胶囊「日本」：按地区筛选（URL 写 filter[region]=日本）", decodeURIComponent(hashJapan).indexOf("filter[region]=日本") >= 0, hashJapan);
check("筛选后工具条计数 = 库里「日本」的项目数（" + String(japanTotal) + " 个）", bodyText.indexOf("找到 " + String(japanTotal) + " 个项目") >= 0, "没找到计数文案");
check("勾选后组头出「已选 1」（收起也能看见勾了哪一洲）", sidebar !== null && groupOf(sidebar, "亚洲") !== undefined && groupOf(sidebar, "亚洲").header.indexOf("已选 1") >= 0, JSON.stringify(sidebar === null ? null : sidebar.groups.map((group) => group.header)));
await shot("03-sidebar-filtered");

// ── ④ 带选区进页面：有勾选的洲默认展开、其余收起 ──
await openList("#/projects?filter[region]=" + encodeURIComponent("中国"));
await openSidebar();
sidebar = await probe(readSidebar);
check("带勾选进页面：有勾选的洲默认展开（亚洲），其余洲收起", sidebar !== null && groupOf(sidebar, "亚洲").expanded && sidebar.groups.filter((group) => group.expanded).length === 1, JSON.stringify(sidebar === null ? null : sidebar.groups.map((group) => group.continent + ":" + String(group.expanded))));
check("默认展开的洲里能看到勾中的那枚胶囊（中国）", sidebar !== null && groupOf(sidebar, "亚洲").chips.indexOf("中国") >= 0, JSON.stringify(sidebar === null ? null : groupOf(sidebar, "亚洲").chips));

// ── ④b 整洲筛选（Push 193）：点洲名 = 选中该洲全部地区（并展开），再点一次取消 ──
await clickByText("#category-filter-panel", "重置");
await sleep(800);
await clickContinentFilter("欧洲");
await sleep(1600);
sidebar = await probe(readSidebar);
const hashEurope = String(await ev("window.location.hash"));
const europeGroup = groupOf(sidebar, "欧洲");
const europeLabels = europeGroup === undefined ? [] : europeGroup.chips;
const europeCodes = europeLabels.map(codeOfLabel);
const codesInUrl = regionCodesInHash(hashEurope);
const europeTotal = europeLabels.reduce((sum, label) => sum + (totalByLabel.get(label) ?? 0), 0);
const europeAllPressed =
  europeGroup !== undefined && europeGroup.chips.length > 0 && europeGroup.chips.every((label) => europeGroup.chipPressed[label] === true);
check(
  "勾上「欧洲」右侧复选框 = 整洲筛选：复选框已勾、组自动展开、URL 写齐欧洲全部 " + String(europeCodes.length) + " 个地区",
  europeGroup !== undefined && europeGroup.checked === true && europeGroup.expanded && europeCodes.length > 1 && codesInUrl.length === europeCodes.length && europeCodes.every((code) => codesInUrl.indexOf(code) >= 0),
  JSON.stringify({ checked: europeGroup === undefined ? null : europeGroup.checked, url: codesInUrl.length, expected: europeCodes.length, missing: europeCodes.filter((code) => codesInUrl.indexOf(code) < 0) })
);
check(
  "整洲筛选后：组头「已选 " + String(europeLabels.length) + "」、洲内胶囊全部选中（aria-pressed）",
  europeGroup !== undefined && europeGroup.header.indexOf("已选 " + String(europeLabels.length)) >= 0 && europeAllPressed,
  JSON.stringify({ header: europeGroup === undefined ? null : europeGroup.header, pressed: europeGroup === undefined ? null : europeGroup.chipPressed })
);
const bodyTextEurope = String(await ev("document.body.textContent"));
check(
  "整洲筛选的工具条计数 = 库里欧洲这些地区的项目数（" + String(europeTotal) + " 个）",
  bodyTextEurope.indexOf("找到 " + String(europeTotal) + " 个项目") >= 0,
  "没找到计数文案"
);
const foreignCodes = codesInUrl.filter((code) => {
  const host = groupOfChip(sidebar, labelOfCode(code));
  return host === undefined || host.continent !== "欧洲";
});
check(
  "URL 里的地区全部属于欧洲（与侧栏分组对账，码 " + String(codesInUrl.length) + " 个）",
  foreignCodes.length === 0,
  JSON.stringify(foreignCodes)
);
await shot("06-sidebar-continent-filter");
await clickContinentFilter("欧洲");
await sleep(1600);
sidebar = await probe(readSidebar);
const europeGroupOff = groupOf(sidebar, "欧洲");
const hashAfterOff = String(await ev("window.location.hash"));
const bodyTextAfterOff = String(await ev("document.body.textContent"));
check(
  "再点一次复选框：取消整洲（复选框复位、URL 不再写 filter[region]、计数回到全量 " + String(projectTotal) + "）",
  europeGroupOff !== undefined && europeGroupOff.checked === false && regionCodesInHash(hashAfterOff).length === 0 && bodyTextAfterOff.indexOf("共 " + String(projectTotal) + " 个项目") >= 0,
  JSON.stringify({ checked: europeGroupOff === undefined ? null : europeGroupOff.checked, hash: hashAfterOff })
);

// ── ⑤ 新建项目弹窗：项目地区 = 贴字段弹出的小窗（Push 195）——分页「已有项目地区 / 全部地区」 ──
const DIALOG = "[role=dialog]";
/** 标准国家清单（worldMap.ts 生成物）：201 条中文名唯一 —— 「全部地区」页的「全覆盖」基准。 */
const worldMapText = readFileSync(new URL("../src/data/worldMap.ts", import.meta.url), "utf8");
const standardNames = Array.from(new Set(Array.from(worldMapText.matchAll(/nameZh: "([^"]+)"/g)).map((match) => match[1])));
/** 期望候选数 = 标准清单 + 字典里不是标准国名的条目（旧「华东」类；当前库为 0）。 */
const dictOnlyRows = dictRegionRows.filter((row) => standardNames.indexOf(row.name) < 0);
const expectedPopupRows = standardNames.length + dictOnlyRows.length;
/** 「已有项目地区」期望 = 有项目在用的地区（值 = 项目落库原文 → 未删除项目数；Push 304 起按落库值聚合，字典外国名也照数）。 */
const usedCountByValue = new Map(projectRows.map((row) => [row.region, Number(row.n)]));
const usedValues = Array.from(usedCountByValue.keys());

const projectsAllBefore = Number((await db.query("select count(*)::int as n from projects")).rows[0].n);
await clickByText("body", "新建项目");
await waitFor("document.querySelector(" + j(PROJECT_DIALOG) + ")!==null");
await waitFor("document.querySelector(" + j(REGION_TRIGGER) + ")!==null");
const triggerTagOfRegion = String(await ev("document.querySelector(" + j(REGION_TRIGGER) + ").tagName"));
check("项目地区触发器是 button（不是输入框：不支持手填）", triggerTagOfRegion === "BUTTON", triggerTagOfRegion);
const triggerAtOpen = String(await ev("document.querySelector(" + j(REGION_TRIGGER) + ").textContent"));
await clickSelector(REGION_TRIGGER);
await sleep(600);
let popup = await probe(readRegionPopup);
check("点触发器：弹出「之前的小窗」（贴字段右侧），顶部搜索框在且打开即聚焦",
  popup !== null && popup.hasInput && popup.focused,
  JSON.stringify(popup === null ? null : { hasInput: popup.hasInput, focused: popup.focused }));
check("小窗 = 纯选择器（Push 194 口径延续）：无删除按钮、只有搜索框 1 个输入框（不能手填）、无「添加地区」入口",
  popup !== null && popup.deleteButtons === 0 && popup.inputCount === 1 && popup.hasAddRow === false,
  JSON.stringify(popup === null ? null : { deleteButtons: popup.deleteButtons, inputs: popup.inputCount, hasAddRow: popup.hasAddRow }));
check("小窗分页 = 「已有项目地区 / 全部地区」两页签，默认停在已有项目地区页",
  popup !== null && popup.tabs.length === 2 && popup.tabs[0].key === "used" && popup.tabs[1].key === "all" && popup.activeTab === "used" && popup.tabs[0].selected === true && popup.tabs[1].selected === false,
  JSON.stringify(popup === null ? null : { tabs: popup.tabs, active: popup.activeTab }));
const usedRows = popup === null ? [] : popup.rows;
const usedRowByValue = new Map(usedRows.map((row) => [row.value, row]));
const usedMismatch = [];
for (const value of usedValues) {
  const row = usedRowByValue.get(value);
  if (row === undefined || row.count !== usedCountByValue.get(value)) {
    usedMismatch.push(value + " 期望 " + String(usedCountByValue.get(value)) + "，实际 " + String(row === undefined ? "（没找到）" : row.count));
  }
}
let usedDescending = true;
for (let index = 1; index < usedRows.length; index += 1) {
  if (usedRows[index].count > usedRows[index - 1].count) {
    usedDescending = false;
  }
}
check("已有项目地区页：" + String(usedValues.length) + " 条有项目在用的地区（落库值口径）、每行带项目数、按用量降序、与库内逐条对账",
  popup !== null && popup.activeTab === "used" && usedRows.length === usedValues.length && usedRows.every((row) => row.count !== null && row.group === "已有项目地区") && usedDescending && usedMismatch.length === 0,
  JSON.stringify({ rows: usedRows.length, expected: usedValues.length, descending: usedDescending, mismatch: usedMismatch.slice(0, 6) }));
const createButtonDisabled = String(await ev("(() => { const button = Array.from(document.querySelectorAll(" + j(PROJECT_DIALOG + " button") + ")).find((item) => item.textContent.trim() === " + j("创建项目") + "); return button === undefined ? " + j("missing") + " : button.disabled; })()"));
check("新建项目默认不带地区（业务口径「不要默认英国 默认为空即可」）：触发器 = 占位「请选择地区」、小窗里没有选中项、创建按钮禁用",
  popup !== null && triggerAtOpen === "请选择地区" && popup.selectedName === null && createButtonDisabled === "true",
  JSON.stringify({ trigger: triggerAtOpen, selected: popup === null ? null : popup.selectedName, disabled: createButtonDisabled }));
await shot("07-modal-region-popover");
const usedTabBox = popup === null ? null : popup.box;

// 切到「全部地区」页：全量候选 + 分洲分组
await clickSelector("[data-region-tab=all]");
await sleep(400);
popup = await probe(readRegionPopup);
check("两个分页的小窗同高同位（追订「两个分页的高度位置要一致」）：已有页 / 全部页的盒子四边一致、切页不跳",
  usedTabBox !== null && popup !== null && popup.box !== null && popup.box.height === usedTabBox.height && popup.box.top === usedTabBox.top && popup.box.left === usedTabBox.left && popup.box.width === usedTabBox.width,
  JSON.stringify({ used: usedTabBox, all: popup === null ? null : popup.box }));
check("点「全部地区」页签：候选 = 标准国家清单 " + String(standardNames.length) + " 条 + 字典独有条目 " + String(dictOnlyRows.length) + " 条，值不重复",
  popup !== null && popup.activeTab === "all" && popup.rows.length === expectedPopupRows && new Set(popup.rows.map((row) => row.value)).size === expectedPopupRows,
  JSON.stringify(popup === null ? null : { active: popup.activeTab, rows: popup.rows.length, expected: expectedPopupRows }));
const popupGroups = popup === null ? [] : popup.groups;
const expectedPopupGroupOrder = allowed.filter((name) => popupGroups.indexOf(name) >= 0);
check("全部地区页按洲分组：小标题 " + String(popupGroups.length) + " 个（" + popupGroups.join(" / ") + "），按洲序排列、每条候选都归到某一洲、同洲成块不交叉",
  popup !== null && popupGroups.length >= 6 && popupGroups.every((name, index) => name === expectedPopupGroupOrder[index]) && contiguityFailures(popup.rows).length === 0 && popup.rows.every((row) => row.group !== null),
  JSON.stringify(popup === null ? null : { groups: popupGroups, expected: expectedPopupGroupOrder, bad: contiguityFailures(popup.rows), ungrouped: popup.rows.filter((row) => row.group === null).length }));
const popupValues = new Set(popup === null ? [] : popup.rows.map((row) => row.value));
const popupNames = new Set(popup === null ? [] : popup.rows.map((row) => row.name));
const missingStandard = standardNames.filter((name) => popupValues.has(name) === false && popupNames.has(name) === false);
check("标准国家清单全覆盖（" + String(standardNames.length) + " 条，值或名命中即可 —— 阿联酋这类字典条目占位）：缺 " + String(missingStandard.length) + " 条",
  popup !== null && missingStandard.length === 0, JSON.stringify(missingStandard.slice(0, 8)));
const missingDict = dictRegionRows.filter((row) => popupNames.has(row.name) === false && popupValues.has(row.code) === false);
check("地区字典启用条目全覆盖（" + String(dictRegionCount) + " 条：命中国家的条目优先占位，值 = 字典码）",
  popup !== null && missingDict.length === 0, JSON.stringify(missingDict.map((row) => row.code)));
const popupSpotFailures = [];
for (const entry of PICKER_SPOT) {
  const row = popup === null ? undefined : popup.rows.find((item) => item.name === entry[1]);
  if (row === undefined || row.group !== entry[0]) {
    popupSpotFailures.push(entry[1] + " 应在 " + entry[0] + "，实际 " + String(row === undefined ? "（没找到）" : row.group));
  }
}
check("候选洲归属抽查（" + String(PICKER_SPOT.length) + " 条）：" + PICKER_SPOT.map((entry) => entry[1] + "→" + entry[0]).join("、"),
  popup !== null && popupSpotFailures.length === 0, popupSpotFailures.join("；"));
check("中国口径护栏：候选里不出现台湾 / 科索沃 / 北塞浦路斯 / 索马里兰、也没有香港 / 澳门",
  popup !== null && FORBIDDEN.concat(["香港", "澳门"]).every((name) => String(popup.text).indexOf(name) < 0),
  FORBIDDEN.concat(["香港", "澳门"]).filter((name) => popup !== null && String(popup.text).indexOf(name) >= 0).join(","));
await shot("08-modal-region-all");

// 搜「冰岛」= 用户原话场景（字典里没有的国家，照样搜得到、选得上）；输入即自动切到全部地区页
await focusPopupSearch();
await typeText(SEARCH_ZH);
popup = await probe(readRegionPopup);
check("搜中文「" + SEARCH_ZH + "」：自动切到全部地区页、候选收敛到 1 条 = 冰岛（欧洲）—— 字典外的国家也能搜到",
  popup !== null && popup.activeTab === "all" && popup.rows.length === 1 && popup.rows[0].name === "冰岛" && popup.rows[0].group === "欧洲",
  JSON.stringify(popup === null ? null : { active: popup.activeTab, rows: popup.rows }));
await shot("09-region-popup-search");
await clickSelector(REGION_POPUP_OPTION);
await sleep(600);
popup = await probe(readRegionPopup);
const triggerAfterIceland = String(await ev("document.querySelector(" + j(REGION_TRIGGER) + ").textContent"));
check("点选冰岛：小窗关掉、项目地区触发器显示「冰岛」（选中即回填，不写字典）",
  popup === null && triggerAfterIceland === "冰岛", JSON.stringify({ popup: popup === null, trigger: triggerAfterIceland }));
await clickSelector(REGION_TRIGGER);
await sleep(600);
popup = await probe(readRegionPopup);
check("重开小窗：当前值不在已有页（冰岛没有项目），默认停在全部地区页；关键词复位、候选回到全量 " + String(expectedPopupRows) + " 条、选中项 = 冰岛且滚进可视区",
  popup !== null && popup.activeTab === "all" && popup.inputValue === "" && popup.rows.length === expectedPopupRows && popup.selectedName === "冰岛" && popup.selectedVisible === true,
  JSON.stringify(popup === null ? null : { active: popup.activeTab, value: popup.inputValue, rows: popup.rows.length, selected: popup.selectedName, visible: popup.selectedVisible }));
await focusPopupSearch();
await typeText(SEARCH_EN);
popup = await probe(readRegionPopup);
check("搜英文「" + SEARCH_EN + "」：候选收敛到 1 条 = 冰岛 —— 英文国名也能搜",
  popup !== null && popup.rows.length === 1 && popup.rows[0].name === "冰岛", JSON.stringify(popup === null ? null : popup.rows));
await clearSearch();
await focusPopupSearch();
await typeText(SEARCH_MISS);
popup = await probe(readRegionPopup);
check("搜不到时：候选 0 条 + 提示行「没有匹配的国家 / 地区。」",
  popup !== null && popup.rows.length === 0 && popup.hasEmptyText, JSON.stringify(popup === null ? null : { rows: popup.rows.length, empty: popup.hasEmptyText }));
await clearSearch();
await focusPopupSearch();
await typeText(SEARCH_ALT_EN);
await pressEnter();
await sleep(600);
popup = await probe(readRegionPopup);
const triggerAfterEnter = String(await ev("document.querySelector(" + j(REGION_TRIGGER) + ").textContent"));
check("搜索框回车 = 选当前页第一条（Brazil → 巴西）：小窗关掉、触发器显示巴西",
  popup === null && triggerAfterEnter === "巴西", JSON.stringify({ popup: popup === null, trigger: triggerAfterEnter }));
// 当前值 = 巴西（有项目在用）：重开默认停在已有项目地区页、滚到选中项；Esc 先关小窗（Push 195 两层分派）
await clickSelector(REGION_TRIGGER);
await sleep(600);
popup = await probe(readRegionPopup);
check("重开小窗（当前值 = 巴西，已在已有项目地区）：默认停在已有页、选中项 = 巴西且滚进可视区",
  popup !== null && popup.activeTab === "used" && popup.selectedName === "巴西" && popup.selectedVisible === true,
  JSON.stringify(popup === null ? null : { active: popup.activeTab, selected: popup.selectedName, visible: popup.selectedVisible }));
await pressKey("Escape", "Escape", 27);
await sleep(500);
const popupAfterEsc = (await ev("document.querySelector(" + j(REGION_POPUP) + ")===null")) === true;
const projectAfterEsc = (await ev("document.querySelector(" + j(PROJECT_DIALOG) + ")===null")) === false;
check("Esc：先关掉小窗、项目弹窗保持打开（再按一次才关外层）", popupAfterEsc && projectAfterEsc, JSON.stringify({ popupClosed: popupAfterEsc, projectOpen: projectAfterEsc }));
await clickSelector(REGION_TRIGGER);
await sleep(600);
await clickSelector(REGION_TRIGGER);
await sleep(400);
const popupAfterToggle = (await ev("document.querySelector(" + j(REGION_POPUP) + ")===null")) === true;
check("再点触发器：小窗收起（开 / 合同一个按钮）", popupAfterToggle, String(popupAfterToggle));

// —— ⑤b 地区字典只读（Push 194 / 195：小窗不承载「添加 / 删除」，不写库） ——
const dictAfter = Number((await db.query("select count(*)::int as n from dict_items where type_code = $1 and enabled", ["region"])).rows[0].n);
check("地区字典只读：回放前后 enabled 条数不变（" + String(dictRegionCount) + " 条，小窗不写字典）", dictAfter === dictRegionCount, JSON.stringify({ before: dictRegionCount, after: dictAfter }));
await clickByText(DIALOG, "取消");
await sleep(700);
const dialogClosed = (await ev("document.querySelector(" + j(PROJECT_DIALOG) + ")===null")) === true;
const projectsAllAfter = Number((await db.query("select count(*)::int as n from projects")).rows[0].n);
check("关掉弹窗：库里项目数不变（回放只读，不建项目 / 不改字典，" + String(projectsAllBefore) + " 行）", dialogClosed && projectsAllAfter === projectsAllBefore, JSON.stringify({ dialogClosed, projectsAllBefore, projectsAllAfter }));

// ── ⑥ 收尾：控制台零报错 + 会话零残留 ──
check("控制台零报错（error / warning 都没有）", consoleErrors.length === 0, consoleErrors.slice(0, 5).join(" | "));
await db.query("update sessions set revoked_at = now() where token_hash = $1", [sha256(token)]);
const residue = (await db.query("select count(*)::int as n from sessions where token_hash = $1 and revoked_at is null", [sha256(token)])).rows[0];
check("清理：临时会话已撤销、零残留", Number(residue.n) === 0, JSON.stringify(residue));

const failed = checks.filter((item) => item.ok !== true);
console.log("");
console.log("=== 汇总：" + String(checks.length) + " 项，通过 " + String(checks.length - failed.length) + "，失败 " + String(failed.length) + " ===");
for (const item of failed) {
  console.log("  FAIL  " + item.name + "  —— " + String(item.detail));
}
console.log("截图目录：" + SHOTS);
await db.end();
chrome.kill();
process.exit(failed.length === 0 ? 0 : 1);
