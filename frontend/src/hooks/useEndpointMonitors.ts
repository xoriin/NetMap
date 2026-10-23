import { useEffect } from "react";
import { api } from "../api/client";
import { useApiQuery } from "./useApiQuery";

/** Endpoint status stays live independently of inventory ICMP polling. */
export function useEndpointMonitors(accessToken: string | null) {
  const query = useApiQuery(accessToken ? () => api.listMonitors(accessToken) : null, [accessToken], { rememberAs: "monitors" });
  const { reload } = query;
  useEffect(() => {
    if (!accessToken) return;
    const interval = window.setInterval(() => { void reload({ silent: true }); }, 30_000);
    const refresh = () => { void reload({ silent: true }); };
    window.addEventListener("focus", refresh);
    return () => { window.clearInterval(interval); window.removeEventListener("focus", refresh); };
  }, [accessToken, reload]);
  return query;
}
