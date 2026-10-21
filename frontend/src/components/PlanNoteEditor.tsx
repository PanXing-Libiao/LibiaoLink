import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { lockBodyScroll } from "../scrollLock";
import { useFocusTrapFor } from "./useFocusTrap";
import { planLabelText, useLocale, useT } from "../i18n";
import {
  PLAN_CATEGORY_MAX,
  PLAN_CATEGORY_NAME_MAX,
  PLAN_COLORS,
  PLAN_CONTENT_MAX,
  PLAN_FONTS,
  PLAN_TITLE_MAX,
  formatPlanFull,
  normalizePlanCategoryName,
  normalizePlanContent,
  normalizePlanTitle,
  planColorOf,
  planFontOf,
  type PlanColorId,
  type PlanFontId,
  type PlanNote,
} from "../myPlan";

/** 编辑结果（保存时回传；规范化在保存前完成）。 */
export type PlanNoteDraft = {
  title: string;
  content: string;
  category: string;
  colorId: PlanColorId;
  fontId: PlanFontId;
};

/**
 * 便签编辑（填写）弹窗 —— 形态照参考页 MiniMemo 的 NoteEditor 照搬（业务口径 2026-10-10「填写也要一样」）：
 * 整卡 = 所选便签底色铺底（描边 / 字色跟同一套色板，换色即时换底）；顶栏 = 关闭 X + 7 色圆点（选中 = 墨色描边）+ 字体 Aa 分段器（选中 = 墨底奶白）；
 * 正文 = 大标题（25px）+ 记录区（字型随手选字体档切换）；分类 = 胶囊行（选中 = 墨底，尾随「＋ 新分类」，可加至 12 类）；
 * 底栏 = 「更新于 YYYY年M月D日 HH:MM」（新建 = 「新建便签」）+ 删除（白底红图标）+ 墨黑「保存」（标题 / 内容都空 = 置灰）。
 * Push 269：完成 / 恢复改拖拽（便签拖进侧栏「完成」区即完成、「已完成」里拖回「全部便签」即恢复）—— 弹窗底栏不再有完成键。
 * 系统收口保留：Esc / 点遮罩 / 关闭 X = 放弃改动；键盘焦点陷阱（useFocusTrapFor）；背景滚动锁（lockBodyScroll）；删除二次确认；Ctrl / Cmd + Enter = 保存。
 */
export function PlanNoteEditor({
  note,
  categories,
  onSave,
  onDelete,
  onAddCategory,
  onClose,
  saveError,
  conflictSummary,
  onConfirmConflict,
}: {
  /** null = 新建。 */
  note: PlanNote | null;
  categories: readonly string[];
  onSave: (draft: PlanNoteDraft) => Promise<boolean>;
  onDelete: () => void;
  onAddCategory: (name: string) => void;
  onClose: () => void;
  saveError?: string;
  conflictSummary?: string;
  onConfirmConflict?: (draft: PlanNoteDraft) => Promise<boolean>;
}) {
  const t = useT();
  const locale = useLocale();
  const [title, setTitle] = useState(note?.title ?? "");
  const [content, setContent] = useState(note?.content ?? "");
  const [category, setCategory] = useState(note?.category ?? categories[0]);
  const [colorId, setColorId] = useState<PlanColorId>(note?.colorId ?? "yellow");
  const [fontId, setFontId] = useState<PlanFontId>(note?.fontId ?? "sans");
  const [addingCategory, setAddingCategory] = useState(false);
  const [newCategory, setNewCategory] = useState("");
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const currentDraft = useRef<PlanNoteDraft | null>(null);
  currentDraft.current = { title: normalizePlanTitle(title), content: normalizePlanContent(content), category, colorId, fontId };
  const dialogRef = useRef<HTMLDivElement | null>(null);
  useFocusTrapFor(dialogRef);
  useEffect(() => lockBodyScroll(), []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose]);

  const isEdit = note !== null;
  const color = planColorOf(colorId);
  const fontClass = planFontOf(fontId).className;
  const canSave = title.trim() !== "" || content.trim() !== "";
  const handleSave = async (confirmConflict = false) => {
    if (!canSave || savingRef.current || currentDraft.current === null) {
      return;
    }
    const submitted = currentDraft.current;
    savingRef.current = true;
    setSaving(true);
    try {
      const ok = await (confirmConflict && onConfirmConflict !== undefined ? onConfirmConflict(submitted) : onSave(submitted));
      // Keep text typed while this save was in flight; the next save uses our own returned revision.
      if (ok && JSON.stringify(currentDraft.current) === JSON.stringify(submitted)) onClose();
    } finally { savingRef.current = false; setSaving(false); }
  };

  /** 新建分类：回车 / 失焦提交（空 = 放弃）；已在表里 = 直接选中；到 12 类上限 = 不加也不选。 */
  const commitNewCategory = () => {
    const name = normalizePlanCategoryName(newCategory);
    setAddingCategory(false);
    setNewCategory("");
    if (name === "") {
      return;
    }
    if (categories.includes(name)) {
      setCategory(name);
      return;
    }
    if (categories.length >= PLAN_CATEGORY_MAX) {
      return;
    }
    onAddCategory(name);
    setCategory(name);
  };

  return createPortal(
    <div
      data-plan-editor=""
      role="dialog"
      aria-modal="true"
      aria-label={isEdit ? t("plan.editorEditAria") : t("plan.newNote")}
      onClick={onClose}
      className="fixed inset-0 z-[70] flex items-center justify-center bg-[rgba(41,37,36,0.36)] p-5 backdrop-blur-[4px]"
    >
      <div
        ref={dialogRef}
        onClick={(event) => {
          event.stopPropagation();
        }}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
            event.preventDefault();
            handleSave();
          }
        }}
        style={{ backgroundColor: color.bg, borderColor: color.border, color: color.ink, maxHeight: "min(720px, calc(100dvh - 40px))" }}
        className="flex w-full max-w-[680px] flex-col overflow-hidden rounded-3xl border shadow-[0_48px_100px_-36px_rgba(28,25,23,0.55)]"
      >
        <header className="flex shrink-0 items-center gap-[14px] px-4 pt-3.5">
          <button
            type="button"
            data-plan-editor-close=""
            onClick={onClose}
            aria-label={t("plan.closeAria")}
            className="grid h-[34px] w-[34px] place-items-center rounded-[10px] bg-white/60 text-[#57534e] transition hover:bg-white hover:text-[#1c1917]"
          >
            <svg viewBox="0 0 24 24" fill="none" className="h-[18px] w-[18px]" aria-hidden="true">
              <path d="M6 6 18 18M18 6 6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </button>
          <div className="flex items-center gap-[7px]">
            {PLAN_COLORS.map((item) => (
              <button
                key={item.id}
                type="button"
                data-plan-color={item.id}
                aria-label={t("plan.colorAria", { name: planLabelText(locale, item.label) })}
                aria-pressed={colorId === item.id}
                title={planLabelText(locale, item.label)}
                onClick={() => setColorId(item.id)}
                style={{ backgroundColor: item.swatch }}
                className={
                  "h-[22px] w-[22px] rounded-full border-2 shadow-[inset_0_0_0_1px_rgba(28,25,23,0.14)] transition " +
                  (colorId === item.id ? "scale-[1.12] border-[#1c1917]" : "border-transparent hover:scale-[1.15]")
                }
              />
            ))}
          </div>
          <div className="ml-auto flex items-center gap-1 rounded-[11px] bg-white/55 p-[3px]">
            {PLAN_FONTS.map((item) => (
              <button
                key={item.id}
                type="button"
                data-plan-font={item.id}
                aria-label={t("plan.fontAria", { name: planLabelText(locale, item.label) })}
                aria-pressed={fontId === item.id}
                title={planLabelText(locale, item.hint)}
                onClick={() => setFontId(item.id)}
                className={
                  "rounded-lg px-2.5 py-1 text-[13px] transition " +
                  item.className +
                  " " +
                  (fontId === item.id ? "bg-[#1c1917] text-[#fdfbf7]" : "text-[#57534e] hover:text-[#1c1917]")
                }
              >
                Aa
              </button>
            ))}
          </div>
        </header>

        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-[26px] pb-1 pt-2.5">
          <input
            data-plan-editor-title=""
            value={title}
            maxLength={PLAN_TITLE_MAX}
            autoFocus
            onChange={(event) => setTitle(event.target.value)}
            placeholder={t("plan.titlePlaceholder")}
            aria-label={t("plan.titlePlaceholder")}
            className={"w-full appearance-none border-0 bg-transparent py-1.5 text-[25px] font-semibold tracking-[-0.01em] text-inherit outline-none placeholder:text-black/30 " + fontClass}
          />
          <textarea
            data-plan-editor-content=""
            value={content}
            maxLength={PLAN_CONTENT_MAX}
            onChange={(event) => setContent(event.target.value)}
            rows={6}
            placeholder={t("plan.contentPlaceholder")}
            aria-label={t("plan.contentAria")}
            className={"min-h-[240px] flex-1 resize-none appearance-none border-0 bg-transparent pb-2.5 pt-1 text-[14.5px] leading-[1.75] text-inherit outline-none placeholder:text-black/30 " + fontClass}
          />
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-[7px] px-[26px] pb-3.5 pt-2">
          {categories.map((item) => (
            <button
              key={item}
              type="button"
              data-plan-editor-category={item}
              aria-pressed={category === item}
              onClick={() => setCategory(item)}
              className={
                "rounded-full border border-transparent px-[13px] py-[5px] text-xs font-medium transition " +
                (category === item ? "bg-[#1c1917] text-[#fdfbf7]" : "bg-white/50 text-[#57534e] hover:bg-white")
              }
            >
              {item}
            </button>
          ))}
          {addingCategory ? (
            <input
              autoFocus
              data-plan-editor-category-new=""
              value={newCategory}
              maxLength={PLAN_CATEGORY_NAME_MAX}
              onChange={(event) => setNewCategory(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  commitNewCategory();
                }
                if (event.key === "Escape") {
                  event.stopPropagation();
                  setAddingCategory(false);
                  setNewCategory("");
                }
              }}
              onBlur={commitNewCategory}
              placeholder={t("plan.newCategoryShort")}
              className="w-24 rounded-full border border-[#1c1917] bg-white px-[13px] py-[5px] text-xs font-medium text-[#1c1917] outline-none"
            />
          ) : (
            <button
              type="button"
              data-plan-editor-category-add=""
              disabled={categories.length >= PLAN_CATEGORY_MAX}
              title={categories.length >= PLAN_CATEGORY_MAX ? t("plan.categoryMaxTitle", { n: PLAN_CATEGORY_MAX }) : t("plan.addCategoryTitle")}
              onClick={() => setAddingCategory(true)}
              className="inline-flex items-center gap-1 rounded-full border border-dashed border-black/[0.32] bg-transparent px-[13px] py-[5px] text-xs font-medium text-[#78716c] transition hover:border-black/50 hover:text-[#1c1917] disabled:cursor-not-allowed disabled:opacity-50"
            >
              <svg viewBox="0 0 24 24" fill="none" className="h-3 w-3" aria-hidden="true">
                <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
              {t("plan.newCategoryShort")}
            </button>
          )}
        </div>

        {saveError === undefined ? null : <div role="status" className="shrink-0 border-t border-black/10 px-5 py-3 text-xs"><p>{saveError}</p>{conflictSummary === undefined ? null : <><details className="mt-2"><summary>{t("plan.reviewRemote")}</summary><p className="max-h-32 overflow-auto whitespace-pre-wrap">{conflictSummary}</p></details><button type="button" disabled={saving} className="mt-2 underline" onClick={() => { void handleSave(true); }}>{t("plan.conflictConfirmBtn")}</button></>}</div>}
        <footer className="flex min-h-16 shrink-0 items-center justify-between gap-3 border-t border-black/[0.08] bg-white/35 px-5 py-3">
          {isEdit && confirmingDelete ? (
            <div data-plan-editor-delete-confirm="" className="ml-auto flex flex-wrap items-center gap-2.5 text-[12.5px] font-semibold text-[#b91c1c]">
              <span>{t("plan.deleteConfirm")}</span>
              <button
                type="button"
                data-plan-editor-delete-cancel=""
                onClick={() => setConfirmingDelete(false)}
                className="rounded-[11px] border border-[#e8e3da] bg-white px-3.5 py-2 text-[13px] font-medium text-[#57534e] transition hover:bg-[#faf9f7] hover:text-[#1c1917]"
              >
                {t("common.cancel")}
              </button>
              <button
                type="button"
                data-plan-editor-delete-do=""
                onClick={onDelete}
                className="rounded-[11px] border border-[#dc2626] bg-[#dc2626] px-3.5 py-2 text-[13px] font-medium text-white transition hover:bg-[#b91c1c]"
              >
                {t("common.delete")}
              </button>
            </div>
          ) : (
            <>
              <span className="text-xs text-[#78716c]">{note === null ? t("plan.newNote") : t("plan.updatedAt", { date: formatPlanFull(note.updatedAt, locale) })}</span>
              <div className="flex items-center gap-2">
                {note === null ? null : (
                  <button
                    type="button"
                    data-plan-editor-delete=""
                    onClick={() => setConfirmingDelete(true)}
                    title={t("plan.deleteNoteAria")}
                    aria-label={t("plan.deleteNoteAria")}
                    className="grid place-items-center rounded-[11px] border border-[#e8e3da] bg-white px-2.5 py-2 text-[#dc2626] transition hover:bg-[#faf9f7]"
                  >
                    <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4" aria-hidden="true">
                      <path d="M4 7h16M10 11v5M14 11v5M6.5 7l.8 11a2 2 0 0 0 2 1.9h5.4a2 2 0 0 0 2-1.9l.8-11M9.5 7V5.4A1.4 1.4 0 0 1 10.9 4h2.2a1.4 1.4 0 0 1 1.4 1.4V7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </button>
                )}
                <button
                  type="button"
                  data-plan-editor-save=""
                  disabled={!canSave || saving}
                  onClick={() => { void handleSave(); }}
                  className="inline-flex items-center gap-1.5 rounded-[11px] border border-[#1c1917] bg-[#1c1917] px-3.5 py-2 text-[13px] font-medium text-[#fdfbf7] shadow-[0_1px_2px_rgba(28,25,23,0.05),0_10px_26px_-16px_rgba(28,25,23,0.22)] transition hover:-translate-y-px hover:bg-[#292524] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:translate-y-0"
                >
                  <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4" aria-hidden="true">
                    <path d="M5 12.5 10 17.5 19 7" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  {saving ? t("common.saving") : t("common.save")}
                </button>
              </div>
            </>
          )}
        </footer>
      </div>
    </div>,
    document.body,
  );
}
