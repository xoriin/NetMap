import { apiRequest } from "../../api/client";
import type { StatusHeartbeatWindow, StatusPagePayload } from "./statusPagesApi";

export type StatusPageVisibility = "public" | "private";
export type StatusPreviewAudience = "public" | "private";

export type StatusPageSummary = {
  id: number;
  slug: string;
  name: string;
  title: string | null;
  visibility: StatusPageVisibility;
  heartbeat_window: StatusHeartbeatWindow;
  logo: string | null;
  accent: string | null;
  custom_css: string | null;
  created_at: string;
  updated_at: string;
};

export type StatusItemSource = { device?: number; monitor?: number; service_check?: number };

export type StatusItemExtras = {
  rtt_graph: boolean;
  uptime_period: "24h" | "7d" | "30d" | null;
  avg_response: boolean;
  p95_response: boolean;
  failure_rate: boolean;
  last_check: boolean;
};

export const NO_EXTRAS: StatusItemExtras = {
  rtt_graph: false, uptime_period: null, avg_response: false, p95_response: false, failure_rate: false, last_check: false,
};

export type StatusLayoutItem = {
  id: number | null;
  source: StatusItemSource;
  display_name: string;
  extras: StatusItemExtras;
};

export type StatusLayoutGroup = {
  id: number | null;
  name: string;
  collapsed_by_default: boolean;
  items: StatusLayoutItem[];
};

export type StatusPageDetail = StatusPageSummary & {
  groups: (StatusLayoutGroup & { id: number; items: (StatusLayoutItem & { id: number; source_key: string })[] })[];
};

export type StatusPageSettings = {
  name: string;
  slug: string;
  visibility: StatusPageVisibility;
  title: string | null;
  accent: string | null;
  heartbeat_window: StatusHeartbeatWindow;
  logo: string | null;
};

export type StatusServiceCheckSource = { id: number; label: string; port: number; check_type: string; enabled: boolean; global: boolean };
export type StatusDeviceSource = { id: number; name: string; ip_address: string | null; service_checks: StatusServiceCheckSource[] };
export type StatusMonitorSource = { id: number; name: string; url: string };
export type StatusSources = { devices: StatusDeviceSource[]; monitors: StatusMonitorSource[] };

const BASE = "/api/v1/status-pages";
const json = (body: unknown) => JSON.stringify(body);

export const statusPagesEditorApi = {
  list: (token: string) => apiRequest<StatusPageSummary[]>(BASE, { token }),
  create: (token: string, body: Pick<StatusPageSettings, "name" | "slug" | "visibility">) =>
    apiRequest<StatusPageSummary>(BASE, { method: "POST", token, body: json(body) }),
  get: (token: string, id: number) => apiRequest<StatusPageDetail>(`${BASE}/${id}`, { token }),
  update: (token: string, id: number, body: Partial<StatusPageSettings>) =>
    apiRequest<StatusPageSummary>(`${BASE}/${id}`, { method: "PATCH", token, body: json(body) }),
  remove: (token: string, id: number) => apiRequest<void>(`${BASE}/${id}`, { method: "DELETE", token }),
  saveLayout: (token: string, id: number, groups: StatusLayoutGroup[]) =>
    apiRequest<StatusPageDetail>(`${BASE}/${id}/layout`, { method: "PUT", token, body: json({ groups }) }),
  sources: (token: string) => apiRequest<StatusSources>(`${BASE}/sources`, { token }),
  preview: (token: string, id: number, audience: StatusPreviewAudience) =>
    apiRequest<StatusPagePayload>(`${BASE}/${id}/preview?audience=${audience}`, { token }),
};

export function sourceKey(source: StatusItemSource): string {
  if (source.monitor !== undefined) return `monitor:${source.monitor}`;
  if (source.service_check !== undefined) return `service:${source.device}:${source.service_check}`;
  return `device:${source.device}`;
}

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/;
const ACCENT_RE = /^#[0-9a-fA-F]{6}$/;

export const SLUG_HINT = "Use 1–48 lowercase letters, digits or hyphens, not starting or ending with a hyphen.";

export function isValidSlug(value: string): boolean {
  return SLUG_RE.test(value);
}

export function isValidAccent(value: string): boolean {
  return ACCENT_RE.test(value);
}

export function slugFromName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48).replace(/-+$/g, "");
}
