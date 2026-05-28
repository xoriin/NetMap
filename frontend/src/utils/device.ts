import type { Device, DevicePayload, DeviceIcon } from "../api/client";
import { deviceTypeIconMap } from "../icons";

export function buildDevicePayload(device: Device, overrides: Partial<DevicePayload> = {}): DevicePayload {
  const base: DevicePayload = {
    display_name: device.display_name,
    hostname: device.hostname,
    ip_address: device.ip_address ?? "",
    mac_address: device.mac_address,
    vendor: device.vendor,
    device_type: device.device_type,
    status: device.status,
    icon: (deviceTypeIconMap[device.device_type ?? ""] || device.icon || "device") as DeviceIcon,
    color: device.color,
    vlan_id: device.vlan_id,
    subnet: device.subnet,
    topology_group_id: device.topology_group_id,
    topology_group: null,
    site_id: device.site_id,
    snmp_profile_id: device.snmp_profile_id,
    tags: device.tags,
    notes: device.notes,
  };
  return { ...base, ...overrides };
}
