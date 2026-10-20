import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { Megaphone } from "lucide-react";
import { TableSkeleton } from "../../components/Skeleton";
import { useToast } from "../../components/Toast";
import { useConfirm } from "../../components/ConfirmDialog";
import { StatusEditorPanelHeader } from "./StatusPageLayoutEditor";
import {
  TEXT_LIMITS, apiErrorMessage, browserTimeZone, formatWhen, isHttpUrl, isoToLocalInput, localInputToIso, statusManageApi,
  type ManagedNotice, type NoticeLevel, type StatusPageDetail,
} from "./statusPagesEditorApi";

const LEVEL_LABELS: Record<NoticeLevel, string> = { info: "Info", warning: "Warning", critical: "Critical" };
const LEVEL_TONES: Record<NoticeLevel, string> = { info: "unknown", warning: "warning", critical: "offline" };

type NoticeDraft = { level: NoticeLevel; title: string; body: string; link: string; expires: string };

const EMPTY_DRAFT: NoticeDraft = { level: "info", title: "", body: "", link: "", expires: "" };

function draftFrom(notice: ManagedNotice | undefined): NoticeDraft {
  if (!notice) return EMPTY_DRAFT;
  return { level: notice.level, title: notice.title, body: notice.body ?? "", link: notice.link ?? "", expires: isoToLocalInput(notice.expires_at) };
}

export function StatusNoticesPanel({ accessToken, page }: { accessToken: string; page: StatusPageDetail }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [notices, setNotices] = useState<ManagedNotice[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<NoticeDraft>(EMPTY_DRAFT);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const load = useCallback(async (reseed: boolean) => {
    try {
      const next = await statusManageApi.notices(accessToken, page.id);
      setNotices(next);
      if (reseed) setDraft(draftFrom(next.find((n) => n.mine)));
      setError(null);
    } catch (err) {
      setError(apiErrorMessage(err, "Unable to load notices"));
    }
  }, [accessToken, page.id]);

  useEffect(() => { void load(true); }, [load]);

  const mine = useMemo(() => notices?.find((n) => n.mine), [notices]);
  const linkInvalid = draft.link.trim() !== "" && !isHttpUrl(draft.link.trim());
  const expiresAt = localInputToIso(draft.expires);
  const expiryPast = expiresAt !== null && new Date(expiresAt).getTime() <= Date.now();
  const loading = notices === null;
  const invalid = !draft.title.trim() || linkInvalid || expiryPast;
  const update = <K extends keyof NoticeDraft>(key: K, value: NoticeDraft[K]) => setDraft((current) => ({ ...current, [key]: value }));

  async function save(event: FormEvent) {
    event.preventDefault();
    if (loading || invalid) return;
    setBusy(true);
    setFormError(null);
    try {
      await statusManageApi.setOwnNotice(accessToken, page.id, {
        level: draft.level,
        title: draft.title.trim(),
        body: draft.body.trim() || null,
        link: draft.link.trim() || null,
        expires_at: expiresAt,
      });
      toast.success("Notice saved");
      await load(true);
    } catch (err) {
      setFormError(apiErrorMessage(err, "Unable to save the notice"));
    } finally {
      setBusy(false);
    }
  }

  async function clear(notice: ManagedNotice) {
    const ok = await confirm({
      title: "Clear this notice?",
      message: `"${notice.title}" disappears from ${page.name} straight away.`,
      confirmLabel: "Clear notice",
    });
    if (!ok) return;
    try {
      if (notice.mine) await statusManageApi.clearOwnNotice(accessToken, page.id);
      else await statusManageApi.clearNotice(accessToken, notice.id);
      toast.success("Notice cleared");
      await load(notice.mine);
    } catch (err) {
      toast.error(apiErrorMessage(err, "Unable to clear the notice"));
    }
  }

  function from(notice: ManagedNotice) {
    if (notice.mine) return <strong>You</strong>;
    if (notice.owner_kind === "token") {
      return (
        <>
          <strong>{notice.author ?? "Integration token"}</strong>
          <small className="status-editor-sub">Integration token · its name is shown to visitors</small>
          {notice.token_active === false && <span className="nm-status nm-status--disabled" title="This token is revoked, expired or no longer allowed to post. Its notice stays until someone clears it.">Token inactive</span>}
        </>
      );
    }
    return (
      <>
        <strong>{notice.author ?? "Another manager"}</strong>
        <small className="status-editor-sub">Visitors see "Status team"</small>
      </>
    );
  }

  return (
    <div className="status-editor-panels">
      <section className="nm-app-panel status-editor-panel status-notices-panel">
        <StatusEditorPanelHeader icon={Megaphone} title="Notices on this page" meta={notices ? `${notices.length} notice${notices.length === 1 ? "" : "s"}` : undefined} />
        <div className="status-layout-intro">
          {error && <div className="nm-alert nm-alert--error" role="alert">{error} <button type="button" className="nm-btn nm-btn--sm nm-btn--secondary" onClick={() => void load(notices === null)}>Try again</button></div>}
          <small className="status-editor-hint">Each person and each integration token has one notice slot per page. You can clear anyone's notice.</small>
        </div>
        {!notices ? (
          <TableSkeleton rows={2} columns={5} />
        ) : notices.length === 0 ? (
          <p className="dash-empty">No notices on this page.</p>
        ) : (
          <div className="nm-table-wrap mon-embedded-table">
            <table className="nm-table status-manage-table status-notices-table">
              <thead>
                <tr>
                  <th>Level</th>
                  <th>Notice</th>
                  <th>From</th>
                  <th>Expires</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {notices.map((notice) => (
                  <tr key={notice.id}>
                    <td><span className={`nm-status nm-status--${LEVEL_TONES[notice.level]}`}>{LEVEL_LABELS[notice.level]}</span></td>
                    <td>
                      <strong>{notice.title}</strong>
                      {notice.body && <small className="status-editor-sub">{notice.body}</small>}
                      {notice.link && <small className="status-editor-sub">{notice.link}</small>}
                    </td>
                    <td>{from(notice)}</td>
                    <td>{notice.expires_at ? formatWhen(notice.expires_at) : "Never"}</td>
                    <td className="status-pages-actions">
                      <div className="nm-table-actions">
                        <button type="button" className="nm-btn nm-btn--sm nm-btn--danger" onClick={() => void clear(notice)}>Clear</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="nm-app-panel status-editor-panel">
        <StatusEditorPanelHeader icon={Megaphone} title="Your notice" meta={mine ? "Live on this page" : "Not set"} />
        <form className="status-editor-settings status-notice-form" onSubmit={(event) => void save(event)} noValidate>
          {formError && <div className="nm-alert nm-alert--error" role="alert">{formError}</div>}
          <label className="nm-field">
            <span className="nm-field-label">Level</span>
            <select className="nm-select" value={draft.level} disabled={loading} onChange={(event) => update("level", event.target.value as NoticeLevel)}>
              <option value="info">Info</option>
              <option value="warning">Warning</option>
              <option value="critical">Critical — raises the summary to at least "Some systems are affected"</option>
            </select>
          </label>
          <label className="nm-field">
            <span className="nm-field-label">Title</span>
            <input className="nm-input" value={draft.title} disabled={loading} maxLength={TEXT_LIMITS.noticeTitle} onChange={(event) => update("title", event.target.value)} />
            <small className="status-editor-hint">Shown as a line under the summary. Plain text · {draft.title.length}/{TEXT_LIMITS.noticeTitle} characters</small>
          </label>
          <label className="nm-field">
            <span className="nm-field-label">Text</span>
            <textarea className="nm-textarea" rows={3} value={draft.body} disabled={loading} maxLength={TEXT_LIMITS.noticeBody} onChange={(event) => update("body", event.target.value)} />
            <small className="status-editor-hint">Optional. Plain text · {draft.body.length}/{TEXT_LIMITS.noticeBody} characters</small>
          </label>
          <label className="nm-field">
            <span className="nm-field-label">Link</span>
            <input className="nm-input" value={draft.link} disabled={loading} maxLength={TEXT_LIMITS.noticeLink} placeholder="https://" aria-invalid={linkInvalid || undefined} onChange={(event) => update("link", event.target.value)} />
            {linkInvalid ? <span className="status-editor-error">Use an http:// or https:// link.</span> : <small className="status-editor-hint">Optional.</small>}
          </label>
          <label className="nm-field">
            <span className="nm-field-label">Expires</span>
            <input className="nm-input" type="datetime-local" value={draft.expires} disabled={loading} aria-invalid={expiryPast || undefined} onChange={(event) => update("expires", event.target.value)} />
            {expiryPast ? <span className="status-editor-error">Choose a time in the future.</span>
              : <small className="status-editor-hint">Optional. In your timezone ({browserTimeZone()}); the notice disappears on its own.</small>}
          </label>
          <small className="status-editor-hint">Visitors see "Status team", never your name.</small>
          <div className="status-editor-actions">
            {mine && <button type="button" className="nm-btn nm-btn--secondary" disabled={busy} onClick={() => void clear(mine)}>Clear my notice</button>}
            <button type="submit" className="nm-btn nm-btn--primary" disabled={busy || loading || invalid}>{busy ? "Saving…" : "Save notice"}</button>
          </div>
        </form>
      </section>
    </div>
  );
}
