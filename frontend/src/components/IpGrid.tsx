import { useState } from "react";
import type { IpAddressEntry } from "../api/client";

const IP_KIND_COLOR: Record<string, string> = {
  network: "#94a3b8", broadcast: "#94a3b8", gateway: "#f59e0b",
  device: "#2dba7c", dhcp: "#3b80d0", reserved: "#115e59", free: "#e8edf3",
};
const IP_KIND_LABEL: Record<string, string> = {
  network: "Network", broadcast: "Broadcast", gateway: "Gateway",
  device: "Device", dhcp: "DHCP lease", reserved: "Reserved", free: "Free",
};
const IP_NO_TOOLTIP = new Set(["network", "broadcast"]);

export function IpGrid({ entries, onReserve, canWrite }: { entries: IpAddressEntry[]; onReserve?: (ip: string) => void; canWrite?: boolean }) {
  const [hovered, setHovered] = useState<IpAddressEntry | null>(null);
  const [pos, setPos] = useState({ x: 0, y: 0 });

  if (!entries.length) return <p className="dash-empty">Subnet too large to enumerate - showing summary only.</p>;

  const rowSize = entries.length <= 32 ? entries.length : 32;
  const rows: IpAddressEntry[][] = [];
  for (let i = 0; i < entries.length; i += rowSize) {
    rows.push(entries.slice(i, i + rowSize));
  }

  return (
    <div
      className="ipam-grid"
      onMouseMove={(e) => setPos({ x: e.clientX, y: e.clientY })}
      onMouseLeave={() => setHovered(null)}
    >
      {rows.map((row, rowIdx) => {
        const parts = row[0].ip.split(".");
        const label = "." + (parts[parts.length - 1] ?? "");
        return (
          <div key={rowIdx} className="ipam-grid-row">
            <span className="ipam-grid-row-label">{label}</span>
            <div className="ipam-grid-row-cells">
              {row.map((e) => (
                <span
                  key={e.ip}
                  className={`ipam-grid-cell${e.dhcp_range ? " ipam-grid-cell--dhcp-range" : ""}${!IP_NO_TOOLTIP.has(e.kind) ? " ipam-grid-cell--has-tip" : ""}${canWrite && e.kind === "free" ? " ipam-grid-cell--reservable" : ""}`}
                  style={{ background: IP_KIND_COLOR[e.kind] ?? "#e8edf3" }}
                  onMouseEnter={() => { if (!IP_NO_TOOLTIP.has(e.kind)) setHovered(e); }}
                  onMouseLeave={() => setHovered(null)}
                  onClick={() => { if (canWrite && e.kind === "free" && onReserve) onReserve(e.ip); }}
                />
              ))}
            </div>
          </div>
        );
      })}
      {hovered && (
        <IpTooltipCard entry={hovered} x={pos.x} y={pos.y} canWrite={canWrite} />
      )}
    </div>
  );
}

function IpTooltipCard({ entry, x, y, canWrite }: { entry: IpAddressEntry; x: number; y: number; canWrite?: boolean }) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const cardW = 220;
  const cardH = 130;
  const left = x + 14 + cardW > vw ? x - cardW - 8 : x + 14;
  const top = y + 14 + cardH > vh ? y - cardH - 8 : y + 14;

  return (
    <div className="ipam-tooltip-card" style={{ left, top }}>
      <div className="ipam-tooltip-header">
        <span className="ipam-tooltip-kind-dot" style={{ background: IP_KIND_COLOR[entry.kind] ?? "#94a3b8" }} />
        <span className="ipam-tooltip-ip">{entry.ip}</span>
        <span className="ipam-tooltip-kind">{IP_KIND_LABEL[entry.kind] ?? entry.kind}</span>
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
