import { useEffect } from "react";
import { useT } from "./i18n";

const ROWS = [
  {
    role: "access.matrixManager",
    source: "access.matrixAutomatic",
    scope: "access.matrixScopeManager",
    rights: "access.matrixRightsManager",
    note: "access.matrixManagerDesc",
    tone: "blue",
  },
  {
    role: "access.matrixMember",
    source: "access.matrixAutomatic",
    scope: "access.matrixScopeMember",
    rights: "access.matrixRightsMember",
    note: "access.matrixMemberDesc",
    tone: "emerald",
  },
  {
    role: "access.matrixTaskOwner",
    source: "access.matrixAutomatic",
    scope: "access.matrixScopeTaskOwner",
    rights: "access.matrixRightsTaskOwner",
    note: "access.matrixTaskOwnerDesc",
    tone: "violet",
  },
  {
    role: "access.matrixManualView",
    source: "access.matrixManual",
    scope: "access.matrixScopeManual",
    rights: "access.dashboard.viewOnly",
    note: "access.matrixManualViewDesc",
    tone: "amber",
  },
  {
    role: "access.matrixManualEdit",
    source: "access.matrixManual",
    scope: "access.matrixScopeManual",
    rights: "access.dashboard.operate",
    note: "access.matrixManualEditDesc",
    tone: "amber",
  },
] as const;

function toneClass(tone: typeof ROWS[number]["tone"]): string {
  if (tone === "blue") return "border-blue-200 bg-blue-50 text-blue-700";
  if (tone === "emerald") return "border-emerald-200 bg-emerald-50 text-emerald-700";
  if (tone === "violet") return "border-violet-200 bg-violet-50 text-violet-700";
  return "border-amber-200 bg-amber-50 text-amber-700";
}

export function AccessPermissionMatrix({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT();

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-zinc-950/45 p-0 backdrop-blur-[2px] sm:items-center sm:p-6" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose(); }}>
      <div role="dialog" aria-modal="true" aria-labelledby="access-matrix-title" className="flex max-h-[92vh] w-full max-w-[1040px] flex-col overflow-hidden rounded-t-3xl bg-white shadow-2xl ring-1 ring-zinc-900/10 sm:rounded-3xl">
        <div className="flex items-start justify-between gap-4 border-b border-zinc-200 px-5 py-4 sm:px-6">
          <div>
            <h2 id="access-matrix-title" className="text-lg font-semibold tracking-tight text-zinc-900">{t("access.matrixTitle")}</h2>
            <p className="mt-1 text-xs leading-5 text-zinc-500">{t("access.matrixHint")}</p>
          </div>
          <button type="button" onClick={onClose} aria-label={t("access.detail.close")} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-zinc-400 transition hover:bg-zinc-100 hover:text-zinc-700">
            <svg viewBox="0 0 20 20" aria-hidden="true" className="h-4 w-4"><path d="m5 5 10 10M15 5 5 15" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" /></svg>
          </button>
        </div>

        <div className="overflow-y-auto px-4 py-4 sm:px-6 sm:py-5">
          <div className="hidden overflow-hidden rounded-xl border border-zinc-200 md:block">
            <div className="grid grid-cols-[132px_92px_170px_116px_minmax(0,1fr)] bg-zinc-50 text-[11px] font-medium text-zinc-500">
              <div className="border-r border-zinc-200 px-3 py-2.5">{t("access.matrixRole")}</div>
              <div className="border-r border-zinc-200 px-3 py-2.5">{t("access.matrixSource")}</div>
              <div className="border-r border-zinc-200 px-3 py-2.5">{t("access.matrixScope")}</div>
              <div className="border-r border-zinc-200 px-3 py-2.5">{t("access.matrixRights")}</div>
              <div className="px-3 py-2.5">{t("access.matrixNote")}</div>
            </div>
            {ROWS.map((row) => (
              <div key={row.role} className="grid grid-cols-[132px_92px_170px_116px_minmax(0,1fr)] border-t border-zinc-100 text-xs text-zinc-700">
                <div className="border-r border-zinc-100 px-3 py-3"><span className={"inline-flex rounded-full border px-2 py-0.5 font-medium " + toneClass(row.tone)}>{t(row.role)}</span></div>
                <div className="border-r border-zinc-100 px-3 py-3 text-[11px] text-zinc-500">{t(row.source)}</div>
                <div className="border-r border-zinc-100 px-3 py-3 text-[11px] leading-5 text-zinc-600">{t(row.scope)}</div>
                <div className="border-r border-zinc-100 px-3 py-3 font-medium text-zinc-800">{t(row.rights)}</div>
                <div className="px-3 py-3 text-[11px] leading-5 text-zinc-500">{t(row.note)}</div>
              </div>
            ))}
          </div>

          <div className="grid gap-2.5 md:hidden">
            {ROWS.map((row) => (
              <article key={row.role} className="rounded-xl border border-zinc-200 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={"inline-flex rounded-full border px-2 py-0.5 text-[11px] font-medium " + toneClass(row.tone)}>{t(row.role)}</span>
                  <span className="text-[10px] text-zinc-400">{t(row.source)}</span>
                  <span className="ml-auto text-[11px] font-medium text-zinc-800">{t(row.rights)}</span>
                </div>
                <p className="mt-2 text-[11px] leading-5 text-zinc-600">{t(row.note)}</p>
                <p className="mt-1 text-[11px] leading-5 text-zinc-500">{t(row.scope)}</p>
              </article>
            ))}
          </div>

          <div className="mt-4 flex items-start gap-2 rounded-xl border border-blue-100 bg-blue-50/60 px-3.5 py-3 text-[11px] leading-5 text-blue-800">
            <svg viewBox="0 0 20 20" aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0"><path d="M10 2.8 16 5v4.2c0 3.6-2.4 6.5-6 7.8-3.6-1.3-6-4.2-6-7.8V5l6-2.2Z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" /><path d="m7.2 10 1.8 1.8 3.9-3.9" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
            <span>{t("access.matrixFooter")}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
