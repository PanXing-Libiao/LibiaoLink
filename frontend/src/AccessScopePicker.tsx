import type { GroupAccessAccessLevel, GroupAccessProjectScope } from "./accessApi";
import { mergeScopePermissions } from "./accessRules";
import type { GroupAccessDataProjectScope, GroupAccessScopePermission } from "./permissions";
import { useT, type TextKey } from "./i18n";

const DATA_SCOPE_OPTIONS: Array<{ value: GroupAccessDataProjectScope; labelKey: TextKey }> = [
  { value: "all", labelKey: "access.scope.all" },
  { value: "own", labelKey: "access.scope.own" },
  { value: "selected", labelKey: "access.scope.selected" },
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
  scopePermissions,
  onChange,
}: {
  scopePermissions: GroupAccessScopePermission[];
  onChange: (next: GroupAccessScopePermission[]) => void;
}) {
  const t = useT();
  const normalized = mergeScopePermissions(scopePermissions);
  const levelOf = (scope: GroupAccessDataProjectScope): GroupAccessAccessLevel | null =>
    normalized.find((permission) => permission.projectScope === scope)?.accessLevel ?? null;

  function setScope(scope: GroupAccessDataProjectScope, accessLevel: GroupAccessAccessLevel | null): void {
    const next = normalized.filter((permission) => permission.projectScope !== scope);
    if (accessLevel !== null) next.push({ projectScope: scope, accessLevel });
    onChange(mergeScopePermissions(next));
  }

  function toggleScope(scope: GroupAccessDataProjectScope): void {
    const current = levelOf(scope);
    setScope(scope, current === null ? "edit" : null);
  }

  function setLevel(scope: GroupAccessDataProjectScope, accessLevel: GroupAccessAccessLevel): void {
    setScope(scope, accessLevel);
  }

  return (
    <div data-access-scope-picker="true" className="grid gap-2 sm:grid-cols-2">
      {DATA_SCOPE_OPTIONS.map((option) => {
        const level = levelOf(option.value);
        const active = level !== null;
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
            <div className="flex flex-wrap items-center gap-1.5 border-t border-blue-100/70 px-3 pb-2 pt-1.5">
              <AccessLevelButton
                checked={level === "edit"}
                tone="edit"
                optionKey={option.value}
                label={t("access.dashboard.operate")}
                onClick={() => { setLevel(option.value, "edit"); }}
              />
              <AccessLevelButton
                checked={level === "view"}
                tone="view"
                optionKey={option.value}
                label={t("access.dashboard.viewOnly")}
                onClick={() => { setLevel(option.value, "view"); }}
              />
            </div>
          </div>
        );
      })}
      <div
        className={
          "flex min-h-[70px] flex-col overflow-hidden rounded-xl border transition-all duration-200 sm:col-span-2 " +
          (normalized.length === 0 ? "border-amber-300 bg-amber-50/70 shadow-sm" : "border-zinc-200 bg-white hover:border-amber-200 hover:bg-amber-50/30")
        }
      >
        <button
          type="button"
          data-access-scope-option={"none" satisfies GroupAccessProjectScope}
          aria-pressed={normalized.length === 0}
          onClick={() => { onChange([]); }}
          className="flex min-h-10 w-full flex-1 items-center gap-2.5 px-3 py-2.5 text-left text-[11px] font-medium text-zinc-700 transition-colors hover:text-amber-800"
        >
          <ParentDot active={normalized.length === 0} />
          <span className="min-w-0 flex-1">{t("access.scope.none")}</span>
        </button>
      </div>
    </div>
  );
}
