import { useT } from "../i18n";

/**
 * 节点库卡片的编辑按钮（Push 181，业务口径「任务节点编辑也要」）：
 * 形态与同卡片的 RowDeleteButton（红底胶囊删除）**成对**——静止 24px 幽灵态（浅灰铅笔，悬停卡片才浮现），
 * 悬停 / 聚焦展开到 48px 胶囊（底色用近黑，与红色删除拉开语义），图标放大下滑离场、文字同步浮出（同一套节奏）。
 * 只负责「点一下」（回调交给调用方：左列节点卡片 = 打开就地编辑表单）；模板面板里的卡片不挂编辑（节点名来自节点库，改名在库上做）。
 */
export function RowEditButton({ onEdit, label }: { onEdit: () => void; label?: string }) {
  const t = useT();
  const text = label ?? t("row.edit.node");
  return (
    <button
      type="button"
      aria-label={text}
      title={text}
      onClick={(event) => {
        event.stopPropagation();
        onEdit();
      }}
      onKeyDown={(event) => event.stopPropagation()}
      className="group/edit relative flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center overflow-hidden rounded-full bg-transparent text-zinc-300 opacity-0 transition-[width,background-color,color,opacity] duration-300 ease-out hover:w-12 hover:bg-zinc-900 hover:text-white focus-visible:w-12 focus-visible:bg-zinc-900 focus-visible:text-white focus-visible:opacity-100 focus-visible:outline-none group-hover:opacity-100"
    >
      <span className="pointer-events-none absolute -translate-y-3 text-[11px] font-semibold opacity-0 transition-all duration-300 group-hover/edit:translate-y-0 group-hover/edit:opacity-100 group-focus-visible/edit:translate-y-0 group-focus-visible/edit:opacity-100">
        {t("common.edit")}
      </span>
      <svg
        viewBox="0 0 512 512"
        aria-hidden="true"
        className="h-3 w-3 shrink-0 transition-all duration-300 group-hover/edit:translate-y-4 group-hover/edit:scale-[1.6] group-hover/edit:opacity-0 group-focus-visible/edit:translate-y-4 group-focus-visible/edit:scale-[1.6] group-focus-visible/edit:opacity-0"
      >
        <path
          fill="currentColor"
          d="M471.6 21.7c-21.9-21.9-57.3-21.9-79.2 0L362.3 51.7l97.9 97.9 30.1-30.1c21.9-21.9 21.9-57.3 0-79.2L471.6 21.7zm-299.2 220c-6.1 6.1-10.8 13.6-13.5 21.9l-29.6 88.8c-2.9 8.6-.6 18.1 5.8 24.6s15.9 8.7 24.6 5.8l88.8-29.6c8.2-2.7 15.7-7.4 21.9-13.5L437.7 172.3 339.7 74.3 172.4 241.7zM96 64C43 64 0 107 0 160V416c0 53 43 96 96 96H352c53 0 96-43 96-96V320c0-17.7-14.3-32-32-32s-32 14.3-32 32v96c0 17.7-14.3 32-32 32H96c-17.7 0-32-14.3-32-32V160c0-17.7 14.3-32 32-32h96c17.7 0 32-14.3 32-32s-14.3-32-32-32H96z"
        />
      </svg>
    </button>
  );
}
