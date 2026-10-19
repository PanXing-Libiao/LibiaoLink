import { useSyncExternalStore } from "react";
import { readStoredFilters } from "./homePrefs";
import { AUDIT_ACTIONS, AUDIT_OBJECT_TYPES, AUDIT_RESULTS } from "./auditApi";
import { PROJECT_STATUS_VALUES } from "./types";

/**
 * 列表页筛选态：URL query 是唯一来源（可分享、可收藏、刷新不丢）。
 * 参数命名与技术设计 v0.2 §8.2（GET /api/v1/projects 与 /projects/facets）同口径，
 * 键名与实际取值见《前端功能需求》§一.3「筛选态与 URL query」。
 */
export type ListQueryState = {
  regions: string[];
  projectTypes: string[];
  managerIds: string[];
  /** 项目状态筛选（Push 262 追订）：active / paused / done / archived，多值任一命中（`filter[status]`）。 */
  statuses: string[];
  timeFrom: string | null;
  timeTo: string | null;
  q: string;
  sortDesc: boolean;
};

export const EMPTY_LIST_QUERY: ListQueryState = {
  regions: [],
  projectTypes: [],
  managerIds: [],
  statuses: [],
  timeFrom: null,
  timeTo: null,
  q: "",
  sortDesc: true,
};

/** 占位页（Push 230 起只剩「任务模板」）：「我的任务」已转正式页面 frontend/src/WorkspacePage.tsx。 */
export type PlaceholderPage = "templates";

/** 项目详情页顶部标签（6 视图，Push 82 / 128 / 145 / 221）在地址里的取值：`#/project/{id}?view=`。缺省「项目总览」不落参数（默认值不进 URL，与列表筛选态同一口径）。 */
export type ProjectView = "overview" | "gantt" | "owners" | "progress" | "daily" | "stakeholders";

/**
 * 「日报及问题」的四块页内子视图（Push 214）在地址里的取值：`#/project/{id}?view=daily&sub=`。
 * 取值 = records（日报记录，缺省，不落参数）/ form（日报填写）/ issues（问题追踪）/ board（问题看板）；
 * 缺省不落参数与顶部标签 / 列表筛选态同一口径 —— 旧链接 `?view=daily` 原样打开 = 日报记录（Push 243 业务口径「点击默认是日报记录页面」）。
 */
export type DailySubView = "form" | "records" | "issues" | "board";

/**
 * 工作台「我的任务」页的标签（Push 230 两枚 / Push 234 增加「我的计划」）在地址里的取值：`#/my-tasks?tab=`。
 * 取值 = tasks（我的任务，缺省，不落参数）/ raised（我提出的问题）/ plan（我的计划）；缺省不落参数与顶部标签 / 列表筛选态同一口径。
 */
export type WorkspaceTab = "tasks" | "raised" | "plan";

/**
 * 「提出/负责的问题」标签（Push 260 改名）下两枚子视图在地址里的取值（形态 = 主标签的下拉子菜单，
 * 业务口径「在我提出的问题增加子标签导航栏 和日报那样 增加待我处理的问题」→「然后导航栏还是改成这样的吧」）：
 * `#/my-tasks?tab=raised&sub=`。取值 = raised（我提出的问题，缺省，不落参数）/ handling（待我处理的问题）；
 * 只在该标签下有语义 —— 切走 / 其它标签一律缺省 raised（地址里也不落），与「日报及问题」的 `?view=daily&sub=` 同一口径。
 */
export type WorkspaceIssueView = "raised" | "handling";

/**
 * 「操作记录」页（#/audit）的筛选态：与首页列表同一口径 —— 地址即状态（可分享 / 可收藏 / 刷新不丢）。
 * 取值白名单 = 契约枚举（auditApi.ts 同口径）；关键字 `q`（摘要 / 操作人姓名，Push 260 搜索）长度兜底 200；
 * 多选（2026-10-09 追订「别的筛选也是同理 要支持多选」+「操作记录里面也是」）：操作人 / 动作 / 对象类型 / 结果 /
 * 项目均为逗号分隔多值（去重保序，地址参数 actor / action / objectType / result / project）；缺省（无筛选 + 第 1 页）不落参数。
 */
export type AuditQueryState = {
  /** 关键字（Push 260 · C7-04 搜索）：操作内容（摘要 / 变化明细）/ 操作人姓名快照，地址参数 `q`。 */
  keyword: string | null;
  /** 多选操作人 id（空数组 = 全部操作人）。 */
  actorIds: string[];
  /** 多选动作（空数组 = 全部动作）。 */
  actions: string[];
  /** 多选对象类型（空数组 = 全部对象）。 */
  objectTypes: string[];
  /** 多选结果（空数组 = 全部结果）。 */
  results: string[];
  /** 多选项目 id（空数组 = 全部项目）。 */
  projectIds: string[];
  /** 时间下界（日，YYYY-MM-DD，Asia/Shanghai）。 */
  from: string | null;
  /** 时间上界（日，YYYY-MM-DD，Asia/Shanghai）。 */
  to: string | null;
  page: number;
};

export const EMPTY_AUDIT_QUERY: AuditQueryState = { keyword: null, actorIds: [], actions: [], objectTypes: [], results: [], projectIds: [], from: null, to: null, page: 1 };

/**
 * 「文件库」页（#/files · Push 261 · 头像菜单「文件库」入口）两栏在地址里的取值：`?tab=`。
 * 取值 = current（系统现有文件，缺省，不落参数）/ recycled（回收站）；与「日报及问题」`?sub=` 同一口径：
 * 缺省不落参数、不认识 / 空值回落 current。
 */
export type FilesTab = "current" | "recycled";

/**
 * 「文件库」页筛选态（Push 261 · 与首页列表 / 操作记录同一口径：地址即状态，可分享 / 可收藏 / 刷新不丢）：
 * 关键字 q（文件名，长度兜底 200）/ 项目 project=<id>[,<id>…]（**多选**：逗号分隔、去重保序，2026-10-09 追订）/
 * 状态 status=<k>[,<k>…]（**多选**；draft / final / changed / archived，只在「系统现有文件」栏有意义 ——
 * 回收站栏固定 recycled、该参数不落地址）/ 上传人 uploadedBy=<id>[,<id>…]（**多选**：逗号分隔、去重保序，
 * 2026-10-09 追订「别的筛选也是同理 要支持多选」）/ 页码 page；缺省（current 栏 + 无筛选 + 第 1 页）不落参数。
 *【2026-10-09 追订】类型 docType 参数整条撤除（业务口径「文件类型不需要 因为没有明确的绑定机制」—— 库内文件
 * 没有类型绑定点、列与筛选恒空；任务侧的「输出成果文件」是任务字段，不受影响）。
 */
export type FilesQueryState = {
  tab: FilesTab;
  keyword: string | null;
  /** 多选项目 id（空数组 = 全部项目；地址里逗号分隔）。 */
  projectIds: string[];
  /** 多选状态（空数组 = 全部状态；地址里逗号分隔）。 */
  statuses: string[];
  /** 多选上传人 id（空数组 = 全部上传人；地址里逗号分隔）。 */
  uploaderIds: string[];
  page: number;
};

export const EMPTY_FILES_QUERY: FilesQueryState = { tab: "current", keyword: null, projectIds: [], statuses: [], uploaderIds: [], page: 1 };

export type Route =
  | { kind: "hub"; view: HubView | null }
  | { kind: "workspace"; tab: WorkspaceTab; sub: WorkspaceIssueView }
  | { kind: "list"; filters: ListQueryState }
  | { kind: "project"; id: string; view: ProjectView; sub: DailySubView }
  | { kind: "placeholder"; page: PlaceholderPage; section: string | null }
  | { kind: "audit"; query: AuditQueryState }
  | { kind: "settings" }
  | { kind: "files"; query: FilesQueryState };

/** 任务模板页地址：当前板块（标签栏选中的阶段）也走 URL —— 与列表页筛选态同一口径，地址即状态。 */
export const TEMPLATE_BASE_HASH = "#/templates";

/** 列表页地址：蓝图页（Hub · Push 285 前叫「入口页 / 首页」）占用 #/，项目空间列表移到 #/projects。 */
export const LIST_BASE_HASH = "#/projects";

/**
 * 蓝图页地址（顶层）：详情 / 列表 / 占位页的「上一层」最终都落到这里。
 * Push 285（业务口径 2026-10-12「登录后默认进入项目空间 首页名称改成蓝图」）：导航项与页面名由「首页」改「蓝图」；
 * 登录后默认落地改项目空间 —— 裸根地址（无 hash / 只有 `#`）按项目空间列表解析，本地址只由显式 `#/`（点导航项 / 分享链接）进入。
 */
export const HUB_HASH = "#/";

/** 项目详情地址前缀：当前标签走 `?view=`（缺省「项目总览」不落参数）。 */
export const PROJECT_BASE_HASH = "#/project/";

/** 工作台「我的任务」页地址（Push 230 转正式）：标签走 `?tab=`，缺省「我的任务」不落参数。 */
export const WORKSPACE_BASE_HASH = "#/my-tasks";

/** 「操作记录」页地址（头像菜单「退出登录」下方入口；筛选态走 query，缺省不落参数）。 */
export const AUDIT_BASE_HASH = "#/audit";

/** 「文件库」页地址（头像菜单「文件库」入口；两栏 + 筛选态走 query，缺省不落参数）—— Push 261。 */
export const FILES_BASE_HASH = "#/files";

/**
 * 「设置」页地址（头像菜单首项入口 · Push 250）：账号级设置的家（当前 = 企业微信绑定 D5 / D6）。
 * 没有页内子态，故不带 query。
 */
export const SETTINGS_BASE_HASH = "#/settings";

const PROJECT_PATH = /^\/project\/([^/]+)$/;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, " "));
  } catch {
    return value;
  }
}

/** 多值参数统一用英文逗号分隔（与契约 filter[...] 同口径）；空值与重复值丢弃。 */
function parseListValue(value: string | null): string[] {
  if (value === null) {
    return [];
  }
  const unique = new Set<string>();
  for (const piece of value.split(",")) {
    const trimmed = piece.trim();
    if (trimmed !== "") {
      unique.add(trimmed);
    }
  }
  return Array.from(unique);
}

/** 日期只接受 YYYY-MM-DD；非法值直接丢弃，不阻塞页面。 */
function parseDayValue(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  const trimmed = value.trim();
  if (!DATE_ONLY.test(trimmed) || Number.isNaN(Date.parse(trimmed + "T00:00:00Z"))) {
    return null;
  }
  return trimmed;
}

/** 项目状态白名单（与 `PROJECT_STATUS_VALUES` 同源）：`filter[status]` 只认这四档，非法值丢弃、不阻塞页面。 */
function parseProjectStatuses(value: string | null): string[] {
  return parseListValue(value).filter((item) => (PROJECT_STATUS_VALUES as readonly string[]).includes(item));
}

/** 解析 hash 里的 query 串（形如 filter[region]=A,B&filter[projectType]=..&filter[managerId]=..&filter[status]=..&filter[timeFrom]=..&filter[timeTo]=..&q=..&sort=createdAt:asc）。 */
export function parseListQuery(search: string): ListQueryState {
  const params = new Map<string, string>();
  for (const chunk of search.split("&")) {
    if (chunk === "") {
      continue;
    }
    const separator = chunk.indexOf("=");
    const key = safeDecode(separator === -1 ? chunk : chunk.slice(0, separator));
    if (!params.has(key)) {
      params.set(key, safeDecode(separator === -1 ? "" : chunk.slice(separator + 1)));
    }
  }
  let timeFrom = parseDayValue(params.get("filter[timeFrom]") ?? null);
  let timeTo = parseDayValue(params.get("filter[timeTo]") ?? null);
  if (timeFrom !== null && timeTo !== null && timeFrom > timeTo) {
    const swap = timeFrom;
    timeFrom = timeTo;
    timeTo = swap;
  }
  return {
    regions: parseListValue(params.get("filter[region]") ?? null),
    projectTypes: parseListValue(params.get("filter[projectType]") ?? null),
    managerIds: parseListValue(params.get("filter[managerId]") ?? null),
    statuses: parseProjectStatuses(params.get("filter[status]") ?? null),
    timeFrom,
    timeTo,
    q: params.get("q") ?? "",
    sortDesc: parseSortDesc(params.get("sort") ?? null),
  };
}

/**
 * 排序参数（Push 175；**Push 177 起只保留创建时间维度**）：`sort=<field>:<asc|desc>` 里**只读方向** ——
 * 维度固定在创建时间（业务口径「取消按更新时间排序 只保留创建时间」）；旧链接（含 `updatedAt:asc`）按同一套方向解析，缺省 = 降序。
 * 默认值（创建时间 × 降序）不落 URL，见 buildListHash。
 */
function parseSortDesc(value: string | null): boolean {
  const direction = (value ?? "").split(":")[1] ?? "";
  return direction !== "asc";
}

/** 任务模板页的板块参数（`?section=<slug>`，兼容旧链接的中文板块名）：空值 / 重复键丢弃，与列表页筛选态同口径；slug ↔ 板块名的解析在 `PlaceholderPage` 侧做。 */
function parseSectionValue(search: string): string | null {
  let section: string | null = null;
  for (const chunk of search.split("&")) {
    if (chunk === "") {
      continue;
    }
    const separator = chunk.indexOf("=");
    const key = safeDecode(separator === -1 ? chunk : chunk.slice(0, separator));
    if (key !== "section" || section !== null) {
      continue;
    }
    const value = safeDecode(separator === -1 ? "" : chunk.slice(separator + 1)).trim();
    section = value === "" ? null : value;
  }
  return section;
}

/** 仪表盘页落地视图（Push 332 · 业务口径 2026-10-15「还是做路由吧 这个页面要记住」）：map = 世界地图（缺省、不落参数）/
 *  dashboard = 仪表盘大屏（Push 358 起六个图表视图：数据总览 / 项目进度 / 任务状态 / 问题 / 交付时间 / 词频图）；地址不带参数时落回账号偏好记的常驻视图（见 App 层 hubView）。与契约 HubViewSchema 同源。 */
export type HubView = "map" | "dashboard";

/** 契约读侧收敛的镜像：偏好 / 地址里的未知值一律回 map（坏值不崩）。 */
export function asHubView(value: unknown): HubView {
  return value === "dashboard" ? "dashboard" : "map";
}

/** 仪表盘页视图参数（`?view=`）：map / dashboard 认，其余取值 / 缺省 = null（= 跟账号记忆，不写死）。 */
function parseHubView(search: string): HubView | null {
  for (const chunk of search.split("&")) {
    if (chunk === "") {
      continue;
    }
    const separator = chunk.indexOf("=");
    const key = safeDecode(separator === -1 ? chunk : chunk.slice(0, separator));
    if (key !== "view") {
      continue;
    }
    const value = safeDecode(separator === -1 ? "" : chunk.slice(separator + 1));
    return value === "dashboard" ? "dashboard" : value === "map" ? "map" : null;
  }
  return null;
}

/** 项目详情标签的合法取值（顺序与标签栏一致）。 */
const PROJECT_VIEW_KEYS: readonly ProjectView[] = ["overview", "gantt", "owners", "progress", "daily", "stakeholders"];

/** 项目详情标签参数（`?view=`）：只认 `PROJECT_VIEW_KEYS`，不认识的取值 / 重复键一律落回「项目总览」。 */
function parseProjectView(search: string): ProjectView {
  for (const chunk of search.split("&")) {
    if (chunk === "") {
      continue;
    }
    const separator = chunk.indexOf("=");
    const key = safeDecode(separator === -1 ? chunk : chunk.slice(0, separator));
    if (key !== "view") {
      continue;
    }
    const value = safeDecode(separator === -1 ? "" : chunk.slice(separator + 1)).trim();
    return PROJECT_VIEW_KEYS.find((view) => view === value) ?? "overview";
  }
  return "overview";
}

/** 「日报及问题」页内子视图的合法取值（顺序与页内导航栏一致）。 */
const PROJECT_SUB_KEYS: readonly DailySubView[] = ["form", "records", "issues", "board"];

/**
 * 页内子视图参数（`?sub=`）：只认 `PROJECT_SUB_KEYS` 里的 ASCII slug，不认识的取值 / 重复键一律落回缺省「日报记录」
 * （地址不纠正，与 `?view=` 同口径）；重复键只认第一个。
 */
function parseProjectSub(search: string): DailySubView {
  for (const chunk of search.split("&")) {
    if (chunk === "") {
      continue;
    }
    const separator = chunk.indexOf("=");
    const key = safeDecode(separator === -1 ? chunk : chunk.slice(0, separator));
    if (key !== "sub") {
      continue;
    }
    const value = safeDecode(separator === -1 ? "" : chunk.slice(separator + 1)).trim();
    return PROJECT_SUB_KEYS.find((sub) => sub === value) ?? "records";
  }
  return "records";
}

/** 工作台标签的合法取值（顺序与标签栏一致）。 */
const WORKSPACE_TAB_KEYS: readonly WorkspaceTab[] = ["tasks", "raised", "plan"];

/**
 * 工作台标签参数（`?tab=`）：只认 `WORKSPACE_TAB_KEYS` 里的 ASCII slug，不认识的取值 / 重复键一律落回缺省「我的任务」
 * （地址不纠正，与 `?view=` / `?sub=` 同口径）；重复键只认第一个。
 */
function parseWorkspaceTab(search: string): WorkspaceTab {
  for (const chunk of search.split("&")) {
    if (chunk === "") {
      continue;
    }
    const separator = chunk.indexOf("=");
    const key = safeDecode(separator === -1 ? chunk : chunk.slice(0, separator));
    if (key !== "tab") {
      continue;
    }
    const value = safeDecode(separator === -1 ? "" : chunk.slice(separator + 1)).trim();
    return WORKSPACE_TAB_KEYS.find((tab) => tab === value) ?? "tasks";
  }
  return "tasks";
}

/** 两枚子视图的合法取值（顺序与下拉面板里的顺序一致）。 */
const WORKSPACE_ISSUE_VIEW_KEYS: readonly WorkspaceIssueView[] = ["raised", "handling"];

/**
 * 子标签参数（`?sub=`，Push 260）：只认 `WORKSPACE_ISSUE_VIEW_KEYS` 里的 ASCII slug，不认识的取值 / 重复键
 * 一律落回缺省「我提出的问题」（地址不纠正，与 `?tab=` / `?view=` 同口径）；重复键只认第一个。
 */
function parseWorkspaceIssueView(search: string): WorkspaceIssueView {
  for (const chunk of search.split("&")) {
    if (chunk === "") {
      continue;
    }
    const separator = chunk.indexOf("=");
    const key = safeDecode(separator === -1 ? chunk : chunk.slice(0, separator));
    if (key !== "sub") {
      continue;
    }
    const value = safeDecode(separator === -1 ? "" : chunk.slice(separator + 1)).trim();
    return WORKSPACE_ISSUE_VIEW_KEYS.find((view) => view === value) ?? "raised";
  }
  return "raised";
}

/**
 * 任务模板页板块在地址里的取值（ASCII slug，Push 154）：URL 不带中文（`?section=design`），
 * 页面内仍以中文板块名为唯一键（与 `PROJECT_STAGES` 口径一致）；板块增删时在这里同步补一行。
 */
const TEMPLATE_SECTION_SLUGS: ReadonlyArray<readonly [string, string]> = [
  ["售前规划", "presale"],
  ["设计开发", "design"],
  ["加工采购", "procurement"],
  ["组装发货", "shipping"],
  ["硬件实施", "hardware"],
  ["软件部署", "software"],
  ["试运行", "trial"],
  ["生产阶段", "production"],
  ["验收", "acceptance"],
];

/** 板块名 → 地址 slug（未登记的板块按原名编码，保证 href 永远写得出）。 */
export function templateSectionSlug(section: string): string {
  return TEMPLATE_SECTION_SLUGS.find(([name]) => name === section)?.[1] ?? section;
}

/** 地址参数 → 板块名：接受 slug，也兼容旧链接里的中文板块名；不认识的取值返回 null。 */
export function templateSectionFromParam(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  const raw = value.trim();
  if (raw === "") {
    return null;
  }
  const hit = TEMPLATE_SECTION_SLUGS.find(([name, slug]) => slug === raw || name === raw);
  return hit === undefined ? null : hit[0];
}

/** 任务模板页某个板块的地址（板块走 query，可直接刷新 / 收藏 / 分享；取值见 `TEMPLATE_SECTION_SLUGS`）。 */
export function templateSectionHref(section: string): string {
  return TEMPLATE_BASE_HASH + "?section=" + encodeURIComponent(templateSectionSlug(section));
}

/** 切换任务模板页的板块：同步渲染并写回地址（replace，不新增历史条目）。 */
export function replaceTemplateSection(section: string): void {
  if (currentRoute.kind !== "placeholder" || currentRoute.page !== "templates") {
    return;
  }
  currentRoute = { ...currentRoute, section };
  emit();
  try {
    window.history.replaceState(null, "", templateSectionHref(section));
  } catch {
    // URL 只是当前板块的投影：写不进去也不影响页面（个别浏览器对 history 调用限流）
  }
}

/**
 * 项目详情某个标签的地址（标签走 query，可直接刷新 / 收藏 / 分享；「项目总览」为缺省、不落参数）。
 * Push 214：「日报及问题」的页内子视图同走地址（`?view=daily&sub=`，ASCII slug；缺省「日报记录」records 不落参数 —— Push 243 改缺省）。
 */
export function projectViewHref(id: string, view: ProjectView, sub: DailySubView = "records"): string {
  const base = PROJECT_BASE_HASH + encodeURIComponent(id);
  if (view === "overview") {
    return base;
  }
  if (view === "daily" && sub !== "records") {
    return base + "?view=daily&sub=" + sub;
  }
  return base + "?view=" + view;
}

/** 切换项目详情标签：同步渲染并写回地址（replace，不新增历史条目）；切进「日报及问题」固定落在缺省「日报记录」（子视图不跨标签记忆；Push 243 前缺省为「日报填写」）。 */
export function replaceProjectView(id: string, view: ProjectView): void {
  if (currentRoute.kind !== "project" || currentRoute.id !== id || currentRoute.view === view) {
    return;
  }
  currentRoute = { ...currentRoute, view, sub: "records" };
  emit();
  try {
    window.history.replaceState(null, "", projectViewHref(id, view));
  } catch {
    // URL 只是当前标签的投影：写不进去也不影响页面（个别浏览器对 history 调用限流）
  }
}

/** 切换「日报及问题」的页内子视图（Push 214）：同步渲染并写回地址（replace，不新增历史条目）—— 刷新 / 收藏 / 分享都停在同一块子视图。 */
export function replaceProjectSubView(id: string, sub: DailySubView): void {
  if (currentRoute.kind !== "project" || currentRoute.id !== id || currentRoute.view !== "daily" || currentRoute.sub === sub) {
    return;
  }
  currentRoute = { ...currentRoute, sub };
  emit();
  try {
    window.history.replaceState(null, "", projectViewHref(id, "daily", sub));
  } catch {
    // URL 只是当前子视图的投影：写不进去也不影响页面（个别浏览器对 history 调用限流）
  }
}

/** 工作台标签地址（缺省「我的任务」不落参数；其余标签按 `?tab=` 取值）—— 与 `projectViewHref` 同一口径。
 *  Push 260：「我提出的问题」下的子标签走 `&sub=`（缺省 raised 不落参数；两参数固定序 tab 在前）。 */
export function workspaceHref(tab: WorkspaceTab, sub: WorkspaceIssueView = "raised"): string {
  if (tab === "tasks") {
    return WORKSPACE_BASE_HASH;
  }
  if (tab === "raised" && sub === "handling") {
    return WORKSPACE_BASE_HASH + "?tab=raised&sub=handling";
  }
  return WORKSPACE_BASE_HASH + "?tab=" + tab;
}

/** 切工作台标签（Push 230）：同步渲染并写回地址（replace，不新增历史条目）—— 刷新 / 收藏 / 分享都停在同一块标签。 */
export function replaceWorkspaceTab(tab: WorkspaceTab): void {
  if (currentRoute.kind !== "workspace" || currentRoute.tab === tab) {
    return;
  }
  currentRoute = { ...currentRoute, tab };
  emit();
  try {
    window.history.replaceState(null, "", workspaceHref(tab));
  } catch {
    // URL 只是当前标签的投影：写不进去也不影响页面（个别浏览器对 history 调用限流）
  }
}

/** 切「我提出的问题」下的子标签（Push 260）：同步渲染并写回地址（replace，不新增历史条目）—— 刷新 / 收藏 /
 *  分享都停在同一块子标签；只在「我提出的问题」标签下生效（其它标签不落 `?sub=`）。 */
export function replaceWorkspaceSub(sub: WorkspaceIssueView): void {
  if (currentRoute.kind !== "workspace" || currentRoute.tab !== "raised" || currentRoute.sub === sub) {
    return;
  }
  currentRoute = { ...currentRoute, sub };
  emit();
  try {
    window.history.replaceState(null, "", workspaceHref("raised", sub));
  } catch {
    // URL 只是当前子标签的投影：写不进去也不影响页面（个别浏览器对 history 调用限流）
  }
}

/** 仪表盘页地址：视图走 query（`#/?view=dashboard`；地图 = 缺省、不落参数）—— 与项目详情标签同一口径，地址即状态。
 *  Push 332（业务口径 2026-10-15「还是做路由吧 这个页面要记住 因为不同的人想常驻的页面可能不一样」）：地址显式带视图时以地址为准。 */
export function hubViewHref(view: HubView): string {
  return view === "dashboard" ? HUB_HASH + "?view=dashboard" : HUB_HASH;
}

/** 切换仪表盘页视图（Push 332）：同步渲染并写回地址（replace，不新增历史条目）—— 刷新 / 收藏 / 分享都停在同一视图。 */
export function replaceHubView(view: HubView): void {
  if (currentRoute.kind !== "hub" || currentRoute.view === view) {
    return;
  }
  currentRoute = { ...currentRoute, view };
  emit();
  try {
    window.history.replaceState(null, "", hubViewHref(view));
  } catch {
    // URL 只是当前视图的投影：写不进去也不影响页面（个别浏览器对 history 调用限流）
  }
}

/** 序列化筛选态：默认值不落 URL（排序固定按创建时间、默认降序 → 省略 sort；时间区间两端齐全才写入）。 */
export function buildListHash(filters: ListQueryState): string {
  const parts: string[] = [];
  const pushList = (key: string, values: string[]): void => {
    if (values.length > 0) {
      parts.push(key + "=" + values.map((value) => encodeURIComponent(value)).join(","));
    }
  };
  pushList("filter[region]", filters.regions);
  pushList("filter[projectType]", filters.projectTypes);
  pushList("filter[managerId]", filters.managerIds);
  pushList("filter[status]", filters.statuses);
  if (filters.timeFrom !== null && filters.timeTo !== null) {
    parts.push("filter[timeFrom]=" + encodeURIComponent(filters.timeFrom));
    parts.push("filter[timeTo]=" + encodeURIComponent(filters.timeTo));
  }
  if (filters.q !== "") {
    parts.push("q=" + encodeURIComponent(filters.q));
  }
  if (!filters.sortDesc) {
    parts.push("sort=createdAt:asc");
  }
  return parts.length === 0 ? LIST_BASE_HASH : LIST_BASE_HASH + "?" + parts.join("&");
}

export function hasListFilters(filters: ListQueryState): boolean {
  return (
    filters.regions.length > 0 ||
    filters.projectTypes.length > 0 ||
    filters.managerIds.length > 0 ||
    filters.statuses.length > 0 ||
    filters.timeFrom !== null ||
    filters.timeTo !== null
  );
}

/** 「项目空间」入口地址：有本地记忆的筛选时直接用记忆地址（与「不带参数进入列表」的恢复口径一致）。 */
export function projectsHref(): string {
  const stored = readStoredFilters();
  if (stored === null) {
    return LIST_BASE_HASH;
  }
  const hash = buildListHash({ ...stored, q: "" });
  return hash === LIST_BASE_HASH ? LIST_BASE_HASH : hash;
}

export function parseHash(hash: string): Route {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  const separator = raw.indexOf("?");
  const path = separator === -1 ? raw : raw.slice(0, separator);
  const search = separator === -1 ? "" : raw.slice(separator + 1);
  if (path === "") {
    // 裸根地址（登录回跳的 `/`、直输域名；或只有 `#`）：Push 285 起默认入口 = **项目空间**
    // （业务口径 2026-10-12「登录后默认进入项目空间」）—— 按列表参数解析；初始化代码再把地址规范化成 `#/projects`。
    return { kind: "list", filters: parseListQuery(search) };
  }
  if (path === "/") {
    // 仪表盘页（顶层 · Push 285 起导航项与页面名由「首页」改「蓝图」· Push 331 起叫「仪表盘」）：显式 `#/` 仍落本页 ——
    // 刷新 / 分享 / 撤回不丢；视图走 `?view=dashboard`（Push 332 · 缺省 = 地图，不带参数时落账号记忆的常驻视图）。
    return { kind: "hub", view: parseHubView(search) };
  }
  if (path === "/templates") {
    return { kind: "placeholder", page: "templates", section: parseSectionValue(search) };
  }
  if (path === "/audit") {
    // 操作记录（C7-04 管理员查询页 · 头像菜单入口）：筛选态走地址（?actor=&action=&objectType=&result=&project=&from=&to=&page=），
    // 缺省不落参数；页面 = frontend/src/AuditLogPage.tsx，数据 = GET /api/v1/audit-logs（auditApi.ts）。
    return { kind: "audit", query: parseAuditQuery(search) };
  }
  if (path === "/files") {
    // 文件库（Push 261 · 头像菜单「文件库」入口）：两栏（系统现有文件 / 回收站）+ 关键字 / 项目 / 状态 / 上传人筛选，
    // 地址即状态（?tab=recycled&q=..&project=..&status=..&uploadedBy=..&page=N；缺省不落参数）；
    // 页面 = frontend/src/FileLibraryPage.tsx，数据 = 逐项目聚合 GET /projects/{id}/files（fileApi.fetchProjectFileLibrary）。
    return { kind: "files", query: parseFilesQuery(search) };
  }
  if (path === "/settings") {
    // 设置（Push 250 · 头像菜单首项入口 · 业务口径 2026-10-16「在点击用户右上角头像后的列表中添加一个设置页」）：
    // 账号级设置的家 —— 当前落点 = 企业微信绑定（D5 / D6 绑定码链路）；页面 = frontend/src/SettingsPage.tsx。
    return { kind: "settings" };
  }
  if (path === "/my-tasks") {
    // 工作台（系统功能书 A6 我的工作台 · A6-01 / A6-03）：Push 230 起页面正式落地（frontend/src/WorkspacePage.tsx），
    // 标签走地址（`?tab=raised` = 提出/负责的问题 / `?tab=plan` = 我的计划；缺省「我的任务」不落参数）；
    // Push 260：第二枚标签带下拉子菜单，两枚子视图走 `?sub=handling`（待我处理的问题；缺省 raised 不落参数）；
    // 数据面 = GET /api/v1/workspace（workspaceApi.ts）。
    const tab = parseWorkspaceTab(search);
    return { kind: "workspace", tab, sub: tab === "raised" ? parseWorkspaceIssueView(search) : "raised" };
  }
  const match = PROJECT_PATH.exec(path);
  if (match) {
    // 页内子视图只在「日报及问题」标签下有语义；其它标签一律缺省（form），地址里也不落
    const view = parseProjectView(search);
    return { kind: "project", id: safeDecode(match[1] ?? ""), view, sub: view === "daily" ? parseProjectSub(search) : "form" };
  }
  return { kind: "list", filters: parseListQuery(search) };
}

/** 操作记录页枚举筛选的白名单校验：不认识 / 空值一律丢弃（不阻塞页面）。 */
function parseAuditEnum(value: string | null, allowed: readonly string[]): string | null {
  if (value === null) {
    return null;
  }
  const trimmed = value.trim();
  return allowed.find((item) => item === trimmed) ?? null;
}

/** 操作记录页的 id 型筛选（操作人 / 项目）：空值丢弃，只做长度兜底。 */
function parseAuditId(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === "" || trimmed.length > 200 ? null : trimmed;
}

/** 操作记录页关键字（q，Push 260 搜索）：空值丢弃，只做长度兜底（与契约 q max(200) 同口径）。 */
function parseAuditKeyword(value: string | null): string | null {
  return parseAuditId(value);
}

/** 解析操作记录页的 query 串（q=关键字&actor=<id>[,<id>…]&action=update,create&objectType=task&result=denied&project=<id>&from=…&to=…&page=2；
 * 多值逗号分隔、逐个校验白名单 / 去重保序，非法项丢弃不报错）。 */
export function parseAuditQuery(search: string): AuditQueryState {
  const params = new Map<string, string>();
  for (const chunk of search.split("&")) {
    if (chunk === "") {
      continue;
    }
    const separator = chunk.indexOf("=");
    const key = safeDecode(separator === -1 ? chunk : chunk.slice(0, separator));
    if (!params.has(key)) {
      params.set(key, safeDecode(separator === -1 ? "" : chunk.slice(separator + 1)));
    }
  }
  let from = parseDayValue(params.get("from") ?? null);
  let to = parseDayValue(params.get("to") ?? null);
  if (from !== null && to !== null && from > to) {
    const swap = from;
    from = to;
    to = swap;
  }
  const pageRaw = Number(params.get("page") ?? "");
  return {
    keyword: parseAuditKeyword(params.get("q") ?? null),
    actorIds: parseAuditIdList(params.get("actor") ?? null),
    actions: parseAuditEnumList(params.get("action") ?? null, AUDIT_ACTIONS),
    objectTypes: parseAuditEnumList(params.get("objectType") ?? null, AUDIT_OBJECT_TYPES),
    results: parseAuditEnumList(params.get("result") ?? null, AUDIT_RESULTS),
    projectIds: parseAuditIdList(params.get("project") ?? null),
    from,
    to,
    page: Number.isInteger(pageRaw) && pageRaw >= 1 ? pageRaw : 1,
  };
}

/** 操作记录页地址（多值参数逗号分隔、去重保序）：缺省（无筛选 + 第 1 页）不落参数（与列表筛选态同一口径）。 */
export function buildAuditHash(query: AuditQueryState): string {
  const parts: string[] = [];
  if (query.keyword !== null) {
    parts.push("q=" + encodeURIComponent(query.keyword));
  }
  if (query.actorIds.length > 0) {
    parts.push("actor=" + query.actorIds.map((id) => encodeURIComponent(id)).join(","));
  }
  if (query.actions.length > 0) {
    parts.push("action=" + query.actions.map((action) => encodeURIComponent(action)).join(","));
  }
  if (query.objectTypes.length > 0) {
    parts.push("objectType=" + query.objectTypes.map((type) => encodeURIComponent(type)).join(","));
  }
  if (query.results.length > 0) {
    parts.push("result=" + query.results.map((result) => encodeURIComponent(result)).join(","));
  }
  if (query.projectIds.length > 0) {
    parts.push("project=" + query.projectIds.map((id) => encodeURIComponent(id)).join(","));
  }
  if (query.from !== null) {
    parts.push("from=" + encodeURIComponent(query.from));
  }
  if (query.to !== null) {
    parts.push("to=" + encodeURIComponent(query.to));
  }
  if (query.page > 1) {
    parts.push("page=" + String(query.page));
  }
  return parts.length === 0 ? AUDIT_BASE_HASH : AUDIT_BASE_HASH + "?" + parts.join("&");
}

/** 更新操作记录页筛选态：同步渲染并写回地址（replace，不新增历史条目）。 */
export function replaceAuditQuery(query: AuditQueryState): void {
  if (currentRoute.kind !== "audit") {
    return;
  }
  currentRoute = { kind: "audit", query };
  emit();
  try {
    window.history.replaceState(null, "", buildAuditHash(query));
  } catch {
    // URL 只是筛选态的投影：写不进去也不影响页面（个别浏览器对 history 调用限流）
  }
}

/** 「文件库」页状态筛选白名单（四档在库状态；回收站栏不吃该参数 —— 固定 filter[status]=recycled，见 FileLibraryPage）。 */
const FILES_STATUS_KEYS: readonly string[] = ["draft", "final", "changed", "archived"];

/**
 * 解析「文件库」页的 query 串（tab=recycled&q=图纸&project=<id>[,<id>…]&status=draft,final&uploadedBy=<id>[,<id>…]&page=2）。
 * id / 关键字 / 枚举的兜底复用操作记录页同一套（trim + 长度兜底 200 / 白名单）；逗号多值逐个校验、去重保序，
 * 不认识的值一律丢弃不报错；status 只在 current 栏解析（recycled 栏恒空，地址里也不落）。
 */
export function parseFilesQuery(search: string): FilesQueryState {
  const params = new Map<string, string>();
  for (const chunk of search.split("&")) {
    if (chunk === "") {
      continue;
    }
    const separator = chunk.indexOf("=");
    const key = safeDecode(separator === -1 ? chunk : chunk.slice(0, separator));
    if (!params.has(key)) {
      params.set(key, safeDecode(separator === -1 ? "" : chunk.slice(separator + 1)));
    }
  }
  const tab: FilesTab = params.get("tab") === "recycled" ? "recycled" : "current";
  const pageRaw = Number(params.get("page") ?? "");
  return {
    tab,
    keyword: parseAuditKeyword(params.get("q") ?? null),
    projectIds: parseAuditIdList(params.get("project") ?? null),
    statuses: tab === "current" ? parseAuditEnumList(params.get("status") ?? null, FILES_STATUS_KEYS) : [],
    uploaderIds: parseAuditIdList(params.get("uploadedBy") ?? null),
    page: Number.isInteger(pageRaw) && pageRaw >= 1 ? pageRaw : 1,
  };
}

/** 逗号分隔的枚举列表（多选筛选用）：逐个过白名单、丢弃非法项、去重保序。 */
function parseAuditEnumList(raw: string | null, allowed: readonly string[]): string[] {
  if (raw === null) {
    return [];
  }
  const out: string[] = [];
  for (const chunk of raw.split(",")) {
    const value = parseAuditEnum(chunk, allowed);
    if (value !== null && !out.includes(value)) {
      out.push(value);
    }
  }
  return out;
}

/** 逗号分隔的 id 列表（多选筛选用）：逐个过 parseAuditId 白名单、丢弃非法项、去重保序。 */
function parseAuditIdList(raw: string | null): string[] {
  if (raw === null) {
    return [];
  }
  const out: string[] = [];
  for (const chunk of raw.split(",")) {
    const id = parseAuditId(chunk);
    if (id !== null && !out.includes(id)) {
      out.push(id);
    }
  }
  return out;
}

/** 「文件库」页地址（多选参数逗号分隔、去重保序）：缺省（current 栏 + 无筛选 + 第 1 页）不落参数；
 *  参数固定序 tab → q → project → status → uploadedBy → page。 */
export function buildFilesHash(query: FilesQueryState): string {
  const parts: string[] = [];
  if (query.tab === "recycled") {
    parts.push("tab=recycled");
  }
  if (query.keyword !== null) {
    parts.push("q=" + encodeURIComponent(query.keyword));
  }
  if (query.projectIds.length > 0) {
    parts.push("project=" + query.projectIds.map((id) => encodeURIComponent(id)).join(","));
  }
  if (query.tab === "current" && query.statuses.length > 0) {
    parts.push("status=" + query.statuses.map((status) => encodeURIComponent(status)).join(","));
  }
  if (query.uploaderIds.length > 0) {
    parts.push("uploadedBy=" + query.uploaderIds.map((id) => encodeURIComponent(id)).join(","));
  }
  if (query.page > 1) {
    parts.push("page=" + String(query.page));
  }
  return parts.length === 0 ? FILES_BASE_HASH : FILES_BASE_HASH + "?" + parts.join("&");
}

/** 更新「文件库」页筛选态：同步渲染并写回地址（replace，不新增历史条目）—— 刷新 / 收藏 / 分享都停在同一栏同一筛选。 */
export function replaceFilesQuery(query: FilesQueryState): void {
  if (currentRoute.kind !== "files") {
    return;
  }
  currentRoute = { kind: "files", query };
  emit();
  try {
    window.history.replaceState(null, "", buildFilesHash(query));
  } catch {
    // URL 只是筛选态的投影：写不进去也不影响页面（个别浏览器对 history 调用限流）
  }
}

function readHash(): string {
  return typeof window === "undefined" ? "" : window.location.hash;
}

/** 裸根地址（无 hash —— 登录回跳的 `/`、直输域名；或只有 `#`）：Push 285 起 = 登录默认入口，落项目空间。 */
function isBareRootHash(hash: string): boolean {
  return hash === "" || hash === "#";
}

/**
 * 初始路由：URL 未携带列表参数时，用本地记忆恢复上次筛选选择（A1-18，URL 优先、本地次之）。
 * 恢复出的选择由下方初始化代码同步回地址栏（replace），与「URL 是筛选态唯一来源」的口径一致。
 *
 * Push 285（业务口径 2026-10-12「登录后默认进入项目空间」）：裸根地址的默认页从蓝图页改为**项目空间** ——
 * 初始化时把地址规范化成列表地址（`#/projects`；有本地筛选记忆时带记忆参数）；`#/`（显式）仍是蓝图页。
 */
function resolveInitialRoute(): { route: Route; restored: boolean; normalized: boolean } {
  const hash = window.location.hash;
  const bareRoot = isBareRootHash(hash);
  const parsed = parseHash(hash);
  if (parsed.kind !== "list" || buildListHash(parsed.filters) !== LIST_BASE_HASH) {
    return { route: parsed, restored: false, normalized: false };
  }
  const stored = readStoredFilters();
  if (stored === null) {
    // 裸根默认入口：没有记忆也把地址规范化成列表地址（地址即状态）
    return { route: parsed, restored: false, normalized: bareRoot };
  }
  const restoredFilters: ListQueryState = { ...stored, q: "" };
  if (buildListHash(restoredFilters) === LIST_BASE_HASH) {
    // 记忆里是「无筛选」视图（用户上次重置过）：与默认视图一致，无需恢复
    return { route: parsed, restored: false, normalized: bareRoot };
  }
  return { route: { kind: "list", filters: restoredFilters }, restored: true, normalized: false };
}

const initial =
  typeof window === "undefined"
    ? { route: { kind: "list", filters: EMPTY_LIST_QUERY } as Route, restored: false, normalized: false }
    : resolveInitialRoute();
let currentRoute: Route = initial.route;
/** 进入详情页时所处列表页的地址（含筛选态）：顶栏与返回按钮据此还原列表页。 */
let listReturnHash: string | null = null;
let cameFromList = false;
let retryTimer: number | null = null;
let installed = false;
const listeners = new Set<() => void>();

// 初始化时把从本地记忆恢复出的筛选态、或裸根默认入口规范化出的列表地址写回地址栏（replace，不产生历史条目）
if (initial.restored || initial.normalized) {
  flushHash();
}

function emit(): void {
  for (const listener of listeners) {
    listener();
  }
}

function applyHash(hash: string): void {
  const fromList = currentRoute.kind === "list";
  const next = parseHash(hash);
  cameFromList = next.kind === "project" && fromList;
  currentRoute = next;
  emit();
}

function handleHashChange(): void {
  applyHash(readHash());
}

/** 把当前列表筛选态写回地址栏：replaceState 不产生历史条目、也不触发 hashchange。 */
function flushHash(): void {
  if (currentRoute.kind !== "list") {
    return;
  }
  const hash = buildListHash(currentRoute.filters);
  try {
    window.history.replaceState(null, "", hash);
    if (retryTimer !== null) {
      window.clearTimeout(retryTimer);
      retryTimer = null;
    }
  } catch {
    // 个别浏览器对 history 调用限流（如 Safari）；URL 只是筛选态的投影，内存状态不受影响，稍后重试一次
    if (retryTimer === null) {
      retryTimer = window.setTimeout(() => {
        retryTimer = null;
        flushHash();
      }, 400);
    }
  }
}

function subscribe(listener: () => void): () => void {
  if (!installed) {
    installed = true;
    window.addEventListener("hashchange", handleHashChange);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): Route {
  return currentRoute;
}

export function useHashRoute(): Route {
  return useSyncExternalStore(subscribe, getSnapshot);
}

/** 初始加载是否由本地记忆恢复而来（项目空间列表据此区分「书签入口」与「带参数链接」两种初始态）。 */
export function initialRouteRestored(): boolean {
  return initial.restored;
}

/** 更新筛选态：同步渲染并写入 URL（replace，不新增历史条目）。 */
export function replaceListQuery(filters: ListQueryState): void {
  currentRoute = { kind: "list", filters };
  emit();
  flushHash();
}

export function openProject(id: string): void {
  listReturnHash = currentRoute.kind === "list" ? buildListHash(currentRoute.filters) : null;
  cameFromList = false;
  // 从列表进入详情固定落在缺省标签「项目总览」（地址不带 ?view=）
  window.location.hash = projectViewHref(id, "overview").slice(1);
}

/** 顶栏 logo 与「项目空间」的落点：列表页原地不动（保留筛选态），详情页回到进入前的列表地址。 */
export function listHref(): string {
  return currentRoute.kind === "list" ? buildListHash(currentRoute.filters) : listReturnHash ?? LIST_BASE_HASH;
}

/** 返回项目列表：优先回退历史（保留进入前的筛选态），其次跳到记录下来的列表地址。 */
export function goBackToList(): void {
  if (currentRoute.kind === "list") {
    return;
  }
  if (cameFromList) {
    cameFromList = false;
    window.history.back();
    return;
  }
  window.location.hash = (listReturnHash ?? LIST_BASE_HASH).slice(1);
}

/** 上一层地址：详情 → 列表（含筛选态）；列表 / 占位页 → 蓝图页；蓝图页 → 蓝图页。 */
export function upLevelHref(): string {
  if (currentRoute.kind === "list") {
    return HUB_HASH;
  }
  if (currentRoute.kind === "project") {
    return listHref();
  }
  return HUB_HASH;
}

/** 上一层导航（顶栏 logo）：详情沿用「优先浏览器后退」以保留进入前的筛选态。 */
export function goUpLevel(): void {
  if (currentRoute.kind === "project") {
    goBackToList();
    return;
  }
  if (currentRoute.kind === "hub") {
    return;
  }
  // 其余页面（列表 / 任务模板 / 工作台 / 操作记录 / 文件库）的上一层 = 蓝图页（#/）
  window.location.hash = "/";
}
