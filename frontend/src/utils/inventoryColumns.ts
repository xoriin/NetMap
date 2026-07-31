/**
 * Resizable inventory columns.
 *
 * The inventory table is a CSS grid rather than a `<table>`, so resizing works
 * by freezing `grid-template-columns` to pixel widths on the first drag. Until
 * then the stylesheet's flexible `fr` layout governs, exactly like the
 * monitoring fleet table.
 */

export const INV_COL_WIDTHS_KEY = "netmap.inv_col_widths_v1";

/** Device, IP, Device Type, Status, Latency, VLAN / Group, Location. */
export const INV_COL_COUNT = 7;

/** The leading checkbox column is fixed and not resizable. */
export const INV_CHECK_COL_WIDTH = 48;

export const INV_MIN_COL_WIDTH = 60;

export function loadInvColWidths(): number[] | null {
  try {
    const raw = window.localStorage.getItem(INV_COL_WIDTHS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (
      Array.isArray(parsed)
      && parsed.length === INV_COL_COUNT
      && parsed.every((value) => typeof value === "number" && value >= INV_MIN_COL_WIDTH)
    ) {
      return parsed as number[];
    }
  } catch {
    /* ignore malformed persisted widths */
  }
  return null;
}

/** `grid-template-columns` value for frozen widths. */
export function invGridTemplate(widths: number[]): string {
  return `${INV_CHECK_COL_WIDTH}px ${widths.map((width) => `${width}px`).join(" ")}`;
}
