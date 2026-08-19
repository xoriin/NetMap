import { useState, useEffect, type ReactNode } from "react";
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
  const [adminMenuExpanded, setAdminMenuExpanded] = useState(currentRoute === "/admin");
  const [activeMonitoringView, setActiveMonitoringView] = useState<MonitoringViewId>(() => readMonitoringViewFromLocation());
  const [monitoringMenuExpanded, setMonitoringMenuExpanded] = useState(currentRoute === "/monitoring");
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
    window.addEventListener("popstate", syncMonitoringView);
    window.addEventListener("hashchange", syncMonitoringView);
    window.addEventListener(MONITORING_VIEW_CHANGE_EVENT, syncMonitoringView);
    return () => {
      window.removeEventListener("popstate", syncMonitoringView);
      window.removeEventListener("hashchange", syncMonitoringView);
      window.removeEventListener(MONITORING_VIEW_CHANGE_EVENT, syncMonitoringView);
    };
  }, []);

  useEffect(() => {
    if (currentRoute === "/admin") {
      setActiveAdminTab(readAdminTabFromLocation());
      setAdminMenuExpanded(true);
    }
  }, [currentRoute]);

  useEffect(() => {
    if (currentRoute === "/monitoring") {
      setActiveMonitoringView(readMonitoringViewFromLocation());
      setMonitoringMenuExpanded(true);
    }
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
            const isContextParent = isAdminParent || isMonitoringParent;
            const isContextRoute = route.href === "/admin" || route.href === "/monitoring";
            const isContextExpanded = isAdminParent ? adminMenuExpanded : isMonitoringParent ? monitoringMenuExpanded : false;
            return (
              <div key={route.href}>
	                {route.section && !collapsed && (
	                  <>
	                    {route.section !== "Network" && <span className="sidebar-section-rule" aria-hidden="true" />}
	                    <div className="sidebar-section-label">{route.section}</div>
	                  </>
	                )}
                <button
                  className={`${route.href === currentRoute ? "sidebar-link active" : "sidebar-link"}${isContextParent ? " sidebar-link--parent" : ""}`}
                  type="button"
                  title={collapsed ? route.label : undefined}
                  onClick={() => {
                    if (route.href === "/admin" && currentRoute === "/admin" && !collapsed) {
                      setAdminMenuExpanded((expanded) => !expanded);
                      return;
                    }
                    if (route.href === "/monitoring" && currentRoute === "/monitoring" && !collapsed) {
                      setMonitoringMenuExpanded((expanded) => !expanded);
                      return;
                    }
                    if (route.href === "/admin") setAdminMenuExpanded(true);
                    if (route.href === "/monitoring") setMonitoringMenuExpanded(true);
                    onNavigate(route.href);
                  }}
                  aria-expanded={isContextParent && !collapsed ? isContextExpanded : undefined}
                >
                  <Icon size={18} aria-hidden="true" />
                  {!collapsed && <span className="sidebar-link-label">{route.label}</span>}
                  {route.href === "/inventory" && openObservationCount && openObservationCount > 0 ? (
                    <span className="sidebar-badge" aria-label={`${openObservationCount} open network changes`}>
                      {openObservationCount > 99 ? "99+" : openObservationCount}
                    </span>
                  ) : null}
                  {isContextRoute && !collapsed && (
                    <ChevronDown className={`sidebar-parent-chevron${isContextExpanded ? " is-expanded" : ""}`} size={14} aria-hidden="true" />
                  )}
                </button>
                {route.href === "/admin" && currentRoute === "/admin" && !collapsed && adminMenuExpanded && (
                  <div className="sidebar-admin-subnav" aria-label="Administration sections">
                    {availableAdminTabs(user).map(({ id, label, Icon: AdminIcon }) => (
                      <button
                        key={id}
                        type="button"
                        className={activeAdminTab === id ? "sidebar-admin-link active" : "sidebar-admin-link"}
                        aria-current={activeAdminTab === id ? "page" : undefined}
                        onClick={() => {
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
                {route.href === "/monitoring" && currentRoute === "/monitoring" && !collapsed && monitoringMenuExpanded && (
                  <div className="sidebar-admin-subnav sidebar-monitoring-subnav" aria-label="Monitoring sections">
                    {monitoringViews.map(({ id, label, Icon: MonitoringIcon }) => (
                      <button
                        key={id}
                        type="button"
                        className={activeMonitoringView === id ? "sidebar-admin-link active" : "sidebar-admin-link"}
                        aria-current={activeMonitoringView === id ? "page" : undefined}
                        onClick={() => {
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
