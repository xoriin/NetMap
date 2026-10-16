import { useEffect } from "react";
import { AlertTriangle } from "lucide-react";
import { api } from "../api/client";
import { useApiQuery } from "../hooks/useApiQuery";

/** Lives above the route boundary: no dismissal or per-browser acknowledgement. */
export function RuntimeSecurityAlert({ accessToken }: { accessToken: string }) {
  const query = useApiQuery(() => api.runtimeSecurityStatus(accessToken), [accessToken]);
  const reload = query.reload;
  useEffect(() => {
    const refresh = () => { void reload({ silent: true }); };
    const timer = window.setInterval(refresh, 30_000);
    window.addEventListener("focus", refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
    };
  }, [reload]);
  const warnings = query.data?.warnings ?? [];
  if (warnings.length === 0 && !query.error) return null;
  return (
    <div className="nm-alert nm-alert--warning workspace-security-alert" role="alert" aria-label="Deployment security">
      <AlertTriangle size={17} aria-hidden="true" />
      <span>
        {warnings.length > 0 && <><strong>Deployment security needs attention. </strong>{warnings.join(" ")}</>}
        {query.error && <> Unable to refresh deployment security status. Retrying automatically.</>}
      </span>
    </div>
  );
}
