import { createContext, useContext, useMemo, type ReactNode } from "react";

/**
 * Whether entity chips (VLAN/group, location, device type) render in colour.
 *
 * Backed by the per-user `entity_colors_enabled` preference in Profile. When
 * off, chips keep their shape and render neutral grey — the table layout is
 * identical either way, only the colour drops out.
 *
 * Defaults to `true` so a chip rendered outside a provider (tests, isolated
 * previews) still shows colour.
 */
const EntityColorContext = createContext<boolean>(true);

export function EntityColorProvider({
  enabled,
  children,
}: {
  enabled: boolean;
  children: ReactNode;
}) {
  const value = useMemo(() => enabled, [enabled]);
  return <EntityColorContext.Provider value={value}>{children}</EntityColorContext.Provider>;
}

export function useEntityColorsEnabled(): boolean {
  return useContext(EntityColorContext);
}
