import type { ReactNode } from "react";
import type { DailySubView } from "../useHashRoute";
import { subTabGroupText, subTabText, useLocale, useT } from "../i18n";

/**
 * 「日报及问题」的子菜单（业务口径 2026-09-30「日报及问题页面的导航栏按钮集成到页面导航栏 如图一的效果」）。
 *
 * 原来是主标签栏下面单独一排**键帽按钮**（页内导航栏，Push 200/201 还做过吸顶）；本刀把这四块子视图
 * **收进主标签栏「日报及问题」标签的下拉子菜单**（图一：父项带下划线，悬停 / 点击展开白色圆角面板，
 * 面板里按分组列子项）—— 分组 = 「日报」（日报填写 / 日报记录）+ 「问题」（问题追踪 / 问题看板）。
 * 地址口径不变：四块子视图仍是 ?view=daily&sub=（Push 243 起缺省 records「日报记录」，见 useHashRoute 的 DailySubView）。
 */

/** 页内导航栏的四块子视图（业务口径：第一块日报填写、第二块日报记录、第三块问题追踪、第四块问题看板）。 */
export type SubTab = "日报填写" | "日报记录" | "问题追踪" | "问题看板";

export const SUB_TABS: readonly SubTab[] = ["日报填写", "日报记录", "问题追踪", "问题看板"];

/**
 * 中文标签 ↔ 地址 slug（Push 214 · 业务口径「这几个页面也要做路由」）：四块子视图进地址 `?view=daily&sub=`，
 * 与主标签栏 `?view=` 同一套「地址即状态」口径 —— 刷新 / 收藏 / 分享 / 上次后退都能停在原块；
 * 缺省「日报记录」= records 不落参数（Push 243 业务口径「点击默认是日报记录页面」；旧链接 `?view=daily` 原样打开 = 日报记录）。
 */
export const SUB_TAB_KEYS: Record<SubTab, DailySubView> = {
  日报填写: "form",
  日报记录: "records",
  问题追踪: "issues",
  问题看板: "board",
};

/** 子菜单分组（图一：「Item 1 / Item 2」两段分组标题 + 各两项）—— 按业务域分「日报」「问题」两组。 */
export const SUB_TAB_GROUPS: readonly { label: string; items: readonly SubTab[] }[] = [
  { label: "日报", items: ["日报填写", "日报记录"] },
  { label: "问题", items: ["问题追踪", "问题看板"] },
];

/** 子项图标（16px；口径沿用键帽那版：日报填写 = 笔与纸描边 1.8px、日报记录 = 文件描边 1.8px、问题追踪 = 圆环感叹号面性、问题看板 = 放大镜）。 */
const SUB_TAB_ICON: Record<SubTab, ReactNode> = {
  日报填写: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="h-4 w-4">
      <path d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L6.832 19.82a4.5 4.5 0 01-1.897 1.13l-2.685.8.8-2.685a4.5 4.5 0 011.13-1.897L16.863 4.487z" />
      <path d="M18 14v4.75A2.25 2.25 0 0115.75 21H5.25A2.25 2.25 0 013 18.75V8.25A2.25 2.25 0 015.25 6h4.75" />
    </svg>
  ),
  日报记录: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="h-4 w-4">
      <path d="M13.5 3H6.75A1.75 1.75 0 005 4.75v14.5c0 .966.784 1.75 1.75 1.75h10.5A1.75 1.75 0 0019 19.25V8.5L13.5 3z" />
      <path d="M13.5 3v4.75c0 .414.336.75.75.75H19" />
      <path d="M8.75 13h6.5M8.75 16.5h6.5" />
    </svg>
  ),
  问题追踪: (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" className="h-4 w-4">
      <path
        d="M7.493 0.015C7.442 0.021 7.268 0.039 7.107 0.055C5.234 0.242 3.347 1.208 2.071 2.634C0.66 4.211 -0.057 6.168 0.009 8.253C0.124 11.854 2.599 14.903 6.11 15.771C8.169 16.28 10.433 15.917 12.227 14.791C14.017 13.666 15.27 11.933 15.771 9.887C15.943 9.186 15.983 8.829 15.983 8C15.983 7.171 15.943 6.814 15.771 6.113C14.979 2.878 12.315 0.498 9 0.064C8.716 0.027 7.683 -0.006 7.493 0.015M8.853 1.563C9.967 1.707 11.01 2.136 11.944 2.834C12.273 3.08 12.92 3.727 13.166 4.056C13.727 4.807 14.142 5.69 14.33 6.535C14.544 7.5 14.544 8.5 14.33 9.465C13.916 11.326 12.605 12.978 10.867 13.828C10.239 14.135 9.591 14.336 8.88 14.444C8.456 14.509 7.544 14.509 7.12 14.444C5.172 14.148 3.528 13.085 2.493 11.451C2.279 11.114 1.999 10.526 1.859 10.119C1.618 9.422 1.514 8.781 1.514 8C1.514 6.961 1.715 6.075 2.16 5.16C2.5 4.462 2.846 3.98 3.413 3.413C3.98 2.846 4.462 2.5 5.16 2.16C6.313 1.599 7.567 1.397 8.853 1.563M7.706 4.29C7.482 4.363 7.355 4.491 7.293 4.705C7.257 4.827 7.253 5.106 7.259 6.816C7.267 8.786 7.267 8.787 7.325 8.896C7.398 9.033 7.538 9.157 7.671 9.204C7.803 9.25 8.197 9.25 8.329 9.204C8.462 9.157 8.602 9.033 8.675 8.896C8.733 8.787 8.733 8.786 8.741 6.816C8.749 4.664 8.749 4.662 8.596 4.481C8.472 4.333 8.339 4.284 8.04 4.276C7.893 4.272 7.743 4.278 7.706 4.29M7.786 10.53C7.597 10.592 7.41 10.753 7.319 10.932C7.249 11.072 7.237 11.325 7.294 11.495C7.388 11.78 7.697 12 8 12C8.303 12 8.612 11.78 8.706 11.495C8.763 11.325 8.751 11.072 8.681 10.932C8.616 10.804 8.46 10.646 8.333 10.58C8.217 10.52 7.904 10.491 7.786 10.53Z"
        fill="currentColor"
        fillRule="evenodd"
      />
    </svg>
  ),
  问题看板: (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className="h-4 w-4">
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M9.5 17c1.71 0 3.287-.573 4.55-1.537l4.743 4.744a1 1 0 0 0 1.414-1.414l-4.744-4.744A7.5 7.5 0 1 0 9.5 17zM15 9.5a5.5 5.5 0 1 1-11 0 5.5 5.5 0 0 1 11 0z"
        fill="currentColor"
      />
    </svg>
  ),
};

/**
 * 子菜单面板（图一：白色圆角面板 + 分组标题 + 子项列表；材质与账号菜单同款，改左上角为弹出原点）。
 * 当前子视图：浅灰底 + 深色字（与主标签栏「当前项」同一套语言）。
 */
export function DailySubMenu({ active, onSelect }: { active: DailySubView; onSelect: (sub: DailySubView) => void }) {
  const locale = useLocale();
  const t = useT();
  return (
    <div
      data-daily-submenu
      role="menu"
      aria-label={t("sub.dailyAria")}
      className="submenu-pop w-44 overflow-hidden rounded-2xl border border-zinc-200/80 bg-white p-1.5 shadow-[0_18px_40px_-12px_rgba(15,23,42,0.30),0_4px_12px_-4px_rgba(15,23,42,0.14)]"
    >
      {SUB_TAB_GROUPS.map((group, index) => (
        <div key={group.label} className={index === 0 ? "" : "mt-1 border-t border-zinc-100 pt-1"}>
          <p className="px-2.5 pb-0.5 pt-1 text-[11px] font-medium tracking-wide text-zinc-400">{subTabGroupText(locale, group.label)}</p>
          {group.items.map((tab) => {
            const current = SUB_TAB_KEYS[tab] === active;
            return (
              <button
                key={tab}
                type="button"
                role="menuitem"
                data-subnav-item={tab}
                aria-current={current ? "page" : undefined}
                onClick={() => {
                  onSelect(SUB_TAB_KEYS[tab]);
                }}
                className={
                  "flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm transition " +
                  (current ? "bg-zinc-100 font-semibold text-zinc-900" : "font-medium text-zinc-600 hover:bg-zinc-50 hover:text-zinc-900")
                }
              >
                {SUB_TAB_ICON[tab]}
                <span>{subTabText(locale, tab)}</span>
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}
