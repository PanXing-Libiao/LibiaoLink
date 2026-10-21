/**
 * 数据字典（C9-01 · A3）：GET /api/v1/dicts 一期两类 —— region（地区）/ projectType（项目类型）。
 * 项目类型主题色随条目 metadata.accent / accentText 下发，前端不硬编码（《前端功能需求》§3.2 / §二.1）。
 * 契约 shared/src/modules/dicts.ts：服务端只下发 enabled=true 的项；阶段 / 成果文件类型 / 紧急重要度是契约枚举，不走本接口。
 * Push 172：新增项目类型时从预置色板（DICT_ACCENT_PALETTE，「颜色模板」）选色。
 * Push 173：删除 = **物理删行**（DELETE /dicts/{type}/items/{code}，仅管理员 dict.manage）—— 删除无记忆：同码可重新新增，
 *   按全新条目处理（本次所选颜色、排到末尾），界面不出现「已停用 / 恢复」字样。
 * Push 174：**引用守卫** —— 条目正被项目卡片引用（usageCount > 0）时删除入口置灰（服务端 409 DICT_ITEM_IN_USE 兜底），
 *   业务口径「有项目在用就不给删」，避免已上卡片的地区 / 类型被删掉。
 */
import { apiRequest, apiSend } from "./api";

export type DictTypeCode = "region" | "projectType";

export type DictItem = {
  code: string;
  name: string;
  sort: number;
  enabled: boolean;
  /** 引用该条目的**未删除项目**数（region / projectType 两个维度；其余恒 0）—— > 0 时不给删（Push 174 引用守卫）。 */
  usageCount: number;
  metadata: Record<string, unknown>;
};

export type Dicts = Record<DictTypeCode, DictItem[]>;

export const EMPTY_DICTS: Dicts = { region: [], projectType: [] };

/** 条目名称 / 码上限：契约 code ≤ 64、name ≤ 80；前端两个入口（地区 / 项目类型）统一按 64 收口。 */
export const DICT_NAME_MAX = 64;

type DictListResponse = { items: Array<{ type: string; items: DictItem[] }> };

/**
 * 只保留启用项并按 sort 升序：写接口的响应是整个字典（服务端组装），直接替换缓存会把兼容的停用行带回下拉 ——
 * 前端缓存一律过滤掉 enabled=false（Push 173 起删除 = 物理删行，enabled 只是二期的兼容字段）。
 */
function enabledOnly(items: DictItem[]): DictItem[] {
  return items.filter((item) => item.enabled).sort((left, right) => left.sort - right.sort);
}

/**
 * 单个类型的写结果（POST / DELETE 的响应只带该类型）：调用方按类型合并进缓存（不能整份替换 —— 写响应不含另一个类型）。
 */
export type DictTypeResult = { type: DictTypeCode; items: DictItem[] };

function toTypeResult(dict: { type: string; items: DictItem[] }): DictTypeResult {
  return { type: dict.type as DictTypeCode, items: enabledOnly(dict.items) };
}

/**
 * 拉全量字典（登录后一次）：GET /api/v1/dicts（登录即可；服务端只下发启用项）。
 * 调用方失败时回落 EMPTY_DICTS，页面继续可用。
 */
export async function loadDicts(): Promise<Dicts> {
  const dicts: Dicts = { region: [], projectType: [] };
  for (const dict of (await apiRequest<DictListResponse>("/api/v1/dicts")).items) {
    if (dict.type !== "region" && dict.type !== "projectType") {
      continue;
    }
    dicts[dict.type] = enabledOnly(dict.items);
  }
  return dicts;
}

/** 字典显示名：未知码（已删除的存量值 / 字典外的值）回落码本身，界面不出现空白。 */
export function dictLabel(dicts: Dicts, type: DictTypeCode, code: string): string {
  const item = dicts[type].find((entry) => entry.code === code);
  return item === undefined ? code : item.name;
}

/** 新字典项的排序值：排在现有条目之后（步长 10，与种子 #5 的 10 / 20 / 30… 同口径）。 */
export function nextDictSort(items: readonly DictItem[]): number {
  let maxSort = 0;
  for (const item of items) {
    if (item.sort > maxSort) {
      maxSort = item.sort;
    }
  }
  return maxSort + 10;
}

/**
 * 新增字典条目：POST /api/v1/dicts/{type}/items（C9-02）。region = 任何登录用户（Push 168 业务口径「全站共享」）；
 * projectType 等其余类型 = dict.manage（仅管理员）。响应 = 更新后的整个字典，前端取该类型的启用项替换缓存
 * （不本地拼接：库内顺序 / updatedAt 以服务端为准）；码重复 409 DICT_ITEM_EXISTS、无权限 403 由调用方分支提示。
 */
export async function createDictItem(
  type: DictTypeCode,
  input: { code: string; name: string; sort: number; enabled: boolean; metadata: Record<string, unknown> },
): Promise<DictTypeResult> {
  return toTypeResult(await apiSend<{ type: string; items: DictItem[] }>("/api/v1/dicts/" + type + "/items", "POST", input));
}

/**
 * 删除字典条目（**物理删除** · 仅管理员 dict.manage）：DELETE /api/v1/dicts/{type}/items/{code}。
 * 库内直接删行（删除前快照写审计，C7-02），下拉候选与首页筛选里立刻消失；存量项目仍按原码 / 原名渲染（无外键引用），
 * 同码可重新新增 —— 按**全新条目**处理：用本次所选颜色、排到末尾，界面不出现任何「恢复」提示。
 */
export async function deleteDictItem(type: DictTypeCode, code: string): Promise<DictTypeResult> {
  return toTypeResult(
    await apiSend<{ type: string; items: DictItem[] }>("/api/v1/dicts/" + type + "/items/" + encodeURIComponent(code), "DELETE"),
  );
}

/**
 * 预置色板（「颜色模板」· Push 172）：新增项目类型时选一个 —— 色值 + 徽标文字色成对给出（白字 / 深灰字按底色定对比度），
 * 写进条目 metadata.accent / metadata.accentText。前三项 = 库内已有类型（T-sort / 3D分拣 / 飞箱）的同款取值，
 * 新增类型据此与既有类型同色系；前端不提供自由取色器（业务口径「颜色之前应该有模板」）。
 */
export const DICT_ACCENT_PALETTE = [
  { key: "blue", name: "蓝", nameEn: "Blue", color: "#3b82f6", text: "#ffffff" },
  { key: "emerald", name: "绿", nameEn: "Green", color: "#10b981", text: "#ffffff" },
  { key: "amber", name: "品牌黄", nameEn: "Brand Yellow", color: "#feca04", text: "#313033" },
  { key: "orange", name: "橙", nameEn: "Orange", color: "#f97316", text: "#ffffff" },
  { key: "red", name: "红", nameEn: "Red", color: "#ef4444", text: "#ffffff" },
  { key: "violet", name: "紫", nameEn: "Violet", color: "#8b5cf6", text: "#ffffff" },
  { key: "cyan", name: "青", nameEn: "Cyan", color: "#06b6d4", text: "#ffffff" },
  { key: "indigo", name: "靛蓝", nameEn: "Indigo", color: "#6366f1", text: "#ffffff" },
  { key: "pink", name: "玫红", nameEn: "Rose", color: "#ec4899", text: "#ffffff" },
  { key: "lime", name: "草绿", nameEn: "Lawn Green", color: "#84cc16", text: "#313033" },
  { key: "slate", name: "石板灰", nameEn: "Slate", color: "#64748b", text: "#ffffff" },
] as const;

export type DictAccent = (typeof DICT_ACCENT_PALETTE)[number];

/** 条目的主题色：取 metadata.accent / accentText；缺省或非字符串回落品牌黄 + 深灰字（浅色底可读）。 */
export function accentOfItem(item: DictItem | undefined): { color: string; text: string } {
  const color = item === undefined ? undefined : item.metadata["accent"];
  const text = item === undefined ? undefined : item.metadata["accentText"];
  return {
    color: typeof color === "string" && color !== "" ? color : "#feca04",
    text: typeof text === "string" && text !== "" ? text : "#313033",
  };
}

/** 项目类型主题色：按码取字典条目的 accent / accentText（卡片、类型徽标、色点共用）。 */
export function typeAccent(dicts: Dicts, code: string): { color: string; text: string } {
  return accentOfItem(dicts.projectType.find((entry) => entry.code === code));
}
