/**
 * Expected-vs-observed device health — the single frontend source of truth.
 *
 * A device carries an `expected_status`, so "offline" is not automatically a
 * problem: a device that is *expected* to be offline and is offline is healthy.
 * The backend models this in `app/services/monitoring/health.py`
 * (`observed_health`) and returns the resolved value as `health_status` on
 * `/monitoring/devices`. Anything computing state from a raw `Device` must go
 * through here instead, or the same device reads green on one page and red on
 * another (GitHub #29).
 *
 * Note the two CSS vocabularies: `mon-dot-*` / `mon-hero-header--*` speak
 * healthy/unhealthy/paused, while `dash-status-dot--*` / `nm-status--*` /
 * `status-dot--*` speak the values returned here.
 */

import type { Device } from "../api/client";
import { isDeviceMonitoringPaused } from "./device";

export type DeviceHealth = "online" | "offline" | "warning" | "unknown" | "paused" | "disabled";

type HealthInput = Pick<
  Device,
  "status" | "monitor_status" | "expected_status" | "lifecycle" | "monitoring_paused"
>;

export type DeviceHealthOptions = {
  /**
   * Observed reachability to judge, when the caller has a fresher reading than
   * the device row (Inventory's live ping poll). Defaults to
   * `monitor_status ?? status`.
   */
  observed?: string | null;
  /**
   * Force the paused state — Inventory also treats "live ping switched off" as
   * paused, since nothing is probing the device.
   */
  paused?: boolean;
};

export function deviceHealth(device: HealthInput, options: DeviceHealthOptions = {}): DeviceHealth {
  if (device.status === "disabled") return "disabled";
  const paused = options.paused ?? isDeviceMonitoringPaused(device);
  if (paused) return "paused";

  const observed = options.observed ?? device.monitor_status ?? device.status;
  if (observed === "warning") return "warning";
  if (observed !== "online" && observed !== "offline") return "unknown";
  return observed === (device.expected_status ?? "online") ? "online" : "offline";
}

/**
 * Human-readable state. A device that is deliberately offline says so — it is
 * healthy/green, and "online" would read as a lie next to a genuinely
 * reachable device. Everything else uses the plain status word.
 */
export function deviceHealthLabel(device: HealthInput, options: DeviceHealthOptions = {}): string {
  const health = deviceHealth(device, options);
  if (health === "online" && device.expected_status === "offline") return "expected offline";
  if (health === "offline") return options.observed ?? device.monitor_status ?? device.status;
  return health;
}
