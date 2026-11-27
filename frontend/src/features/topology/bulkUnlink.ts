import type { Relationship, RelationshipPayload } from "../../api/client";

export type UnlinkScope = "between" | "touching";

export function linksForSelection(relationships: Relationship[], deviceIds: number[], scope: UnlinkScope): Relationship[] {
  const selected = new Set(deviceIds);
  return relationships.filter((r) => {
    const source = selected.has(r.source_device_id);
    const target = selected.has(r.target_device_id);
    return scope === "between" ? source && target : source || target;
  });
}

export function restorePayload(relationship: Relationship): RelationshipPayload {
  return {
    source_device_id: relationship.source_device_id,
    target_device_id: relationship.target_device_id,
    relationship_type: relationship.relationship_type,
    allow_outbound: relationship.allow_outbound,
    allow_inbound: relationship.allow_inbound,
    notes: relationship.notes ?? null,
    link_speed_mbps: relationship.link_speed_mbps ?? null,
  };
}
