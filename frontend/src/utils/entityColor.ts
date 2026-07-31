/**
 * Colour resolution for VLAN/group and location chips.
 *
 * A group or site may carry an explicit `color`. When it does not, we derive a
 * stable colour from its name so the inventory table is colourful out of the
 * box and a given group keeps the same colour across reloads and browsers.
 */

/** Hues spaced around the wheel; readable as a tinted chip in both themes. */
export const ENTITY_COLOR_PALETTE = [
  "#3b82f6", // blue
  "#8b5cf6", // violet
  "#ec4899", // pink
  "#ef4444", // red
  "#f97316", // orange
  "#eab308", // amber
  "#22c55e", // green
  "#14b8a6", // teal
  "#06b6d4", // cyan
  "#6366f1", // indigo
  "#a855f7", // purple
  "#84cc16", // lime
] as const;

const HEX_RE = /^#[0-9A-Fa-f]{6}$/;

/** FNV-1a — small, dependency-free, and stable across runtimes. */
function hashName(name: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < name.length; i += 1) {
    hash ^= name.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** The palette colour a name falls back to when no colour is configured. */
export function autoEntityColor(name: string | null | undefined): string {
  const key = (name ?? "").trim().toLowerCase();
  if (!key) return ENTITY_COLOR_PALETTE[0];
  return ENTITY_COLOR_PALETTE[hashName(key) % ENTITY_COLOR_PALETTE.length];
}

/** Explicit colour when set and valid, otherwise the derived palette colour. */
export function resolveEntityColor(
  color: string | null | undefined,
  name: string | null | undefined,
): string {
  const explicit = (color ?? "").trim();
  if (HEX_RE.test(explicit)) return explicit;
  return autoEntityColor(name);
}

export function isValidHexColor(value: string | null | undefined): boolean {
  return HEX_RE.test((value ?? "").trim());
}

/** What `EntityChip` needs to render one group or location value. */
export type ChipSource = {
  label: string;
  color: string | null;
  /** Canonical name the fallback colour is derived from. */
  key: string;
};

type GroupLike = { id: number; name: string; display_name: string | null; color: string | null };
type SiteLike = { id: number; name: string; display_name: string | null; color: string | null };
type DeviceLike = { topology_group_id: number | null; topology_group: string | null; site_id: number | null };

/**
 * A device's VLAN/group chip. Devices can carry an *inferred* group name with
 * no `topology_group_id`, so fall back to matching the name before giving up.
 */
export function groupChipFor(device: DeviceLike, groups: GroupLike[]): ChipSource | null {
  const assigned = device.topology_group_id != null
    ? groups.find((group) => group.id === device.topology_group_id)
    : undefined;
  if (assigned) {
    return { label: assigned.display_name || assigned.name, color: assigned.color, key: assigned.name };
  }
  const inferred = (device.topology_group ?? "").trim();
  if (!inferred) return null;
  const matched = groups.find(
    (group) => group.name === inferred || group.display_name === inferred,
  );
  if (matched) {
    return { label: matched.display_name || matched.name, color: matched.color, key: matched.name };
  }
  return { label: inferred, color: null, key: inferred };
}

type DeviceTypeLike = { value: string; label: string; color: string | null };

/**
 * A device's type chip. Falls back to the raw `device_type` string so devices
 * carrying a type that is no longer in the catalog still get a stable colour.
 */
export function deviceTypeChipFor(
  deviceType: string | null | undefined,
  deviceTypes: DeviceTypeLike[],
): ChipSource | null {
  const value = (deviceType ?? "").trim();
  if (!value) return null;
  const match = deviceTypes.find((candidate) => candidate.value === value);
  if (match) return { label: match.label, color: match.color, key: match.value };
  return { label: value, color: null, key: value };
}

/** A device's location chip. */
export function siteChipFor(device: DeviceLike, sites: SiteLike[]): ChipSource | null {
  if (device.site_id == null) return null;
  const site = sites.find((candidate) => candidate.id === device.site_id);
  if (!site) return null;
  return { label: site.display_name ?? site.name, color: site.color, key: site.name };
}
