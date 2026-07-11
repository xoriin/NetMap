/**
 * Typed localStorage access. Centralizes key names and guards against
 * quota/privacy-mode exceptions so callers never need try/catch.
 */

export const storageKeys = {
  theme: "netmap.theme",
  iconPack: "netmap.icon_pack",
  sidebarCollapsed: "netmap.sidebar_collapsed",
} as const;

export function readString(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeString(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Quota exceeded or storage unavailable — persisting is best-effort.
  }
}

export function removeKey(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // Ignore — removal is best-effort.
  }
}

export function readBool(key: string): boolean {
  return readString(key) === "1";
}

export function writeBool(key: string, value: boolean): void {
  writeString(key, value ? "1" : "0");
}

export function readJson<T>(key: string): T | null {
  const raw = readString(key);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function writeJson(key: string, value: unknown): void {
  writeString(key, JSON.stringify(value));
}
