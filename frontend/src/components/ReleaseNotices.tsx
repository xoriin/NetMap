import { useEffect, useState, type CSSProperties } from "react";
import { AlertTriangle, Info, Megaphone, OctagonAlert } from "lucide-react";
import { api, type ReleaseNotice } from "../api/client";
import { useApiQuery } from "../hooks/useApiQuery";
import { useToast } from "./Toast";

const TONE = { info: "info", warning: "warning", breaking: "error" } as const;
const ICON = { info: Info, warning: AlertTriangle, breaking: OctagonAlert } as const;

function NoticeText({ notice }: { notice: ReleaseNotice }) {
  return (
    <span>
      <strong>{notice.title}. </strong>
      {notice.message}
      {notice.link && <> <a href={notice.link} target="_blank" rel="noreferrer noopener">Read more</a></>}
    </span>
  );
}

/** Release notices from the NetMap project feed, shown above every workspace. */
export function NoticeBanners({ accessToken }: { accessToken: string }) {
  const toast = useToast();
  const query = useApiQuery(() => api.notices(accessToken), [accessToken]);
  const reload = query.reload;
  const [busyId, setBusyId] = useState<string | null>(null);
  useEffect(() => {
    const timer = window.setInterval(() => { void reload({ silent: true }); }, 10 * 60_000);
    return () => window.clearInterval(timer);
  }, [reload]);

  async function act(notice: ReleaseNotice) {
    setBusyId(notice.id);
    try {
      if (notice.can_acknowledge) await api.acknowledgeNotice(accessToken, notice.id);
      else await api.dismissNotice(accessToken, notice.id);
      query.setData((query.data ?? []).filter((row) => row.id !== notice.id));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Unable to update the notice");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <>
      {(query.data ?? []).map((notice) => {
        const Icon = ICON[notice.severity];
        return (
          <div
            key={notice.id}
            className={`nm-alert nm-alert--${TONE[notice.severity]} workspace-security-alert workspace-notice`}
            role={notice.severity === "info" ? "status" : "alert"}
            aria-label={`Notice: ${notice.title}`}
          >
            <Icon size={17} aria-hidden="true" />
            <NoticeText notice={notice} />
            {(notice.can_dismiss || notice.can_acknowledge) && (
              <button type="button" className="nm-btn nm-btn--sm nm-btn--secondary workspace-notice-action" disabled={busyId === notice.id} onClick={() => void act(notice)}>
                {notice.can_acknowledge ? "Acknowledge" : "Dismiss"}
              </button>
            )}
          </div>
        );
      })}
    </>
  );
}

/** Admin → System: feed status, the on/off switch and every current notice. */
export function ReleaseNoticesPanel({ accessToken, style }: { accessToken: string; style?: CSSProperties }) {
  const toast = useToast();
  const feedQuery = useApiQuery(() => api.noticeFeed(accessToken), [accessToken]);
  const settingsQuery = useApiQuery(() => api.adminSettings(accessToken), [accessToken]);
  const [checking, setChecking] = useState(false);
  const [pending, setPending] = useState<boolean | null>(null);
  const feed = feedQuery.data;
  const enabled = pending ?? settingsQuery.data?.notice_feed_enabled !== false;

  async function toggle(next: boolean) {
    setPending(next);
    try {
      settingsQuery.setData(await api.updateAdminSettings(accessToken, { notice_feed_enabled: next }));
      await feedQuery.reload({ silent: true });
      toast.success(next ? "Release notices turned on" : "Release notices turned off");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Unable to save the release notice setting");
    } finally {
      setPending(null);
    }
  }

  async function checkNow() {
    setChecking(true);
    try {
      feedQuery.setData(await api.refreshNoticeFeed(accessToken));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Unable to check for notices");
    } finally {
      setChecking(false);
    }
  }

  async function acknowledge(notice: ReleaseNotice) {
    try {
      await api.acknowledgeNotice(accessToken, notice.id);
      await feedQuery.reload({ silent: true });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Unable to acknowledge the notice");
    }
  }

  const checked = feed?.checked_at ? new Date(feed.checked_at).toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : null;
  return (
    <section className="panel admin-panel nm-app-panel admin-system-card nm-motion-item" aria-label="Release Notices" style={style}>
      <div className="admin-system-card-header nm-app-panel-header">
        <h2 className="admin-section-title"><Megaphone size={16} />Release Notices</h2>
        <button type="button" className="nm-btn nm-btn--sm nm-btn--secondary" disabled={checking || !enabled} onClick={() => void checkNow()}>
          {checking ? "Checking…" : "Check now"}
        </button>
      </div>
      <div className="tool-form admin-system-card-body">
        <label className="tool-form-inline-check">
          <input type="checkbox" checked={enabled} disabled={pending !== null || settingsQuery.isLoading} onChange={(e) => void toggle(e.target.checked)} />
          <span className="tool-form-check-copy">
            <span>Show notices from the NetMap project</span>
            <span className="tool-note">Warnings about breaking changes before you upgrade. NetMap reads a public file every 6 hours and sends nothing about this installation.</span>
          </span>
        </label>
        {enabled && feed && (
          <p className="tool-note">
            {feed.error ? <>Last check failed: {feed.error}</> : checked ? <>Checked {checked}</> : <>Not checked yet</>}
          </p>
        )}
        {enabled && feed && feed.notices.length === 0 && <p className="tool-note">No current notices.</p>}
        {enabled && feed?.notices.map((notice) => {
          const Icon = ICON[notice.severity];
          return (
            <div key={notice.id} className={`nm-alert nm-alert--${TONE[notice.severity]}`}>
              <Icon size={17} aria-hidden="true" />
              <span>
                <NoticeText notice={notice} />
                {notice.acknowledged_by && <span className="tool-note"> Acknowledged by {notice.acknowledged_by}.</span>}
              </span>
              {notice.can_acknowledge && (
                <button type="button" className="nm-btn nm-btn--sm nm-btn--secondary workspace-notice-action" onClick={() => void acknowledge(notice)}>Acknowledge</button>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
