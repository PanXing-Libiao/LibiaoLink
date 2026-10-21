import { useT } from "../i18n";

export function Loader() {
  const t = useT();
  return (
    <div className="dot-spinner" role="status" aria-label={t("loader.aria")}>
      <div className="dot-spinner__dot" />
      <div className="dot-spinner__dot" />
      <div className="dot-spinner__dot" />
      <div className="dot-spinner__dot" />
      <div className="dot-spinner__dot" />
      <div className="dot-spinner__dot" />
      <div className="dot-spinner__dot" />
      <div className="dot-spinner__dot" />
    </div>
  );
}
