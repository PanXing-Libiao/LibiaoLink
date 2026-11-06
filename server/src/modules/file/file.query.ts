import { DeliverableTypeSchema, UuidSchema } from "@libiaolink/contracts";
import { AppError } from "../../common/errors/app-error.js";

/**
 * 文件库列表查询解析（M4-03 · A4-01 / A4-09）：纯函数、不做 IO。
 * 非法状态 / 超长类型名称 / uuid 一律 400（明确失败，不返回静默空列表）；排序白名单外 400。
 *
 * 默认口径：不带 filter[status] 时排除 recycled（文件库 = 在用文件；回收站文件走显式
 * `filter[status]=recycled`，与任务文件摘要的排除口径一致）；显式给出时以给出为准。
 */

export const FILE_LIST_STATUSES = ["draft", "final", "changed", "archived", "recycled"] as const;

export type FileListSortField = "createdAt" | "updatedAt" | "finalizedAt" | "name" | "status";

export interface FileListSort {
  field: FileListSortField;
  direction: "asc" | "desc";
}

export interface FileListFilter {
  nodeId: string | null;
  taskId: string | null;
  /** 多值（OR）；null = 默认（排除 recycled）。 */
  statuses: string[] | null;
  /** 多值（OR）；null = 不筛选。 */
  docTypes: string[] | null;
  /** 上传人（files.created_by：文件创建者；追加版本的 uploaded_by 不是筛选口径）。 */
  uploadedBy: string | null;
  keyword: string | null;
}

/** 与 shared FileListQuerySchema 的 z.infer 同形（窄化键名，避免 controller 重复传 z 类型）。 */
export interface FileListQueryInput {
  "filter[nodeId]"?: string | undefined;
  "filter[taskId]"?: string | undefined;
  "filter[status]"?: string | undefined;
  "filter[docType]"?: string | undefined;
  "filter[uploadedBy]"?: string | undefined;
  q?: string | undefined;
  page: number;
  limit: number;
  sort?: string | undefined;
}

export function parseFileListFilter(query: FileListQueryInput): FileListFilter {
  const nodeId = optionalUuid(query["filter[nodeId]"], "filter[nodeId]");
  const taskId = optionalUuid(query["filter[taskId]"], "filter[taskId]");
  const uploadedBy = optionalUuid(query["filter[uploadedBy]"], "filter[uploadedBy]");
  const statuses = splitMulti(query["filter[status]"]);
  if (statuses !== null) {
    for (const status of statuses) {
      if (!(FILE_LIST_STATUSES as readonly string[]).includes(status)) {
        throw new AppError("VALIDATION_FAILED", "filter[status] 含非法文件状态：" + status);
      }
    }
  }
  const docTypes = splitMulti(query["filter[docType]"]);
  if (docTypes !== null) {
    for (const docType of docTypes) {
      if (!DeliverableTypeSchema.safeParse(docType).success) {
        throw new AppError("VALIDATION_FAILED", "filter[docType] 含非法成果文件类型：" + docType);
      }
    }
  }
  const keyword = query.q?.trim() ?? "";
  return {
    nodeId,
    taskId,
    statuses,
    docTypes,
    uploadedBy,
    keyword: keyword === "" ? null : keyword,
  };
}

/**
 * 排序解析（白名单 createdAt / updatedAt / finalizedAt / name / status）；
 * 空值 = 默认顺序（created_at desc + id 升序 tie-breaker，见 repository）。
 */
export function parseFileListSort(sort: string | undefined): FileListSort[] {
  if (sort === undefined || sort === "") return [];
  const parsed: FileListSort[] = [];
  for (const segment of sort.split(",")) {
    const [rawField = "", rawDirection] = segment.split(":");
    if (!isSortField(rawField)) {
      throw new AppError(
        "VALIDATION_FAILED",
        "sort 字段不在白名单（createdAt / updatedAt / finalizedAt / name / status）：" + rawField,
      );
    }
    if (rawDirection !== undefined && rawDirection !== "asc" && rawDirection !== "desc") {
      throw new AppError("VALIDATION_FAILED", "sort 方向仅支持 asc / desc：" + rawDirection);
    }
    parsed.push({ field: rawField, direction: rawDirection ?? "asc" });
  }
  return parsed;
}

function isSortField(value: string): value is FileListSortField {
  return (
    value === "createdAt" ||
    value === "updatedAt" ||
    value === "finalizedAt" ||
    value === "name" ||
    value === "status"
  );
}

function optionalUuid(value: string | undefined, field: string): string | null {
  if (value === undefined) return null;
  if (!UuidSchema.safeParse(value).success) {
    throw new AppError("VALIDATION_FAILED", field + " 不是合法 UUID：" + value);
  }
  return value;
}

function splitMulti(value: string | undefined): string[] | null {
  if (value === undefined) return null;
  const parts = value.split(",").map((part) => part.trim()).filter((part) => part !== "");
  return parts.length === 0 ? null : parts;
}
