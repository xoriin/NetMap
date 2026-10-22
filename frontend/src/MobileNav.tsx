import { useEffect, useState } from "react";
import { BookOpen, LogOut, Menu, Moon, Sun, X } from "lucide-react";
import { type AppRoute, type RouteDefinition } from "./routes";
import { type User } from "./api/client";
import { SpaLink } from "./components/SpaLink";
import { useTheme } from "./providers/ThemeProvider";
import { ADMIN_TAB_CHANGE_EVENT, availableAdminTabs, navigateToAdminTab, readAdminTabFromLocation } from "./features/admin/adminNavigation";
import { MONITORING_VIEW_CHANGE_EVENT, availableMonitoringViews, navigateToMonitoringView, readMonitoringViewFromLocation } from "./features/monitoring/monitoringNavigation";
import { INVENTORY_VIEW_CHANGE_EVENT, inventoryViews, navigateToInventoryView, readInventoryViewFromLocation } from "./features/inventory/inventoryNavigation";
import { IPAM_VIEW_CHANGE_EVENT, ipamViews, navigateToIpamView, readIpamViewFromLocation } from "./features/ipam/ipamNavigation";

const TAB_ROUTES: AppRoute[] = ["/overview", "/inventory", "/monitoring", "/topology"];
const TAB_LABELS: Partial<Record<AppRoute, string>> = { "/overview": "Home", "/monitoring": "Monitor", "/topology": "Map" };

export function MobileTabBar({ routes, currentRoute, moreOpen, openObservationCount, onNavigate, onToggleMore }: {
  routes: RouteDefinition[];
  currentRoute: AppRoute;
  moreOpen: boolean;
  openObservationCount?: number;
  onNavigate: (route: AppRoute) => void;
  onToggleMore: () => void;
}) {
  const tabs = TAB_ROUTES.map((href) => routes.find((route) => route.href === href)).filter((route): route is RouteDefinition => Boolean(route));
  const onTab = tabs.some((route) => route.href === currentRoute);
  return (
    <nav className="mobile-tabbar" aria-label="Primary navigation">
      {tabs.map((route) => {
        const Icon = route.icon;
        const active = !moreOpen && route.href === currentRoute;
        return (
          <SpaLink key={route.href} href={route.href} className={active ? "mobile-tab active" : "mobile-tab"} aria-current={active ? "page" : undefined} onNavigate={() => onNavigate(route.href)}>
            <Icon size={20} aria-hidden="true" />
            <span>{TAB_LABELS[route.href] ?? route.label}</span>
            {route.href === "/inventory" && openObservationCount ? <em className="mobile-tab-badge">{openObservationCount > 99 ? "99+" : openObservationCount}</em> : null}
          </SpaLink>
        );
      })}
      <button type="button" className={moreOpen || !onTab ? "mobile-tab active" : "mobile-tab"} aria-expanded={moreOpen} onClick={onToggleMore}>
        <Menu size={20} aria-hidden="true" />
        <span>More</span>
      </button>
    </nav>
  );
}

export function MobileMoreSheet({ routes, currentRoute, onNavigate, onClose, onLogout }: {
  routes: RouteDefinition[];
  currentRoute: AppRoute;
  onNavigate: (route: AppRoute) => void;
  onClose: () => void;
  onLogout: () => void;
}) {
  const { theme, toggleTheme } = useTheme();
  const others = routes.filter((route) => !TAB_ROUTES.includes(route.href));
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <>
      <div className="mobile-sheet-backdrop" aria-hidden="true" onClick={onClose} />
      <section className="mobile-sheet" role="dialog" aria-modal="true" aria-label="More">
        <header className="mobile-sheet-header">
          <strong>More</strong>
          <button type="button" className="mobile-sheet-close" aria-label="Close" onClick={onClose}><X size={18} aria-hidden="true" /></button>
        </header>
        <div className="mobile-sheet-grid">
          {others.map((route) => {
            const Icon = route.icon;
            return (
              <SpaLink key={route.href} href={route.href} className={route.href === currentRoute ? "mobile-sheet-item active" : "mobile-sheet-item"} onNavigate={() => onNavigate(route.href)}>
                <Icon size={20} aria-hidden="true" />
                <span>{route.label}</span>
              </SpaLink>
            );
          })}
          <button type="button" className="mobile-sheet-item" onClick={toggleTheme}>
            {theme === "dark" ? <Sun size={20} aria-hidden="true" /> : <Moon size={20} aria-hidden="true" />}
            <span>{theme === "dark" ? "Light mode" : "Dark mode"}</span>
          </button>
          <a className="mobile-sheet-item" href="https://docs.netmap.dev" target="_blank" rel="noreferrer">
            <BookOpen size={20} aria-hidden="true" />
            <span>Docs</span>
          </a>
        </div>
        <button type="button" className="nm-btn nm-btn--secondary mobile-sheet-signout" onClick={onLogout}>
          <LogOut size={16} aria-hidden="true" />Sign out
        </button>
      </section>
    </>
  );
}

type Section = { id: string; label: string };

function sectionsFor(route: AppRoute, user: User): { sections: readonly Section[]; read: () => string; go: (id: string) => void; event: string } | null {
  if (route === "/inventory") return { sections: inventoryViews, read: readInventoryViewFromLocation, go: (id) => navigateToInventoryView(id as never), event: INVENTORY_VIEW_CHANGE_EVENT };
  if (route === "/monitoring") return { sections: availableMonitoringViews(user), read: readMonitoringViewFromLocation, go: (id) => navigateToMonitoringView(id as never), event: MONITORING_VIEW_CHANGE_EVENT };
  if (route === "/ipam") return { sections: ipamViews, read: readIpamViewFromLocation, go: (id) => navigateToIpamView(id as never), event: IPAM_VIEW_CHANGE_EVENT };
  if (route === "/admin") return { sections: availableAdminTabs(user), read: readAdminTabFromLocation, go: (id) => navigateToAdminTab(id as never), event: ADMIN_TAB_CHANGE_EVENT };
  return null;
}

export function MobileSectionTabs({ currentRoute, user }: { currentRoute: AppRoute; user: User }) {
  const config = sectionsFor(currentRoute, user);
  const [active, setActive] = useState(() => config?.read() ?? "");
  useEffect(() => {
    if (!config) return;
    const sync = () => setActive(config.read());
    sync();
    window.addEventListener("popstate", sync);
    window.addEventListener("hashchange", sync);
    window.addEventListener(config.event, sync);
    return () => {
      window.removeEventListener("popstate", sync);
      window.removeEventListener("hashchange", sync);
      window.removeEventListener(config.event, sync);
    };
  }, [currentRoute]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!config || config.sections.length < 2) return null;
  return (
    <nav className="mobile-section-tabs" aria-label="Sections">
      {config.sections.map((section) => (
        <button
          key={section.id}
          type="button"
          className={section.id === active ? "mobile-section-tab active" : "mobile-section-tab"}
          aria-current={section.id === active ? "page" : undefined}
          onClick={() => { config.go(section.id); setActive(section.id); window.scrollTo({ top: 0 }); }}
        >
          {section.label}
        </button>
      ))}
    </nav>
  );
}
