import { Globe2 } from "lucide-react";
import { IconServer } from "@tabler/icons-react";

export type MonitoringViewId = "devices" | "endpoints";

export const monitoringViews = [
  { id: "devices", label: "Devices", Icon: IconServer },
  { id: "endpoints", label: "Endpoints", Icon: Globe2 },
] as const;

export const MONITORING_VIEW_CHANGE_EVENT = "netmap:monitoring-view-change";

export function readMonitoringViewFromLocation(): MonitoringViewId {
  const candidate = window.location.hash.slice(1);
  if (candidate === "endpoints" || candidate === "monitors") return "endpoints";
  return "devices";
}

export function navigateToMonitoringView(view: MonitoringViewId, replace = false) {
  const nextUrl = `${window.location.pathname}${window.location.search}#${view}`;
  window.history[replace ? "replaceState" : "pushState"](null, "", nextUrl);
  window.dispatchEvent(new CustomEvent<MonitoringViewId>(MONITORING_VIEW_CHANGE_EVENT, { detail: view }));
}
