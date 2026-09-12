import { IconServer } from "@tabler/icons-react";

export type InventoryViewId = "devices";

export const inventoryViews = [
  { id: "devices", label: "Devices", Icon: IconServer },
] as const;

export const INVENTORY_VIEW_CHANGE_EVENT = "netmap:inventory-view-change";

export function readInventoryViewFromLocation(): InventoryViewId {
  return "devices";
}

export function navigateToInventoryView(view: InventoryViewId, replace = false) {
  const nextUrl = `${window.location.pathname}${window.location.search}#${view}`;
  window.history[replace ? "replaceState" : "pushState"](null, "", nextUrl);
  window.dispatchEvent(new CustomEvent<InventoryViewId>(INVENTORY_VIEW_CHANGE_EVENT, { detail: view }));
}
