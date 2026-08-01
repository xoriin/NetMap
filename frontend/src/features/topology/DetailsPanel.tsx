import type {
  Device, DevicePayload, DeviceLiveStatus, DeviceSecurityEventSummary,
  DeviceTypeOption, Relationship, Site, SnmpProfile, TopologyGroup,
} from "../../api/client";
import { DeviceDetails } from "../devices/DeviceDetails";
import { RelationshipDetails } from "./RelationshipDetails";

/**
 * Right-hand details panel for the selected device or link. Renders nothing
 * when there is no selection; the orchestrator owns selection state and all
 * mutations.
 */
export function DetailsPanel({
  accessToken,
  canViewSecurity,
  canWrite,
  selectedDevice,
  selectedRelationship,
  allDevices,
  busy,
  deviceTypes,
  groups,
  snmpProfiles,
  sites,
  liveStatus,
  securityLoading,
  securitySummary,
  onGraphChange,
  onDeleteDevice,
  onCloneDevice,
  onSubmitDevice,
  onDeleteRelationship,
  onEditRelationship,
}: {
  accessToken: string | null;
  canViewSecurity: boolean;
  canWrite: boolean;
  selectedDevice: Device | null;
  selectedRelationship: Relationship | null;
  allDevices: Device[];
  busy: boolean;
  deviceTypes?: DeviceTypeOption[];
  groups: TopologyGroup[];
  snmpProfiles: SnmpProfile[];
  sites: Site[];
  liveStatus: DeviceLiveStatus | null;
  securityLoading: boolean;
  securitySummary: DeviceSecurityEventSummary | null;
  onGraphChange: () => Promise<void>;
  onDeleteDevice: () => Promise<void>;
  onCloneDevice: (device: Device) => void;
  onSubmitDevice: (payload: DevicePayload) => Promise<void>;
  onDeleteRelationship: () => void;
  onEditRelationship: () => void;
}) {
  if (!selectedDevice && !selectedRelationship) return null;
  return (
    <aside className="details-panel topology-details-panel">
      {selectedDevice ? (
        <DeviceDetails
          canViewSecurity={canViewSecurity}
          canWrite={canWrite}
          accessToken={accessToken || ""}
          device={selectedDevice}
          deviceTypes={deviceTypes}
          disabled={busy}
          groups={groups}
          snmpProfiles={snmpProfiles}
          sites={sites}
          onGraphChange={onGraphChange}
          liveStatus={liveStatus}
          onDelete={onDeleteDevice}
          onClone={() => onCloneDevice(selectedDevice)}
          onSubmit={onSubmitDevice}
          securityLoading={securityLoading}
          securitySummary={securitySummary}
        />
      ) : selectedRelationship ? (
        <RelationshipDetails
          canWrite={canWrite}
          devices={allDevices}
          disabled={busy}
          relationship={selectedRelationship}
          onDelete={onDeleteRelationship}
          onEdit={onEditRelationship}
        />
      ) : null}
    </aside>
  );
}
