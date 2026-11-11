import { STAKEHOLDER_COMPANY_TYPES } from "@libiaolink/contracts";
import { AppError } from "../../common/errors/app-error.js";
import type { ProjectScopeFilter } from "../permission/index.js";

/**
 * 干系人策略纯函数（j6 · S8·stakeholder · A5-03 / A5-04）：记录级可见集规格 + 列表过滤 / 排序解析。
 * 不碰数据库（CI 用例主对象）；字段级裁剪不在这里 —— 复用 permission 模块的 projectFields（五出口同源 · C3-08）。
 */

/**
 * 记录级可见集规格：每条干系人记录归属一个项目，可见性只由所属项目决定。
 * all = 全量台账（项目可见集为 all，即管理员）；restricted = 所属项目落在当前账号可见项目内。
 * 项目之间互不继承：即使同一自然人由同一账号录入，不同项目也是独立记录。
 */
export type StakeholderVisibility =
  | { kind: "all" }
  | { kind: "restricted"; projectIds: string[] };

export function stakeholderVisibility(projectScope: ProjectScopeFilter): StakeholderVisibility {
  if (projectScope.kind === "all") return { kind: "all" };
  return { kind: "restricted", projectIds: [...projectScope.ids] };
}

export function isStakeholderProjectFilterVisible(
  filter: StakeholderFilter,
  visibility: StakeholderVisibility,
): boolean {
  if (filter.projectId === null) return true;
  return visibility.kind === "all" || visibility.projectIds.includes(filter.projectId);
}

/** 列表过滤条件（纯解析结果）。 */
export interface StakeholderFilter {
  keyword: string | null;
  companyTypes: string[] | null;
  projectId: string | null;
}

/** 与 shared StakeholderListQuerySchema 的 z.infer 同形（窄化键名，controller 直接透传）。 */
export interface StakeholderListQueryInput {
  q?: string | undefined;
  "filter[companyType]"?: string | undefined;
  "filter[projectId]"?: string | undefined;
  page: number;
  limit: number;
  sort?: string | undefined;
}

/** 过滤解析：非法公司分类 / 项目 id 一律 400（不静默返回空列表）。 */
export function buildStakeholderFilter(query: StakeholderListQueryInput): StakeholderFilter {
  const companyTypes = splitMulti(query["filter[companyType]"]);
  if (companyTypes !== null) {
    for (const companyType of companyTypes) {
      if (!(STAKEHOLDER_COMPANY_TYPES as readonly string[]).includes(companyType)) {
        throw new AppError("VALIDATION_FAILED", "filter[companyType] 含非法公司分类：" + companyType);
      }
    }
  }
  const keyword = query.q?.trim() ?? "";
  return {
    keyword: keyword === "" ? null : keyword,
    companyTypes,
    projectId: query["filter[projectId]"] ?? null,
  };
}

export type StakeholderSortField = "updatedAt" | "createdAt" | "name";

export interface StakeholderSort {
  field: StakeholderSortField;
  direction: "asc" | "desc";
}

/** 排序解析：白名单 updatedAt / createdAt / name；缺省 updatedAt:desc（A5-01「最近更新时间」在前）。 */
export function parseStakeholderSort(sort: string | undefined): StakeholderSort[] {
  if (sort === undefined || sort === "") return [{ field: "updatedAt", direction: "desc" }];
  const parsed: StakeholderSort[] = [];
  for (const segment of sort.split(",")) {
    const parts = segment.split(":");
    const rawField = parts[0] ?? "";
    const rawDirection = parts[1];
    if (rawField !== "updatedAt" && rawField !== "createdAt" && rawField !== "name") {
      throw new AppError("VALIDATION_FAILED", "sort 字段不在白名单（updatedAt / createdAt / name）：" + rawField);
    }
    if (rawDirection !== undefined && rawDirection !== "asc" && rawDirection !== "desc") {
      throw new AppError("VALIDATION_FAILED", "sort 方向仅支持 asc / desc：" + rawDirection);
    }
    parsed.push({ field: rawField, direction: rawDirection ?? "asc" });
  }
  return parsed;
}

/** 关键词谓词（与仓储同一口径）：姓名 / 公司 / 职务命中。 */
export function matchesKeyword(stakeholder: { name: string; company: string | null; title: string | null }, keyword: string): boolean {
  const needle = keyword.toLowerCase();
  return [stakeholder.name, stakeholder.company ?? "", stakeholder.title ?? ""].some((value) => value.toLowerCase().includes(needle));
}

function splitMulti(value: string | undefined): string[] | null {
  if (value === undefined) return null;
  const parts = value.split(",").map((part) => part.trim()).filter((part) => part !== "");
  return parts.length === 0 ? null : parts;
}
