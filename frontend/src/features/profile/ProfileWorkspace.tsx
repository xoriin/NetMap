import { useEffect, useState, type FormEvent } from "react";
import { Copy } from "lucide-react";
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

function ApiKeysPanel({ accessToken }: { accessToken: string }) {
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
      setKeys(await api.listApiKeys(accessToken));
      setKeysError(null);
    } catch (err) {
      setKeysError(err instanceof Error ? err.message : "Failed to load API keys");
    }
  }

  useEffect(() => {
    void loadKeys();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accessToken]);

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

  /** Only the prefix exists after creation — useful for matching audit entries. */
  async function copyPrefix(key: ApiKey) {
    try {
      await navigator.clipboard.writeText(`nm_${key.prefix}`);
      toast.success("Key prefix copied — the full key is only shown at creation");
    } catch {
      toast.error("Could not copy the key prefix");
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
    <div className="profile-section">
      <div className="profile-section-header">
        <h2>API keys</h2>
        <button type="button" className="nm-btn nm-btn--primary" onClick={() => setShowCreateModal(true)}>
          Create API key
        </button>
      </div>
      <p className="auth-field-hint">
        API keys let external scripts and integrations call the NetMap API with your permissions. Send the key in
        an <code>X-API-Key</code> header.
      </p>
      {keysError && <div className="form-error">{keysError}</div>}
      {activeKeys.length === 0
        ? <p className="auth-field-hint">You have no active API keys.</p>
        : (
          <div className="nm-table-wrap">
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
                        {/* The secret is never stored, so only the prefix can be
                            shown — the mask stands in for the unknown remainder. */}
                        <span className="profile-key-mask nm-table-mono">•••• •••• •••• ••••</span>
                        <span className="nm-table-mono">{key.prefix.slice(-4)}</span>
                        <button
                          type="button"
                          className="nm-btn nm-btn--sm nm-btn--ghost nm-btn--icon"
                          title="Copy key prefix"
                          aria-label={`Copy the key prefix for ${key.name}`}
                          onClick={() => void copyPrefix(key)}
                        >
                          <Copy size={13} />
                        </button>
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

      {showCreateModal && (
        <Modal
          title="Create API key"
          onCancel={() => { setShowCreateModal(false); setNewKeyName(""); setNewKeyExpiry(null); }}
          headerSubmitLabel={keysBusy ? "Creating…" : "Create key"}
          headerSubmitFormId="api-key-create-form"
          headerSubmitDisabled={keysBusy || !newKeyName.trim()}
        >
          <form id="api-key-create-form" className="modal-form" onSubmit={(e) => void createKey(e)}>
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
            <p className="form-error">
              Copy this key now — it will not be shown again.
            </p>
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
    </div>
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

  return (
    <section className="profile-layout">
      {/* One panel, divided into sections. These are all settings for the same
          page — giving each its own card added chrome without adding meaning. */}
      <div className="panel profile-panel">
        {/* Identity is stated once, up front. It used to be two disabled inputs
            buried among the editable fields, which read as broken form fields. */}
        <header className="profile-identity">
          <div className="profile-avatar">
            {avatarPreview
              ? <img src={avatarPreview} alt="Profile avatar" className="profile-avatar-img" />
              : <span className="profile-avatar-initials">{initials}</span>
            }
          </div>
          <div className="profile-identity-text">
            <h1 className="profile-identity-name">{user.display_name || user.username}</h1>
            <span className="profile-identity-username">@{user.username}</span>
            <div className="profile-identity-tags">
              <span className="nm-pill nm-pill--role">{roleLabel}</span>
              {user.auth_source === "oidc" && <span className="nm-pill nm-pill--sso">SSO</span>}
              {user.email && <span className="profile-identity-email">{user.email}</span>}
            </div>
          </div>
          <div className="profile-avatar-actions">
            <label className="profile-avatar-upload-btn">
              {avatarPreview ? "Change photo" : "Upload photo"}
              <input
                type="file"
                accept="image/*"
                style={{ display: "none" }}
                onChange={(e) => { const f = e.target.files?.[0]; if (f) handleAvatarFile(f); }}
              />
            </label>
            {avatarPreview && (
              <button type="button" className="profile-avatar-remove-btn" onClick={() => setAvatarPreview(null)}>
                Remove photo
              </button>
            )}
            <span className="profile-avatar-hint">Saved with account details</span>
          </div>
        </header>

        {/* One column. A profile is a short list of unrelated settings; side-by-side
            panels can never balance in height and leave dead space beside the
            shorter one. */}
        <div className="profile-split">
        <div className="profile-section">
          <h2>Account details</h2>
          <form className="profile-form" onSubmit={saveProfile}>
            <label className="profile-field-label">
              Display name
              <input
                className="profile-input"
                placeholder={user.username}
                value={displayName}
                maxLength={100}
                onChange={(e) => setDisplayName(e.target.value)}
              />
              <span className="profile-field-hint">Shown instead of your username across NetMap.</span>
            </label>

            <label className="profile-field-label">
              Email
              <input
                className="profile-input"
                type="email"
                maxLength={254}
                placeholder="you@example.com"
                value={profileEmail}
                onChange={(e) => setProfileEmail(e.target.value)}
              />
              <span className="profile-field-hint">Optional — used for password reset notifications.</span>
            </label>

            {profileError && <div className="form-error">{profileError}</div>}

            <div className="profile-form-actions">
              <button type="submit" className="nm-btn nm-btn--primary" disabled={profileBusy}>
                {profileBusy ? "Saving…" : "Save account details"}
              </button>
            </div>
          </form>
        </div>

        <div className="profile-section">
          <h2>Preferences</h2>
          <div className="profile-pref-row">
            <div className="profile-pref-text">
              <strong>Colour-coded columns</strong>
              <span>
                Show VLAN / group, location, and device type as coloured chips in the inventory
                table and device details. Turn this off for neutral grey chips instead.
              </span>
            </div>
            <div className="profile-pref-control">
              <EntityChip label="Servers" colorKey="Servers" />
              <button
                type="button"
                className={`nm-btn nm-btn--sm${entityColorsEnabled ? "" : " nm-btn--secondary"}`}
                disabled={colorPrefBusy}
                aria-pressed={entityColorsEnabled}
                onClick={() => void saveColorPreference(!entityColorsEnabled)}
              >
                {colorPrefBusy ? "Saving…" : entityColorsEnabled ? "On" : "Off"}
              </button>
            </div>
          </div>
        </div>
        </div>

        <div className="profile-section">
          <h2>Password</h2>
          <form className="profile-form" onSubmit={changePassword}>
          <div className="profile-field-row">
          <label className="profile-field-label">
            Current password
            <input
              className="profile-input"
              type="password"
              autoComplete="current-password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              required
            />
          </label>

          <label className="profile-field-label">
            New password
            <input
              className="profile-input"
              type="password"
              autoComplete="new-password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              minLength={12}
              required
            />
          </label>

          <label className="profile-field-label">
            Confirm new password
            <input
              className="profile-input"
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

        <ApiKeysPanel accessToken={accessToken} />
      </div>
    </section>
  );
}
