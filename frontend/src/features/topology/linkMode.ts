import type { Device, Relationship, RelationshipPayload } from "../../api/client";
import { deviceLabel } from "../../utils/format";
import { groupRepresentativeDeviceId } from "../../utils/sort";
import { composeRelationshipNotes } from "../../utils/relationship";

export type LinkEndpoint = { endpoint: string; deviceId: number; label: string };

export const QUICK_LINK_SPEEDS: { label: string; value: number | null }[] = [
  { label: "—", value: null },
  { label: "100M", value: 100 },
  { label: "1G", value: 1000 },
  { label: "2.5G", value: 2500 },
  { label: "10G", value: 10_000 },
  { label: "25G", value: 25_000 },
];

export function resolveLinkEndpoint(endpoint: string, devices: Device[]): LinkEndpoint | null {
  if (endpoint.startsWith("device:")) {
    const deviceId = Number(endpoint.slice("device:".length));
    const device = devices.find((d) => d.id === deviceId);
    return device ? { endpoint, deviceId, label: deviceLabel(device) } : null;
  }
  if (endpoint.startsWith("group:")) {
    const groupName = endpoint.slice("group:".length);
    const deviceId = groupRepresentativeDeviceId(devices, groupName);
    return deviceId !== null ? { endpoint, deviceId, label: groupName } : null;
  }
  return null;
}

export function findExistingLink(relationships: Relationship[], aDeviceId: number, bDeviceId: number): Relationship | undefined {
  return relationships.find(
    (r) =>
      (r.source_device_id === aDeviceId && r.target_device_id === bDeviceId) ||
      (r.source_device_id === bDeviceId && r.target_device_id === aDeviceId),
  );
}

export function quickLinkPayload(source: LinkEndpoint, target: LinkEndpoint, speedMbps: number | null): RelationshipPayload {
  return {
    source_device_id: source.deviceId,
    target_device_id: target.deviceId,
    relationship_type: "link",
    allow_outbound: true,
    allow_inbound: true,
    notes: composeRelationshipNotes(source.endpoint, target.endpoint, null),
    link_speed_mbps: speedMbps,
  };
}
