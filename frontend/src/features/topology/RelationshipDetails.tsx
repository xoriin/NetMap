import { IconNote } from "@tabler/icons-react";
import { type Device, type Relationship } from "../../api/client";
import { parseRelationshipVisualEndpoints, stripRelationshipMetadata, relationshipEndpointLabel } from "../../utils/relationship";

export function RelationshipDetails({
  canWrite,
  devices,
  disabled,
  relationship,
  onDelete,
  onEdit,
}: {
  canWrite: boolean;
  devices: Device[];
  disabled: boolean;
  relationship: Relationship;
  onDelete: () => void;
  onEdit: () => void;
}) {
  const source = devices.find((device) => device.id === relationship.source_device_id);
  const target = devices.find((device) => device.id === relationship.target_device_id);
  const visualEndpoints = parseRelationshipVisualEndpoints(relationship.notes);
  const sourceLabel = relationshipEndpointLabel(visualEndpoints?.source, devices, source, relationship.source_device_id);
  const targetLabel = relationshipEndpointLabel(visualEndpoints?.target, devices, target, relationship.target_device_id);
  return (
    <div>
      <div className="details-heading">
        <div className="details-heading-body">
          <h3>{relationship.relationship_type || "Link"}</h3>
        </div>
      </div>
      <dl>
        <dt>Source</dt>
        <dd>{sourceLabel}</dd>
        <dt>Target</dt>
        <dd>{targetLabel}</dd>
        <dt>Source → Target</dt>
        <dd>{relationship.allow_outbound !== false ? "Allowed" : "Blocked"}</dd>
        <dt>Target → Source</dt>
        <dd>{relationship.allow_inbound !== false ? "Allowed" : "Blocked"}</dd>
        <dt><span className="details-field-icon"><IconNote size={12} /></span>Notes</dt>
        <dd>{stripRelationshipMetadata(relationship.notes) || "—"}</dd>
      </dl>
      {canWrite && (
        <div className="detail-actions detail-actions--device">
          <button type="button" className="nm-btn nm-btn--sm" disabled={disabled} onClick={onEdit}>Edit link</button>
          <button type="button" className="nm-btn nm-btn--sm nm-btn--danger" disabled={disabled} onClick={onDelete}>Delete link</button>
        </div>
      )}
    </div>
  );
}
