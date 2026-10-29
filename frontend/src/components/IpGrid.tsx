import { useState, type CSSProperties } from "react";
import type { IpAddressEntry } from "../api/client";
import { StackBar } from "./Charts";

const IP_KIND_LABEL: Record<string, string> = {
  network: "Network", broadcast: "Broadcast", gateway: "Gateway",
  device: "Device", dhcp: "DHCP lease", reserved: "Reserved", free: "Free",
};

const MAP_KEYS: [string, string][] = [
  ["device", "Device"], ["dhcp", "DHCP lease"], ["dhcp-pool", "DHCP pool (free)"], ["reserved", "Reserved"],
  ["gateway", "Gateway"], ["free", "Free"], ["network", "Network / broadcast"],
];

function mapKind(entry: IpAddressEntry) {
  if (entry.kind === "free" && entry.dhcp_range) return "dhcp-pool";
  return entry.kind;
}

function displayKind(entry: IpAddressEntry) {
  if (entry.kind === "free" && entry.dhcp_range) return "DHCP pool";
  return IP_KIND_LABEL[entry.kind] ?? entry.kind;
}

function addressOctet(ip: string) {
  const parts = ip.split(".");
  return parts[parts.length - 1] ?? ip;
}

export function AddressUsage({ entries }: { entries: IpAddressEntry[] }) {
  const count = (kind: IpAddressEntry["kind"]) => entries.filter((entry) => entry.kind === kind).length;
  return (
    <div className="ipam-usage">
      <StackBar viewId="ipam.subnet-address-usage" label="Address usage" of="of this subnet" items={[
        { label: "Device", value: count("device"), color: "var(--ipam-device)" },
        { label: "DHCP lease", value: count("dhcp"), color: "var(--ipam-dhcp)" },
        { label: "Reserved", value: count("reserved"), color: "var(--ipam-reserved)" },
        { label: "Gateway", value: count("gateway"), color: "var(--ipam-gateway)" },
        { label: "Free", value: count("free"), color: "var(--nm-track-bg)" },
      ]} />
    </div>
  );
}

export function IpGrid({ entries, onReserve, canWrite }: { entries: IpAddressEntry[]; onReserve?: (ip: string) => void; canWrite?: boolean }) {
  const [selectedIp, setSelectedIp] = useState<string | null>(null);
  const [hovered, setHovered] = useState<{ entry: IpAddressEntry; anchor: DOMRect } | null>(null);

  if (!entries.length) return <p className="dash-empty">Subnet too large to enumerate - showing summary only.</p>;

  const selected = entries.find((entry) => entry.ip === selectedIp) ?? null;
  const rowSize = Math.min(16, entries.length);
  const rows: IpAddressEntry[][] = [];
  for (let i = 0; i < entries.length; i += rowSize) rows.push(entries.slice(i, i + rowSize));
  const columns = { "--ipam-map-cols": rowSize } as CSSProperties;

  return (
    <div className="ipam-ip-map" style={columns}>
      <div className="ipam-map-wrap">
        <div className="ipam-map">
          <div className="ipam-map-head" aria-hidden="true">
            <span />
            {rows[0].map((_, index) => <span key={index}>{index}</span>)}
          </div>
          {rows.map((row) => (
            <div key={row[0].ip} className="ipam-map-row">
              <span className="ipam-map-label">.{addressOctet(row[0].ip)}</span>
              {row.map((entry) => (
                <button
                  key={entry.ip}
                  type="button"
                  aria-label={`${entry.ip} · ${displayKind(entry)}`}
                  aria-pressed={selected?.ip === entry.ip}
                  className={`ipam-tile ipam-tile--${mapKind(entry)}${selected?.ip === entry.ip ? " is-selected" : ""}`}
                  onClick={() => setSelectedIp(entry.ip)}
                  onMouseEnter={(event) => setHovered({ entry, anchor: event.currentTarget.getBoundingClientRect() })}
                  onFocus={(event) => setHovered({ entry, anchor: event.currentTarget.getBoundingClientRect() })}
                  onMouseLeave={() => setHovered(null)}
                  onBlur={() => setHovered(null)}
                >
                  <span className="ipam-tile-num" aria-hidden="true">{addressOctet(entry.ip)}</span>
                </button>
              ))}
            </div>
          ))}
        </div>
        <div className="ipam-map-keys">
          {MAP_KEYS.map(([kind, label]) => (
            <span key={kind} className="ipam-map-key"><i className={`ipam-tile ipam-tile--${kind}`} />{label}</span>
          ))}
        </div>
      </div>
      <AddressDetail entry={selected} canWrite={canWrite} onReserve={onReserve} />
      {hovered && <AddressTooltip entry={hovered.entry} anchor={hovered.anchor} />}
    </div>
  );
}

function AddressTooltip({ entry, anchor }: { entry: IpAddressEntry; anchor: DOMRect }) {
  const width = 220;
  const left = Math.min(Math.max(8, anchor.left + anchor.width / 2 - width / 2), window.innerWidth - width - 8);
  const above = anchor.top > 140;
  const name = entry.display_name || entry.label;
  return (
    <div className={`hb-tooltip-card hb-tooltip-card--${above ? "above" : "below"} ipam-tile-tooltip`} aria-hidden="true" style={{ left, top: above ? anchor.top - 8 : anchor.bottom + 8 }}>
      <div className="hb-tooltip-header">
        <span className="hb-tooltip-date">{entry.ip}</span>
        <span className="hb-tooltip-time">{displayKind(entry)}</span>
      </div>
      {name && <div className="ipam-tile-tooltip-line">{name}</div>}
      {(entry.mac_address || entry.vendor) && (
        <div className="ipam-tile-tooltip-line dash-panel-meta">{[entry.vendor, entry.mac_address].filter(Boolean).join(" · ")}</div>
      )}
      {!name && !entry.mac_address && !entry.vendor && (
        <div className="ipam-tile-tooltip-line dash-panel-meta">{entry.kind === "free" ? "Available" : "No details recorded"}</div>
      )}
    </div>
  );
}

function AddressDetail({ entry, canWrite, onReserve }: { entry: IpAddressEntry | null; canWrite?: boolean; onReserve?: (ip: string) => void }) {
  if (!entry) {
    return (
      <aside className="ipam-address-detail nm-app-panel" aria-live="polite">
        <p className="ipam-address-detail-empty">Select an address to see its details{canWrite ? " or reserve it" : ""}.</p>
      </aside>
    );
  }
  const name = entry.display_name || entry.label;
  return (
    <aside className="ipam-address-detail nm-app-panel" aria-live="polite">
      <div className="nm-app-panel-header">
        <strong className="ipam-address-detail-ip">{entry.ip}</strong>
        <span className="ipam-address-detail-kind"><i className={`ipam-tile ipam-tile--${mapKind(entry)}`} />{displayKind(entry)}</span>
      </div>
      <dl className="ipam-address-detail-list">
        <dt>Status</dt><dd>{entry.kind === "free" ? "Available" : displayKind(entry)}</dd>
        {name && <><dt>Name</dt><dd>{name}</dd></>}
        {entry.mac_address && <><dt>MAC</dt><dd className="ipam-address-detail-mono">{entry.mac_address}</dd></>}
        {entry.vendor && <><dt>Vendor</dt><dd>{entry.vendor}</dd></>}
        {entry.dhcp_range && <><dt>Range</dt><dd>DHCP assignment pool</dd></>}
      </dl>
      {canWrite && entry.kind === "free" && onReserve && (
        <div className="ipam-address-detail-actions">
          <button type="button" className="nm-btn nm-btn--sm nm-btn--secondary" onClick={() => onReserve(entry.ip)}>Reserve this address</button>
        </div>
      )}
    </aside>
  );
}
