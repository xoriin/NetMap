export type StatusItemState = "operational" | "degraded" | "down" | "maintenance" | "unknown";
export type StatusSummaryState = "empty" | "major" | "affected" | "unknown" | "maintenance" | "operational";
export type StatusBeat = "healthy" | "unhealthy" | "unknown" | "maintenance";
export type StatusHeartbeatWindow = "1h" | "24h";

export type StatusAvailability = {
  percent: number | null;
  label: "ok" | "insufficient" | "no_data";
  coverage: number | null;
};

export type StatusItemMetrics = {
  avg_response?: number | null;
  p95_response?: number | null;
  failure_rate?: number | null;
  last_check?: string | null;
  uptime_period?: StatusAvailability & { period: "24h" | "7d" | "30d" };
};

export type StatusPageItemPayload = {
  id: number;
  name: string;
  state: StatusItemState;
  availability: StatusAvailability;
  heartbeats: StatusBeat[];
  response?: (number | null)[] | null;
  metrics: StatusItemMetrics | null;
  incident_ids: number[];
};

export type StatusPageGroupPayload = {
  id: number;
  name: string;
  state: StatusSummaryState;
  collapsed: boolean;
  items: StatusPageItemPayload[];
};

export type StatusNotice = {
  id: number;
  level: "info" | "warning" | "critical";
  title: string;
  body: string | null;
  link: string | null;
  expires_at: string | null;
};

export type StatusIncidentUpdate = {
  id: number;
  at: string;
  status: "investigating" | "identified" | "monitoring" | "resolved" | null;
  message: string | null;
  author: string;
  internal?: boolean;
};

export type StatusIncident = {
  id: number;
  title: string;
  severity: "performance" | "partial" | "major";
  status: "investigating" | "identified" | "monitoring" | "resolved";
  opened_at: string;
  resolved_at: string | null;
  ticket: { url: string; label: string | null } | null;
  updates: StatusIncidentUpdate[];
};

export type StatusMaintenanceWindow = {
  id: number;
  title: string;
  description: string | null;
  starts_at: string;
  ends_at: string;
  active: boolean;
};

export type StatusPagePayload = {
  slug: string;
  title: string;
  accent: string | null;
  logo: string | null;
  heartbeat_window: StatusHeartbeatWindow;
  custom_css: string | null;
  generated_at: string;
  valid_until: string;
  summary: { state: StatusSummaryState; label: string; counts: Record<StatusItemState, number> };
  notices: StatusNotice[];
  incidents: StatusIncident[];
  maintenance: StatusMaintenanceWindow[];
  past: StatusIncident[];
  groups: StatusPageGroupPayload[];
};

export type StatusFetchResult =
  | { kind: "ok"; payload: StatusPagePayload; etag: string | null }
  | { kind: "not-modified" }
  | { kind: "unavailable"; retryAfterSeconds: number | null }
  | { kind: "error"; status: number };

export const STATUS_SLUG_PATTERN = /^\/status\/([a-z0-9-]+)$/;

export function statusPagePath(slug: string): string {
  return `/status/${slug}`;
}

export function publicStatusUrl(slug: string): string {
  return `/api/v1/public/status-pages/${encodeURIComponent(slug)}`;
}

export function signedInStatusUrl(slug: string): string {
  return `/api/v1/status-pages/${encodeURIComponent(slug)}/view`;
}

const REQUEST_TIMEOUT_MS = 10_000;

export async function fetchStatusPage(url: string, etag: string | null, signedIn: boolean): Promise<StatusFetchResult> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const headers = new Headers({ Accept: "application/json" });
    if (etag) headers.set("If-None-Match", etag);
    const response = await fetch(url, { headers, credentials: signedIn ? "same-origin" : "omit", cache: "no-store", signal: controller.signal });
    if (response.status === 304) return { kind: "not-modified" };
    if (response.status === 503) {
      const retryAfter = Number(response.headers.get("Retry-After"));
      return { kind: "unavailable", retryAfterSeconds: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null };
    }
    if (!response.ok) return { kind: "error", status: response.status };
    return { kind: "ok", payload: (await response.json()) as StatusPagePayload, etag: response.headers.get("ETag") };
  } finally {
    window.clearTimeout(timer);
  }
}
