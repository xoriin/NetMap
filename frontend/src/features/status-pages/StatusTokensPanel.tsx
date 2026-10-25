import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Info, KeyRound, Plus } from "lucide-react";
import { Modal, ModalFooterActions } from "../../components/Modal";
import { TableSkeleton } from "../../components/Skeleton";
import { useToast } from "../../components/Toast";
import { useConfirm } from "../../components/ConfirmDialog";
import { StatusEditorPanelHeader } from "./StatusPageLayoutEditor";
import { useStatusPageCatalog } from "./useStatusPageCatalog";
import {
  TEXT_LIMITS, apiErrorMessage, browserTimeZone, formatWhen, localInputToIso, statusManageApi,
  type IntegrationToken, type IntegrationTokenCreated, type ManagedNotice, type StatusPageDetail,
} from "./statusPagesEditorApi";

function tokenState(token: IntegrationToken): { label: string; tone: string; title?: string } {
  if (token.revoked_at) return { label: "Revoked", tone: "disabled" };
  if (token.expires_at && new Date(token.expires_at).getTime() <= Date.now()) return { label: "Expired", tone: "disabled" };
  if (!token.active) return { label: "Inactive", tone: "paused", title: "It has no pages, or its creator can no longer manage status pages." };
  return { label: "Active", tone: "online" };
}

function CreateTokenModal({
  accessToken, page, pages, onCancel, onCreated, onDone,
}: {
  accessToken: string;
  page: StatusPageDetail;
  pages: StatusPageDetail[];
  onCancel: () => void;
  onCreated: () => void;
  onDone: () => void;
}) {
  const toast = useToast();
  const [name, setName] = useState("");
  const [pageIds, setPageIds] = useState<number[]>([page.id]);
  const [expires, setExpires] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<IntegrationTokenCreated | null>(null);
  const expiresAt = localInputToIso(expires);
  const expiryPast = expiresAt !== null && new Date(expiresAt).getTime() <= Date.now();
  const invalid = !name.trim() || pageIds.length === 0 || expiryPast;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (invalid) return;
    setBusy(true);
    setError(null);
    try {
      setCreated(await statusManageApi.createToken(accessToken, {
        name: name.trim(),
        page_ids: pages.filter((p) => pageIds.includes(p.id)).map((p) => p.id),
        ...(expiresAt ? { expires_at: expiresAt } : {}),
      }));
      onCreated();
    } catch (err) {
      setError(apiErrorMessage(err, "Unable to create the token"));
    } finally {
      setBusy(false);
    }
  }

  async function copy(secret: string) {
    try {
      await navigator.clipboard.writeText(secret);
      toast.success("Secret copied");
    } catch {
      toast.error("Copy failed. Select the secret and copy it by hand.");
    }
  }

  if (created) {
    return (
      <Modal
        title="Create integration token"
        titleIcon={<KeyRound size={18} />}
        dismissible={false}
        onCancel={onDone}
        footer={<button type="button" className="nm-btn nm-btn--primary" onClick={onDone}>Done</button>}
      >
        <div className="modal-form">
          <div className="nm-alert nm-alert--info totp-key-note status-token-secret" role="note">
            <Info size={17} aria-hidden="true" />
            <div className="totp-secret">
              <strong>Copy this secret now. It won't be shown again.</strong>
              <code>{created.secret}</code>
            </div>
          </div>
          <div className="nm-btn-row">
            <button type="button" className="nm-btn nm-btn--sm nm-btn--secondary" onClick={() => void copy(created.secret)}>Copy secret</button>
          </div>
          <small className="status-editor-hint">Send it as "Authorization: Bearer &lt;secret&gt;". {created.name} can post only to the pages you chose and can't use any other NetMap API.</small>
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      title="Create integration token"
      titleIcon={<KeyRound size={18} />}
      onCancel={onCancel}
      footer={<ModalFooterActions onCancel={onCancel} formId="status-token-form" primaryLabel={busy ? "Creating…" : "Create token"} primaryDisabled={busy || invalid} />}
    >
      <form id="status-token-form" className="modal-form" onSubmit={(event) => void submit(event)} noValidate>
        {error && <div className="form-error" role="alert">{error}</div>}
        <div className="nm-alert nm-alert--warning" role="note">
          The name is shown publicly as the author of this token's notices and incident updates, so use a neutral system name such as "backup-server".
        </div>
        <label>Name
          <input value={name} maxLength={TEXT_LIMITS.tokenName} placeholder="e.g. backup-server" onChange={(event) => setName(event.target.value)} />
          <small className="status-editor-hint">Plain text · {name.length}/{TEXT_LIMITS.tokenName} characters</small>
        </label>
        <fieldset className="status-manage-choices">
          <legend className="nm-field-label">Pages it may post to</legend>
          {pages.map((p) => (
            <label key={p.id} className="tool-form-inline-check">
              <input
                type="checkbox"
                checked={pageIds.includes(p.id)}
                onChange={(event) => setPageIds((ids) => event.target.checked ? [...ids, p.id] : ids.filter((id) => id !== p.id))}
              />
              {p.name}
            </label>
          ))}
          {pageIds.length === 0 && <span className="status-editor-error">Choose at least one page.</span>}
        </fieldset>
        <label>Expires
          <input type="datetime-local" value={expires} aria-invalid={expiryPast || undefined} onChange={(event) => setExpires(event.target.value)} />
          {expiryPast ? <small className="status-editor-error">Choose a time in the future.</small>
            : <small className="status-editor-hint">Optional. In your timezone ({browserTimeZone()}).</small>}
        </label>
      </form>
    </Modal>
  );
}

export function StatusTokensPanel({ accessToken, page }: { accessToken: string; page: StatusPageDetail }) {
  const toast = useToast();
  const confirm = useConfirm();
  const { pages, error: pagesError } = useStatusPageCatalog(accessToken);
  const [tokens, setTokens] = useState<IntegrationToken[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    try {
      setTokens(await statusManageApi.tokens(accessToken));
      setError(null);
    } catch (err) {
      setError(apiErrorMessage(err, "Unable to load integration tokens"));
    }
  }, [accessToken]);

  useEffect(() => { void load(); }, [load]);

  const pageName = (id: number) => pages?.find((p) => p.id === id)?.name ?? `Page #${id}`;

  async function tokenNotices(token: IntegrationToken): Promise<ManagedNotice[]> {
    const ids = pages?.map((p) => p.id) ?? token.page_ids;
    const lists = await Promise.all(ids.map((id) => statusManageApi.notices(accessToken, id)));
    return lists.flat().filter((n) => n.owner_kind === "token" && n.owner_id === token.id);
  }

  async function revoke(token: IntegrationToken) {
    const ok = await confirm({
      title: `Revoke ${token.name}?`,
      message: "Systems using this token can no longer post. Its notices stay on the pages until they are cleared.",
      confirmLabel: "Revoke token",
    });
    if (!ok) return;
    try {
      await statusManageApi.revokeToken(accessToken, token.id);
      toast.success(`Revoked ${token.name}`);
    } catch (err) {
      toast.error(apiErrorMessage(err, "Unable to revoke the token"));
      return;
    } finally {
      await load();
    }
    let notices: ManagedNotice[];
    try {
      notices = await tokenNotices(token);
    } catch (err) {
      toast.error(apiErrorMessage(err, "The token is revoked, but its notices couldn't be checked. Clear them from each page's Notices tab."));
      return;
    }
    if (notices.length === 0) return;
    const onPages = [...new Set(notices.map((n) => pageName(n.page_id)))].join(", ");
    const clear = await confirm({
      title: "Also clear this token's notices?",
      message: `${token.name} still has ${notices.length} notice${notices.length === 1 ? "" : "s"} on ${onPages}.`,
      detail: "Visitors keep seeing them until someone clears them.",
      confirmLabel: "Clear notices",
      cancelLabel: "Keep notices",
    });
    if (!clear) return;
    const results = await Promise.allSettled(notices.map((n) => statusManageApi.clearNotice(accessToken, n.id)));
    const failed = results.filter((r) => r.status === "rejected").length;
    if (failed) toast.error(`${failed} notice${failed === 1 ? "" : "s"} could not be cleared`);
    else toast.success("Notices cleared");
  }

  return (
    <div className="status-editor-panels">
      <section className="nm-app-panel status-editor-panel status-tokens-panel">
        <StatusEditorPanelHeader icon={KeyRound} title="Integration Tokens" meta={tokens ? `${tokens.length} token${tokens.length === 1 ? "" : "s"}` : undefined}>
          <button type="button" className="nm-btn nm-btn--sm nm-btn--primary" disabled={!pages} onClick={() => setCreating(true)}>
            <Plus size={14} /> Create token
          </button>
        </StatusEditorPanelHeader>
        <div className="status-layout-intro">
          {(error || pagesError) && <div className="nm-alert nm-alert--error" role="alert">{error ?? pagesError}</div>}
          <small className="status-editor-hint">Tokens are shared by all status pages. Each token can post notices, incidents and maintenance only to the pages chosen for it, and can't use any other NetMap API.</small>
        </div>
        {!tokens ? (
          <TableSkeleton rows={2} columns={7} />
        ) : tokens.length === 0 ? (
          <p className="dash-empty">No integration tokens yet.</p>
        ) : (
          <div className="nm-table-wrap mon-embedded-table">
            <table className="nm-table status-manage-table status-tokens-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Prefix</th>
                  <th>Pages</th>
                  <th>Last used</th>
                  <th>Expires</th>
                  <th>Status</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {tokens.map((token) => {
                  const state = tokenState(token);
                  return (
                    <tr key={token.id}>
                      <td>
                        <strong>{token.name}</strong>
                        <small className="status-editor-sub">Created by {token.created_by ?? "a removed user"} · {formatWhen(token.created_at)}</small>
                      </td>
                      <td className="nm-table-mono">{token.prefix}</td>
                      <td>{token.page_ids.length > 0 ? token.page_ids.map(pageName).join(", ") : "No pages"}</td>
                      <td>{token.last_used_at ? formatWhen(token.last_used_at) : "Never"}</td>
                      <td>{token.expires_at ? formatWhen(token.expires_at) : "Never"}</td>
                      <td><span className={`nm-status nm-status--${state.tone}`} title={state.title}>{state.label}</span></td>
                      <td className="status-pages-actions">
                        <div className="nm-table-actions">
                          {!token.revoked_at && <button type="button" className="nm-btn nm-btn--sm nm-btn--danger" onClick={() => void revoke(token)}>Revoke</button>}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {creating && pages && (
        <CreateTokenModal
          accessToken={accessToken}
          page={page}
          pages={pages}
          onCancel={() => setCreating(false)}
          onCreated={() => void load()}
          onDone={() => setCreating(false)}
        />
      )}
    </div>
  );
}
