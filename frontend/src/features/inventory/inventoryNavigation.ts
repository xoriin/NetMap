import { IconCloud, IconServer } from "@tabler/icons-react";

export type InventoryViewId = "devices" | "cloud-assets";

export const inventoryViews = [
  { id: "devices", label: "Devices", Icon: IconServer },
  { id: "cloud-assets", label: "Cloud assets", Icon: IconCloud },
] as const;

export const INVENTORY_VIEW_CHANGE_EVENT = "netmap:inventory-view-change";

export function readInventoryViewFromLocation(): InventoryViewId {
  return window.location.hash === "#cloud-assets" ? "cloud-assets" : "devices";
}

export function navigateToInventoryView(view: InventoryViewId, replace = false) {
  const nextUrl = `${window.location.pathname}${window.location.search}#${view}`;
  window.history[replace ? "replaceState" : "pushState"](null, "", nextUrl);
  window.dispatchEvent(new CustomEvent<InventoryViewId>(INVENTORY_VIEW_CHANGE_EVENT, { detail: view }));
}

type CloudAssetReturn = { cloudAsset?: string; cloudAssetDevice?: number | null };

export function readCloudAssetReturn(): CloudAssetReturn {
  const state = window.history.state as CloudAssetReturn | null;
  return { cloudAsset: state?.cloudAsset, cloudAssetDevice: state?.cloudAssetDevice ?? null };
}

export function rememberCloudAssetReturn(cloudAsset: string, cloudAssetDevice: number | null) {
  window.history.replaceState({ ...(window.history.state ?? {}), cloudAsset, cloudAssetDevice }, "");
}

export function clearCloudAssetReturn() {
  const state = { ...(window.history.state ?? {}) };
  delete state.cloudAsset;
  delete state.cloudAssetDevice;
  window.history.replaceState(state, "");
}
