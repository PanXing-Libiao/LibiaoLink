import { Injectable } from "@nestjs/common";
import { AppError } from "../../common/errors/app-error.js";
import { BACKGROUND_TIER_IDS, HUB_DASH_PROJECT_MAX_LENGTH, HUB_DASH_VIEW_IDS, HUB_VIEW_IDS, LOCALE_IDS, PLAN_BOARD_BG_IDS, PLAN_BOARD_CATEGORY_LIMIT, PLAN_BOARD_CATEGORY_NAME_MAX, PLAN_BOARD_COLOR_IDS, PLAN_BOARD_CONTENT_MAX, PLAN_BOARD_FONT_IDS, PLAN_BOARD_NOTE_LIMIT, PLAN_BOARD_TITLE_MAX, SAVED_HOME_FILTER_LIMIT, TASK_TABLE_COLUMN_KEYS, type BackgroundTier, type HubDashView, type HubView, type Locale, type MyPlanBoard, type MyPlanNote, type PlanBoardBg, type SavedHomeFilter, type TaskTableColumnKey, type UserPreferences, type UserPreferencesUpdateBody, type WorkspaceOpenProjects } from "@libiaolink/contracts";
import { UserPreferenceRepository } from "./user-preference.repository.js";
import type { UserPreferenceRow } from "./user-preference.repository.js";

type PrefsRecord = Record<string, unknown>;

/** 读侧规范化：jsonb 是自由对象（手工 / 旧版本写入都可能存在），声明键一律按契约形状收敛，坏数据丢弃不抛错。 */
function stringArrayOf(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const result: string[] = [];
  for (const item of value) {
    if (typeof item === "string" && item !== "" && !result.includes(item)) {
      result.push(item);
    }
  }
  return result;
}

/** 任务表列 key 白名单（契约 `TaskTableColumnKey`）：jsonb 里可能残留旧版本 / 手改的 key，读侧一律丢弃。 */
const COLUMN_KEY_SET: ReadonlySet<TaskTableColumnKey> = new Set(TASK_TABLE_COLUMN_KEYS);

function isColumnKey(value: unknown): value is TaskTableColumnKey {
  return typeof value === "string" && COLUMN_KEY_SET.has(value as TaskTableColumnKey);
}

/** 隐藏列 key 列表：只留白名单内、去重（顺序保持写入顺序，界面按表头顺序渲染不受影响）。 */
function columnKeysOf(value: unknown): TaskTableColumnKey[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const result: TaskTableColumnKey[] = [];
  for (const item of value) {
    if (isColumnKey(item) && !result.includes(item)) {
      result.push(item);
    }
  }
  return result;
}

function savedFiltersOf(value: unknown): SavedHomeFilter[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const result: SavedHomeFilter[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) {
      continue;
    }
    const record = item as Record<string, unknown>;
    const id = typeof record.id === "string" && record.id !== "" ? record.id : null;
    const name = typeof record.name === "string" ? record.name.slice(0, 20) : "";
    if (id === null || name === "" || result.some((existing) => existing.id === id)) {
      continue;
    }
    result.push({
      id,
      name,
      regions: stringArrayOf(record.regions),
      projectTypes: stringArrayOf(record.projectTypes),
      managerIds: stringArrayOf(record.managerIds),
      timeFrom: dayOf(record.timeFrom),
      timeTo: dayOf(record.timeTo),
    });
    if (result.length >= SAVED_HOME_FILTER_LIMIT) {
      break;
    }
  }
  return result;
}

/** 布尔偏好（醒目模式 · §6.13）：jsonb 是自由对象，只认严格布尔，字符串 / 数字 / 缺失一律回默认 false（不抛错）。 */
function booleanOf(value: unknown): boolean {
  return value === true;
}

/** 背景档位（Push 291 · 业务口径 2026-10-13「当前背景选择后刷新就没了 要按账号记住」；Push 313 起默认 medium · 业务口径 2026-10-14「把系统当前所有人的背景改成适中 无水印 这个设成默认的」）：jsonb 里白名单外（simple / medium / vivid 之外）/ 缺省一律回默认 medium（不抛错）。 */
const BACKGROUND_TIER_SET: ReadonlySet<string> = new Set(BACKGROUND_TIER_IDS);

function backgroundTierOf(value: unknown): BackgroundTier {
  return typeof value === "string" && BACKGROUND_TIER_SET.has(value) ? (value as BackgroundTier) : "medium";
}

/** 卡片水印（Push 292 · 业务口径 2026-10-13「增加一个水印选项 可以选择是否要水印」；Push 313 起默认 false · 业务口径 2026-10-14「把系统当前所有人的背景改成适中 无水印 这个设成默认的」）：默认 false（没存过 = 无水印）；只有严格 true 开启，其余（缺省 / 非布尔）一律回 false。 */
function cardWatermarkOf(value: unknown): boolean {
  return value === true;
}

/** 界面语言（Push 296 · 业务口径 2026-10-13「现在我要做系统语言切换 暂时中英文」）：jsonb 里白名单外（zh / en 之外）/ 缺省一律回默认 zh（不抛错）。 */
const LOCALE_SET: ReadonlySet<string> = new Set(LOCALE_IDS);

function localeOf(value: unknown): Locale {
  return typeof value === "string" && LOCALE_SET.has(value) ? (value as Locale) : "zh";
}

/** 仪表盘页常驻视图（Push 332 · 业务口径 2026-10-15「还是做路由吧 这个页面要记住 因为不同的人想常驻的页面可能不一样」）：jsonb 里白名单外（map / dashboard 之外）/ 缺省一律回默认 map（不抛错）。 */
const HUB_VIEW_SET: ReadonlySet<string> = new Set(HUB_VIEW_IDS);

function hubViewOf(value: unknown): HubView {
  return typeof value === "string" && HUB_VIEW_SET.has(value) ? (value as HubView) : "map";
}

/** 仪表盘常驻项目（Push 336 · 业务口径 2026-10-15「选择的项目也要记住 不随刷新变动而回到全部项目」）：jsonb 里非字符串 / 空串 / 超长一律回 null（= 全部项目，不抛错）。 */
function hubDashProjectOf(value: unknown): string | null {
  return typeof value === "string" && value !== "" && value.length <= HUB_DASH_PROJECT_MAX_LENGTH ? value : null;
}

/** 仪表盘页内图表视图（Push 345 · 业务口径 2026-10-16「选择后刷新不变 按账号记住」；Push 353 加「词频图」、Push 358 加「数据总览」）：jsonb 里白名单外（overview / progress / status / issues / delivery / wordcloud 之外）/ 缺省一律回默认 progress（不抛错）。 */
const HUB_DASH_VIEW_SET: ReadonlySet<string> = new Set(HUB_DASH_VIEW_IDS);

function hubDashViewOf(value: unknown): HubDashView {
  return typeof value === "string" && HUB_DASH_VIEW_SET.has(value) ? (value as HubDashView) : "progress";
}

/** 工作台展开态（A31 · Push 233）：`{ tasks, raised }` 两个项目 id 列表；jsonb 里非对象 / 数组内非字符串项一律收敛（不抛错）。 */
function openProjectsOf(value: unknown): WorkspaceOpenProjects {
  const record = typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  return { tasks: stringArrayOf(record["tasks"]), raised: stringArrayOf(record["raised"]) };
}

/** 便签颜色 / 字体白名单（契约 PlanBoardColorSchema / PlanBoardFontSchema）：jsonb 里旧值 / 手改值一律回落缺省。 */
const PLAN_COLOR_SET: ReadonlySet<string> = new Set(PLAN_BOARD_COLOR_IDS);
const PLAN_FONT_SET: ReadonlySet<string> = new Set(PLAN_BOARD_FONT_IDS);

function isoTimeOf(value: unknown): string | null {
  return typeof value === "string" && value !== "" && !Number.isNaN(Date.parse(value)) ? value : null;
}

function isPlanColor(value: unknown): value is MyPlanNote["colorId"] {
  return typeof value === "string" && PLAN_COLOR_SET.has(value);
}

function isPlanFont(value: unknown): value is MyPlanNote["fontId"] {
  return typeof value === "string" && PLAN_FONT_SET.has(value);
}

/** 「我的计划」单条（Push 268）：与前端 myPlan.ts sanitize 同口径 —— 字段缺失 / 类型不符即整条丢弃（不半读半写）。 */
function planNoteOf(value: unknown): MyPlanNote | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const id = typeof record.id === "string" && record.id !== "" && record.id.length <= 64 ? record.id : null;
  const title = typeof record.title === "string" ? record.title.slice(0, PLAN_BOARD_TITLE_MAX) : null;
  const content = typeof record.content === "string" ? record.content.slice(0, PLAN_BOARD_CONTENT_MAX) : null;
  const category = typeof record.category === "string" ? record.category.trim().slice(0, PLAN_BOARD_CATEGORY_NAME_MAX) : null;
  const createdAt = isoTimeOf(record.createdAt);
  const updatedAt = isoTimeOf(record.updatedAt);
  if (id === null || title === null || content === null || category === null || category === "" || createdAt === null || updatedAt === null) {
    return null;
  }
  if (title === "" && content === "") {
    return null;
  }
  return {
    id,
    title,
    content,
    category,
    colorId: isPlanColor(record.colorId) ? record.colorId : "white",
    fontId: isPlanFont(record.fontId) ? record.fontId : "sans",
    done: booleanOf(record.done),
    createdAt,
    updatedAt,
  };
}

/** 便签墙背景色（Push 271）：白名单（PLAN_BOARD_BG_IDS）外 / 缺省 → null（调用方决定回落 white）。 */
function planBoardBgOf(value: unknown): PlanBoardBg | null {
  return typeof value === "string" && (PLAN_BOARD_BG_IDS as readonly string[]).includes(value) ? (value as PlanBoardBg) : null;
}

/** 便签墙（Push 268）：单条逐条收敛（非法整条丢弃、id 去重、≤ 300 条）；分类表去空 / 去重 / 截断；背景色白名单外 → white；updatedAt 非法 → null。 */
function planBoardOf(value: unknown): MyPlanBoard {
  const record = typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const notes: MyPlanNote[] = [];
  if (Array.isArray(record["notes"])) {
    for (const item of record["notes"]) {
      const note = planNoteOf(item);
      if (note !== null && !notes.some((existing) => existing.id === note.id)) {
        notes.push(note);
      }
      if (notes.length >= PLAN_BOARD_NOTE_LIMIT) {
        break;
      }
    }
  }
  const categories: string[] = [];
  if (Array.isArray(record["categories"])) {
    for (const item of record["categories"]) {
      if (typeof item !== "string") {
        continue;
      }
      const name = item.trim().slice(0, PLAN_BOARD_CATEGORY_NAME_MAX);
      if (name !== "" && !categories.includes(name)) {
        categories.push(name);
      }
      if (categories.length >= PLAN_BOARD_CATEGORY_LIMIT) {
        break;
      }
    }
  }
  return { notes, categories, bg: planBoardBgOf(record["bg"]) ?? "white", updatedAt: isoTimeOf(record["updatedAt"]) };
}

const DAY_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function dayOf(value: unknown): string | null {
  return typeof value === "string" && DAY_ONLY.test(value) ? value : null;
}

/**
 * 用户级 UI 偏好用例（A4 / A24）：声明键 = taskTableHiddenColumns / homeSavedFilters / focusMode（§6.13 醒目模式 · Push 171）/ workspaceOpenProjects（A31 工作台展开态 · Push 233）/ myPlanBoard（「我的计划」便签墙 · Push 268）/ backgroundTier（背景档位 · Push 291）/ cardWatermark（卡片水印 · Push 292）/ locale（界面语言 · Push 296）/ hubView（仪表盘页常驻视图 · Push 332）/ hubDashProject（仪表盘常驻项目 · Push 336）/ hubDashView（仪表盘页内图表视图 · Push 345）；
 * GET 返回契约全量形状（无行 = 默认值 + updatedAt null）；
 * PATCH 合并语义 —— 只传变更键、数组键整体替换、未声明键原样保存（前向兼容，不必为新偏好键改契约）。
 * 偏好不写审计；事务内合并，多窗口整板/组合写入必须比较对应键的版本。
 */
@Injectable()
export class UserPreferenceService {
  constructor(private readonly preferences: UserPreferenceRepository) {}

  async get(userId: string): Promise<UserPreferences> {
    return this.toContract(await this.preferences.find(userId));
  }

  async update(userId: string, body: UserPreferencesUpdateBody, at: Date = new Date()): Promise<UserPreferences> {
    if (Object.prototype.hasOwnProperty.call(body, "_revisions")) throw new AppError("VALIDATION_FAILED", "服务端版本元数据不可写入");
    const row = await this.preferences.mutate(userId, (current) => {
      const { expectedRevisions, ...patch } = body;
      const revisions = revisionRecord(current["_revisions"]);
      for (const key of ["homeSavedFilters", "myPlanBoard"] as const) {
        if (patch[key] === undefined) continue;
        if (expectedRevisions?.[key] === undefined) throw new AppError("VALIDATION_FAILED", "保存需要偏好基线版本，请重新打开页面");
        if (expectedRevisions[key] !== (revisions[key] ?? 0)) throw new AppError("VERSION_CONFLICT", "另一个窗口已修改这些内容，未保存的改动仍保留，请核对后再保存");
      }
      const next: PrefsRecord = { ...current, ...patch };
      delete next["expectedRevisions"];
      for (const key of Object.keys(patch)) revisions[key] = (revisions[key] ?? 0) + 1;
      next["_revisions"] = revisions;
      if (body.myPlanBoard !== undefined) {
        const previous = planBoardOf(current["myPlanBoard"]);
        next["myPlanBoard"] = { ...body.myPlanBoard, bg: body.myPlanBoard.bg ?? previous.bg, updatedAt: at.toISOString() };
      }
      return next;
    }, at);
    return this.toContract(row);
  }

  /** 行 → 契约：声明键按形状收敛，updatedAt 由写入时间给出（无行 = null）。 */
  private toContract(row: UserPreferenceRow | null): UserPreferences {
    const prefs: PrefsRecord = row?.prefs ?? {};
    return {
      taskTableHiddenColumns: columnKeysOf(prefs["taskTableHiddenColumns"]),
      homeSavedFilters: savedFiltersOf(prefs["homeSavedFilters"]),
      focusMode: booleanOf(prefs["focusMode"]),
      workspaceOpenProjects: openProjectsOf(prefs["workspaceOpenProjects"]),
      myPlanBoard: planBoardOf(prefs["myPlanBoard"]),
      revisions: revisionRecord(prefs["_revisions"]),
      backgroundTier: backgroundTierOf(prefs["backgroundTier"]),
      cardWatermark: cardWatermarkOf(prefs["cardWatermark"]),
      locale: localeOf(prefs["locale"]),
      hubView: hubViewOf(prefs["hubView"]),
      hubDashProject: hubDashProjectOf(prefs["hubDashProject"]),
      hubDashView: hubDashViewOf(prefs["hubDashView"]),
      updatedAt: row === null ? null : row.updatedAt.toISOString(),
    };
  }
}

function revisionRecord(value: unknown): Record<string, number> {
  const result = Object.create(null) as Record<string, number>;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return result;
  for (const [key, revision] of Object.entries(value)) if (typeof revision === "number" && Number.isSafeInteger(revision) && revision >= 0) result[key] = revision;
  return result;
}
