import { useState, useEffect, type ReactNode } from "react";

const STICKY_MENU_PREFIX = "netmap.sidebar.menu.";

/**
 * Sidebar section menus remember whether they are open.
 *
 * They used to be plain state seeded from the current route and force-expanded on arrival,
 * so leaving a section collapsed it and coming back discarded a deliberate collapse. The
 * choice now survives navigation and reloads.
 */
function readStickyMenu(key: string): "open" | "closed" | null {
  try {
    const stored = window.localStorage.getItem(`${STICKY_MENU_PREFIX}${key}`);
    return stored === "open" || stored === "closed" ? stored : null;
  } catch {
    // Private mode or blocked storage.
    return null;
  }
}

function useStickyMenu(key: string, fallback: boolean) {
  const stored = readStickyMenu(key);
  const [expanded, setExpandedState] = useState<boolean>(stored === null ? fallback : stored === "open");

  /**
   * Only an explicit toggle is persisted. Writing the derived default on mount would turn
   * "never chosen" into "closed" the moment you loaded any other page, and the menu would
   * then refuse to open on arrival.
   */
  const setExpanded = (next: boolean | ((current: boolean) => boolean)) => {
    setExpandedState((current) => {
      const value = typeof next === "function" ? next(current) : next;
      try {
        window.localStorage.setItem(`${STICKY_MENU_PREFIX}${key}`, value ? "open" : "closed");
      } catch {
        // Nothing to do — the menu still works for this session.
      }
      return value;
    });
  };

  return [expanded, setExpanded] as const;
}
import { ChevronDown, LogOut, Moon, PanelLeftClose, PanelLeftOpen, Sun } from "lucide-react";
import { type AppRoute, appRoutes, appRouteByHref, appRouteCopy } from "./routes";
import { type User, type VersionInfo } from "./api/client";
import { useTheme } from "./providers/ThemeProvider";
import {
  ADMIN_TAB_CHANGE_EVENT,
  availableAdminTabs,
  navigateToAdminTab,
  readAdminTabFromLocation,
  type AdminTabId,
} from "./features/admin/adminNavigation";
import {
  MONITORING_VIEW_CHANGE_EVENT,
  monitoringViews,
  navigateToMonitoringView,
  readMonitoringViewFromLocation,
  type MonitoringViewId,
} from "./features/monitoring/monitoringNavigation";
import {
  INVENTORY_VIEW_CHANGE_EVENT,
  inventoryViews,
  navigateToInventoryView,
  readInventoryViewFromLocation,
  type InventoryViewId,
} from "./features/inventory/inventoryNavigation";
import {
  IPAM_VIEW_CHANGE_EVENT,
  ipamViews,
  navigateToIpamView,
  readIpamViewFromLocation,
  type IpamViewId,
} from "./features/ipam/ipamNavigation";

export function Sidebar({
  canAccessAdmin,
  canAccessExports,
  canViewSecurity,
  collapsed,
  currentRoute,
  onLogout,
  onToggleCollapse,
  openObservationCount,
  onNavigate,
  versionInfo,
  user,
}: {
  canAccessAdmin: boolean;
  canAccessExports: boolean;
  canViewSecurity: boolean;
  collapsed: boolean;
  currentRoute: AppRoute;
  onLogout: () => void;
  onToggleCollapse: () => void;
  openObservationCount?: number;
  onNavigate: (route: AppRoute) => void;
  versionInfo: VersionInfo | null;
  user: User;
}) {
  const { theme, toggleTheme } = useTheme();
  const [activeAdminTab, setActiveAdminTab] = useState<AdminTabId>(() => readAdminTabFromLocation());
  const [adminMenuExpanded, setAdminMenuExpanded] = useStickyMenu("admin", currentRoute === "/admin");
  const [activeMonitoringView, setActiveMonitoringView] = useState<MonitoringViewId>(() => readMonitoringViewFromLocation());
  const [activeInventoryView, setActiveInventoryView] = useState<InventoryViewId>(() => readInventoryViewFromLocation());
  const [activeIpamView, setActiveIpamView] = useState<IpamViewId>(() => readIpamViewFromLocation());
  const [inventoryMenuExpanded, setInventoryMenuExpanded] = useStickyMenu("inventory", currentRoute === "/inventory");
  const [ipamMenuExpanded, setIpamMenuExpanded] = useStickyMenu("ipam", currentRoute === "/ipam");
  const [monitoringMenuExpanded, setMonitoringMenuExpanded] = useStickyMenu("monitoring", currentRoute === "/monitoring");
  const versionLabel = versionInfo
    ? `${versionInfo.channel ? `${versionInfo.channel}: ` : "v"}${versionInfo.current}`
    : "";

  useEffect(() => {
    const syncAdminTab = () => setActiveAdminTab(readAdminTabFromLocation());
    window.addEventListener("popstate", syncAdminTab);
    window.addEventListener("hashchange", syncAdminTab);
    window.addEventListener(ADMIN_TAB_CHANGE_EVENT, syncAdminTab);
    return () => {
      window.removeEventListener("popstate", syncAdminTab);
      window.removeEventListener("hashchange", syncAdminTab);
      window.removeEventListener(ADMIN_TAB_CHANGE_EVENT, syncAdminTab);
    };
  }, []);

  useEffect(() => {
    const syncMonitoringView = () => setActiveMonitoringView(readMonitoringViewFromLocation());
    const syncInventoryView = () => setActiveInventoryView(readInventoryViewFromLocation());
    const syncIpamView = () => setActiveIpamView(readIpamViewFromLocation());
    window.addEventListener("popstate", syncIpamView);
    window.addEventListener("hashchange", syncIpamView);
    window.addEventListener(IPAM_VIEW_CHANGE_EVENT, syncIpamView);
    window.addEventListener("popstate", syncInventoryView);
    window.addEventListener("hashchange", syncInventoryView);
    window.addEventListener(INVENTORY_VIEW_CHANGE_EVENT, syncInventoryView);
    window.addEventListener("popstate", syncMonitoringView);
    window.addEventListener("hashchange", syncMonitoringView);
    window.addEventListener(MONITORING_VIEW_CHANGE_EVENT, syncMonitoringView);
    return () => {
      window.removeEventListener("popstate", syncInventoryView);
      window.removeEventListener("hashchange", syncInventoryView);
      window.removeEventListener(INVENTORY_VIEW_CHANGE_EVENT, syncInventoryView);
      window.removeEventListener("popstate", syncIpamView);
      window.removeEventListener("hashchange", syncIpamView);
      window.removeEventListener(IPAM_VIEW_CHANGE_EVENT, syncIpamView);
      window.removeEventListener("popstate", syncMonitoringView);
      window.removeEventListener("hashchange", syncMonitoringView);
      window.removeEventListener(MONITORING_VIEW_CHANGE_EVENT, syncMonitoringView);
    };
  }, []);

  // Arriving on a section syncs which sub-view is current, but no longer forces the menu
  // open: the expanded state is the user's, and re-expanding here threw away a collapse
  // every time they came back.
  useEffect(() => {
    if (currentRoute === "/admin") setActiveAdminTab(readAdminTabFromLocation());
    if (currentRoute === "/monitoring") setActiveMonitoringView(readMonitoringViewFromLocation());
    if (currentRoute === "/ipam") setActiveIpamView(readIpamViewFromLocation());
    if (currentRoute === "/inventory") setActiveInventoryView(readInventoryViewFromLocation());
  }, [currentRoute]);

  return (
    <aside className={collapsed ? "sidebar sidebar--collapsed" : "sidebar"} aria-label="Primary navigation">
      <div className="sidebar-brand-row">
        <button
          type="button"
          className="brand"
          onClick={() => onNavigate("/overview")}
          title="Home (Overview)"
        >
          <img src="/favicon.svg" width="28" height="28" alt="" />
          {!collapsed && <span>NetMap</span>}
        </button>
      </div>
      <nav>
        {appRoutes
          .filter((route) => !route.requiresSecurityRole || canViewSecurity)
          .filter((route) => !route.requiresSuperAdmin || canAccessAdmin)
          .filter((route) => route.href !== "/exports" || canAccessExports)
          .map((route) => {
            const Icon = route.icon;
            const isAdminParent = route.href === "/admin" && currentRoute === "/admin";
            const isMonitoringParent = route.href === "/monitoring" && currentRoute === "/monitoring";
            const isInventoryParent = route.href === "/inventory" && currentRoute === "/inventory";
            const isIpamParent = route.href === "/ipam" && currentRoute === "/ipam";
            const isContextParent = isAdminParent || isMonitoringParent || isInventoryParent || isIpamParent;
            const isContextRoute = route.href === "/admin" || route.href === "/monitoring" || route.href === "/inventory" || route.href === "/ipam";
            const isContextExpanded = route.href === "/admin" ? adminMenuExpanded
              : route.href === "/monitoring" ? monitoringMenuExpanded
              : route.href === "/inventory" ? inventoryMenuExpanded
              : route.href === "/ipam" ? ipamMenuExpanded
              : false;
            return (
              <div key={route.href}>
	                {route.section && !collapsed && (
	                  <>
	                    {route.section !== "Network" && <span className="sidebar-section-rule" aria-hidden="true" />}
	                    <div className="sidebar-section-label">{route.section}</div>
	                  </>
	                )}
                <div className={isContextRoute && !collapsed ? "sidebar-link-row" : undefined}>
                <button
                  className={`${route.href === currentRoute ? "sidebar-link active" : "sidebar-link"}${isContextParent ? " sidebar-link--parent" : ""}`}
                  type="button"
                  title={collapsed ? route.label : undefined}
                  onClick={() => {
                    // The parent navigates and opens its menu — it never collapses it.
                    // Collapsing is the chevron's job, so the two never fight over a click.
                    if (isContextParent && !collapsed) {
                      if (route.href === "/admin") setAdminMenuExpanded(true);
                      if (route.href === "/monitoring") {
                        setMonitoringMenuExpanded(true);
                        if (activeMonitoringView !== "devices") { navigateToMonitoringView("devices"); setActiveMonitoringView("devices"); }
                      }
                      if (route.href === "/inventory") {
                        setInventoryMenuExpanded(true);
                        if (activeInventoryView !== "devices") { navigateToInventoryView("devices"); setActiveInventoryView("devices"); }
                      }
                      if (route.href === "/ipam") {
                        setIpamMenuExpanded(true);
                        if (activeIpamView !== "internal") { navigateToIpamView("internal"); setActiveIpamView("internal"); }
                      }
                      return;
                    }
                    // Clicking a section name always drops its menu down, even if it was
                    // collapsed earlier — you clicked the section, so you want its contents.
                    // The chevron is what keeps a menu shut.
                    if (route.href === "/admin") setAdminMenuExpanded(true);
                    if (route.href === "/monitoring") { setMonitoringMenuExpanded(true); setActiveMonitoringView("devices"); }
                    if (route.href === "/inventory") { setInventoryMenuExpanded(true); setActiveInventoryView("devices"); }
                    if (route.href === "/ipam") { setIpamMenuExpanded(true); setActiveIpamView("internal"); }
                    onNavigate(route.href);
                  }}

                >
                  <Icon size={18} aria-hidden="true" />
                  {!collapsed && <span className="sidebar-link-label">{route.label}</span>}
                  {route.href === "/inventory" && openObservationCount && openObservationCount > 0 ? (
                    <span className="sidebar-badge" aria-label={`${openObservationCount} open network changes`}>
                      {openObservationCount > 99 ? "99+" : openObservationCount}
                    </span>
                  ) : null}
                </button>
                {isContextRoute && !collapsed && (
                  <button
                    type="button"
                    className="sidebar-parent-toggle"
                    aria-label={`${isContextExpanded ? "Collapse" : "Expand"} ${route.label} sections`}
                    aria-expanded={isContextExpanded}
                    onClick={() => {
                      if (route.href === "/admin") setAdminMenuExpanded((expanded) => !expanded);
                      if (route.href === "/monitoring") setMonitoringMenuExpanded((expanded) => !expanded);
                      if (route.href === "/inventory") setInventoryMenuExpanded((expanded) => !expanded);
                      if (route.href === "/ipam") setIpamMenuExpanded((expanded) => !expanded);
                    }}
                  >
                    <ChevronDown className="sidebar-parent-chevron" size={14} aria-hidden="true" />
                  </button>
                )}
                </div>
                {route.href === "/admin" && !collapsed && adminMenuExpanded && (
                  <div className="sidebar-admin-subnav" aria-label="Administration sections">
                    {availableAdminTabs(user).map(({ id, label, Icon: AdminIcon }) => (
                      <button
                        key={id}
                        type="button"
                        className={currentRoute === "/admin" && activeAdminTab === id ? "sidebar-admin-link active" : "sidebar-admin-link"}
                        aria-current={currentRoute === "/admin" && activeAdminTab === id ? "page" : undefined}
                        onClick={() => {
                          // The menu stays open off-route, so a sub-item may need to take
                          // you back to its section before selecting the view.
                          if (currentRoute !== "/admin") onNavigate("/admin");
                          navigateToAdminTab(id);
                          setActiveAdminTab(id);
                          window.scrollTo({ top: 0, behavior: "smooth" });
                        }}
                      >
                        <AdminIcon size={14} aria-hidden="true" />
                        <span>{label}</span>
                      </button>
                    ))}
                  </div>
                )}
                {route.href === "/inventory" && !collapsed && inventoryMenuExpanded && (
                  <div className="sidebar-admin-subnav sidebar-monitoring-subnav" aria-label="Inventory sections">
                    {inventoryViews.map(({ id, label, Icon: InventoryIcon }) => (
                      <button
                        key={id}
                        type="button"
                        className={currentRoute === "/inventory" && activeInventoryView === id ? "sidebar-admin-link active" : "sidebar-admin-link"}
                        aria-current={currentRoute === "/inventory" && activeInventoryView === id ? "page" : undefined}
                        onClick={() => {
                          // The menu stays open off-route, so a sub-item may need to take
                          // you back to its section before selecting the view.
                          if (currentRoute !== "/inventory") onNavigate("/inventory");
                          navigateToInventoryView(id);
                          setActiveInventoryView(id);
                          window.scrollTo({ top: 0, behavior: "smooth" });
                        }}
                      >
                        <InventoryIcon size={14} aria-hidden="true" />
                        <span>{label}</span>
                      </button>
                    ))}
                  </div>
                )}
                {route.href === "/ipam" && !collapsed && ipamMenuExpanded && (
                  <div className="sidebar-admin-subnav sidebar-monitoring-subnav" aria-label="IP address management sections">
                    {ipamViews.map(({ id, label, Icon: IpamIcon }) => (
                      <button
                        key={id}
                        type="button"
                        className={currentRoute === "/ipam" && activeIpamView === id ? "sidebar-admin-link active" : "sidebar-admin-link"}
                        aria-current={currentRoute === "/ipam" && activeIpamView === id ? "page" : undefined}
                        onClick={() => {
                          // The menu stays open off-route, so a sub-item may need to take
                          // you back to its section before selecting the view.
                          if (currentRoute !== "/ipam") onNavigate("/ipam");
                          navigateToIpamView(id);
                          setActiveIpamView(id);
                          window.scrollTo({ top: 0, behavior: "smooth" });
                        }}
                      >
                        <IpamIcon size={14} aria-hidden="true" />
                        <span>{label}</span>
                      </button>
                    ))}
                  </div>
                )}
                {route.href === "/monitoring" && !collapsed && monitoringMenuExpanded && (
                  <div className="sidebar-admin-subnav sidebar-monitoring-subnav" aria-label="Monitoring sections">
                    {monitoringViews.map(({ id, label, Icon: MonitoringIcon }) => (
                      <button
                        key={id}
                        type="button"
                        className={currentRoute === "/monitoring" && activeMonitoringView === id ? "sidebar-admin-link active" : "sidebar-admin-link"}
                        aria-current={currentRoute === "/monitoring" && activeMonitoringView === id ? "page" : undefined}
                        onClick={() => {
                          // The menu stays open off-route, so a sub-item may need to take
                          // you back to its section before selecting the view.
                          if (currentRoute !== "/monitoring") onNavigate("/monitoring");
                          navigateToMonitoringView(id);
                          setActiveMonitoringView(id);
                          window.scrollTo({ top: 0, behavior: "smooth" });
                        }}
                      >
                        <MonitoringIcon size={14} aria-hidden="true" />
                        <span>{label}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
      </nav>
      <div className="sidebar-footer-actions">
        <button
          type="button"
          className="sidebar-collapse-btn sidebar-collapse-btn--footer"
          onClick={onToggleCollapse}
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          {collapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
          {!collapsed && "Collapse sidebar"}
        </button>
        <button className="sidebar-theme-toggle" type="button" onClick={toggleTheme} title={collapsed ? (theme === "dark" ? "Light mode" : "Dark mode") : undefined}>
          {theme === "dark" ? <Sun size={16} aria-hidden="true" /> : <Moon size={16} aria-hidden="true" />}
          {!collapsed && (theme === "dark" ? "Light mode" : "Dark mode")}
        </button>
        <button className="sidebar-logout" type="button" onClick={onLogout} title={collapsed ? "Sign out" : undefined}>
          <LogOut size={16} aria-hidden="true" />
          {!collapsed && "Sign out"}
        </button>
      </div>
      {versionInfo && (
        <div className="sidebar-version" title={collapsed ? versionLabel : undefined}>
          {!collapsed && (
            <span>
              {versionLabel}
              {!versionInfo.up_to_date && versionInfo.latest && (
                <a href={versionInfo.release_url} target="_blank" rel="noreferrer" className="sidebar-version-update">
                  {" "}↑ v{versionInfo.latest}
                </a>
              )}
            </span>
          )}
        </div>
      )}
    </aside>
  );
}

export function AppTopbar({ currentRoute, user, note }: { currentRoute: AppRoute; user: User; note?: ReactNode }) {
  const route = appRouteByHref.get(currentRoute) ?? appRoutes[0];
  const Icon = route.icon;
  const copy = appRouteCopy[currentRoute] ?? { title: route.label, subtitle: "" };
  const [now, setNow] = useState(new Date());
  const displayName = user.display_name || user.username;
  const hour = now.getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
  const dateStr = now.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  const timeStr = now.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const showGreeting = currentRoute === "/overview";

  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(id);
  }, []);

  return (
    <header className="app-topbar">
      <div className="app-topbar-route">
        <span className="app-topbar-icon" aria-hidden="true">
          <Icon size={24} />
        </span>
        <div className="app-topbar-copy">
          <strong>{copy.title}</strong>
          {copy.subtitle && <small>{copy.subtitle}</small>}
        </div>
      </div>
      <div className="app-topbar-account">
        {currentRoute === "/monitoring" && note}
        {currentRoute === "/ipam" && note && <span className="app-topbar-note">{note}</span>}
        {currentRoute === "/locations" && note}
        {currentRoute === "/security" && note}
        {showGreeting && (
          <div className="app-topbar-greeting">
            <strong>{greeting}, {displayName}</strong>
            <span>{dateStr} · <span className="dash-clock">{timeStr}</span></span>
          </div>
        )}
      </div>
    </header>
  );
}
