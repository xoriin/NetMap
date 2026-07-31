import type { CSSProperties, ReactNode } from "react";

import { useEntityColorsEnabled } from "../providers/EntityColorProvider";
import { resolveEntityColor } from "../utils/entityColor";

/**
 * Coloured chip for a VLAN/group or location.
 *
 * The colour comes from the entity's configured `color` (Admin -> Device Icons)
 * and falls back to a stable palette colour derived from the name.
 */
export function EntityChip({
  label,
  color,
  colorKey,
  title,
  className,
  icon,
  forceColor,
}: {
  label: string;
  /** Explicit colour, if the entity has one configured. */
  color?: string | null;
  /** Name the fallback palette colour is derived from. Defaults to `label`. */
  colorKey?: string | null;
  title?: string;
  className?: string;
  /**
   * Rendered tinted in place of the swatch square. Device types already carry an
   * icon, and showing both it and a swatch reads as two competing colour marks.
   */
  icon?: ReactNode;
  /** Forces colour on regardless of the user preference (admin colour pickers). */
  forceColor?: boolean;
}) {
  const colorsEnabled = useEntityColorsEnabled() || forceColor === true;
  const resolved = resolveEntityColor(color, colorKey ?? label);
  return (
    <span
      className={
        `nm-chip${icon ? " nm-chip--icon" : ""}`
        + `${colorsEnabled ? "" : " nm-chip--nocolor"}`
        + `${className ? ` ${className}` : ""}`
      }
      style={colorsEnabled ? ({ "--nm-chip-color": resolved } as CSSProperties) : undefined}
      title={title ?? label}
    >
      {icon ? <span className="nm-chip-icon" aria-hidden>{icon}</span> : <span className="nm-chip-swatch" aria-hidden />}
      <span className="nm-chip-label">{label}</span>
    </span>
  );
}

/** Muted chip used where a device has no group or location assigned. */
export function EntityChipEmpty({ label = "—" }: { label?: string }) {
  return <span className="nm-chip nm-chip--empty">{label}</span>;
}
