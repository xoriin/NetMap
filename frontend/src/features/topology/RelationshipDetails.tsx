import { ArrowLeft, ArrowRight, Check, Gauge, Link2, Network, X } from "lucide-react";
import { type Device, type Relationship } from "../../api/client";
import { parseRelationshipVisualEndpoints, stripRelationshipMetadata, relationshipEndpointLabel } from "../../utils/relationship";
import { formatLinkSpeed } from "./RelationshipForm";

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
  const sourceIsGroup = visualEndpoints?.source?.startsWith("group:") ?? false;
  const targetIsGroup = visualEndpoints?.target?.startsWith("group:") ?? false;
  const speedLabel = formatLinkSpeed(relationship.link_speed_mbps ?? null);
  const notes = stripRelationshipMetadata(relationship.notes);
  return (
    <div className="relationship-detail">
      <div className="details-heading relationship-detail__heading">
        <span className="relationship-detail__heading-icon" aria-hidden="true"><Link2 size={17} /></span>
        <div className="details-heading-body">
          <h3>Link details</h3>
          <p>{relationship.relationship_type || "Network link"}</p>
        </div>
        {speedLabel && <span className="relationship-detail__speed-pill">{speedLabel}</span>}
      </div>
      <div className="relationship-detail__content">
        <section className="relationship-route" aria-label="Link endpoints">
          <div className="relationship-endpoint">
            <span className="relationship-endpoint__icon" aria-hidden="true">
              {sourceIsGroup ? <Network size={17} /> : <Link2 size={17} />}
            </span>
            <span className="relationship-endpoint__copy">
              <small>Source</small>
              <strong>{sourceLabel}</strong>
              {!sourceIsGroup && source?.ip_address && sourceLabel !== source.ip_address && <span>{source.ip_address}</span>}
            </span>
          </div>
          <div className="relationship-route__connector" aria-hidden="true">
            <span />
            <ArrowRight size={14} />
          </div>
          <div className="relationship-endpoint">
            <span className="relationship-endpoint__icon" aria-hidden="true">
              {targetIsGroup ? <Network size={17} /> : <Link2 size={17} />}
            </span>
            <span className="relationship-endpoint__copy">
              <small>Target</small>
              <strong>{targetLabel}</strong>
              {!targetIsGroup && target?.ip_address && targetLabel !== target.ip_address && <span>{target.ip_address}</span>}
            </span>
          </div>
        </section>

        <div className="relationship-summary-grid">
          <div className="relationship-summary-card">
            <Link2 size={14} aria-hidden="true" />
            <span><small>Link type</small><strong>{relationship.relationship_type || "Link"}</strong></span>
          </div>
          <div className="relationship-summary-card">
            <Gauge size={14} aria-hidden="true" />
            <span><small>Capacity</small><strong>{speedLabel || "Not specified"}</strong></span>
          </div>
        </div>

        <section className="relationship-detail__section">
          <h4>Traffic directions</h4>
          <div className="relationship-direction-row">
            <span className="relationship-direction-row__identity"><ArrowRight size={14} />Source to target</span>
            <span className={`relationship-state-pill ${relationship.allow_outbound !== false ? "is-allowed" : "is-blocked"}`}>
              {relationship.allow_outbound !== false ? <Check size={12} /> : <X size={12} />}
              {relationship.allow_outbound !== false ? "Allowed" : "Blocked"}
            </span>
          </div>
          <div className="relationship-direction-row">
            <span className="relationship-direction-row__identity"><ArrowLeft size={14} />Target to source</span>
            <span className={`relationship-state-pill ${relationship.allow_inbound !== false ? "is-allowed" : "is-blocked"}`}>
              {relationship.allow_inbound !== false ? <Check size={12} /> : <X size={12} />}
              {relationship.allow_inbound !== false ? "Allowed" : "Blocked"}
            </span>
          </div>
        </section>

        <section className="relationship-detail__section relationship-detail__notes">
          <h4>Notes</h4>
          <p>{notes || "No notes have been added to this link."}</p>
        </section>
      </div>
      {canWrite && (
        <div className="detail-actions relationship-detail__actions">
          <button type="button" className="nm-btn nm-btn--sm nm-btn--secondary" disabled={disabled} onClick={onEdit}>Edit link</button>
          <button type="button" className="nm-btn nm-btn--sm nm-btn--danger" disabled={disabled} onClick={onDelete}>Delete link</button>
        </div>
      )}
    </div>
  );
}
