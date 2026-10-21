import { useEffect, useRef, useState } from "react";
import { useT } from "../i18n";
import type { OverviewExportLanguage } from "../overviewExportShared";

type ExportOverviewButtonProps = {
  /** 选择主体语言后触发导出（导出实现见 ../exportOverviewPdf.ts）。 */
  onExport: (primary: OverviewExportLanguage) => void;
  /** 任务数据还在取 / 重取中：置灰不给点，避免导出半份数据。 */
  disabled?: boolean;
  /** 导出进行中（等「项目进展描述」列英译，见 §6.16 ⑯）：按钮转「生成中…」并防重复点击。 */
  busy?: boolean;
};

/**
 * 「导出 PDF」按钮（项目总览工具区 · 业务口径 2026-10-09）。
 * 2026-10-21 追订：点击后先选择报告主体语言 —— 中文为主体保持当前版式；英文为主体把英文
 * 提到主文案位置、中文降为次要小字。菜单行为与 ColumnPicker 同套：点外面 / Esc 收起。
 */
export function ExportOverviewButton({ onExport, disabled = false, busy = false }: ExportOverviewButtonProps) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const blocked = disabled || busy;

  useEffect(() => {
    if (!open) {
      return;
    }
    const handlePointer = (event: MouseEvent) => {
      if (rootRef.current !== null && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handlePointer);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handlePointer);
      document.removeEventListener("keydown", handleKey);
    };
  }, [open]);

  useEffect(() => {
    if (blocked) {
      setOpen(false);
    }
  }, [blocked]);

  const choose = (primary: OverviewExportLanguage) => {
    setOpen(false);
    onExport(primary);
  };

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        type="button"
        data-export-overview=""
        className="export-docs-btn"
        aria-label={t("export.aria")}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-busy={busy}
        disabled={blocked}
        onClick={() => setOpen((previous) => !previous)}
      >
        <span className="export-docs-btn__face">
          <svg viewBox="0 0 24 24" width={15} height={15} stroke="currentColor" strokeWidth={2} fill="none" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
            <line x1={16} y1={13} x2={8} y2={13} />
            <line x1={16} y1={17} x2={8} y2={17} />
            <polyline points="10 9 9 9 8 9" />
          </svg>
          {busy ? t("export.busy") : t("export.pdf")}
          {busy ? null : (
            <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={"h-3 w-3 transition-transform " + (open ? "rotate-180" : "")}>
              <path d="M5.5 8l4.5 4.5L14.5 8" />
            </svg>
          )}
        </span>
      </button>
      {open ? (
        <div role="menu" aria-label={t("export.primary.title")} data-export-language-menu="" className="absolute right-0 top-full z-40 mt-2 w-72 rounded-xl border border-zinc-200 bg-white p-2 shadow-xl">
          <div className="px-2.5 pb-1.5 pt-1 text-xs font-medium text-zinc-500">{t("export.primary.title")}</div>
          <button
            type="button"
            role="menuitem"
            data-export-language="zh"
            onClick={() => choose("zh")}
            className="flex w-full flex-col items-start gap-0.5 rounded-lg px-2.5 py-2 text-left transition hover:bg-zinc-50 focus-visible:bg-zinc-50 focus-visible:outline-none"
          >
            <span className="text-sm font-medium text-zinc-800">{t("export.primary.zh")}</span>
            <span className="text-xs text-zinc-400">{t("export.primary.zhHint")}</span>
          </button>
          <button
            type="button"
            role="menuitem"
            data-export-language="en"
            onClick={() => choose("en")}
            className="flex w-full flex-col items-start gap-0.5 rounded-lg px-2.5 py-2 text-left transition hover:bg-zinc-50 focus-visible:bg-zinc-50 focus-visible:outline-none"
          >
            <span className="text-sm font-medium text-zinc-800">{t("export.primary.en")}</span>
            <span className="text-xs text-zinc-400">{t("export.primary.enHint")}</span>
          </button>
        </div>
      ) : null}
    </div>
  );
}
