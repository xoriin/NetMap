import {
  createContext, useContext, useEffect, useMemo, useState, type ReactNode,
} from "react";
import { STATUS_SLUG_PATTERN } from "../utils/statusRoute";
import { storageKeys, readString, writeString } from "../utils/storage";

export type Theme = "light" | "dark";
export type ThemeSource = "stored" | "system";

type ThemeApi = {
  theme: Theme;
  themeSource: ThemeSource;
  toggleTheme: () => void;
};

const ThemeCtx = createContext<ThemeApi | null>(null);
const DARK_QUERY = "(prefers-color-scheme: dark)";

export function useTheme(): ThemeApi {
  const api = useContext(ThemeCtx);
  if (!api) throw new Error("useTheme must be used inside <ThemeProvider>");
  return api;
}

function systemTheme(): Theme {
  return window.matchMedia?.(DARK_QUERY).matches ? "dark" : "light";
}

function initialTheme(): { theme: Theme; source: ThemeSource } {
  const stored = readString(storageKeys.theme);
  if (stored === "light" || stored === "dark") return { theme: stored, source: "stored" };
  if (STATUS_SLUG_PATTERN.test(window.location.pathname)) return { theme: systemTheme(), source: "system" };
  return { theme: "dark", source: "stored" };
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [initial] = useState(initialTheme);
  const [theme, setTheme] = useState<Theme>(initial.theme);
  const [themeSource, setThemeSource] = useState<ThemeSource>(initial.source);

  useEffect(() => {
    if (themeSource === "stored") writeString(storageKeys.theme, theme);
    document.body.classList.toggle("theme-dark", theme === "dark");
  }, [theme, themeSource]);

  useEffect(() => {
    if (themeSource !== "system" || !window.matchMedia) return;
    const query = window.matchMedia(DARK_QUERY);
    const follow = () => setTheme(query.matches ? "dark" : "light");
    query.addEventListener("change", follow);
    return () => query.removeEventListener("change", follow);
  }, [themeSource]);

  const api = useMemo<ThemeApi>(() => ({
    theme,
    themeSource,
    toggleTheme: () => {
      setThemeSource("stored");
      setTheme((current) => (current === "dark" ? "light" : "dark"));
    },
  }), [theme, themeSource]);

  return <ThemeCtx.Provider value={api}>{children}</ThemeCtx.Provider>;
}
