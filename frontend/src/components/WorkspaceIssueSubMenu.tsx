import type { ReactNode } from "react";
import type { WorkspaceIssueView } from "../useHashRoute";
import { textOf, useLocale, workspaceLabelText } from "../i18n";

/**
 * 「提出/负责的问题」的下拉子菜单（业务口径 2026-10-09「然后导航栏还是改成这样的吧」；
 * 用户给的图 = 项目页主标签栏「日报及问题」的下拉面板）。
 *
 * Push 260 第一稿把两枚子视图做成主标签栏下面单独一排的**下划线子标签栏**；本刀按业务口径「集成到页面导航栏」
 * 收进主标签「提出/负责的问题」的下拉面板 —— 与「日报及问题」的下拉子菜单（components/DailySubMenu.tsx）
 * 同一套材质：白色圆角面板（submenu-pop 弹出动画）+ 图标 + 子项列表，当前子视图 = 浅灰底 + 深色字
 * （与主标签栏「当前项」同一套语言）。
 *
 * 地址口径不变：仍是 `?tab=raised&sub=`（缺省 raised 不落参数、`?sub=handling` = 待我处理的问题），见
 * useHashRoute 的 WorkspaceIssueView —— 刷新 / 收藏 / 分享 / 上次后退都停在同一枚子视图。两枚子视图吃的是同一份
 * 读面的两个数据栏（myIssues.raised / myIssues.handling），面板里不另立分组标题。
 */

/** 两枚子视图（顺序 = 面板里的顺序）：我提出的问题（reporterId 我）/ 待我处理的问题（ownerId 我）。 */
export const ISSUE_VIEW_ITEMS: ReadonlyArray<{ key: WorkspaceIssueView; label: string; icon: ReactNode }> = [
  {
    key: "raised",
    label: "我提出的问题",
    /** 图标 = 纸飞机描边（「提出」= 我抛出去的那条）；与「待我处理的问题」的圆环感叹号区分开。 */
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="h-4 w-4">
        <path d="M6 12L3.269 3.126A59.768 59.768 0 0121.485 12 59.77 59.77 0 013.27 20.876L5.999 12zm0 0h7.5" />
      </svg>
    ),
  },
  {
    key: "handling",
    label: "待我处理的问题",
    /** 图标 = 圆环感叹号面性（与项目页「日报及问题 → 问题追踪」同一枚符号，同一套问题口径）。 */
    icon: (
      <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" className="h-4 w-4">
        <path
          d="M7.493 0.015C7.442 0.021 7.268 0.039 7.107 0.055C5.234 0.242 3.347 1.208 2.071 2.634C0.66 4.211 -0.057 6.168 0.009 8.253C0.124 11.854 2.599 14.903 6.11 15.771C8.169 16.28 10.433 15.917 12.227 14.791C14.017 13.666 15.27 11.933 15.771 9.887C15.943 9.186 15.983 8.829 15.983 8C15.983 7.171 15.943 6.814 15.771 6.113C14.979 2.878 12.315 0.498 9 0.064C8.716 0.027 7.683 -0.006 7.493 0.015M8.853 1.563C9.967 1.707 11.01 2.136 11.944 2.834C12.273 3.08 12.92 3.727 13.166 4.056C13.727 4.807 14.142 5.69 14.33 6.535C14.544 7.5 14.544 8.5 14.33 9.465C13.916 11.326 12.605 12.978 10.867 13.828C10.239 14.135 9.591 14.336 8.88 14.444C8.456 14.509 7.544 14.509 7.12 14.444C5.172 14.148 3.528 13.085 2.493 11.451C2.279 11.114 1.999 10.526 1.859 10.119C1.618 9.422 1.514 8.781 1.514 8C1.514 6.961 1.715 6.075 2.16 5.16C2.5 4.462 2.846 3.98 3.413 3.413C3.98 2.846 4.462 2.5 5.16 2.16C6.313 1.599 7.567 1.397 8.853 1.563M7.706 4.29C7.482 4.363 7.355 4.491 7.293 4.705C7.257 4.827 7.253 5.106 7.259 6.816C7.267 8.786 7.267 8.787 7.325 8.896C7.398 9.033 7.538 9.157 7.671 9.204C7.803 9.25 8.197 9.25 8.329 9.204C8.462 9.157 8.602 9.033 8.675 8.896C8.733 8.787 8.733 8.786 8.741 6.816C8.749 4.664 8.749 4.662 8.596 4.481C8.472 4.333 8.339 4.284 8.04 4.276C7.893 4.272 7.743 4.278 7.706 4.29M7.786 10.53C7.597 10.592 7.41 10.753 7.319 10.932C7.249 11.072 7.237 11.325 7.294 11.495C7.388 11.78 7.697 12 8 12C8.303 12 8.612 11.78 8.706 11.495C8.763 11.325 8.751 11.072 8.681 10.932C8.616 10.804 8.46 10.646 8.333 10.58C8.217 10.52 7.904 10.491 7.786 10.53Z"
          fill="currentColor"
          fillRule="evenodd"
        />
      </svg>
    ),
  },
];

/**
 * 子菜单面板（材质 = 「日报及问题」下拉子菜单同款：白色圆角面板 + 图标 + 子项；当前子视图 = 浅灰底 + 深色字）。
 * 锚点：面板 data-workspace-submenu、子项 data-workspace-subtab（供回放断言与后续 E2E 复用）。
 */
export function WorkspaceIssueSubMenu({ active, onSelect }: { active: WorkspaceIssueView; onSelect: (view: WorkspaceIssueView) => void }) {
  const locale = useLocale();
  return (
    <div
      data-workspace-submenu
      role="menu"
      aria-label={textOf(locale, "ws.submenu.aria")}
      className="submenu-pop w-44 overflow-hidden rounded-2xl border border-zinc-200/80 bg-white p-1.5 shadow-[0_18px_40px_-12px_rgba(15,23,42,0.30),0_4px_12px_-4px_rgba(15,23,42,0.14)]"
    >
      {ISSUE_VIEW_ITEMS.map((item) => {
        const current = item.key === active;
        return (
          <button
            key={item.key}
            type="button"
            role="menuitem"
            data-workspace-subtab={item.key}
            aria-current={current ? "page" : undefined}
            onClick={() => {
              onSelect(item.key);
            }}
            className={
              "flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm transition " +
              (current ? "bg-zinc-100 font-semibold text-zinc-900" : "font-medium text-zinc-600 hover:bg-zinc-50 hover:text-zinc-900")
            }
          >
            {item.icon}
            <span>{workspaceLabelText(locale, item.label)}</span>
          </button>
        );
      })}
    </div>
  );
}
