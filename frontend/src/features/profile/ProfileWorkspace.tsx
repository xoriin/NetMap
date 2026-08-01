import { useEffect, useState, type CSSProperties, type FormEvent, type ReactNode } from "react";
import "./profile.css";
import {
  AlertTriangle,
  Camera,
  CircleUserRound,
  KeyRound,
  LockKeyhole,
  Palette,
  ShieldCheck,
  UserRound,
  type LucideIcon,
} from "lucide-react";
import { EntityChip } from "../../components/EntityChip";
import { api, type ApiKey, type ApiKeyExpiryDays, type User } from "../../api/client";
import { useToast } from "../../components/Toast";
import { useConfirm } from "../../components/ConfirmDialog";
import { Modal } from "../../components/Modal";

const API_KEY_EXPIRY_OPTIONS: { label: string; value: ApiKeyExpiryDays }[] = [
  { label: "Never", value: null },
  { label: "30 days", value: 30 },
  { label: "90 days", value: 90 },
  { label: "365 days", value: 365 },
];

function formatKeyDate(value: string | null): string {
  return value ? new Date(value).toLocaleDateString() : "—";
}

function ProfilePanelHeader({
  icon: Icon,
  title,
  action,
}: {
  icon: LucideIcon;
  title: string;
  action?: ReactNode;
}) {
  return (
    <header className="profile-panel-header nm-app-panel-header">
      <span className="profile-panel-title">
        <span className="profile-panel-icon"><Icon size={18} /></span>
        <span aria-hidden="true">-</span>
        <strong>{title}</strong>
      </span>
      {action && <span className="profile-panel-action">{action}</span>}
    </header>
  );
}

function ApiKeysPanel({ accessToken, onActiveCountChange }: { accessToken: string; onActiveCountChange: (count: number) => void }) {
  const toast = useToast();
  const confirmAction = useConfirm();
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [keysError, setKeysError] = useState<string | null>(null);
  const [keysBusy, setKeysBusy] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [newKeyName, setNewKeyName] = useState("");
  const [newKeyExpiry, setNewKeyExpiry] = useState<ApiKeyExpiryDays>(null);
  const [createdKey, setCreatedKey] = useState<string | null>(null);

  async function loadKeys() {
    try {
      const loaded = await api.listApiKeys(accessToken);
      setKeys(loaded);
      onActiveCountChange(loaded.filter((key) => key.revoked_at === null).length);
      setKeysError(null);
    } catch (err) {
      setKeysError(err instanceof Error ? err.message : "Failed to load API keys");
    }
  }

  useEffect(() => {
    void loadKeys();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accessToken, onActiveCountChange]);

  async function createKey(event: FormEvent) {
    event.preventDefault();
    if (!newKeyName.trim()) return;
    setKeysBusy(true);
    try {
      const created = await api.createApiKey(accessToken, newKeyName.trim(), newKeyExpiry);
      setShowCreateModal(false);
      setNewKeyName("");
      setNewKeyExpiry(null);
      setCreatedKey(created.key);
      await loadKeys();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to create API key");
    } finally {
      setKeysBusy(false);
    }
  }

  async function revokeKey(key: ApiKey) {
    const confirmed = await confirmAction({
      title: "Revoke this API key?",
      message: `"${key.name}" will stop working immediately.`,
      detail: "Any integration or script using this key will lose access to NetMap. This cannot be undone.",
      confirmLabel: "Revoke key",
      danger: true,
    });
    if (!confirmed) return;
    setKeysBusy(true);
    try {
      await api.revokeApiKey(accessToken, key.id);
      toast.success("API key revoked");
      await loadKeys();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to revoke API key");
    } finally {
      setKeysBusy(false);
    }
  }

  async function copyCreatedKey() {
    if (!createdKey) return;
    try {
      await navigator.clipboard.writeText(createdKey);
      toast.success("API key copied to clipboard");
    } catch {
      toast.error("Could not copy — select and copy the key manually");
    }
  }

  const activeKeys = keys.filter((key) => key.revoked_at === null);

  return (
    <section className="profile-api-panel profile-panel nm-app-panel">
      <ProfilePanelHeader
        icon={KeyRound}
        title="API access"
        action={(
          <button type="button" className="nm-btn nm-btn--primary" onClick={() => setShowCreateModal(true)}>
            Create API key
          </button>
        )}
      />
      <div className="profile-panel-body">
        <div className="profile-section-intro">
          <span className="profile-intro-icon"><ShieldCheck size={18} /></span>
          <span>
            <strong>Authenticated external access</strong>
            <small>Use an <code>X-API-Key</code> header to call NetMap with your current account permissions.</small>
          </span>
        </div>
      {keysError && <div className="form-error">{keysError}</div>}
      {activeKeys.length === 0
        ? (
          <div className="profile-empty-state">
            <KeyRound size={22} />
            <span><strong>No active API keys</strong><small>Create a key when a script or integration needs access.</small></span>
          </div>
        )
        : (
          <div className="profile-key-table nm-table-wrap">
            <table className="nm-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Key</th>
                  <th>Created</th>
                  <th>Expires</th>
                  <th>Last used</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {activeKeys.map((key) => (
                  <tr key={key.id}>
                    <td>{key.name}</td>
                    <td>
                      <span className="profile-key-cell">
                        <span className="profile-key-mask nm-table-mono">•••• •••• •••• ••••</span>
                      </span>
                    </td>
                    <td>{formatKeyDate(key.created_at)}</td>
                    <td>{key.expires_at ? formatKeyDate(key.expires_at) : "Never"}</td>
                    <td>{key.last_used_at ? new Date(key.last_used_at).toLocaleString() : "Never"}</td>
                    <td className="nm-table-actions">
                      <button
                        type="button"
                        className="nm-btn nm-btn--sm nm-btn--danger"
                        disabled={keysBusy}
                        onClick={() => void revokeKey(key)}
                      >
                        Revoke
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {showCreateModal && (
        <Modal
          title="Create API key"
          onCancel={() => { setShowCreateModal(false); setNewKeyName(""); setNewKeyExpiry(null); }}
          headerSubmitLabel={keysBusy ? "Creating…" : "Create key"}
          headerSubmitFormId="api-key-create-form"
          headerSubmitDisabled={keysBusy || !newKeyName.trim()}
        >
          <form id="api-key-create-form" className="modal-form" onSubmit={(e) => void createKey(e)}>
            <div className="nm-alert nm-alert--warning" role="note">
              <AlertTriangle size={17} aria-hidden="true" />
              <span>The complete key will be shown once after creation. Copy it before closing that window because it cannot be retrieved later.</span>
            </div>
            <label>
              Name
              <input
                maxLength={100}
                placeholder="e.g. monitoring-script"
                value={newKeyName}
                onChange={(e) => setNewKeyName(e.target.value)}
                required
              />
            </label>
            <label>
              Expiration
              <select
                value={newKeyExpiry === null ? "" : String(newKeyExpiry)}
                onChange={(e) => setNewKeyExpiry(e.target.value === "" ? null : (Number(e.target.value) as ApiKeyExpiryDays))}
              >
                {API_KEY_EXPIRY_OPTIONS.map((option) => (
                  <option key={option.label} value={option.value === null ? "" : String(option.value)}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
          </form>
        </Modal>
      )}

      {createdKey && (
        <Modal title="API key created" onCancel={() => setCreatedKey(null)}>
          <div className="modal-form">
            <div className="nm-alert nm-alert--warning" role="alert">
              <AlertTriangle size={17} aria-hidden="true" />
              <span><strong>Copy this key now.</strong> It will never be shown again and cannot be recovered after this window closes.</span>
            </div>
            <label>
              Your new API key
              <input className="nm-table-mono" readOnly value={createdKey} onFocus={(e) => e.target.select()} />
            </label>
            <div className="profile-form-actions">
              <button type="button" className="nm-btn nm-btn--primary" onClick={() => void copyCreatedKey()}>
                Copy to clipboard
              </button>
              <button type="button" className="nm-btn nm-btn--secondary" onClick={() => setCreatedKey(null)}>
                Done
              </button>
            </div>
          </div>
        </Modal>
      )}
    </section>
  );
}

export function ProfileWorkspace({
  accessToken,
  user,
  onUserUpdate,
}: {
  accessToken: string;
  user: User;
  onUserUpdate: (user: User) => void;
}) {
  const toast = useToast();
  const [displayName, setDisplayName] = useState(user.display_name ?? "");
  const [profileEmail, setProfileEmail] = useState(user.email ?? "");
  const [avatarPreview, setAvatarPreview] = useState<string | null>(user.avatar_data ?? null);
  const [colorPrefBusy, setColorPrefBusy] = useState(false);
  const entityColorsEnabled = user.entity_colors_enabled !== false;
  const [profileBusy, setProfileBusy] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [pwBusy, setPwBusy] = useState(false);
  const [pwError, setPwError] = useState<string | null>(null);
  const [activeKeyCount, setActiveKeyCount] = useState<number | null>(null);

  function handleAvatarFile(file: File) {
    if (!file.type.startsWith("image/")) {
      setProfileError("Please select an image file.");
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      setProfileError("Image must be under 2 MB.");
      return;
    }
    const reader = new FileReader();
    reader.onload = (e) => {
      const result = e.target?.result as string;
      setAvatarPreview(result);
      setProfileError(null);
    };
    reader.readAsDataURL(file);
  }

  async function saveProfile(event: FormEvent) {
    event.preventDefault();
    setProfileBusy(true);
    setProfileError(null);
    try {
      const updated = await api.updateProfile(accessToken, {
        display_name: displayName.trim() || null,
        avatar_data: avatarPreview,
        email: profileEmail.trim() || null,
      });
      onUserUpdate(updated);
      toast.success("Profile saved");
    } catch (err) {
      setProfileError(err instanceof Error ? err.message : "Failed to save profile");
    } finally {
      setProfileBusy(false);
    }
  }

  // Saved immediately rather than on "Save profile" — it's a preference the
  // user wants to see take effect, not a form field.
  async function saveColorPreference(next: boolean) {
    setColorPrefBusy(true);
    setProfileError(null);
    try {
      const updated = await api.updateProfile(accessToken, { entity_colors_enabled: next });
      onUserUpdate(updated);
      toast.success(next ? "Colour-coded columns on" : "Colour-coded columns off");
    } catch (err) {
      setProfileError(err instanceof Error ? err.message : "Failed to save preference");
    } finally {
      setColorPrefBusy(false);
    }
  }

  async function changePassword(event: FormEvent) {
    event.preventDefault();
    if (newPassword !== confirmPassword) {
      setPwError("New passwords do not match.");
      return;
    }
    setPwBusy(true);
    setPwError(null);
    try {
      await api.changePassword(accessToken, currentPassword, newPassword);
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      toast.success("Password changed successfully");
    } catch (err) {
      setPwError(err instanceof Error ? err.message : "Failed to change password");
    } finally {
      setPwBusy(false);
    }
  }

  const initials = (user.display_name || user.username).slice(0, 2).toUpperCase();

  const roleLabel = user.role.replace(/_/g, " ");
  const completedProfileFields = [displayName.trim(), profileEmail.trim(), avatarPreview].filter(Boolean).length;
  const profileCompleteness = Math.round((completedProfileFields / 3) * 100);
  const signInLabel = user.auth_source === "oidc" ? "Single sign-on" : "Local password";

  return (
    <section className="profile-layout">
      <section className="profile-identity-panel nm-app-panel">
        <div className="profile-identity">
          <div className="profile-avatar">
            {avatarPreview
              ? <img src={avatarPreview} alt="Profile avatar" className="profile-avatar-img" />
              : <span className="profile-avatar-initials">{initials}</span>
            }
          </div>
          <div className="profile-identity-text">
            <h2 className="profile-identity-name">{user.display_name || user.username}</h2>
            <span className="profile-identity-username">@{user.username}</span>
            <div className="profile-identity-tags">
              <span className="nm-pill nm-pill--role">{roleLabel}</span>
              {user.auth_source === "oidc" && <span className="nm-pill nm-pill--sso">SSO</span>}
              {profileEmail && <span className="profile-identity-email">{profileEmail}</span>}
            </div>
          </div>
          <div className="profile-avatar-actions">
            <div className="profile-photo-actions">
              <label className="nm-btn nm-btn--secondary profile-avatar-upload-btn">
                <Camera size={15} />
                {avatarPreview ? "Change photo" : "Upload photo"}
                <input
                  type="file"
                  accept="image/*"
                  className="profile-avatar-file"
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) handleAvatarFile(f); }}
                />
              </label>
              {avatarPreview && (
                <button type="button" className="nm-btn nm-btn--ghost nm-btn--sm" onClick={() => setAvatarPreview(null)}>
                  Remove photo
                </button>
              )}
            </div>
            <span className="profile-avatar-hint">Saved with account details</span>
          </div>
        </div>
      </section>

      <section className="profile-summary-band nm-app-panel" aria-label="Account summary">
        <div className="profile-summary-item profile-summary-item--progress">
          <span
            className="profile-completeness-ring"
            style={{ "--profile-progress": `${profileCompleteness * 3.6}deg` } as CSSProperties}
          >
            <span>{profileCompleteness}%</span>
          </span>
          <span><strong>Profile completeness</strong><small>{profileCompleteness === 100 ? "Account details complete" : "Add a name, email, and photo"}</small></span>
        </div>
        <div className="profile-summary-item">
          <span className="profile-summary-icon is-security"><ShieldCheck size={19} /></span>
          <span><strong>Sign-in method</strong><b>{signInLabel}</b><small>{user.auth_source === "oidc" ? "Managed by your identity provider" : "Password protected"}</small></span>
        </div>
        <div className="profile-summary-item">
          <span className="profile-summary-icon is-api"><KeyRound size={19} /></span>
          <span><strong>Active API keys</strong><b>{activeKeyCount ?? "—"}</b><small>{activeKeyCount == null ? "Loading key status…" : activeKeyCount === 1 ? "1 key can access NetMap" : `${activeKeyCount} keys can access NetMap`}</small></span>
        </div>
        <div className="profile-summary-item">
          <span className="profile-summary-icon is-role"><CircleUserRound size={19} /></span>
          <span><strong>Access level</strong><b>{roleLabel}</b><small>Permissions follow this role</small></span>
        </div>
      </section>

      <div className="profile-settings-grid">
        <div className="profile-settings-column">
          <section className="profile-account-panel profile-panel nm-app-panel">
            <ProfilePanelHeader icon={UserRound} title="Account details" />
            <div className="profile-panel-body">
              <form className="profile-form" onSubmit={saveProfile}>
                <div className="profile-account-fields">
              <label className="nm-field">
                Display name
                <input
                  className="nm-input"
                  placeholder={user.username}
                  value={displayName}
                  maxLength={100}
                  onChange={(e) => setDisplayName(e.target.value)}
                />
                <span className="profile-field-hint">Shown instead of your username across NetMap.</span>
              </label>

              <label className="nm-field">
                Email
                <input
                  className="nm-input"
                  type="email"
                  maxLength={254}
                  placeholder="you@example.com"
                  value={profileEmail}
                  onChange={(e) => setProfileEmail(e.target.value)}
                />
                <span className="profile-field-hint">Optional — used for password reset notifications.</span>
              </label>
                </div>

                {profileError && <div className="form-error">{profileError}</div>}

                <div className="profile-form-actions">
                  <button type="submit" className="nm-btn nm-btn--primary" disabled={profileBusy}>
                    {profileBusy ? "Saving…" : "Save account details"}
                  </button>
                </div>
              </form>
            </div>
          </section>
          <section className="profile-password-panel profile-panel nm-app-panel">
            <ProfilePanelHeader icon={LockKeyhole} title="Password" />
            <div className="profile-panel-body">
              <form className="profile-form" onSubmit={changePassword}>
                <div className="profile-password-fields">
                  <label className="nm-field">
                    Current password
                    <input
                      className="nm-input"
                      type="password"
                      autoComplete="current-password"
                      value={currentPassword}
                      onChange={(e) => setCurrentPassword(e.target.value)}
                      required
                    />
                  </label>

                  <label className="nm-field">
                    New password
                    <input
                      className="nm-input"
                      type="password"
                      autoComplete="new-password"
                      value={newPassword}
                      onChange={(e) => setNewPassword(e.target.value)}
                      minLength={12}
                      required
                    />
                  </label>

                  <label className="nm-field">
                    Confirm new password
                    <input
                      className="nm-input"
                      type="password"
                      autoComplete="new-password"
                      value={confirmPassword}
                      onChange={(e) => setConfirmPassword(e.target.value)}
                      required
                    />
                  </label>
                </div>

                {pwError && <div className="form-error">{pwError}</div>}

                <div className="profile-form-actions">
                  <button type="submit" className="nm-btn nm-btn--primary" disabled={pwBusy}>
                    {pwBusy ? "Updating…" : "Change password"}
                  </button>
                </div>
              </form>
            </div>
          </section>
        </div>

        <div className="profile-settings-column profile-settings-column--side">
          <section className="profile-preferences-panel profile-panel nm-app-panel">
            <ProfilePanelHeader icon={Palette} title="Preferences" />
            <div className="profile-panel-body">
              <div className="profile-pref-row">
                <div className="profile-pref-text">
                  <strong>Colour-coded entities</strong>
                  <span>Show groups, locations, and device types as coloured chips throughout NetMap.</span>
                </div>
                <div className="profile-pref-control">
                  <EntityChip label="Servers" colorKey="Servers" />
                  <button
                    type="button"
                    className={`nm-btn nm-btn--sm${entityColorsEnabled ? " nm-btn--active" : " nm-btn--secondary"}`}
                    disabled={colorPrefBusy}
                    aria-pressed={entityColorsEnabled}
                    onClick={() => void saveColorPreference(!entityColorsEnabled)}
                  >
                    {colorPrefBusy ? "Saving…" : entityColorsEnabled ? "Enabled" : "Disabled"}
                  </button>
                </div>
              </div>
            </div>
          </section>

          <section className="profile-security-panel profile-panel nm-app-panel">
            <ProfilePanelHeader icon={ShieldCheck} title="Account security" />
            <div className="profile-security-list">
              <div className="profile-security-row">
                <span><strong>Sign-in method</strong><small>How this account authenticates</small></span>
                <span className="nm-pill">{signInLabel}</span>
              </div>
              <div className="profile-security-row">
                <span><strong>Password access</strong><small>{user.auth_source === "oidc" ? "Managed by your provider" : "Can be updated on this page"}</small></span>
                <span className={`nm-pill ${user.auth_source === "oidc" ? "nm-pill--sso" : "nm-pill--online"}`}>{user.auth_source === "oidc" ? "SSO" : "Protected"}</span>
              </div>
              <div className="profile-security-row">
                <span><strong>API access</strong><small>Keys inherit your account permissions</small></span>
                <span className="nm-pill">{activeKeyCount ?? "—"} active</span>
              </div>
            </div>
          </section>
        </div>
      </div>

      <ApiKeysPanel accessToken={accessToken} onActiveCountChange={setActiveKeyCount} />
    </section>
  );
}
