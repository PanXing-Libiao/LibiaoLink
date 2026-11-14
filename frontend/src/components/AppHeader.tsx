import { useEffect, useMemo, useRef, useState } from "react";
import { BG_TIERS, selectBackgroundTier, selectCardWatermark, useBackgroundTier, useCardWatermark } from "../backgroundTier";
import { BG_TIER_TEXT_KEYS, LOCALES, selectLocale, useLocalizedText, useLocale, useT } from "../i18n";
import type { MouseEvent as ReactMouseEvent } from "react";
import { clearHomePrefs } from "../homePrefs";
import { clearLegacyPlanBoard } from "../myPlan";
import { hasPageAccess, useMyPermissions } from "../permissions";
import { useInboxBadge } from "../inbox";
import { useTaskNodePendingBadge } from "../taskNodePending";
import { resetWecomBindingStatus, useWecomBindingBound } from "../wecomBindingStatus";
import { ACCESS_BASE_HASH, AUDIT_BASE_HASH, FILES_BASE_HASH, HUB_HASH, MODEL_SETTINGS_BASE_HASH, SETTINGS_BASE_HASH, goBackToList, goUpLevel, listHref, upLevelHref } from "../useHashRoute";
import { firstAllowedHref } from "../accessRoutes";
import { MobileNav } from "./MobileNav";
import { TopNav } from "./TopNav";
import { InboxPanel } from "./InboxPanel";
import { Toast } from "./Toast";
import type { MeResponse, Project } from "../types";

/** 背景档位（业务口径 2026-10-13）：「类型 / 档位表 / 选中态 + 各档观感」都收在 ../backgroundTier
 *  （模块级 store：顶栏在每页都渲染，切页不丢选择；Push 291 起点选即单键 PATCH 按账号落库、失败出顶部 Toast）；
 *  三档只显档名（同日追订「这些备注的话不要说」）；Push 292 起弹层第四行 =「水印」开关（同套落库口径）；
 *  同日追订「选择后不要退出 用户点别的地方再退出」：点档 / 点开关都不收弹层，点外 / Esc / 再点触发钮才收起。
 * 语言切换（业务口径 2026-10-13「现在我要做系统语言切换 暂时中英文」+「在这个左侧添加按钮」，2026-10-23 扩到日韩）：
 *  「背景」胶囊左侧新增「语言 · 中文 / Language · English」胶囊 + 弹层（中文 / English / 日本語 / 한국어 四项、选中打点，
 *  原生语言名不翻译）；交互与背景弹层同套、互斥打开。
 * 站内信（业务口径 2026-10-16「在这个左侧增加站内信按钮 点击后出现局部弹窗用来消息通知」）：「语言」胶囊左侧
 *  新增铃铛按钮 + 未读红点（Transitions.dev「Notification badge」样张：滑入 + 弹性放大、读完后缩小消散，
 *  app.css 的 .inbox-badge 等价还原），点击 = 局部弹窗（最近 8 条 + 全部已读；见 ./InboxPanel）；
 *  红点 = ../inbox 模块级 store（登录后读面补拉 + SSE unread 快照，切页不丢）；未绑定企微时
 *  未读为 0 也亮无数字红点，并由弹窗底部提示直达设置页（Push 540 起取消登录后自动浮卡）。
 * 设置页入口（业务口径 2026-10-16「在点击用户右上角头像后的列表中添加一个设置页」· Push 250）：账号菜单第三项（Push 400 顺序调整）
 *  「企微绑定」（#/settings · 全账号可见），落点 = 账号级设置（单聊 D5 / D6 + 项目群绑定）；菜单顺序 = 回收站 /〔操作记录〕/〔权限管理〕/ 企微绑定 / 退出登录；权限管理仅群组管理员可见。 */

const PAGE_WATERMARK_EDGE_GAP = 10;
const PAGE_WATERMARK_BLOCK_HEIGHT = 18;
const PAGE_WATERMARK_ROTATION_DEG = 18;

type WatermarkMark = { x: number; y: number };
type ViewportSize = { width: number; height: number };

/** 中文按全角、拉丁字符按半角估算文本宽度；只用于给完整水印预留边界。 */
function estimateWatermarkTextWidth(text: string): number {
  let width = 0;
  for (const char of text) {
    width += (char.codePointAt(0) ?? 0) > 0x2e7f ? 13 : 7.2;
  }
  return Math.max(24, width - 0.2 * Math.max(0, Array.from(text).length - 1));
}

/** 按视口生成整齐的交错行网格；每枚按完整包围盒落在安全区内，密集但不随机、不截字。 */
function layoutPageWatermark(text: string, width: number, height: number): WatermarkMark[] {
  const angle = (PAGE_WATERMARK_ROTATION_DEG * Math.PI) / 180;
  const textWidth = estimateWatermarkTextWidth(text) + 8;
  const boxWidth = textWidth * Math.cos(angle) + PAGE_WATERMARK_BLOCK_HEIGHT * Math.sin(angle);
  const boxHeight = textWidth * Math.sin(angle) + PAGE_WATERMARK_BLOCK_HEIGHT * Math.cos(angle);
  const minX = boxWidth / 2 + PAGE_WATERMARK_EDGE_GAP;
  const maxX = width - boxWidth / 2 - PAGE_WATERMARK_EDGE_GAP;
  const minY = boxHeight / 2 + PAGE_WATERMARK_EDGE_GAP;
  const maxY = height - boxHeight / 2 - PAGE_WATERMARK_EDGE_GAP;
  if (maxX <= minX || maxY <= minY) return [];

  const desiredStepX = Math.max(165, Math.min(410, width * 0.165));
  const desiredStepY = Math.max(120, Math.min(170, height * 0.125));
  const columns = Math.max(1, Math.round((maxX - minX) / desiredStepX) + 1);
  const rows = Math.max(1, Math.round((maxY - minY) / desiredStepY) + 1);
  const stepX = columns > 1 ? (maxX - minX) / (columns - 1) : 0;
  const stepY = rows > 1 ? (maxY - minY) / (rows - 1) : 0;
  const marks: WatermarkMark[] = [];
  for (let row = 0; row < rows; row += 1) {
    const rowOffset = row % 2 === 1 ? stepX / 2 : 0;
    for (let column = 0; column < columns; column += 1) {
      const x = minX + rowOffset + column * stepX;
      if (x > maxX + 0.01) continue;
      marks.push({ x, y: minY + row * stepY });
    }
  }
  return marks;
}

function readViewportSize(): ViewportSize {
  if (typeof document === "undefined") return { width: 0, height: 0 };
  const root = document.documentElement;
  const width = root.clientWidth || window.innerWidth;
  const height = root.clientHeight || window.innerHeight;
  return { width: Math.max(0, width), height: Math.max(0, height) };
}

function useViewportSize(): ViewportSize {
  const [size, setSize] = useState<ViewportSize>(readViewportSize);
  useEffect(() => {
    let frame = 0;
    const sync = () => {
      const next = readViewportSize();
      setSize((current) =>
        current.width === next.width && current.height === next.height ? current : next,
      );
    };
    const syncAfterLayout = () => {
      sync();
      frame = window.requestAnimationFrame(sync);
    };
    syncAfterLayout();
    window.addEventListener("resize", sync, { passive: true });
    window.addEventListener("orientationchange", syncAfterLayout, { passive: true });
    const visualViewport = window.visualViewport;
    visualViewport?.addEventListener("resize", sync, { passive: true });
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", sync);
      window.removeEventListener("orientationchange", syncAfterLayout);
      visualViewport?.removeEventListener("resize", sync);
    };
  }, []);
  return size;
}

type AppHeaderProps = {
  me: MeResponse;
  project?: Project | null;
};

export function AppHeader({ me, project }: AppHeaderProps) {
  const locale = useLocale();
  const t = useT();
  const user = me.user;
  const displayName = user.displayName ?? user.name ?? t("header.unnamed");
  /** 全站个人水印：显示名取当前登录账号，后缀固定；按视口生成交错网格，与卡片国家名水印开关互相独立。 */
  const pageWatermark = displayName + "@立镖机器人";
  const viewport = useViewportSize();
  const pageWatermarkMarks = useMemo(
    () => layoutPageWatermark(pageWatermark, viewport.width, viewport.height),
    [pageWatermark, viewport.width, viewport.height],
  );
  const contact = user.email ?? user.name ?? "—";
  const initial = Array.from(displayName)[0] ?? "—";
  const [menuOpen, setMenuOpen] = useState(false);
  const permissions = useMyPermissions();
  const menuRef = useRef<HTMLDivElement | null>(null);
  /** 背景档位弹出框（业务口径 2026-10-13「在这旁边增加一个背景下拉选择」）：本期只有弹层选择，不做观感上色。 */
  const [bgMenuOpen, setBgMenuOpen] = useState(false);
  /** 语言切换弹出框（业务口径 2026-10-13「现在我要做系统语言切换 暂时中英文」，2026-10-23 扩到日韩）：四项。 */
  const [langMenuOpen, setLangMenuOpen] = useState(false);
  /** 站内信弹窗（业务口径 2026-10-16「在这个左侧增加站内信按钮 点击后出现局部弹窗用来消息通知」）。 */
  const [inboxOpen, setInboxOpen] = useState(false);
  /** 站内信操作失败文案（标记已读 / 全部已读 / 删除）：失败回滚 + 顶部 Toast；关闭即清。 */
  const [inboxError, setInboxError] = useState<string | null>(null);
  /** 语言保存失败文案（Push 296 · 按账号落库）：失败回滚 + 顶部 Toast；关闭即清。 */
  const [langError, setLangError] = useState<string | null>(null);
  /** 背景档位保存失败文案（Push 291）：失败回滚 + 顶部 Toast；关闭即清。 */
  const [bgError, setBgError] = useState<string | null>(null);
  const bgTier = useBackgroundTier();
  const cardWatermark = useCardWatermark();
  const bgMenuRef = useRef<HTMLDivElement | null>(null);
  const langMenuRef = useRef<HTMLDivElement | null>(null);
  const inboxMenuRef = useRef<HTMLDivElement | null>(null);
  const localeLabel = LOCALES.find((item) => item.key === locale)?.label ?? "中文";
  const bgTierLabel = t(BG_TIER_TEXT_KEYS[bgTier]);
  /**
   * 「任务模板」导航红点（PM 反馈 2026-11-13「任务模板 这里加红点提醒吧」）：模块级 store
   * （../taskNodePending），取数 = 有公共节点审核权看全局待审、其他账号看本人 pending；
   * 刷新时机由 App.tsx（登录 / 切页 / 60 秒）与任务模板页审核动作负责，这里只订阅，不自己发请求。
   */
  const templatesPending = useTaskNodePendingBadge();
  /** 顶栏站内信提示：../inbox 给未读数，../wecomBindingStatus 给未绑定态；切页不丢。 */
  const inboxBadge = useInboxBadge();
  const wecomBound = useWecomBindingBound();
  const inboxWecomUnbound = wecomBound === false;
  const inboxHasUnread = inboxBadge.unreadCount > 0;
  const inboxBadgeVisible = inboxHasUnread || inboxWecomUnbound;
  const inboxBadgeKind = inboxHasUnread ? "unread" : inboxWecomUnbound ? "binding" : "none";
  const inboxUnreadText = inboxBadge.unreadCount > 99 ? "99+" : String(inboxBadge.unreadCount);
  const inboxTitle = inboxWecomUnbound
    ? t("header.inbox.title") + " · " + t("inbox.unbound.hint")
    : t("header.inbox.title");
  const inboxAriaLabel = inboxWecomUnbound
    ? (inboxHasUnread ? t("header.inbox.unreadAria", { count: inboxBadge.unreadCount }) : t("header.inbox.title")) + " · " + t("inbox.unbound.hint")
    : inboxHasUnread
      ? t("header.inbox.unreadAria", { count: inboxBadge.unreadCount })
      : t("header.inbox.title");
  const homeHref = listHref();
  const defaultUpHref = upLevelHref();
  /** Logo 缺省回仪表盘；群组未开通仪表盘时落首个可访问页面，避免点 Logo 直接吃 403。 */
  const upHref = defaultUpHref === HUB_HASH && !hasPageAccess(permissions, "dashboard")
    ? firstAllowedHref(permissions)
    : defaultUpHref;
  const goUp = (): void => {
    if (upHref === defaultUpHref) {
      goUpLevel();
      return;
    }
    if (window.location.hash !== upHref) window.location.hash = upHref.slice(1);
  };
  const seqNoText = project ? String(project.seqNo).padStart(2, "0") : "";
  /** 手打内容（项目名）机翻显示：英文界面显示译文（自动切换到位），悬停看中文原文。 */
  const projectNameText = useLocalizedText(project?.description ?? "");
  /** 操作记录对所有登录账号开放：服务端按管理员 / 项目经理 / 本人收敛可见记录。 */
  const canViewFiles = hasPageAccess(permissions, "files");
  /** 「权限管理」菜单项：群组管理员（关闭群组限制时等价管理员亦可配置）。 */
  const canManageAccess = permissions?.groupAccessAdmin === true;
  /** 「回收站」菜单项（Push 261）：回收站页（#/files）按群组页面权限收敛；
   *  读面仍按项目可见性放开，「彻底删除」入口在页面内按 groupAccessAdmin 收敛。 */

  useEffect(() => {
    if (!menuOpen) {
      return;
    }
    const handleMouseDown = (event: MouseEvent) => {
      if (menuRef.current !== null && !menuRef.current.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handleMouseDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleMouseDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [menuOpen]);

  /** 背景档位弹出框的点外 / Esc 收起（与账号菜单同一套交互）。 */
  useEffect(() => {
    if (!bgMenuOpen) {
      return;
    }
    const handleMouseDown = (event: MouseEvent) => {
      if (bgMenuRef.current !== null && !bgMenuRef.current.contains(event.target as Node)) {
        setBgMenuOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setBgMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handleMouseDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleMouseDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [bgMenuOpen]);

  /** 语言弹层的点外 / Esc 收起（与账号菜单 / 背景弹层同一套交互）。 */
  useEffect(() => {
    if (!langMenuOpen) {
      return;
    }
    const handleMouseDown = (event: MouseEvent) => {
      if (langMenuRef.current !== null && !langMenuRef.current.contains(event.target as Node)) {
        setLangMenuOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setLangMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handleMouseDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleMouseDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [langMenuOpen]);

  /** 站内信弹窗的点外 / Esc 收起（与账号菜单 / 背景 / 语言弹层同一套交互）。 */
  useEffect(() => {
    if (!inboxOpen) {
      return;
    }
    const handleMouseDown = (event: MouseEvent) => {
      if (inboxMenuRef.current !== null && !inboxMenuRef.current.contains(event.target as Node)) {
        setInboxOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setInboxOpen(false);
      }
    };
    document.addEventListener("mousedown", handleMouseDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleMouseDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [inboxOpen]);

  // 站内跳转统一拦截：带修饰键点击（新标签 / 新窗口）交给浏览器默认行为
  const interceptNav = (action: () => void) => (event: ReactMouseEvent<HTMLAnchorElement>) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return;
    }
    event.preventDefault();
    action();
  };

  useEffect(() => {
    document.body.dataset.appShell = "true";
    return () => {
      delete document.body.dataset.appShell;
    };
  }, []);

  const header = (
    <header data-app-header="" className="app-header sticky top-0 z-30 border-b border-zinc-200 bg-white/90 backdrop-blur">
      <div className="app-header__inner flex h-16 items-center gap-3 px-6">
        <a href={upHref} onClick={interceptNav(goUp)} title={t("header.up")} className="app-header__brand flex shrink-0 items-center gap-3">
          <img src="/libiaolink-logo.svg" alt="LibiaoLink" className="app-header__logo h-11 w-auto" />
          <div className="app-header__brand-copy leading-tight">
            <p className="text-base font-semibold text-zinc-900">LibiaoLink</p>
            <p className="text-xs text-zinc-500">{t("header.brand.subtitle")}</p>
          </div>
        </a>
        {/* 顶部导航栏（业务口径 2026-09-30「我要做顶部导航栏 分别是首页 项目空间 任务模版 我的任务」）：
            四个纯文字导航项常驻（同日续口径「去除这个液态效果 只保留文字」）；原来的大页名（项目空间 / 任务模板 / 我的任务）
            由导航的当前项接管，不再重复显示。 */}
        <TopNav templatesPending={templatesPending} />
        {project ? (
          <div className="mx-1 hidden min-w-0 border-l border-zinc-200 pl-4 lg:block">
            <p className="truncate text-xs text-zinc-500">
              <a href={homeHref} onClick={interceptNav(goBackToList)} className="transition hover:text-zinc-800">{t("nav.projects")}</a>
              <span className="mx-1.5 text-zinc-300">/</span>
              <span className="text-zinc-500">
                {t("header.seqNo")}{" "}
                <span className="font-mono text-[13px] font-medium text-zinc-600">{seqNoText}</span>
              </span>
              <span className="mx-1.5 text-zinc-300">/</span>
              <span className="font-mono text-[13px] font-semibold text-zinc-900">{project.code}</span>
            </p>
            <p className="mt-0.5 truncate text-xs text-zinc-500">
              <span title={projectNameText === project.description ? undefined : project.description}>{projectNameText}</span> · {t("header.createdAt")} {project.createdAt}
            </p>
          </div>
        ) : null}
        <div className="app-header__actions ml-auto flex shrink-0 items-center gap-2">
          {/* 站内信（业务口径 2026-10-16「在这个左侧增加站内信按钮 点击后出现局部弹窗用来消息通知」）：
              位置 =「语言」胶囊左侧；未读 / 未绑定企微提示共用一枚红点（app.css 的 .inbox-badge）；
              弹窗与语言 / 背景 / 账号菜单同一套交互（点外 / Esc / 再点触发钮收起）且互斥。 */}
          <div ref={inboxMenuRef} className="relative">
            <button
              type="button"
              data-inbox-trigger="true"
              data-inbox-binding-hint={inboxWecomUnbound ? "true" : "false"}
              title={inboxTitle}
              aria-label={inboxAriaLabel}
              aria-haspopup="dialog"
              aria-expanded={inboxOpen}
              onClick={() => {
                setInboxOpen((open) => !open);
                setMenuOpen(false);
                setBgMenuOpen(false);
                setLangMenuOpen(false);
              }}
              className="app-header__icon-button relative inline-flex h-9 w-9 items-center justify-center rounded-full border border-zinc-200 bg-white text-zinc-600 transition hover:border-zinc-300 hover:text-zinc-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true" className="h-4 w-4">
                <path strokeLinecap="round" strokeLinejoin="round" d="M14.857 17.082a23.848 23.848 0 0 0 5.454-1.31A8.967 8.967 0 0 1 18 9.75V9A6 6 0 0 0 6 9v.75a8.967 8.967 0 0 1-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.255 24.255 0 0 1-5.714 0m5.714 0a3 3 0 1 1-5.714 0" />
              </svg>
              <span className="inbox-badge" data-open={inboxBadgeVisible ? "true" : "false"} data-kind={inboxBadgeKind} aria-hidden="true">
                <span className="inbox-badge-dot" data-shape={inboxHasUnread ? "count" : "dot"}>
                  {inboxHasUnread ? inboxUnreadText : null}
                </span>
              </span>
            </button>
            {inboxOpen ? (
              <div
                role="dialog"
                data-inbox-panel="true"
                data-live-sync-readonly="true"
                aria-label={t("header.inbox.title")}
                className="menu-pop absolute right-0 top-full z-20 mt-2 w-88 max-w-[calc(100vw_-_2rem)] overflow-hidden rounded-xl border border-zinc-200/80 bg-white shadow-[0_18px_40px_-12px_rgba(15,23,42,0.30),0_4px_12px_-4px_rgba(15,23,42,0.14)]"
              >
                <InboxPanel
                  onError={(text) => {
                    setInboxError(text);
                  }}
                  onNavigate={() => {
                    setInboxOpen(false);
                  }}
                />
              </div>
            ) : null}
          </div>
          {/* 语言切换（业务口径 2026-10-13「现在我要做系统语言切换 暂时中英文」+「在这个左侧添加按钮」）：
              位置 =「背景」胶囊左侧、同排同款；弹层四项（原生语言名不翻译），点选 / 点外 / Esc / 再点触发钮收起。 */}
          <div ref={langMenuRef} className="relative">
            <button
              type="button"
              data-lang-trigger="true"
              title={t("header.lang.title")}
              aria-label={t("header.lang.title")}
              aria-haspopup="menu"
              aria-expanded={langMenuOpen}
              onClick={() => {
                setLangMenuOpen((open) => !open);
                setMenuOpen(false);
                setBgMenuOpen(false);
                setInboxOpen(false);
              }}
              className="app-header__pill inline-flex h-9 items-center gap-1 rounded-full border border-zinc-200 bg-white px-3 text-xs font-medium text-zinc-600 transition hover:border-zinc-300 hover:text-zinc-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60"
            >
              <span className="app-header__control-text">
                <span className="app-header__control-prefix">{t("header.lang.label")} · </span>
                <span className="app-header__control-value">{localeLabel}</span>
              </span>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true" className="h-3 w-3 text-zinc-400">
                <path strokeLinecap="round" strokeLinejoin="round" d="m6 9 6 6 6-6" />
              </svg>
            </button>
            {langMenuOpen ? (
              <div
                role="menu"
                data-lang-menu="true"
                className="menu-pop absolute right-0 top-full z-20 mt-2 w-36 rounded-xl border border-zinc-200/80 bg-white p-1 shadow-[0_18px_40px_-12px_rgba(15,23,42,0.30),0_4px_12px_-4px_rgba(15,23,42,0.14)]"
              >
                {LOCALES.map((item) => {
                  const active = item.key === locale;
                  return (
                    <button
                      key={item.key}
                      type="button"
                      role="menuitemradio"
                      aria-checked={active}
                      data-lang={item.key}
                      onClick={() => {
                        // Push 296 追订（「按账号记住 刷新不会回中文」）：点选不收弹层（同背景），乐观落位 + 单键 PATCH，失败回滚出 Toast
                        void selectLocale(item.key).then((error) => {
                          if (error !== null) {
                            setLangError(error);
                          }
                        });
                      }}
                      className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left transition hover:bg-zinc-100"
                    >
                      <span className={"h-1.5 w-1.5 shrink-0 rounded-full " + (active ? "bg-zinc-900" : "bg-zinc-200")} />
                      <span className="min-w-0 flex-1 truncate text-sm text-zinc-800">{item.label}</span>
                    </button>
                  );
                })}
              </div>
            ) : null}
          </div>
          {/* 背景下拉选择（业务口径 2026-10-13「在这旁边增加一个背景下拉选择 先做弹出框 分为三个档位
              简约（就是当前系统除去醒目模式的档位）适中 就是醒目模式下的列表 炫彩 三个版本 代码背景实现先不做」）：
              本期只做弹出框与选中态，不做任何观感上色（应用实现留待后续版本）。 */}
          <div ref={bgMenuRef} className="relative">
            <button
              type="button"
              data-bg-tier-trigger="true"
              title={t("header.bg.title")}
              aria-label={t("header.bg.title")}
              aria-haspopup="menu"
              aria-expanded={bgMenuOpen}
              onClick={() => {
                setBgMenuOpen((open) => !open);
                setLangMenuOpen(false);
                setMenuOpen(false);
                setInboxOpen(false);
              }}
              className="app-header__pill inline-flex h-9 items-center gap-1 rounded-full border border-zinc-200 bg-white px-3 text-xs font-medium text-zinc-600 transition hover:border-zinc-300 hover:text-zinc-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60"
            >
              <span className="app-header__control-text">
                <span className="app-header__control-prefix">{t("header.bg.label")} · </span>
                <span className="app-header__control-value">{bgTierLabel}</span>
              </span>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true" className="h-3 w-3 text-zinc-400">
                <path strokeLinecap="round" strokeLinejoin="round" d="m6 9 6 6 6-6" />
              </svg>
            </button>
            {bgMenuOpen ? (
              <div
                role="menu"
                data-bg-tier-menu="true"
                className="menu-pop absolute right-0 top-full z-20 mt-2 w-40 rounded-xl border border-zinc-200/80 bg-white p-1 shadow-[0_18px_40px_-12px_rgba(15,23,42,0.30),0_4px_12px_-4px_rgba(15,23,42,0.14)]"
              >
                {BG_TIERS.map((tier) => {
                  const active = tier.key === bgTier;
                  return (
                    <button
                      key={tier.key}
                      type="button"
                      role="menuitemradio"
                      aria-checked={active}
                      data-bg-tier={tier.key}
                      onClick={() => {
                        // Push 292 追订「选择后不要退出 用户点别的地方再退出」：点档不收弹层（点外 / Esc 才收；开关行同口径）
                        void selectBackgroundTier(tier.key).then((error) => {
                          if (error !== null) {
                            setBgError(error);
                          }
                        });
                      }}
                      className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left transition hover:bg-zinc-100"
                    >
                      <span className={"h-1.5 w-1.5 shrink-0 rounded-full " + (active ? "bg-zinc-900" : "bg-zinc-200")} />
                      <span className="min-w-0 flex-1 truncate text-sm text-zinc-800">{t(BG_TIER_TEXT_KEYS[tier.key])}</span>
                    </button>
                  );
                })}
                <div className="mx-2 my-1 h-px bg-zinc-100" />
                <button
                  type="button"
                  role="menuitemcheckbox"
                  aria-checked={cardWatermark}
                  data-bg-watermark={cardWatermark ? "on" : "off"}
                  onClick={() => {
                    void selectCardWatermark(!cardWatermark).then((error) => {
                      if (error !== null) {
                        setBgError(error);
                      }
                    });
                  }}
                  className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left transition hover:bg-zinc-100"
                >
                  <span className="min-w-0 flex-1 truncate text-sm text-zinc-800">{t("header.bg.watermark")}</span>
                  <span
                    aria-hidden="true"
                    className={"relative h-5 w-9 shrink-0 rounded-full transition-colors " + (cardWatermark ? "bg-zinc-900" : "bg-zinc-200")}
                  >
                    <span className={"absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all " + (cardWatermark ? "left-[18px]" : "left-0.5")} />
                  </span>
                </button>
              </div>
            ) : null}
          </div>
          <div ref={menuRef} className="relative">
            <button
              type="button"
              data-account-trigger="true"
              title={displayName + " · " + contact}
              aria-label={t("header.account")}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={() => {
                setMenuOpen((open) => !open);
                setBgMenuOpen(false);
                setLangMenuOpen(false);
                setInboxOpen(false);
              }}
              className="app-header__icon-button flex h-9 w-9 items-center justify-center rounded-full bg-zinc-100 text-sm font-medium text-zinc-700 transition hover:bg-zinc-200 hover:text-zinc-900 hover:shadow-[0_6px_18px_rgba(15,23,42,0.18)] active:shadow-[0_2px_8px_rgba(15,23,42,0.16)] focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60"
            >
              {initial}
            </button>
            {menuOpen ? (
              <div
                role="menu"
                className="menu-pop absolute right-0 top-full z-20 mt-2 w-36 overflow-hidden rounded-xl border border-zinc-200/80 bg-white p-1 shadow-[0_18px_40px_-12px_rgba(15,23,42,0.30),0_4px_12px_-4px_rgba(15,23,42,0.14)]"
              >
                {canViewFiles ? (
                  <a
                    role="menuitem"
                    data-account-files="true"
                    href={FILES_BASE_HASH}
                    onClick={() => {
                      setMenuOpen(false);
                    }}
                    className="block rounded-lg px-3 py-2 text-sm text-zinc-700 transition hover:bg-zinc-100 hover:text-zinc-900"
                  >
                    {t("header.files")}
                  </a>
                ) : null}
                <a
                  role="menuitem"
                  data-account-audit="true"
                  href={AUDIT_BASE_HASH}
                  onClick={() => {
                    setMenuOpen(false);
                  }}
                  className="block rounded-lg px-3 py-2 text-sm text-zinc-700 transition hover:bg-zinc-100 hover:text-zinc-900"
                >
                  {t("header.audit")}
                </a>
                {canManageAccess ? (
                  <a
                    role="menuitem"
                    data-account-access="true"
                    href={ACCESS_BASE_HASH}
                    onClick={() => {
                      setMenuOpen(false);
                    }}
                    className="block rounded-lg px-3 py-2 text-sm text-zinc-700 transition hover:bg-zinc-100 hover:text-zinc-900"
                  >
                    {t("header.access")}
                  </a>
                ) : null}
                {canManageAccess ? (
                  <a role="menuitem" data-account-models="true" href={MODEL_SETTINGS_BASE_HASH}
                    onClick={() => setMenuOpen(false)}
                    className="block rounded-lg px-3 py-2 text-sm text-zinc-700 transition hover:bg-zinc-100 hover:text-zinc-900">
                    {t("header.models")}
                  </a>
                ) : null}
                <a
                  role="menuitem"
                  data-account-settings="true"
                  href={SETTINGS_BASE_HASH}
                  onClick={() => {
                    setMenuOpen(false);
                  }}
                  className="block rounded-lg px-3 py-2 text-sm text-zinc-700 transition hover:bg-zinc-100 hover:text-zinc-900"
                >
                  {t("header.settings")}
                </a>
                <a
                  role="menuitem"
                  href="/auth/logout"
                  onClick={() => {
                    // 退出登录清除本地记忆：多人共用设备时，避免把上一位用户的筛选选择带给下一位
                    clearHomePrefs();
                    // 「我的计划」便签墙：数据在账号里（Push 268 起）；这里只清尚未迁移上云的本机旧键，不带给下一位用户
                    clearLegacyPlanBoard();
                    // 清空会话内的企微绑定提示态，避免共用设备时把上一位用户的红点状态带给下一位
                    resetWecomBindingStatus();
                  }}
                  className="block rounded-lg px-3 py-2 text-sm text-zinc-700 transition hover:bg-zinc-100 hover:text-zinc-900"
                >
                  {t("header.logout")}
                </a>
              </div>
            ) : null}
          </div>
        </div>
      </div>
      {bgError === null ? null : (
        <Toast kind="error" text={bgError} onClose={() => { setBgError(null); }} anchor={{ name: "data-bg-tier-error", value: "" }} />
      )}
      {langError === null ? null : (
        <Toast kind="error" text={langError} onClose={() => { setLangError(null); }} anchor={{ name: "data-lang-error", value: "" }} />
      )}
      {inboxError === null ? null : (
        <Toast kind="error" text={inboxError} onClose={() => { setInboxError(null); }} anchor={{ name: "data-inbox-error", value: "" }} />
      )}
    </header>
  );

  return (
    <>
      <div
        aria-hidden="true"
        data-page-watermark={pageWatermark}
        data-bg-tier={bgTier}
        className="page-watermark"
      >
        {pageWatermarkMarks.map((mark, index) => (
          <span
            key={index}
            className="page-watermark-mark"
            style={{ left: mark.x + "px", top: mark.y + "px" }}
          >
            {pageWatermark}
          </span>
        ))}
      </div>
      {header}
      <MobileNav />
    </>
  );
}
