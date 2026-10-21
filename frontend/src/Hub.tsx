import { useCallback, useEffect, useRef, useState } from "react";
import { useLiveRefresh } from "./useLiveRefresh";
import { useT } from "./i18n";
import { AppHeader } from "./components/AppHeader";
import { HubDashboard, type HubDashboardState } from "./components/HubDashboard";
import { HubMap } from "./components/HubMap";
import type { DashboardDataset, DashboardIssueDataset, DashboardWordDataset } from "./dashboardApi";
import type { HubDashView } from "./data/dashboardProgress";
import { buildMapDistribution, type HubMapDistribution } from "./data/mapProjects";
import { fetchDashboardChangeWords, fetchDashboardIssues, fetchDashboardProgress } from "./dashboardApi";
import { loadDicts } from "./dicts";
import { fetchProjectList } from "./projectApi";
import { EMPTY_LIST_QUERY, replaceHubView, type HubView } from "./useHashRoute";
import type { MeResponse } from "./types";

/**
 * 仪表盘页（顶层 · 2026-10-15 业务口径「导航栏名称蓝图改成仪表盘」「鼠标滑动蓝图转场展示仪表盘」）：
 * 本页由「蓝图」改名「**仪表盘**」—— 页面本体还是那张世界地图（蓝图），鼠标滑动 / 方向键 / 页边圆钮触发转场，
 * 转入「阶段 × 进度五档」统计视图（形态 = 业务确认过的效果图；取数口径见 data/dashboardProgress.ts）。
 *
 * 转场（2026-10-15「转场效果看这个参考这个页面的顶部渐变、底部渐变」= tympanus《A Collection of Page Transitions》
 * 的「Fade top / Fade bottom」第 11 / 12 号动画）：下滑 = 地图上移淡出、仪表盘自下淡入；上滑 = 反向。
 * 转场体（Push 343）改「刚体滑轨」（app.css 的 .hub-deck__strip）：两屏在滑轨里静态首尾相接、只动滑轨一格（0.6s ease），
 * 两屏只各自动透明度（出 1→.3、入 .3→1）—— 两屏相对几何恒定，「首帧闪影 / 两屏脱节叠影」在结构上不可能出现。
 *
 * Push 354（2026-10-16 业务口径「仪表盘页面重新登录点击刷新后 会触发页面转场动画效果 修复」+「我需要上滑再下滑才能正常目前」）：
 * 「没人翻页却演了一页转场」根治 —— ① 滑轨的 transform 过渡只在用户翻页期间开启（app.css 的 data-anim），落屏 / 地址 /
 * 账号记忆对齐一律瞬时换屏；② 记忆落屏即把视图写回地址（见下对齐 effect）：地址不再停在 #/、每次刷新都要再等一遍记忆
 * 晚到，用户也不再需要「上滑再下滑」把地址手动翻回来；③ App 层首落闸门：地址没写 ?view= 时，账号记忆没落定前先不渲染
 * 卡面（见 App.tsx 的 hubPrefsSettled）。
 *
 * 尺寸（2026-10-15「蓝图页面我不希望有鼠标滚动条 所以尺寸还要优化」）：外框收口成视口高度
 * （h-[100dvh] + overflow-hidden），面板 flex-1，地图 / 统计都按 viewBox 缩放 —— 本页不出滚动条，
 * 滚轮专用于触发转场（面板内部可滚区，例如钉住的「项目梳理」清单，照常滚）。
 *
 * Push 344（2026-10-16 业务口径「现在做这个问题 效果和上面做的一样」）：仪表盘第三个视图「问题」（分组柱状图 +
 * 点柱只读「数据详情」）的问题 / 日报读面**懒加载** —— 首次切到「问题」视图才拉（ensureIssues；不加重仪表盘首屏那轮
 * 任务取数），拉完存明细、切项目 / 开弹窗零请求；已经拉过（ready）时随变更静默刷新跟着刷（见下 useLiveRefresh）。
 *
 * Push 353（2026-10-16 业务口径「现在做这个词频图 根据变更原因的词频拼成这个图」）：仪表盘第五个视图「词频图」
 * （变更原因核心词词云 + 点最中间那枚词只读「数据详情」）的变更记录 + 用户目录读面**懒加载** —— 首次切到「词频图」视图才拉
 * （ensureWords；不加重仪表盘首屏那轮任务取数），拉完存明细、切项目 / 点词零请求；已经拉过（ready）时随变更
 * 静默刷新跟着刷；分词 / 计数口径见 data/changeWords.ts。
 *
 * 历史（口径不动，只动了页面命名）：Push 285「登录后默认进入项目空间 首页名称改成蓝图」—— 本页由
 * 「入口页 / 首页」改名「蓝图」，登录后的默认落地改为项目空间 `#/projects`，本页由导航首项 / `#/` 直连进入；
 * Push 188 改版起平面世界地图占满内容区（地图口径见 components/HubMap.tsx；项目立柱的数据口径见
 * data/mapProjects.ts —— 联动键是 projects.region，取数复用现有接口，没有新增契约）。
 *
 * 业务口径 2026-09-30「这三个按钮删除吧」：原来最左侧竖排的三个入口胶囊（项目空间 / 任务模板 / 我的任务，
 * components/HubButton.tsx）与顶部导航栏重复，整列下架（组件文件一并删除），地图从此占满整行；
 * 项目空间 / 任务模板 / 我的任务三个落点地址不变，改由顶部导航栏承接。
 */
type HubNote = "loading" | "none" | { kind: "capped"; n: number; total: number } | "failed";
type HubAnim = "toDashboard" | "toMap" | null;

/** 右侧边缘页面指示器的两屏顺序（Push 333 · 业务口径「页面指示器呢 我没看到」「这个悬浮球不需要」）。 */
const DECK_VIEWS: readonly HubView[] = ["map", "dashboard"];

/** 转场时长（与 app.css 的 .hub-deck__strip 滑轨过渡一致）：滑完才落定视图。 */
const DECK_ANIM_MS = 620;

/** 数据详情弹窗（Push 336 · 业务口径「点击具体的模块进入详细内容后是弹窗一样的效果 并且不支持鼠标滑动切换页面」）：
 *  弹窗打开时滚轮 / 方向键 / Esc 只属于弹窗，不参与地图 ⇄ 仪表盘转场（弹窗挂在浮层里，本判定是硬闸）。 */
function detailDialogOpen(): boolean {
  return document.querySelector("[data-hub-detail-dialog]") !== null;
}

/** 转场只吃「页面级」滚轮：落点上游有可滚动祖先（例如钉住的「项目梳理」清单）时放行给内部滚动。 */
function scrollableAncestorWithin(target: EventTarget | null, boundary: HTMLElement): boolean {
  let node = target instanceof HTMLElement ? target : null;
  while (node !== null && node !== boundary) {
    if (node.scrollHeight > node.clientHeight + 1 || node.scrollWidth > node.clientWidth + 1) {
      return true;
    }
    node = node.parentElement;
  }
  return false;
}

export default function Hub({ me, routeView, rememberedView, onViewChange, rememberedDashProject, onDashProjectChange, rememberedDashView, onDashViewChange }: {
  me: MeResponse;
  /** 地址里的视图（`#/?view=dashboard`；null = 地址没写，落账号记忆的常驻视图）—— Push 332。 */
  routeView: HubView | null;
  /** 账号记的常驻视图（user_preferences.prefs.hubView；地址没写时用它）—— Push 332。 */
  rememberedView: HubView;
  onViewChange: (view: HubView) => void;
  /** 账号记的仪表盘常驻项目（user_preferences.prefs.hubDashProject；null = 全部项目）—— Push 336。 */
  rememberedDashProject: string | null;
  /** 记下 / 清除仪表盘常驻项目（Push 336；乐观更新由 App 层负责）。 */
  onDashProjectChange: (projectId: string | null) => Promise<void>;
  /** 账号记的仪表盘页内视图（Push 345 · 业务口径 2026-10-16「选择后刷新不变 按账号记住」；缺省 progress）。 */
  rememberedDashView: HubDashView;
  /** 记下仪表盘页内视图（Push 345；乐观更新 + 失败回滚 + Toast 由 App 层负责）。 */
  onDashViewChange: (view: HubDashView) => Promise<void>;
}) {
  const t = useT();
  /** 提示条内容（Push 301）：存结构化状态、渲染时按当前语言取词（切换语言不用等下一次取数）。 */
  const [note, setNote] = useState<HubNote>("loading");
  const [distribution, setDistribution] = useState<HubMapDistribution | null>(null);
  const [view, setView] = useState<HubView>(routeView ?? rememberedView);
  const [anim, setAnim] = useState<HubAnim>(null);
  const [dash, setDash] = useState<DashboardDataset | null>(null);
  const [dashState, setDashState] = useState<HubDashboardState>("loading");
  /** 「问题」视图数据（Push 344 · 懒加载：首次切到「问题」视图才拉，不加重仪表盘首屏；取数见 dashboardApi.ts）。 */
  const [issues, setIssues] = useState<DashboardIssueDataset | null>(null);
  const [issuesState, setIssuesState] = useState<"idle" | "loading" | "ready" | "failed">("idle");
  /** 「词频图」视图数据（Push 353 · 懒加载：首次切到「词频图」视图才拉；取数见 dashboardApi.ts）。 */
  const [words, setWords] = useState<DashboardWordDataset | null>(null);
  const [wordsState, setWordsState] = useState<"idle" | "loading" | "ready" | "failed">("idle");
  const deckRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<HubView>(routeView ?? rememberedView);
  const animRef = useRef<HubAnim>(null);
  const dashStateRef = useRef<HubDashboardState>("loading");
  const dashLoadingRef = useRef(false);
  const issuesStateRef = useRef<"idle" | "loading" | "ready" | "failed">("idle");
  const issuesLoadingRef = useRef(false);
  const wordsStateRef = useRef<"idle" | "loading" | "ready" | "failed">("idle");
  const wordsLoadingRef = useRef(false);
  const settleTimerRef = useRef<number | null>(null);
  const noteText = note === "loading" ? t("hub.loading") : note === "failed" ? t("hub.loadFailed") : note === "none" ? "" : t("hub.capped", { n: note.n, total: note.total });

  const updateDashState = useCallback((next: HubDashboardState) => {
    dashStateRef.current = next;
    setDashState(next);
  }, []);

  const updateIssuesState = useCallback((next: "idle" | "loading" | "ready" | "failed") => {
    issuesStateRef.current = next;
    setIssuesState(next);
  }, []);

  const updateWordsState = useCallback((next: "idle" | "loading" | "ready" | "failed") => {
    wordsStateRef.current = next;
    setWordsState(next);
  }, []);

  /** 拉统计（纯取数、不落状态）：首转 / 失败重试 / 变更静默刷新共用。 */
  const pullDashboard = useCallback(async (): Promise<DashboardDataset | null> => {
    try {
      return await fetchDashboardProgress();
    } catch {
      return null;
    }
  }, []);

  /** 拉问题读面（纯取数、不落状态）：首次 / 失败重试 / 变更静默刷新共用。 */
  const pullIssues = useCallback(async (): Promise<DashboardIssueDataset | null> => {
    try {
      return await fetchDashboardIssues();
    } catch {
      return null;
    }
  }, []);

  /** 拉词频图读面（纯取数、不落状态）：首次 / 失败重试 / 变更静默刷新共用。 */
  const pullWords = useCallback(async (): Promise<DashboardWordDataset | null> => {
    try {
      return await fetchDashboardChangeWords();
    } catch {
      return null;
    }
  }, []);

  /** 首次切到「问题」视图时拉问题 / 日报读面（Push 344 · 懒加载：不进仪表盘首屏那一轮取数）。 */
  const ensureIssues = useCallback(() => {
    if (issuesStateRef.current === "ready" || issuesLoadingRef.current) {
      return;
    }
    issuesLoadingRef.current = true;
    updateIssuesState("loading");
    void (async () => {
      const data = await pullIssues();
      issuesLoadingRef.current = false;
      if (data === null) {
        updateIssuesState("failed");
        return;
      }
      setIssues(data);
      updateIssuesState("ready");
    })();
  }, [pullIssues, updateIssuesState]);

  /** 首次切到「词频图」视图时拉变更记录 / 用户目录读面（Push 353 · 懒加载：不进仪表盘首屏那一轮取数）。 */
  const ensureWords = useCallback(() => {
    if (wordsStateRef.current === "ready" || wordsLoadingRef.current) {
      return;
    }
    wordsLoadingRef.current = true;
    updateWordsState("loading");
    void (async () => {
      const data = await pullWords();
      wordsLoadingRef.current = false;
      if (data === null) {
        updateWordsState("failed");
        return;
      }
      setWords(data);
      updateWordsState("ready");
    })();
  }, [pullWords, updateWordsState]);

  /** 转入仪表盘前确保有数据：未就绪拉一次（转场先走，拉完再渲染数据，中途显示加载球）。 */
  const ensureDashboard = useCallback(() => {
    if (dashStateRef.current === "ready" || dashLoadingRef.current) {
      return;
    }
    dashLoadingRef.current = true;
    if (dashStateRef.current === "failed") {
      updateDashState("loading");
    }
    void (async () => {
      const data = await pullDashboard();
      dashLoadingRef.current = false;
      if (data === null) {
        updateDashState("failed");
        return;
      }
      setDash(data);
      updateDashState("ready");
    })();
  }, [pullDashboard, updateDashState]);

  /** 触发转场：动画期间锁住再次触发；动画跑完落定视图（与 CSS 时长同步）。 */
  const startTransition = useCallback((next: HubView) => {
    if (animRef.current !== null || viewRef.current === next) {
      return;
    }
    if (next === "dashboard") {
      ensureDashboard();
    }
    const nextAnim: HubAnim = next === "dashboard" ? "toDashboard" : "toMap";
    animRef.current = nextAnim;
    setAnim(nextAnim);
    settleTimerRef.current = window.setTimeout(() => {
      settleTimerRef.current = null;
      animRef.current = null;
      viewRef.current = next;
      setAnim(null);
      setView(next);
      // Push 332：视图落定即写回地址（replace · 刷新 / 收藏 / 分享都停这一屏）并按账号记住（地址带参数时以地址为准）。
      replaceHubView(next);
      onViewChange(next);
    }, DECK_ANIM_MS);
  }, [ensureDashboard, onViewChange]);

  useEffect(() => () => {
    if (settleTimerRef.current !== null) {
      window.clearTimeout(settleTimerRef.current);
    }
  }, []);

  /**
   * 地址 / 账号记忆与当前视图对齐（Push 332 · 业务口径「还是做路由吧 这个页面要记住 因为不同的人想常驻的页面可能不一样」）：
   * ① 地址显式带视图（?view=dashboard）时以地址为准；② 地址不带参数时落账号记忆的常驻视图。
   * 两者都只在「当前不在这一屏」时瞬时对齐 —— 它是落地定位，不是滚轮 / 按钮触发的翻页（不走转场）。
   *
   * Push 354（2026-10-16 业务口径「仪表盘页面重新登录点击刷新后 会触发页面转场动画效果 修复」+「我需要上滑再下滑才能正常目前」）：
   * ③ 对齐换屏不吃 CSS 过渡：滑轨过渡只在转场（animRef 非空）期间开启（app.css 的 data-anim）——
   *    此前记忆 / 地址晚到改 data-view 时被 600ms 过渡顺手播了一遍，「没人滑过滚轮却演了一页转场」由此而来；
   * ④ 记忆落屏即把视图写回地址（replace）：否则地址停在 #/，刷新时记忆晚到又重演一遍假转场
   *    —— 业务侧只能「上滑再下滑」手动翻一遍，让地址被转场落定写回后才恢复正常。
   */
  useEffect(() => {
    const target = routeView ?? rememberedView;
    if (target === "dashboard") {
      ensureDashboard();
    }
    if (animRef.current !== null) {
      return;
    }
    if (target === viewRef.current) {
      if (routeView === null) {
        replaceHubView(target);
      }
      return;
    }
    viewRef.current = target;
    setView(target);
    if (routeView === null) {
      replaceHubView(target);
    }
  }, [routeView, rememberedView, ensureDashboard]);

  useEffect(() => {
    const deck = deckRef.current;
    if (deck === null) {
      return undefined;
    }
    const onWheel = (event: WheelEvent) => {
      if (detailDialogOpen() || scrollableAncestorWithin(event.target, deck)) {
        return;
      }
      event.preventDefault();
      if (animRef.current !== null) {
        return;
      }
      const delta = event.deltaY;
      if (Math.abs(delta) < 8) {
        return;
      }
      if (delta > 0 && viewRef.current === "map") {
        startTransition("dashboard");
      } else if (delta < 0 && viewRef.current === "dashboard") {
        startTransition("map");
      }
    };
    deck.addEventListener("wheel", onWheel, { passive: false });
    return () => deck.removeEventListener("wheel", onWheel);
  }, [startTransition]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (detailDialogOpen() || event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) {
        return;
      }
      const target = event.target;
      if (target instanceof HTMLElement && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) {
        return;
      }
      if (event.key === "ArrowDown" || event.key === "PageDown") {
        if (viewRef.current === "map") {
          event.preventDefault();
          startTransition("dashboard");
        }
      } else if (event.key === "ArrowUp" || event.key === "PageUp" || event.key === "Escape") {
        if (viewRef.current === "dashboard") {
          event.preventDefault();
          startTransition("map");
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [startTransition]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [list, dicts] = await Promise.all([fetchProjectList(EMPTY_LIST_QUERY), loadDicts()]);
        if (cancelled) {
          return;
        }
        setDistribution(buildMapDistribution(list.items, dicts));
        setNote(list.items.length < list.total ? { kind: "capped", n: list.items.length, total: list.total } : "none");
      } catch {
        if (cancelled) {
          return;
        }
        // 取数失败不挡蓝图页：地图照常可触碰，只是没有立柱
        setDistribution(null);
        setNote("failed");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useLiveRefresh(["projects", "dicts", "tasks", "permissions", "users"], async () => {
    const [list, dicts] = await Promise.all([fetchProjectList(EMPTY_LIST_QUERY), loadDicts()]);
    /** 统计只在已就绪后才跟着刷新（没转过场就不预拉）。 */
    const nextDash = dashStateRef.current === "ready" ? ((await pullDashboard()) ?? dash) : dash;
    /** 问题读面只在已经拉过（ready）后跟着静默刷新（没切过「问题」视图就不预拉）。 */
    const nextIssues = issuesStateRef.current === "ready" ? ((await pullIssues()) ?? issues) : issues;
    /** 词频图读面只在已经拉过（ready）后跟着静默刷新（没切过「词频图」视图就不预拉）。 */
    const nextWords = wordsStateRef.current === "ready" ? ((await pullWords()) ?? words) : words;
    return () => {
      setDistribution(buildMapDistribution(list.items, dicts));
      setNote(list.items.length < list.total ? { kind: "capped", n: list.items.length, total: list.total } : "none");
      if (nextDash !== dash) {
        setDash(nextDash);
      }
      if (nextIssues !== issues) {
        setIssues(nextIssues);
      }
      if (nextWords !== words) {
        setWords(nextWords);
      }
    };
  }, "hub", distribution !== null);

  /** 刚体滑轨的落位（Push 343）：转场途中指向目标屏、滑完就是当前视图；两屏在滑轨里永远静态（app.css 的 .hub-deck__strip）。
   *  data-anim（Push 354）：滑轨的 transform 过渡只在转场期间开启 —— 落屏 / 记忆对齐改 data-view 是瞬时换屏（app.css）。 */
  const stripView: HubView = anim === "toMap" ? "map" : anim === "toDashboard" ? "dashboard" : view;
  const mapSideClass = anim === "toMap" ? "hub-deck__cell--in" : anim === "toDashboard" ? "hub-deck__cell--out" : "";
  const dashSideClass = anim === "toDashboard" ? "hub-deck__cell--in" : anim === "toMap" ? "hub-deck__cell--out" : "";
  /** 指示器跟随转场目标：点球即先变色（转场途中也即时反馈），落定后与地址 / 账号记忆一致。 */
  const indicatorView: HubView = anim === "toDashboard" ? "dashboard" : anim === "toMap" ? "map" : view;
  /** 两屏共用的卡面样式（Push 343 起去掉 backdrop-blur：滑轨背后只有页面底色，模糊是重采样脏影与合成层抖动的源头）；位置 / 尺寸由 .hub-deck__cell 给。 */
  const deckCellClass = "hub-deck__cell overflow-hidden rounded-[28px] border border-zinc-200/80 bg-white/80 p-3 shadow-[0_24px_60px_-42px_rgba(15,23,42,0.45)]";

  return (
    <div className="flex h-[100dvh] flex-col overflow-hidden overscroll-none">
      <AppHeader me={me} />
      <main className="relative min-h-0 flex-1 px-6 py-5 lg:px-10 lg:py-6">
        <section ref={deckRef} data-hub-deck="" className="relative h-full overflow-hidden">
          <div className="hub-deck__strip" data-view={stripView} data-anim={anim === null ? undefined : "true"}>
            <div data-view="map" data-hub-deck-cell="map" className={deckCellClass + " " + mapSideClass}>
              <HubMap distribution={distribution} note={noteText} />
            </div>
            <div data-view="dashboard" data-hub-deck-cell="dashboard" className={deckCellClass + " " + dashSideClass}>
              <HubDashboard data={dash} state={dashState} issues={issues} issuesState={issuesState} onNeedIssues={ensureIssues} words={words} wordsState={wordsState} onNeedWords={ensureWords} rememberedDashProject={rememberedDashProject} onDashProjectChange={onDashProjectChange} rememberedDashView={rememberedDashView} onDashViewChange={onDashViewChange} />
            </div>
          </div>
          <nav className="hub-deck-dots" aria-label={t("hub.dots.label")}>
            {DECK_VIEWS.map((item) => (
              <button
                key={item}
                type="button"
                className="hub-deck-dots__dot"
                data-view={item}
                data-active={indicatorView === item ? "true" : "false"}
                aria-current={indicatorView === item ? "true" : undefined}
                aria-label={t(item === "map" ? "hub.dots.map" : "hub.dots.dashboard")}
                onClick={() => startTransition(item)}
              />
            ))}
          </nav>
        </section>
      </main>
    </div>
  );
}
