import type { Project } from "./types";

/**
 * 「常用筛选」（分类筛选侧栏 · 业务口径 2026-09-22）：
 * 不同员工关注的项目不一样 —— 把一组分类条件（地区 / 项目类型 / 项目经理 / 项目时间）
 * 存成可命名的组合，一键复用：点「添加」→ 在分类里勾选多项 → 命名保存 → 出现在「常用筛选」。
 *
 * 存储（A24 · Push 169 落库）：按账号存服务端 `user_preferences.prefs.homeSavedFilters`
 * （GET / PATCH /api/v1/users/me/preferences；同一账号换设备可见，同一设备换账号互不可见）。
 * 本文件只保留类型 / 常量 / 纯函数，外加 Push 138–168 期间 localStorage 旧键的**迁移读取**
 * （服务端为空时把本机组合推上云，一次性迁移见 frontend/src/preferencesApi.ts）。
 */
export type FilterCriteria = {
  regions: string[];
  projectTypes: string[];
  managerIds: string[];
  timeFrom: string | null;
  timeTo: string | null;
};

export type SavedFilter = FilterCriteria & {
  id: string;
  name: string;
};

/** 名称上限（与输入框 maxLength 同源）；超长截断而不是拒绝。 */
export const SAVED_FILTER_NAME_MAX = 20;

/** 最多保存的组合数（超出后「添加」置灰并提示）。 */
export const SAVED_FILTER_LIMIT = 20;

/** Push 138–168 的本机记忆键（**只读迁移用**：Push 169 起不再写入，见 preferencesApi.ts）。 */
export const SAVED_FILTERS_STORAGE_KEY = "libiaolink.home.savedFilters.v1";

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export function emptyCriteria(): FilterCriteria {
  return { regions: [], projectTypes: [], managerIds: [], timeFrom: null, timeTo: null };
}

/** 至少选中一项条件（名称 + 空条件不允许保存）。 */
export function hasCriteria(criteria: FilterCriteria): boolean {
  return (
    criteria.regions.length > 0 ||
    criteria.projectTypes.length > 0 ||
    criteria.managerIds.length > 0 ||
    (criteria.timeFrom !== null && criteria.timeTo !== null)
  );
}

/** 条件命中判定：与首页列表（Home.tsx）同一口径 —— 多值任一命中即命中、时间闭区间按日期部分比较。 */
export function matchesCriteria(project: Project, criteria: FilterCriteria): boolean {
  if (criteria.regions.length > 0 && !criteria.regions.includes(project.region)) {
    return false;
  }
  if (criteria.managerIds.length > 0 && !project.managerIds.some((managerId) => criteria.managerIds.includes(managerId))) {
    return false;
  }
  if (criteria.projectTypes.length > 0 && !criteria.projectTypes.includes(project.projectType)) {
    return false;
  }
  if (criteria.timeFrom !== null && criteria.timeTo !== null) {
    const day = project.updatedAt.slice(0, 10);
    if (day < criteria.timeFrom || day > criteria.timeTo) {
      return false;
    }
  }
  return true;
}

function sortedKey(list: string[]): string {
  return list.slice().sort().join("\u0000");
}

/** 两组条件是否等价（忽略数组顺序与重复）—— 用于「当前筛选 = 哪个常用筛选」的高亮判定。 */
export function sameCriteria(left: FilterCriteria, right: FilterCriteria): boolean {
  return (
    sortedKey(left.regions) === sortedKey(right.regions) &&
    sortedKey(left.projectTypes) === sortedKey(right.projectTypes) &&
    sortedKey(left.managerIds) === sortedKey(right.managerIds) &&
    left.timeFrom === right.timeFrom &&
    left.timeTo === right.timeTo
  );
}

export function criteriaOf(filter: SavedFilter): FilterCriteria {
  return {
    regions: filter.regions.slice(),
    projectTypes: filter.projectTypes.slice(),
    managerIds: filter.managerIds.slice(),
    timeFrom: filter.timeFrom,
    timeTo: filter.timeTo,
  };
}

export function normalizeFilterName(raw: string): string {
  return raw.trim().slice(0, SAVED_FILTER_NAME_MAX);
}

export function newSavedFilterId(): string {
  return "sf-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
}

function sanitizeList(value: unknown): string[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || item === "") {
      return null;
    }
    if (!result.includes(item)) {
      result.push(item);
    }
  }
  return result;
}

function sanitizeDay(value: unknown): string | null | undefined {
  if (value === null) {
    return null;
  }
  if (typeof value === "string" && DATE_ONLY.test(value)) {
    return value;
  }
  return undefined;
}

/** 单条：字段缺失 / 类型不符即整条丢弃（不半读半写）。 */
function sanitizeSavedFilter(value: unknown): SavedFilter | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const id = typeof record.id === "string" && record.id !== "" ? record.id : null;
  const name = typeof record.name === "string" ? normalizeFilterName(record.name) : "";
  const regions = sanitizeList(record.regions);
  const projectTypes = sanitizeList(record.projectTypes);
  const managerIds = sanitizeList(record.managerIds);
  const timeFrom = sanitizeDay(record.timeFrom ?? null);
  const timeTo = sanitizeDay(record.timeTo ?? null);
  if (id === null || name === "" || regions === null || projectTypes === null || managerIds === null || timeFrom === undefined || timeTo === undefined) {
    return null;
  }
  const criteria: FilterCriteria = { regions, projectTypes, managerIds, timeFrom, timeTo };
  if (!hasCriteria(criteria)) {
    return null;
  }
  return { id, name, ...criteria };
}

/** 读取本机旧键（迁移用）；损坏 / 缺失一律按「无常用筛选」处理，不抛错，最多回 SAVED_FILTER_LIMIT 条。 */
export function readLegacySavedFilters(): SavedFilter[] {
  try {
    const raw = window.localStorage.getItem(SAVED_FILTERS_STORAGE_KEY);
    if (raw === null) {
      return [];
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    const items: SavedFilter[] = [];
    for (const item of parsed) {
      const filter = sanitizeSavedFilter(item);
      if (filter !== null && !items.some((existing) => existing.id === filter.id)) {
        items.push(filter);
      }
      if (items.length >= SAVED_FILTER_LIMIT) {
        break;
      }
    }
    return items;
  } catch {
    return [];
  }
}

/**
 * 迁移成功（或服务端已有值）后清除本机旧键。
 * 「退出登录清空」的口径随之取消：常用筛选是账号自己的记忆（服务端按 actorId 隔离），换账号不会串。
 */
export function clearLegacySavedFilters(): void {
  try {
    window.localStorage.removeItem(SAVED_FILTERS_STORAGE_KEY);
  } catch {
    // 存储受限（隐私模式）静默跳过
  }
}
