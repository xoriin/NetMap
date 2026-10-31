import { builtInIconPack, fullTablerIconPack, loadFullTablerIconPack, type IconPack } from "../../icons";

// Public visitors only have the bundled packs, so group icons come from these and never from local packs.
export const DEFAULT_GROUP_ICON_MARKUP = '<path d="M6 3h12v6H6z M3 15h6v6H3z M15 15h6v6h-6z M12 9v3 M6 15v-3h12v3"/>';

const builtIn = new Map(builtInIconPack.icons.map((icon) => [icon.value, icon.path ?? ""]));

export function statusGroupIconPacks(): IconPack[] {
  return fullTablerIconPack.icons.length > 0 ? [builtInIconPack, fullTablerIconPack] : [builtInIconPack];
}

export function groupIconMarkup(name: string | null | undefined): string | null {
  if (!name) return null;
  return builtIn.get(name) ?? fullTablerIconPack.icons.find((icon) => icon.value === name)?.path ?? null;
}

const SHAPES = new Set(["path", "circle", "ellipse", "line", "polyline", "polygon", "rect"]);
const SHAPE_ATTRIBUTES = new Set(["d", "cx", "cy", "r", "rx", "ry", "x", "y", "x1", "y1", "x2", "y2", "points", "width", "height", "fill", "stroke"]);

/** Icon markup as plain SVG shapes: only known shape elements and geometry attributes survive. */
export function groupIconShapes(doc: Document, markup: string | null): SVGElement[] {
  if (!markup) return [];
  const svgNs = "http://www.w3.org/2000/svg";
  const parsed = new DOMParser().parseFromString(`<svg xmlns="${svgNs}">${markup}</svg>`, "image/svg+xml").documentElement;
  if (parsed.namespaceURI !== svgNs) return [];
  const shapes: SVGElement[] = [];
  for (const source of Array.from(parsed.children)) {
    if (!SHAPES.has(source.localName)) continue;
    const shape = doc.createElementNS(svgNs, source.localName) as SVGElement;
    for (const attribute of Array.from(source.attributes)) {
      if (SHAPE_ATTRIBUTES.has(attribute.name) && !/[<>]|url\(/i.test(attribute.value)) shape.setAttribute(attribute.name, attribute.value);
    }
    shapes.push(shape);
  }
  return shapes;
}

export function groupIconsPending(names: Array<string | null | undefined>): boolean {
  return fullTablerIconPack.icons.length === 0 && names.some((name) => !!name && !builtIn.has(name));
}

export function loadGroupIcons(): Promise<unknown> {
  return loadFullTablerIconPack();
}
