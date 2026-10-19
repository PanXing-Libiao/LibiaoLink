/**
 * 用户偏好（A4 / A24 · Push 169；A4 列显隐白名单 · Push 170；A31 工作台展开态 · Push 233；「我的计划」便签墙 · Push 268；便签墙背景色 bg · Push 271；背景档位 backgroundTier · Push 291；卡片水印 cardWatermark · Push 292；界面语言 locale · Push 296；仪表盘页常驻视图 hubView · Push 332；仪表盘常驻项目 hubDashProject · Push 336；仪表盘页内图表视图 hubDashView · Push 345；Push 358 加 overview）回归：无行默认值、PATCH 合并语义（只传变更键 / 数组整体替换 /
 * 未声明键保留）、读侧规范化（jsonb 是自由对象，脏数据一律收敛不抛错）、契约上限（≤ 20 组 / 名称 ≤ 20 字）、
 * 任务表列 key 白名单（未知 key 400 + 与前端 `TABLE_COLUMNS` 同源）、工作台展开态形状与收敛、便签墙形状 / 收敛 / 服务端盖章、背景档位枚举与读侧收敛、卡片水印布尔与读侧收敛、界面语言枚举与读侧收敛。
 * 不连库：仓储用内存替身（与 admin-audit.test.ts 同口径）；契约 schema 直接解析校验。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { HUB_DASH_PROJECT_MAX_LENGTH, PLAN_BOARD_CATEGORY_LIMIT, PLAN_BOARD_NOTE_LIMIT, SAVED_HOME_FILTER_LIMIT, TASK_TABLE_COLUMN_KEYS, UserPreferencesUpdateBodySchema, WORKSPACE_OPEN_PROJECTS_LIMIT } from "@libiaolink/contracts";
import type { MyPlanNote } from "@libiaolink/contracts";
import type { SavedHomeFilter } from "@libiaolink/contracts";
import { UserPreferenceService } from "../src/modules/identity/user-preference.service.js";
import type { UserPreferenceRepository, UserPreferenceRow } from "../src/modules/identity/user-preference.repository.js";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const PROJECT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PROJECT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const AT = new Date("2026-09-23T04:00:00.000Z");

class FakePreferenceRepository {
  rows = new Map<string, UserPreferenceRow>();
  async find(userId: string): Promise<UserPreferenceRow | null> {
    return this.rows.get(userId) ?? null;
  }
  private chain: Promise<unknown> = Promise.resolve();
  mutate(userId: string, update: (current: Record<string, unknown>) => Record<string, unknown>, at: Date): Promise<UserPreferenceRow> {
    const operation = this.chain.then(async () => this.upsert(userId, update(this.rows.get(userId)?.prefs ?? {}), at));
    this.chain = operation.catch(() => {});
    return operation;
  }
  async upsert(userId: string, prefs: Record<string, unknown>, at: Date): Promise<UserPreferenceRow> {
    const row = { userId, prefs, updatedAt: at } as UserPreferenceRow;
    this.rows.set(userId, row);
    return row;
  }
}

function makeService(): { service: UserPreferenceService; repo: FakePreferenceRepository } {
  const repo = new FakePreferenceRepository();
  return { service: new UserPreferenceService(repo as unknown as UserPreferenceRepository), repo };
}

/**
 * 白名单与前端任务表列**同源**（契约承诺「与前端 TABLE_COLUMNS 一致」）：直接读前端源码抽取非锁定列 key。
 * 前端这份没有测试基建，故把守卫放在 server 测试里（比注释更强：改一边漏另一边会红）。
 */
function frontendColumnKeys(): string[] {
  const source = readFileSync(fileURLToPath(new URL("../../frontend/src/components/TaskBoard.tsx", import.meta.url)), "utf8");
  const start = source.indexOf("export const TABLE_COLUMNS");
  if (start < 0) {
    throw new Error("未找到前端 TABLE_COLUMNS（文件被改名？同步更新本守卫）");
  }
  const block = source.slice(start, source.indexOf("];", start));
  const keys: string[] = [];
  for (const match of block.matchAll(/\{\s*key:\s*"([a-zA-Z]+)"([^}]*)\}/g)) {
    const body = match[2] ?? "";
    if (!body.includes("locked: true")) {
      keys.push(match[1] ?? "");
    }
  }
  return keys;
}

function filterOf(index: number, name?: string): SavedHomeFilter {
  return {
    id: "sf-" + String(index),
    name: name ?? "组合" + String(index),
    regions: ["华东"],
    projectTypes: [],
    managerIds: [],
    timeFrom: null,
    timeTo: null,
  };
}

describe("用户偏好（A4 / A24）", () => {
  it("无行：返回契约默认值 + updatedAt null", async () => {
    const { service } = makeService();
    expect(await service.get(USER_ID)).toEqual({ taskTableHiddenColumns: [], homeSavedFilters: [], focusMode: false, workspaceOpenProjects: { tasks: [], raised: [] }, myPlanBoard: { notes: [], categories: [], bg: "white", updatedAt: null }, revisions: {}, backgroundTier: "medium", cardWatermark: false, locale: "zh", hubView: "map", hubDashProject: null, hubDashView: "progress", updatedAt: null });
  });

  it("首次 PATCH 只传 homeSavedFilters：数组整体落库，updatedAt 为写入时间", async () => {
    const { service, repo } = makeService();
    const prefs = await service.update(USER_ID, { homeSavedFilters: [filterOf(1)], expectedRevisions: { homeSavedFilters: 0 } }, AT);
    expect(prefs.homeSavedFilters).toEqual([filterOf(1)]);
    expect(prefs.taskTableHiddenColumns).toEqual([]);
    expect(prefs.updatedAt).toBe(AT.toISOString());
    expect(repo.rows.get(USER_ID)?.prefs).toMatchObject({ homeSavedFilters: [filterOf(1)] });
  });

  it("合并语义：只传变更键 —— 未传的声明键保持原值，数组键整体替换", async () => {
    const { service } = makeService();
    await service.update(USER_ID, { taskTableHiddenColumns: ["owner", "due"], homeSavedFilters: [filterOf(1), filterOf(2)], expectedRevisions: { homeSavedFilters: 0 } }, AT);
    const after = await service.update(USER_ID, { homeSavedFilters: [filterOf(3)], expectedRevisions: { homeSavedFilters: 1 } }, AT);
    expect(after.taskTableHiddenColumns).toEqual(["owner", "due"]);
    expect(after.homeSavedFilters).toEqual([filterOf(3)]);
  });

  it("未声明键原样保存（前向兼容）：后续 PATCH 不会把它冲掉", async () => {
    const { service, repo } = makeService();
    await service.update(USER_ID, { sidebarOpen: false } as unknown as { homeSavedFilters?: SavedHomeFilter[] }, AT);
    await service.update(USER_ID, { homeSavedFilters: [filterOf(4)], expectedRevisions: { homeSavedFilters: 0 } }, AT);
    expect(repo.rows.get(USER_ID)?.prefs).toMatchObject({ sidebarOpen: false, homeSavedFilters: [filterOf(4)] });
  });

  it("读侧规范化：非数组 / 缺 id / 重复 id / 非法日期一律收敛，名称超长截断", async () => {
    const { service, repo } = makeService();
    repo.rows.set(USER_ID, {
      userId: USER_ID,
      prefs: {
        taskTableHiddenColumns: ["owner", 7, "owner", "", "progress", "title"],
        homeSavedFilters: [
          filterOf(1, "名称超长超长超长超长超长超长超长超长超长"),
          { id: "sf-1", name: "重复 id" },
          { name: "缺 id" },
          null,
          { id: "sf-2", name: "坏日期", regions: [], projectTypes: [], managerIds: [], timeFrom: "2026/1/1", timeTo: "2026-09-30" },
        ],
        workspaceOpenProjects: { tasks: [PROJECT_A, 7, PROJECT_A, "", PROJECT_B], raised: "坏形状" },
      },
      updatedAt: AT,
    } as unknown as UserPreferenceRow);
    const prefs = await service.get(USER_ID);
    // owner 去重保留；progress / title / 非字符串 一律丢弃（title = 常显列，progress = 不存在）
    expect(prefs.taskTableHiddenColumns).toEqual(["owner"]);
    expect(prefs.homeSavedFilters).toHaveLength(2);
    expect(prefs.homeSavedFilters[0]?.name).toBe("名称超长超长超长超长超长超长超长超长超长超".slice(0, 20));
    expect(prefs.homeSavedFilters[1]?.timeFrom).toBeNull();
    expect(prefs.homeSavedFilters[1]?.timeTo).toBe("2026-09-30");
    expect(prefs.workspaceOpenProjects).toEqual({ tasks: [PROJECT_A, PROJECT_B], raised: [] });
    expect(prefs.updatedAt).toBe(AT.toISOString());
  });

  it("醒目模式（A4 / §6.13 · Push 171）：只传 focusMode 落库，未传键保持原值；false 可显式写回", async () => {
    const { service, repo } = makeService();
    await service.update(USER_ID, { taskTableHiddenColumns: ["owner"], focusMode: true }, AT);
    expect((await service.get(USER_ID)).focusMode).toBe(true);
    expect(repo.rows.get(USER_ID)?.prefs).toMatchObject({ taskTableHiddenColumns: ["owner"], focusMode: true });
    const after = await service.update(USER_ID, { homeSavedFilters: [filterOf(9)], expectedRevisions: { homeSavedFilters: 0 } }, AT);
    expect(after.focusMode).toBe(true);
    expect(after.taskTableHiddenColumns).toEqual(["owner"]);
    expect((await service.update(USER_ID, { focusMode: false }, AT)).focusMode).toBe(false);
  });

  it("醒目模式读侧收敛 + 契约：jsonb 里非布尔一律回 false；PATCH 非布尔 400", async () => {
    const { service, repo } = makeService();
    repo.rows.set(USER_ID, { userId: USER_ID, prefs: { focusMode: "yes" }, updatedAt: AT } as unknown as UserPreferenceRow);
    const prefs = await service.get(USER_ID);
    expect(prefs.focusMode).toBe(false);
    expect(UserPreferencesUpdateBodySchema.safeParse({ focusMode: true }).success).toBe(true);
    expect(UserPreferencesUpdateBodySchema.safeParse({ focusMode: false }).success).toBe(true);
    expect(UserPreferencesUpdateBodySchema.safeParse({ focusMode: "yes" }).success).toBe(false);
    expect(UserPreferencesUpdateBodySchema.safeParse({ focusMode: 1 }).success).toBe(false);
  });

  it("背景档位（Push 291 · 业务口径「当前背景选择后刷新就没了 要按账号记住」；Push 313 起默认 medium）：只传 backgroundTier 落库、未传键保持原值；读侧白名单外 / 缺省回 medium", async () => {
    const { service, repo } = makeService();
    await service.update(USER_ID, { taskTableHiddenColumns: ["owner"], backgroundTier: "medium" }, AT);
    expect((await service.get(USER_ID)).backgroundTier).toBe("medium");
    expect(repo.rows.get(USER_ID)?.prefs).toMatchObject({ taskTableHiddenColumns: ["owner"], backgroundTier: "medium" });
    const after = await service.update(USER_ID, { homeSavedFilters: [filterOf(1)], expectedRevisions: { homeSavedFilters: 0 } }, AT);
    expect(after.backgroundTier).toBe("medium");
    expect(after.taskTableHiddenColumns).toEqual(["owner"]);
    expect((await service.update(USER_ID, { backgroundTier: "simple" }, AT)).backgroundTier).toBe("simple");
    repo.rows.set(USER_ID, { userId: USER_ID, prefs: { backgroundTier: "neon" }, updatedAt: AT } as unknown as UserPreferenceRow);
    expect((await service.get(USER_ID)).backgroundTier).toBe("medium");
    repo.rows.set(USER_ID, { userId: USER_ID, prefs: { focusMode: true }, updatedAt: AT } as unknown as UserPreferenceRow);
    expect((await service.get(USER_ID)).backgroundTier).toBe("medium");
  });

  it("背景档位契约：枚举 simple / medium / vivid 通过，未知档位 / 非字符串 400", () => {
    expect(UserPreferencesUpdateBodySchema.safeParse({ backgroundTier: "simple" }).success).toBe(true);
    expect(UserPreferencesUpdateBodySchema.safeParse({ backgroundTier: "medium" }).success).toBe(true);
    expect(UserPreferencesUpdateBodySchema.safeParse({ backgroundTier: "vivid" }).success).toBe(true);
    expect(UserPreferencesUpdateBodySchema.safeParse({ backgroundTier: "neon" }).success).toBe(false);
    expect(UserPreferencesUpdateBodySchema.safeParse({ backgroundTier: true }).success).toBe(false);
  });

  it("卡片水印（Push 292 · 业务口径「增加一个水印选项 可以选择是否要水印」；Push 313 起默认 false）：只传 cardWatermark 落库、未传键保持原值；读侧非布尔 / 缺省回默认 false", async () => {
    const { service, repo } = makeService();
    await service.update(USER_ID, { cardWatermark: false }, AT);
    expect((await service.get(USER_ID)).cardWatermark).toBe(false);
    expect(repo.rows.get(USER_ID)?.prefs).toMatchObject({ cardWatermark: false });
    expect((await service.update(USER_ID, { focusMode: true }, AT)).cardWatermark).toBe(false);
    expect((await service.update(USER_ID, { cardWatermark: true }, AT)).cardWatermark).toBe(true);
    repo.rows.set(USER_ID, { userId: USER_ID, prefs: { cardWatermark: "off" }, updatedAt: AT } as unknown as UserPreferenceRow);
    expect((await service.get(USER_ID)).cardWatermark).toBe(false);
    repo.rows.set(USER_ID, { userId: USER_ID, prefs: {}, updatedAt: AT } as unknown as UserPreferenceRow);
    expect((await service.get(USER_ID)).cardWatermark).toBe(false);
  });

  it("卡片水印契约：布尔通过，字符串 / 数字 400", () => {
    expect(UserPreferencesUpdateBodySchema.safeParse({ cardWatermark: true }).success).toBe(true);
    expect(UserPreferencesUpdateBodySchema.safeParse({ cardWatermark: false }).success).toBe(true);
    expect(UserPreferencesUpdateBodySchema.safeParse({ cardWatermark: "off" }).success).toBe(false);
    expect(UserPreferencesUpdateBodySchema.safeParse({ cardWatermark: 0 }).success).toBe(false);
  });

  it("界面语言（Push 296 · 业务口径「现在我要做系统语言切换 暂时中英文」）：只传 locale 落库、未传键保持原值；读侧白名单外回 zh", async () => {
    const { service, repo } = makeService();
    await service.update(USER_ID, { locale: "en" }, AT);
    expect((await service.get(USER_ID)).locale).toBe("en");
    expect(repo.rows.get(USER_ID)?.prefs).toMatchObject({ locale: "en" });
    expect((await service.update(USER_ID, { focusMode: true }, AT)).locale).toBe("en");
    expect((await service.update(USER_ID, { locale: "zh" }, AT)).locale).toBe("zh");
    repo.rows.set(USER_ID, { userId: USER_ID, prefs: { locale: "fr" }, updatedAt: AT } as unknown as UserPreferenceRow);
    expect((await service.get(USER_ID)).locale).toBe("zh");
  });

  it("界面语言契约：zh / en 通过，其它字符串 / 布尔 400", () => {
    expect(UserPreferencesUpdateBodySchema.safeParse({ locale: "zh" }).success).toBe(true);
    expect(UserPreferencesUpdateBodySchema.safeParse({ locale: "en" }).success).toBe(true);
    expect(UserPreferencesUpdateBodySchema.safeParse({ locale: "fr" }).success).toBe(false);
    expect(UserPreferencesUpdateBodySchema.safeParse({ locale: true }).success).toBe(false);
  });

  it("仪表盘页常驻视图（Push 332 · 业务口径「还是做路由吧 这个页面要记住 因为不同的人想常驻的页面可能不一样」）：只传 hubView 落库、未传键保持原值；读侧白名单外回 map", async () => {
    const { service, repo } = makeService();
    await service.update(USER_ID, { hubView: "dashboard" }, AT);
    expect((await service.get(USER_ID)).hubView).toBe("dashboard");
    expect(repo.rows.get(USER_ID)?.prefs).toMatchObject({ hubView: "dashboard" });
    expect((await service.update(USER_ID, { focusMode: true }, AT)).hubView).toBe("dashboard");
    expect((await service.update(USER_ID, { hubView: "map" }, AT)).hubView).toBe("map");
    repo.rows.set(USER_ID, { userId: USER_ID, prefs: { hubView: "board" }, updatedAt: AT } as unknown as UserPreferenceRow);
    expect((await service.get(USER_ID)).hubView).toBe("map");
  });

  it("仪表盘页常驻视图契约：map / dashboard 通过，其它字符串 / 布尔 400", () => {
    expect(UserPreferencesUpdateBodySchema.safeParse({ hubView: "map" }).success).toBe(true);
    expect(UserPreferencesUpdateBodySchema.safeParse({ hubView: "dashboard" }).success).toBe(true);
    expect(UserPreferencesUpdateBodySchema.safeParse({ hubView: "board" }).success).toBe(false);
    expect(UserPreferencesUpdateBodySchema.safeParse({ hubView: true }).success).toBe(false);
  });

  it("仪表盘常驻项目（Push 336 · 业务口径「选择的项目也要记住 不随刷新变动而回到全部项目」）：只传 hubDashProject 落库、未传键保持原值；读侧坏值回 null", async () => {
    const { service, repo } = makeService();
    await service.update(USER_ID, { hubDashProject: PROJECT_A }, AT);
    expect((await service.get(USER_ID)).hubDashProject).toBe(PROJECT_A);
    expect(repo.rows.get(USER_ID)?.prefs).toMatchObject({ hubDashProject: PROJECT_A });
    expect((await service.update(USER_ID, { focusMode: true }, AT)).hubDashProject).toBe(PROJECT_A);
    expect((await service.update(USER_ID, { hubDashProject: null }, AT)).hubDashProject).toBeNull();
    repo.rows.set(USER_ID, { userId: USER_ID, prefs: { hubDashProject: 7 }, updatedAt: AT } as unknown as UserPreferenceRow);
    expect((await service.get(USER_ID)).hubDashProject).toBeNull();
    repo.rows.set(USER_ID, { userId: USER_ID, prefs: { hubDashProject: "" }, updatedAt: AT } as unknown as UserPreferenceRow);
    expect((await service.get(USER_ID)).hubDashProject).toBeNull();
    repo.rows.set(USER_ID, { userId: USER_ID, prefs: { hubDashProject: "x".repeat(HUB_DASH_PROJECT_MAX_LENGTH + 1) }, updatedAt: AT } as unknown as UserPreferenceRow);
    expect((await service.get(USER_ID)).hubDashProject).toBeNull();
  });

  it("仪表盘常驻项目契约：≤ 64 字符串 / null 通过，空串 / 超 64 字 / 布尔 400", () => {
    expect(UserPreferencesUpdateBodySchema.safeParse({ hubDashProject: PROJECT_A }).success).toBe(true);
    expect(UserPreferencesUpdateBodySchema.safeParse({ hubDashProject: null }).success).toBe(true);
    expect(UserPreferencesUpdateBodySchema.safeParse({ hubDashProject: "" }).success).toBe(false);
    expect(UserPreferencesUpdateBodySchema.safeParse({ hubDashProject: "x".repeat(HUB_DASH_PROJECT_MAX_LENGTH + 1) }).success).toBe(false);
    expect(UserPreferencesUpdateBodySchema.safeParse({ hubDashProject: true }).success).toBe(false);
  });

  it("仪表盘页内图表视图（Push 345 · 业务口径 2026-10-16「选择后刷新不变 按账号记住」；Push 353 加词频图；Push 358 加数据总览）：只传 hubDashView 落库、未传键保持原值；读侧白名单外回 progress", async () => {
    const { service, repo } = makeService();
    await service.update(USER_ID, { hubDashView: "delivery" }, AT);
    expect((await service.get(USER_ID)).hubDashView).toBe("delivery");
    expect(repo.rows.get(USER_ID)?.prefs).toMatchObject({ hubDashView: "delivery" });
    expect((await service.update(USER_ID, { focusMode: true }, AT)).hubDashView).toBe("delivery");
    expect((await service.update(USER_ID, { hubDashView: "progress" }, AT)).hubDashView).toBe("progress");
    expect((await service.update(USER_ID, { hubDashView: "wordcloud" }, AT)).hubDashView).toBe("wordcloud");
    expect((await service.update(USER_ID, { hubDashView: "overview" }, AT)).hubDashView).toBe("overview");
    expect((await service.update(USER_ID, { hubDashView: "progress" }, AT)).hubDashView).toBe("progress");
    repo.rows.set(USER_ID, { userId: USER_ID, prefs: { hubDashView: "board" }, updatedAt: AT } as unknown as UserPreferenceRow);
    expect((await service.get(USER_ID)).hubDashView).toBe("progress");
  });

  it("仪表盘页内图表视图契约：overview / progress / status / issues / delivery / wordcloud 通过，其它字符串 / 布尔 400", () => {
    expect(UserPreferencesUpdateBodySchema.safeParse({ hubDashView: "overview" }).success).toBe(true);
    expect(UserPreferencesUpdateBodySchema.safeParse({ hubDashView: "progress" }).success).toBe(true);
    expect(UserPreferencesUpdateBodySchema.safeParse({ hubDashView: "status" }).success).toBe(true);
    expect(UserPreferencesUpdateBodySchema.safeParse({ hubDashView: "issues" }).success).toBe(true);
    expect(UserPreferencesUpdateBodySchema.safeParse({ hubDashView: "delivery" }).success).toBe(true);
    expect(UserPreferencesUpdateBodySchema.safeParse({ hubDashView: "wordcloud" }).success).toBe(true);
    expect(UserPreferencesUpdateBodySchema.safeParse({ hubDashView: "board" }).success).toBe(false);
    expect(UserPreferencesUpdateBodySchema.safeParse({ hubDashView: true }).success).toBe(false);
  });

  it("工作台展开态（A31 · Push 233）：只传 workspaceOpenProjects 落库、整体替换；两标签各自独立", async () => {
    const { service, repo } = makeService();
    await service.update(USER_ID, { workspaceOpenProjects: { tasks: [PROJECT_A], raised: [] } }, AT);
    expect((await service.get(USER_ID)).workspaceOpenProjects).toEqual({ tasks: [PROJECT_A], raised: [] });
    const after = await service.update(USER_ID, { workspaceOpenProjects: { tasks: [], raised: [PROJECT_B] } }, AT);
    expect(after.workspaceOpenProjects).toEqual({ tasks: [], raised: [PROJECT_B] });
    expect(repo.rows.get(USER_ID)?.prefs).toMatchObject({ workspaceOpenProjects: { tasks: [], raised: [PROJECT_B] } });
  });

  it("工作台展开态契约：{ tasks, raised }（uuid 数组）通过；缺键 / 非 uuid / 超上限 400", () => {
    expect(UserPreferencesUpdateBodySchema.safeParse({ workspaceOpenProjects: { tasks: [PROJECT_A], raised: [] } }).success).toBe(true);
    expect(UserPreferencesUpdateBodySchema.safeParse({ workspaceOpenProjects: { tasks: [] } }).success).toBe(false);
    expect(UserPreferencesUpdateBodySchema.safeParse({ workspaceOpenProjects: { tasks: ["不是-uuid"], raised: [] } }).success).toBe(false);
    const many = Array.from({ length: WORKSPACE_OPEN_PROJECTS_LIMIT + 1 }, () => PROJECT_A);
    expect(UserPreferencesUpdateBodySchema.safeParse({ workspaceOpenProjects: { tasks: many, raised: [] } }).success).toBe(false);
  });

  it("便签墙（「我的计划」· Push 268）：只传 myPlanBoard 落库、整体替换；updatedAt 由服务端盖章（不被客户端伪造值覆盖）", async () => {
    const { service, repo } = makeService();
    const note: MyPlanNote = { id: "pn-1", title: "买纸", content: "A4", category: "采购", colorId: "yellow", fontId: "sans", done: false, createdAt: AT.toISOString(), updatedAt: AT.toISOString() };
    await service.update(USER_ID, { myPlanBoard: { notes: [note], categories: ["采购"] }, expectedRevisions: { myPlanBoard: 0 } }, AT);
    const prefs = await service.get(USER_ID);
    expect(prefs.myPlanBoard.notes).toEqual([note]);
    expect(prefs.myPlanBoard.categories).toEqual(["采购"]);
    expect(prefs.myPlanBoard.updatedAt).toBe(AT.toISOString());
    expect(repo.rows.get(USER_ID)?.prefs).toMatchObject({ myPlanBoard: { notes: [note], categories: ["采购"], bg: "white", updatedAt: AT.toISOString() } });
    // 客户端夹带 updatedAt 伪造 → 被服务端盖章值覆盖（写入时间以服务端为准）
    const forged: MyPlanNote = { ...note, id: "pn-2", done: true };
    const later = new Date("2026-10-10T02:00:00.000Z");
    const forgedPatch = { expectedRevisions: { myPlanBoard: 1 }, myPlanBoard: { notes: [forged], categories: ["采购"], updatedAt: "1999-01-01T00:00:00.000Z" } } as unknown as Parameters<UserPreferenceService["update"]>[1];
    const after = await service.update(USER_ID, forgedPatch, later);
    expect(after.myPlanBoard.updatedAt).toBe(later.toISOString());
    expect(after.myPlanBoard.notes).toEqual([forged]);
    // 未传键保持原值：换个键 PATCH 不冲掉便签墙
    expect((await service.update(USER_ID, { focusMode: true }, AT)).myPlanBoard.notes).toEqual([forged]);
    // Push 271 背景色三态：传入白名单值 = 整体替换；老客户端不传 bg = 沿用库内现值（不冲回 white）
    const cream = await service.update(USER_ID, { myPlanBoard: { notes: [forged], categories: ["采购"], bg: "cream" }, expectedRevisions: { myPlanBoard: 2 } }, AT);
    expect(cream.myPlanBoard.bg).toBe("cream");
    expect(repo.rows.get(USER_ID)?.prefs).toMatchObject({ myPlanBoard: { notes: [forged], categories: ["采购"], bg: "cream", updatedAt: AT.toISOString() }, focusMode: true });
    const legacyNoBg = await service.update(USER_ID, { myPlanBoard: { notes: [forged], categories: ["采购"] }, expectedRevisions: { myPlanBoard: 3 } }, AT);
    expect(legacyNoBg.myPlanBoard.bg).toBe("cream");
  });

  it("便签墙读侧收敛：脏 jsonb（非法便签整条丢弃 / 颜色字体回落 / done 非布尔 → false / 分类去空去重）", async () => {
    const { service, repo } = makeService();
    const ok: MyPlanNote = { id: "pn-a", title: "t", content: "c", category: "待办", colorId: "blue", fontId: "mono", done: true, createdAt: AT.toISOString(), updatedAt: AT.toISOString() };
    const dirty = {
      notes: [ok, { id: "pn-b" }, "oops", { ...ok, id: "pn-c", colorId: "red", fontId: "x", done: "yes" }, { ...ok, id: "pn-d", category: "  " }, { ...ok, id: "pn-e", title: "", content: "" }],
      categories: ["待办", "待办", 5, "", "采购"],
      bg: "gold",
    };
    repo.rows.set(USER_ID, { userId: USER_ID, prefs: { myPlanBoard: dirty }, updatedAt: AT } as unknown as UserPreferenceRow);
    const prefs = await service.get(USER_ID);
    expect(prefs.myPlanBoard.notes.map((item) => item.id)).toEqual(["pn-a", "pn-c"]);
    expect(prefs.myPlanBoard.notes[1]).toMatchObject({ colorId: "white", fontId: "sans", done: false });
    expect(prefs.myPlanBoard.categories).toEqual(["待办", "采购"]);
    expect(prefs.myPlanBoard.bg).toBe("white");
    expect(prefs.myPlanBoard.updatedAt).toBeNull();
  });

  it("便签墙契约：≤ 300 条 / done 必填 / 颜色字体白名单；超上限 / 缺 done / 未知色 / 超 12 类由 schema 拒绝", () => {
    const note: MyPlanNote = { id: "pn-1", title: "t", content: "", category: "待办", colorId: "white", fontId: "sans", done: false, createdAt: AT.toISOString(), updatedAt: AT.toISOString() };
    expect(UserPreferencesUpdateBodySchema.safeParse({ myPlanBoard: { notes: [note], categories: ["待办"] } }).success).toBe(true);
    expect(UserPreferencesUpdateBodySchema.safeParse({ myPlanBoard: { notes: [note], categories: ["待办"], bg: "cream" } }).success).toBe(true);
    expect(UserPreferencesUpdateBodySchema.safeParse({ myPlanBoard: { notes: [note], categories: ["待办"], bg: "neon" } }).success).toBe(false);
    expect(UserPreferencesUpdateBodySchema.safeParse({ myPlanBoard: { notes: [{ ...note, done: undefined }], categories: ["待办"] } }).success).toBe(false);
    expect(UserPreferencesUpdateBodySchema.safeParse({ myPlanBoard: { notes: [{ ...note, colorId: "red" }], categories: ["待办"] } }).success).toBe(false);
    const many = Array.from({ length: PLAN_BOARD_NOTE_LIMIT + 1 }, () => note);
    expect(UserPreferencesUpdateBodySchema.safeParse({ myPlanBoard: { notes: many, categories: ["待办"] } }).success).toBe(false);
    const cats = Array.from({ length: PLAN_BOARD_CATEGORY_LIMIT + 1 }, (_value, index) => "类" + String(index));
    expect(UserPreferencesUpdateBodySchema.safeParse({ myPlanBoard: { notes: [], categories: cats } }).success).toBe(false);
    expect(UserPreferencesUpdateBodySchema.safeParse({ myPlanBoard: { notes: [], categories: ["一二三四五六七八九十一"] } }).success).toBe(false);
  });

  it("契约上限：第 21 组 / 名称 21 字由 schema 拒绝（服务端 400）", () => {
    const many = Array.from({ length: SAVED_HOME_FILTER_LIMIT + 1 }, (_value, index) => filterOf(index));
    expect(UserPreferencesUpdateBodySchema.safeParse({ homeSavedFilters: many }).success).toBe(false);
    expect(UserPreferencesUpdateBodySchema.safeParse({ homeSavedFilters: [filterOf(1, "一二三四五六七八九十一二三四五六七八九十一")] }).success).toBe(false);
    expect(UserPreferencesUpdateBodySchema.safeParse({ homeSavedFilters: [filterOf(1, "一二三四五六七八九十一二三四五六七八九十")] }).success).toBe(true);
  });

  it("列显隐白名单：白名单内 key 通过，未知 key / 常显的 title 拒绝（服务端 400）", () => {
    expect(UserPreferencesUpdateBodySchema.safeParse({ taskTableHiddenColumns: ["owner", "due", "deliverable"] }).success).toBe(true);
    expect(UserPreferencesUpdateBodySchema.safeParse({ taskTableHiddenColumns: [] }).success).toBe(true);
    expect(UserPreferencesUpdateBodySchema.safeParse({ taskTableHiddenColumns: ["progress"] }).success).toBe(false);
    expect(UserPreferencesUpdateBodySchema.safeParse({ taskTableHiddenColumns: ["title"] }).success).toBe(false);
  });

  it("同账号同时保存整板：只有一个基线成功，另一个409且不能覆盖", async () => {
    const { service } = makeService();
    const writes = await Promise.allSettled([
      service.update(USER_ID, { myPlanBoard: { notes: [], categories: ["A"] }, expectedRevisions: { myPlanBoard: 0 } }),
      service.update(USER_ID, { myPlanBoard: { notes: [], categories: ["B"] }, expectedRevisions: { myPlanBoard: 0 } }),
    ]);
    expect(writes.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    const failed = writes.find((item) => item.status === "rejected");
    expect(failed?.status === "rejected" && failed.reason.code).toBe("VERSION_CONFLICT");
    expect((await service.get(USER_ID)).myPlanBoard.categories).toEqual(["A"]);
  });

  it("十个不同键并发写入全部保留，且不能伪造服务端版本", async () => {
    const { service, repo } = makeService();
    await Promise.all(Array.from({ length: 10 }, (_, index) => service.update(USER_ID, { ["key" + String(index)]: index })));
    for (let index = 0; index < 10; index += 1) expect(repo.rows.get(USER_ID)?.prefs["key" + String(index)]).toBe(index);
    await expect(service.update(USER_ID, { _revisions: { myPlanBoard: 999 } })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(service.update(USER_ID, { myPlanBoard: { notes: [], categories: [] } })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("白名单与前端任务表列同源：TASK_TABLE_COLUMN_KEYS = TABLE_COLUMNS 的非锁定列（逐项 + 顺序）", () => {
    expect(frontendColumnKeys()).toEqual([...TASK_TABLE_COLUMN_KEYS]);
  });

  it("非法形状的偏好体：空对象合法（等价空 PATCH），homeSavedFilters 非数组拒绝", () => {
    expect(UserPreferencesUpdateBodySchema.safeParse({}).success).toBe(true);
    expect(UserPreferencesUpdateBodySchema.safeParse({ homeSavedFilters: "oops" }).success).toBe(false);
  });
});
