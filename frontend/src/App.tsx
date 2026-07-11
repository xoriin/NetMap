import { useState, useEffect, useMemo, useRef, type ReactNode } from "react";
import { Moon, Sun } from "lucide-react";
import {
  type SystemSettings, type TokenPair, type User, type VersionInfo, api, subscribeTokenRefresh,
} from "./api/client";
import { useGraphData } from "./hooks/useGraphData";
import { useTheme } from "./providers/ThemeProvider";
import { storageKeys, readBool, writeBool } from "./utils/storage";
import {
  type AppRoute,
  readStoredTokens, storeTokens, readRouteFromLocation, navigateToRoute, isMethodNotAllowedError,
  routeBodyClass, routeDocumentTitle,
} from "./routes";
import { TopbarNoteCtx } from "./context";
import { LoadingView } from "./views/LoadingView";
import { SetupView } from "./features/auth/SetupView";
import { LoginView } from "./features/auth/LoginView";
import { ResetPasswordView } from "./features/auth/ResetPasswordView";
import { Sidebar, AppTopbar } from "./Sidebar";
import { DashboardView } from "./views/DashboardView";
import { WhatsNewModal, shouldShowWhatsNew } from "./components/WhatsNewModal";

export function App() {
  const [needsSetup, setNeedsSetup] = useState<boolean | null>(null);
  const [tokens, setTokens] = useState<TokenPair | null>(() => readStoredTokens());
  const [user, setUser] = useState<User | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [currentRoute, setCurrentRoute] = useState<AppRoute>(() => readRouteFromLocation());
  const [appSettings, setAppSettings] = useState<SystemSettings | null>(null);
  const [topbarNote, setTopbarNote] = useState<ReactNode>("");
  const idleTimeoutMs = (appSettings?.idle_timeout_minutes ?? 15) * 60 * 1000;
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => readBool(storageKeys.sidebarCollapsed));
  const { theme, toggleTheme } = useTheme();
  const [versionInfo, setVersionInfo] = useState<VersionInfo | null>(null);
  const [showWhatsNew, setShowWhatsNew] = useState(false);
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

  const screen = useMemo(() => {
    if (resetToken) return "reset-password";
    if (loading || needsSetup === null) return "loading";
    if (needsSetup) return "setup";
    if (!accessToken || !user) return "login";
    return "dashboard";
  }, [accessToken, loading, needsSetup, user, resetToken]);

  const documentTitle = useMemo(() => {
    if (screen === "dashboard") return routeDocumentTitle(currentRoute);
    if (screen === "reset-password") return "Reset password";
    if (screen === "setup") return "Setup";
    if (screen === "login") return "Login";
    return "Loading";
  }, [currentRoute, screen]);

  useEffect(() => {
    void api.adminPublicSettings().then(setAppSettings).catch(() => {});
  }, []);

  useEffect(() => {
    if (!accessToken) return;
    void api.getVersion(accessToken).then(setVersionInfo).catch(() => {});
  }, [accessToken]);

  useEffect(() => {
    setShowWhatsNew(shouldShowWhatsNew(versionInfo, user));
    // Auto-open decision is made when the version info arrives (or the signed-in
    // user changes) — not on every user-object update, which would re-open the
    // modal after unrelated profile edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [versionInfo, user?.id]);

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
    const bodyClass = routeBodyClass(currentRoute);
    document.body.classList.add(bodyClass);
    return () => {
      document.body.classList.remove(bodyClass);
    };
  }, [currentRoute]);

  useEffect(() => {
    document.title = documentTitle;
  }, [documentTitle]);

  // Adopt tokens rotated inside the API client (proactive refresh or a
  // transparent 401 retry) so subsequent calls use the fresh access token.
  useEffect(() => subscribeTokenRefresh(setTokens), []);

  const bootstrapDoneRef = useRef(false);

  const {
    graph, summary, loadInitial, refreshTopology,
    upsertGraphDevice, removeGraphDevices, clearSummary,
  } = useGraphData({
    accessToken,
    active: screen === "dashboard",
    livePingEnabled: appSettings?.live_ping_enabled,
    monitorIntervalSeconds: appSettings?.monitor_interval_seconds,
    onError: setError,
  });

  useEffect(() => {
    // A token rotation for an already-authenticated session must not re-run
    // the bootstrap (it would flash the loading screen and refetch everything).
    if (bootstrapDoneRef.current && tokens?.access_token) {
      return;
    }
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
        bootstrapDoneRef.current = true;

        // Awaited so the loading screen covers the initial graph fetch;
        // non-405 failures surface through the shared error banner.
        await loadInitial(token);
        if (cancelled) {
          return;
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
    bootstrapDoneRef.current = false;
    storeTokens(null);
    setTokens(null);
    setUser(null);
    clearSummary();
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

  function closeWhatsNew() {
    setShowWhatsNew(false);
    const version = versionInfo?.current;
    if (version && accessToken && user?.whats_new_acknowledged_version !== version) {
      void api.acknowledgeWhatsNew(accessToken, version).then(setUser).catch(() => {});
    }
  }

  function openWhatsNew() {
    setShowWhatsNew(true);
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
            onClick={toggleTheme}
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
        onToggleCollapse={() => {
          setSidebarCollapsed((c) => {
            const next = !c;
            writeBool(storageKeys.sidebarCollapsed, next);
            return next;
          });
        }}
        openObservationCount={openObservationCount}
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
            <div className="dash-alert dash-alert--overview-bar dash-alert--announcement">
              <span className="dash-alert-dot dash-alert-dot--purple" aria-hidden="true" />
              <span>{appSettings.announcement}</span>
            </div>
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
            summary={summary}
            user={user}
            onOpenWhatsNew={openWhatsNew}
            versionInfo={versionInfo}
          />
          {showWhatsNew && versionInfo && (
            <WhatsNewModal versionInfo={versionInfo} onClose={closeWhatsNew} />
          )}
        </section>
        </TopbarNoteCtx.Provider>
      </section>
    </main>
  );
}
