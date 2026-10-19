import { ProjectStatusSchema, STAGE_KEYS, UuidSchema } from "@libiaolink/contracts";
import { AppError } from "../../common/errors/app-error.js";

/**
 * 项目列表 / facets 的查询解析（M2-04 · v0.3 §3.3「列表与计数共用一个 filter 构造器，禁止两套 SQL」）。
 * 纯函数、不做 IO；时间区间按 Asia/Shanghai 日界（ADR-028，固定 +08:00，中国无夏令时）。
 * 非法枚举 / uuid / 时间区间一律 400（明确失败，不返回静默空列表）。
 */

export interface ProjectFilter {
  regions: string[] | null;
  projectTypes: string[] | null;
  managerIds: string[] | null;
  stageKeys: string[] | null;
  statuses: string[] | null;
  keyword: string | null;
  /** 创建时间下界（含）：filter[timeFrom] 当日 00:00:00+08:00（Push 175：维度 = projects.created_at）。 */
  createdFrom: Date | null;
  /** 创建时间上界（不含）：filter[timeTo] 次日 00:00:00+08:00。 */
  createdToExclusive: Date | null;
  /** 归档年份（C4-07 归档检索）：filter[archivedYear] 四位年份多值；按 archived_at 的 Asia/Shanghai 年判定。 */
  archivedYears: number[] | null;
  /** 项目回收站：true = 仅已软删项目；false = 仅未删除项目。列表 / facets 共用。 */
  recycled: boolean;
}

export type ProjectSortField = "updatedAt" | "createdAt" | "seqNo";

export interface ProjectSort {
  field: ProjectSortField;
  direction: "asc" | "desc";
}

/** 与 shared ProjectListQuerySchema 的 z.infer 同形（窄化键名，避免 controller 重复传入 z 类型）。 */
export interface ProjectListQueryInput {
  "filter[region]"?: string | undefined;
  "filter[projectType]"?: string | undefined;
  "filter[managerId]"?: string | undefined;
  "filter[stageKey]"?: string | undefined;
  "filter[status]"?: string | undefined;
  "filter[timeFrom]"?: string | undefined;
  "filter[timeTo]"?: string | undefined;
  "filter[archivedYear]"?: string | undefined;
  "filter[recycled]"?: "true" | "false" | undefined;
  q?: string | undefined;
  page: number;
  limit: number;
  sort?: string | undefined;
}

const SHANGHAI_OFFSET = "+08:00";
const DAY_MS = 86_400_000;

export function buildProjectFilter(query: ProjectListQueryInput): ProjectFilter {
  const statuses = splitMulti(query["filter[status]"]);
  if (statuses !== null) {
    for (const status of statuses) {
      if (!ProjectStatusSchema.safeParse(status).success) {
        throw new AppError("VALIDATION_FAILED", "filter[status] 含非法项目状态：" + status);
      }
    }
  }
  const stageKeys = splitMulti(query["filter[stageKey]"]);
  if (stageKeys !== null) {
    for (const stageKey of stageKeys) {
      if (!(STAGE_KEYS as readonly string[]).includes(stageKey)) {
        throw new AppError("VALIDATION_FAILED", "filter[stageKey] 含非法阶段：" + stageKey);
      }
    }
  }
  const managerIds = splitMulti(query["filter[managerId]"]);
  if (managerIds !== null) {
    for (const managerId of managerIds) {
      if (!UuidSchema.safeParse(managerId).success) {
        throw new AppError("VALIDATION_FAILED", "filter[managerId] 含非法用户 ID：" + managerId);
      }
    }
  }
  const archivedYears = splitMulti(query["filter[archivedYear]"]);
  if (archivedYears !== null) {
    for (const year of archivedYears) {
      const value = Number(year);
      if (!/^[0-9]{4}$/.test(year) || value < 1900 || value > 2100) {
        throw new AppError("VALIDATION_FAILED", "filter[archivedYear] 含非法年份（四位年份，1900-2100）：" + year);
      }
    }
  }
  const createdFrom = query["filter[timeFrom]"] === undefined ? null : shanghaiDayStart(query["filter[timeFrom]"]);
  const toDayStart = query["filter[timeTo]"] === undefined ? null : shanghaiDayStart(query["filter[timeTo]"]);
  if (createdFrom !== null && toDayStart !== null && createdFrom.getTime() > toDayStart.getTime()) {
    throw new AppError("VALIDATION_FAILED", "filter[timeFrom] 不能晚于 filter[timeTo]");
  }
  const keyword = query.q?.trim() ?? "";
  const recycled = query["filter[recycled]"];
  if (recycled !== undefined && recycled !== "true" && recycled !== "false") {
    throw new AppError("VALIDATION_FAILED", "filter[recycled] 仅支持 true / false");
  }
  return {
    regions: splitMulti(query["filter[region]"]),
    projectTypes: splitMulti(query["filter[projectType]"]),
    managerIds,
    stageKeys,
    statuses,
    keyword: keyword === "" ? null : keyword,
    createdFrom,
    createdToExclusive: toDayStart === null ? null : new Date(toDayStart.getTime() + DAY_MS),
    archivedYears: archivedYears === null ? null : archivedYears.map((year) => Number(year)),
    recycled: recycled === "true",
  };
}

/** 排序解析：白名单 updatedAt / createdAt / seqNo（A9）；缺省 createdAt:desc（Push 175：默认按创建时间，最近创建的在前）。 */
export function parseProjectSort(sort: string | undefined): ProjectSort[] {
  if (sort === undefined || sort === "") {
    return [{ field: "createdAt", direction: "desc" }];
  }
  const parsed: ProjectSort[] = [];
  for (const segment of sort.split(",")) {
    const [rawField = "", rawDirection] = segment.split(":");
    if (rawField !== "updatedAt" && rawField !== "createdAt" && rawField !== "seqNo") {
      throw new AppError("VALIDATION_FAILED", "sort 字段不在白名单（updatedAt / createdAt / seqNo）：" + rawField);
    }
    if (rawDirection !== undefined && rawDirection !== "asc" && rawDirection !== "desc") {
      throw new AppError("VALIDATION_FAILED", "sort 方向仅支持 asc / desc：" + rawDirection);
    }
    parsed.push({ field: rawField, direction: rawDirection ?? "asc" });
  }
  return parsed;
}

function splitMulti(value: string | undefined): string[] | null {
  if (value === undefined) return null;
  const parts = value.split(",").map((part) => part.trim()).filter((part) => part !== "");
  return parts.length === 0 ? null : parts;
}

function shanghaiDayStart(dateOnly: string): Date {
  return new Date(dateOnly + "T00:00:00" + SHANGHAI_OFFSET);
}
