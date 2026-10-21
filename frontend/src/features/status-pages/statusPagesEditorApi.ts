import { ApiError, apiRequest } from "../../api/client";
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
  custom_css: string | null;
};

export function cssErrors(err: unknown): string[] | null {
  if (!(err instanceof ApiError) || err.status !== 422 || !err.detail || typeof err.detail !== "object") return null;
  const errors = (err.detail as { css_errors?: unknown }).css_errors;
  return Array.isArray(errors) ? errors.map(String) : null;
}

export type StatusServiceCheckSource = { id: number; label: string; port: number; check_type: string; enabled: boolean; global: boolean };
export type StatusDeviceSource = { id: number; name: string; ip_address: string | null; service_checks: StatusServiceCheckSource[] };
export type StatusMonitorSource = { id: number; name: string; url: string };
export type StatusSources = { devices: StatusDeviceSource[]; monitors: StatusMonitorSource[] };

const BASE = "/api/v1/status-pages";
const json = (body: unknown) => JSON.stringify(body);

export const statusPageDefaultCssApi = {
  get: (token: string) => apiRequest<{ css: string | null }>("/api/v1/admin/status-page-default-css", { token }),
  save: (token: string, css: string | null) =>
    apiRequest<{ css: string | null }>("/api/v1/admin/status-page-default-css", { method: "PUT", token, body: json({ css }) }),
};

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

export type IncidentSeverity = "performance" | "partial" | "major";
export type IncidentStatus = "investigating" | "identified" | "monitoring" | "resolved";
export type NoticeLevel = "info" | "warning" | "critical";

export type ManagedIncidentUpdate = {
  id: number;
  at: string;
  page_id: number | null;
  author: string | null;
  author_kind: "person" | "token" | "netmap";
  is_public: boolean;
  status: IncidentStatus | null;
  message: string | null;
  event_code: string | null;
};

export type ManagedIncident = {
  id: number;
  title: string;
  severity: IncidentSeverity;
  status: IncidentStatus;
  source: "person" | "token" | "netmap";
  opened_at: string;
  resolved_at: string | null;
  ticket: { url: string; label: string | null } | null;
  page_ids: number[];
  hidden_page_ids?: number[];
  items: { page_id: number; source_key: string; display_name: string }[];
  updates: ManagedIncidentUpdate[];
  breaching: boolean;
};

export type TicketInput = { url: string; label: string | null };

export type IncidentCreatePayload = {
  title: string;
  severity: IncidentSeverity;
  message: string;
  is_public: boolean;
  page_ids: number[];
  items: StatusItemSource[];
  ticket?: TicketInput;
};

export type IncidentUpdatePayload = {
  message: string | null;
  is_public: boolean;
  page_id: number | null;
  status_change: Exclude<IncidentStatus, "resolved"> | null;
};

export type ManagedNotice = {
  id: number;
  page_id: number;
  owner_kind: "user" | "token";
  owner_id: number;
  level: NoticeLevel;
  title: string;
  body: string | null;
  link: string | null;
  author: string | null;
  created_at: string;
  expires_at: string | null;
  mine: boolean;
  token_active: boolean | null;
};

export type NoticePayload = { level: NoticeLevel; title: string; body: string | null; link: string | null; expires_at: string | null };

export type ManagedMaintenance = {
  id: number;
  title: string;
  description: string | null;
  starts_at: string;
  ends_at: string;
  suppress_alerts: boolean;
  state: "upcoming" | "active" | "finished";
  items: { source: StatusItemSource; source_key: string }[];
  page_ids: number[];
  created_by: string | null;
  created_by_token: string | null;
  created_at: string;
};

export type MaintenancePayload = {
  title: string;
  description: string | null;
  starts_at: string;
  ends_at: string;
  items: StatusItemSource[];
  page_ids?: number[];
  suppress_alerts: boolean;
};

export type IntegrationToken = {
  id: number;
  name: string;
  prefix: string;
  page_ids: number[];
  created_by: string | null;
  created_at: string;
  expires_at: string | null;
  revoked_at: string | null;
  last_used_at: string | null;
  active: boolean;
};

export type IntegrationTokenCreated = IntegrationToken & { secret: string; name_is_public: boolean };

export const TEXT_LIMITS = {
  incidentTitle: 200,
  incidentMessage: 5000,
  resolveReason: 500,
  ticketUrl: 2048,
  ticketLabel: 120,
  noticeTitle: 200,
  noticeBody: 2000,
  noticeLink: 2048,
  maintenanceTitle: 200,
  maintenanceDescription: 5000,
  tokenName: 120,
} as const;

export const statusManageApi = {
  incidents: (token: string) => apiRequest<ManagedIncident[]>(`${BASE}/incidents`, { token }),
  openIncident: (token: string, body: IncidentCreatePayload) =>
    apiRequest<ManagedIncident>(`${BASE}/incidents`, { method: "POST", token, body: json(body) }),
  addUpdate: (token: string, id: number, body: IncidentUpdatePayload) =>
    apiRequest<ManagedIncident>(`${BASE}/incidents/${id}/updates`, { method: "POST", token, body: json(body) }),
  resolve: (token: string, id: number, reason: string | null) =>
    apiRequest<ManagedIncident>(`${BASE}/incidents/${id}/resolve`, { method: "POST", token, body: json({ reason }) }),
  boardVisibility: (token: string, id: number, pageId: number, visible: boolean) =>
    apiRequest<ManagedIncident>(`${BASE}/incidents/${id}/pages/${pageId}/visibility`, { method: "PUT", token, body: json({ visible }) }),
  publish: (token: string, id: number, pageIds: number[]) =>
    apiRequest<ManagedIncident>(`${BASE}/incidents/${id}/publish`, { method: "POST", token, body: json({ page_ids: pageIds }) }),
  notices: (token: string, pageId: number) => apiRequest<ManagedNotice[]>(`${BASE}/${pageId}/notices`, { token }),
  setOwnNotice: (token: string, pageId: number, body: NoticePayload) =>
    apiRequest<ManagedNotice>(`${BASE}/${pageId}/notice`, { method: "PUT", token, body: json(body) }),
  clearOwnNotice: (token: string, pageId: number) => apiRequest<void>(`${BASE}/${pageId}/notice`, { method: "DELETE", token }),
  clearNotice: (token: string, noticeId: number) => apiRequest<void>(`${BASE}/notices/${noticeId}`, { method: "DELETE", token }),
  maintenance: (token: string) => apiRequest<ManagedMaintenance[]>(`${BASE}/maintenance`, { token }),
  createMaintenance: (token: string, body: MaintenancePayload) =>
    apiRequest<ManagedMaintenance>(`${BASE}/maintenance`, { method: "POST", token, body: json(body) }),
  updateMaintenance: (token: string, id: number, body: Partial<MaintenancePayload>) =>
    apiRequest<ManagedMaintenance>(`${BASE}/maintenance/${id}`, { method: "PATCH", token, body: json(body) }),
  deleteMaintenance: (token: string, id: number) => apiRequest<void>(`${BASE}/maintenance/${id}`, { method: "DELETE", token }),
  tokens: (token: string) => apiRequest<IntegrationToken[]>(`${BASE}/tokens`, { token }),
  createToken: (token: string, body: { name: string; page_ids: number[]; expires_at?: string }) =>
    apiRequest<IntegrationTokenCreated>(`${BASE}/tokens`, { method: "POST", token, body: json(body) }),
  revokeToken: (token: string, id: number) => apiRequest<void>(`${BASE}/tokens/${id}`, { method: "DELETE", token }),
};

const pad = (value: number) => String(Math.abs(value)).padStart(2, "0");

export function localInputToIso(value: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : toOffsetIso(date);
}

export function toOffsetIso(date: Date): string {
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const base = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  return `${base}${sign}${pad(Math.trunc(offset / 60))}:${pad(offset % 60)}`;
}

export function isoToLocalInput(value: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function browserTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "your local time";
}

export function formatWhen(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "—"
    : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

export function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export function apiErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError && typeof err.detail === "string") return err.detail;
  return err instanceof Error ? err.message : fallback;
}
