import { useT } from "../i18n";

type SearchInputProps = {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  className?: string;
  disabled?: boolean;
};

export function SearchInput({ value, onChange, placeholder, className = "", disabled = false }: SearchInputProps) {
  const t = useT();
  /** 缺省占位文案随语言切换（传了就用调用方的）。 */
  const resolvedPlaceholder = placeholder ?? t("search.default.placeholder");
  return (
    <div className={"relative " + className}>
      <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-400">
        <svg viewBox="0 0 24 24" fill="none" className="h-[18px] w-[18px]" aria-hidden="true">
          <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="2" />
          <path d="M20.5 20.5 16.2 16.2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      </span>
      <input
        type="search"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
        placeholder={resolvedPlaceholder}
        aria-label={resolvedPlaceholder}
        className="block w-full appearance-none rounded-lg border border-zinc-300 bg-white py-2 pl-9 pr-9 text-sm text-zinc-900 shadow-xs outline-none transition placeholder:text-zinc-400 focus:border-blue-500 focus:ring-2 focus:ring-blue-500/25 disabled:cursor-not-allowed disabled:bg-zinc-50 disabled:text-zinc-400 [&::-webkit-search-cancel-button]:hidden [&::-webkit-search-decoration]:hidden"
      />
      {value.length > 0 && (
        <button
          type="button"
          aria-label={t("home.clearSearch")}
          onClick={() => onChange("")}
          disabled={disabled}
          className="absolute right-2 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-full text-zinc-400 transition hover:bg-zinc-100 hover:text-zinc-600"
        >
          <svg viewBox="0 0 24 24" fill="none" className="h-3.5 w-3.5" aria-hidden="true">
            <path d="M6 6l12 12M18 6 6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </button>
      )}
    </div>
  );
}
