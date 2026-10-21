/**
 * 用户偏好（A4 / A24）：GET / PATCH /api/v1/users/me/preferences。
 * 声明键：taskTableHiddenColumns（A4 列显隐）/ homeSavedFilters（A24 常用筛选）/ workspaceOpenProjects（A31 工作台折叠面板展开态 · Push 233）/ myPlanBoard（「我的计划」便签墙 · Push 268）/ backgroundTier（背景档位 · Push 291）/ cardWatermark（卡片水印 · Push 292）/ locale（界面语言 · Push 296）/ hubView（仪表盘页常驻视图 · Push 332）/ hubDashProject（仪表盘常驻项目 · Push 336）/ hubDashView（仪表盘页内图表视图 · Push 345）。
 * （focusMode「A4 醒目模式 · Push 171」已随 Push 290「醒目模式下架、观感统一走背景档位」停用：前端不再读写，服务端键保留不动。）
 * 常用筛选（A24）自 Push 169 起按账号存服务端（user_preferences.prefs.homeSavedFilters）——
 * 同一账号换设备可见；同一设备换账号互不可见（服务端按会话 actorId 隔离，路径不接受用户 id）。
 * 契约 shared/src/modules/users.ts：PATCH 为合并语义（只传变更键、数组键整体替换）。
 */
import { apiRequest, apiSend } from "./api";
import type { BackgroundTier } from "./backgroundTier";
import type { Locale } from "./i18n";
import type { HubDashView } from "./data/dashboardProgress";
import type { HubView } from "./useHashRoute";
import { clearLegacySavedFilters, readLegacySavedFilters } from "./savedFilters";
import type { SavedFilter } from "./savedFilters";
import type { PlanBoardBgId, PlanNote } from "./myPlan";

/** 工作台折叠面板展开态（A31 · Push 233 · 业务口径「这个下拉要有记忆」）：tasks / raised 两枚已展开的项目 id 列表（整体替换语义；默认两空数组 = 全部收起）。 */
export type WorkspaceOpenProjects = {
  tasks: string[];
  raised: string[];
};

/** 「我的计划」便签墙（Push 268）：按账号存 prefs.myPlanBoard；PATCH 只传 notes / categories / bg（Push 271 起），updatedAt 由服务端盖章（从未保存 = null）。 */
export type MyPlanBoardPrefs = {
  notes: PlanNote[];
  categories: string[];
  /** 背景色（Push 271）：white = 与全站页面统一（默认）；cream = MiniMemo 奶白；读侧白名单外收敛为 white。 */
  bg: PlanBoardBgId;
  updatedAt: string | null;
};

/** 偏好全量（与契约 UserPreferences 同形；`updatedAt` = 尚未保存过时 null）。 */
export type UserPreferences = {
  taskTableHiddenColumns: string[];
  homeSavedFilters: SavedFilter[];
  /** 工作台折叠面板展开态（A31 · Push 233）：按标签记住已展开的项目 id；默认两空数组 = 全部收起。 */
  workspaceOpenProjects: WorkspaceOpenProjects;
  /** 「我的计划」便签墙（Push 268）：整面便签墙按账号存；从未保存 = updatedAt null（前端据此预置示例 / 迁移旧键）。 */
  myPlanBoard: MyPlanBoardPrefs;
  revisions: Record<string, number>;
  /** 背景档位（Push 291 · 业务口径「当前背景选择后刷新就没了 要按账号记住」）：顶栏「背景 · 档位」按账号存 —— 刷新 / 换设备同账号保持；Push 313 起默认 medium（适中）。 */
  backgroundTier: BackgroundTier;
  /** 卡片水印（Push 292 · 业务口径「增加一个水印选项 可以选择是否要水印」）：项目卡片右下角国家名水印按账号存；Push 313 起默认 false（无水印）。 */
  cardWatermark: boolean;
  /** 界面语言（Push 296 · 业务口径「按账号记住 刷新不会回中文」）：顶栏「语言 · 中文 / English」按账号存 —— 刷新 / 换设备同账号保持；默认 zh。 */
  locale: Locale;
  /** 仪表盘页常驻视图（Push 332 · 业务口径「还是做路由吧 这个页面要记住 因为不同的人想常驻的页面可能不一样」）：地址不带 `?view=` 时本页落在哪个视图 —— 刷新 / 换设备同账号保持；默认 map。 */
  hubView: HubView;
  /** 仪表盘常驻项目（Push 336 · 业务口径「选择的项目也要记住 不随刷新变动而回到全部项目」）：按账号记住选中的项目 id；null = 全部项目（默认）。 */
  hubDashProject: string | null;
  /** 仪表盘页内图表视图（Push 345 · 业务口径 2026-10-16「选择后刷新不变 按账号记住」；Push 353 加词频图、Push 358 加数据总览）：overview = 「数据总览」/ progress = 「项目进度」（默认）/ status = 「任务状态」/ issues = 「问题」/ delivery = 「交付时间」/ wordcloud = 「词频图」—— 刷新 / 换设备同账号保持。 */
  hubDashView: HubDashView;
  updatedAt: string | null;
};

/** 读取当前账号的偏好（无记录 = 默认值 + updatedAt null；401 由 apiRequest 统一跳登录）。 */
export function loadMyPreferences(): Promise<UserPreferences> {
  return apiRequest<UserPreferences>("/api/v1/users/me/preferences");
}

/** 常用筛选整体替换（PATCH 只带这一个键）：返回服务端收敛后的全量偏好，前端以返回值覆盖本地。 */
export function saveHomeSavedFilters(items: SavedFilter[], revision: number): Promise<UserPreferences> {
  return apiSend<UserPreferences>("/api/v1/users/me/preferences", "PATCH", { homeSavedFilters: items, expectedRevisions: { homeSavedFilters: revision } });
}

/** 任务表列显隐整体替换（A4 · Push 170）：只传这一个键，返回服务端收敛后的全量偏好。 */
export function saveTaskTableHiddenColumns(keys: string[]): Promise<UserPreferences> {
  return apiSend<UserPreferences>("/api/v1/users/me/preferences", "PATCH", { taskTableHiddenColumns: keys });
}

/** 工作台折叠面板展开态（A31 · Push 233 · 业务口径「这个下拉要有记忆」）单键 PATCH：整体替换两标签的项目 id 列表。 */
export function saveWorkspaceOpenProjects(value: WorkspaceOpenProjects): Promise<UserPreferences> {
  return apiSend<UserPreferences>("/api/v1/users/me/preferences", "PATCH", { workspaceOpenProjects: value });
}

/** 「我的计划」便签墙整体替换（Push 268 · 业务口径「数据接入数据库」；Push 271 起带上 bg 背景色）：只传这一个键（notes / categories / bg），返回服务端收敛 + 盖章后的全量偏好。 */
export function saveMyPlanBoard(board: { notes: PlanNote[]; categories: string[]; bg: PlanBoardBgId }, revision: number): Promise<UserPreferences> {
  return apiSend<UserPreferences>("/api/v1/users/me/preferences", "PATCH", { myPlanBoard: board, expectedRevisions: { myPlanBoard: revision } });
}

/** 背景档位单键 PATCH（Push 291 · 业务口径「当前背景选择后刷新就没了 要按账号记住」）：只传这一个键，返回服务端收敛后的全量偏好。 */
export function saveBackgroundTier(tier: BackgroundTier): Promise<UserPreferences> {
  return apiSend<UserPreferences>("/api/v1/users/me/preferences", "PATCH", { backgroundTier: tier });
}

/** 卡片水印开关单键 PATCH（Push 292 · 业务口径「增加一个水印选项 可以选择是否要水印」）：只传这一个键，返回服务端收敛后的全量偏好。 */
export function saveCardWatermark(value: boolean): Promise<UserPreferences> {
  return apiSend<UserPreferences>("/api/v1/users/me/preferences", "PATCH", { cardWatermark: value });
}

/** 仪表盘页常驻视图单键 PATCH（Push 332 · 业务口径「这个页面要记住 因为不同的人想常驻的页面可能不一样」）：只传这一个键，返回服务端收敛后的全量偏好。 */
export function saveHubView(view: HubView): Promise<UserPreferences> {
  return apiSend<UserPreferences>("/api/v1/users/me/preferences", "PATCH", { hubView: view });
}

/** 仪表盘常驻项目单键 PATCH（Push 336 · 业务口径「选择的项目也要记住 不随刷新变动而回到全部项目」）：只传这一个键，null = 回全部项目；返回服务端收敛后的全量偏好。 */
export function saveHubDashProject(projectId: string | null): Promise<UserPreferences> {
  return apiSend<UserPreferences>("/api/v1/users/me/preferences", "PATCH", { hubDashProject: projectId });
}

/** 仪表盘页内图表视图单键 PATCH（Push 345 · 业务口径 2026-10-16「选择后刷新不变 按账号记住」）：只传这一个键，返回服务端收敛后的全量偏好。 */
export function saveHubDashView(view: HubDashView): Promise<UserPreferences> {
  return apiSend<UserPreferences>("/api/v1/users/me/preferences", "PATCH", { hubDashView: view });
}

/** 界面语言单键 PATCH（Push 296 · 业务口径「按账号记住 刷新不会回中文」）：只传这一个键，返回服务端收敛后的全量偏好。 */
export function saveLocale(locale: Locale): Promise<UserPreferences> {
  return apiSend<UserPreferences>("/api/v1/users/me/preferences", "PATCH", { locale });
}

/**
 * 登录后取偏好（含 Push 169 一次性迁移）：服务端为空 + 本机仍有 Push 138–168 的 localStorage 旧键
 * （libiaolink.home.savedFilters.v1）时，把本机组合整体推上云，成功后再清本机键（老用户不丢数据）。
 * - 服务端已有值：以账号为准，本机旧键直接清掉（避免下次误复活旧组合）。
 * - 迁移失败：本次用本机组合兜底展示（键保留，下次登录自动重试），不因偏好失败阻塞页面。
 */
export async function loadMyPreferencesWithLegacyMigration(): Promise<UserPreferences> {
  const prefs = await loadMyPreferences();
  if (prefs.homeSavedFilters.length > 0) {
    clearLegacySavedFilters();
    return prefs;
  }
  const legacy = readLegacySavedFilters();
  if (legacy.length === 0) {
    clearLegacySavedFilters();
    return prefs;
  }
  try {
    const migrated = await saveHomeSavedFilters(legacy, prefs.revisions?.homeSavedFilters ?? 0);
    clearLegacySavedFilters();
    return migrated;
  } catch {
    return await loadMyPreferences().catch(() => ({ ...prefs, homeSavedFilters: legacy }));
  }
}
