import { useT } from "../i18n";

/**
 * 任务表行内的删除按钮（Push 141，业务口径「不要这个笔作为编辑了…改成删除按钮吧」）：
 * 形态取自业务给的参考代码（圆 → 悬停展开成红底胶囊、浮出「删除」字样），尺寸与色彩按任务表行收小 / 收淡：
 * 静止 24px 幽灵态（无底色、浅灰垃圾桶图标，行悬停才浮现 —— 业务反馈「鼠标触碰列表时候黑的太突兀了 还是要比较看不出来吧」），
 * 悬停 / 聚焦展开到 48px 小号红胶囊（业务反馈「这个状态下有点太大了 要再小一点」），
 * 展开只吃 TaskBoard 任务描述列右侧预留的 48px 动作槽位、不挤动四格进度条与描述文字；图标放大下滑离场、文字同步浮出（参考代码同款节奏）。
 * Push 172：首页项目卡片复用同一个按钮（`label="删除项目"`），形态与行内一套、只有无障碍名不同。
 * Push 181：加 `scope` —— 模板面板标题行那枚用 `scope="panel"`（随面板浮现），面板里的卡片按钮保持默认（随卡片自己浮现）。
 */
export function RowDeleteButton({
  onDelete,
  label,
  text,
  scope = "default",
  wide = false,
}: {
  onDelete: () => void;
  label?: string;
  /** 悬停胶囊里的可见文字（缺省「删除」）；项目回收站用「彻底删除」。 */
  text?: string;
  /** 加宽展开态（四个汉字 / 英文长文案）。 */
  wide?: boolean;
  /**
   * 显示作用域（Push 181 业务口径「为什么我鼠标放上去全显示了 我不要这样的」）：
   * `default` = 随**最近的 `group`**（任务表行 / 项目卡片 / 任务节点卡片自己那一个）浮现；
   * `panel` = 随**所在模板面板**（`group/panel`）浮现 —— 用在「删除这份模板」这类面板级动作上，
   * 这样鼠标扫过面板时不会再让面板里每一张卡片的按钮一起亮。
   */
  scope?: "default" | "panel";
}) {
  const t = useT();
  const ariaLabel = label ?? t("row.delete.task");
  const visibleText = text ?? t("common.delete");
  return (
    <button
      type="button"
      data-row-delete=""
      aria-label={ariaLabel}
      title={ariaLabel}
      onClick={(event) => {
        event.stopPropagation();
        onDelete();
      }}
      onKeyDown={(event) => event.stopPropagation()}
      className={
        "group/del relative flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center overflow-hidden rounded-full bg-transparent text-zinc-300 opacity-0 transition-[width,background-color,color,opacity] duration-300 ease-out hover:bg-red-500 hover:text-white focus-visible:bg-red-500 focus-visible:text-white focus-visible:opacity-100 focus-visible:outline-none " +
        (wide ? "hover:w-20 focus-visible:w-20 " : "hover:w-12 focus-visible:w-12 ") +
        (scope === "panel" ? "group-hover/panel:opacity-100" : "group-hover:opacity-100")
      }
    >
      <span className="pointer-events-none absolute -translate-y-3 text-[11px] font-semibold opacity-0 transition-all duration-300 group-hover/del:translate-y-0 group-hover/del:opacity-100 group-focus-visible/del:translate-y-0 group-focus-visible/del:opacity-100">
        {visibleText}
      </span>
      <svg
        viewBox="0 0 448 512"
        aria-hidden="true"
        className="h-3 w-3 shrink-0 transition-all duration-300 group-hover/del:translate-y-4 group-hover/del:scale-[1.6] group-hover/del:opacity-0 group-focus-visible/del:translate-y-4 group-focus-visible/del:scale-[1.6] group-focus-visible/del:opacity-0"
      >
        <path
          fill="currentColor"
          d="M135.2 17.7L128 32H32C14.3 32 0 46.3 0 64S14.3 96 32 96H416c17.7 0 32-14.3 32-32s-14.3-32-32-32H320l-7.2-14.3C307.4 6.8 296.3 0 284.2 0H163.8c-12.1 0-23.2 6.8-28.6 17.7zM416 128H32L53.2 467c1.6 25.3 22.6 45 47.9 45H346.9c25.3 0 46.3-19.7 47.9-45L416 128z"
        />
      </svg>
    </button>
  );
}
