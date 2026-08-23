import { Globe2, Network } from "lucide-react";

export type IpamViewId = "internal" | "external";

export const ipamViews = [
  { id: "internal", label: "Internal networks", Icon: Network },
  { id: "external", label: "External IPs", Icon: Globe2 },
] as const;

export const IPAM_VIEW_CHANGE_EVENT = "netmap:ipam-view-change";

/**
 * IPAM's tab lives in the URL for the same reason Monitoring's and Inventory's do:
 * other pages need to deep-link into it. Cloud assets' "Manage in IPAM" lands on
 * External IPs rather than dropping the user on Internal networks to find it.
 */
export function readIpamViewFromLocation(): IpamViewId {
  const candidate = window.location.hash.slice(1);
  if (candidate === "external" || candidate === "external-ips") return "external";
  return "internal";
}

export function navigateToIpamView(view: IpamViewId, replace = false) {
  const nextUrl = `${window.location.pathname}${window.location.search}#${view}`;
  window.history[replace ? "replaceState" : "pushState"](null, "", nextUrl);
  window.dispatchEvent(new CustomEvent<IpamViewId>(IPAM_VIEW_CHANGE_EVENT, { detail: view }));
}
