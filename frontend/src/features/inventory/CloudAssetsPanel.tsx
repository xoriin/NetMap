import { Fragment, useMemo, useState } from "react";
import { Cloud, ChevronDown, ChevronRight, Globe2 } from "lucide-react";
import { IconServer } from "@tabler/icons-react";

import { api, type CloudProviderOption, type Device, type ExternalIpAssignment, type ExternalIpPool } from "../../api/client";
import { CloudProviderIcon } from "../../components/CloudProviderIcon";
import { DashStat } from "../../components/DashStat";
import { WorkspaceSkeleton } from "../../components/Skeleton";
import { SpaLink } from "../../components/SpaLink";
import { useApiQuery } from "../../hooks/useApiQuery";
import { navigateToIpamView } from "../ipam/ipamNavigation";

/** Sentinel keys for the buckets that have no real identity of their own. */
const NO_PROVIDER = "__no_provider__";
const UNLINKED = "__unlinked__";

function statusLabel(status: ExternalIpAssignment["status"]) {
  return status === "in_use" ? "In use" : status === "reserved" ? "Reserved" : "Available";
}

/** Maps to the pill variants defined in `styles/monitoring.css` — there is no
 *  `nm-status--healthy`, so `in_use` wears `online`. */
function statusVariant(status: ExternalIpAssignment["status"]) {
  return status === "in_use" ? "online" : status === "reserved" ? "paused" : "unknown";
}

/**
 * Cloud assets — inventory devices that hold public addresses.
 *
 * Rendered as an Inventory sub-view (Inventory → Cloud assets), mirroring how
 * Monitoring splits into Devices and Endpoints.
 *
 * A cloud asset *is* a device, so this is a device-centric view of external address
 * space rather than a second inventory. Devices arrive here through the "Add to
 * Inventory and Monitoring" toggle when tracking an address in IPAM, which is why the
 * page has no create action of its own.
 *
 * Styling note: this panel is a sibling of the Devices sub-view, so it wears
 * `.inventory-layout` and the shared `inventory-surface` / `inv-panel-*` chrome from
 * `inventory.css`. It must not reach for IPAM's `.external-ip-*` classes — `ipam.css`
 * is imported by `IpamWorkspace` alone and is simply absent here.
 */
export function CloudAssetsPanel({ accessToken, devices, onNavigate }: {
  accessToken: string;
  devices: Device[];
  onNavigate?: (route: "/ipam") => void;
}) {
  const query = useApiQuery(async () => {
    const [assignments, pools] = await Promise.all([
      api.listExternalIpAssignments(accessToken),
      api.listExternalIpPools(accessToken),
    ]);
    return { assignments, pools };
  }, [accessToken]);

  const assignments = useMemo(() => query.data?.assignments ?? [], [query.data]);
  const pools = useMemo(() => query.data?.pools ?? [], [query.data]);
  const poolById = useMemo(() => new Map<number, ExternalIpPool>(pools.map((pool) => [pool.id, pool])), [pools]);

  /**
   * Provider → device → address.
   *
   * Mirrors how IPAM lays out External IPs, so the same mental model carries across:
   * you pick the provider first, then drill into what is running there. A device's
   * provider comes from the allocation its addresses sit in — a device with addresses
   * from two providers therefore appears under each, which is correct: that is the
   * fact worth seeing.
   */
  const providerGroups = useMemo(() => {
    const deviceById = new Map(devices.map((device) => [device.id, device]));

    type DeviceRow = {
      key: string;
      name: string;
      deviceType: string | null;
      primaryIp: string | null;
      unlinked: boolean;
      addresses: ExternalIpAssignment[];
    };
    const groups = new Map<string, {
      key: string;
      name: string;
      provider: CloudProviderOption | null;
      devices: Map<string, DeviceRow>;
    }>();

    const ensureGroup = (provider: CloudProviderOption | null) => {
      const key = provider ? String(provider.id ?? provider.key) : NO_PROVIDER;
      let group = groups.get(key);
      if (!group) {
        group = { key, name: provider?.name ?? "No provider", provider, devices: new Map() };
        groups.set(key, group);
      }
      return group;
    };

    for (const assignment of assignments) {
      const pool = assignment.pool_id !== null ? poolById.get(assignment.pool_id) : undefined;
      const group = ensureGroup(pool?.provider ?? null);

      const deviceKey = assignment.device_id === null ? UNLINKED : `device-${assignment.device_id}`;
      let row = group.devices.get(deviceKey);
      if (!row) {
        const device = assignment.device_id === null ? null : deviceById.get(assignment.device_id) ?? null;
        const summary = assignment.device ?? null;
        row = {
          key: `${group.key}:${deviceKey}`,
          name: assignment.device_id === null
            ? "Not linked to a device"
            : device?.display_name || device?.hostname || summary?.display_name || summary?.hostname || summary?.ip_address || `Device ${assignment.device_id}`,
          deviceType: device?.device_type ?? summary?.device_type ?? null,
          primaryIp: device?.ip_address ?? summary?.ip_address ?? null,
          unlinked: assignment.device_id === null,
          addresses: [],
        };
        group.devices.set(deviceKey, row);
      }
      row.addresses.push(assignment);
    }

    return [...groups.values()]
      .map((group) => {
        const deviceRows = [...group.devices.values()].sort((a, b) => (
          a.unlinked ? 1 : b.unlinked ? -1 : a.name.localeCompare(b.name)
        ));
        const addresses = deviceRows.flatMap((row) => row.addresses);
        return {
          ...group,
          devices: deviceRows,
          deviceCount: deviceRows.filter((row) => !row.unlinked).length,
          addressCount: addresses.length,
          inUse: addresses.filter((row) => row.status === "in_use").length,
        };
      })
      .sort((a, b) => (a.key === NO_PROVIDER ? 1 : b.key === NO_PROVIDER ? -1 : a.name.localeCompare(b.name)));
  }, [assignments, devices, poolById]);

  /** Groups start open: a collapsed-by-default tree hides the only content the page has. */
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  function toggle(key: string) {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  if (query.isLoading) return <WorkspaceSkeleton />;
  if (query.error) {
    return (
      <section className="topology-layout inventory-layout cloud-assets-layout">
        <div className="inventory-surface nm-app-panel">
          <div className="cloud-empty cloud-empty--error">{query.error}</div>
        </div>
      </section>
    );
  }

  const deviceCount = providerGroups.reduce((sum, group) => sum + group.deviceCount, 0);
  const inUseCount = assignments.filter((row) => row.status !== "available").length;

  return (
    <section className="topology-layout inventory-layout cloud-assets-layout">
      <div className="dash-stats dash-stats--fill inventory-stats nm-summary-band">
        <DashStat label="Cloud devices" value={deviceCount} sub="holding public addresses" icon={<IconServer size={20} />} accent="teal" />
        <DashStat label="Public addresses" value={assignments.length} sub="tracked in IPAM" icon={<Cloud size={20} />} accent="blue" />
        <DashStat label="In use" value={inUseCount} sub="assigned or reserved" icon={<Globe2 size={20} />} accent="green" />
      </div>

      <div className="topology-content">
        <div className="inventory-surface nm-app-panel">
          <div className="inventory-panel-header nm-app-panel-header">
            <span className="inv-panel-title">
              <span className="inv-panel-title-icon" aria-hidden="true"><Cloud size={17} /></span>
              <span>Cloud assets</span>
              <span className="inv-panel-count">
                {providerGroups.length} provider{providerGroups.length === 1 ? "" : "s"} · {deviceCount} device{deviceCount === 1 ? "" : "s"} · {assignments.length} address{assignments.length === 1 ? "" : "es"}
              </span>
            </span>
            {onNavigate && (
              <SpaLink
                className="nm-btn nm-btn--sm nm-btn--secondary cloud-header-action"
                href="/ipam#external"
                onNavigate={() => {
                  // Route first, then stamp the hash: `navigateToRoute` pushes the bare
                  // path, so setting the view beforehand would land on the old pathname.
                  onNavigate("/ipam");
                  navigateToIpamView("external", true);
                }}
              >
                Manage in IPAM
              </SpaLink>
            )}
          </div>

          {providerGroups.length === 0 ? (
            <div className="cloud-empty">
              No devices hold public addresses yet. Track an external IP in IPAM and turn on
              <strong> Add to Inventory and Monitoring</strong> to bring its device here.
            </div>
          ) : (
            <div className="nm-table-wrap cloud-table-wrap">
              <table className="nm-table nm-table--selectable cloud-table">
                <colgroup>
                  <col className="cloud-col-identity" />
                  <col className="cloud-col-type" />
                  <col className="cloud-col-stat" />
                  <col className="cloud-col-stat" />
                  <col className="cloud-col-status" />
                </colgroup>
                <thead>
                  <tr>
                    <th>Provider / device / address</th>
                    <th>Type</th>
                    <th className="nm-table-num">Addresses</th>
                    <th className="nm-table-num">In use</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>{providerGroups.map((group) => {
                  const groupOpen = !collapsed.has(group.key);
                  return <Fragment key={group.key}>
                    <tr className="cloud-group-row" onClick={() => toggle(group.key)}>
                      <td>
                        <span className="cloud-identity">
                          <span className="cloud-chevron" aria-hidden="true">{groupOpen ? <ChevronDown size={15} /> : <ChevronRight size={15} />}</span>
                          <span className={`cloud-group-icon cloud-group-icon--${group.provider?.icon ?? "cloud"}`} aria-hidden="true">
                            <CloudProviderIcon icon={group.provider?.icon} iconData={group.provider?.icon_data} size={20} />
                          </span>
                          <span className="cloud-identity-text">
                            <strong>{group.name}</strong>
                            <small>{group.deviceCount} device{group.deviceCount === 1 ? "" : "s"} · {group.addressCount} address{group.addressCount === 1 ? "" : "es"}</small>
                          </span>
                        </span>
                      </td>
                      <td />
                      <td className="nm-table-num cloud-stat">{group.addressCount}</td>
                      <td className="nm-table-num cloud-stat">{group.inUse}</td>
                      <td />
                    </tr>

                    {groupOpen && group.devices.map((row, deviceIndex) => {
                      const deviceOpen = !collapsed.has(row.key);
                      const inUse = row.addresses.filter((item) => item.status === "in_use").length;
                      return <Fragment key={row.key}>
                        <tr
                          className={`cloud-device-row${deviceIndex % 2 === 1 ? " is-alt" : ""}${row.unlinked ? " cloud-device-row--unlinked" : ""}`}
                          onClick={() => toggle(row.key)}
                        >
                          <td>
                            <span className="cloud-identity">
                              <span className="cloud-chevron" aria-hidden="true">{deviceOpen ? <ChevronDown size={15} /> : <ChevronRight size={15} />}</span>
                              <span className="cloud-device-icon" aria-hidden="true"><IconServer size={17} /></span>
                              <span className="cloud-identity-text">
                                <strong>{row.name}</strong>
                                <small>{row.primaryIp ?? `${row.addresses.length} public address${row.addresses.length === 1 ? "" : "es"}`}</small>
                              </span>
                            </span>
                          </td>
                          <td><span className="cloud-type">{row.deviceType ?? "—"}</span></td>
                          <td className="nm-table-num cloud-stat">{row.addresses.length}</td>
                          <td className="nm-table-num cloud-stat">{inUse}</td>
                          <td />
                        </tr>

                        {deviceOpen && row.addresses.map((assignment, index) => (
                          <tr key={assignment.id} className={`cloud-address-row${index % 2 === 1 ? " is-alt" : ""}`}>
                            <td>
                              <span className="cloud-identity-text">
                                <code className="nm-table-mono">{assignment.ip_address}</code>
                                <small>{assignment.label || "Untitled address"}</small>
                              </span>
                            </td>
                            <td><span className="cloud-type">{assignment.pool_id !== null ? poolById.get(assignment.pool_id)?.name ?? "—" : "—"}</span></td>
                            <td className="nm-table-num" />
                            <td className="nm-table-num" />
                            <td><span className={`nm-status nm-status--${statusVariant(assignment.status)}`}>{statusLabel(assignment.status)}</span></td>
                          </tr>
                        ))}
                      </Fragment>;
                    })}
                  </Fragment>;
                })}</tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
