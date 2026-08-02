import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Cloud, Edit3, Globe2, Plus, Trash2 } from "lucide-react";
import {
  api,
  type ExternalIpAssignment,
  type ExternalIpAssignmentPayload,
  type ExternalIpPool,
  type ExternalIpPoolPayload,
} from "../../api/client";
import { DashStat } from "../../components/DashStat";
import { Modal, ModalFooterActions } from "../../components/Modal";
import { WorkspaceSkeleton } from "../../components/Skeleton";
import { useConfirm } from "../../components/ConfirmDialog";
import { useToast } from "../../components/Toast";
import { useApiQuery } from "../../hooks/useApiQuery";

const EMPTY_POOL: ExternalIpPoolPayload = { name: "", cidr: "", provider: null, account: null, description: null };
const EMPTY_ASSIGNMENT: ExternalIpAssignmentPayload = {
  pool_id: null, ip_address: "", label: "", status: "in_use", provider: null,
  account: null, owner: null, service: null, tags: null, notes: null,
};

function statusLabel(status: ExternalIpAssignment["status"]) {
  return status === "in_use" ? "In use" : status === "reserved" ? "Reserved" : "Available";
}

function nullable(value: string) {
  const trimmed = value.trim();
  return trimmed || null;
}

export function ExternalIpPanel({ accessToken, canWrite }: { accessToken: string; canWrite: boolean }) {
  const toast = useToast();
  const confirmAction = useConfirm();
  const query = useApiQuery(async () => {
    const [summary, pools, assignments] = await Promise.all([
      api.getExternalIpSummary(accessToken),
      api.listExternalIpPools(accessToken),
      api.listExternalIpAssignments(accessToken),
    ]);
    return { summary, pools, assignments };
  }, [accessToken]);
  const pools = useMemo(() => query.data?.pools ?? [], [query.data]);
  const assignments = useMemo(() => query.data?.assignments ?? [], [query.data]);
  const [selectedPoolId, setSelectedPoolId] = useState<number | null>(null);
  const selectedPool = pools.find((pool) => pool.id === selectedPoolId) ?? null;
  const [pageOffset, setPageOffset] = useState(0);
  const addressQuery = useApiQuery(
    selectedPoolId === null ? null : () => api.getExternalPoolAddresses(accessToken, selectedPoolId, pageOffset, 256),
    [accessToken, selectedPoolId, pageOffset],
  );
  const [poolModal, setPoolModal] = useState<ExternalIpPool | "new" | null>(null);
  const [poolForm, setPoolForm] = useState<ExternalIpPoolPayload>(EMPTY_POOL);
  const [assignmentModal, setAssignmentModal] = useState<ExternalIpAssignment | "new" | null>(null);
  const [assignmentForm, setAssignmentForm] = useState<ExternalIpAssignmentPayload>(EMPTY_ASSIGNMENT);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    if (selectedPoolId !== null && !pools.some((pool) => pool.id === selectedPoolId)) setSelectedPoolId(null);
  }, [pools, selectedPoolId]);

  function openPool(pool?: ExternalIpPool) {
    setPoolModal(pool ?? "new");
    setPoolForm(pool ? {
      name: pool.name, cidr: pool.cidr, provider: pool.provider,
      account: pool.account, description: pool.description,
    } : EMPTY_POOL);
    setFormError(null);
  }

  function openAssignment(assignment?: ExternalIpAssignment, ipAddress = "", poolId: number | null = null) {
    setAssignmentModal(assignment ?? "new");
    setAssignmentForm(assignment ? {
      pool_id: assignment.pool_id, ip_address: assignment.ip_address, label: assignment.label,
      status: assignment.status, provider: assignment.provider, account: assignment.account,
      owner: assignment.owner, service: assignment.service, tags: assignment.tags, notes: assignment.notes,
    } : { ...EMPTY_ASSIGNMENT, pool_id: poolId, ip_address: ipAddress });
    setFormError(null);
  }

  async function savePool(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setFormError(null);
    const payload = { ...poolForm, provider: nullable(poolForm.provider ?? ""), account: nullable(poolForm.account ?? ""), description: nullable(poolForm.description ?? "") };
    try {
      if (poolModal === "new") await api.createExternalIpPool(accessToken, payload);
      else if (poolModal) await api.updateExternalIpPool(accessToken, poolModal.id, payload);
      setPoolModal(null);
      await query.reload();
      toast.success(poolModal === "new" ? "External IP pool added" : "External IP pool updated");
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "Failed to save external IP pool");
    } finally { setBusy(false); }
  }

  async function saveAssignment(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setFormError(null);
    const payload = {
      ...assignmentForm,
      provider: nullable(assignmentForm.provider ?? ""), account: nullable(assignmentForm.account ?? ""),
      owner: nullable(assignmentForm.owner ?? ""), service: nullable(assignmentForm.service ?? ""),
      tags: nullable(assignmentForm.tags ?? ""), notes: nullable(assignmentForm.notes ?? ""),
    };
    try {
      if (assignmentModal === "new") await api.createExternalIpAssignment(accessToken, payload);
      else if (assignmentModal) await api.updateExternalIpAssignment(accessToken, assignmentModal.id, payload);
      setAssignmentModal(null);
      await query.reload();
      if (selectedPoolId !== null) await addressQuery.reload();
      toast.success(assignmentModal === "new" ? "External IP tracked" : "External IP updated");
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "Failed to save external IP");
    } finally { setBusy(false); }
  }

  async function removePool(pool: ExternalIpPool) {
    if (!await confirmAction({ title: "Delete external pool", message: `Delete ${pool.name} (${pool.cidr}) and its tracked assignments?`, confirmLabel: "Delete pool" })) return;
    try { await api.deleteExternalIpPool(accessToken, pool.id); await query.reload(); toast.success("External IP pool deleted"); }
    catch (error) { toast.error(error instanceof Error ? error.message : "Failed to delete pool"); }
  }

  async function removeAssignment(assignment: ExternalIpAssignment) {
    if (!await confirmAction({ title: "Stop tracking external IP", message: `Remove ${assignment.ip_address} from external IP tracking?`, confirmLabel: "Remove" })) return;
    try {
      await api.deleteExternalIpAssignment(accessToken, assignment.id);
      await query.reload();
      if (selectedPoolId !== null) await addressQuery.reload();
      toast.success("External IP removed");
    } catch (error) { toast.error(error instanceof Error ? error.message : "Failed to remove external IP"); }
  }

  if (query.isLoading) return <WorkspaceSkeleton />;
  if (query.error) return <p className="dash-empty external-ip-error">{query.error}</p>;
  const summary = query.data?.summary;
  const standalone = assignments.filter((row) => row.pool_id === null);

  return (
    <div className="external-ip-workspace">
      <div className="dash-stats ipam-stats nm-summary-band">
        <DashStat label="Address pools" value={summary?.pool_count ?? 0} sub="public CIDR ranges" icon={<Globe2 size={20} />} accent="teal" />
        <DashStat label="Tracked" value={(summary?.in_use ?? 0) + (summary?.reserved ?? 0)} sub="assigned or reserved" icon={<Cloud size={20} />} accent="blue" />
        <DashStat label="Available" value={summary?.free ?? 0} sub="pool addresses" icon={<Globe2 size={20} />} accent="green" />
        <DashStat label="Standalone" value={summary?.standalone_count ?? 0} sub="outside a managed pool" icon={<Cloud size={20} />} accent="purple" />
      </div>

      <section className="nm-app-panel external-ip-panel">
        <header className="nm-app-panel-header external-ip-panel-header">
          <div><strong>External address pools</strong><span>{pools.length} tracked ranges</span></div>
          {canWrite && <button className="nm-btn nm-btn--sm nm-btn--primary" type="button" onClick={() => openPool()}><Plus size={14} /> Add pool</button>}
        </header>
        {pools.length === 0 ? <div className="external-ip-empty">Add a provider-assigned public CIDR to track utilization and ownership.</div> : (
          <div className="external-ip-table-wrap"><table className="mon-table external-ip-table">
            <thead><tr><th>Pool</th><th>Provider / account</th><th>In use</th><th>Reserved</th><th>Available</th><th>Utilization</th><th aria-label="Actions" /></tr></thead>
            <tbody>{pools.map((pool) => <tr key={pool.id} className={selectedPoolId === pool.id ? "external-ip-row--selected" : ""} onClick={() => { setSelectedPoolId(pool.id); setPageOffset(0); }}>
              <td><strong>{pool.name}</strong><code>{pool.cidr}</code></td>
              <td>{pool.provider ?? "—"}<small>{pool.account ?? "No account reference"}</small></td>
              <td>{pool.in_use}</td><td>{pool.reserved}</td><td>{pool.free}</td>
              <td><span className="external-ip-util"><i style={{ width: `${Math.round(pool.utilization * 100)}%` }} /></span>{Math.round(pool.utilization * 100)}%</td>
              <td className="external-ip-actions">{canWrite && <><button className="nm-btn nm-btn--icon nm-btn--sm" type="button" aria-label={`Edit ${pool.name}`} onClick={(event) => { event.stopPropagation(); openPool(pool); }}><Edit3 size={14} /></button><button className="nm-btn nm-btn--icon nm-btn--sm nm-btn--danger" type="button" aria-label={`Delete ${pool.name}`} onClick={(event) => { event.stopPropagation(); void removePool(pool); }}><Trash2 size={14} /></button></>}</td>
            </tr>)}</tbody>
          </table></div>
        )}
      </section>

      {selectedPool && <section className="nm-app-panel external-ip-panel external-ip-address-panel">
        <header className="nm-app-panel-header external-ip-panel-header"><div><strong>{selectedPool.name} addresses</strong><span>{selectedPool.cidr} · select an available address to track it</span></div></header>
        {addressQuery.isLoading ? <div className="external-ip-empty">Loading addresses…</div> : <>
          <div className="external-ip-grid">{(addressQuery.data?.addresses ?? []).map((entry) => <button
            key={entry.ip_address} type="button" className={`external-ip-address external-ip-address--${entry.status}`}
            title={entry.assignment ? `${entry.assignment.label} · ${statusLabel(entry.assignment.status)}` : "Available"}
            onClick={() => entry.assignment ? openAssignment(entry.assignment) : canWrite && openAssignment(undefined, entry.ip_address, selectedPool.id)}
          ><span>{entry.ip_address}</span><small>{entry.assignment?.label ?? "Available"}</small></button>)}</div>
          {(addressQuery.data?.total ?? 0) > 256 && <footer className="external-ip-pager"><span>{pageOffset + 1}–{Math.min(pageOffset + 256, addressQuery.data?.total ?? 0)} of {addressQuery.data?.total}</span><button className="nm-btn nm-btn--sm" disabled={pageOffset === 0} onClick={() => setPageOffset(Math.max(0, pageOffset - 256))}>Previous</button><button className="nm-btn nm-btn--sm" disabled={pageOffset + 256 >= (addressQuery.data?.total ?? 0)} onClick={() => setPageOffset(pageOffset + 256)}>Next</button></footer>}
        </>}
      </section>}

      <section className="nm-app-panel external-ip-panel">
        <header className="nm-app-panel-header external-ip-panel-header"><div><strong>Standalone external addresses</strong><span>Public IPs not allocated from a managed pool</span></div>{canWrite && <button className="nm-btn nm-btn--sm nm-btn--secondary" type="button" onClick={() => openAssignment()}><Plus size={14} /> Track address</button>}</header>
        {standalone.length === 0 ? <div className="external-ip-empty">No standalone external addresses are being tracked.</div> : <div className="external-ip-table-wrap"><table className="mon-table external-ip-table"><thead><tr><th>IP address</th><th>Label</th><th>Status</th><th>Provider</th><th>Owner / service</th><th aria-label="Actions" /></tr></thead><tbody>{standalone.map((row) => <tr key={row.id}><td><code>{row.ip_address}</code></td><td>{row.label}</td><td><span className={`external-ip-status external-ip-status--${row.status}`}>{statusLabel(row.status)}</span></td><td>{row.provider ?? "—"}</td><td>{row.owner ?? "—"}<small>{row.service ?? "No service"}</small></td><td className="external-ip-actions">{canWrite && <><button className="nm-btn nm-btn--icon nm-btn--sm" type="button" onClick={() => openAssignment(row)} aria-label={`Edit ${row.ip_address}`}><Edit3 size={14} /></button><button className="nm-btn nm-btn--icon nm-btn--sm nm-btn--danger" type="button" onClick={() => void removeAssignment(row)} aria-label={`Remove ${row.ip_address}`}><Trash2 size={14} /></button></>}</td></tr>)}</tbody></table></div>}
      </section>

      {poolModal && <Modal title={poolModal === "new" ? "Add external IP pool" : "Edit external IP pool"} titleIcon={<Globe2 size={18} />} onCancel={() => setPoolModal(null)} footer={<ModalFooterActions onCancel={() => setPoolModal(null)} primaryLabel={busy ? "Saving…" : "Save pool"} primaryDisabled={busy} formId="external-pool-form" />}>
        <form id="external-pool-form" className="modal-form external-ip-form" onSubmit={(event) => void savePool(event)}>
          <div className="nm-form-row"><label>Name<input autoFocus required value={poolForm.name} onChange={(e) => setPoolForm({ ...poolForm, name: e.target.value })} placeholder="Primary WAN allocation" /></label><label>Public CIDR<input required value={poolForm.cidr} onChange={(e) => setPoolForm({ ...poolForm, cidr: e.target.value })} placeholder="203.0.113.0/29" /></label></div>
          <div className="nm-form-row"><label>Provider<input value={poolForm.provider ?? ""} onChange={(e) => setPoolForm({ ...poolForm, provider: e.target.value })} placeholder="ISP or cloud provider" /></label><label>Account / circuit<input value={poolForm.account ?? ""} onChange={(e) => setPoolForm({ ...poolForm, account: e.target.value })} placeholder="Customer or circuit reference" /></label></div>
          <label>Description<textarea rows={3} value={poolForm.description ?? ""} onChange={(e) => setPoolForm({ ...poolForm, description: e.target.value })} placeholder="How this allocation is used" /></label>
          {formError && <p className="modal-error">{formError}</p>}
        </form>
      </Modal>}

      {assignmentModal && <Modal title={assignmentModal === "new" ? "Track external IP" : "Edit external IP"} titleIcon={<Cloud size={18} />} onCancel={() => setAssignmentModal(null)} size="lg" footer={<ModalFooterActions onCancel={() => setAssignmentModal(null)} primaryLabel={busy ? "Saving…" : "Save address"} primaryDisabled={busy} formId="external-assignment-form">{assignmentModal !== "new" && <button type="button" className="nm-btn nm-btn--danger" onClick={() => void removeAssignment(assignmentModal)}>Remove</button>}</ModalFooterActions>}>
        <form id="external-assignment-form" className="modal-form external-ip-form" onSubmit={(event) => void saveAssignment(event)}>
          <div className="nm-form-row"><label>Address<input autoFocus required value={assignmentForm.ip_address} onChange={(e) => setAssignmentForm({ ...assignmentForm, ip_address: e.target.value })} placeholder="8.8.8.8" /></label><label>Pool<select value={assignmentForm.pool_id ?? ""} onChange={(e) => setAssignmentForm({ ...assignmentForm, pool_id: e.target.value ? Number(e.target.value) : null })}><option value="">Standalone address</option>{pools.map((pool) => <option key={pool.id} value={pool.id}>{pool.name} ({pool.cidr})</option>)}</select></label></div>
          <div className="nm-form-row"><label>Label<input required value={assignmentForm.label} onChange={(e) => setAssignmentForm({ ...assignmentForm, label: e.target.value })} placeholder="Public web endpoint" /></label><label>Status<select value={assignmentForm.status} onChange={(e) => setAssignmentForm({ ...assignmentForm, status: e.target.value as ExternalIpAssignment["status"] })}><option value="in_use">In use</option><option value="reserved">Reserved</option><option value="available">Available</option></select></label></div>
          <div className="nm-form-row"><label>Provider<input value={assignmentForm.provider ?? ""} onChange={(e) => setAssignmentForm({ ...assignmentForm, provider: e.target.value })} /></label><label>Account<input value={assignmentForm.account ?? ""} onChange={(e) => setAssignmentForm({ ...assignmentForm, account: e.target.value })} /></label></div>
          <div className="nm-form-row"><label>Owner<input value={assignmentForm.owner ?? ""} onChange={(e) => setAssignmentForm({ ...assignmentForm, owner: e.target.value })} placeholder="Team or customer" /></label><label>Service<input value={assignmentForm.service ?? ""} onChange={(e) => setAssignmentForm({ ...assignmentForm, service: e.target.value })} placeholder="NAT, VPN, mail…" /></label></div>
          <label>Tags<input value={assignmentForm.tags ?? ""} onChange={(e) => setAssignmentForm({ ...assignmentForm, tags: e.target.value })} placeholder="production, wan, customer" /></label>
          <label>Notes<textarea rows={3} value={assignmentForm.notes ?? ""} onChange={(e) => setAssignmentForm({ ...assignmentForm, notes: e.target.value })} /></label>
          {formError && <p className="modal-error">{formError}</p>}
        </form>
      </Modal>}
    </div>
  );
}
