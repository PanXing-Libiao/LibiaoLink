import { HUB_HASH, TEMPLATE_BASE_HASH, WORKSPACE_BASE_HASH, projectsHref, useHashRoute } from "../useHashRoute";
import { useT } from "../i18n";

/**
 * 顶部导航栏（业务口径 2026-09-30「我要做顶部导航栏 分别是首页 项目空间 任务模版 我的任务」；
 * Push 285 业务口径 2026-10-12「登录后默认进入项目空间 首页名称改成蓝图」：首项由「首页」改名「**蓝图**」；
 * 2026-10-15 业务口径「导航栏名称蓝图改成仪表盘」：首项再改名「**仪表盘**」—— 两次改名落点都不变（`#/` 顶层），
 * 登录默认落地改由路由层落项目空间，见 useHashRoute）。
 *
 * 首版按业务给的 styled-components 玻璃胶囊样张还原（CSS 见 app.css 的 .topnav-* 段）；业务随后收口
 * 「去除这个液态效果 只保留文字」（2026-09-30）→ 胶囊面 / 描边环 / 高光扫过 / 悬浮动效全部下架，
 * 只剩纯文字项，样式只做排版与配色（app.css 的 .topnav-*）。
 *
 * 当前所在页：active 项 = 深色字、字重 700（与项目页内键帽导航同一套「当前项」语言）；
 * 项目详情页视作「项目空间」内（导航项亮「项目空间」）。
 */
export function TopNav() {
  const route = useHashRoute();
  /** 导航项文案走 i18n（Push 296 语言切换）：默认中文；切英文后顶栏导航四项跟着换。 */
  const t = useT();
  const items = [
    { key: "hub", label: t("nav.hub"), href: HUB_HASH, active: route.kind === "hub" },
    {
      key: "projects",
      label: t("nav.projects"),
      href: projectsHref(),
      active: route.kind === "list" || route.kind === "project",
    },
    {
      key: "templates",
      label: t("nav.templates"),
      href: TEMPLATE_BASE_HASH,
      active: route.kind === "placeholder" && route.page === "templates",
    },
    { key: "workspace", label: t("nav.workspace"), href: WORKSPACE_BASE_HASH, active: route.kind === "workspace" },
  ];

  return (
    <nav data-topnav="" aria-label={t("nav.aria")} className="topnav ml-1 hidden min-w-0 items-center md:flex">
      {items.map((item) => (
        <a
          key={item.key}
          data-topnav-item={item.key}
          href={item.href}
          aria-current={item.active ? "page" : undefined}
          className="topnav-btn"
        >
          {item.label}
        </a>
      ))}
    </nav>
  );
}
