import { useSyncExternalStore } from "react";
import { saveBackgroundTier, saveCardWatermark } from "./preferencesApi";
import { getLocale, textOf } from "./i18n";

/**
 * 背景档位（业务口径 2026-10-13「在这旁边增加一个背景下拉选择 先做弹出框 分为三个档位
 * 简约（就是当前系统除去醒目模式的档位）适中 就是醒目模式下的列表 炫彩 三个版本 代码背景实现先不做」；
 * 同日追订「这些备注的话不要说」：弹层只显档名、不写说明小字）：
 *  简约 = 当前系统观感（不含整片铺色）；适中 = 便签同款兑白实色铺满；炫彩 = 同色相高饱和浓彩（兑白比例整体拉高）。
 *  Push 290：原「醒目模式」开关下架 —— 档位 = 全站唯一观感开关（项目空间卡片 / 项目总览 / 问题追踪 /
 *  工作台「我的任务」「我提出的问题」都随档位；「适中」统一 = 行 / 卡整片铺色 + 状态列收口成深色字）。
 *
 * 进度（同日「现在开始涉及 先来适中版」→「借鉴我的任务的色调 当前项目空间的还是太淡了」→「不同项目类型的颜色不同应该」
 * →「颜色还是不太搭配」→「用 c 试试」）：适中档先落项目空间卡片 —— 底色 = 「我的任务」便签完全同款（实色 + 同款描边，
 * 取 myPlan.ts 的 PLAN_COLORS），按字典主题色查定档色板；未定档取值回落「主题色兑白 15% / 描边 32%」换算（新增类型自动有淡彩）。
 *
 * 炫彩档（2026-10-13「ok现在我们做炫彩 颜色饱和度偏高的色彩」）：色相照旧（项目类型 / 任务状态色不换、只换浓淡），
 * 兑白比例整体拉高 —— 底色 accent × 0.62 + 白、描边 / 悬停 × 0.82 + 白；接线面与适中档同刀（项目空间卡片 / 项目总览 /
 * 工作台两表 / 日报问题追踪），顶栏「背景 · 炫彩」一键全站生效。
 *
 * 选中态挂在模块级 store：顶栏（AppHeader）在各页都渲染，切换页面不丢选择；Push 291 起**按账号落库** ——
 * 单键 PATCH `user_preferences.prefs.backgroundTier`（业务口径 2026-10-13「当前背景选择后刷新就没了 要按账号记住」；
 * 与常用筛选 / 工作台展开态同一条偏好通道，跨设备同账号可见；失败回滚 + 顶部 Toast 出文案）。
 * Push 292 追加**卡片水印开关**（业务口径 2026-10-13「增加一个水印选项 可以选择是否要水印」）：同一条偏好通道的
 * `cardWatermark`（顶栏背景菜单第四行 toggle，关 = 卡片不渲染水印）。
 * Push 313（业务口径 2026-10-14「把系统当前所有人的背景改成适中 无水印 这个设成默认的」）：**默认档 simple → medium、
 * 水印默认 true → false**（新账号 / 无记录 = 适中 + 无水印；存量账号由迁移 0049 统一回填），设置菜单里用户仍可自行切换。
 */
export type BackgroundTier = "simple" | "medium" | "vivid";

export const BG_TIERS: Array<{ key: BackgroundTier; label: string }> = [
  { key: "simple", label: "简约" },
  { key: "medium", label: "适中" },
  { key: "vivid", label: "炫彩" },
];

/** 默认档（Push 313 起 = 适中；无记录 / 坏值同口径回落，见 asBackgroundTier）。 */
let currentTier: BackgroundTier = "medium";
/** 卡片水印开关（Push 292 新增 · Push 313 起默认 false）：true = 项目卡片右下角国家名水印显示 / false = 隐藏（默认，无水印）。 */
let currentWatermark = false;
const listeners = new Set<() => void>();

/** 订阅变更（档位与水印共用一套订阅：任一偏好变化都通知两边重读各自快照）。 */
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 运行期兜底（老服务端混布 / 坏值）：白名单外一律落默认 medium（Push 313 起）。 */
export function asBackgroundTier(value: unknown): BackgroundTier {
  return value === "simple" || value === "vivid" ? value : "medium";
}

export function getBackgroundTier(): BackgroundTier {
  return currentTier;
}

function setTierInternal(next: BackgroundTier): void {
  if (next === currentTier) {
    return;
  }
  currentTier = next;
  listeners.forEach((listener) => {
    listener();
  });
}

/** 登录后由偏好加载静默落位（App.tsx）：只改本地观感、不落库。 */
export function applyBackgroundTier(next: BackgroundTier): void {
  setTierInternal(next);
}

/**
 * 用户点选档位（顶栏「背景 · 档位」）：Push 291 起按账号落库 —— 乐观落位 + 单键 PATCH
 * `user_preferences.prefs.backgroundTier`（与常用筛选 / 工作台展开态同一条偏好通道；跨设备同账号可见）。
 * 成功 = 以服务端收敛值落位；失败 = 若期间没再切档则回滚到点选前的档位、返回文案给顶栏 Toast（界面不能停在假状态）。
 */
export async function selectBackgroundTier(next: BackgroundTier): Promise<string | null> {
  const previous = currentTier;
  if (next === previous) {
    return null;
  }
  setTierInternal(next);
  try {
    const prefs = await saveBackgroundTier(next);
    // 服务端未回该键（服务端仍是旧构建的混布窗口）时保持乐观值，不被 undefined 冲回默认档
    if (currentTier === next && typeof prefs.backgroundTier === "string") {
      setTierInternal(asBackgroundTier(prefs.backgroundTier));
    }
    return null;
  } catch {
    if (currentTier === next) {
      setTierInternal(previous);
    }
    return textOf(getLocale(), "header.bg.saveFailed");
  }
}

/** 订阅当前档位（AppHeader 选中态与各页观感的唯一来源）。 */
export function useBackgroundTier(): BackgroundTier {
  return useSyncExternalStore(subscribe, getBackgroundTier);
}

/** 运行期兜底（老服务端混布 / 坏值）：只有严格 true 算开启，缺键 / 其它一律回默认 false（Push 313 起）。 */
export function asCardWatermark(value: unknown): boolean {
  return value === true;
}

export function getCardWatermark(): boolean {
  return currentWatermark;
}

function setWatermarkInternal(next: boolean): void {
  if (next === currentWatermark) {
    return;
  }
  currentWatermark = next;
  listeners.forEach((listener) => {
    listener();
  });
}

/** 登录后由偏好加载静默落位（App.tsx）：只改本地观感、不落库。 */
export function applyCardWatermark(next: boolean): void {
  setWatermarkInternal(next);
}

/**
 * 用户点选「水印」开关（顶栏背景菜单第四行 · Push 292 · 业务口径「增加一个水印选项 可以选择是否要水印」）：
 * 乐观落位 + 单键 PATCH `user_preferences.prefs.cardWatermark`；成功 = 以服务端收敛值落位
 * （服务端未回该键的混布窗口保持乐观值）、失败 = 回滚到点选前状态并返回文案给顶栏 Toast。
 */
export async function selectCardWatermark(next: boolean): Promise<string | null> {
  const previous = currentWatermark;
  if (next === previous) {
    return null;
  }
  setWatermarkInternal(next);
  try {
    const prefs = await saveCardWatermark(next);
    if (currentWatermark === next && typeof prefs.cardWatermark === "boolean") {
      setWatermarkInternal(asCardWatermark(prefs.cardWatermark));
    }
    return null;
  } catch {
    if (currentWatermark === next) {
      setWatermarkInternal(previous);
    }
    return textOf(getLocale(), "header.bg.watermarkSaveFailed");
  }
}

/** 订阅卡片水印开关（AppHeader 开关态与项目卡片渲染的唯一来源）。 */
export function useCardWatermark(): boolean {
  return useSyncExternalStore(subscribe, getCardWatermark);
}

/** 适中档 · 「我的任务」便签同款色板（业务口径 2026-10-13「用 c 试试」）：按字典主题色定档 ——
 *  底色 / 描边取 myPlan.ts 的 PLAN_COLORS 同款（T-sort 便签蓝 / 飞箱 便签黄 / 3D分拣 便签绿，键 = 种子里的 metadata.accent）。 */
const MEDIUM_NOTE_SWATCH_BY_ACCENT: Record<string, { bg: string; border: string }> = {
  "#3b82f6": { bg: "#e3eefe", border: "#c5daf7" },
  "#feca04": { bg: "#fef8d5", border: "#f2e3a4" },
  "#10b981": { bg: "#e4f6e6", border: "#c6e8ca" },
};

/** 适中档 · 未定档主题色的回退比例：底色 accent × 0.15 + 白 × 0.85；描边 accent × 0.32 + 白 × 0.68。 */
const MEDIUM_TINT_MIX = 0.15;
const MEDIUM_TINT_BORDER_MIX = 0.32;

/** 十六进制主题色兑白换算（t = accent 占比）；非 #rrggbb 取值 = undefined（调用方按「不上色」处理）。 */
function mixWithWhite(accentColor: string, t: number): string | undefined {
  const hex = accentColor.trim();
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)) {
    return undefined;
  }
  const channel = (start: number) => {
    const value = parseInt(hex.slice(start, start + 2), 16);
    return Math.round(255 - (255 - value) * t);
  };
  return "rgb(" + String(channel(1)) + ", " + String(channel(3)) + ", " + String(channel(5)) + ")";
}

/** 定档便签色查询：主题色大小写 / 空格归一后查表；未定档 = undefined。 */
function noteSwatchOf(accentColor: string): { bg: string; border: string } | undefined {
  return MEDIUM_NOTE_SWATCH_BY_ACCENT[accentColor.trim().toLowerCase()];
}

/** 适中档 · 项目卡片底色：定档色 = 便签同款实色；未定档 = 主题色兑白淡彩。 */
export function mediumCardTintOf(accentColor: string): string | undefined {
  const swatch = noteSwatchOf(accentColor);
  return swatch === undefined ? mixWithWhite(accentColor, MEDIUM_TINT_MIX) : swatch.bg;
}

/** 适中档 · 项目卡片描边：与底色配套（定档色板自带同款描边；未定档 = 同色系一档深）。 */
export function mediumCardBorderOf(accentColor: string): string | undefined {
  const swatch = noteSwatchOf(accentColor);
  return swatch === undefined ? mixWithWhite(accentColor, MEDIUM_TINT_BORDER_MIX) : swatch.border;
}

/**
 * 铺色档（适中 / 炫彩）：两档都 = 铺色 + 状态列收口，只有浓淡之差 —— 组件接线统一用本类型
 * （simple 档 = false；背景档位布尔化时代的 tierTint: boolean 全部升格为本类型）。
 */
export type TintedTier = "medium" | "vivid";

/** 炫彩档 · 配方（业务口径 2026-10-13「颜色饱和度偏高的色彩」）：底色 = accent × 0.62 + 白、
 *  描边 / 悬停 = × 0.82 + 白 —— 约当 Tailwind 300~400 档的饱和感：够艳、深色字仍保对比（同色相不换）。 */
const VIVID_TINT_MIX = 0.62;
const VIVID_BORDER_MIX = 0.82;

/** 炫彩档 · 项目卡片 / 任务行底色：主题色高饱和兑白（定档 / 未定档同一套换算）。 */
export function vividCardTintOf(accentColor: string): string | undefined {
  return mixWithWhite(accentColor, VIVID_TINT_MIX);
}

/** 炫彩档 · 项目卡片 / 任务行描边（悬停底）：同色系再深一档。 */
export function vividCardBorderOf(accentColor: string): string | undefined {
  return mixWithWhite(accentColor, VIVID_BORDER_MIX);
}

/** 按档位取卡片底色 / 描边（simple = undefined 不上色；适中 = 便签同款淡彩；炫彩 = 高饱和浓彩）。 */
export function cardTintOf(tier: BackgroundTier, accentColor: string): string | undefined {
  if (tier === "medium") {
    return mediumCardTintOf(accentColor);
  }
  return tier === "vivid" ? vividCardTintOf(accentColor) : undefined;
}

export function cardBorderOf(tier: BackgroundTier, accentColor: string): string | undefined {
  if (tier === "medium") {
    return mediumCardBorderOf(accentColor);
  }
  return tier === "vivid" ? vividCardBorderOf(accentColor) : undefined;
}
