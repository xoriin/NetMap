import { useCallback, useEffect, useState } from "react";
import { IconPalette } from "@tabler/icons-react";

import { api, type Site, type TopologyGroup } from "../../../api/client";
import { EntityChip } from "../../../components/EntityChip";
import { autoEntityColor, isValidHexColor, resolveEntityColor } from "../../../utils/entityColor";

type Row = {
  kind: "group" | "site";
  id: number;
  name: string;
  label: string;
  color: string | null;
};

/**
 * Admin -> Device icons: colours for the VLAN/group and location chips shown in
 * the inventory table and device details. An unset colour falls back to a
 * stable palette colour derived from the name.
 */
export function EntityColorsPanel({
  accessToken,
  onError,
  onSuccess,
}: {
  accessToken: string;
  onError: (message: string | null) => void;
  onSuccess: (message: string | null) => void;
}) {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [groups, sites] = await Promise.all([
        api.topologyGroups(accessToken),
        api.sites(accessToken),
      ]);
      setRows([
        ...groups.map((group: TopologyGroup) => ({
          kind: "group" as const,
          id: group.id,
          name: group.name,
          label: group.display_name || group.name,
          color: group.color,
        })),
        ...sites.map((site: Site) => ({
          kind: "site" as const,
          id: site.id,
          name: site.name,
          label: site.display_name ?? site.name,
          color: site.color,
        })),
      ]);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Unable to load groups and locations");
    } finally {
      setLoading(false);
    }
  }, [accessToken, onError]);

  useEffect(() => {
    void load();
  }, [load]);

  async function saveColor(row: Row, color: string | null) {
    const key = `${row.kind}:${row.id}`;
    setBusy(key);
    onError(null);
    onSuccess(null);
    try {
      if (row.kind === "group") {
        await api.updateTopologyGroup(accessToken, row.id, { color });
      } else {
        await api.updateSite(accessToken, row.id, { color });
      }
      setRows((current) =>
        current.map((candidate) =>
          candidate.kind === row.kind && candidate.id === row.id ? { ...candidate, color } : candidate,
        ),
      );
      onSuccess(color ? `${row.label} colour updated` : `${row.label} reset to automatic colour`);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Unable to save colour");
    } finally {
      setBusy(null);
    }
  }

  const groupRows = rows.filter((row) => row.kind === "group");
  const siteRows = rows.filter((row) => row.kind === "site");

  function renderRows(list: Row[], emptyText: string) {
    if (list.length === 0) {
      return <p className="tool-note" style={{ margin: "2px 0 0" }}>{emptyText}</p>;
    }
    return (
      <div className="entity-colors-list">
        {list.map((row) => {
          const key = `${row.kind}:${row.id}`;
          const automatic = !isValidHexColor(row.color);
          return (
            <div key={key} className="entity-colors-row">
              {/* forceColor: the admin picker must show colour even for an
                  admin who has turned colour off for their own views. */}
              <EntityChip label={row.label} color={row.color} colorKey={row.name} forceColor />
              <span className="entity-colors-note">{automatic ? "automatic" : row.color}</span>
              <input
                type="color"
                className="entity-colors-input"
                aria-label={`Colour for ${row.label}`}
                disabled={busy === key}
                value={resolveEntityColor(row.color, row.name)}
                onChange={(event) => void saveColor(row, event.target.value)}
              />
              <button
                type="button"
                className="nm-btn nm-btn--sm nm-btn--secondary"
                disabled={busy === key || automatic}
                title={`Reset to the automatic colour (${autoEntityColor(row.name)})`}
                onClick={() => void saveColor(row, null)}
              >
                Reset
              </button>
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <section className="panel admin-panel nm-app-panel">
      <div className="nm-app-panel-header admin-panel-header">
        <span className="admin-panel-identity">
          <span className="admin-panel-icon" aria-hidden="true"><IconPalette size={17} /></span>
          <span className="admin-panel-title-wrap">
            <span className="admin-panel-title">Group &amp; location colours</span>
            <span className="admin-panel-meta">Chips in the inventory table</span>
          </span>
        </span>
      </div>


      {loading ? (
        <p className="tool-note">Loading…</p>
      ) : (
        <>
          <h3 className="entity-colors-heading">VLANs / groups</h3>
          {renderRows(groupRows, "No groups defined yet.")}
          <h3 className="entity-colors-heading">Locations</h3>
          {renderRows(siteRows, "No locations defined yet.")}
        </>
      )}
    </section>
  );
}
