import { useState, useEffect, useCallback, useMemo } from "react";
import { IconArrowRight } from "@tabler/icons-react";
import { api, type DiscoveryObservation } from "../api/client";
import type { AppRoute } from "../routes";
import { Modal } from "./Modal";
import { useConfirm } from "./ConfirmDialog";

const OBSERVATION_TARGET_ROUTE: Record<string, AppRoute> = {
  new_device: "/inventory",
  ip_change: "/inventory",
  field_change: "/inventory",
  disappeared: "/monitoring",
};

export function ObservationsAlert({
  accessToken,
  onObservationActioned,
  openObservationCount,
  onNavigate,
}: {
  accessToken: string | null;
  onObservationActioned?: () => void;
  openObservationCount?: number;
  onNavigate?: (route: AppRoute) => void;
}) {
  const [dismissed, setDismissed] = useState(false);
  const [obsBreakdown, setObsBreakdown] = useState<DiscoveryObservation[]>([]);
  const [modalOpen, setModalOpen] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [clearAllBusy, setClearAllBusy] = useState(false);
  const confirmAction = useConfirm();

  useEffect(() => {
    if (!accessToken || !openObservationCount || openObservationCount === 0) { setObsBreakdown([]); return; }
    void api.listDiscoveryObservations(accessToken, { status_filter: "open" }).then(setObsBreakdown).catch(() => {});
  }, [accessToken, openObservationCount]);

  useEffect(() => { setDismissed(false); }, [openObservationCount]);

  const openObs = useMemo(
    () => obsBreakdown.filter((o) => o.status !== "resolved"),
    [obsBreakdown],
  );

  const typeCounts = useMemo(() => {
    const c = { new_device: 0, ip_change: 0, field_change: 0, disappeared: 0 };
    for (const o of openObs) {
      if (o.observation_type in c) c[o.observation_type as keyof typeof c]++;
    }
    return c;
  }, [openObs]);

  const updateObservation = useCallback(async (obs: DiscoveryObservation, newStatus: "acknowledged" | "resolved") => {
    if (!accessToken) return;
    setActionError(null);
    try {
      await api.updateDiscoveryObservation(accessToken, obs.id, newStatus);
      setObsBreakdown((prev) => prev.map((o) => o.id === obs.id ? { ...o, status: newStatus } : o));
      onObservationActioned?.();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to update.");
    }
  }, [accessToken, onObservationActioned]);

  const applyObservation = useCallback(async (obs: DiscoveryObservation) => {
    if (!accessToken) return;
    setActionError(null);
    try {
      const updated = await api.applyObservation(accessToken, obs.id);
      setObsBreakdown((prev) => prev.map((o) => o.id === obs.id ? updated : o));
      onObservationActioned?.();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to apply.");
    }
  }, [accessToken, onObservationActioned]);

  const clearAll = useCallback(async () => {
    if (!accessToken || openObs.length === 0) return;
    const count = openObs.length;
    const confirmed = await confirmAction({
      title: "Clear all network changes",
      message: `This resolves all ${count} pending network change${count !== 1 ? "s" : ""} at once.`,
      detail: "Resolved changes are dismissed permanently and won't reappear.",
      confirmLabel: "Clear all",
      typeToConfirm: count >= 5 ? "clear" : undefined,
    });
    if (!confirmed) return;
    setActionError(null);
    setClearAllBusy(true);
    try {
      await api.resolveAllObservations(accessToken);
      setObsBreakdown((prev) => prev.map((o) => o.status === "resolved" ? o : { ...o, status: "resolved" }));
      onObservationActioned?.();
      setModalOpen(false);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to clear all.");
    } finally {
      setClearAllBusy(false);
    }
  }, [accessToken, openObs.length, confirmAction, onObservationActioned]);

  function goToObservation(obs: DiscoveryObservation) {
    const route = OBSERVATION_TARGET_ROUTE[obs.observation_type];
    if (!route || !onNavigate) return;
    setModalOpen(false);
    onNavigate(route);
  }

  const count = openObs.length || openObservationCount || 0;
  if (!count || dismissed) return null;

  return (
    <>
      <div className="dash-alert dash-alert--overview-bar dash-alert--changes">
        <span className="dash-alert-dot dash-alert-dot--amber" aria-hidden="true" />
        <strong>{count} network change{count !== 1 ? "s" : ""} detected</strong>
        {typeCounts.new_device > 0 && (
          <span className="dash-alert-tag">{typeCounts.new_device} new device{typeCounts.new_device !== 1 ? "s" : ""}</span>
        )}
        {typeCounts.ip_change > 0 && (
          <span className="dash-alert-tag">{typeCounts.ip_change} IP change{typeCounts.ip_change !== 1 ? "s" : ""}</span>
        )}
        {typeCounts.field_change > 0 && (
          <span className="dash-alert-tag">{typeCounts.field_change} field change{typeCounts.field_change !== 1 ? "s" : ""}</span>
        )}
        {typeCounts.disappeared > 0 && (
          <span className="dash-alert-tag">{typeCounts.disappeared} disappeared</span>
        )}
        <button type="button" className="dash-alert-link" onClick={() => setModalOpen(true)}>
          Review <IconArrowRight size={13} />
        </button>
        <button type="button" className="dash-alert-dismiss" aria-label="Dismiss alert" onClick={() => setDismissed(true)}>
          &times;
        </button>
      </div>

      {modalOpen && (
        <Modal title="Network changes" wide onCancel={() => { setModalOpen(false); setActionError(null); }}>
          <div className="obs-modal-body">
            {actionError && <div className="error-banner">{actionError}</div>}
            <div className="obs-modal-hint-row">
              <p className="obs-modal-hint">
                Scheduled scans detected the following changes on your network. Acknowledge to mark as seen, resolve to dismiss permanently, or click a row to jump to its device.
              </p>
              {openObs.length > 0 && (
                <button type="button" className="nm-btn nm-btn--sm nm-btn--danger" disabled={clearAllBusy} onClick={() => void clearAll()}>
                  {clearAllBusy ? "Clearing…" : "Clear all"}
                </button>
              )}
            </div>
            {obsBreakdown.length === 0 && (
              <p className="obs-modal-empty">Loading…</p>
            )}
            {obsBreakdown.length > 0 && openObs.length === 0 && (
              <p className="obs-modal-empty">All network changes have been resolved.</p>
            )}
            {openObs.length > 0 && (
              <div className="obs-list">
                {openObs.map((obs) => {
                  const typeLabel: Record<string, string> = { new_device: "New device", ip_change: "IP change", field_change: "Field change", disappeared: "Disappeared" };
                  const subDetail = [obs.hostname, obs.ip_address, obs.mac_address].filter(Boolean).join(" · ");
                  const rawProposed = (obs.details as { proposed_updates?: unknown }).proposed_updates;
                  const proposed: Record<string, string> = rawProposed && !Array.isArray(rawProposed) && typeof rawProposed === "object" ? rawProposed as Record<string, string> : {};
                  const canAddToInventory = obs.observation_type === "new_device" && !!obs.ip_address;
                  const canApply = canAddToInventory || (obs.device_id !== null && (obs.observation_type === "ip_change" || obs.observation_type === "field_change") && Object.keys(proposed).length > 0);
                  const applyLabel = obs.observation_type === "new_device" ? "Add to inventory" : "Apply to device";
                  const fieldLabels: Record<string, string> = { ip_address: "IP", hostname: "Hostname", mac_address: "MAC", vendor: "Vendor", device_type: "Type", os_info: "OS" };
                  const targetRoute = onNavigate ? OBSERVATION_TARGET_ROUTE[obs.observation_type] : undefined;
                  return (
                    <div
                      key={obs.id}
                      className={`obs-row${targetRoute ? " obs-row--clickable" : ""}`}
                      onClick={targetRoute ? () => goToObservation(obs) : undefined}
                      title={targetRoute ? `Go to ${targetRoute === "/inventory" ? "Inventory" : "Monitoring"}` : undefined}
                    >
                      <span className={`obs-row-type-badge obs-row-type-badge--${obs.observation_type}`}>
                        {typeLabel[obs.observation_type] ?? obs.observation_type}
                      </span>
                      <div className="obs-row-detail">
                        <strong>{obs.summary}</strong>
                        {subDetail && <span>{subDetail}</span>}
                        {!canAddToInventory && canApply && (
                          <span className="obs-row-proposed">
                            {Object.entries(proposed).map(([k, v]) => `${fieldLabels[k] ?? k}: ${v}`).join(" · ")}
                          </span>
                        )}
                      </div>
                      <span className="obs-row-meta">{new Date(obs.last_seen_at).toLocaleString()}</span>
                      <div className="obs-row-actions" onClick={(e) => e.stopPropagation()}>
                        {obs.status === "acknowledged" && (
                          <span className="obs-row-acked">Acknowledged</span>
                        )}
                        {canApply && (
                          <button type="button" className="nm-btn" onClick={() => void applyObservation(obs)}>{applyLabel}</button>
                        )}
                        {obs.status === "open" && (
                          <button type="button" className="nm-btn" onClick={() => void updateObservation(obs, "acknowledged")}>Acknowledge</button>
                        )}
                        <button type="button" className="nm-btn nm-btn--danger" onClick={() => void updateObservation(obs, "resolved")}>Resolve</button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </Modal>
      )}
    </>
  );
}
