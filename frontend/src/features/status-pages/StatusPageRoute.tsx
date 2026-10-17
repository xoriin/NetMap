import { useEffect, useState } from "react";
import { PanelSkeleton } from "../../components/Skeleton";
import { StatusPageFrame } from "./StatusPageFrame";
import {
  type StatusFetchResult, type StatusPagePayload, fetchStatusPage, publicStatusUrl, signedInStatusUrl, statusPagePath,
} from "./statusPagesApi";
import "./statusPages.css";

const POLL_MS = 30_000;
const MIN_POLL_MS = 1_000;
const MAX_RETRY_AFTER_S = 10;

type Phase = "loading" | "ready" | "not-found";

export function StatusPageRoute({ slug }: { slug: string }) {
  const [phase, setPhase] = useState<Phase>("loading");
  const [payload, setPayload] = useState<StatusPagePayload | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    let etag: string | null = null;
    let signedIn = false;
    let retriedUnavailable = false;
    let freshUntil = 0;

    const schedule = (ms: number) => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void poll(), ms);
    };

    const fail = () => {
      setUnavailable(true);
      schedule(POLL_MS);
    };

    const fresh = (validForMs: number) => {
      retriedUnavailable = false;
      freshUntil = Date.now() + validForMs;
      setUnavailable(false);
      setLastUpdated(new Date());
      schedule(Math.min(POLL_MS, Math.max(MIN_POLL_MS, validForMs)));
    };

    async function poll() {
      let result: StatusFetchResult | null;
      try {
        result = await fetchStatusPage(signedIn ? signedInStatusUrl(slug) : publicStatusUrl(slug), etag, signedIn);
      } catch {
        result = null;
      }
      if (cancelled) return;
      if (!result) return fail();

      if (result.kind === "ok") {
        etag = result.etag;
        const validFor = Date.parse(result.payload.valid_until) - Date.parse(result.payload.generated_at);
        setPayload(result.payload);
        setPhase("ready");
        return fresh(Number.isFinite(validFor) ? Math.min(POLL_MS, Math.max(0, validFor)) : 0);
      }
      if (result.kind === "not-modified") return fresh(POLL_MS);
      if (result.kind === "unavailable") {
        if (retriedUnavailable) return fail();
        retriedUnavailable = true;
        return schedule(Math.min(result.retryAfterSeconds ?? MAX_RETRY_AFTER_S, MAX_RETRY_AFTER_S) * 1000);
      }
      if (result.status === 404 && !signedIn) {
        signedIn = true;
        etag = null;
        return void poll();
      }
      if (result.status === 401 && signedIn) {
        window.location.assign(`/?next=${encodeURIComponent(statusPagePath(slug))}`);
        return;
      }
      if (result.status === 404) {
        setPayload(null);
        setUnavailable(false);
        setPhase("not-found");
        return;
      }
      fail();
    }

    const onVisible = () => {
      if (document.visibilityState === "visible" && freshUntil && Date.now() > freshUntil) schedule(0);
    };

    document.addEventListener("visibilitychange", onVisible);
    void poll();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [slug]);

  useEffect(() => {
    document.title = payload?.title || "Status";
  }, [payload?.title]);

  const updatedAt = lastUpdated?.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

  return (
    <main className="status-route">
      {payload && (
        <StatusPageFrame
          payload={payload}
          css={payload.custom_css}
          title={payload.title || "Status page"}
          className={unavailable ? "status-page-frame--hidden" : undefined}
        />
      )}
      {phase === "loading" && !unavailable && (
        <div className="status-route-message">
          <div className="status-route-card"><PanelSkeleton lines={4} /></div>
        </div>
      )}
      {phase === "not-found" && (
        <div className="status-route-message">
          <div className="nm-alert nm-alert--info status-route-card" role="note">
            <strong>Status page not found</strong>
            <span>This status page does not exist, or you do not have access to it.</span>
          </div>
        </div>
      )}
      {unavailable && phase !== "not-found" && (
        <div className="status-route-message">
          <div className="nm-alert nm-alert--warning status-route-card" role="alert">
            <strong>Status is temporarily unavailable</strong>
            <span>{updatedAt ? `Last updated ${updatedAt}. Retrying automatically.` : "No status has been received yet. Retrying automatically."}</span>
          </div>
        </div>
      )}
    </main>
  );
}
