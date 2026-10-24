import type { GroupAccessAccessLevel, GroupAccessProjectScope } from "./accessApi";
import { useT, type TextKey } from "./i18n";

const SCOPE_OPTIONS: Array<{ value: GroupAccessProjectScope; labelKey: TextKey }> = [
  { value: "all", labelKey: "access.scope.all" },
  { value: "own", labelKey: "access.scope.own" },
  { value: "selected", labelKey: "access.scope.selected" },
  { value: "none", labelKey: "access.scope.none" },
];

function ParentDot({ active }: { active: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={
        "flex h-4 w-4 shrink-0 items-center justify-center rounded-full border transition-all duration-200 " +
        (active ? "border-blue-600 bg-blue-600 text-white shadow-sm" : "border-zinc-300 bg-white text-transparent")
      }
    >
      <svg viewBox="0 0 16 16" className="h-2.5 w-2.5">
        <path d="m3.3 8.2 3 3 6.4-6.4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  );
}

function LevelDot({ checked, tone }: { checked: boolean; tone: "edit" | "view" }) {
  const checkedClass = tone === "edit" ? "border-blue-600 bg-blue-600" : "border-emerald-600 bg-emerald-600";
  return (
    <span aria-hidden="true" className={"h-2.5 w-2.5 shrink-0 rounded-full border-2 transition-all duration-200 " + (checked ? checkedClass : "border-zinc-300 bg-white")} />
  );
}

function AccessLevelButton({
  checked,
  tone,
  label,
  optionKey,
  onClick,
}: {
  checked: boolean;
  tone: "edit" | "view";
  label: string;
  optionKey: string;
  onClick: () => void;
}) {
  const activeClass = tone === "edit"
    ? "border-blue-200 bg-blue-50 text-blue-700"
    : "border-emerald-200 bg-emerald-50 text-emerald-700";
  return (
    <button
      type="button"
      data-access-level={tone}
      data-access-level-scope={optionKey}
      aria-pressed={checked}
      onClick={onClick}
      className={
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] font-medium transition-all duration-200 hover:-translate-y-0.5 hover:shadow-sm " +
        (checked ? activeClass : "border-zinc-200 bg-white text-zinc-500 hover:border-zinc-300 hover:bg-zinc-50")
      }
    >
      <LevelDot checked={checked} tone={tone} />
      {label}
    </button>
  );
}

export function AccessScopePicker({
  projectScope,
  accessLevel,
  onChange,
}: {
  projectScope: GroupAccessProjectScope;
  accessLevel: GroupAccessAccessLevel;
  onChange: (next: { projectScope: GroupAccessProjectScope; accessLevel: GroupAccessAccessLevel }) => void;
}) {
  const t = useT();

  function toggleScope(option: GroupAccessProjectScope): void {
    if (projectScope === option) {
      onChange({ projectScope: "none", accessLevel: "view" });
      return;
    }
    onChange({ projectScope: option, accessLevel: option === "none" ? "view" : "edit" });
  }

  function toggleEdit(option: GroupAccessProjectScope): void {
    if (projectScope !== option) {
      onChange({ projectScope: option, accessLevel: "edit" });
      return;
    }
    onChange({ projectScope: option, accessLevel: accessLevel === "edit" ? "view" : "edit" });
  }

  function toggleView(option: GroupAccessProjectScope): void {
    if (projectScope !== option) {
      onChange({ projectScope: option, accessLevel: "view" });
      return;
    }
    onChange({ projectScope: "none", accessLevel: "view" });
  }

  return (
    <div data-access-scope-picker="true" className="grid gap-2 sm:grid-cols-2">
      {SCOPE_OPTIONS.map((option) => {
        const active = projectScope === option.value;
        const dataScope = option.value !== "none";
        return (
          <div
            key={option.value}
            className={
              "flex min-h-[70px] flex-col overflow-hidden rounded-xl border transition-all duration-200 " +
              (active ? "border-blue-300 bg-blue-50/70 shadow-sm" : "border-zinc-200 bg-white hover:border-blue-200 hover:bg-blue-50/30")
            }
          >
            <button
              type="button"
              data-access-scope-option={option.value}
              aria-pressed={active}
              onClick={() => { toggleScope(option.value); }}
              className="flex min-h-10 w-full flex-1 items-center gap-2.5 px-3 py-2.5 text-left text-[11px] font-medium text-zinc-700 transition-colors hover:text-blue-800"
            >
              <ParentDot active={active} />
              <span className="min-w-0 flex-1 truncate">{t(option.labelKey)}</span>
            </button>
            {dataScope ? (
              <div className="flex flex-wrap items-center gap-1.5 border-t border-blue-100/70 px-3 pb-2 pt-1.5">
                <AccessLevelButton
                  checked={active && accessLevel === "edit"}
                  tone="edit"
                  optionKey={option.value}
                  label={t("access.dashboard.operate")}
                  onClick={() => { toggleEdit(option.value); }}
                />
                <AccessLevelButton
                  checked={active}
                  tone="view"
                  optionKey={option.value}
                  label={t("access.dashboard.viewOnly")}
                  onClick={() => { toggleView(option.value); }}
                />
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
