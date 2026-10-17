import { Globe2 } from "lucide-react";
import { IconServer, IconBroadcast } from "@tabler/icons-react";
import type { User } from "../../api/client";
import { userHasPermission } from "../../utils/permissions";

export type MonitoringViewId = "devices" | "endpoints" | "status-pages";

export const monitoringViews = [
  { id: "devices", label: "Devices", Icon: IconServer, permission: null },
  { id: "endpoints", label: "Endpoints", Icon: Globe2, permission: null },
  { id: "status-pages", label: "Status pages", Icon: IconBroadcast, permission: "status_page_manage" },
] as const;

export function availableMonitoringViews(user: User | null | undefined) {
  return monitoringViews.filter((view) => view.permission === null || userHasPermission(user, view.permission));
}

export const MONITORING_VIEW_CHANGE_EVENT = "netmap:monitoring-view-change";

export function readMonitoringViewFromLocation(): MonitoringViewId {
  const candidate = window.location.hash.slice(1);
  if (candidate === "endpoints" || candidate === "monitors") return "endpoints";
  if (candidate === "status-pages") return "status-pages";
  return "devices";
}

export function navigateToMonitoringView(view: MonitoringViewId, replace = false) {
  const nextUrl = `${window.location.pathname}${window.location.search}#${view}`;
  window.history[replace ? "replaceState" : "pushState"](null, "", nextUrl);
  window.dispatchEvent(new CustomEvent<MonitoringViewId>(MONITORING_VIEW_CHANGE_EVENT, { detail: view }));
}
