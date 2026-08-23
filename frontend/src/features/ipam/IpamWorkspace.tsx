import { useState, useEffect, useMemo, useCallback, useContext, type FormEvent, type ReactNode } from "react";
import "./ipam.css";
import {
  IPAM_VIEW_CHANGE_EVENT,
  navigateToIpamView,
  readIpamViewFromLocation,
  type IpamViewId,
} from "./ipamNavigation";
import { Network, Activity, X, ChevronUp, ChevronDown, Globe2 } from "lucide-react";
import {
  IconServer, IconWifi, IconWifiOff, IconMapPin, IconAlertCircle, IconArrowRight,
  IconTag, IconFingerprint, IconNote, IconUsers, IconDeviceLaptop, IconClock, IconCalendar,
} from "@tabler/icons-react";
import {
  api,
  type IpamSummary, type IpamSubnet, type IpamConflict, type DhcpLease,
  type IpReservation, type IpReservationPayload, type IpAddressEntry,
  type SubnetPayload, type VlanSuggestion,
} from "../../api/client";
import { TopbarNoteCtx } from "../../context";
import { DashStat } from "../../components/DashStat";
import { UtilizationBar } from "../../components/UtilizationBar";
import { IpGrid } from "../../components/IpGrid";
import { Modal } from "../../components/Modal";
import { MonStatusDot } from "../../components/MonitorBadges";
import { SubnetForm } from "../ipam/SubnetForm";
import { useApiQuery } from "../../hooks/useApiQuery";
import { useSortableData } from "../../hooks/useSortableData";
import { useConfirm } from "../../components/ConfirmDialog";
import { useToast } from "../../components/Toast";
import { WorkspaceSkeleton } from "../../components/Skeleton";
import { ExternalIpPanel } from "./ExternalIpPanel";

function ipamAddressLabel(entry: IpAddressEntry): string | null {
  const name = entry.display_name?.trim();
  if (name) return name;
  if (entry.kind === "dhcp" || entry.kind === "reserved" || entry.kind === "gateway") {
    return entry.label?.trim() || null;
  }
  return null;
}

function defaultReservationExpiryDate() {
  const date = new Date();
  date.setDate(date.getDate() + 90);
  const localTime = date.getTime() - date.getTimezoneOffset() * 60_000;
  return new Date(localTime).toISOString().slice(0, 10);
}

function IpamPanelIdentity({ icon, title, meta }: { icon: ReactNode; title: string; meta?: ReactNode }) {
  return (
    <span className="ipam-panel-identity">
      <span className="ipam-panel-icon" aria-hidden="true">{icon}</span>
      <span className="ipam-panel-title-wrap">
        <span className="ipam-panel-title">{title}</span>
        {meta !== undefined ? <span className="ipam-panel-meta">{meta}</span> : null}
      </span>
    </span>
  );
}

export function IpamWorkspace({ accessToken, canWrite, canCreateDevice = false, onDeviceChange }: { accessToken: string; canWrite: boolean; canCreateDevice?: boolean; onDeviceChange?: (device: import("../../api/client").Device) => void }) {
  const confirmAction = useConfirm();
  const toast = useToast();
  const [ipamView, setIpamView] = useState<IpamViewId>(() => readIpamViewFromLocation());
  const ipamQuery = useApiQuery(async () => {
    const [summary, subnets, conflicts, dhcpLeases, reservations, settings] = await Promise.all([
      api.getIpamSummary(accessToken),
      api.listSubnets(accessToken),
      api.getIpamConflicts(accessToken),
      api.listDhcpLeases(accessToken),
      api.listReservations(accessToken),
      api.adminPublicSettings(),
    ]);
    return { summary, subnets, conflicts, dhcpLeases, reservations, settings };
  }, [accessToken]);
  const summary = ipamQuery.data?.summary ?? null;
  const subnets = useMemo(() => ipamQuery.data?.subnets ?? [], [ipamQuery.data]);
  const conflicts = ipamQuery.data?.conflicts ?? [];
  const dhcpLeases = ipamQuery.data?.dhcpLeases ?? [];
  const reservations = ipamQuery.data?.reservations ?? [];
  const loading = ipamQuery.isLoading;
  const error = ipamQuery.error;
  const defaultReservationExpiryEnabled = ipamQuery.data?.settings.ip_reservation_default_expiry_enabled ?? true;
  const initialReservationExpiry = () => defaultReservationExpiryEnabled ? defaultReservationExpiryDate() : "";

  const [selectedSubnet, setSelectedSubnet] = useState<IpamSubnet | null>(null);

  const [showSubnetForm, setShowSubnetForm] = useState(false);
  const [editingSubnet, setEditingSubnet] = useState<IpamSubnet | null>(null);
  const [formBusy, setFormBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const [showDhcp, setShowDhcp] = useState(false);
  const [dhcpText, setDhcpText] = useState("");
  const [dhcpBusy, setDhcpBusy] = useState(false);
  const [dhcpMsg, setDhcpMsg] = useState<string | null>(null);

  const [showConflicts, setShowConflicts] = useState(false);
  const [addrFilter, setAddrFilter] = useState<"all" | "device" | "dhcp" | "reserved" | "free">("all");

  // Reservation form state
  const [reserveIp, setReserveIp] = useState<string | null>(null);
  const [reserveIpLocked, setReserveIpLocked] = useState(false);
  const [editingReservation, setEditingReservation] = useState<IpReservation | null>(null);
  const [reserveLabel, setReserveLabel] = useState("");
  const [reserveMac, setReserveMac] = useState("");
  const [reserveNotes, setReserveNotes] = useState("");
  const [reserveExpires, setReserveExpires] = useState(""); // YYYY-MM-DD
  const [reserveBusy, setReserveBusy] = useState(false);
  const [reserveError, setReserveError] = useState<string | null>(null);
  const [nextFreeBusySubnetId, setNextFreeBusySubnetId] = useState<number | null>(null);
  const [showReservations, setShowReservations] = useState(false);
  const [resSubnetFilter, setResSubnetFilter] = useState<number | "all">("all");

  const [showVlanImport, setShowVlanImport] = useState(false);
  const [vlanSuggestions, setVlanSuggestions] = useState<VlanSuggestion[]>([]);
  const [vlanSelected, setVlanSelected] = useState<Set<number>>(new Set());
  const [vlanBusy, setVlanBusy] = useState(false);
  const [vlanMsg, setVlanMsg] = useState<string | null>(null);
  const { sortKey: ipamSortKey, sortDir: ipamSortDir, toggleSort: toggleIpamSort } = useSortableData<"name" | "cidr" | "util" | "devices" | "dhcp" | "free" | "gateway">("name");

  const sortedSubnets = useMemo(() => {
    const dir = ipamSortDir === "asc" ? 1 : -1;
    return [...subnets].sort((a, b) => {
      switch (ipamSortKey) {
        case "name": return dir * a.name.localeCompare(b.name);
        case "cidr": return dir * a.cidr.localeCompare(b.cidr);
        case "util": return dir * (a.utilization - b.utilization);
        case "devices": return dir * (a.device_count - b.device_count);
        case "dhcp": return dir * (a.dhcp_count - b.dhcp_count);
        case "free": return dir * (a.free - b.free);
        case "gateway": return dir * ((a.gateway ?? "").localeCompare(b.gateway ?? ""));
        default: return 0;
      }
    });
  }, [subnets, ipamSortKey, ipamSortDir]);

  const load = ipamQuery.reload;

  const setTopbarNote = useContext(TopbarNoteCtx);
  useEffect(() => {
    setTopbarNote("Auto-synced with inventory");
    return () => setTopbarNote("");
  }, [setTopbarNote]);

  // Keep the tab in step with the URL so a deep link (and Back) lands on the right one.
  useEffect(() => {
    const sync = () => setIpamView(readIpamViewFromLocation());
    window.addEventListener("popstate", sync);
    window.addEventListener("hashchange", sync);
    window.addEventListener(IPAM_VIEW_CHANGE_EVENT, sync);
    return () => {
      window.removeEventListener("popstate", sync);
      window.removeEventListener("hashchange", sync);
      window.removeEventListener(IPAM_VIEW_CHANGE_EVENT, sync);
    };
  }, []);

  const addressesQuery = useApiQuery(
    selectedSubnet ? () => api.getSubnetAddresses(accessToken, selectedSubnet.id) : null,
    [accessToken, selectedSubnet?.id],
  );
  const addresses = selectedSubnet ? (addressesQuery.data ?? []) : [];
  const addressesLoading = Boolean(selectedSubnet) && (addressesQuery.isLoading || addressesQuery.isRefreshing);
  const loadAddresses = useCallback(
    (_subnet: IpamSubnet) => addressesQuery.reload({ silent: false }),
    [addressesQuery.reload],
  );

  async function saveSubnet(payload: SubnetPayload, createVlanGroup = false) {
    setFormBusy(true); setFormError(null);
    try {
      if (editingSubnet) {
        await api.updateSubnet(accessToken, editingSubnet.id, payload);
      } else {
        await api.createSubnet(accessToken, payload);
        if (createVlanGroup) {
          try {
            await api.createTopologyGroup(accessToken, {
              name: payload.name,
              display_name: null,
              vlan_id: payload.vlan_id ?? null,
              ip_range: payload.cidr,
              gateway: payload.gateway ?? null,
              description: payload.description ?? null,
            });
          } catch { /* skip silently if group already exists */ }
        }
      }
      setShowSubnetForm(false); setEditingSubnet(null);
      await load();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Failed to save subnet");
    } finally { setFormBusy(false); }
  }

  async function deleteSubnet(subnet: IpamSubnet) {
    const confirmed = await confirmAction({
      title: "Delete subnet",
      message: `Delete subnet "${subnet.name}" (${subnet.cidr})?`,
      detail: "Devices and leases in this range are kept; only the subnet definition is removed.",
      confirmLabel: "Delete subnet",
    });
    if (!confirmed) return;
    try {
      await api.deleteSubnet(accessToken, subnet.id);
      if (selectedSubnet?.id === subnet.id) setSelectedSubnet(null);
      await load();
      toast.success("Subnet deleted");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to delete subnet");
    }
  }

  function parseReserveIpInput(value: string): string[] | string {
    const v = value.trim();
    const parseOctet = (s: string) => { const n = Number(s); return Number.isInteger(n) && n >= 0 && n <= 255 ? n : null; };
    const parseIp = (s: string): number[] | null => {
      const parts = s.trim().split(".");
      if (parts.length !== 4) return null;
      const nums = parts.map(parseOctet);
      return nums.some((n) => n === null) ? null : (nums as number[]);
    };
    // Range: "192.168.1.10-35" or "192.168.1.10-192.168.1.35"
    const dash = v.lastIndexOf("-");
    if (dash > 0) {
      const startStr = v.slice(0, dash);
      const endStr = v.slice(dash + 1);
      const sp = parseIp(startStr);
      if (!sp) return "Invalid start IP";
      // End is either a bare octet (10-35 shorthand) or a full IP
      let ep: number[] | null;
      if (/^\d{1,3}$/.test(endStr)) {
        const eo = parseOctet(endStr);
        if (eo === null) return "Invalid end octet";
        ep = [...sp.slice(0, 3), eo];
      } else {
        ep = parseIp(endStr);
        if (!ep) return "Invalid end IP";
      }
      if (sp[0] !== ep[0] || sp[1] !== ep[1] || sp[2] !== ep[2]) return "Start and end must share the same /24";
      if (sp[3] > ep[3]) return "End must be ≥ start";
      const count = ep[3] - sp[3] + 1;
      if (count > 255) return "Range too large (max 255)";
      const prefix = sp.slice(0, 3).join(".");
      return Array.from({ length: count }, (_, i) => `${prefix}.${sp[3] + i}`);
    }
    return [v];
  }

  function openReserveDialog(ip: string) {
    setReserveIp(ip);
    setReserveIpLocked(true);
    setEditingReservation(null);
    setReserveLabel("");
    setReserveMac("");
    setReserveNotes("");
    setReserveExpires(initialReservationExpiry());
    setReserveError(null);
  }

  function openNewReservation() {
    setReserveIp("");
    setReserveIpLocked(false);
    setEditingReservation(null);
    setReserveLabel("");
    setReserveMac("");
    setReserveNotes("");
    setReserveExpires(initialReservationExpiry());
    setReserveError(null);
  }

  async function openNextFreeReservation(subnet: IpamSubnet) {
    if (!canWrite) return;
    setNextFreeBusySubnetId(subnet.id);
    setSelectedSubnet(subnet);
    setEditingReservation(null);
    setReserveIpLocked(true);
    setReserveLabel("");
    setReserveMac("");
    setReserveNotes("");
    setReserveExpires(initialReservationExpiry());
    setReserveError(null);
    try {
      const { ip } = await api.getNextAvailableIp(accessToken, subnet.id);
      setReserveIp(ip);
    } catch (err) {
      setReserveIp("");
      setReserveIpLocked(false);
      setReserveError(err instanceof Error ? err.message : "No free IP found");
    } finally {
      setNextFreeBusySubnetId(null);
    }
  }

  function openEditReservation(r: IpReservation) {
    setEditingReservation(r);
    setReserveIp(r.ip_address);
    setReserveIpLocked(true);
    setReserveLabel(r.label);
    setReserveMac(r.mac_address ?? "");
    setReserveNotes(r.notes ?? "");
    setReserveExpires(r.expires_at ? r.expires_at.slice(0, 10) : "");
    setReserveError(null);
  }

  function closeReserveDialog() {
    setReserveIp(null);
    setReserveIpLocked(false);
    setEditingReservation(null);
    setReserveError(null);
  }

  async function saveReservation(e: FormEvent) {
    e.preventDefault();
    if (reserveIp === null) return;
    setReserveBusy(true); setReserveError(null);
    try {
      if (editingReservation) {
        await api.updateReservation(accessToken, editingReservation.id, {
          label: reserveLabel.trim(),
          mac_address: reserveMac.trim() || null,
          notes: reserveNotes.trim() || null,
          expires_at: reserveExpires ? `${reserveExpires}T23:59:59Z` : null,
        });
      } else {
        const ips = parseReserveIpInput(reserveIp);
        if (typeof ips === "string") { setReserveError(ips); setReserveBusy(false); return; }
        const expiresAt = reserveExpires ? `${reserveExpires}T23:59:59Z` : null;
        for (const ip of ips) {
          await api.createReservation(accessToken, {
            ip_address: ip, label: reserveLabel.trim(),
            mac_address: ips.length === 1 ? (reserveMac.trim() || null) : null,
            notes: reserveNotes.trim() || null,
            subnet_id: selectedSubnet?.id ?? null,
            expires_at: expiresAt,
          });
        }
      }
      closeReserveDialog();
      await load();
      if (selectedSubnet) void loadAddresses(selectedSubnet);
    } catch (err) {
      setReserveError(err instanceof Error ? err.message : "Failed to save reservation");
    } finally { setReserveBusy(false); }
  }

  async function deleteReservation(r: IpReservation) {
    const confirmed = await confirmAction({
      title: "Remove reservation",
      message: `Remove the reservation for ${r.ip_address}?`,
      confirmLabel: "Remove reservation",
    });
    if (!confirmed) return;
    try {
      await api.deleteReservation(accessToken, r.id);
      await load();
      if (selectedSubnet) void loadAddresses(selectedSubnet);
      toast.success("Reservation removed");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to remove reservation");
    }
  }

  async function importDhcp(e: FormEvent) {
    e.preventDefault();
    setDhcpBusy(true); setDhcpMsg(null);
    try {
      const result = await api.importDhcpLeases(accessToken, dhcpText);
      setDhcpMsg(`Imported ${result.imported} new leases (${result.total} total parsed).`);
      setDhcpText(""); await load();
    } catch {
      setDhcpMsg("Failed to parse lease file. Check the format.");
    } finally { setDhcpBusy(false); }
  }

  async function clearDhcp() {
    const confirmed = await confirmAction({
      title: "Clear DHCP leases",
      message: `Clear all ${dhcpLeases.length} imported DHCP leases?`,
      detail: "Lease data can be re-imported from your DHCP server at any time.",
      confirmLabel: "Clear leases",
    });
    if (!confirmed) return;
    try {
      await api.clearDhcpLeases(accessToken);
      await load();
      toast.success("DHCP leases cleared");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to clear DHCP leases");
    }
  }

  async function openVlanImport() {
    setVlanMsg(null); setVlanSelected(new Set());
    const suggestions = await api.getVlanSuggestions(accessToken);
    setVlanSuggestions(suggestions);
    setShowVlanImport(true);
  }

  function toggleVlan(id: number) {
    setVlanSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  async function doVlanImport() {
    if (vlanSelected.size === 0) return;
    setVlanBusy(true); setVlanMsg(null);
    try {
      const result = await api.importSubnetsFromVlans(accessToken, [...vlanSelected]);
      setVlanMsg(`Imported ${result.imported} subnet${result.imported !== 1 ? "s" : ""}.`);
      setVlanSelected(new Set());
      await load();
      const updated = await api.getVlanSuggestions(accessToken);
      setVlanSuggestions(updated);
    } catch {
      setVlanMsg("Import failed.");
    } finally { setVlanBusy(false); }
  }

  const filteredAddresses = useMemo(() => {
    if (addrFilter === "all") return addresses;
    if (addrFilter === "reserved") return addresses.filter((a) => a.kind === "reserved");
    return addresses.filter((a) => a.kind === addrFilter);
  }, [addresses, addrFilter]);

  const filteredReservations = useMemo(() => {
    if (resSubnetFilter === "all") return reservations;
    return reservations.filter((r) => r.subnet_id === resSubnetFilter);
  }, [reservations, resSubnetFilter]);

  function fmtExpiry(iso: string | null) {
    if (!iso) return "—";
    const d = new Date(iso);
    return d.toLocaleDateString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  }

  if (loading) return <div className="dash-layout"><WorkspaceSkeleton /></div>;
  if (error) return <div className="dash-layout"><p className="dash-empty" style={{ color: "var(--dash-red)" }}>{error}</p></div>;

  const errorConflicts = conflicts.filter((c) => c.severity === "error");
  const warnConflicts = conflicts.filter((c) => c.severity === "warning");
  const summaryCards = (
    <div className="dash-stats ipam-stats nm-summary-band">
      <DashStat label="Subnets" value={summary?.subnet_count ?? 0} sub="defined" icon={<Network size={20} />} accent="teal" />
      <DashStat label="Total hosts" value={summary?.total_hosts ?? 0} sub="across all subnets" icon={<IconServer size={20} />} accent="blue" />
      <DashStat label="Used" value={summary?.used ?? 0} sub="addresses assigned" icon={<IconWifi size={20} />} accent="green" />
      <DashStat label="Free" value={summary?.free ?? 0} sub="addresses available" icon={<IconWifiOff size={20} />} accent="indigo" />
      <DashStat label="Reserved" value={summary?.reservation_count ?? 0} sub="IP reservations" icon={<IconMapPin size={20} />} accent="purple" />
      <DashStat label="DHCP leases" value={summary?.dhcp_lease_count ?? 0} sub="imported" icon={<Activity size={20} />} accent="blue" />
    </div>
  );

  // External IPs is its own page now, not a tab inside this one. It shares nothing with
  // Internal networks — the subnet stats, conflicts, reservations and DHCP leases below
  // are all internal concerns and used to render above the external table regardless.
  if (ipamView === "external") {
    return (
      <section className="dash-layout ipam-workspace ipam-workspace--external">
        <ExternalIpPanel
          accessToken={accessToken}
          canWrite={canWrite}
          canCreateDevice={canCreateDevice}
          onDeviceChange={onDeviceChange}
        />
      </section>
    );
  }

  return (
    <section className="dash-layout ipam-workspace">
      {/* Stat cards */}
      {summaryCards}

      {/* Conflicts banner */}
      {conflicts.length > 0 && (
        <div className={`dash-alert${errorConflicts.length === 0 ? " dash-alert--warn" : ""}`} style={{ maxWidth: "none" }}>
          <IconAlertCircle size={15} />
          <span>
            <strong>{conflicts.length} conflict{conflicts.length !== 1 ? "s" : ""} detected</strong>
            {" — "}
            {errorConflicts.length > 0 && `${errorConflicts.length} error${errorConflicts.length !== 1 ? "s" : ""}, `}
            {warnConflicts.length > 0 && `${warnConflicts.length} warning${warnConflicts.length !== 1 ? "s" : ""}`}
          </span>
          <button type="button" className="dash-alert-link" onClick={() => setShowConflicts((v) => !v)}>
            {showConflicts ? "Hide" : "View"} <IconArrowRight size={13} />
          </button>
        </div>
      )}

      {/* Conflict list */}
      {showConflicts && conflicts.length > 0 && (
        <div className="dash-panel nm-app-panel ipam-panel ipam-conflicts-panel">
          <div className="dash-panel-header nm-app-panel-header ipam-panel-header">
            <IpamPanelIdentity icon={<IconAlertCircle size={18} />} title="Conflicts" meta={`${conflicts.length} total`} />
          </div>
          <div className="dash-panel-body" style={{ padding: "10px 18px" }}>
            {conflicts.map((c, i) => (
              <div key={i} className={`ipam-conflict-row ipam-conflict-row--${c.severity}`}>
                <span className="ipam-conflict-icon">{c.severity === "error" ? "●" : "◆"}</span>
                <span className="ipam-conflict-desc">{c.description}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* VLAN import picker */}
      {showVlanImport && (
        <div className="dash-panel nm-app-panel ipam-panel ipam-vlan-import-panel">
          <div className="dash-panel-header nm-app-panel-header ipam-panel-header">
            <IpamPanelIdentity icon={<IconTag size={18} />} title="Import subnets from VLANs" meta="Review available ranges" />
            <button type="button" className="dash-panel-link" onClick={() => { setShowVlanImport(false); setVlanMsg(null); }}>
              <X size={14} />
            </button>
          </div>
          <div className="dash-panel-body" style={{ padding: "12px 18px" }}>
            {vlanSuggestions.length === 0 ? (
              <p className="dash-empty">No VLANs with an IP range configured. Set an IP range on a VLAN in the topology settings.</p>
            ) : (
              <>
                <table className="mon-table ipam-data-table" style={{ marginBottom: 10 }}>
                  <thead>
                    <tr>
                      <th style={{ width: 32 }} />
                      <th>VLAN name</th>
                      <th>VLAN ID</th>
                      <th>IP range</th>
                      <th>Gateway</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {vlanSuggestions.map((v) => (
                      <tr key={v.id} className="mon-row" style={{ opacity: v.already_imported ? 0.5 : 1 }}>
                        <td>
                          <input
                            type="checkbox"
                            checked={vlanSelected.has(v.id)}
                            disabled={v.already_imported}
                            onChange={() => toggleVlan(v.id)}
                          />
                        </td>
                        <td><span className="mon-device-name">{v.display_name || v.name}</span></td>
                        <td className="mon-cell-mono">{v.vlan_id ?? "—"}</td>
                        <td><code className="ipam-cidr">{v.ip_range}</code></td>
                        <td className="mon-cell-mono">{v.gateway ?? "—"}</td>
                        <td>
                          {v.already_imported
                            ? <span className="nm-status nm-status--unknown">Already imported</span>
                            : <span className="nm-status nm-status--online">Available</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {vlanMsg && <p style={{ fontSize: 13, marginBottom: 8, color: "var(--dash-green)" }}>{vlanMsg}</p>}
                <button
                  type="button"
                  className="nm-btn nm-btn--primary"
                  disabled={vlanSelected.size === 0 || vlanBusy}
                  onClick={() => void doVlanImport()}
                >
                  {vlanBusy ? "Importing…" : `Import ${vlanSelected.size > 0 ? vlanSelected.size : ""} selected`}
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {/* Add subnet modal */}
      {showSubnetForm && !editingSubnet && (
        <Modal title="Add subnet" titleIcon={<Network size={18} />} onCancel={() => { setShowSubnetForm(false); setFormError(null); }}>
          <div className="ipam-subnet-form-modal-body">
            <SubnetForm
              showVlanSync
              onSave={(p, createVlanGroup) => void saveSubnet(p, createVlanGroup)}
              onCancel={() => { setShowSubnetForm(false); setFormError(null); }}
              busy={formBusy}
              error={formError}
            />
          </div>
        </Modal>
      )}

      {/* Edit subnet modal */}
      {editingSubnet && (
        <Modal title="Edit subnet" titleIcon={<Network size={18} />} onCancel={() => { setEditingSubnet(null); setFormError(null); }}>
          <div className="ipam-subnet-form-modal-body">
            <SubnetForm
              initial={editingSubnet}
              onSave={(p) => void saveSubnet(p, false)}
              onCancel={() => { setEditingSubnet(null); setFormError(null); }}
              busy={formBusy}
              error={formError}
            />
          </div>
        </Modal>
      )}

      {/* Reservations panel */}
      <div className="dash-panel nm-app-panel ipam-panel ipam-reservations-panel">
        <div className="dash-panel-header nm-app-panel-header ipam-panel-header ipam-reservations-header">
          <IpamPanelIdentity
            icon={<IconMapPin size={18} />}
            title="IP reservations"
            meta={resSubnetFilter === "all" ? `${reservations.length} reserved` : `${filteredReservations.length} of ${reservations.length} shown`}
          />
          <div className="ipam-reservations-actions">
            {subnets.length > 0 && (
              <label className="ipam-reservation-filter">
                <span>Subnet</span>
                <select
                  className="inv-select"
                  value={resSubnetFilter === "all" ? "all" : String(resSubnetFilter)}
                  onChange={(e) => setResSubnetFilter(e.target.value === "all" ? "all" : Number(e.target.value))}
                >
                  <option value="all">All subnets</option>
                  {subnets.map((s) => (
                    <option key={s.id} value={String(s.id)}>{s.name} ({s.cidr})</option>
                  ))}
                </select>
              </label>
            )}
            {canWrite && reservations.some((r) => r.expires_at && new Date(r.expires_at) < new Date()) && (
              <button
                type="button"
                className="nm-btn"
                onClick={async () => {
                  const confirmed = await confirmAction({
                    title: "Delete expired reservations",
                    message: "Delete all expired IP reservations?",
                    confirmLabel: "Delete expired",
                  });
                  if (!confirmed) return;
                  try {
                    const { deleted } = await api.deleteExpiredReservations(accessToken);
                    if (deleted > 0) { await load(); if (selectedSubnet) void loadAddresses(selectedSubnet); }
                    toast.success(deleted > 0 ? `Deleted ${deleted} expired reservation${deleted === 1 ? "" : "s"}` : "No expired reservations to delete");
                  } catch (err) {
                    toast.error(err instanceof Error ? err.message : "Failed to delete expired reservations");
                  }
                }}
              >
                Clear expired
              </button>
            )}
            {canWrite && (
              <button type="button" className="nm-btn nm-btn--secondary" onClick={openNewReservation}>
                + Reserve IP
              </button>
            )}
            <button type="button" className="dash-panel-link" onClick={() => setShowReservations((v) => !v)}>
              {showReservations ? "Hide" : "Show"}
            </button>
          </div>
        </div>
        {showReservations && (
          <div className="dash-panel-body ipam-reservations-body">
            {filteredReservations.length === 0 ? (
              <p className="dash-empty">{reservations.length === 0 ? "No IP reservations yet. Click a free address in any subnet detail to reserve it." : "No reservations match the selected subnet."}</p>
            ) : (
              <table className="mon-table ipam-data-table ipam-reservations-table">
                <thead>
                  <tr>
                    <th><Network size={12} style={{ marginRight: 4, verticalAlign: "middle" }} />IP Address</th>
                    <th><IconTag size={12} style={{ marginRight: 4, verticalAlign: "middle" }} />Label</th>
                    <th><IconFingerprint size={12} style={{ marginRight: 4, verticalAlign: "middle" }} />MAC</th>
                    <th><IconNote size={12} style={{ marginRight: 4, verticalAlign: "middle" }} />Notes</th>
                    <th><IconUsers size={12} style={{ marginRight: 4, verticalAlign: "middle" }} />Reserved by</th>
                    <th><IconCalendar size={12} style={{ marginRight: 4, verticalAlign: "middle" }} />Expires</th>
                    {canWrite && <th />}
                  </tr>
                </thead>
                <tbody>
                  {filteredReservations.map((r) => (
                    <tr key={r.id} className="mon-row">
                      <td><code className="ipam-cidr">{r.ip_address}</code></td>
                      <td className="mon-device-name">{r.label}</td>
                      <td className="mon-cell-mono">{r.mac_address ?? <span className="dash-panel-meta">—</span>}</td>
                      <td>{r.notes ?? <span className="dash-panel-meta">—</span>}</td>
                      <td className="mon-cell-mono">{r.reserved_by ?? <span className="dash-panel-meta">—</span>}</td>
                      <td className="mon-cell-mono">
                        {r.expires_at ? (
                          new Date(r.expires_at) < new Date()
                            ? <span className="ipam-expired-badge" title={r.expires_at}>expired</span>
                            : r.expires_at.slice(0, 10)
                        ) : <span className="dash-panel-meta">—</span>}
                      </td>
                      {canWrite && (
                        <td>
                          <span className="ipam-row-actions">
                            <button type="button" className="nm-btn nm-btn--sm" onClick={() => openEditReservation(r)}>Edit</button>
                            <button type="button" className="nm-btn nm-btn--sm nm-btn--danger" onClick={() => void deleteReservation(r)}>Delete</button>
                          </span>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </div>

      {/* Subnet list */}
      {(
        <div className="ipam-subnets-panel-wrap">
        <div className="dash-panel nm-app-panel ipam-panel ipam-subnets-panel">
          <div className="dash-panel-header nm-app-panel-header ipam-panel-header">
            <span className="ipam-panel-identity">
              <span className="ipam-panel-icon" aria-hidden="true"><Network size={18} /></span>
              <span className="ipam-panel-title-wrap">
                <span className="ipam-panel-title">Internal networks</span>
                <span className="ipam-panel-meta">{subnets.length} subnet{subnets.length === 1 ? "" : "s"}</span>
              </span>
            </span>
            {canWrite && !showSubnetForm && (
              <span style={{ display: "flex", gap: 8 }}>
                <button type="button" className="nm-btn" onClick={() => void openVlanImport()}>
                  Import from VLANs
                </button>
                <button type="button" className="nm-btn nm-btn--primary" onClick={() => setShowSubnetForm(true)}>
                  + Add subnet
                </button>
              </span>
            )}
          </div>
          <div className="dash-panel-body">
            {subnets.length === 0 ? (
              <p className="dash-empty">No subnets defined yet. Add one to start tracking utilization.</p>
            ) : (
              <table className="mon-table ipam-data-table ipam-subnets-table">
                <thead>
                  <tr>
                    <th><button type="button" className={`inventory-sort-btn${ipamSortKey === "name" ? " active" : ""}`} onClick={() => toggleIpamSort("name")}>Name{ipamSortKey === "name" && (ipamSortDir === "asc" ? <ChevronUp size={10} /> : <ChevronDown size={10} />)}</button></th>
                    <th><button type="button" className={`inventory-sort-btn${ipamSortKey === "cidr" ? " active" : ""}`} onClick={() => toggleIpamSort("cidr")}>CIDR{ipamSortKey === "cidr" && (ipamSortDir === "asc" ? <ChevronUp size={10} /> : <ChevronDown size={10} />)}</button></th>
                    <th><button type="button" className={`inventory-sort-btn${ipamSortKey === "util" ? " active" : ""}`} onClick={() => toggleIpamSort("util")}>Utilization{ipamSortKey === "util" && (ipamSortDir === "asc" ? <ChevronUp size={10} /> : <ChevronDown size={10} />)}</button></th>
                    <th><button type="button" className={`inventory-sort-btn${ipamSortKey === "devices" ? " active" : ""}`} onClick={() => toggleIpamSort("devices")}>Devices{ipamSortKey === "devices" && (ipamSortDir === "asc" ? <ChevronUp size={10} /> : <ChevronDown size={10} />)}</button></th>
	                    <th><button type="button" className={`inventory-sort-btn${ipamSortKey === "dhcp" ? " active" : ""}`} onClick={() => toggleIpamSort("dhcp")}>DHCP{ipamSortKey === "dhcp" && (ipamSortDir === "asc" ? <ChevronUp size={10} /> : <ChevronDown size={10} />)}</button></th>
	                    <th>DHCP range</th>
	                    <th><button type="button" className={`inventory-sort-btn${ipamSortKey === "free" ? " active" : ""}`} onClick={() => toggleIpamSort("free")}>Free{ipamSortKey === "free" && (ipamSortDir === "asc" ? <ChevronUp size={10} /> : <ChevronDown size={10} />)}</button></th>
                    <th><button type="button" className={`inventory-sort-btn${ipamSortKey === "gateway" ? " active" : ""}`} onClick={() => toggleIpamSort("gateway")}>Gateway{ipamSortKey === "gateway" && (ipamSortDir === "asc" ? <ChevronUp size={10} /> : <ChevronDown size={10} />)}</button></th>
                    {canWrite && <th />}
                  </tr>
                </thead>
                <tbody>
                  {sortedSubnets.map((s) => (
                    <tr
                      key={s.id}
                      className={`mon-row ipam-subnet-row${selectedSubnet?.id === s.id ? " mon-row--active" : ""}`}
                      onClick={() => { setSelectedSubnet(s); setAddrFilter("all"); }}
                    >
                      <td>
                        <span className="mon-device-name">{s.name}</span>
                        {s.vlan_id && <span className="mon-device-ip">VLAN {s.vlan_id}</span>}
                      </td>
                      <td><code className="ipam-cidr">{s.cidr}</code></td>
                      <td>
                        <div className="ipam-util-wrap">
                          <UtilizationBar value={s.utilization} size="thin" />
                          <span className="ipam-util-pct">{Math.round(s.utilization * 100)}%</span>
                        </div>
                      </td>
	                      <td className="mon-cell-mono">{s.device_count}</td>
	                      <td className="mon-cell-mono">{s.dhcp_count}</td>
	                      <td>
	                        {s.dhcp_start && s.dhcp_end
	                          ? <span className="ipam-dhcp-range-pill"><code>{s.dhcp_start}</code><span>to</span><code>{s.dhcp_end}</code></span>
	                          : <span className="dash-panel-meta">—</span>}
	                      </td>
	                      <td className="mon-cell-mono">{s.free}</td>
                      <td className="mon-cell-mono">{s.gateway ?? "—"}</td>
                      {canWrite && (
                        <td onClick={(e) => e.stopPropagation()}>
                          <span className="ipam-row-actions">
                            <button
                              type="button"
                              className="nm-btn nm-btn--sm"
                              disabled={nextFreeBusySubnetId === s.id}
                              onClick={() => void openNextFreeReservation(s)}
                            >
                              {nextFreeBusySubnetId === s.id ? "Finding..." : "Next free"}
                            </button>
                            <button type="button" className="nm-btn nm-btn--sm" onClick={() => { setEditingSubnet(s); setShowSubnetForm(false); }}>Edit</button>
                            <button type="button" className="nm-btn nm-btn--sm nm-btn--danger" onClick={() => void deleteSubnet(s)}>Delete</button>
                          </span>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
        </div>
      )}

      {/* Subnet detail modal */}
      {selectedSubnet && (
        <Modal
          title={selectedSubnet.name}
          titleIcon={<Network size={18} />}
          onCancel={() => setSelectedSubnet(null)}
          modalClassName="ipam-detail-modal"
          bodyClassName="ipam-detail-modal-shell modal-body--flush"
          headerExtra={(
            <>
              <code className="ipam-cidr ipam-modal-cidr">{selectedSubnet.cidr}</code>
              {selectedSubnet.vlan_id && <span className="mon-device-ip">VLAN {selectedSubnet.vlan_id}</span>}
            </>
          )}
          headerActions={canWrite ? (
            <button
              type="button"
              className="nm-btn nm-btn--secondary ipam-next-ip-header-btn"
              disabled={nextFreeBusySubnetId === selectedSubnet.id}
              onClick={() => void openNextFreeReservation(selectedSubnet)}
            >
              {nextFreeBusySubnetId === selectedSubnet.id ? "Finding..." : `Reserve next IP in ${selectedSubnet.cidr}`}
            </button>
          ) : undefined}
        >
          <div className="ipam-modal-stats">
            <div className="ipam-modal-stat">
              <span className="ipam-modal-stat-label">Used</span>
              <strong className="ipam-modal-stat-val">{selectedSubnet.used}<span className="ipam-modal-stat-of"> / {selectedSubnet.total_hosts}</span></strong>
            </div>
            <div className="ipam-modal-stat">
              <span className="ipam-modal-stat-label">Free</span>
              <strong className="ipam-modal-stat-val">{selectedSubnet.free}</strong>
            </div>
            <div className="ipam-modal-stat">
              <span className="ipam-modal-stat-label">Utilization</span>
              <strong className="ipam-modal-stat-val">{Math.round(selectedSubnet.utilization * 100)}%</strong>
            </div>
            {selectedSubnet.gateway && (
              <div className="ipam-modal-stat">
                <span className="ipam-modal-stat-label">Gateway</span>
                <strong className="ipam-modal-stat-val ipam-modal-stat-mono">{selectedSubnet.gateway}</strong>
              </div>
            )}
            {selectedSubnet.dhcp_start && selectedSubnet.dhcp_end && (
              <div className="ipam-modal-stat">
                <span className="ipam-modal-stat-label">DHCP range</span>
                <span className="ipam-dhcp-range-pill ipam-modal-dhcp-pill">
                  <code>{selectedSubnet.dhcp_start}</code><span>to</span><code>{selectedSubnet.dhcp_end}</code>
                </span>
              </div>
            )}
          </div>

          <div className="ipam-modal-util">
            <UtilizationBar value={selectedSubnet.utilization} />
          </div>

          <div className="ipam-addr-tabs" role="tablist" aria-label="Address filter">
            {(
              [
                { key: "all" as const, label: "All" },
                { key: "device" as const, label: "Devices", count: addresses.filter((a) => a.kind === "device").length },
                { key: "dhcp" as const, label: "DHCP", count: addresses.filter((a) => a.kind === "dhcp").length },
                { key: "reserved" as const, label: "Reserved", count: addresses.filter((a) => a.kind === "reserved").length },
                { key: "free" as const, label: "Free", count: addresses.filter((a) => a.kind === "free").length },
              ]
            ).map((tab) => (
              <button
                key={tab.key}
                type="button"
                role="tab"
                aria-selected={addrFilter === tab.key}
                className={`ipam-addr-tab${addrFilter === tab.key ? " active" : ""}`}
                onClick={() => setAddrFilter(tab.key)}
              >
                <span className="ipam-addr-tab-label">{tab.label}</span>
                {"count" in tab && tab.count !== undefined ? (
                  <span className="ipam-addr-tab-count">{tab.count}</span>
                ) : null}
              </button>
            ))}
          </div>

          <div className="ipam-modal-body">
            {addressesLoading ? (
              <p className="dash-empty ipam-modal-body-inner">Loading addresses…</p>
            ) : addresses.length === 0 ? (
              <p className="dash-empty ipam-modal-body-inner">Subnet too large to enumerate individual IPs (max 1024 hosts).</p>
            ) : addrFilter === "all" && addresses.length <= 256 ? (
              <div className="ipam-modal-body-inner">
                <IpGrid entries={addresses} onReserve={openReserveDialog} canWrite={canWrite} />
                <div className="ipam-grid-legend">
                  {[["device","Device"], ["dhcp","DHCP lease"], ["dhcp-pool","DHCP range"], ["reserved","Reserved"], ["gateway","Gateway"], ["free","Free"], ["system","Net/Bcast"]].map(([kind, label]) => (
                    <span key={kind} className="ipam-legend-item"><span className={`ipam-legend-dot ipam-legend-dot--${kind}`} />{label}</span>
                  ))}
                  {canWrite && <span className="ipam-legend-tip">· click a free address to reserve it</span>}
                </div>
              </div>
            ) : (
              <table className="ipam-addr-table">
                <colgroup>
                  <col className="ipam-addr-col" />
                  <col className="ipam-addr-col" />
                  <col className="ipam-addr-col" />
                </colgroup>
                <thead>
                  <tr><th>IP Address</th><th>Status</th><th>Label</th></tr>
                </thead>
                <tbody>
                  {filteredAddresses.filter((a) => a.kind !== "network" && a.kind !== "broadcast").map((a) => (
                    <tr key={a.ip} className="ipam-addr-row">
                      <td className="ipam-addr-cell ipam-addr-cell--ip">
                        <code className="ipam-cidr">{a.ip}</code>
                      </td>
                      <td className="ipam-addr-cell ipam-addr-cell--status">
                        <span className={`ipam-kind-badge ipam-kind-badge--${a.kind}`}>{a.kind}</span>
                      </td>
                      <td className="ipam-addr-cell ipam-addr-cell--label">
                        <span className="ipam-addr-label">
                          {ipamAddressLabel(a) ?? <span className="dash-panel-meta">—</span>}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </Modal>
      )}

      {reserveIp !== null && (
        <Modal
          title={editingReservation ? "Edit reservation" : "Reserve IP address"}
          titleIcon={<IconMapPin size={18} />}
          onCancel={closeReserveDialog}
          size="sm"
          footer={(
            <div className="nm-btn-row" style={{ width: "100%", justifyContent: "space-between" }}>
              {editingReservation && canWrite ? (
                <button
                  type="button"
                  className="nm-btn nm-btn--danger"
                  onClick={() => { closeReserveDialog(); void deleteReservation(editingReservation); }}
                >
                  Delete
                </button>
              ) : <span />}
              <div className="nm-btn-row">
                <button type="button" className="nm-btn" onClick={closeReserveDialog}>Cancel</button>
                <button
                  type="submit"
                  form="reserve-ip-form"
                  className="nm-btn nm-btn--secondary"
                  disabled={reserveBusy || !reserveLabel.trim()}
                >
                  {reserveBusy ? "Saving…" : editingReservation ? "Save changes" : (() => {
                    const r = reserveIp ? parseReserveIpInput(reserveIp) : null;
                    return Array.isArray(r) && r.length > 1 ? `Reserve ${r.length} addresses` : "Reserve IP";
                  })()}
                </button>
              </div>
            </div>
          )}
        >
          <form id="reserve-ip-form" className="modal-form" onSubmit={(e) => void saveReservation(e)}>
            <label className="nm-field">
              <span className="nm-field-label">IP address</span>
              <input
                className="nm-input"
                style={{ fontFamily: "monospace" }}
                required
                placeholder="e.g. 192.168.1.50 or 192.168.1.10-35"
                value={reserveIp ?? ""}
                readOnly={reserveIpLocked || !!editingReservation}
                autoFocus={!reserveIpLocked && !editingReservation}
                onChange={(e) => setReserveIp(e.target.value)}
              />
            </label>
            {!reserveIpLocked && !editingReservation && selectedSubnet && (
              <button
                type="button"
                className="nm-btn nm-btn--sm"
                style={{ alignSelf: "flex-start" }}
                onClick={async () => {
                  try {
                    const { ip } = await api.getNextAvailableIp(accessToken, selectedSubnet.id);
                    setReserveIp(ip);
                  } catch (err) {
                    setReserveError(err instanceof Error ? err.message : "No free IP found");
                  }
                }}
              >
                Use next free IP in {selectedSubnet.cidr}
              </button>
            )}
            {!reserveIpLocked && !editingReservation && reserveIp ? (() => {
              const result = parseReserveIpInput(reserveIp);
              return Array.isArray(result) && result.length > 1
                ? <p className="ipam-range-preview">→ {result.length} addresses ({result[0]} – {result[result.length - 1]})</p>
                : null;
            })() : null}
            <label className="nm-field">
              <span className="nm-field-label">Label / purpose *</span>
              <input
                className="nm-input"
                required
                placeholder="e.g. Printer, CCTV camera, Reserved for server"
                value={reserveLabel}
                onChange={(e) => setReserveLabel(e.target.value)}
                autoFocus={reserveIpLocked || !!editingReservation}
              />
            </label>
            {(() => {
              const result = reserveIp ? parseReserveIpInput(reserveIp) : null;
              const isRange = Array.isArray(result) && result.length > 1;
              return !isRange ? (
                <label className="nm-field">
                  <span className="nm-field-label">MAC address</span>
                  <input
                    className="nm-input"
                    style={{ fontFamily: "monospace" }}
                    placeholder="e.g. aa:bb:cc:dd:ee:ff"
                    value={reserveMac}
                    onChange={(e) => setReserveMac(e.target.value)}
                  />
                </label>
              ) : null;
            })()}
            <label className="nm-field">
              <span className="nm-field-label">Notes</span>
              <input
                className="nm-input"
                placeholder="Optional"
                value={reserveNotes}
                onChange={(e) => setReserveNotes(e.target.value)}
              />
            </label>
            <label className="nm-field">
              <span className="nm-field-label">Expires</span>
              <input
                type="date"
                className="nm-input"
                value={reserveExpires}
                onChange={(e) => setReserveExpires(e.target.value)}
              />
              <span className="dash-panel-meta">New reservations default to 90 days from today.</span>
            </label>
            {reserveError && <p className="nm-alert nm-alert--error">{reserveError}</p>}
          </form>
        </Modal>
      )}

      {/* DHCP leases panel */}
      <div className="dash-panel nm-app-panel ipam-panel ipam-dhcp-panel">
        <div className="dash-panel-header nm-app-panel-header ipam-panel-header">
          <IpamPanelIdentity icon={<Activity size={18} />} title="DHCP leases" meta={`${dhcpLeases.length} imported`} />
          <button type="button" className="dash-panel-link" onClick={() => setShowDhcp((v) => !v)} style={{ marginLeft: 12 }}>
            {showDhcp ? "Hide importer" : "Import leases"}
          </button>
          {canWrite && dhcpLeases.length > 0 && (
            <button type="button" className="dash-panel-link ipam-delete-btn" onClick={() => void clearDhcp()} style={{ marginLeft: 8 }}>
              Clear all
            </button>
          )}
        </div>

        {showDhcp && (
          <div className="ipam-dhcp-importer">
            <form onSubmit={(e) => void importDhcp(e)}>
              <textarea
                className="ipam-lease-textarea"
                rows={8}
                placeholder={"Paste ISC dhcpd.leases or dnsmasq.leases content here…\n\nISC example:\nlease 192.168.1.50 {\n  starts 1 2026/01/01 08:00:00;\n  ends 1 2026/01/01 20:00:00;\n  binding state active;\n  hardware ethernet aa:bb:cc:dd:ee:ff;\n  client-hostname \"mypc\";\n}"}
                value={dhcpText}
                onChange={(e) => setDhcpText(e.target.value)}
              />
              <div style={{ display: "flex", gap: 8, marginTop: 8, alignItems: "center" }}>
                <button type="submit" className="nm-btn nm-btn--primary" disabled={dhcpBusy || !dhcpText.trim()}>
                  {dhcpBusy ? "Importing…" : "Import"}
                </button>
                {dhcpMsg && <span className="dash-panel-meta">{dhcpMsg}</span>}
              </div>
            </form>
          </div>
        )}

        <div className="dash-panel-body" style={{ maxHeight: 280 }}>
          {dhcpLeases.length === 0 ? (
            <p className="dash-empty">No DHCP leases imported yet.</p>
          ) : (
            <table className="mon-table ipam-data-table ipam-dhcp-table">
              <thead>
                <tr>
                <th><Network size={12} style={{ marginRight: 4, verticalAlign: "middle" }} />IP Address</th>
                <th><IconFingerprint size={12} style={{ marginRight: 4, verticalAlign: "middle" }} />MAC</th>
                <th><IconDeviceLaptop size={12} style={{ marginRight: 4, verticalAlign: "middle" }} />Hostname</th>
                <th><IconClock size={12} style={{ marginRight: 4, verticalAlign: "middle" }} />Expires</th>
                <th><Activity size={12} style={{ marginRight: 4, verticalAlign: "middle" }} />Active</th>
              </tr>
              </thead>
              <tbody>
                {dhcpLeases.map((l) => (
                  <tr key={l.id} className="mon-row">
                    <td><code className="ipam-cidr">{l.ip_address}</code></td>
                    <td className="mon-cell-mono">{l.mac_address ?? "—"}</td>
                    <td>{l.hostname ?? <span className="dash-panel-meta">—</span>}</td>
                    <td className="mon-cell-mono">{fmtExpiry(l.expires_at)}</td>
                    <td><MonStatusDot status={l.is_active ? "online" : "offline"} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

    </section>
  );
}
