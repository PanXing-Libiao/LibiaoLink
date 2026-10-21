import type { Locale } from "./i18n";

/**
 * 「我的计划」便签墙（工作台第三枚标签 · 业务口径 2026-10-10「照 minimemo3 的便签页融入系统」）：
 * 个人便签墙 —— 新建 / 编辑 / 删除 / 完成便签（完成后只出现在「已完成」视图，便签墙与分类视图不再显示），支持颜色、字体、分类（可自定义）、搜索；页面形态与配色照 MiniMemo 参考页照搬（Push 268 起页面底改纯白、排序下架 / 198 高圆角卡片 / 7 色 hex 调色板；Push 271 起工具条可切背景色 —— white 统一白（默认，与全站页面一致）/ cream 奶白（#fdfbf7 + 左上暖色径向渐变），随账号落库），编辑（填写）弹窗亦照搬（便签底色整卡铺底 + 顶栏关闭 / 7 色圆点 / 字体 Aa 分段器 + 大标题 / 记录区 + 分类胶囊 + 「更新于」底栏 + 「完成 / 恢复」；业务口径 2026-10-10「填写也要一样」→「数据接入数据库」+「新增完成按钮 完成后只显示在已完成里面」），不做导出 / 导入。
 *
 * 存储（Push 268 起 · 账号落库）：整面便签墙按账号存服务端偏好（user_preferences.prefs.myPlanBoard，GET / PATCH /api/v1/users/me/preferences，见 preferencesApi.ts）—— 换设备用同一账号登录都能看到；
 * 本机 localStorage 只保留旧键 libiaolink.plan.board.v1 作一次性迁移来源：账号里从未保存过（updatedAt null）或旧键有便签而账号为空时，首次打开本页把本机数据推上云再清旧键；
 * 退出登录清掉未迁移的旧键（AppHeader，多人共用设备不把上一位的便签带给下一位）；迁移失败保留旧键、下次打开自动重试（原样展示本机数据，不阻塞页面）。
 *
 * 口径：
 * - 首次打开（账号里从未保存过）预置 6 条示例便签并上云（可删）—— 与参考页 minimemo3 的初始数据同一做法，便签墙一进来不是空的；
 * - 单条：标题（≤ 40 字）/ 内容（≤ 2000 字）/ 分类（默认六类，可加至 12 类、每类名 ≤ 10 字）/ 颜色（7 色）/ 字体（简约 / 优雅 / 等宽）/ 完成态（done；完成后只出现在「已完成」视图）；
 * - 便签数上限 300 条（超出时「新建便签」出提示，不静默丢）；
 * - 读取时逐条收敛（不合法整条丢弃），不抛错、不半读半写；服务端读侧同口径收敛（server user-preference.service.ts）；
 * - 导出 / 导入不做（业务口径 2026-10-10「导出导入功能不要」）；保存失败保留界面改动并出提示（可重试）。
 */

export type PlanColorId = "white" | "yellow" | "green" | "blue" | "purple" | "pink" | "orange";

export type PlanFontId = "sans" | "serif" | "mono";

/** 便签墙背景色（Push 271）：white = 与全站页面统一纯白（默认）；cream = 奶白（参考页默认底色）；
 *  其余 9 色 = 参考组件色板（粉 / 橙 / 黄 / 青柠 / 翠绿 / 天蓝 / 蓝 / 紫 / 薰衣草，实色铺底；玫红 2026-10-10 按口径「把玫红颜色删除掉」下架）。 */
export type PlanBoardBgId = "white" | "cream" | "pink" | "orange" | "yellow" | "lime" | "emerald" | "sky" | "blue" | "violet" | "lavender";

export type PlanNote = {
  id: string;
  title: string;
  content: string;
  category: string;
  colorId: PlanColorId;
  fontId: PlanFontId;
  /** 完成态（Push 268）：true = 收进「已完成」，便签墙（含分类视图）不再显示。 */
  done: boolean;
  /** ISO 8601（UTC，展示按本机时区）；排序与展示同一来源。 */
  createdAt: string;
  updatedAt: string;
};

export type PlanBoard = {
  notes: PlanNote[];
  categories: string[];
  /** 背景色（Push 271 · 业务口径「默认是和别的页面统一颜色 第二个颜色是minimemo的默认颜色」）：随账号落库、换设备可见。 */
  bg: PlanBoardBgId;
};

/** 本机旧键（Push 268 起只作一次性迁移来源：账号里没有便签墙时把本机数据推上云再清键）。 */
export const PLAN_STORAGE_KEY = "libiaolink.plan.board.v1";

export const PLAN_TITLE_MAX = 40;
export const PLAN_CONTENT_MAX = 2000;
export const PLAN_NOTE_LIMIT = 300;
export const PLAN_CATEGORY_MAX = 12;
export const PLAN_CATEGORY_NAME_MAX = 10;

export type PlanColor = {
  id: PlanColorId;
  label: string;
  /** 卡片底色（便签墙 / 编辑弹窗同一档；Push 266 起照 MiniMemo 参考页的 hex 调色板）。 */
  bg: string;
  /** 卡片描边。 */
  border: string;
  /** 卡片文字色（标题 / 正文 / 底行继承）。 */
  ink: string;
  /** 分类签底色（编辑弹窗的取色圆点同用）。 */
  swatch: string;
};

export const PLAN_COLORS: readonly PlanColor[] = [
  { id: "white", label: "白色", bg: "#ffffff", border: "#e7e5e4", ink: "#292524", swatch: "#f1f0ee" },
  { id: "yellow", label: "黄色", bg: "#fef8d5", border: "#f2e3a4", ink: "#713f12", swatch: "#fde68a" },
  { id: "green", label: "绿色", bg: "#e4f6e6", border: "#c6e8ca", ink: "#14532d", swatch: "#b9f0bf" },
  { id: "blue", label: "蓝色", bg: "#e3eefe", border: "#c5daf7", ink: "#1e3a8a", swatch: "#bcd8fb" },
  { id: "purple", label: "紫色", bg: "#eceafd", border: "#d6d1f6", ink: "#4c1d95", swatch: "#d8cffd" },
  { id: "pink", label: "粉色", bg: "#fce8f1", border: "#f5cddf", ink: "#831843", swatch: "#fbc9e2" },
  { id: "orange", label: "橙色", bg: "#feeddb", border: "#f7d6ae", ink: "#7c2d12", swatch: "#fdd0a0" },
];

export type PlanFont = { id: PlanFontId; label: string; hint: string; className: string };

export const PLAN_FONTS: readonly PlanFont[] = [
  { id: "sans", label: "简约", hint: "默认无衬线", className: "font-sans" },
  { id: "serif", label: "优雅", hint: "衬线体", className: "font-serif" },
  { id: "mono", label: "等宽", hint: "等宽体", className: "font-mono" },
];

/** 默认分类（首次打开预置；可再加，不删除 —— 便签引用的分类永远在）。 */
export const PLAN_DEFAULT_CATEGORIES: readonly string[] = ["待办", "工作", "想法", "采购", "个人", "其他"];

export function planColorOf(id: string): PlanColor {
  return PLAN_COLORS.find((item) => item.id === id) ?? PLAN_COLORS[0];
}

export function planFontOf(id: string): PlanFont {
  return PLAN_FONTS.find((item) => item.id === id) ?? PLAN_FONTS[0];
}

export type PlanBoardBackground = {
  id: PlanBoardBgId;
  label: string;
  hint: string;
  /** 工具条色块的色面（奶白 = 画布渐变的缩微版）。 */
  swatch: string;
  /** 画布（便签墙 section）背景：统一白 = 纯白；奶白 = MiniMemo 参考页原样（Push 266 口径：#fdfbf7 + 左上暖色径向渐变）。 */
  canvas: string;
};

export const PLAN_BOARD_BGS: readonly PlanBoardBackground[] = [
  { id: "white", label: "统一白", hint: "与其它页面一致（默认）", swatch: "#ffffff", canvas: "#ffffff" },
  { id: "cream", label: "奶白", hint: "参考页默认底色", swatch: "radial-gradient(46px 30px at 28% 0%, #f6eddc 0%, #fdfbf7 76%)", canvas: "radial-gradient(1200px 480px at 12% -8%, #f6eddc 0%, rgba(246, 237, 220, 0) 62%), #fdfbf7" },
  { id: "pink", label: "粉", hint: "#f472b6", swatch: "#f472b6", canvas: "#f472b6" },
  { id: "orange", label: "橙", hint: "#fb923c", swatch: "#fb923c", canvas: "#fb923c" },
  { id: "yellow", label: "黄", hint: "#facc15", swatch: "#facc15", canvas: "#facc15" },
  { id: "lime", label: "青柠", hint: "#84cc16", swatch: "#84cc16", canvas: "#84cc16" },
  { id: "emerald", label: "翠绿", hint: "#10b981", swatch: "#10b981", canvas: "#10b981" },
  { id: "sky", label: "天蓝", hint: "#0ea5e9", swatch: "#0ea5e9", canvas: "#0ea5e9" },
  { id: "blue", label: "蓝", hint: "#3b82f6", swatch: "#3b82f6", canvas: "#3b82f6" },
  { id: "violet", label: "紫", hint: "#8b5cf6", swatch: "#8b5cf6", canvas: "#8b5cf6" },
  { id: "lavender", label: "薰衣草", hint: "#a78bfa", swatch: "#a78bfa", canvas: "#a78bfa" },
];

export function planBoardBgOf(id: string): PlanBoardBackground {
  return PLAN_BOARD_BGS.find((item) => item.id === id) ?? PLAN_BOARD_BGS[0];
}

function isPlanColorId(value: string): value is PlanColorId {
  return PLAN_COLORS.some((item) => item.id === value);
}

function isPlanFontId(value: string): value is PlanFontId {
  return PLAN_FONTS.some((item) => item.id === value);
}

export function newPlanNoteId(): string {
  return "pn-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
}

/** 标题：去首尾空白 + 截断（超长截断而不是拒绝）。 */
export function normalizePlanTitle(raw: string): string {
  return raw.trim().slice(0, PLAN_TITLE_MAX);
}

/** 内容：去尾部空白 + 截断；中间换行保留（便签按行写、按行显示）。 */
export function normalizePlanContent(raw: string): string {
  return raw.replace(/\s+$/, "").slice(0, PLAN_CONTENT_MAX);
}

/** 分类名：去首尾空白 + 截断 + 全角空格兼容。 */
export function normalizePlanCategoryName(raw: string): string {
  return raw.replace(/^[\s\u3000]+|[\s\u3000]+$/g, "").slice(0, PLAN_CATEGORY_NAME_MAX);
}

function isIsoTime(value: unknown): value is string {
  return typeof value === "string" && value !== "" && !Number.isNaN(Date.parse(value));
}

/** 单条：字段缺失 / 类型不符即整条丢弃（不半读半写）。 */
function sanitizeNote(value: unknown): PlanNote | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const id = typeof record.id === "string" && record.id !== "" ? record.id : null;
  const title = typeof record.title === "string" ? normalizePlanTitle(record.title) : null;
  const content = typeof record.content === "string" ? normalizePlanContent(record.content) : null;
  const category = typeof record.category === "string" ? normalizePlanCategoryName(record.category) : null;
  const createdAt = isIsoTime(record.createdAt) ? record.createdAt : null;
  const updatedAt = isIsoTime(record.updatedAt) ? record.updatedAt : null;
  if (id === null || title === null || content === null || category === null || category === "" || createdAt === null || updatedAt === null) {
    return null;
  }
  if (title === "" && content === "") {
    return null;
  }
  const colorId = typeof record.colorId === "string" && isPlanColorId(record.colorId) ? record.colorId : "white";
  const fontId = typeof record.fontId === "string" && isPlanFontId(record.fontId) ? record.fontId : "sans";
  return { id, title, content, category, colorId, fontId, done: record.done === true, createdAt, updatedAt };
}

/** 分类表：去重、去空、去超长，最多 12 类；空表回落默认六类。 */
function sanitizeCategories(value: unknown): string[] {
  const result: string[] = [];
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item !== "string") {
        continue;
      }
      const name = normalizePlanCategoryName(item);
      if (name !== "" && !result.includes(name)) {
        result.push(name);
      }
      if (result.length >= PLAN_CATEGORY_MAX) {
        break;
      }
    }
  }
  return result.length > 0 ? result : PLAN_DEFAULT_CATEGORIES.slice();
}

/** 首次打开预置的 6 条示例便签（对应参考页 minimemo3 的初始数据；可删）。 */
function seedNotes(now: Date): PlanNote[] {
  const at = (hoursAgo: number): string => new Date(now.getTime() - hoursAgo * 3600000).toISOString();
  return [
    { id: "pn-seed-1", title: "本周重点", content: "1: 跟进印度项目的任务排期\n2: 整理周五评审要用的材料\n3: 给新同事开通账号", category: "待办", colorId: "yellow", fontId: "sans", done: false, createdAt: at(6), updatedAt: at(1) },
    { id: "pn-seed-2", title: "想法速记", content: "把「我的计划」做成便签墙：颜色分类 + 搜索。\n做完的便签点开按「完成」，自动收进「已完成」。", category: "想法", colorId: "blue", fontId: "sans", done: false, createdAt: at(26), updatedAt: at(3) },
    { id: "pn-seed-3", title: "会议要点", content: "周一例会：\n- 验收节点提前到月底\n- 甘特图按负责人筛选\n- 日报必填项已上线", category: "工作", colorId: "white", fontId: "sans", done: false, createdAt: at(50), updatedAt: at(22) },
    { id: "pn-seed-4", title: "采购清单", content: "- A4 打印纸\n- 标签机色带\n- 白板笔（黑 / 红）", category: "采购", colorId: "green", fontId: "mono", done: false, createdAt: at(74), updatedAt: at(30) },
    { id: "pn-seed-5", title: "读书清单", content: "《人月神话》\n《凤凰项目》\n《持续交付》", category: "个人", colorId: "pink", fontId: "serif", done: false, createdAt: at(98), updatedAt: at(50) },
    { id: "pn-seed-6", title: "随手记", content: "便签跟着账号走：换台设备用同一账号登录也能看到；重要内容自己留个底。", category: "其他", colorId: "purple", fontId: "sans", done: false, createdAt: at(122), updatedAt: at(74) },
  ];
}

/** 首次打开（账号里从未保存过）预置的整面便签墙：6 条示例 + 默认六类（与参考页 minimemo3 的初始数据同一做法）。 */
export function seedPlanBoard(): PlanBoard {
  return { notes: seedNotes(new Date()), categories: PLAN_DEFAULT_CATEGORIES.slice(), bg: "white" };
}

/** 读取本机旧键（迁移来源）：无记录 / 损坏 = null（键保留，不覆盖原始值）；有记录 = 逐条收敛后的整面便签墙。 */
export function readLegacyPlanBoard(): PlanBoard | null {
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(PLAN_STORAGE_KEY);
  } catch {
    return null;
  }
  if (raw === null) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) {
      throw new Error("bad shape");
    }
    const record = parsed as Record<string, unknown>;
    const notes: PlanNote[] = [];
    if (Array.isArray(record.notes)) {
      for (const item of record.notes) {
        const note = sanitizeNote(item);
        if (note !== null && !notes.some((existing) => existing.id === note.id)) {
          notes.push(note);
        }
        if (notes.length >= PLAN_NOTE_LIMIT) {
          break;
        }
      }
    }
    // 旧键（Push ≤ 267）没有背景色字段：一律按默认「统一白」迁移（新字段口径见 Push 271）。
    return { notes, categories: sanitizeCategories(record.categories), bg: "white" };
  } catch {
    return null;
  }
}

/** 退出登录清掉未迁移的本机旧键（与首页偏好同一条隔离口径：多人共用设备不把上一位的便签带给下一位）。 */
export function clearLegacyPlanBoard(): void {
  try {
    window.localStorage.removeItem(PLAN_STORAGE_KEY);
  } catch {
    // 与旧写入同一降级策略
  }
}

/** 顺序（Push 268 起固定 = 最近更新在前；排序 UI 下架）：不改原数组。 */
export function orderPlanNotes(notes: readonly PlanNote[]): PlanNote[] {
  return notes.slice().sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

/** 关键字（标题 / 内容 / 分类，忽略大小写）+ 分类过滤。 */
export function filterPlanNotes(notes: readonly PlanNote[], keyword: string, category: string | null): PlanNote[] {
  const query = keyword.trim().toLowerCase();
  return notes.filter((note) => {
    if (category !== null && note.category !== category) {
      return false;
    }
    if (query === "") {
      return true;
    }
    return (note.title + "\n" + note.content + "\n" + note.category).toLowerCase().includes(query);
  });
}

/** 英文月份短名（Push 301 · 便签卡角标 / 编辑弹窗「更新于」；与 i18n.EN_MONTHS 同款）。 */
const PLAN_MONTHS_EN: readonly string[] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** ISO 时间 → 卡片角标相对文案（Push 266 照 MiniMemo 参考页；Push 301 按界面语言出中英）：中文 = 刚刚 / N 分钟前 / N 小时前 / 昨天 / M月D日（跨年带年）；英文 = Just now / N min ago / N hr ago / Yesterday / Sep 5；非法值原样透出。 */
export function formatPlanRelative(iso: string, locale: Locale = "zh", now: Date = new Date()): string {
  const at = new Date(iso);
  const atMs = at.getTime();
  if (Number.isNaN(atMs)) {
    return iso;
  }
  const diff = now.getTime() - atMs;
  const minute = 60000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) {
    return locale === "en" ? "Just now" : "刚刚";
  }
  if (diff < hour) {
    const minutesAgo = Math.floor(diff / minute);
    return locale === "en" ? String(minutesAgo) + " min ago" : String(minutesAgo) + " 分钟前";
  }
  if (diff < day) {
    const hoursAgo = Math.floor(diff / hour);
    return locale === "en" ? String(hoursAgo) + " hr ago" : String(hoursAgo) + " 小时前";
  }
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (atMs >= startOfToday - day && atMs < startOfToday) {
    return locale === "en" ? "Yesterday" : "昨天";
  }
  const month = String(at.getMonth() + 1);
  const dayText = String(at.getDate());
  if (at.getFullYear() === now.getFullYear()) {
    return locale === "en" ? PLAN_MONTHS_EN[at.getMonth()] + " " + dayText : month + "月" + dayText + "日";
  }
  return locale === "en"
    ? PLAN_MONTHS_EN[at.getMonth()] + " " + dayText + ", " + String(at.getFullYear())
    : String(at.getFullYear()) + "年" + month + "月" + dayText + "日";
}

/** 编辑弹窗底栏「更新于」：中文 = 2026年10月10日 18:20；英文 = Oct 10, 2026 18:20（与参考页 formatFull 同口径：年 / 月 / 日原样、时 / 分补零；Push 301 起按界面语言出中英）。 */
export function formatPlanFull(iso: string, locale: Locale = "zh"): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) {
    return iso;
  }
  const pad = (value: number): string => String(value).padStart(2, "0");
  if (locale === "en") {
    return PLAN_MONTHS_EN[at.getMonth()] + " " + String(at.getDate()) + ", " + String(at.getFullYear()) + " " + pad(at.getHours()) + ":" + pad(at.getMinutes());
  }
  return (
    String(at.getFullYear()) + "年" + String(at.getMonth() + 1) + "月" + String(at.getDate()) + "日 " +
    pad(at.getHours()) + ":" + pad(at.getMinutes())
  );
}

/** 时段问候（Push 266 照 MiniMemo 参考页；Push 301 按界面语言出中英）：中文 = 夜深了 / 早上好 / 中午好 / 下午好 / 晚上好；英文 = Late night / Good morning / Good afternoon / Good evening。 */
export function planGreeting(locale: Locale = "zh", now: Date = new Date()): string {
  const hour = now.getHours();
  if (locale === "en") {
    if (hour < 5) {
      return "Late night";
    }
    if (hour < 12) {
      return "Good morning";
    }
    if (hour < 18) {
      return "Good afternoon";
    }
    return "Good evening";
  }
  if (hour < 5) {
    return "夜深了";
  }
  if (hour < 12) {
    return "早上好";
  }
  if (hour < 14) {
    return "中午好";
  }
  if (hour < 18) {
    return "下午好";
  }
  return "晚上好";
}
