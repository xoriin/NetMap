import { useMemo, type MouseEvent } from "react";

export type MiniMapNode = { id: number; x: number; y: number; color: string };
export type MiniMapExtent = { x1: number; y1: number; x2: number; y2: number };

const MAP_W = 168;
const MAP_H = 112;
const PAD = 10;

/**
 * Corner overview of the topology canvas: scaled node dots plus the current
 * viewport rectangle. Receives model-space data and reports clicks back in
 * model coordinates — it never touches the cytoscape instance.
 */
export function MiniMap({
  nodes,
  extent,
  onCenter,
}: {
  nodes: MiniMapNode[];
  extent: MiniMapExtent | null;
  onCenter: (modelX: number, modelY: number) => void;
}) {
  const transform = useMemo(() => {
    if (nodes.length === 0) return null;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const node of nodes) {
      if (node.x < minX) minX = node.x;
      if (node.y < minY) minY = node.y;
      if (node.x > maxX) maxX = node.x;
      if (node.y > maxY) maxY = node.y;
    }
    const width = Math.max(maxX - minX, 1);
    const height = Math.max(maxY - minY, 1);
    const scale = Math.min((MAP_W - PAD * 2) / width, (MAP_H - PAD * 2) / height);
    const offsetX = (MAP_W - width * scale) / 2 - minX * scale;
    const offsetY = (MAP_H - height * scale) / 2 - minY * scale;
    return {
      toMini: (x: number, y: number) => ({ x: x * scale + offsetX, y: y * scale + offsetY }),
      fromMini: (x: number, y: number) => ({ x: (x - offsetX) / scale, y: (y - offsetY) / scale }),
    };
  }, [nodes]);

  if (nodes.length < 2 || transform === null) return null;

  const viewportRect = (() => {
    if (!extent) return null;
    const a = transform.toMini(extent.x1, extent.y1);
    const b = transform.toMini(extent.x2, extent.y2);
    const x = Math.max(0, Math.min(a.x, b.x));
    const y = Math.max(0, Math.min(a.y, b.y));
    const right = Math.min(MAP_W, Math.max(a.x, b.x));
    const bottom = Math.min(MAP_H, Math.max(a.y, b.y));
    if (right <= x || bottom <= y) return null;
    return { x, y, width: right - x, height: bottom - y };
  })();

  function handleClick(event: MouseEvent<SVGSVGElement>) {
    if (!transform) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const point = transform.fromMini(event.clientX - rect.left, event.clientY - rect.top);
    onCenter(point.x, point.y);
  }

  return (
    <div className="topo-minimap" title="Click to pan the map">
      <svg width={MAP_W} height={MAP_H} viewBox={`0 0 ${MAP_W} ${MAP_H}`} onClick={handleClick} role="presentation">
        {nodes.map((node) => {
          const point = transform.toMini(node.x, node.y);
          return <circle key={node.id} cx={point.x} cy={point.y} r={2.4} fill={node.color} />;
        })}
        {viewportRect && (
          <rect
            className="topo-minimap-viewport"
            x={viewportRect.x}
            y={viewportRect.y}
            width={viewportRect.width}
            height={viewportRect.height}
          />
        )}
      </svg>
    </div>
  );
}
