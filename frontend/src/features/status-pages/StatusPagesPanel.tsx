import { useCallback, useEffect, useState, type FormEvent } from "react";
import { CalendarClock, Eye, Layers, PieChart, Plus, Siren } from "lucide-react";
import { DashStat } from "../../components/DashStat";
import { CountUp, DonutChart } from "../../components/Charts";
import { EventList, type EventTone } from "../../components/EventList";
import { InsightPanel } from "../../components/InsightPanel";
import { shortDateTime } from "../../utils/history";
import { IconBroadcast } from "@tabler/icons-react";
import { Modal, ModalFooterActions } from "../../components/Modal";
import { TableSkeleton } from "../../components/Skeleton";
import { useToast } from "../../components/Toast";
import { useConfirm } from "../../components/ConfirmDialog";
import { StatusPageEditor } from "./StatusPageEditor";
import { statusPagePath } from "./statusPagesApi";
import {
  SLUG_HINT, isValidSlug, slugFromName, statusManageApi, statusPagesEditorApi, type ManagedIncident, type ManagedMaintenance,
  type StatusPageSummary, type StatusPageVisibility,
} from "./statusPagesEditorApi";
import type { StatusItemState } from "./statusPagesApi";

type Overview = { counts: Record<StatusItemState, number>; incidents: ManagedIncident[]; maintenance: ManagedMaintenance[] };

const STATE_ITEMS: { state: StatusItemState; label: string; color: `--${string}` }[] = [
  { state: "operational", label: "Healthy", color: "--dash-green" },
  { state: "degraded", label: "Degraded", color: "--dash-amber" },
  { state: "down", label: "Unavailable", color: "--dash-red" },
  { state: "maintenance", label: "Maintenance", color: "--dash-blue" },
  { state: "unknown", label: "No data", color: "--dash-muted" },
];

const INCIDENT_TONE: Record<string, EventTone> = { major: "offline", partial: "warning", performance: "warning" };
import "./statusPagesEditor.css";

const WINDOW_LABELS = { "1h": "Last hour", "24h": "Last 24 hours" } as const;

function formatUpdated(iso: string) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? "—"
    : `${date.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" })} ${date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}

function CreatePageModal({
  accessToken,
  onCancel,
  onCreated,
}: {
  accessToken: string;
  onCancel: () => void;
  onCreated: (page: StatusPageSummary) => void;
}) {
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);
  const [visibility, setVisibility] = useState<StatusPageVisibility>("public");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const slugInvalid = slug !== "" && !isValidSlug(slug);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!name.trim() || !isValidSlug(slug)) return;
    setBusy(true);
    setError(null);
    try {
      onCreated(await statusPagesEditorApi.create(accessToken, { name: name.trim(), slug, visibility }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to create the status page");
      setBusy(false);
    }
  }

  return (
    <Modal
      title="New status page"
      titleIcon={<IconBroadcast size={18} />}
      onCancel={onCancel}
      footer={
        <ModalFooterActions
          onCancel={onCancel}
          formId="status-page-create-form"
          primaryLabel={busy ? "Creating…" : "Create page"}
          primaryDisabled={busy || !name.trim() || !isValidSlug(slug)}
        />
      }
    >
      <form id="status-page-create-form" className="modal-form" onSubmit={(event) => void submit(event)}>
        {error && <div className="form-error" role="alert">{error}</div>}
        <label>Name
          <input
            value={name}
            maxLength={120}
            required
            placeholder="e.g. Customer services"
            onChange={(event) => {
              setName(event.target.value);
              if (!slugEdited) setSlug(slugFromName(event.target.value));
            }}
          />
        </label>
        <label>Slug
          <input
            value={slug}
            maxLength={48}
            required
            aria-invalid={slugInvalid || undefined}
            onChange={(event) => { setSlugEdited(true); setSlug(event.target.value.toLowerCase()); }}
          />
          <small className="status-editor-hint">{slugInvalid ? SLUG_HINT : `Visitors open ${statusPagePath(slug || "your-slug")}.`}</small>
        </label>
        <label>Visibility
          <select value={visibility} onChange={(event) => setVisibility(event.target.value as StatusPageVisibility)}>
            <option value="public">Public — anyone with the link</option>
            <option value="private">Private — signed-in users only</option>
          </select>
        </label>
      </form>
    </Modal>
  );
}

export function StatusPagesPanel({ accessToken, canManageAlerts = false }: { accessToken: string; canManageAlerts?: boolean }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [pages, setPages] = useState<StatusPageSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [overview, setOverview] = useState<Overview | null>(null);

  const load = useCallback(async () => {
    try {
      const list = await statusPagesEditorApi.list(accessToken);
      setPages(list);
      setError(null);
      void loadOverview(list);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load status pages");
    } finally {
      setLoading(false);
    }
  }, [accessToken]);

  const loadOverview = useCallback(async (list: StatusPageSummary[]) => {
    const counts: Record<StatusItemState, number> = { operational: 0, degraded: 0, down: 0, maintenance: 0, unknown: 0 };
    const [previews, incidents, maintenance] = await Promise.all([
      Promise.all(list.map((page) => statusPagesEditorApi.preview(accessToken, page.id, "public").catch(() => null))),
      statusManageApi.incidents(accessToken).catch(() => []),
      statusManageApi.maintenance(accessToken).catch(() => []),
    ]);
    for (const preview of previews) {
      for (const state of Object.keys(counts) as StatusItemState[]) counts[state] += preview?.summary?.counts?.[state] ?? 0;
    }
    setOverview({ counts, incidents: Array.isArray(incidents) ? incidents : [], maintenance: Array.isArray(maintenance) ? maintenance : [] });
  }, [accessToken]);

  useEffect(() => { void load(); }, [load]);

  async function deletePage(page: StatusPageSummary) {
    const confirmed = await confirm({
      title: `Delete ${page.name}`,
      message: `This permanently deletes the status page and its layout. ${statusPagePath(page.slug)} stops working immediately.`,
      confirmLabel: "Delete page",
    });
    if (!confirmed) return;
    try {
      await statusPagesEditorApi.remove(accessToken, page.id);
      toast.success(`Deleted ${page.name}`);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Unable to delete the status page");
    }
  }

  if (editingId !== null) {
    return (
      <StatusPageEditor
        accessToken={accessToken}
        pageId={editingId}
        canManageAlerts={canManageAlerts}
        onClose={() => { setEditingId(null); void load(); }}
      />
    );
  }

  const componentTotal = overview ? Object.values(overview.counts).reduce((sum, n) => sum + n, 0) : 0;
  const openIncidents = overview?.incidents.filter((i) => i.status !== "resolved") ?? [];
  const upcoming = (overview?.maintenance ?? []).filter((m) => m.state !== "finished").sort((a, b) => a.starts_at.localeCompare(b.starts_at));
  const pageName = (ids: number[]) => pages.find((p) => ids.includes(p.id))?.name ?? "No page";
  const publicCount = pages.filter((p) => p.visibility === "public").length;
  const events = [
    ...(overview?.incidents ?? []).map((i) => ({
      key: `i${i.id}`, at: i.resolved_at ?? i.opened_at, tone: (i.status === "resolved" ? "online" : INCIDENT_TONE[i.severity] ?? "warning") as EventTone,
      title: i.title, detail: `${pageName(i.page_ids)} · ${i.status}`,
    })),
    ...(overview?.maintenance ?? []).filter((m) => m.state !== "finished").map((m) => ({
      key: `m${m.id}`, at: m.starts_at, tone: "disabled" as EventTone, title: m.title, detail: `${pageName(m.page_ids)} · ${m.state === "active" ? "in progress" : "scheduled"}`,
    })),
  ].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 6);

  return (
    <div className="status-pages-overview nm-motion">
      <div className="nm-bento nm-bento--four">
        <InsightPanel title="Service health across pages" icon={<PieChart size={16} />} className="nm-motion-item">
          {!overview ? <TableSkeleton rows={3} columns={2} />
            : componentTotal ? <DonutChart label="Status page services by state" centre={<CountUp value={componentTotal} />} sub="Services" legendBars={false}
                items={STATE_ITEMS.map((item) => ({ label: item.label, value: overview.counts[item.state], color: item.color })).filter((item) => item.value > 0)} />
            : <p className="tool-note nm-chart-empty">No monitored services on any status page yet.</p>}
        </InsightPanel>
        <div className="dash-stats nm-bento-stats nm-summary-band">
          <DashStat accent="teal" className="nm-motion-item" icon={<IconBroadcast size={20} />} label="Status pages" value={<CountUp value={pages.length} />}
            sub={`${publicCount} public · ${pages.length - publicCount} private`} />
          <DashStat accent="green" className="nm-motion-item" icon={<Layers size={20} />} label="Monitored services" value={<CountUp value={componentTotal} />}
            sub={`${overview?.counts.operational ?? 0} healthy`} />
          <DashStat accent={openIncidents.length ? "red" : "green"} className="nm-motion-item" icon={<Siren size={20} />} label="Open incidents" value={<CountUp value={openIncidents.length} />}
            sub={openIncidents[0] ? openIncidents[0].title : "All clear"} />
          <DashStat accent="blue" className="nm-motion-item" icon={<CalendarClock size={20} />} label="Maintenance" value={<CountUp value={upcoming.length} />}
            sub={upcoming[0] ? `${shortDateTime(upcoming[0].starts_at)} · ${upcoming[0].title}` : "Nothing scheduled"} />
        </div>
      </div>
      <div className="nm-console">
        <div className="nm-console-main">
    <div className="dash-panel nm-app-panel mon-view-window status-pages-window nm-fill nm-motion-item">
      <div className="dash-panel-header nm-app-panel-header status-editor-header">
        <div className="status-editor-title">
          <span className="status-editor-icon"><IconBroadcast size={18} /></span>
          <strong>Status pages</strong>
          {!loading && <span className="status-editor-count">{pages.length} page{pages.length === 1 ? "" : "s"}</span>}
        </div>
        <div className="mon-panel-controls">
          <button type="button" className="nm-btn nm-btn--primary" onClick={() => setCreating(true)}>
            <Plus size={14} /> New status page
          </button>
        </div>
      </div>
      <div className="dash-panel-body mon-table-body status-pages-body">
        {error && <div className="nm-alert nm-alert--error status-pages-alert" role="alert">{error}</div>}
        {loading ? (
          <TableSkeleton rows={4} columns={6} />
        ) : pages.length === 0 ? (
          <p className="dash-empty">No status pages yet. Create one to share the health of chosen devices and endpoints.</p>
        ) : (
          <div className="nm-table-wrap mon-embedded-table status-pages-table-wrap nm-phone-cards">
            <table className="nm-table status-pages-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Address</th>
                  <th>Visibility</th>
                  <th>Heartbeat window</th>
                  <th>Updated</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {pages.map((page) => (
                  <tr key={page.id}>
                    <td>
                      <strong>{page.name}</strong>
                      {page.title && page.title !== page.name && <small className="status-editor-sub">{page.title}</small>}
                    </td>
                    <td className="nm-table-mono">
                      <a href={statusPagePath(page.slug)} target="_blank" rel="noopener noreferrer">{statusPagePath(page.slug)}</a>
                    </td>
                    <td>{page.visibility === "public" ? "Public" : "Private"}</td>
                    <td>{WINDOW_LABELS[page.heartbeat_window]}</td>
                    <td>{formatUpdated(page.updated_at)}</td>
                    <td className="status-pages-actions">
                      <div className="nm-table-actions">
                        <button type="button" className="nm-btn nm-btn--sm nm-btn--secondary" onClick={() => setEditingId(page.id)}>Edit</button>
                        <button type="button" className="nm-btn nm-btn--sm nm-btn--danger" onClick={() => void deletePage(page)}>Delete</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
        </div>
        <aside className="nm-console-side">
          <InsightPanel title="Incidents & maintenance" icon={<Eye size={16} />} className="nm-fill nm-motion-item">
            {!overview ? <TableSkeleton rows={3} columns={1} />
              : <EventList empty="No incidents or maintenance." rows={events.map(({ key, at, tone, title, detail }) => ({ key, tone, title, detail, time: shortDateTime(at), dateTime: at }))} />}
          </InsightPanel>
        </aside>
      </div>
      {creating && (
        <CreatePageModal
          accessToken={accessToken}
          onCancel={() => setCreating(false)}
          onCreated={(page) => {
            setCreating(false);
            toast.success(`Created ${page.name}`);
            setEditingId(page.id);
          }}
        />
      )}
    </div>
  );
}
