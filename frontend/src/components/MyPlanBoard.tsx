import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode, type Ref } from "react";
import { Toast } from "./Toast";
import { Loader } from "./Loader";
import { PlanNoteCard } from "./PlanNoteCard";
import { PlanNoteEditor, type PlanNoteDraft } from "./PlanNoteEditor";
import { RowDeleteButton } from "./RowDeleteButton";
import { planLabelText, useLocale, useT } from "../i18n";
import { ApiError } from "../api";
import { useLiveRefresh } from "../useLiveRefresh";
import { keepLiveOrder } from "../liveSync";
import { loadMyPreferences, saveMyPlanBoard } from "../preferencesApi";
import {
  PLAN_BOARD_BGS,
  PLAN_CATEGORY_MAX,
  PLAN_CATEGORY_NAME_MAX,
  PLAN_NOTE_LIMIT,
  clearLegacyPlanBoard,
  filterPlanNotes,
  newPlanNoteId,
  normalizePlanCategoryName,
  orderPlanNotes,
  planBoardBgOf,
  planGreeting,
  readLegacyPlanBoard,
  seedPlanBoard,
  type PlanBoard,
  type PlanBoardBgId,
  type PlanNote,
} from "../myPlan";

/**
 * 工作台「我的计划」便签墙（第三枚标签 · 业务口径 2026-10-10「照 minimemo3 便签页融入系统」→
 * 「ui直接照搬可以吗 背景颜色也搬过去 卡片的尺寸也要」→「导出导入功能不要」→「填写也要一样」→
 * Push 268「这个也不需要（排序）· 背景换成白色 · 数据接入数据库 · 新增完成按钮 · 完成后只显示在已完成里面」）：
 * 页面形态照 MiniMemo 参考页照搬 —— 纯白背景 + 左侧分类栏（全部便签 / 已完成 / 各分类）+ 「问候 + 大标题 + 计数」头部 +
 * 228px 起跳的 auto-fill 网格 + 198 高圆角卡片（配色 = 同一套 7 色 hex 调色板）；工具条 = 搜索 + 新建便签（排序已下架；不做导出 / 导入）。
 *
 * 存储（Push 268 起 · 账号落库）：整面便签墙按账号存服务端偏好（user_preferences.prefs.myPlanBoard，见 preferencesApi.ts）——
 * 首次打开（账号里从未保存）预置 6 条示例并上云；本机旧键（libiaolink.plan.board.v1）自动迁移上云再清键（迁移失败保留旧键、本机数据兜底、下轮重试）。
 * 保存 = 乐观更新 + 单键 PATCH（串行）；失败保留界面改动并出提示（刷新回滚到账号里最后一次保存）。
 * 完成态（Push 269 改拖拽 · 业务口径 2026-10-10「不要这个完成 在这个分类旁边增加完成区域 拖动便签到完成区域则完成」）：
 * 编辑弹窗不再有完成键 —— 侧栏分类卡下方新增「完成」拖放区：把便签拖进去即完成；「已完成」视图里的便签拖回「全部便签」即恢复。
 * 完成后只出现在「已完成」视图（便签墙与分类视图不再显示）。
 * Push 270（业务口径 2026-10-10「我要分类的左侧全部作为完成区 虚线框起来 然后便签拖动应该脱离原来的位置」）：
 * 「完成」区放大成整条左栏 —— 虚线圆角框把分类卡整张裹进去，下方剩余空间给「完成」提示（悬停变墨底奶白）；左栏拉满视口高度（sticky 不抖）。
 * 拖动中便签从原位脱离：原槽位只留虚线占位框（卡片本体隐去），本体只以悬浮小卡（ghost）示人。
 * Push 271（业务口径 2026-10-10「卡片拖动大小不要改变要原尺寸」）：ghost 改成被拖便签 1:1 原尺寸复刻（同款便签卡组件 + 抓取点偏移跟手，大小不缩水）；
 * 落点提示挪到 ghost 顶部的小黑签（松手，收进「已完成」/ 松手，恢复为未完成）。
 * 侧栏脚注「数据保存在账号里（换设备可见）」撤除（只留「共 N 条便签」）。
 * 用户分类可删（Push 271）：行悬停出 ×，行内两步确认；删分类不删便签（有便签先整批移入「其他」，没有「其他」则第一条剩余分类）；
 * 最后一个分类不可删；全部便签 / 已完成 固定不可删。
 * 背景色切换（Push 271 · 业务口径 2026-10-10「在如图的位置增加背景颜色切换 默认是和别的页面统一颜色 第二个颜色是minimemo的默认颜色」→
 * 「还有很多种颜色啊为什么不写了 而且为什么选中的效果也不一样」→「把玫红颜色删除掉」→「颜色选择组件要弹出选择 不要常驻 箭头旁边名称叫 背景颜色」→「搜索往右靠然后颜色选择不要下滑 要向右滑」→「背景颜色文字一开始不显示 鼠标触碰按钮才显示」）：
 * 工具条左端 = 「背景颜色」箭头按钮（照参考组件：深色圆 + 白箭头 + 文字），点击弹出颜色面板（不常驻；从按钮右侧滑出、顶对齐按钮 = 不下滑）；展开 / 悬停时圆铺满成胶囊、箭头右移、文字转白，收起时只露圆 + 箭头（「背景颜色」文字悬停 / 展开才浮现）；
 * 面板内 = 色块紧贴成一整条（墨框 + 硬投影连片 + 圆角叠角；悬停 1.5 / 邻 1.3 / 次邻 1.15 联动 + 冒色名签；点击 / 选中不改色块外观）；
 * 色板 = 统一白（默认，与全站页面一致）/ 奶白（#fdfbf7 + 左上暖色径向渐变，参考页默认底色）/ 参考组件 9 色板（粉…薰衣草，实色铺底；玫红下架）；选中即整面 PATCH（随账号落库 · 换设备可见）。
 * 用户分类删除的触发件 = 项目同款删除胶囊（RowDeleteButton：行悬停浮现幽灵垃圾桶，悬停展开成红色「删除」胶囊）。
 */

const BTN_PRIMARY =
  "inline-flex items-center gap-[7px] rounded-[11px] border border-[#1c1917] bg-[#1c1917] px-3.5 py-[9px] text-[13px] font-medium text-[#fdfbf7] shadow-[0_1px_2px_rgba(28,25,23,0.05),0_10px_26px_-16px_rgba(28,25,23,0.22)] transition hover:-translate-y-px hover:bg-[#292524] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:translate-y-0";

/** 拖拽落点（Push 269）：done = 侧栏「完成」区域；all =「全部便签」（把已完成的拖回来恢复）。
 *  Push 271：w / offX / offY = 原卡宽度与抓取点偏移（ghost 1:1 原尺寸复刻、跟手不跳）。 */
type PlanDragState = { noteId: string; done: boolean; x: number; y: number; over: "done" | "all" | null; w: number; offX: number; offY: number };

/* ----- 图标（照参考页同款的细线性图标；系统内联 SVG 口径） ----- */

function FolderOpenIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4 shrink-0" aria-hidden="true">
      <path
        d="m6 14 1.45-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.55 6a2 2 0 0 1-1.94 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.93a2 2 0 0 1 1.66.9l.82 1.2a2 2 0 0 0 1.66.9H18a2 2 0 0 1 2 2v2"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function TagIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4 shrink-0" aria-hidden="true">
      <path
        d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="7.5" cy="7.5" r="1" fill="currentColor" />
    </svg>
  );
}

function CheckCircleIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4 shrink-0" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" />
      <path d="m8.4 12.3 2.5 2.5 4.7-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4 shrink-0" aria-hidden="true">
      <path d="M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <path d="M12 5v14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function NoteIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" className="h-[30px] w-[30px]" aria-hidden="true">
      <path
        d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v7.9L13.4 21H6.5A2.5 2.5 0 0 1 4 18.5Z"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M20 13.5h-4.6a1.9 1.9 0 0 0-1.9 1.9V21"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/* ----- 分类栏条目（「全部便签」/「已完成」+ 各分类；选中 = 墨黑底、右侧带条数） ----- */

function CategoryItem({
  value,
  label,
  icon,
  count,
  active,
  onClick,
  buttonRef,
  dropActive,
  onDelete,
}: {
  value: string;
  label: string;
  icon: ReactNode;
  count: number;
  active: boolean;
  onClick: () => void;
  /** 拖拽落点（Push 269）：仅「全部便签」用（把已完成的便签拖回来恢复）。 */
  buttonRef?: Ref<HTMLButtonElement>;
  dropActive?: boolean;
  /** 分类删除（Push 271）：仅用户分类给（行悬停浮现项目同款删除胶囊 RowDeleteButton）；全部便签 / 已完成 不给。
   *  行悬停时右侧计数淡出让位（「删除和数字叠起来了不好看」—— 两个控件不同时出现在同一位置）。 */
  onDelete?: () => void;
}) {
  const t = useT();
  return (
    <div className="group relative min-w-0">
      <button
        ref={buttonRef}
        type="button"
        data-plan-category={value}
        data-plan-drop-active={dropActive === true ? "true" : undefined}
        aria-pressed={active}
        onClick={onClick}
        className={
          "flex w-full items-center justify-between gap-2.5 rounded-full border border-[#e8e3da] px-3 py-1.5 text-[13.5px] transition lg:rounded-[11px] lg:border-0 lg:px-2.5 lg:py-[9px] " +
          (active ? "bg-[#1c1917] text-[#fdfbf7]" : "text-[#57534e] hover:bg-[#faf9f7]") +
          (dropActive === true ? " ring-2 ring-[#1c1917]/35" : "")
        }
      >
        <span className="inline-flex items-center gap-2">
          {icon}
          {label}
        </span>
        <span className={"hidden text-[11px] transition-opacity duration-200 lg:inline " + (active ? "opacity-[0.7]" : "opacity-[0.55]") + (onDelete === undefined ? "" : " group-hover:opacity-0")}>{count}</span>
      </button>
      {onDelete === undefined ? null : (
        <span data-plan-category-delete={value} className="absolute right-1.5 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-end">
          <RowDeleteButton label={t("row.delete.category", { name: label })} onDelete={onDelete} />
        </span>
      )}
    </div>
  );
}

/* ----- 工具条：搜索（照参考页搜索框材质） ----- */

/** 背景色切换（Push 271 · 业务口径 2026-10-10「在如图的位置增加背景颜色切换 默认是和别的页面统一颜色 第二个颜色是minimemo的默认颜色」→
 *  「还有很多种颜色啊为什么不写了 而且为什么选中的效果也不一样」→「效果不一样啊 另外选中是不用浮起来的」→「点击不要有变化即可」→「点击完毕还是弹起来了啊 没有回到原来的位置」→
 *  「你完全参考这个代码不行吗」→「把玫红颜色删除掉」→「颜色选择组件要弹出选择 不要常驻 箭头旁边名称叫 背景颜色」→「搜索往右靠然后颜色选择不要下滑 要向右滑」→「背景颜色文字一开始不显示 鼠标触碰按钮才显示」）：
 *  工具条左端 = 「背景颜色」箭头按钮（照参考组件：深色圆 + 白箭头 + 文字），点击弹出颜色面板（不常驻：再点按钮 / 点面板外 / Esc 收起；从按钮右侧滑出、顶对齐 = 不下滑；收起时只露圆 + 箭头，「背景颜色」文字悬停 / 展开才浮现；悬停 / 展开时圆铺满成胶囊、箭头右移、文字转白）；
 *  面板内 = 色块紧贴成条（-6px 叠角）+ 悬停 1.5 / 邻 1.3 / 次邻 1.15 联动（z 抬升防遮挡）+ 冒奶白色名签，缓动 500ms cubic-bezier(0.175,0.885,0.32,1.1)（照参考组件 1:1）；
 *  悬停「已选中」块 = 该块自身不放大（口径「选中是不用浮起来的」），邻居联动照常 —— 点击完毕时点击块自身立即落回原位、其余不塌陷（「点击完毕回到原来的位置」/「右边那个全压下去 源码不会这样」）；
 *  点击不带任何焦点残留：指针 / 触摸点击后主动 blur；选择颜色后面板保持打开（可连续试色）。
 *  排布追订（2026-10-10「搜索往右靠然后颜色选择不要下滑 要向右滑」）：颜色面板从按钮右侧滑出（左缘 = 按钮右缘 + 12px、顶对齐；240ms 弹性滑入 · 不下滑）；搜索框右靠（贴着「新建便签」）。 */
function BackgroundSwitcher({ value, onChange }: { value: PlanBoardBgId; onChange: (next: PlanBoardBgId) => void }) {
  const t = useT();
  const locale = useLocale();
  const [open, setOpen] = useState(false);
  const [hovered, setHovered] = useState<PlanBoardBgId | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return undefined;
    const onDocDown = (event: MouseEvent) => {
      if (rootRef.current !== null && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDocDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  const hoveredIndex = hovered === null ? -1 : PLAN_BOARD_BGS.findIndex((bg) => bg.id === hovered);
  return (
    <div ref={rootRef} data-plan-bg-root="" className="relative pl-0.5">
      <button
        type="button"
        data-plan-bg-trigger=""
        aria-haspopup="true"
        aria-expanded={open}
        onClick={(event) => {
          setOpen((prev) => !prev);
          if (event.detail > 0) event.currentTarget.blur();
        }}
        className="group/bg relative h-12 w-48 cursor-pointer rounded-full text-left"
      >
        <span
          aria-hidden="true"
          className={"absolute inset-y-0 left-0 rounded-full bg-[#1c1917] transition-all duration-[450ms] ease-[cubic-bezier(0.65,0,0.076,1)] " + (open ? "w-full" : "w-12 group-hover/bg:w-full")}
        />
        <span
          aria-hidden="true"
          className={"absolute left-0 top-0 grid h-12 w-12 place-items-center text-[#fdfbf7] transition-transform duration-[450ms] ease-[cubic-bezier(0.65,0,0.076,1)] " + (open ? "translate-x-4" : "group-hover/bg:translate-x-4")}
        >
          <svg viewBox="0 0 24 24" fill="none" className="h-[18px] w-[18px]">
            <path d="M5 12h12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className={"transition-opacity duration-[450ms] " + (open ? "opacity-100" : "opacity-0 group-hover/bg:opacity-100")} />
            <path d="m12 6 6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
        <span className={"absolute inset-y-0 left-[52px] right-0 flex items-center justify-center text-[14px] font-semibold transition-[opacity,color] duration-[450ms] " + (open ? "text-[#fdfbf7] opacity-100" : "text-[#1c1917] opacity-0 group-hover/bg:opacity-100 group-hover/bg:text-[#fdfbf7]")}>{t("plan.bgColor")}</span>
      </button>
      {open ? (
        <div
          data-plan-bg-panel=""
          className="plan-bg-panel-pop absolute left-[calc(100%+12px)] top-0 z-40 rounded-2xl border border-[#e8e3da] bg-white px-4 pb-4 pt-12 shadow-[0_1px_2px_rgba(28,25,23,0.05),0_18px_44px_-18px_rgba(28,25,23,0.28)]"
        >
          <div data-plan-bg-switch="" role="group" aria-label={t("plan.bgGroupAria")} className="flex items-center">
            {PLAN_BOARD_BGS.map((item, index) => {
              const active = value === item.id;
              const dist = hoveredIndex >= 0 ? Math.abs(index - hoveredIndex) : -1;
              const liftClass = dist === 0 ? (active ? "" : " scale-150") : dist === 1 ? " scale-[1.3]" : dist === 2 ? " scale-[1.15]" : "";
              const liftZ = dist === 0 ? (active ? undefined : 99999) : dist === 1 ? 9999 : dist === 2 ? 999 : undefined;
              return (
                <span
                  key={item.id}
                  onMouseEnter={() => setHovered(item.id)}
                  onMouseLeave={() => setHovered((h) => (h === item.id ? null : h))}
                  style={{ zIndex: liftZ }}
                  className={"group relative inline-flex" + (index === 0 ? "" : " -ml-[6px]") + " focus-within:z-20"}
                >
                  <button
                    type="button"
                    data-plan-bg-option={item.id}
                    data-plan-bg-active={active ? "true" : "false"}
                    aria-pressed={active}
                    aria-label={t("plan.bgOptionAria", { label: planLabelText(locale, item.label), hint: planLabelText(locale, item.hint) })}
                    onClick={(event) => {
                      onChange(item.id);
                      if (event.detail > 0) event.currentTarget.blur();
                    }}
                    style={{ background: item.swatch }}
                    className={"relative h-[34px] w-[34px] rounded-[8px] border-[2.5px] border-[#1c1917] shadow-[3.5px_3.5px_0_0_#1c1917] transition duration-500 ease-[cubic-bezier(0.175,0.885,0.32,1.1)] focus-visible:outline-none" + liftClass}
                  />
                  <span
                    data-plan-bg-tip=""
                    className="pointer-events-none absolute bottom-[calc(100%+9px)] left-1/2 z-30 -translate-x-1/2 whitespace-nowrap rounded-[8px] border-2 border-[#1c1917] bg-[#fef3c7] px-2 py-[3px] text-[11px] font-semibold text-[#1c1917] opacity-0 shadow-[2px_2px_0_0_#1c1917] transition-opacity duration-500 ease-[cubic-bezier(0.175,0.885,0.32,1.1)] group-hover:opacity-100"
                  >
                    {planLabelText(locale, item.label)}
                  </span>
                </span>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function BoardSearch({ value, onChange }: { value: string; onChange: (next: string) => void }) {
  const t = useT();
  return (
    <div data-plan-search="" className="relative ml-auto flex w-full max-w-[460px] flex-1 items-center">
      <span className="pointer-events-none absolute left-3 text-[#a8a29e]">
        <svg viewBox="0 0 24 24" fill="none" className="h-[18px] w-[18px]" aria-hidden="true">
          <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="2" />
          <path d="M20.5 20.5 16.2 16.2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      </span>
      <input
        type="search"
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
        }}
        placeholder={t("plan.searchPlaceholder")}
        aria-label={t("plan.searchPlaceholder")}
        className="w-full appearance-none rounded-xl border border-[#e8e3da] bg-white py-2.5 pl-9 pr-9 text-[13.5px] text-[#1c1917] outline-none transition placeholder:text-[#b6afa6] focus:border-[#d5cdbd] focus:ring-[3px] focus:ring-black/5 [&::-webkit-search-cancel-button]:hidden [&::-webkit-search-decoration]:hidden"
      />
      {value.length > 0 ? (
        <button
          type="button"
          aria-label={t("plan.searchClearAria")}
          onClick={() => {
            onChange("");
          }}
          className="absolute right-2 grid h-7 w-7 place-items-center rounded-lg text-[#78716c] transition hover:bg-black/5 hover:text-[#1c1917]"
        >
          <svg viewBox="0 0 24 24" fill="none" className="h-3.5 w-3.5" aria-hidden="true">
            <path d="M6 6l12 12M18 6 6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </button>
      ) : null}
    </div>
  );
}

/* ----- 空态（照参考页：虚线圆角容器 + 圆形图标 + 新建按钮） ----- */

function BoardEmpty({ title, text, onNew }: { title: string; text: string; onNew?: () => void }) {
  const t = useT();
  return (
    <div
      data-plan-empty=""
      className="flex flex-col items-center gap-2.5 rounded-[22px] border-[1.5px] border-dashed border-[#e8e3da] bg-[#faf9f7] px-5 py-[90px] text-center"
    >
      <span className="grid h-[62px] w-[62px] place-items-center rounded-full bg-[#f1ece3] text-[#a8a29e]">
        <NoteIcon />
      </span>
      <p className="mt-1.5 text-base font-semibold text-[#1c1917]">{title}</p>
      <p className="mb-2.5 text-[13px] text-[#78716c]">{text}</p>
      {onNew === undefined ? null : (
        <button type="button" data-plan-empty-new="" onClick={onNew} className={BTN_PRIMARY}>
          <PlusIcon />
          {t("plan.newNote")}
        </button>
      )}
    </div>
  );
}

/**
 * 便签墙主体：工具条（搜索 / 新建便签 —— 排序已下架）+ 左侧分类栏（全部便签 / 已完成 / 各分类）+「问候 + 标题 + 计数」头部 + 便签网格；
 * 点卡片进编辑弹窗（PlanNoteEditor —— 便签底色整卡铺底 + 顶栏关闭 X / 7 色圆点 / 字体 Aa 分段器 + 大标题 / 记录区 + 分类胶囊 +
 * 底栏「更新于」+ 删除 + 保存）；完成 / 恢复 = 拖拽（Push 269：便签拖进「完成」区 / 「已完成」里拖回「全部便签」）。不做导出 / 导入（业务口径 2026-10-10「导出导入功能不要」）。
 */
export function MyPlanBoard() {
  const t = useT();
  const locale = useLocale();
  const [board, setBoard] = useState<PlanBoard | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  const [keyword, setKeyword] = useState("");
  const [category, setCategory] = useState<string | null>(null);
  const [doneOnly, setDoneOnly] = useState(false);
  /** 编辑弹窗：null = 关着；note null = 新建。 */
  const [editor, setEditor] = useState<{ note: PlanNote | null } | null>(null);
  const [notice, setNotice] = useState<{ kind: "ok" | "error" | "info"; text: string } | null>(null);
  const [addingCategory, setAddingCategory] = useState(false);
  const [newCategory, setNewCategory] = useState("");
  /** 分类删除（Push 271）：正在等确认删除的分类名（null = 无；全部便签 / 已完成 固定不可删）。 */
  const [categoryConfirm, setCategoryConfirm] = useState<string | null>(null);
  /** 上云串行链：多笔提交按顺序落库（每笔都是整面便签墙，顺序错乱会互相覆盖）。 */
  const saveChain = useRef<Promise<void>>(Promise.resolve());
  const revision = useRef(0);
  const createdNoteId = useRef<string | null>(null);
  const pendingSaves = useRef(0);
  const failed = useRef(false);
  const [unsaved, setUnsaved] = useState(false);
  const [conflict, setConflict] = useState<{ board: PlanBoard; revision: number } | null>(null);


  /** 拖拽（Push 269）：便签卡按下后交给这里（超 6px 阈值才算拖）；中途高亮落点，松手落点决定完成 / 恢复。 */
  const [drag, setDrag] = useState<PlanDragState | null>(null);
  const doneZoneRef = useRef<HTMLDivElement | null>(null);
  const allItemRef = useRef<HTMLButtonElement | null>(null);
  /** 拖完松手会顺带触发一次 click —— 用时间戳挡掉，避免误开编辑弹窗。 */
  const suppressOpenAtRef = useRef(0);

  /**
   * 打开读面：GET 偏好 → 首次（账号里从未保存）预置示例上云；本机旧键（Push ≤ 267 的 localStorage）
   * 在账号没数据（或账号为空板而旧键有便签）时迁移上云再清键；迁移失败保留旧键、本机数据兜底展示、下轮打开重试。
   */
  useEffect(() => {
    let alive = true;
    setBoard(null);
    setLoadFailed(false);
    void (async () => {
      try {
        const prefs = await loadMyPreferences();
        if (!alive) {
          return;
        }
        const remote = prefs.myPlanBoard;
        revision.current = prefs.revisions?.myPlanBoard ?? 0;
        const legacy = readLegacyPlanBoard();
        if (legacy !== null) {
          const shouldMigrate = remote.updatedAt === null || (remote.notes.length === 0 && legacy.notes.length > 0);
          if (shouldMigrate) {
            try {
              const saved = await saveMyPlanBoard(legacy, revision.current);
              if (!alive) {
                return;
              }
              revision.current = saved.revisions?.myPlanBoard ?? revision.current + 1;
              clearLegacyPlanBoard();
              setBoard({ notes: saved.myPlanBoard.notes, categories: saved.myPlanBoard.categories, bg: planBoardBgOf(saved.myPlanBoard.bg).id });
              return;
            } catch (error) {
              if (error instanceof ApiError && error.status === 409) {
                const latest = await loadMyPreferences();
                if (alive) { revision.current = latest.revisions?.myPlanBoard ?? 0; setBoard(latest.myPlanBoard); }
                return;
              }
              failed.current = true;
              setUnsaved(true);
              if (!alive) {
                return;
              }
              setBoard(legacy);
              return;
            }
          }
          clearLegacyPlanBoard();
          setBoard({ notes: remote.notes, categories: remote.categories, bg: planBoardBgOf(remote.bg).id });
          return;
        }
        if (remote.updatedAt === null) {
          const seeded = seedPlanBoard();
          setBoard(seeded);
          try {
            const saved = await saveMyPlanBoard(seeded, revision.current);
            revision.current = saved.revisions?.myPlanBoard ?? revision.current + 1;
          } catch (error) {
            if (error instanceof ApiError && error.status === 409) {
              const latest = await loadMyPreferences();
              if (alive) { revision.current = latest.revisions?.myPlanBoard ?? 0; setBoard(latest.myPlanBoard); }
            } else { failed.current = true; setUnsaved(true); }
          }
          return;
        }
        setBoard({ notes: remote.notes, categories: remote.categories, bg: planBoardBgOf(remote.bg).id });
      } catch {
        if (alive) {
          setLoadFailed(true);
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [reloadToken]);

  useLiveRefresh(["preferences"], async () => {
    const prefs = await loadMyPreferences();
    return () => {
      revision.current = prefs.revisions?.myPlanBoard ?? 0;
      setBoard((previous) => previous === null ? prefs.myPlanBoard : { ...prefs.myPlanBoard, notes: keepLiveOrder(previous.notes, prefs.myPlanBoard.notes) });
    };
  }, "my-plan", board !== null, { paused: () => failed.current || pendingSaves.current > 0 || editor !== null || addingCategory || categoryConfirm !== null || drag !== null });

  /** Failed queued writes remain dirty; only an explicit conflict decision advances their baseline. */
  const commit = (next: PlanBoard, okText?: string): Promise<boolean> => {
    setBoard(next);
    setUnsaved(true);
    pendingSaves.current += 1;
    const operation = saveChain.current.then(async () => {
      if (failed.current) { pendingSaves.current -= 1; return false; }
      try {
        const saved = await saveMyPlanBoard(next, revision.current);
        revision.current = saved.revisions?.myPlanBoard ?? revision.current + 1;
        if (okText !== undefined) setNotice({ kind: "ok", text: okText });
        return true;
      } catch (error) {
        failed.current = true;
        if (error instanceof ApiError && error.status === 409) {
          const latest = await loadMyPreferences().catch(() => null);
          if (latest !== null) setConflict({ board: latest.myPlanBoard, revision: latest.revisions?.myPlanBoard ?? 0 });
        }
        setNotice({ kind: "error", text: error instanceof ApiError ? error.message : t("plan.saveFailedNotice") });
        return false;
      } finally {
        pendingSaves.current -= 1;
        if (pendingSaves.current === 0 && !failed.current) setUnsaved(false);
      }
    });
    saveChain.current = operation.then(() => {});
    return operation;
  };

  const handleSaveNote = (draft: PlanNoteDraft): Promise<boolean> => {
    if (editor === null || board === null) {
      return Promise.resolve(false);
    }
    const now = new Date().toISOString();
    const existing = editor.note;
    if (existing === null) {
      if (board.notes.length >= PLAN_NOTE_LIMIT) {
        setEditor(null);
        setNotice({ kind: "error", text: t("plan.limitNotice", { n: PLAN_NOTE_LIMIT }) });
        return Promise.resolve(false);
      }
      const note: PlanNote = { id: createdNoteId.current ?? newPlanNoteId(), title: draft.title, content: draft.content, category: draft.category, colorId: draft.colorId, fontId: draft.fontId, done: false, createdAt: now, updatedAt: now };
      createdNoteId.current = note.id;
      if (doneOnly) {
        setDoneOnly(false);
      }
      return commit({ notes: [note].concat(board.notes.filter((item) => item.id !== note.id)), categories: board.categories, bg: board.bg });
    } else {
      const notes = board.notes.map((item) => (item.id === existing.id ? { ...item, ...draft, updatedAt: now } : item));
      return commit({ notes, categories: board.categories, bg: board.bg });
    }
  };

  const handleDeleteNote = (): void => {
    if (editor === null || editor.note === null || board === null) {
      return;
    }
    const target = editor.note;
    void commit({ notes: board.notes.filter((item) => item.id !== target.id), categories: board.categories, bg: board.bg }, t("plan.deletedNote")).then((ok) => { if (ok) { setEditor(null); createdNoteId.current = null; } });
  };

  /** 完成 / 恢复（Push 269 · 拖拽）：落一次整面 PATCH（乐观更新 + 串行上云）。 */
  const setNoteDone = (noteId: string, done: boolean): void => {
    if (board === null) {
      return;
    }
    const now = new Date().toISOString();
    const notes = board.notes.map((item) => (item.id === noteId ? { ...item, done, updatedAt: now } : item));
    commit({ notes, categories: board.categories, bg: board.bg }, done ? t("plan.doneNotice") : t("plan.undoneNotice"));
  };

  /** 背景色切换（Push 271）：选中即整面 PATCH（bg 随账号落库 · 换设备可见）；重复点当前项不动。 */
  const handleSwitchBg = (next: PlanBoardBgId): void => {
    if (board === null || board.bg === next) {
      return;
    }
    commit({ notes: board.notes, categories: board.categories, bg: next }, t("plan.bgSwitched", { name: planLabelText(locale, planBoardBgOf(next).label) }));
  };

  /** 命中测试（Push 270：完成区 = 整条左栏）：拖未完成便签 → 认左栏「完成」区（含分类卡区域）；拖已完成便签 → 只认「全部便签」行。 */
  const dragHit = (x: number, y: number, fromDone: boolean): "done" | "all" | null => {
    const inside = (node: HTMLElement | null): boolean => {
      if (node === null) {
        return false;
      }
      const rect = node.getBoundingClientRect();
      return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
    };
    if (!fromDone && inside(doneZoneRef.current)) {
      return "done";
    }
    if (fromDone && inside(allItemRef.current)) {
      return "all";
    }
    return null;
  };

  /** 拖拽起点（Push 269）：按住便签卡 —— 超过 6px 才算拖（否则仍是点开编辑）；松手落在落点上即完成 / 恢复。 */
  const handleNotePointerDown = (note: PlanNote, event: ReactPointerEvent<HTMLButtonElement>): void => {
    if (event.button !== 0) {
      return;
    }
    suppressOpenAtRef.current = 0;
    const startX = event.clientX;
    const startY = event.clientY;
    /** Push 271：抓取点偏移 + 原卡宽度 —— ghost 按 1:1 原尺寸跟手。 */
    const grabRect = event.currentTarget.getBoundingClientRect();
    const grabX = event.clientX - grabRect.left;
    const grabY = event.clientY - grabRect.top;
    const grabW = grabRect.width;
    let active = false;
    const handleMove = (moveEvent: PointerEvent): void => {
      if (!active) {
        if (Math.abs(moveEvent.clientX - startX) < 6 && Math.abs(moveEvent.clientY - startY) < 6) {
          return;
        }
        active = true;
      }
      setDrag({ noteId: note.id, done: note.done, x: moveEvent.clientX, y: moveEvent.clientY, over: dragHit(moveEvent.clientX, moveEvent.clientY, note.done), w: grabW, offX: grabX, offY: grabY });
    };
    const handleUp = (upEvent: PointerEvent): void => {
      cleanup();
      setDrag(null);
      if (!active) {
        return;
      }
      suppressOpenAtRef.current = Date.now();
      const over = dragHit(upEvent.clientX, upEvent.clientY, note.done);
      if (over === "done") {
        setNoteDone(note.id, true);
      } else if (over === "all") {
        setNoteDone(note.id, false);
      }
    };
    const handleCancel = (): void => {
      cleanup();
      setDrag(null);
    };
    function cleanup(): void {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
      window.removeEventListener("pointercancel", handleCancel);
    }
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
    window.addEventListener("pointercancel", handleCancel);
  };

  /** 拖动期间禁掉正文选中（松手 / 取消即恢复）。 */
  const dragging = drag !== null;
  useEffect(() => {
    if (!dragging) {
      return;
    }
    const previous = document.body.style.userSelect;
    document.body.style.userSelect = "none";
    return () => {
      document.body.style.userSelect = previous;
    };
  }, [dragging]);

  const handleAddCategory = (name: string): void => {
    if (board === null) {
      return;
    }
    const normalized = normalizePlanCategoryName(name);
    if (normalized === "" || board.categories.includes(normalized) || board.categories.length >= PLAN_CATEGORY_MAX) {
      return;
    }
    commit({ notes: board.notes, categories: board.categories.concat(normalized), bg: board.bg });
  };

  /** 分类删除（Push 271）：删分类不删便签 —— 分类下仍有便签时整批移入「其他」（没有「其他」则第一条剩余分类）。 */
  const handleDeleteCategory = (name: string): void => {
    if (board === null) {
      return;
    }
    const remaining = board.categories.filter((item) => item !== name);
    if (remaining.length === 0) {
      setCategoryConfirm(null);
      setNotice({ kind: "info", text: t("plan.keepOneCategory") });
      return;
    }
    const moveTo = remaining.includes("其他") ? "其他" : remaining[0];
    const moved = board.notes.filter((item) => item.category === name).length;
    const now = new Date().toISOString();
    const notes = board.notes.map((item) => (item.category === name ? { ...item, category: moveTo, updatedAt: now } : item));
    if (category === name) {
      setCategory(null);
    }
    setCategoryConfirm(null);
    commit(
      { notes, categories: remaining, bg: board.bg },
      moved > 0
        ? t("plan.categoryDeletedMoved", { name, n: moved, moveTo })
        : t("plan.categoryDeleted", { name }),
    );
  };

  /** 分类删除第一步（Push 271）：点行内 × —— 最后一个分类不删（提示），其余进入行内确认。 */
  const requestDeleteCategory = (name: string): void => {
    if (board === null || categoryConfirm !== null) {
      return;
    }
    if (board.categories.length <= 1) {
      setNotice({ kind: "info", text: t("plan.keepOneCategory") });
      return;
    }
    setCategoryConfirm(name);
  };

  /** 分类栏「新建分类」：回车 / 失焦提交（空 = 放弃）；已在表里 = 直接选中；到 12 类上限 = 不加。 */
  const commitNewCategory = (): void => {
    const name = normalizePlanCategoryName(newCategory);
    setAddingCategory(false);
    setNewCategory("");
    if (name === "" || board === null) {
      return;
    }
    if (board.categories.includes(name)) {
      setCategory(name);
      return;
    }
    if (board.categories.length >= PLAN_CATEGORY_MAX) {
      return;
    }
    handleAddCategory(name);
    setCategory(name);
  };

  if (board === null) {
    return (
      <section
        data-workspace-plan=""
        className="-mx-6 -mb-10 -mt-5 min-h-[calc(100dvh-8rem)] bg-white px-6 pb-10 pt-6"
      >
        <div className="mx-auto w-full max-w-[1240px]">
          {loadFailed ? (
            <div data-plan-load-failed="" className="rounded-[18px] border border-dashed border-[#e8e3da] bg-white px-6 py-12 text-center">
              <p className="text-sm text-[#57534e]">{t("plan.loadFailed")}</p>
              <p className="mt-1.5 text-xs text-[#a8a29e]">{t("plan.loadFailedHint")}</p>
              <button
                type="button"
                data-plan-load-retry=""
                onClick={() => {
                  setReloadToken((token) => token + 1);
                }}
                className={BTN_PRIMARY + " mt-4"}
              >
                {t("common.reload")}
              </button>
            </div>
          ) : (
            <div data-plan-loading="" className="flex justify-center py-[120px]">
              <Loader />
            </div>
          )}
        </div>
      </section>
    );
  }

  const visible = orderPlanNotes(filterPlanNotes(board.notes.filter((note) => note.done === doneOnly), keyword, doneOnly ? null : category));
  const activeCount = board.notes.filter((note) => !note.done).length;
  const doneCount = board.notes.filter((note) => note.done).length;
  const heading = doneOnly ? t("plan.done") : category === null ? t("plan.allNotes") : category;
  const dragFromDone = drag !== null && drag.done;
  const overDone = drag !== null && drag.over === "done";
  const overAll = drag !== null && drag.over === "all";
  const dragNote = drag === null ? null : board.notes.find((item) => item.id === drag.noteId) ?? null;
  /** 完成区（Push 270）：整条左栏 = 虚线框住的大拖放区（分类卡嵌在里面，下方剩余空间给「完成」提示）。 */
  const zoneClass =
    "flex min-w-0 flex-col gap-2.5 rounded-[18px] border-[1.5px] p-2 transition lg:sticky lg:top-[124px] lg:self-start lg:min-h-[calc(100dvh-176px)] " +
    (overDone
      ? "border-solid border-[#1c1917] bg-[#1c1917] text-[#fdfbf7] shadow-[0_10px_26px_-16px_rgba(28,25,23,0.5)]"
      : dragging
        ? dragFromDone
          ? "border-dashed border-[#d5cdbd] bg-[#faf9f7]/60 text-[#78716c] opacity-45"
          : "border-solid border-[#1c1917] bg-white text-[#1c1917]"
        : "border-dashed border-[#d5cdbd] bg-[#faf9f7]/60 text-[#78716c]");

  return (
    <section
      data-workspace-plan=""
      style={{ background: planBoardBgOf(board.bg).canvas }}
      className="-mx-6 -mb-10 -mt-5 min-h-[calc(100dvh-8rem)] bg-white px-6 pb-10 pt-6"
    >
      <div className="mx-auto w-full max-w-[1240px]">
        <div className="flex flex-wrap items-center gap-3">
          <BackgroundSwitcher
            value={board.bg}
            onChange={handleSwitchBg}
          />
          <BoardSearch value={keyword} onChange={setKeyword} />
          <span className="flex items-center gap-2">
            <button
              type="button"
              data-plan-new=""
              onClick={() => {
                createdNoteId.current = null;
    setEditor({ note: null });
              }}
              className={BTN_PRIMARY}
            >
              <PlusIcon />
              {t("plan.newNote")}
            </button>
          </span>
        </div>

        <div className="mt-6 grid gap-6 lg:grid-cols-[252px_minmax(0,1fr)]">
          <div
            ref={doneZoneRef}
            data-plan-done-zone=""
            data-plan-done-zone-over={overDone ? "true" : "false"}
            className={zoneClass}
          >
          <aside className="flex flex-wrap content-start items-center gap-1.5 rounded-[18px] border border-[#e8e3da] bg-white p-3.5 shadow-[0_1px_2px_rgba(28,25,23,0.05),0_10px_26px_-16px_rgba(28,25,23,0.22)] lg:flex-col lg:flex-nowrap lg:items-stretch lg:gap-[3px]">
            <p className="mb-2 hidden px-2 pt-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-[#a8a29e] lg:block">{t("plan.category")}</p>
            <CategoryItem
              value="all"
              label={t("plan.allNotes")}
              icon={<FolderOpenIcon />}
              count={activeCount}
              active={!doneOnly && category === null}
              onClick={() => {
                setDoneOnly(false);
                setCategory(null);
              }}
              buttonRef={allItemRef}
              dropActive={overAll}
            />
            <CategoryItem
              value="done"
              label={t("plan.done")}
              icon={<CheckCircleIcon />}
              count={doneCount}
              active={doneOnly}
              onClick={() => {
                setDoneOnly(true);
                setCategory(null);
              }}
            />
            {board.categories.map((item) => {
              const itemCount = board.notes.filter((note) => !note.done && note.category === item).length;
              if (categoryConfirm === item) {
                const rest = board.categories.filter((name) => name !== item);
                const moveTo = rest.includes("其他") ? "其他" : rest[0];
                const total = board.notes.filter((note) => note.category === item).length;
                return (
                  <div
                    key={item}
                    data-plan-category-confirm={item}
                    className="w-full rounded-[14px] border border-dashed border-[#d5cdbd] bg-white px-3 py-2.5 text-left"
                  >
                    <p className="text-[12.5px] font-semibold text-[#1c1917]">{t("plan.categoryDeleteTitle", { name: item })}</p>
                    <p className="mt-0.5 text-[11.5px] text-[#a8a29e]">
                      {total > 0 ? t("plan.categoryDeleteMoved", { n: total, moveTo }) : t("plan.categoryDeleteEmpty")}
                    </p>
                    <div className="mt-2 flex items-center gap-2">
                      <button
                        type="button"
                        data-plan-category-confirm-delete=""
                        onClick={() => {
                          handleDeleteCategory(item);
                        }}
                        className="rounded-full bg-[#1c1917] px-3 py-1 text-[12px] font-medium text-[#fdfbf7] transition hover:bg-[#292524]"
                      >
                        {t("common.delete")}
                      </button>
                      <button
                        type="button"
                        data-plan-category-confirm-cancel=""
                        onClick={() => {
                          setCategoryConfirm(null);
                        }}
                        className="rounded-full border border-[#e8e3da] bg-white px-3 py-1 text-[12px] text-[#57534e] transition hover:bg-[#faf9f7]"
                      >
                        {t("common.cancel")}
                      </button>
                    </div>
                  </div>
                );
              }
              return (
                <CategoryItem
                  key={item}
                  value={item}
                  label={item}
                  icon={<TagIcon />}
                  count={itemCount}
                  active={!doneOnly && category === item}
                  onClick={() => {
                    setDoneOnly(false);
                    setCategory(category === item ? null : item);
                  }}
                  onDelete={() => {
                    requestDeleteCategory(item);
                  }}
                />
              );
            })}
            {addingCategory ? (
              <input
                autoFocus
                data-plan-category-new=""
                value={newCategory}
                maxLength={PLAN_CATEGORY_NAME_MAX}
                onChange={(event) => {
                  setNewCategory(event.target.value);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    commitNewCategory();
                  }
                  if (event.key === "Escape") {
                    setAddingCategory(false);
                    setNewCategory("");
                  }
                }}
                onBlur={commitNewCategory}
                placeholder={t("plan.newCategoryPlaceholder")}
                className="w-full rounded-full border border-dashed border-[#d5cdbd] bg-[#faf9f7] px-3 py-2 text-[13px] text-[#1c1917] outline-none transition placeholder:text-[#b6afa6] focus:border-solid focus:border-[#1c1917] focus:bg-white lg:rounded-[11px]"
              />
            ) : (
              <button
                type="button"
                data-plan-category-add=""
                disabled={board.categories.length >= PLAN_CATEGORY_MAX}
                title={board.categories.length >= PLAN_CATEGORY_MAX ? t("plan.categoryMaxTitle", { n: PLAN_CATEGORY_MAX }) : t("plan.addCategoryTitle")}
                onClick={() => {
                  setAddingCategory(true);
                }}
                className="flex items-center gap-1.5 rounded-full border border-dashed border-[#e8e3da] px-3 py-1.5 text-[13px] text-[#a8a29e] transition hover:border-[#d5cdbd] hover:bg-[#faf9f7] hover:text-[#1c1917] disabled:cursor-not-allowed disabled:opacity-50 lg:rounded-[11px] lg:px-2.5 lg:py-[9px]"
              >
                <PlusIcon />
                {t("plan.newCategory")}
              </button>
            )}
            <div className="mt-2 hidden gap-[3px] border-t border-dashed border-[#e8e3da] px-2 pb-1 pt-3 text-[11.5px] text-[#a8a29e] lg:grid">
              <p data-plan-count="">{t("plan.noteCount", { n: activeCount })}</p>
            </div>
          </aside>

          <div className="flex flex-col items-center justify-center gap-0.5 rounded-[14px] px-3 py-6 text-center lg:flex-1">
            <span className={"grid h-9 w-9 place-items-center rounded-full " + (overDone ? "bg-white/[0.14]" : "bg-[#efeae1]")}>
              <CheckCircleIcon />
            </span>
            <span className="mt-2 block text-[13.5px] font-semibold">{t("plan.doneZone")}</span>
            <span className="mt-0.5 block text-[11.5px] opacity-80">{overDone ? t("plan.dropDone") : dragFromDone ? t("plan.dragFromDoneHint") : t("plan.dragToDoneHint")}</span>
          </div>
          </div>

          <div className="flex min-w-0 flex-col gap-[18px]">
            <div className="flex items-end justify-between gap-4">
              <div>
                <p className="mb-1 text-[12.5px] tracking-[0.16em] text-[#a8a29e]">{planGreeting(locale)}</p>
                <h1 className="flex items-center gap-2.5 text-[30px] font-bold tracking-[-0.02em] text-[#1c1917]">
                  {heading}
                  <span className="rounded-full bg-[#efeae1] px-2.5 py-[3px] text-xs font-semibold text-[#57534e]">{visible.length}</span>
                </h1>
                {doneOnly ? (
                  <p data-plan-done-hint="" className="mb-0.5 mt-1.5 text-[12.5px] text-[#a8a29e]">{t("plan.doneHint")}</p>
                ) : null}
              </div>
              {keyword.trim() === "" ? null : <p className="pb-1 text-[12.5px] text-[#78716c]">{t("plan.searching", { keyword: keyword.trim() })}</p>}
            </div>

            {board.notes.length === 0 ? (
              <BoardEmpty
                title={t("plan.empty.title")}
                text={t("plan.empty.text")}
                onNew={() => {
                  createdNoteId.current = null;
                  setEditor({ note: null });
                }}
              />
            ) : doneOnly && doneCount === 0 ? (
              <BoardEmpty title={t("plan.emptyDone.title")} text={t("plan.emptyDone.text")} />
            ) : visible.length === 0 ? (
              <BoardEmpty
                title={t("plan.emptySearch.title")}
                text={t("plan.emptySearch.text")}
                onNew={() => {
                  createdNoteId.current = null;
                  setEditor({ note: null });
                }}
              />
            ) : (
              <div data-plan-grid="" className="grid grid-cols-[repeat(auto-fill,minmax(228px,1fr))] content-start gap-4">
                {visible.map((note) => {
                  const lifted = drag !== null && drag.noteId === note.id;
                  return (
                    <div key={note.id} data-live-card={note.id} className="relative min-w-0">
                      <PlanNoteCard
                        note={note}
                        lifted={lifted}
                        onOpen={() => {
                          if (Date.now() - suppressOpenAtRef.current < 350) {
                            return;
                          }
                          setEditor({ note });
                        }}
                        onPointerDown={(event) => {
                          handleNotePointerDown(note, event);
                        }}
                      />
                      {lifted ? (
                        <div data-plan-note-lift="" className="pointer-events-none absolute inset-0 rounded-[18px] border-2 border-dashed border-[#ded6c8] bg-[#faf9f7]/70" />
                      ) : null}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>

      {drag === null || dragNote === null ? null : (
        <div
          data-plan-drag-ghost=""
          style={{ left: drag.x - drag.offX, top: drag.y - drag.offY, width: drag.w }}
          className="pointer-events-none fixed z-[60] rotate-[-3deg]"
        >
          <div className="relative rounded-[18px] shadow-[0_24px_44px_-20px_rgba(28,25,23,0.5)]">
            <PlanNoteCard note={dragNote} onOpen={() => {}} />
            <span className="absolute left-1/2 top-0 -translate-x-1/2 -translate-y-1/2 whitespace-nowrap rounded-full bg-[#1c1917] px-2.5 py-1 text-[11px] font-medium text-[#fdfbf7] shadow-[0_8px_18px_-10px_rgba(28,25,23,0.7)]">
              {drag.over === "done" ? t("plan.dropDone") : drag.over === "all" ? t("plan.dropRestore") : dragNote.done ? t("plan.dragToAllHint") : t("plan.dragToDoneZoneHint")}
            </span>
          </div>
        </div>
      )}

      {unsaved && failed.current ? (
        <div data-plan-unsaved="" className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900" role="status">
          <p>{t("plan.unsavedLead")}{conflict === null ? t("plan.unsavedRetry") : t("plan.unsavedConflict")}</p>
          {conflict === null ? (
            <button type="button" className="mt-2 underline" onClick={() => { failed.current = false; void commit(board); }}>{t("plan.retrySave")}</button>
          ) : (
            <>
              <details className="mt-2"><summary>{t("plan.viewRemote")}</summary>{conflict.board.notes.map((note) => <p key={note.id} className="whitespace-pre-wrap py-1">{note.title + "：" + note.content}</p>)}</details>
              <button type="button" className="mt-2 mr-4 underline" onClick={() => { setBoard(conflict.board); revision.current = conflict.revision; setConflict(null); failed.current = false; setUnsaved(false); setEditor(null); }}>{t("plan.takeRemote")}</button>
              <button type="button" className="mt-2 underline" onClick={() => { revision.current = conflict.revision; setConflict(null); failed.current = false; void commit(board); }}>{t("plan.overwriteRemote")}</button>
            </>
          )}
        </div>
      ) : null}
      {notice === null ? null : (
        <Toast
          kind={notice.kind}
          text={notice.text}
          onClose={() => {
            setNotice(null);
          }}
          anchor={{ name: "data-plan-toast", value: notice.kind }}
        />
      )}

      {editor === null ? null : (
        <PlanNoteEditor
          note={editor.note}
          categories={board.categories}
          onSave={handleSaveNote}
          saveError={unsaved && failed.current ? notice?.text ?? t("plan.unsavedKept") : undefined}
          conflictSummary={
            conflict === null
              ? undefined
              : t("plan.conflictSummary", {
                  categories: conflict.board.categories.join(locale === "en" ? ", " : "、"),
                  bg: planLabelText(locale, planBoardBgOf(conflict.board.bg).label),
                  notes: conflict.board.notes
                    .map((note) =>
                      t("plan.conflictNote", {
                        title: note.title,
                        content: note.content,
                        category: note.category,
                        done: note.done ? t("plan.conflictNoteDone") : "",
                      }),
                    )
                    .join("\n"),
                })
          }
          onConfirmConflict={conflict === null ? undefined : (draft) => {
            revision.current = conflict.revision;
            failed.current = false;
            setConflict(null);
            return handleSaveNote(draft);
          }}
          onDelete={handleDeleteNote}
          onAddCategory={handleAddCategory}
          onClose={() => {
            setEditor(null);
            createdNoteId.current = null;
          }}
        />
      )}
    </section>
  );
}
