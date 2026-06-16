import { useState, type FormEvent } from "react";
import { type SubnetPayload } from "../../api/client";

export function SubnetForm({
  initial, onSave, onCancel, busy, error, showVlanSync = false,
}: {
  initial?: Partial<SubnetPayload>;
  onSave: (p: SubnetPayload, createVlanGroup: boolean) => void;
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

  function submit(e: FormEvent) {
    e.preventDefault();
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
      <div className="ipam-form-row">
        <label className="ipam-form-label">Name *
          <input className="ipam-form-input" value={name} onChange={(e) => setName(e.target.value)} required placeholder="e.g. Office LAN" />
        </label>
        <label className="ipam-form-label">CIDR *
          <input className="ipam-form-input ipam-form-input--mono" value={cidr} onChange={(e) => setCidr(e.target.value)} required placeholder="e.g. 192.168.1.0/24" />
        </label>
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
      </div>
      <label className="ipam-form-label">Description
        <input className="ipam-form-input ipam-form-input--wide" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Optional" />
      </label>
      {showVlanSync && (
        <label className="ipam-vlan-sync-label">
          <input type="checkbox" checked={createVlanGroup} onChange={(e) => setCreateVlanGroup(e.target.checked)} />
          Also create a matching group in the VLANs tab
        </label>
      )}
      {error && <p className="form-error">{error}</p>}
      <div className="ipam-form-actions">
        <button type="submit" className="nm-btn nm-btn--primary" disabled={busy}>{busy ? "Saving…" : "Save subnet"}</button>
        <button type="button" className="nm-btn" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}
