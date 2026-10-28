import { useT } from "../i18n";
import { MainNavIcon } from "./MainNavIcon";
import { useMainNavItems } from "./mainNav";

export function MobileNav() {
  const t = useT();
  const items = useMainNavItems();
  return (
    <nav data-mobile-nav="" aria-label={t("nav.aria")} className="mobile-nav">
      <div className="mobile-nav__inner">
        {items.map((item) => (
          <a
            key={item.key}
            data-mobile-nav-item={item.key}
            href={item.href}
            aria-current={item.active ? "page" : undefined}
            className="mobile-nav__link"
          >
            <span className="mobile-nav__icon">
              <MainNavIcon name={item.key} className="h-6 w-6" />
            </span>
            <span className="mobile-nav__label">{item.label}</span>
          </a>
        ))}
      </div>
    </nav>
  );
}
