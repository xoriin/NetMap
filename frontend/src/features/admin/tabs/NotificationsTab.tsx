import { useState, type FormEvent } from "react";
import { IconCloud } from "@tabler/icons-react";
import { api, type NotificationProfile } from "../../../api/client";
import { useApiQuery } from "../../../hooks/useApiQuery";
import { Modal } from "../../../components/Modal";
import {
  notificationMethodCatalog, appriseSupportedMethods, emptyProfileForm,
  providerForMethod, buildNotificationConfig, profileFormIsComplete,
  populateFormFromProfile, notificationProfileMethodLabel,
  type NotificationMethodId, type NotificationProfileForm,
} from "../notificationProfiles";

export function NotificationsTab({
  accessToken,
  onError,
  onSuccess,
}: {
  accessToken: string;
  onError: (message: string | null) => void;
  onSuccess: (message: string | null) => void;
}) {
  const [profileForm, setProfileForm] = useState<NotificationProfileForm>(emptyProfileForm);
  const [profileTestResult, setProfileTestResult] = useState<Record<number, string>>({});
  const [profileBusy, setProfileBusy] = useState(false);
  const [editingProfileId, setEditingProfileId] = useState<number | null>(null);
  const [showProfileModal, setShowProfileModal] = useState(false);

  const profilesQuery = useApiQuery(() => api.listNotificationProfiles(accessToken), [accessToken]);
  const notificationProfiles = profilesQuery.data ?? [];

  async function saveNotificationProfile(event: FormEvent) {
    event.preventDefault();
    setProfileBusy(true);
    onError(null); onSuccess(null);
    try {
      if (editingProfileId !== null) {
        const isApprise = providerForMethod(profileForm.method) === "apprise";
        const hasCredentials = !isApprise || profileFormIsComplete(profileForm);
        const updated = await api.updateNotificationProfile(accessToken, editingProfileId, {
          name: profileForm.name.trim(),
          enabled: profileForm.enabled,
          ...(hasCredentials && {
            provider: providerForMethod(profileForm.method),
            config: buildNotificationConfig(profileForm),
          }),
        });
        profilesQuery.setData((current) => (current ?? []).map((p) => p.id === updated.id ? updated : p));
        setProfileForm(emptyProfileForm);
        setEditingProfileId(null);
        setShowProfileModal(false);
        onSuccess(`Notification method "${updated.name}" updated.`);
      } else {
        const profile = await api.createNotificationProfile(accessToken, {
          name: profileForm.name.trim(),
          provider: providerForMethod(profileForm.method),
          enabled: profileForm.enabled,
          config: buildNotificationConfig(profileForm),
        });
        profilesQuery.setData((current) => [...(current ?? []), profile].sort((a, b) => a.name.localeCompare(b.name)));
        setProfileForm(emptyProfileForm);
        setShowProfileModal(false);
        onSuccess(`Notification method "${profile.name}" created.`);
      }
    } catch (err) {
      onError(err instanceof Error ? err.message : editingProfileId !== null ? "Unable to update notification method" : "Unable to create notification method");
    } finally {
      setProfileBusy(false);
    }
  }

  async function toggleNotificationProfile(profile: NotificationProfile) {
    setProfileBusy(true);
    onError(null); onSuccess(null);
    try {
      const updated = await api.updateNotificationProfile(accessToken, profile.id, { enabled: !profile.enabled });
      profilesQuery.setData((current) => (current ?? []).map((item) => item.id === updated.id ? updated : item));
    } catch (err) {
      onError(err instanceof Error ? err.message : "Unable to update notification profile");
    } finally {
      setProfileBusy(false);
    }
  }

  async function deleteNotificationProfile(profile: NotificationProfile) {
    setProfileBusy(true);
    onError(null); onSuccess(null);
    try {
      await api.deleteNotificationProfile(accessToken, profile.id);
      profilesQuery.setData((current) => (current ?? []).filter((item) => item.id !== profile.id));
      onSuccess(`Notification profile "${profile.name}" deleted.`);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Unable to delete notification profile");
    } finally {
      setProfileBusy(false);
    }
  }

  async function testNotificationProfile(profile: NotificationProfile) {
    setProfileTestResult((current) => ({ ...current, [profile.id]: "Sending…" }));
    try {
      const result = await api.testNotificationProfile(accessToken, profile.id);
      setProfileTestResult((current) => ({ ...current, [profile.id]: result.status === "ok" ? "Sent successfully" : result.status }));
    } catch (err) {
      setProfileTestResult((current) => ({ ...current, [profile.id]: err instanceof Error ? err.message : "Failed" }));
    }
  }

  return (
    <div className="admin-tab-content">
      <section className="panel admin-panel nm-app-panel admin-panel-separated">
        <div className="admin-panel-header nm-app-panel-header">
          <h2 className="admin-section-title notif-provider-heading"><IconCloud size={16} />Notification methods</h2>
          <div className="admin-panel-actions">
            <button
              type="button"
              className="nm-btn nm-btn--primary"
              onClick={() => { setEditingProfileId(null); setProfileForm(emptyProfileForm); setShowProfileModal(true); }}
            >
              + Add method
            </button>
            <button type="button" className="nm-btn" disabled={profileBusy} onClick={() => void profilesQuery.reload()}>
              Refresh
            </button>
          </div>
        </div>
        <p className="tool-note">Create reusable notification methods. Common services have guided fields; Custom Apprise URL covers the wider Apprise catalog.</p>
        <details className="notif-apprise-details">
          <summary>Services available via Custom Apprise URL</summary>
          <p className="tool-note" style={{ margin: '6px 0 0' }}>{appriseSupportedMethods.join(", ")} and more.</p>
        </details>
        <div className="notif-methods-table">
          {notificationProfiles.length === 0 ? (
            <p className="audit-empty">No notification methods configured yet. Click <strong>+ Add method</strong> to get started.</p>
          ) : notificationProfiles.map((profile) => (
            <div className="notif-method-row" key={profile.id}>
              <div className="notif-method-info">
                <span className="notif-method-name">{profile.name}</span>
                <div className="notif-method-meta">
                  <span className="notif-method-tag">{notificationProfileMethodLabel(profile)}</span>
                  <span className={`notif-status-badge notif-status-badge--${profile.enabled ? "active" : "off"}`}>
                    {profile.enabled ? "Active" : "Disabled"}
                  </span>
                </div>
                {profileTestResult[profile.id] && (
                  <span className={`notif-result${profileTestResult[profile.id] === "Sent successfully" ? " ok" : " err"}`} style={{ display: "block", marginTop: 5 }}>
                    {profileTestResult[profile.id]}
                  </span>
                )}
              </div>
              <div className="notif-method-actions">
                <button type="button" className="nm-btn nm-btn--sm nm-btn--secondary" disabled={profileBusy} onClick={() => void testNotificationProfile(profile)}>
                  Test
                </button>
                <button type="button" className="nm-btn nm-btn--sm nm-btn--secondary" disabled={profileBusy} onClick={() => { setEditingProfileId(profile.id); setProfileForm(populateFormFromProfile(profile)); setShowProfileModal(true); }}>
                  Edit
                </button>
                <button type="button" className="nm-btn nm-btn--sm nm-btn--secondary" disabled={profileBusy} onClick={() => void toggleNotificationProfile(profile)}>
                  {profile.enabled ? "Disable" : "Enable"}
                </button>
                <button type="button" className="nm-btn nm-btn--sm nm-btn--danger" disabled={profileBusy} onClick={() => void deleteNotificationProfile(profile)}>
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      </section>

      {showProfileModal && (
        <Modal
          title={editingProfileId !== null ? `Edit — ${profileForm.name || "notification method"}` : "Add notification method"}
          onCancel={() => { setShowProfileModal(false); setEditingProfileId(null); setProfileForm(emptyProfileForm); }}
          headerSubmitLabel={profileBusy ? "Saving…" : editingProfileId !== null ? "Update" : "Save"}
          headerSubmitFormId="notif-profile-form"
          headerSubmitDisabled={profileBusy || (editingProfileId === null ? !profileFormIsComplete(profileForm) : !profileForm.name.trim())}
        >
          <form id="notif-profile-form" className="modal-form" onSubmit={saveNotificationProfile}>
            <div className="notif-modal-type-section">
              <label>
                Notification type
                <select
                  value={profileForm.method}
                  onChange={(e) => setProfileForm((c) => ({ ...c, method: e.target.value as NotificationMethodId }))}
                >
                  {notificationMethodCatalog.map((m) => (
                    <option key={m.id} value={m.id}>{m.label}</option>
                  ))}
                </select>
              </label>
              <p className="notif-modal-type-desc">
                {notificationMethodCatalog.find((m) => m.id === profileForm.method)?.description}
              </p>
            </div>
            <label>
              Name
              <input required maxLength={120} placeholder="e.g. Home Alerts" value={profileForm.name} onChange={(e) => setProfileForm((c) => ({ ...c, name: e.target.value }))} />
            </label>
            {providerForMethod(profileForm.method) === "apprise" && (
              <label>
                Title <span className="tool-note">(optional — shown in notification)</span>
                <input maxLength={80} placeholder="NetMap" value={profileForm.title} onChange={(e) => setProfileForm((c) => ({ ...c, title: e.target.value }))} />
              </label>
            )}
            {profileForm.method === "ntfy" && (
              <div className="modal-form-row">
                <label>
                  Topic URL
                  <input required placeholder="https://ntfy.sh/my-topic" value={profileForm.ntfy_url} onChange={(e) => setProfileForm((c) => ({ ...c, ntfy_url: e.target.value }))} />
                </label>
                <label>
                  Access token <span className="tool-note">(optional)</span>
                  <input type="password" placeholder="tk_..." value={profileForm.ntfy_token} onChange={(e) => setProfileForm((c) => ({ ...c, ntfy_token: e.target.value }))} />
                </label>
              </div>
            )}
            {profileForm.method === "telegram" && (
              <div className="modal-form-row">
                <label>
                  Bot token
                  <input required type="password" placeholder="123456:ABC-DEF..." value={profileForm.telegram_bot_token} onChange={(e) => setProfileForm((c) => ({ ...c, telegram_bot_token: e.target.value }))} />
                </label>
                <label>
                  Chat ID
                  <input required placeholder="-100123456789" value={profileForm.telegram_chat_id} onChange={(e) => setProfileForm((c) => ({ ...c, telegram_chat_id: e.target.value }))} />
                </label>
              </div>
            )}
            {profileForm.method === "signal" && (
              <>
                <label>
                  REST API URL
                  <input required placeholder="http://localhost:8080" value={profileForm.signal_url} onChange={(e) => setProfileForm((c) => ({ ...c, signal_url: e.target.value }))} />
                </label>
                <div className="modal-form-row">
                  <label>
                    Sender number
                    <input required placeholder="+447700000000" value={profileForm.signal_number} onChange={(e) => setProfileForm((c) => ({ ...c, signal_number: e.target.value }))} />
                  </label>
                  <label>
                    Recipient number
                    <input required placeholder="+447700000001" value={profileForm.signal_recipient} onChange={(e) => setProfileForm((c) => ({ ...c, signal_recipient: e.target.value }))} />
                  </label>
                </div>
              </>
            )}
            {profileForm.method === "smtp" && (
              <>
                <div className="modal-form-row">
                  <label>
                    SMTP host
                    <input required placeholder="smtp.gmail.com" value={profileForm.smtp_host} onChange={(e) => setProfileForm((c) => ({ ...c, smtp_host: e.target.value }))} />
                  </label>
                  <label>
                    Port
                    <input placeholder="587" value={profileForm.smtp_port} onChange={(e) => setProfileForm((c) => ({ ...c, smtp_port: e.target.value }))} />
                  </label>
                </div>
                <div className="modal-form-row">
                  <label>
                    Username
                    <input placeholder="you@example.com" value={profileForm.smtp_user} onChange={(e) => setProfileForm((c) => ({ ...c, smtp_user: e.target.value }))} />
                  </label>
                  <label>
                    Password
                    <input type="password" value={profileForm.smtp_password} onChange={(e) => setProfileForm((c) => ({ ...c, smtp_password: e.target.value }))} />
                  </label>
                </div>
                <div className="modal-form-row">
                  <label>
                    From address
                    <input placeholder="netmap@example.com" value={profileForm.smtp_from} onChange={(e) => setProfileForm((c) => ({ ...c, smtp_from: e.target.value }))} />
                  </label>
                  <label>
                    Send alerts to
                    <input required placeholder="admin@example.com" value={profileForm.smtp_to} onChange={(e) => setProfileForm((c) => ({ ...c, smtp_to: e.target.value }))} />
                  </label>
                </div>
                <label className="checkbox-label">
                  <input type="checkbox" checked={profileForm.smtp_tls} onChange={(e) => setProfileForm((c) => ({ ...c, smtp_tls: e.target.checked }))} />
                  <span>Use STARTTLS</span>
                </label>
              </>
            )}
            {profileForm.method === "discord" && (
              <div className="modal-form-row">
                <label>
                  Webhook ID
                  <input required type="password" value={profileForm.discord_webhook_id} onChange={(e) => setProfileForm((c) => ({ ...c, discord_webhook_id: e.target.value }))} />
                </label>
                <label>
                  Webhook token
                  <input required type="password" value={profileForm.discord_webhook_token} onChange={(e) => setProfileForm((c) => ({ ...c, discord_webhook_token: e.target.value }))} />
                </label>
              </div>
            )}
            {profileForm.method === "slack" && (
              <>
                <div className="modal-form-row">
                  <label>
                    Token A
                    <input required type="password" placeholder="T00000000" value={profileForm.slack_token_a} onChange={(e) => setProfileForm((c) => ({ ...c, slack_token_a: e.target.value }))} />
                  </label>
                  <label>
                    Token B
                    <input required type="password" placeholder="B00000000" value={profileForm.slack_token_b} onChange={(e) => setProfileForm((c) => ({ ...c, slack_token_b: e.target.value }))} />
                  </label>
                </div>
                <div className="modal-form-row">
                  <label>
                    Token C
                    <input required type="password" placeholder="XXXXXXXXXXXXXXXX" value={profileForm.slack_token_c} onChange={(e) => setProfileForm((c) => ({ ...c, slack_token_c: e.target.value }))} />
                  </label>
                  <label>
                    Channel <span className="tool-note">(optional)</span>
                    <input placeholder="#alerts" value={profileForm.slack_channel} onChange={(e) => setProfileForm((c) => ({ ...c, slack_channel: e.target.value }))} />
                  </label>
                </div>
              </>
            )}
            {profileForm.method === "gotify" && (
              <div className="modal-form-row">
                <label>
                  Server URL
                  <input required placeholder="https://gotify.example.com" value={profileForm.gotify_base_url} onChange={(e) => setProfileForm((c) => ({ ...c, gotify_base_url: e.target.value }))} />
                </label>
                <label>
                  App token
                  <input required type="password" value={profileForm.gotify_token} onChange={(e) => setProfileForm((c) => ({ ...c, gotify_token: e.target.value }))} />
                </label>
              </div>
            )}
            {profileForm.method === "pushover" && (
              <div className="modal-form-row">
                <label>
                  User key
                  <input required type="password" value={profileForm.pushover_user_key} onChange={(e) => setProfileForm((c) => ({ ...c, pushover_user_key: e.target.value }))} />
                </label>
                <label>
                  Application token
                  <input required type="password" value={profileForm.pushover_app_token} onChange={(e) => setProfileForm((c) => ({ ...c, pushover_app_token: e.target.value }))} />
                </label>
              </div>
            )}
            {profileForm.method === "google_chat" && (
              <>
                <div className="modal-form-row">
                  <label>
                    Workspace
                    <input required type="password" value={profileForm.google_chat_workspace} onChange={(e) => setProfileForm((c) => ({ ...c, google_chat_workspace: e.target.value }))} />
                  </label>
                  <label>
                    Webhook key
                    <input required type="password" value={profileForm.google_chat_key} onChange={(e) => setProfileForm((c) => ({ ...c, google_chat_key: e.target.value }))} />
                  </label>
                </div>
                <label>
                  Webhook token
                  <input required type="password" value={profileForm.google_chat_token} onChange={(e) => setProfileForm((c) => ({ ...c, google_chat_token: e.target.value }))} />
                </label>
              </>
            )}
            {profileForm.method === "webhook" && (
              <>
                <label>
                  Webhook URL
                  <input required placeholder="https://example.com/netmap-alerts" value={profileForm.webhook_url} onChange={(e) => setProfileForm((c) => ({ ...c, webhook_url: e.target.value }))} />
                </label>
                <label>
                  Bearer token (optional)
                  <input type="password" value={profileForm.webhook_token} onChange={(e) => setProfileForm((c) => ({ ...c, webhook_token: e.target.value }))} />
                </label>
                <p className="tool-note">{'NetMap sends a POST request with the JSON body {"title": "NetMap", "message": "…"}.'}</p>
              </>
            )}
            {profileForm.method === "custom" && (
              <label>
                Apprise URL
                <input required type="password" placeholder="jsons://example.com/webhook" value={profileForm.custom_url} onChange={(e) => setProfileForm((c) => ({ ...c, custom_url: e.target.value }))} />
              </label>
            )}
            {editingProfileId !== null && providerForMethod(profileForm.method) === "apprise" && (
              <p className="tool-note">Leave credential fields blank to keep existing values.</p>
            )}
            <label className="checkbox-label">
              <input type="checkbox" checked={profileForm.enabled} onChange={(e) => setProfileForm((c) => ({ ...c, enabled: e.target.checked }))} />
              <span>Enabled</span>
            </label>
          </form>
        </Modal>
      )}
    </div>
  );
}
