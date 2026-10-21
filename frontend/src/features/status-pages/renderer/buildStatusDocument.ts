import type {
  StatusAvailability, StatusBeat, StatusIncident, StatusItemState, StatusMaintenanceWindow, StatusNotice,
  StatusPageGroupPayload, StatusPastEntry, StatusPastMaintenance, StatusPageItemPayload, StatusPagePayload, StatusSummaryState,
} from "../statusPagesApi";
import { themeCss } from "./themeCss";
import { REDUCED_MOTION_OVERRIDE, RENDERER_CSP, type StatusColorScheme, builtinStyles } from "./builtinStyles";

export type BuildStatusOptions = { css: string | null; now: Date; colorScheme?: StatusColorScheme };

const SVG_NS = "http://www.w3.org/2000/svg";
const LOGO_PATTERN = /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/;
const ACCENT_PATTERN = /^#[0-9a-fA-F]{6}$/;

const ITEM_STATE_LABELS: Record<StatusItemState, string> = {
  operational: "Operational",
  degraded: "Degraded",
  down: "Down",
  maintenance: "Under maintenance",
  unknown: "Unknown",
};

const COUNT_LABELS: Record<StatusItemState, string> = {
  operational: "operational",
  degraded: "degraded",
  down: "down",
  maintenance: "under maintenance",
  unknown: "unknown",
};

const GROUP_STATE_LABELS: Record<StatusSummaryState, string> = {
  empty: "No systems configured",
  major: "Major outage",
  affected: "Some systems affected",
  unknown: "Status unavailable",
  maintenance: "Under maintenance",
  operational: "Operational",
};

const SEVERITY_LABELS: Record<StatusIncident["severity"], string> = {
  performance: "Performance issues",
  partial: "Partial outage",
  major: "Major outage",
};

const SEVERITY_TONES: Record<StatusIncident["severity"], string> = {
  performance: "warning",
  partial: "warning",
  major: "danger",
};

const INCIDENT_STATUS_LABELS: Record<StatusIncident["status"], string> = {
  investigating: "Investigating",
  identified: "Identified",
  monitoring: "Monitoring",
  resolved: "Resolved",
};

const NOTICE_LEVELS: Record<StatusNotice["level"], { label: string; tone: string }> = {
  info: { label: "Notice", tone: "info" },
  warning: { label: "Warning", tone: "warning" },
  critical: { label: "Critical", tone: "danger" },
};

const PERIOD_LABELS: Record<string, string> = { "24h": "24 h", "7d": "7 d", "30d": "30 d" };
const WINDOW_LABELS: Record<string, { name: string; start: string }> = {
  "1h": { name: "Last hour", start: "1h" },
  "24h": { name: "Last 24 hours", start: "24h" },
};

type Builder = {
  doc: Document;
  now: Date;
  el: <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string | null, text?: string | null) => HTMLElementTagNameMap[K];
};

function makeBuilder(doc: Document, now: Date): Builder {
  return {
    doc,
    now,
    el(tag, className, text) {
      const node = doc.createElement(tag);
      if (className) node.className = className;
      if (text != null) node.textContent = text;
      return node;
    },
  };
}

export function safeHttpUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

function externalLink(b: Builder, href: string | null | undefined, text: string): HTMLAnchorElement | null {
  const safe = safeHttpUrl(href);
  if (!safe) return null;
  const link = b.el("a", null, text);
  link.href = safe;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  return link;
}

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

export function formatStatusTime(iso: string | null | undefined, now: Date): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const time = date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  if (sameDay(date, now)) return time;
  return `${date.toLocaleDateString(undefined, { day: "numeric", month: "short" })} ${time}`;
}

export function visitorTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "local time";
  } catch {
    return "local time";
  }
}

export function formatWindowStart(iso: string, now: Date): string | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const time = date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  const weekday = date.toLocaleDateString(undefined, { weekday: "short" });
  if (Math.abs(date.getTime() - now.getTime()) < 6 * 86_400_000) return `${weekday} ${time}`;
  return `${weekday} ${date.toLocaleDateString(undefined, { day: "numeric", month: "short" })} ${time}`;
}

export function formatDuration(startIso: string, endIso: string): string | null {
  const minutes = Math.round((new Date(endIso).getTime() - new Date(startIso).getTime()) / 60_000);
  if (!Number.isFinite(minutes) || minutes <= 0) return null;
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  const parts = [days ? `${days} d` : null, hours ? `${hours} h` : null, mins ? `${mins} min` : null].filter(Boolean);
  return parts.join(" ");
}

function formatPercent(fraction: number): string {
  const floored = Math.floor(fraction * 10000) / 100;
  return `${Number(floored.toFixed(2))}%`;
}

function availabilityText(availability: StatusAvailability | undefined): string {
  if (!availability || availability.label === "no_data") return "No data";
  if (availability.label === "insufficient" || availability.percent == null) return "Insufficient data";
  return formatPercent(availability.percent);
}

function availabilityTone(availability: StatusAvailability): string {
  if (availability.label !== "ok" || availability.percent == null) return "neutral";
  if (availability.percent >= 0.99) return "good";
  if (availability.percent >= 0.95) return "warning";
  return "danger";
}

function formatMs(value: number | null | undefined): string {
  return value == null ? "Unavailable" : `${Math.round(value)} ms`;
}

function summaryCounts(payload: StatusPagePayload): string {
  const counts = payload.summary.counts ?? {};
  const parts = (Object.keys(COUNT_LABELS) as StatusItemState[])
    .filter((state) => (counts[state] ?? 0) > 0)
    .map((state) => `${counts[state]} ${COUNT_LABELS[state]}`);
  const open = payload.incidents.filter((incident) => incident.status !== "resolved").length;
  if (open) parts.push(`${open} ${open === 1 ? "incident" : "incidents"}`);
  if (payload.notices.length) parts.push(`${payload.notices.length} ${payload.notices.length === 1 ? "notice" : "notices"}`);
  return parts.join(" · ");
}

function heartbeatLabel(beats: StatusBeat[], window: string): string {
  const tally = { healthy: 0, unhealthy: 0, unknown: 0, maintenance: 0 };
  beats.forEach((beat) => { tally[beat in tally ? beat : "unknown"] += 1; });
  const parts = [`${tally.healthy} up`];
  if (tally.unhealthy) parts.push(`${tally.unhealthy} down`);
  if (tally.unknown) parts.push(`${tally.unknown} unknown`);
  if (tally.maintenance) parts.push(`${tally.maintenance} maintenance`);
  return `${(WINDOW_LABELS[window] ?? WINDOW_LABELS["1h"]).name}: ${parts.join(", ")}`;
}

function heartbeatBar(b: Builder, beats: StatusBeat[], window: string): HTMLElement {
  const bar = b.el("span", "sp-heartbeats");
  bar.setAttribute("role", "img");
  bar.setAttribute("aria-label", heartbeatLabel(beats, window));
  beats.forEach((beat) => {
    const kind = ["healthy", "unhealthy", "unknown", "maintenance"].includes(beat) ? beat : "unknown";
    bar.append(b.el("span", `sp-beat sp-beat--${kind}`));
  });
  return bar;
}

function responseGraph(b: Builder, values: (number | null)[], window: string): Element {
  const slots = values.length || 60;
  const svg = b.doc.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", "sp-response");
  svg.setAttribute("viewBox", `0 0 ${slots} 24`);
  svg.setAttribute("preserveAspectRatio", "none");
  svg.setAttribute("role", "img");
  const valid = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0);
  const name = (WINDOW_LABELS[window] ?? WINDOW_LABELS["1h"]).name;
  svg.setAttribute("aria-label", valid.length
    ? `${name} response time: ${Math.round(Math.min(...valid))} to ${Math.round(Math.max(...valid))} ms`
    : `${name} response time: no successful responses`);
  const max = Math.max(1, ...valid) * 1.15;
  const y = (value: number) => (22 - (value / max) * 19).toFixed(2);
  const runs: Array<Array<[number, number]>> = [];
  let current: Array<[number, number]> = [];
  values.forEach((value, index) => {
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      current.push([index, value]);
    } else if (current.length) {
      runs.push(current);
      current = [];
    }
  });
  if (current.length) runs.push(current);
  runs.forEach((run) => {
    const points = run.length === 1
      ? [[run[0][0] + 0.15, run[0][1]], [run[0][0] + 0.85, run[0][1]]] as Array<[number, number]>
      : run.map(([index, value]) => [index + 0.5, value] as [number, number]);
    const line = points.map(([x, value]) => `${x.toFixed(2)},${y(value)}`).join(" ");
    const first = points[0][0].toFixed(2);
    const last = points[points.length - 1][0].toFixed(2);
    const area = b.doc.createElementNS(SVG_NS, "polygon");
    area.setAttribute("class", "sp-response-area");
    area.setAttribute("points", `${first},24 ${line} ${last},24`);
    const stroke = b.doc.createElementNS(SVG_NS, "polyline");
    stroke.setAttribute("class", "sp-response-line");
    stroke.setAttribute("points", line);
    svg.append(area, stroke);
  });
  return svg;
}

function lane(b: Builder, label: string, content: Element): HTMLElement {
  const node = b.el("span", "sp-lane");
  node.append(b.el("span", "sp-lane-label", label), content);
  return node;
}

function axis(b: Builder, window: string): HTMLElement {
  const node = b.el("span", "sp-axis");
  node.setAttribute("aria-hidden", "true");
  node.append(b.el("span", null, (WINDOW_LABELS[window] ?? WINDOW_LABELS["1h"]).start), b.el("span", null, "now"));
  return node;
}

function statsList(b: Builder, item: StatusPageItemPayload): HTMLDListElement | null {
  const rows: Array<[string, string]> = [];
  const metrics = item.metrics ?? {};
  if (metrics.uptime_period) {
    const period = PERIOD_LABELS[metrics.uptime_period.period] ?? metrics.uptime_period.period;
    rows.push([`Uptime ${period}`, availabilityText(metrics.uptime_period)]);
    if (metrics.uptime_period.label === "insufficient" && metrics.uptime_period.coverage != null) {
      rows.push([`Coverage ${period}`, formatPercent(metrics.uptime_period.coverage)]);
    }
  }
  if (item.availability?.label === "insufficient" && item.availability.coverage != null) {
    rows.push(["Coverage", formatPercent(item.availability.coverage)]);
  }
  if ("avg_response" in metrics) rows.push(["Avg response", formatMs(metrics.avg_response)]);
  if ("p95_response" in metrics) rows.push(["p95 response", formatMs(metrics.p95_response)]);
  if ("failure_rate" in metrics) {
    rows.push(["Failed checks", metrics.failure_rate == null ? "Unavailable" : formatPercent(metrics.failure_rate)]);
  }
  if ("last_check" in metrics) rows.push(["Last check", formatStatusTime(metrics.last_check, b.now) ?? "Never"]);
  if (!rows.length) return null;
  const list = b.el("dl", "sp-stats");
  rows.forEach(([term, value]) => list.append(b.el("dt", null, term), b.el("dd", null, value)));
  return list;
}

function itemRow(b: Builder, item: StatusPageItemPayload, window: string): HTMLElement {
  const response = Array.isArray(item.response) ? item.response : null;
  const stats = statsList(b, item);
  const hasExtras = Boolean(response || (item.metrics && Object.keys(item.metrics).length));

  const ident = b.el("span", "sp-ident");
  const uptime = b.el("span", "sp-uptime", availabilityText(item.availability));
  uptime.dataset.tone = item.availability ? availabilityTone(item.availability) : "neutral";
  ident.append(
    b.el("span", "sp-caret"),
    uptime,
    b.el("span", "sp-row-name", item.name),
    b.el("span", "sp-state", ITEM_STATE_LABELS[item.state] ?? "Unknown"),
  );
  const graphs = b.el("span", "sp-graphs");
  graphs.append(lane(b, "Status", heartbeatBar(b, item.heartbeats ?? [], window)), axis(b, window));

  if (!hasExtras) {
    const row = b.el("div", "sp-row");
    row.dataset.state = item.state;
    const main = b.el("div", "sp-row-main");
    main.append(ident, graphs);
    row.append(main);
    return row;
  }

  const row = b.el("details", "sp-row");
  row.dataset.state = item.state;
  const summary = b.el("summary", "sp-row-main");
  summary.append(ident, graphs);
  const more = b.el("div", "sp-row-more");
  more.append(stats ?? b.el("span"));
  const moreGraphs = b.el("span", "sp-graphs");
  if (response) moreGraphs.append(lane(b, "Response", responseGraph(b, response, window)));
  moreGraphs.append(axis(b, window));
  more.append(moreGraphs);
  row.append(summary, more);
  return row;
}

function groupSection(b: Builder, group: StatusPageGroupPayload, window: string): HTMLElement {
  const section = b.el("details", "sp-group");
  section.dataset.state = group.state;
  if (!group.collapsed) section.open = true;
  const name = b.el("summary", "sp-group-name");
  name.append(b.el("span", "sp-group-label", group.name), b.el("span", "sp-group-state", GROUP_STATE_LABELS[group.state] ?? ""));
  section.append(name);
  if (!group.items.length) section.append(b.el("p", "sp-group-empty", "No systems configured"));
  group.items.forEach((item) => section.append(itemRow(b, item, window)));
  return section;
}

function strip(b: Builder, label: string, tone: string, title: string, extra: Array<Node | null>): HTMLElement {
  const node = b.el("div", "sp-strip");
  const pill = b.el("span", "sp-pill", label);
  pill.dataset.tone = tone;
  node.append(pill, b.el("span", "sp-strip-title", title));
  extra.forEach((child) => { if (child) node.append(child); });
  return node;
}

function incidentStrip(b: Builder, incident: StatusIncident): HTMLElement {
  const since = formatStatusTime(incident.opened_at, b.now);
  const meta = [since ? `since ${since}` : null, INCIDENT_STATUS_LABELS[incident.status]].filter(Boolean).join(" · ");
  const node = strip(b, SEVERITY_LABELS[incident.severity] ?? "Incident", SEVERITY_TONES[incident.severity] ?? "warning", incident.title, [
    b.el("span", "sp-strip-meta", meta),
    externalLink(b, incident.ticket?.url, incident.ticket?.label || "Ticket"),
  ]);
  node.dataset.kind = "incident";
  return node;
}

function noticeStrip(b: Builder, notice: StatusNotice): HTMLElement {
  const level = NOTICE_LEVELS[notice.level] ?? NOTICE_LEVELS.info;
  const node = strip(b, level.label, level.tone, notice.title, [
    notice.body ? b.el("span", "sp-strip-body", notice.body) : null,
    externalLink(b, notice.link, "More"),
  ]);
  node.classList.add("sp-notice");
  node.dataset.level = notice.level;
  return node;
}

function maintenanceStrip(b: Builder, window: StatusMaintenanceWindow): HTMLElement {
  const zone = visitorTimeZone();
  const start = formatWindowStart(window.starts_at, b.now);
  const end = formatWindowStart(window.ends_at, b.now);
  const duration = formatDuration(window.starts_at, window.ends_at);
  const when = window.active
    ? end ? `until ${end} (${zone})` : null
    : start ? `${start}${duration ? ` for ${duration}` : ""} (${zone})` : null;
  const node = strip(b, window.active ? "Maintenance" : "Planned maintenance", "maintenance", window.title, [
    when ? b.el("span", "sp-strip-meta", when) : null,
    window.description ? b.el("span", "sp-strip-body", window.description) : null,
  ]);
  node.dataset.kind = "maintenance";
  node.dataset.active = String(window.active);
  node.dataset.announced = String(window.announced);
  return node;
}

function pastMaintenanceEntry(b: Builder, window: StatusPastMaintenance): HTMLElement {
  const article = b.el("article", "sp-incident");
  article.dataset.kind = "maintenance";
  const title = b.el("h3", "sp-incident-title");
  const pill = b.el("span", "sp-pill", "Planned maintenance");
  pill.dataset.tone = "maintenance";
  title.append(pill, b.el("span", null, window.title));
  article.append(title);
  const range = [formatStatusTime(window.starts_at, b.now), formatStatusTime(window.ends_at, b.now)].filter(Boolean).join(" – ");
  article.append(b.el("p", "sp-incident-meta", range ? `${range} (${visitorTimeZone()})` : ""));
  if (window.description) {
    const list = b.el("ol", "sp-updates");
    const entry = b.el("li", "sp-update");
    entry.append(b.el("span", "sp-update-text", window.description));
    list.append(entry);
    article.append(list);
  }
  return article;
}

function incidentEntry(b: Builder, incident: StatusIncident): HTMLElement {
  const article = b.el("article", "sp-incident");
  article.dataset.severity = incident.severity;
  const title = b.el("h3", "sp-incident-title");
  const pill = b.el("span", "sp-pill", incident.status === "resolved" ? "Resolved" : SEVERITY_LABELS[incident.severity] ?? "Incident");
  pill.dataset.tone = incident.status === "resolved" ? "neutral" : SEVERITY_TONES[incident.severity] ?? "warning";
  title.append(pill, b.el("span", null, incident.title));
  article.append(title);
  const opened = formatStatusTime(incident.opened_at, b.now);
  const resolved = formatStatusTime(incident.resolved_at, b.now);
  const meta = b.el("p", "sp-incident-meta", [opened ? `Opened ${opened}` : null, resolved ? `resolved ${resolved}` : null].filter(Boolean).join(" · "));
  const ticket = externalLink(b, incident.ticket?.url, incident.ticket?.label || "Ticket");
  if (ticket) meta.append(" · ", ticket);
  article.append(meta);
  if (incident.updates?.length) {
    const list = b.el("ol", "sp-updates");
    incident.updates.forEach((update) => {
      const entry = b.el("li", "sp-update");
      entry.append(b.el("span", "sp-update-time", formatStatusTime(update.at, b.now) ?? ""));
      if (update.author) entry.append(b.el("span", "sp-update-author", update.author));
      if (update.internal) {
        entry.dataset.internal = "true";
        const internal = b.el("span", "sp-pill sp-update-internal", "Internal");
        internal.dataset.tone = "neutral";
        entry.append(internal);
      }
      const statusLabel = update.status ? INCIDENT_STATUS_LABELS[update.status] : null;
      if (statusLabel && update.message && !update.message.startsWith(statusLabel)) entry.append(b.el("span", "sp-update-status", statusLabel));
      const text = update.message ?? statusLabel ?? "";
      entry.append(b.el("span", "sp-update-text", text));
      list.append(entry);
    });
    article.append(list);
  }
  return article;
}

function incidentSection(b: Builder, className: string, title: string, incidents: Array<StatusIncident | StatusPastEntry>): HTMLElement {
  const section = b.el("details", className);
  const summary = b.el("summary", "sp-section-title");
  summary.append(b.el("h2", "sp-section-heading", title), b.el("span", "sp-section-count", String(incidents.length)));
  section.append(summary);
  incidents.forEach((entry) => section.append(
    "kind" in entry && entry.kind === "maintenance" ? pastMaintenanceEntry(b, entry) : incidentEntry(b, entry as StatusIncident),
  ));
  return section;
}

export function buildStatusDocument(payload: StatusPagePayload, options: BuildStatusOptions): string {
  const doc = document.implementation.createHTMLDocument("");
  const b = makeBuilder(doc, options.now);
  doc.documentElement.lang = "en";

  const csp = doc.createElement("meta");
  csp.httpEquiv = "Content-Security-Policy";
  csp.content = RENDERER_CSP;
  doc.head.prepend(csp);
  const titleNode = doc.head.querySelector("title");
  if (titleNode) titleNode.textContent = payload.title;
  doc.head.append(b.el("style", null, builtinStyles(options.colorScheme ?? null)));
  if (options.css && !options.css.includes("<")) {
    const custom = b.el("style", null, themeCss(options.css, options.colorScheme ?? null));
    custom.dataset.spCustom = "";
    doc.head.append(custom);
  }
  doc.head.append(b.el("style", null, REDUCED_MOTION_OVERRIDE));

  const page = b.el("main", "sp-page");
  if (payload.accent && ACCENT_PATTERN.test(payload.accent)) page.style.setProperty("--sp-page-accent", payload.accent);

  const header = b.el("header", "sp-header");
  if (payload.logo && LOGO_PATTERN.test(payload.logo)) {
    const logo = b.el("img", "sp-logo");
    logo.src = payload.logo;
    logo.alt = "";
    header.append(logo);
  }
  header.append(b.el("h1", "sp-title", payload.title));
  page.append(header);

  const summary = b.el("section", "sp-summary");
  summary.dataset.state = payload.summary.state;
  const dot = b.el("span", "sp-summary-dot");
  dot.setAttribute("aria-hidden", "true");
  summary.append(dot, b.el("h2", "sp-summary-label", payload.summary.label));
  const counts = summaryCounts(payload);
  if (counts) summary.append(b.el("span", "sp-summary-counts", counts));
  page.append(summary);

  payload.incidents.filter((incident) => incident.status !== "resolved").forEach((incident) => page.append(incidentStrip(b, incident)));
  payload.notices.forEach((notice) => page.append(noticeStrip(b, notice)));
  payload.maintenance.forEach((window) => page.append(maintenanceStrip(b, window)));

  const groups = b.el("div", "sp-groups");
  payload.groups.forEach((group) => groups.append(groupSection(b, group, payload.heartbeat_window)));
  page.append(groups);

  if (payload.incidents.length) page.append(incidentSection(b, "sp-log", "Incident log", payload.incidents));
  if (payload.past.length) page.append(incidentSection(b, "sp-past", "Past incidents", payload.past));

  doc.body.append(page);
  return "<!doctype html>" + doc.documentElement.outerHTML;
}
