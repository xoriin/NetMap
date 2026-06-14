import { useState, useEffect, type ReactNode } from "react";
import { LogOut, Moon, PanelLeftClose, PanelLeftOpen, Sun } from "lucide-react";
import { type AppRoute, appRoutes, appRouteByHref, appRouteCopy } from "./routes";
import { type User, type VersionInfo } from "./api/client";

export function Sidebar({
  canAccessAdmin,
  canAccessExports,
  canViewSecurity,
  collapsed,
  currentRoute,
  onLogout,
  onToggleTheme,
  onToggleCollapse,
  openObservationCount,
  theme,
  onNavigate,
  versionInfo,
}: {
  canAccessAdmin: boolean;
  canAccessExports: boolean;
  canViewSecurity: boolean;
  collapsed: boolean;
  currentRoute: AppRoute;
  onLogout: () => void;
  onToggleTheme: () => void;
  onToggleCollapse: () => void;
  openObservationCount?: number;
  theme: "light" | "dark";
  onNavigate: (route: AppRoute) => void;
  versionInfo: VersionInfo | null;
}) {
  const versionLabel = versionInfo
    ? `${versionInfo.channel ? `${versionInfo.channel}: ` : "v"}${versionInfo.current}`
    : "";

  return (
    <aside className={collapsed ? "sidebar sidebar--collapsed" : "sidebar"} aria-label="Primary navigation">
      <div className="brand">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="24" height="24" aria-hidden="true">
          <line x1="16" y1="8" x2="8" y2="24" stroke="#1d6472" strokeWidth="2" strokeLinecap="round"/>
          <line x1="16" y1="8" x2="24" y2="24" stroke="#1d6472" strokeWidth="2" strokeLinecap="round"/>
          <line x1="8" y1="24" x2="24" y2="24" stroke="#1d6472" strokeWidth="2" strokeLinecap="round"/>
          <circle cx="16" cy="8" r="3.5" fill="#1d9ab0"/>
          <circle cx="8" cy="24" r="3.5" fill="#5bc8da"/>
          <circle cx="24" cy="24" r="3.5" fill="#5bc8da"/>
        </svg>
        {!collapsed && <span>NetMap</span>}
      </div>
      <button
        type="button"
        className="sidebar-collapse-btn"
        onClick={onToggleCollapse}
        title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
      >
        {collapsed ? <PanelLeftOpen size={15} /> : <PanelLeftClose size={15} />}
        {!collapsed && <span className="nav-label">Collapse</span>}
      </button>
      <nav>
        {appRoutes
          .filter((route) => !route.requiresSecurityRole || canViewSecurity)
          .filter((route) => !route.requiresSuperAdmin || canAccessAdmin)
          .filter((route) => route.href !== "/exports" || canAccessExports)
          .map((route) => {
            const Icon = route.icon;
            return (
              <div key={route.href}>
	                {route.section && !collapsed && (
	                  <>
	                    {route.section !== "Network" && <span className="sidebar-section-rule" aria-hidden="true" />}
	                    <div className="sidebar-section-label">{route.section}</div>
	                  </>
	                )}
                <button
                  className={route.href === currentRoute ? "sidebar-link active" : "sidebar-link"}
                  type="button"
                  title={collapsed ? route.label : undefined}
                  onClick={() => onNavigate(route.href)}
                >
                  <Icon size={18} aria-hidden="true" />
                  {!collapsed && route.label}
                  {route.href === "/inventory" && openObservationCount && openObservationCount > 0 ? (
                    <span className="sidebar-badge" aria-label={`${openObservationCount} open network changes`}>
                      {openObservationCount > 99 ? "99+" : openObservationCount}
                    </span>
                  ) : null}
                </button>
              </div>
            );
          })}
      </nav>
      <button className="sidebar-theme-toggle" type="button" onClick={onToggleTheme} title={collapsed ? (theme === "dark" ? "Light mode" : "Dark mode") : undefined}>
        {theme === "dark" ? <Sun size={16} aria-hidden="true" /> : <Moon size={16} aria-hidden="true" />}
        {!collapsed && (theme === "dark" ? "Light mode" : "Dark mode")}
      </button>
      <button className="sidebar-logout" type="button" onClick={onLogout} title={collapsed ? "Sign out" : undefined}>
        <LogOut size={16} aria-hidden="true" />
        {!collapsed && "Sign out"}
      </button>
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
