/**
 * 项目接口封装（M2-07 首页联调）：
 * - 列表 GET /api/v1/projects（filter[...] + q + sort + page/limit）
 * - 分类计数 GET /api/v1/projects/facets（与列表同一套参数，禁止两套口径；《前端功能需求》§3.2）
 * - 新建 POST /api/v1/projects、编辑 PATCH /api/v1/projects/{id}（乐观锁 version）、删除 DELETE /api/v1/projects/{id}（移入项目回收站，If-Match 版本）
 * - 项目回收站 GET /api/v1/projects?filter[recycled]=true、恢复 POST /api/v1/projects/{id}/restore、彻底删除 POST /api/v1/projects/{id}/purge
 * 契约 shared/src/modules/projects.ts；UI 模型见 types.ts（前端「项目描述」= 契约 name）。
 */
import { apiDownload, apiRequest, apiSend, readAllPages } from "./api";
import { EMPTY_LIST_QUERY, type ListQueryState } from "./useHashRoute";
import type { Project } from "./types";

export type ApiProject = {
  id: string;
  code: string;
  seqNo: number;
  name: string;
  customer: string | null;
  region: string;
  projectType: string;
  managerIds: string[];
  managerNames: Array<string | null>;
  stageKey: string;
  status: string;
  description: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  /** 进入项目回收站的时间；未删除 = null。 */
  deletedAt: string | null;
  /** 移入项目回收站的操作用户 id；未删除 = null。 */
  deletedBy: string | null;
};

export type ProjectListResult = { items: ApiProject[]; page: number; limit: number; total: number };

/** 首页侧边栏计数（五组固定返回；一期展示 region / projectType / managerId 三组）。 */
export type ProjectFacets = {
  total: number;
  region: Record<string, number>;
  projectType: Record<string, number>;
  managerId: Record<string, number>;
  stageKey: Record<string, number>;
  status: Record<string, number>;
};

export const EMPTY_FACETS: ProjectFacets = { total: 0, region: {}, projectType: {}, managerId: {}, stageKey: {}, status: {} };

/**
 * 计数分组的维度：侧栏各组各自排除自己那一维、其余条件照常参与 ——
 * 选中「华东」后其它地区仍显示各自计数（不是一律 0），项目类型 / 项目经理 / 项目状态计数则跟着收窄。
 */
export type FacetSkip = "regions" | "projectTypes" | "managerIds" | "statuses";

/** 组装列表 / 计数的同一套查询串（契约 §3.2 参数命名）。 */
export function buildListQuery(filters: ListQueryState, skip: FacetSkip | null = null): string {
  const parts: string[] = [];
  const pushList = (key: string, values: string[]): void => {
    if (values.length > 0) {
      parts.push(key + "=" + values.map((value) => encodeURIComponent(value)).join(","));
    }
  };
  if (skip !== "regions") {
    pushList("filter[region]", filters.regions);
  }
  if (skip !== "projectTypes") {
    pushList("filter[projectType]", filters.projectTypes);
  }
  if (skip !== "managerIds") {
    pushList("filter[managerId]", filters.managerIds);
  }
  if (skip !== "statuses") {
    pushList("filter[status]", filters.statuses);
  }
  if (filters.timeFrom !== null && filters.timeTo !== null) {
    parts.push("filter[timeFrom]=" + encodeURIComponent(filters.timeFrom));
    parts.push("filter[timeTo]=" + encodeURIComponent(filters.timeTo));
  }
  if (filters.q.trim() !== "") {
    parts.push("q=" + encodeURIComponent(filters.q.trim()));
  }
  // 排序也进同一条查询串（Push 175 修）：Home 的请求键 = 本函数，排序不进键时切换升 / 降序不触发重新取数
  // —— 旧实现把 sort 拼在 fetchProjectList 里，切换后列表纹丝不动（业务反馈「根据时间排序没用了」）。
  // 维度固定创建时间（Push 177：业务口径「取消按更新时间排序 只保留创建时间」），只切方向。
  parts.push("sort=createdAt:" + (filters.sortDesc ? "desc" : "asc"));
  return parts.join("&");
}

export function fetchProjectList(filters: ListQueryState): Promise<ProjectListResult> {
  const parts = [buildListQuery(filters)];

  const query = parts.filter((part) => part !== "").join("&");
  return readAllPages<ApiProject>("/api/v1/projects?" + query);
}

export function fetchProjectFacets(filters: ListQueryState, skip: FacetSkip | null = null): Promise<ProjectFacets> {
  const query = buildListQuery(filters, skip);
  return apiRequest<ProjectFacets>("/api/v1/projects/facets" + (query === "" ? "" : "?" + query));
}

/**
 * 「已有项目地区」计数（Push 304）：全量 region 计数（不带筛选；值 = 项目 region 落库原文 → 未删除项目数）——
 * 与列表筛选同源 facet，字典外的国名 / 存量值也照数（只认字典码的旧口径会漏「美国 / 英国」这类落库值）。
 */
export function fetchUsedRegions(): Promise<Record<string, number>> {
  return fetchProjectFacets(EMPTY_LIST_QUERY).then((facets) => facets.region);
}

export function fetchProject(id: string): Promise<ApiProject> {
  return apiRequest<ApiProject>("/api/v1/projects/" + encodeURIComponent(id));
}

/** 进入项目详情时记录一次访问（动作 = 访问）；同一页面内静默刷新 / 修改数据不重复写。 */
export function recordProjectVisit(id: string): Promise<void> {
  return apiSend<void>("/api/v1/projects/" + encodeURIComponent(id) + "/visit", "POST");
}

/**
 * 写请求字段（新建 / 编辑同一套）。
 * Push 280：`remark` = 备注（契约 `description`）—— undefined = 不发送（不改）；空串 = 新建不发送（留空）、编辑发送 null（清空）。
 * customer（客户）仍未采集（不发送即不改）。
 */
export type ProjectWriteInput = {
  code: string;
  name: string;
  region: string;
  projectType: string;
  managerIds: string[];
  /** 备注（契约 description）：undefined = 不发送；空串 = 新建留空不发送 / 编辑发 null 清空。 */
  remark?: string;
};

export function createProject(input: ProjectWriteInput): Promise<ApiProject> {
  const body: { code: string; name: string; region: string; projectType: string; managerIds: string[]; description?: string } = {
    code: input.code,
    name: input.name,
    region: input.region,
    projectType: input.projectType,
    managerIds: input.managerIds,
  };
  // 备注（Push 280）：新建留空不发送（契约 description 可选）；有值才带上。
  if (input.remark !== undefined && input.remark !== "") {
    body.description = input.remark;
  }
  return apiSend<ApiProject>("/api/v1/projects", "POST", body);
}

/** PATCH 可写状态（契约 ProjectUpdateBody：archived 不接受 PATCH —— 归档只能走归档端点；Push 262 编辑弹窗口径）。 */
export type ProjectStatusPatch = "active" | "paused" | "done";

export function updateProject(id: string, input: ProjectWriteInput, version: number, status?: ProjectStatusPatch): Promise<ApiProject> {
  const body: {
    code: string;
    name: string;
    region: string;
    projectType: string;
    managerIds: string[];
    version: number;
    status?: ProjectStatusPatch;
    description?: string | null;
  } = {
    code: input.code,
    name: input.name,
    region: input.region,
    projectType: input.projectType,
    managerIds: input.managerIds,
    version,
  };
  if (status !== undefined) {
    body.status = status;
  }
  // 备注（Push 280）：undefined = 不发送（不改）；空串 = 发 null 清空（契约 description 可空）。
  if (input.remark !== undefined) {
    body.description = input.remark === "" ? null : input.remark;
  }
  return apiSend<ApiProject>("/api/v1/projects/" + encodeURIComponent(id), "PATCH", body);
}

/**
 * 项目归档（M7-04 · C4-02 / C4-03 · ADR-027；Push 262 编辑弹窗「已归档」接线）：`PATCH` 不收 archived，归档只能走本端点 ——
 * 硬前置 = 验收阶段完成（未完成 409 ARCHIVE_NOT_READY，不可越过）；缺项首次 422 ARCHIVE_GATE_NOT_PASSED（明细在 ApiError.details），
 * `confirm=true` 二次确认后带缺项归档（缺项随清单 acknowledgedMissing 留痕）。
 */
export type ProjectArchiveResult = {
  id: string;
  projectId: string;
  archivedAt: string;
  archivedBy: string;
  archivedByName: string | null;
};

export function archiveProject(id: string, version: number, confirm: boolean): Promise<ProjectArchiveResult> {
  return apiSend<ProjectArchiveResult>("/api/v1/projects/" + encodeURIComponent(id) + "/archive", "POST", { version, confirm });
}

/**
 * 删除项目（2026-10-19 起 = 移入项目回收站）：DELETE /api/v1/projects/{id} —— 版本走 **If-Match 请求头**（不是正文），
 * 缺头 / 非数字 400 VALIDATION_FAILED；版本不一致 409 VERSION_CONFLICT；归档项目 409 PROJECT_ARCHIVED；不存在 / 不可见 404。
 * 只写 deleted_at / deleted_by（version +1），项目聚合数据与对象存储图片保留；可通过项目回收站恢复。
 */
export function deleteProject(id: string, version: number): Promise<ApiProject> {
  return apiRequest<ApiProject>("/api/v1/projects/" + encodeURIComponent(id), {
    method: "DELETE",
    headers: { "If-Match": String(version) },
  });
}

/** 项目回收站列表：全量分页取满；普通项目列表不返回已删除项目。 */
export function fetchRecycledProjects(): Promise<ProjectListResult> {
  return readAllPages<ApiProject>("/api/v1/projects?filter[recycled]=true&sort=createdAt:desc");
}

/** 从项目回收站恢复：清 deleted_at / deleted_by 并 version +1；version 不匹配 409。 */
export function restoreProject(id: string, version: number): Promise<ApiProject> {
  return apiSend<ApiProject>("/api/v1/projects/" + encodeURIComponent(id) + "/restore", "POST", { version });
}

export type ProjectPurgeResult = { projectId: string; purgedAt: string };

/**
 * 彻底删除项目（仅系统管理员）：清空数据库内项目聚合数据，并删除对象存储 projects/{id}/ 前缀下全部版本、
 * delete marker 与暂存对象。永久不可恢复；仅回收站中的项目可执行。
 */
export function purgeProject(id: string, version: number): Promise<ProjectPurgeResult> {
  return apiSend<ProjectPurgeResult>("/api/v1/projects/" + encodeURIComponent(id) + "/purge", "POST", { version });
}

/** ISO8601（UTC）→ 展示用「YYYY-MM-DD HH:mm」（Asia/Shanghai，时区口径 ADR-028）。 */
export function formatDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const pick = (type: string): string => {
    const found = parts.find((part) => part.type === type);
    return found === undefined ? "" : found.value;
  };
  return pick("year") + "-" + pick("month") + "-" + pick("day") + " " + pick("hour") + ":" + pick("minute");
}

/** API 视图 → UI 模型：前端「项目描述」= 契约 name；经理姓名随行下发（卡片 / 详情不再查演示目录）。 */
export function toUiProject(view: ApiProject): Project {
  return {
    id: view.id,
    seqNo: view.seqNo,
    code: view.code,
    description: view.name,
    remark: view.description ?? "",
    region: view.region,
    projectType: view.projectType,
    createdAt: formatDateTime(view.createdAt),
    updatedAt: formatDateTime(view.updatedAt),
    managerIds: view.managerIds,
    managerNames: view.managerNames,
    version: view.version,
    stageKey: view.stageKey,
    status: view.status,
    deletedAt: view.deletedAt === null ? null : formatDateTime(view.deletedAt),
    deletedBy: view.deletedBy,
  };
}

/** 浏览器保存用的兜底文件名（服务端 Content-Disposition 优先；这里只处理文件名非法字符）。 */
function projectExportDownloadName(project: Project): string {
  const clean = (value: string): string => value.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").replace(/[. ]+$/g, "").trim().slice(0, 120).replace(/[. ]+$/g, "") || "项目";
  return "[" + clean(project.code) + "] " + clean(project.description) + ".xlsx";
}

/**
 * 项目数据导出（project.export）：一次下载四个 Sheet 的 xlsx；
 * origin 显式回传，供服务端把「文件」列生成为当前站点的文件库检索链接。
 */
export async function downloadProjectWorkbook(project: Project): Promise<void> {
  const origin = encodeURIComponent(window.location.origin);
  const response = await apiDownload(
    "/api/v1/projects/" + encodeURIComponent(project.id) + "/export?origin=" + origin,
    { headers: { Accept: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" } },
  );
  const objectUrl = URL.createObjectURL(response.blob);
  try {
    const link = document.createElement("a");
    link.href = objectUrl;
    link.download = response.fileName ?? projectExportDownloadName(project);
    document.body.appendChild(link);
    link.click();
    link.remove();
  } finally {
    window.setTimeout(() => {
      URL.revokeObjectURL(objectUrl);
    }, 1000);
  }
}
