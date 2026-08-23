import { Cloud } from "lucide-react";
import { IconServer } from "@tabler/icons-react";

export type InventoryViewId = "devices" | "cloud";

export const inventoryViews = [
  { id: "devices", label: "Devices", Icon: IconServer },
  { id: "cloud", label: "Cloud assets", Icon: Cloud },
] as const;

export const INVENTORY_VIEW_CHANGE_EVENT = "netmap:inventory-view-change";

export function readInventoryViewFromLocation(): InventoryViewId {
  const candidate = window.location.hash.slice(1);
  if (candidate === "cloud" || candidate === "cloud-assets") return "cloud";
  return "devices";
}

export function navigateToInventoryView(view: InventoryViewId, replace = false) {
  const nextUrl = `${window.location.pathname}${window.location.search}#${view}`;
  window.history[replace ? "replaceState" : "pushState"](null, "", nextUrl);
  window.dispatchEvent(new CustomEvent<InventoryViewId>(INVENTORY_VIEW_CHANGE_EVENT, { detail: view }));
}
