import { useState, useEffect, useMemo, useRef, type ReactNode } from "react";
import { Moon, Sun } from "lucide-react";
import {
  type DashboardSummary, type Device, type DeviceMonitorSummary, type DeviceStatus, type SystemSettings, type TokenPair,
  type TopologyGraph, type User, type VersionInfo, api,
} from "./api/client";
import { themeStorageKey, iconPackStorageKey } from "./constants";
import {
  builtInIconPack, loadIconPacks, readLocalIconPacks, writeLocalIconPacks,
  applyIconPackSelection, refreshDeviceTypeIconMap, type IconPack,
} from "./icons";
import {
  type AppRoute,
  readStoredTokens, storeTokens, readRouteFromLocation, navigateToRoute, isMethodNotAllowedError,
} from "./routes";
import { TopbarNoteCtx } from "./context";
import { LoadingView } from "./views/LoadingView";
import { SetupView } from "./features/auth/SetupView";
import { LoginView } from "./features/auth/LoginView";
import { ResetPasswordView } from "./features/auth/ResetPasswordView";
import { Sidebar, AppTopbar } from "./Sidebar";
import { DashboardView } from "./views/DashboardView";

export function App() {
  const [needsSetup, setNeedsSetup] = useState<boolean | null>(null);
  const [tokens, setTokens] = useState<TokenPair | null>(() => readStoredTokens());
  const [user, setUser] = useState<User | null>(null);
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [graph, setGraph] = useState<TopologyGraph>({ devices: [], relationships: [] });
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [currentRoute, setCurrentRoute] = useState<AppRoute>(() => readRouteFromLocation());
  const [appSettings, setAppSettings] = useState<SystemSettings | null>(null);
  const [topbarNote, setTopbarNote] = useState<ReactNode>("");
  const idleTimeoutMs = (appSettings?.idle_timeout_minutes ?? 15) * 60 * 1000;
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => window.localStorage.getItem("netmap.sidebar_collapsed") === "1");
  const [theme, setTheme] = useState<"light" | "dark">(() => {
    const stored = window.localStorage.getItem(themeStorageKey);
    return stored === "light" ? "light" : "dark";
  });
  const [iconPacks, setIconPacks] = useState<IconPack[]>([]);
  const [localIconPacks, setLocalIconPacks] = useState<IconPack[]>(() => readLocalIconPacks());
  const [iconPackLoading, setIconPackLoading] = useState(true);
  const [activeIconPackId, setActiveIconPackId] = useState(() => window.localStorage.getItem(iconPackStorageKey) || builtInIconPack.id);
  const [iconPackError, setIconPackError] = useState<string | null>(null);
  const [versionInfo, setVersionInfo] = useState<VersionInfo | null>(null);
  const topologyRefreshRequestIdRef = useRef(0);
  const monitorCursorRef = useRef<string | null>(null);
  const monitorPollCountRef = useRef(0);
  const [resetToken, setResetToken] = useState<string | null>(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get("reset_token");
  });

  const accessToken = tokens?.access_token ?? null;
  const canViewSecurity =
    user?.role === "SuperAdmin" || user?.role === "NetworkAdmin" || user?.role === "SecurityAnalyst";
  const canAccessExports = user?.role !== "Viewer";
  const canAccessAdmin = user?.role === "SuperAdmin";
  const [openObservationCount, setOpenObservationCount] = useState(0);

  useEffect(() => {
    void api.adminPublicSettings().then(setAppSettings).catch(() => {});
  }, []);

  useEffect(() => {
    if (!accessToken) return;
    void api.getVersion(accessToken).then(setVersionInfo).catch(() => {});
  }, [accessToken]);

  useEffect(() => {
    if (!accessToken) return;
    void api.adminPublicSettings().then(setAppSettings).catch(() => {});
  }, [accessToken]);

  const refreshObservationCount = useMemo(() => {
    if (!accessToken || !canAccessAdmin) return undefined;
    return () => {
      void api.listDiscoveryObservations(accessToken, { status_filter: "open" })
        .then((obs) => setOpenObservationCount(obs.length))
        .catch(() => {});
    };
  }, [accessToken, canAccessAdmin]);

  useEffect(() => {
    if (!refreshObservationCount) return;
    refreshObservationCount();
    const id = window.setInterval(refreshObservationCount, 5 * 60 * 1000);
    return () => window.clearInterval(id);
  }, [refreshObservationCount]);

  useEffect(() => {
    const syncRoute = () => setCurrentRoute(readRouteFromLocation());
    window.addEventListener("popstate", syncRoute);
    return () => window.removeEventListener("popstate", syncRoute);
  }, []);

  useEffect(() => {
    window.localStorage.setItem(themeStorageKey, theme);
    document.body.classList.toggle("theme-dark", theme === "dark");
  }, [theme]);

  useEffect(() => {
    let cancelled = false;
    async function bootstrapIconPacks() {
      setIconPackLoading(true);
      const loaded = await loadIconPacks();
      if (cancelled) return;
      setIconPacks(loaded);
      setIconPackLoading(false);
      setIconPackError(null);
    }
    void bootstrapIconPacks();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    writeLocalIconPacks(localIconPacks);
  }, [localIconPacks]);

  useEffect(() => {
    const merged = [...iconPacks];
    localIconPacks.forEach((pack) => {
      const existingIndex = merged.findIndex((row) => row.id === pack.id);
      if (existingIndex >= 0) merged[existingIndex] = pack;
      else merged.push(pack);
    });
    const available = [builtInIconPack, ...merged];
    const selected = available.some((pack) => pack.id === activeIconPackId) ? activeIconPackId : builtInIconPack.id;
    applyIconPackSelection(available, selected);
    refreshDeviceTypeIconMap();
    if (selected !== activeIconPackId) {
      setActiveIconPackId(selected);
      setIconPackError("Selected icon pack was not found; reverted to Built-in.");
      return;
    }
    window.localStorage.setItem(iconPackStorageKey, selected);
  }, [activeIconPackId, iconPacks, localIconPacks]);

  useEffect(() => {
    document.body.classList.toggle("route-topology", currentRoute === "/topology");
    document.body.classList.toggle("route-security", currentRoute === "/security");
    document.body.classList.toggle("route-inventory", currentRoute === "/inventory");
    document.body.classList.toggle("route-vlans", currentRoute === "/vlans");
    document.body.classList.toggle("route-locations", currentRoute === "/locations");
    document.body.classList.toggle("route-monitoring", currentRoute === "/monitoring");
    document.body.classList.toggle("route-ipam", currentRoute === "/ipam");
    return () => {
      document.body.classList.remove("route-topology");
      document.body.classList.remove("route-security");
      document.body.classList.remove("route-inventory");
      document.body.classList.remove("route-vlans");
      document.body.classList.remove("route-locations");
      document.body.classList.remove("route-monitoring");
      document.body.classList.remove("route-ipam");
    };
  }, [currentRoute]);

  useEffect(() => {
    let cancelled = false;
    async function bootstrap() {
      setLoading(true);
      setError(null);
      let token = tokens?.access_token ?? null;
      try {
        const setup = await api.setupStatus();
        if (cancelled) {
          return;
        }
        setNeedsSetup(setup.needs_setup);

        if (setup.needs_setup) {
          return;
        }

        // If no access token in state, try to restore the session via the
        // HttpOnly refresh-token cookie.
        if (!token) {
          try {
            const refreshed = await api.refresh();
            if (cancelled) return;
            token = refreshed.access_token;
            setTokens(refreshed);
          } catch {
            // No valid cookie — show login.
            return;
          }
        }

        const currentUser = await api.me(token);
        if (cancelled) {
          return;
        }
        setUser(currentUser);

        const [dashboardResult, topologyResult] = await Promise.allSettled([
          api.dashboardSummary(token),
          api.topologyGraph(token),
        ]);
        if (cancelled) {
          return;
        }
        if (dashboardResult.status === "fulfilled") {
          setSummary(dashboardResult.value);
        } else if (dashboardResult.reason instanceof Error) {
          if (!isMethodNotAllowedError(dashboardResult.reason)) {
            setError(dashboardResult.reason.message);
          }
        }
        if (topologyResult.status === "fulfilled") {
          setGraph(topologyResult.value);
        } else if (topologyResult.reason instanceof Error) {
          if (!isMethodNotAllowedError(topologyResult.reason)) {
            setError(topologyResult.reason.message);
          }
        }
      } catch (err) {
        if (!cancelled) {
          if (err instanceof Error && isMethodNotAllowedError(err)) {
            setError(null);
          } else {
            setError(err instanceof Error ? err.message : "Unable to load NetMap");
          }
          storeTokens(null);
          setTokens(null);
          setUser(null);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }
    bootstrap();
    return () => {
      cancelled = true;
    };
  }, [tokens?.access_token]);

  const screen = useMemo(() => {
    if (resetToken) return "reset-password";
    if (loading || needsSetup === null) return "loading";
    if (needsSetup) return "setup";
    if (!accessToken || !user) return "login";
    return "dashboard";
  }, [accessToken, loading, needsSetup, user, resetToken]);

  async function handleSetup(username: string, password: string) {
    setError(null);
    await api.createAdmin(username, password);
    const newTokens = await api.login(username, password);
    storeTokens(newTokens);
    setTokens(newTokens);
    setNeedsSetup(false);
    navigateToRoute("/overview", true);
    setCurrentRoute("/overview");
  }

  async function handleLogin(username: string, password: string) {
    setError(null);
    const newTokens = await api.login(username, password);
    storeTokens(newTokens);
    setTokens(newTokens);
    navigateToRoute("/overview", true);
    setCurrentRoute("/overview");
  }

  async function handleLogout(reason: "user" | "idle" | "expired" = "user") {
    const token = tokens?.access_token;
    try {
      await api.logout(token);
    } catch {
      // Session cleanup must proceed even when server-side revoke fails.
    }
    storeTokens(null);
    setTokens(null);
    setUser(null);
    setSummary(null);
    window.history.replaceState(null, "", "/");
    setCurrentRoute("/overview");
    if (reason === "idle") {
      setError(`Session timed out after ${Math.round(idleTimeoutMs / 60_000)} minutes of inactivity.`);
    } else if (reason === "expired") {
      setError("Session expired. Sign in again.");
    }
  }

  // Proactive token refresh — fires 3 min before the 60-min access token expiry.
  useEffect(() => {
    if (screen !== "dashboard" || !tokens?.access_token) return;
    const intervalId = window.setInterval(async () => {
      try {
        const refreshed = await api.refresh();
        setTokens(refreshed);
      } catch {
        void handleLogout("expired");
      }
    }, 57 * 60 * 1000);
    return () => window.clearInterval(intervalId);
  }, [screen, tokens?.access_token]);

  useEffect(() => {
    if (screen !== "dashboard" || !accessToken || appSettings?.live_ping_enabled === false) {
      monitorCursorRef.current = null;
      monitorPollCountRef.current = 0;
      return;
    }

    const validStatuses = new Set<DeviceStatus>(["online", "offline", "warning", "unknown", "disabled"]);
    const boundedMonitorIntervalSeconds = Math.min(3600, Math.max(30, appSettings?.monitor_interval_seconds ?? 300));
    const pollMs = Math.min(60_000, Math.max(30_000, boundedMonitorIntervalSeconds * 1000));
    const fullRefreshPolls = Math.max(1, Math.ceil(300_000 / pollMs));
    let cancelled = false;
    const token = accessToken;

    function applyMonitorRows(rows: DeviceMonitorSummary[]) {
      if (rows.length === 0) return;
      const byId = new Map(rows.map((row) => [row.device_id, row]));
      setGraph((current) => {
        let changed = false;
        const devices = current.devices.map((device) => {
          const row = byId.get(device.id);
          if (!row || !validStatuses.has(row.status as DeviceStatus)) {
            return device;
          }
          const nextStatus = row.status as DeviceStatus;
          const nextCheckedAt = row.last_checked ?? device.last_monitored_at;
          if (device.monitor_status === nextStatus && device.last_monitored_at === nextCheckedAt) {
            return device;
          }
          changed = true;
          return {
            ...device,
            monitor_status: nextStatus,
            last_monitored_at: nextCheckedAt,
          };
        });
        return changed ? { ...current, devices } : current;
      });
    }

    async function pollMonitoring(forceFull = false) {
      try {
        const previousCursor = monitorCursorRef.current;
        const shouldFullRefresh = forceFull || !previousCursor || monitorPollCountRef.current >= fullRefreshPolls;
        const [fleet, rows] = await Promise.all([
          api.getMonitoringSummary(token),
          api.listMonitoringDevices(token, shouldFullRefresh ? undefined : previousCursor),
        ]);
        if (cancelled) return;
        applyMonitorRows(rows);
        monitorCursorRef.current = fleet.last_checked ?? previousCursor;
        monitorPollCountRef.current = shouldFullRefresh ? 1 : monitorPollCountRef.current + 1;
      } catch {
        // Keep the current graph state; the next poll or route refresh will reconcile.
      }
    }

    void pollMonitoring(true);
    const intervalId = window.setInterval(() => {
      void pollMonitoring(false);
    }, pollMs);
    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [accessToken, appSettings?.live_ping_enabled, appSettings?.monitor_interval_seconds, screen]);

  useEffect(() => {
    if (screen !== "dashboard" || !tokens?.access_token) {
      return;
    }
    let timeoutId = window.setTimeout(() => {
      void handleLogout("idle");
    }, idleTimeoutMs);
    const reset = () => {
      window.clearTimeout(timeoutId);
      timeoutId = window.setTimeout(() => {
        void handleLogout("idle");
      }, idleTimeoutMs);
    };
    const events = ["pointerdown", "keydown", "mousemove", "touchstart", "scroll"];
    events.forEach((eventName) => window.addEventListener(eventName, reset, { passive: true }));
    return () => {
      window.clearTimeout(timeoutId);
      events.forEach((eventName) => window.removeEventListener(eventName, reset));
    };
  }, [screen, tokens?.access_token, idleTimeoutMs]);

  async function refreshTopology(token = accessToken) {
    if (!token) {
      return;
    }
    const requestId = ++topologyRefreshRequestIdRef.current;
    const [dashboard, topology] = await Promise.all([
      api.dashboardSummary(token),
      api.topologyGraph(token),
    ]);
    if (requestId !== topologyRefreshRequestIdRef.current) {
      return;
    }
    setSummary(dashboard);
    setGraph(topology);
  }

  function upsertGraphDevice(device: Device) {
    setGraph((current) => {
      const exists = current.devices.some((row) => row.id === device.id);
      return {
        ...current,
        devices: exists
          ? current.devices.map((row) => (row.id === device.id ? device : row))
          : [...current.devices, device],
      };
    });
  }

  function removeGraphDevices(deviceIds: number[]) {
    const removeSet = new Set(deviceIds);
    setGraph((current) => ({
      devices: current.devices.filter((device) => !removeSet.has(device.id)),
      relationships: current.relationships.filter(
        (relationship) =>
          !removeSet.has(relationship.source_device_id) &&
          !removeSet.has(relationship.target_device_id),
      ),
    }));
  }

  useEffect(() => {
    if (screen !== "dashboard" || !user) {
      if (window.location.pathname !== "/") {
        window.history.replaceState(null, "", "/");
      }
      return;
    }
    if (currentRoute === "/security" && !canViewSecurity) {
      navigateToRoute("/overview", true);
      setCurrentRoute("/overview");
      return;
    }
    if (currentRoute === "/exports" && !canAccessExports) {
      navigateToRoute("/overview", true);
      setCurrentRoute("/overview");
      return;
    }
    if (currentRoute === "/admin" && !canAccessAdmin) {
      navigateToRoute("/overview", true);
      setCurrentRoute("/overview");
      return;
    }
    if (window.location.pathname === "/") {
      navigateToRoute(currentRoute, true);
    }
  }, [canAccessAdmin, canAccessExports, canViewSecurity, currentRoute, screen, user]);

  if (screen !== "dashboard" || !user) {
    return (
      <main className="auth-shell">
        <div className="auth-split-left" aria-hidden="true">
          <div className="auth-brand-panel">
            <div className="auth-brand-mark">
              <img src="/favicon.svg" width="80" height="80" alt="" />
            </div>
            <div className="auth-brand-wordmark">NetMap</div>
            <div className="auth-brand-tagline">Network topology &amp; monitoring for your infrastructure</div>
            <div className="auth-brand-stats">
              <div className="auth-brand-stat"><span className="auth-brand-stat-dot" />Discover &amp; map your network</div>
              <div className="auth-brand-stat"><span className="auth-brand-stat-dot" />Monitor device health in real-time</div>
              <div className="auth-brand-stat"><span className="auth-brand-stat-dot" />Alert on events that matter</div>
            </div>
          </div>
        </div>
        <div className="auth-split-right">
          <button
            className="auth-theme-toggle"
            type="button"
            onClick={() => setTheme((current) => (current === "dark" ? "light" : "dark"))}
          >
            {theme === "dark" ? <Sun size={15} aria-hidden="true" /> : <Moon size={15} aria-hidden="true" />}
            {theme === "dark" ? "Light mode" : "Dark mode"}
          </button>
          <section className="auth-workspace">
            {error && <div className="error-banner">{error}</div>}
            {screen === "loading" && <LoadingView />}
            {screen === "setup" && <SetupView onSubmit={handleSetup} />}
            {screen === "login" && <LoginView onSubmit={handleLogin} appName={appSettings?.app_name} loginMessage={appSettings?.login_message} />}
            {screen === "reset-password" && (
              <ResetPasswordView
                resetToken={resetToken!}
                onSuccess={() => {
                  window.history.replaceState(null, "", "/");
                  setResetToken(null);
                }}
              />
            )}
          </section>
        </div>
      </main>
    );
  }

  return (
    <main className={sidebarCollapsed ? "app-shell app-shell--sidebar-collapsed" : "app-shell"}>
      <Sidebar
        canAccessAdmin={canAccessAdmin}
        canAccessExports={canAccessExports}
        canViewSecurity={canViewSecurity}
        collapsed={sidebarCollapsed}
        currentRoute={currentRoute}
        onLogout={() => void handleLogout("user")}
        onToggleTheme={() => setTheme((current) => (current === "dark" ? "light" : "dark"))}
        onToggleCollapse={() => {
          setSidebarCollapsed((c) => {
            const next = !c;
            window.localStorage.setItem("netmap.sidebar_collapsed", next ? "1" : "0");
            return next;
          });
        }}
        openObservationCount={openObservationCount}
        theme={theme}
        onNavigate={(route) => {
          if (route === currentRoute) {
            return;
          }
          navigateToRoute(route);
          setCurrentRoute(route);
          window.scrollTo({ top: 0, behavior: "smooth" });
        }}
        versionInfo={versionInfo}
      />
      <section className="app-main">
        <AppTopbar currentRoute={currentRoute} user={user} note={topbarNote} />
        <TopbarNoteCtx.Provider value={setTopbarNote}>
        <section className="workspace">
          {error && <div className="error-banner">{error}</div>}
          {appSettings?.announcement && (
            <div className="announcement-banner">{appSettings.announcement}</div>
          )}
          <DashboardView
            accessToken={accessToken}
            currentRoute={currentRoute}
            graph={graph}
            livePingEnabled={appSettings?.live_ping_enabled !== false}
            monitorIntervalSeconds={appSettings?.monitor_interval_seconds ?? 300}
            onGraphChange={refreshTopology}
            onDeviceChange={upsertGraphDevice}
            onDevicesRemove={removeGraphDevices}
            onNavigate={(route) => {
              navigateToRoute(route);
              setCurrentRoute(route);
              window.scrollTo({ top: 0, behavior: "smooth" });
            }}
            onSettingsChange={setAppSettings}
            onUserUpdate={setUser}
            onObservationActioned={refreshObservationCount}
            openObservationCount={openObservationCount}
            theme={theme}
            summary={summary}
            user={user}
            activeIconPackId={activeIconPackId}
            iconPackLoading={iconPackLoading}
            iconPacks={iconPacks}
            localIconPacks={localIconPacks}
            iconPackError={iconPackError}
            onSelectIconPack={(packId) => {
              setIconPackError(null);
              setActiveIconPackId(packId);
            }}
            onAddLocalIconPack={(pack) => {
              setLocalIconPacks((current) => {
                const index = current.findIndex((row) => row.id === pack.id);
                if (index >= 0) {
                  const next = [...current];
                  next[index] = pack;
                  return next;
                }
                return [...current, pack];
              });
            }}
            onRemoveLocalIconPack={(packId) => {
              setLocalIconPacks((current) => current.filter((row) => row.id !== packId));
              if (activeIconPackId === packId) {
                setActiveIconPackId(builtInIconPack.id);
              }
            }}
            versionInfo={versionInfo}
          />
        </section>
        </TopbarNoteCtx.Provider>
      </section>
    </main>
  );
}
