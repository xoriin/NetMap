import { useState } from "react";
import type { IpAddressEntry } from "../api/client";

const IP_KIND_LABEL: Record<string, string> = {
  network: "Network", broadcast: "Broadcast", gateway: "Gateway",
  device: "Device", dhcp: "DHCP lease", reserved: "Reserved", free: "Free",
};

function mapKind(entry: IpAddressEntry) {
  if (entry.kind === "free" && entry.dhcp_range) return "dhcp-pool";
  return entry.kind;
}

function displayKind(entry: IpAddressEntry) {
  if (entry.kind === "free" && entry.dhcp_range) return "DHCP pool";
  return IP_KIND_LABEL[entry.kind] ?? entry.kind;
}

function addressOctet(entry: IpAddressEntry) {
  const parts = entry.ip.split(".");
  return parts[parts.length - 1] ?? entry.ip;
}

export function IpGrid({ entries, onReserve, canWrite }: { entries: IpAddressEntry[]; onReserve?: (ip: string) => void; canWrite?: boolean }) {
  const [inspectedIp, setInspectedIp] = useState<string | null>(null);
  const [pointerPosition, setPointerPosition] = useState({ x: 0, y: 0 });

  if (!entries.length) return <p className="dash-empty">Subnet too large to enumerate - showing summary only.</p>;

  const inspected = entries.find((entry) => entry.ip === inspectedIp) ?? null;

  const rowSize = entries.length <= 32 ? entries.length : 32;
  const rows: IpAddressEntry[][] = [];
  for (let i = 0; i < entries.length; i += rowSize) {
    rows.push(entries.slice(i, i + rowSize));
  }

  return (
    <div
      className="ipam-grid"
      onMouseMove={(event) => setPointerPosition({ x: event.clientX, y: event.clientY })}
      onMouseLeave={() => setInspectedIp(null)}
    >
      <div className="ipam-grid-map-label">
        <span>All {entries.length} positions</span>
        <small>{rows.length} row{rows.length === 1 ? "" : "s"} · up to 32 addresses per row · hover for details</small>
      </div>
      <div className="ipam-grid-map">
          {rows.map((row, rowIdx) => {
            const firstParts = row[0].ip.split(".");
            const lastParts = row[row.length - 1].ip.split(".");
            const firstOctet = firstParts[firstParts.length - 1] ?? "";
            const lastOctet = lastParts[lastParts.length - 1] ?? firstOctet;
            return (
              <div key={rowIdx} className="ipam-grid-row">
                <span className="ipam-grid-row-label">{firstOctet}–{lastOctet}</span>
                <div className="ipam-grid-row-cells">
                  {row.map((entry) => (
                    <button
                      key={entry.ip}
                      type="button"
                      aria-label={`${entry.ip} · ${displayKind(entry)}`}
                      aria-pressed={inspected?.ip === entry.ip}
                      className={`ipam-grid-cell ipam-grid-cell--${mapKind(entry)}${entry.dhcp_range ? " ipam-grid-cell--dhcp-range" : ""}${canWrite && entry.kind === "free" ? " ipam-grid-cell--reservable" : ""}${inspected?.ip === entry.ip ? " is-inspected" : ""}`}
                      onMouseEnter={() => setInspectedIp(entry.ip)}
                      onFocus={(event) => {
                        const rect = event.currentTarget.getBoundingClientRect();
                        setPointerPosition({ x: rect.right, y: rect.top + rect.height / 2 });
                        setInspectedIp(entry.ip);
                      }}
                      onClick={() => { if (canWrite && entry.kind === "free" && onReserve) onReserve(entry.ip); }}
                    >
                      <span className="ipam-grid-cell-label">{addressOctet(entry)}</span>
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
      </div>
      {inspected && <IpDetailCard entry={inspected} canWrite={canWrite} x={pointerPosition.x} y={pointerPosition.y} />}
    </div>
  );
}

function IpDetailCard({ entry, canWrite, x, y }: { entry: IpAddressEntry; canWrite?: boolean; x: number; y: number }) {
  const cardWidth = 270;
  // Four metadata rows (DHCP range, name, MAC and vendor) are possible. Use
  // the maximum expected card height for edge avoidance while allowing the
  // actual card to size naturally to shorter content.
  const cardHeightAllowance = 190;
  const preferredLeft = x + 14 + cardWidth > window.innerWidth ? x - cardWidth - 10 : x + 14;
  const preferredTop = y + 14 + cardHeightAllowance > window.innerHeight
    ? y - cardHeightAllowance - 10
    : y + 14;
  const left = Math.max(10, Math.min(preferredLeft, window.innerWidth - cardWidth - 10));
  const top = Math.max(10, preferredTop);
  return (
    <div className="ipam-tooltip-card ipam-grid-detail-card" style={{ left, top }} aria-live="polite">
      <div className="ipam-tooltip-header">
        <span className={`ipam-tooltip-kind-dot ipam-tooltip-kind-dot--${mapKind(entry)}`} />
        <span className="ipam-tooltip-ip">{entry.ip}</span>
        <span className="ipam-tooltip-kind">{displayKind(entry)}</span>
      </div>
      {entry.kind === "free" ? (
        <>
          <div className="ipam-tooltip-row ipam-tooltip-row--available">
            <span>Status</span><span>Available{canWrite ? " - click to reserve" : ""}</span>
          </div>
          {entry.dhcp_range && (
            <div className="ipam-tooltip-row">
              <span>Range</span><span>DHCP assignment pool</span>
            </div>
          )}
        </>
      ) : (
        <>
          {entry.dhcp_range && (
            <div className="ipam-tooltip-row">
              <span>Range</span><span>DHCP assignment pool</span>
            </div>
          )}
          {(entry.display_name || entry.label) && (
            <div className="ipam-tooltip-row">
              <span>Name</span><span>{entry.display_name || entry.label}</span>
            </div>
          )}
          {entry.mac_address && (
            <div className="ipam-tooltip-row">
              <span>MAC</span><span className="ipam-tooltip-mono">{entry.mac_address}</span>
            </div>
          )}
          {entry.vendor && (
            <div className="ipam-tooltip-row">
              <span>Vendor</span><span>{entry.vendor}</span>
            </div>
          )}
        </>
      )}
    </div>
  );
}
