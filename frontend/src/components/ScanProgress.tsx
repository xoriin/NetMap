import type { DiscoveryScanProgress, DiscoveryScanStatus, DiscoveryScanType } from "../api/client";

function formatElapsed(totalSeconds: number) {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}` : `${minutes}:${seconds}`;
}

/**
 * Loading state for a discovery scan. Without `status` it is the original
 * synchronous message; with an async scan's status it adds the progress
 * count and elapsed time on a second line.
 */
export function ScanProgress({
  scanType,
  status,
  progress,
  elapsedSeconds,
  note,
}: {
  scanType: DiscoveryScanType | string;
  status?: DiscoveryScanStatus;
  progress?: DiscoveryScanProgress | null;
  elapsedSeconds?: number | null;
  note?: string | null;
}) {
  const sweep = scanType === "ping" ? "ping sweep" : "basic port detection";
  const tracking = status === "queued" || status === "running";
  const count = progress && progress.total > 0 ? `${progress.done} of ${progress.total} addresses scanned` : null;
  const elapsed = elapsedSeconds != null ? `${formatElapsed(elapsedSeconds)} elapsed` : null;
  return (
    <div className="scan-progress" role="status">
      <div className="scan-progress-pulse" />
      <div>
        <strong>{status === "queued" ? "Scan queued" : "Scanning network"}</strong>
        <span>
          {status === "queued"
            ? `Waiting to start the ${sweep}.`
            : tracking
            ? `Running ${sweep}. You can close this window; the scan keeps running.`
            : `Validating target, running ${sweep}, parsing results.`}
        </span>
        {note && <span>{note}</span>}
        {tracking && (count || elapsed) && (
          <span className="scan-progress-detail">
            {count}
            {count && elapsed && " · "}
            {/* The clock ticks every second; keep it out of the live region's announcements. */}
            {elapsed && <span aria-hidden="true">{elapsed}</span>}
          </span>
        )}
      </div>
    </div>
  );
}
