import { useState, type FormEvent } from "react";
import { Globe2, Network } from "lucide-react";
import { type ExternalIpPoolPayload, type SubnetPayload } from "../../api/client";

export function SubnetForm({
  initial, onSave, onSaveExternal, onCancel, busy, error, showVlanSync = false,
}: {
  initial?: Partial<SubnetPayload>;
  onSave: (p: SubnetPayload, createVlanGroup: boolean) => void;
  onSaveExternal?: (p: ExternalIpPoolPayload) => void;
  onCancel: () => void;
  busy: boolean;
  error: string | null;
  showVlanSync?: boolean;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [cidr, setCidr] = useState(initial?.cidr ?? "");
  const [gateway, setGateway] = useState(initial?.gateway ?? "");
  const [dhcpStart, setDhcpStart] = useState(initial?.dhcp_start ?? "");
  const [dhcpEnd, setDhcpEnd] = useState(initial?.dhcp_end ?? "");
  const [vlan, setVlan] = useState(initial?.vlan_id ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [createVlanGroup, setCreateVlanGroup] = useState(false);
  const [scope, setScope] = useState<"internal" | "external">("internal");
  const [provider, setProvider] = useState("");
  const [account, setAccount] = useState("");

  function submit(e: FormEvent) {
    e.preventDefault();
    if (scope === "external" && onSaveExternal) {
      onSaveExternal({
        name: name.trim(),
        cidr: cidr.trim(),
        provider: provider.trim() || null,
        account: account.trim() || null,
        description: description.trim() || null,
      });
      return;
    }
    onSave({
      name: name.trim(),
      cidr: cidr.trim(),
      gateway: gateway.trim() || null,
      dhcp_start: dhcpStart.trim() || null,
      dhcp_end: dhcpEnd.trim() || null,
      vlan_id: vlan.trim() || null,
      description: description.trim() || null,
    }, createVlanGroup);
  }

  return (
    <form className="ipam-subnet-form" onSubmit={submit}>
      {onSaveExternal && (
        <fieldset className="ipam-scope-fieldset">
          <legend>Address scope</legend>
          <div className="ipam-scope-options">
            <button type="button" className={`ipam-scope-option${scope === "internal" ? " active" : ""}`} aria-pressed={scope === "internal"} onClick={() => setScope("internal")}>
              <Network size={18} /><span><strong>Internal network</strong><small>A private subnet used by devices, VLANs, DHCP and reservations.</small></span>
            </button>
            <button type="button" className={`ipam-scope-option${scope === "external" ? " active" : ""}`} aria-pressed={scope === "external"} onClick={() => setScope("external")}>
              <Globe2 size={18} /><span><strong>External range</strong><small>A small assigned range or full CIDR from an ISP or cloud provider.</small></span>
            </button>
          </div>
        </fieldset>
      )}
      <div className="ipam-form-row">
        <label className="ipam-form-label">Name *
          <input className="ipam-form-input" value={name} onChange={(e) => setName(e.target.value)} required placeholder="e.g. Office LAN" />
        </label>
        <label className="ipam-form-label">{scope === "external" ? "Public IP range" : "CIDR"} *
          <input className="ipam-form-input ipam-form-input--mono" value={cidr} onChange={(e) => setCidr(e.target.value)} required placeholder={scope === "external" ? "e.g. 1.1.1.8-1.1.1.14" : "e.g. 192.168.1.0/24"} />
          {scope === "external" && <small className="ipam-form-help">Accepts a start-end range or CIDR containing at least two usable addresses.</small>}
        </label>
        {scope === "internal" ? <>
          <label className="ipam-form-label">Gateway
            <input className="ipam-form-input ipam-form-input--mono" value={gateway} onChange={(e) => setGateway(e.target.value)} placeholder="e.g. 192.168.1.1" />
          </label>
          <label className="ipam-form-label">DHCP start
            <input className="ipam-form-input ipam-form-input--mono" value={dhcpStart} onChange={(e) => setDhcpStart(e.target.value)} placeholder="e.g. 192.168.1.50" />
          </label>
          <label className="ipam-form-label">DHCP end
            <input className="ipam-form-input ipam-form-input--mono" value={dhcpEnd} onChange={(e) => setDhcpEnd(e.target.value)} placeholder="e.g. 192.168.1.199" />
          </label>
          <label className="ipam-form-label">VLAN ID
            <input className="ipam-form-input" value={vlan} onChange={(e) => setVlan(e.target.value)} placeholder="e.g. 10" />
          </label>
        </> : <>
          <label className="ipam-form-label">Provider
            <input className="ipam-form-input" value={provider} onChange={(e) => setProvider(e.target.value)} placeholder="e.g. ISP or cloud provider" />
          </label>
          <label className="ipam-form-label">Account / circuit
            <input className="ipam-form-input" value={account} onChange={(e) => setAccount(e.target.value)} placeholder="Optional reference" />
          </label>
        </>}
      </div>
      <label className="ipam-form-label">Description
        <input className="ipam-form-input ipam-form-input--wide" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Optional" />
      </label>
      {showVlanSync && scope === "internal" && (
        <label className="ipam-vlan-sync-label">
          <input type="checkbox" checked={createVlanGroup} onChange={(e) => setCreateVlanGroup(e.target.checked)} />
          Also create a matching group in the VLANs tab
        </label>
      )}
      {error && <p className="form-error">{error}</p>}
      <div className="ipam-form-actions">
        <button type="submit" className="nm-btn nm-btn--primary" disabled={busy}>{busy ? "Saving…" : scope === "external" ? "Save external range" : "Save subnet"}</button>
        <button type="button" className="nm-btn" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}
