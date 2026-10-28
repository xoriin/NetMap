import { ChartViewsPreference } from "../../components/ChartViewsPreference";
import { useCallback, useEffect, useId, useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from "react";
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
import { api, ApiError, type ApiKey, type ApiKeyExpiryDays, type LinkedIdentity, type OidcStatus, type TotpSetup, type User } from "../../api/client";
import { useToast } from "../../components/Toast";
import { useConfirm } from "../../components/ConfirmDialog";
import { Modal } from "../../components/Modal";
import { RecoveryCodesView, TotpEnrolment } from "../auth/TotpEnrolment";
import { takeSsoProfileNotice } from "../auth/ssoCallback";
import { useTheme } from "../../providers/ThemeProvider";

const API_KEY_EXPIRY_OPTIONS: { label: string; value: ApiKeyExpiryDays }[] = [
  { label: "Never", value: null },
  { label: "30 days", value: 30 },
  { label: "90 days", value: 90 },
  { label: "365 days", value: 365 },
];

function formatKeyDate(value: string | null): string {
  return value ? new Date(value).toLocaleDateString() : "—";
}

/** Seconds until a 429 can be retried, from Retry-After or the "Retry in N seconds" detail. */
function retryAfterSeconds(err: ApiError): number | null {
  const fromDetail = typeof err.detail === "string" ? err.detail.match(/(\d+)\s*seconds?/i) : null;
  const seconds = err.retryAfterSeconds ?? (fromDetail ? Number(fromDetail[1]) : null);
  return seconds !== null && seconds > 0 ? seconds : null;
}

function retryText(seconds: number): string {
  return `Too many attempts. Try again in ${seconds} ${seconds === 1 ? "second" : "seconds"}.`;
}

/** A live "try again in N seconds" countdown for a 429. */
function useRetryCountdown() {
  const [until, setUntil] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (until === null) return;
    const timer = window.setInterval(() => {
      const current = Date.now();
      setNow(current);
      if (current >= until) setUntil(null);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [until]);
  const start = useCallback((seconds: number) => {
    const current = Date.now();
    setNow(current);
    setUntil(current + seconds * 1000);
  }, []);
  return { active: until !== null, seconds: until === null ? 0 : Math.max(0, Math.ceil((until - now) / 1000)), start };
}

type SsoModal = { kind: "link" } | { kind: "unlink"; identity: LinkedIdentity };

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
        title="API Access"
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
                        <span
                          className="profile-key-mask nm-table-mono"
                          title={key.suffix
                            ? "Only the final four characters are retained for identification"
                            : "The ending will appear after this legacy key is next successfully used"}
                        >
                          {key.suffix ? `•••• •••• •••• ${key.suffix}` : "•••• •••• •••• ••••"}
                        </span>
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
  const { darkStyle, setDarkStyle } = useTheme();
  const [displayName, setDisplayName] = useState(user.display_name ?? "");
  const [profileEmail, setProfileEmail] = useState(user.email ?? "");
  const [avatarPreview, setAvatarPreview] = useState<string | null>(user.avatar_data ?? null);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [avatarError, setAvatarError] = useState<string | null>(null);
  const avatarChanged = avatarPreview !== (user.avatar_data ?? null);
  const [colorPrefBusy, setColorPrefBusy] = useState(false);
  const entityColorsEnabled = user.entity_colors_enabled !== false;
  const [profileBusy, setProfileBusy] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);

  // Single sign-on: the link/unlink list comes from /auth/me/identities.
  const [identities, setIdentities] = useState<LinkedIdentity[] | null>(null);
  const [oidc, setOidc] = useState<OidcStatus | null>(null);
  const [ssoUnavailable, setSsoUnavailable] = useState(false);
  const [ssoEmailManaged, setSsoEmailManaged] = useState(false);
  const [identitiesFailed, setIdentitiesFailed] = useState(false);
  const linkedIdentity = identities?.[0] ?? null;
  const ssoEnabled = oidc?.enabled === true && !ssoUnavailable;

  // Email re-auth is picked by has_local_password alone (not auth_source, not
  // linked identities). With a NetMap password — linked to SSO or not — PATCH
  // /auth/me needs the current password, plus a code when 2FA is on. Without
  // one (SSO-only) the change is confirmed by signing in again at the provider
  // (POST /auth/me/email/sso), plus the code when 2FA is on; it's read-only
  // when SSO is off, no identity is linked, or the backend says the email is
  // managed (403). If the identities list fails to load, the SSO flow stays
  // and the backend's 403 decides.
  const hasLocalPassword = user.has_local_password !== false;
  const noIdentityLinked = identities !== null && !identitiesFailed && identities.length === 0;
  const emailReadOnly = !hasLocalPassword && (ssoEmailManaged || ssoUnavailable || oidc?.enabled === false || noIdentityLinked);
  const ssoEmail = !hasLocalPassword && !emailReadOnly;
  const savedEmail = user.email ?? null;
  const emailEdited = (profileEmail.trim() || null) !== savedEmail;
  const emailChanged = hasLocalPassword && emailEdited;
  const ssoEmailChanged = ssoEmail && emailEdited;
  const needsReauthCode = (emailChanged || ssoEmailChanged) && user.totp_enabled === true;
  const [reauthPassword, setReauthPassword] = useState("");
  const [reauthCode, setReauthCode] = useState("");
  const [reauthError, setReauthError] = useState<{ field: "password" | "code"; message: string } | null>(null);
  const [retryUntil, setRetryUntil] = useState<number | null>(null);
  const [retryNow, setRetryNow] = useState(() => Date.now());
  const retrySeconds = retryUntil === null ? 0 : Math.max(0, Math.ceil((retryUntil - retryNow) / 1000));
  const reauthIds = useId();
  const emailHintId = `${reauthIds}-email-hint`;
  const passwordHintId = `${reauthIds}-password-hint`;
  const passwordErrorId = `${reauthIds}-password-error`;
  const codeHintId = `${reauthIds}-code-hint`;
  const codeErrorId = `${reauthIds}-code-error`;
  const profileErrorId = `${reauthIds}-profile-error`;

  useEffect(() => {
    if (retryUntil === null) return;
    const timer = window.setInterval(() => {
      const now = Date.now();
      setRetryNow(now);
      if (now >= retryUntil) setRetryUntil(null);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [retryUntil]);

  function clearReauth() {
    setReauthPassword("");
    setReauthCode("");
    setReauthError(null);
  }

  function changeProfileEmail(value: string) {
    setProfileEmail(value);
    // Reverting to the saved email hides the re-auth fields; don't keep secrets around.
    if ((value.trim() || null) === savedEmail) clearReauth();
  }

  const [ssoNotice, setSsoNotice] = useState<string | null>(null);
  const [ssoModal, setSsoModal] = useState<SsoModal | null>(null);
  const [ssoPassword, setSsoPassword] = useState("");
  const [ssoCode, setSsoCode] = useState("");
  const [ssoBusy, setSsoBusy] = useState(false);
  const [ssoError, setSsoError] = useState<{ field: "password" | "code" | null; message: string } | null>(null);
  const ssoRetry = useRetryCountdown();
  const ssoIds = useId();
  const ssoPasswordErrorId = `${ssoIds}-password-error`;
  const ssoCodeErrorId = `${ssoIds}-code-error`;
  const ssoFormErrorId = `${ssoIds}-form-error`;

  const loadIdentities = useCallback(() => {
    api.myIdentities(accessToken)
      .then((list) => { setIdentities(list); setIdentitiesFailed(false); })
      .catch(() => { setIdentities([]); setIdentitiesFailed(true); });
  }, [accessToken]);

  useEffect(() => {
    loadIdentities();
    let cancelled = false;
    api.oidcStatus().then((status) => { if (!cancelled) setOidc(status); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [loadIdentities]);

  // The single sign-on callback's outcome (link, email change, or why it failed).
  useEffect(() => {
    const notice = takeSsoProfileNotice();
    if (!notice) return;
    if (notice.tone === "success") toast.success(notice.message);
    else setSsoNotice(notice.message);
  }, [toast]);

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [pwBusy, setPwBusy] = useState(false);
  const [pwError, setPwError] = useState<string | null>(null);
  const [activeKeyCount, setActiveKeyCount] = useState<number | null>(null);

  const [totpModal, setTotpModal] = useState<"setup" | "disable" | "regenerate" | null>(null);
  const [totpPassword, setTotpPassword] = useState("");
  const [totpCode, setTotpCode] = useState("");
  const [totpBusy, setTotpBusy] = useState(false);
  const [totpError, setTotpError] = useState<string | null>(null);
  const [newCodes, setNewCodes] = useState<string[] | null>(null);
  const [totpSetup, setTotpSetup] = useState<TotpSetup | null>(null);
  const [setupCodesShown, setSetupCodesShown] = useState(false);
  const totpSession = useRef(0);
  const refreshUser = useCallback(() => {
    void api.me(accessToken).then(onUserUpdate).catch(() => undefined);
  }, [accessToken, onUserUpdate]);
  const startTotp = useCallback(
    () => (totpSetup ? Promise.resolve(totpSetup) : Promise.reject(new Error("Setup has not started"))),
    [totpSetup],
  );
  const confirmTotp = useCallback(async (code: string) => {
    const result = await api.confirmMyTotp(accessToken, code);
    refreshUser();
    return result.recovery_codes;
  }, [accessToken, refreshUser]);

  function handleAvatarFile(file: File) {
    if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
      setAvatarError("Please select a PNG, JPEG, or WebP image.");
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      setAvatarError("Image must be under 2 MB.");
      return;
    }
    const reader = new FileReader();
    reader.onload = (e) => {
      const result = e.target?.result as string;
      setAvatarPreview(result);
      setAvatarError(null);
    };
    reader.onerror = () => setAvatarError("Unable to read this image. Please try again.");
    reader.readAsDataURL(file);
  }

  async function saveAvatar() {
    setAvatarBusy(true);
    setAvatarError(null);
    try {
      const updated = await api.updateProfile(accessToken, { avatar_data: avatarPreview });
      onUserUpdate(updated);
      toast.success("Photo saved");
    } catch (err) {
      setAvatarError(err instanceof Error ? err.message : "Failed to save photo");
    } finally {
      setAvatarBusy(false);
    }
  }

  async function saveProfile(event: FormEvent) {
    event.preventDefault();
    if (retryUntil !== null) return;
    setProfileBusy(true);
    setProfileError(null);
    setReauthError(null);
    try {
      if (ssoEmailChanged) {
        if ((displayName.trim() || null) !== (user.display_name ?? null)) {
          onUserUpdate(await api.updateProfile(accessToken, { display_name: displayName.trim() || null }));
        }
        const { authorize_url } = await api.startSsoEmailChange(
          accessToken,
          profileEmail.trim(),
          needsReauthCode ? reauthCode.trim() : undefined,
        );
        // The provider sends the browser back to /?sso_email=changed (or ?sso_error=).
        window.location.assign(authorize_url);
        return;
      }
      const updated = await api.updateProfile(accessToken, {
        display_name: displayName.trim() || null,
        email: profileEmail.trim() || null,
        // Re-auth fields go only with an email change, never otherwise.
        ...(emailChanged ? { current_password: reauthPassword } : {}),
        ...(needsReauthCode ? { totp_code: reauthCode.trim() } : {}),
      });
      onUserUpdate(updated);
      clearReauth();
      toast.success("Profile saved");
    } catch (err) {
      const detail = err instanceof ApiError && typeof err.detail === "string" ? err.detail : null;
      if (err instanceof ApiError && err.status === 429) {
        const fromDetail = detail?.match(/(\d+)\s*seconds?/i);
        const seconds = err.retryAfterSeconds ?? (fromDetail ? Number(fromDetail[1]) : null);
        if (seconds !== null && seconds > 0) {
          const now = Date.now();
          setRetryNow(now);
          setRetryUntil(now + seconds * 1000);
        } else {
          setProfileError(detail ?? "Too many attempts. Try again later.");
        }
      } else if (err instanceof ApiError && err.status === 401 && (emailChanged || ssoEmailChanged) && detail) {
        // 401s on /auth/ paths never refresh or sign out (see recoverExpiredToken).
        if (/^authentication code is (required|incorrect)/i.test(detail)) setReauthError({ field: "code", message: detail });
        else if (/^current password/i.test(detail)) setReauthError({ field: "password", message: detail });
        else setProfileError(detail);
      } else if (err instanceof ApiError && err.status === 409 && (emailChanged || ssoEmailChanged) && detail) {
        // The account's password state changed under us: show why and reload it.
        setProfileError(detail);
        refreshUser();
      } else if (err instanceof ApiError && err.status === 403 && ssoEmailChanged) {
        // SSO is off or no identity is linked any more: the email is read-only.
        setSsoEmailManaged(true);
        setProfileEmail(savedEmail ?? "");
        clearReauth();
        setProfileError(detail ?? "Your email is managed by your identity provider or an administrator");
      } else if (err instanceof ApiError && ssoEmailChanged && detail) {
        setProfileError(detail);
      } else {
        setProfileError(err instanceof Error ? err.message : "Failed to save profile");
      }
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

  function resetTotpModal(kind: "setup" | "disable" | "regenerate" | null) {
    totpSession.current += 1;
    setTotpModal(kind);
    setTotpPassword("");
    setTotpCode("");
    setTotpBusy(false);
    setTotpError(null);
    setNewCodes(null);
    setTotpSetup(null);
    setSetupCodesShown(false);
  }

  function openTotpModal(kind: "setup" | "disable" | "regenerate") {
    resetTotpModal(kind);
  }

  function closeTotpModal() {
    resetTotpModal(null);
    refreshUser();
  }

  async function submitTotpSetupPassword(event: FormEvent) {
    event.preventDefault();
    const session = totpSession.current;
    setTotpBusy(true);
    setTotpError(null);
    try {
      const setup = await api.startMyTotp(accessToken, totpPassword);
      if (session === totpSession.current) {
        setTotpPassword("");
        setTotpSetup(setup);
      }
    } catch (err) {
      if (session === totpSession.current) setTotpError(err instanceof Error ? err.message : "Unable to start setup");
    } finally {
      if (session === totpSession.current) setTotpBusy(false);
    }
  }

  async function submitTotpManage(event: FormEvent) {
    event.preventDefault();
    const session = totpSession.current;
    const kind = totpModal;
    setTotpBusy(true);
    setTotpError(null);
    try {
      if (kind === "disable") {
        await api.disableMyTotp(accessToken, totpPassword, totpCode);
        refreshUser();
        toast.success("Two-factor authentication turned off");
        if (session === totpSession.current) resetTotpModal(null);
      } else {
        const result = await api.regenerateRecoveryCodes(accessToken, totpPassword, totpCode);
        refreshUser();
        if (session === totpSession.current) setNewCodes(result.recovery_codes);
      }
    } catch (err) {
      if (session === totpSession.current) setTotpError(err instanceof Error ? err.message : "Unable to update two-factor authentication");
    } finally {
      if (session === totpSession.current) setTotpBusy(false);
    }
  }

  function openSsoModal(modal: SsoModal) {
    setSsoModal(modal);
    setSsoPassword("");
    setSsoCode("");
    setSsoBusy(false);
    setSsoError(null);
  }

  function closeSsoModal() {
    setSsoModal(null);
    setSsoPassword("");
    setSsoCode("");
    setSsoError(null);
  }

  async function submitSso(event: FormEvent) {
    event.preventDefault();
    if (!ssoModal || ssoRetry.active) return;
    setSsoBusy(true);
    setSsoError(null);
    const payload = {
      current_password: ssoPassword,
      ...(user.totp_enabled ? { totp_code: ssoCode.trim() } : {}),
    };
    try {
      if (ssoModal.kind === "link") {
        const { authorize_url } = await api.linkMyIdentity(accessToken, payload);
        // The provider sends the browser back to /?sso_link=linked (or ?sso_error=).
        window.location.assign(authorize_url);
        return;
      }
      await api.unlinkMyIdentity(accessToken, ssoModal.identity.id, payload);
      // Other sessions were revoked and this device got new cookies; adopt them.
      await api.refresh().catch(() => undefined);
      closeSsoModal();
      loadIdentities();
      refreshUser();
      toast.success("Single sign-on unlinked");
    } catch (err) {
      const detail = err instanceof ApiError && typeof err.detail === "string" ? err.detail : null;
      if (err instanceof ApiError && err.status === 429) {
        const seconds = retryAfterSeconds(err);
        if (seconds !== null) ssoRetry.start(seconds);
        else setSsoError({ field: null, message: detail ?? "Too many attempts. Try again later." });
      } else if (err instanceof ApiError && err.status === 401 && detail) {
        // 401s on /auth/ paths never refresh or sign out (see recoverExpiredToken).
        if (/^authentication code is required/i.test(detail)) setSsoError({ field: "code", message: detail });
        else if (/^current password/i.test(detail)) setSsoError({ field: "password", message: detail });
        else setSsoError({ field: null, message: detail });
      } else if (err instanceof ApiError && err.status === 404 && ssoModal.kind === "link") {
        setSsoUnavailable(true);
        setSsoError({ field: null, message: "Single sign-on isn't enabled on this server, so there's nothing to link." });
      } else if (err instanceof ApiError && err.status === 409) {
        loadIdentities();
        setSsoError({ field: null, message: detail ?? "Single sign-on can't be changed right now." });
      } else {
        setSsoError({ field: null, message: detail ?? (err instanceof Error ? err.message : "Unable to update single sign-on") });
      }
    } finally {
      setSsoBusy(false);
    }
  }

  const canUnlinkSso = !(oidc?.enabled && oidc.require_sso && user.role !== "SuperAdmin");
  const ssoProvider = linkedIdentity?.provider_name || oidc?.provider_name || "your identity provider";
  const showSsoRows = identities !== null && (identities.length > 0 || ssoEnabled);

  const initials = (user.display_name || user.username).slice(0, 2).toUpperCase();

  const roleLabel = user.role.replace(/_/g, " ");
  const completedProfileFields = [displayName.trim(), profileEmail.trim(), avatarPreview].filter(Boolean).length;
  const profileCompleteness = Math.round((completedProfileFields / 3) * 100);
  const signInLabel = hasLocalPassword ? "Local password" : "Single sign-on";

  return (
    <section className="profile-layout">
      {ssoNotice && (
        <div className="nm-alert nm-alert--error" role="alert">
          <AlertTriangle size={17} aria-hidden="true" />
          <span>{ssoNotice}</span>
          <button type="button" className="nm-btn nm-btn--sm nm-btn--ghost" onClick={() => setSsoNotice(null)}>Dismiss</button>
        </div>
      )}
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
                  disabled={avatarBusy}
                  accept="image/png,image/jpeg,image/webp"
                  className="profile-avatar-file"
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) handleAvatarFile(f); e.target.value = ""; }}
                />
              </label>
              {avatarPreview && (
                <button type="button" className="nm-btn nm-btn--ghost nm-btn--sm" disabled={avatarBusy} onClick={() => { setAvatarPreview(null); setAvatarError(null); }}>
                  Remove photo
                </button>
              )}
              {avatarChanged && (
                <button type="button" className="nm-btn nm-btn--primary" disabled={avatarBusy || profileBusy || colorPrefBusy} onClick={() => void saveAvatar()}>
                  {avatarBusy ? "Saving…" : "Save photo"}
                </button>
              )}
            </div>
            {avatarError && <div className="form-error" role="alert">{avatarError}</div>}
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
          <span><strong>Sign-in method</strong><b>{signInLabel}</b><small>{hasLocalPassword ? "Password protected" : "Managed by your identity provider"}</small></span>
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
            <ProfilePanelHeader icon={UserRound} title="Account Details" />
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
                  readOnly={emailReadOnly}
                  aria-describedby={emailHintId}
                  onChange={(e) => changeProfileEmail(e.target.value)}
                />
                <span className="profile-field-hint" id={emailHintId}>
                  {emailReadOnly
                    ? "Managed by your identity provider or an administrator."
                    : ssoEmailChanged
                      ? `You'll confirm this change by signing in again with ${ssoProvider}.`
                      : "Optional — used for password reset notifications."}
                </span>
              </label>
              {emailChanged && (
                <label className="nm-field">
                  Current password
                  <input
                    className="nm-input"
                    type="password"
                    name="current-password"
                    autoComplete="current-password"
                    required
                    maxLength={256}
                    value={reauthPassword}
                    aria-invalid={reauthError?.field === "password" || undefined}
                    aria-describedby={reauthError?.field === "password" ? `${passwordHintId} ${passwordErrorId}` : passwordHintId}
                    onChange={(e) => setReauthPassword(e.target.value)}
                  />
                  <span className="profile-field-hint" id={passwordHintId}>Required to change your email.</span>
                </label>
              )}
              {emailChanged && reauthError?.field === "password" && (
                <div className="form-error" role="alert" id={passwordErrorId}>{reauthError.message}</div>
              )}
              {needsReauthCode && (
                <label className="nm-field">
                  Authentication code
                  <input
                    className="nm-input"
                    name="one-time-code"
                    autoComplete="one-time-code"
                    required
                    maxLength={32}
                    value={reauthCode}
                    aria-invalid={reauthError?.field === "code" || undefined}
                    aria-describedby={reauthError?.field === "code" ? `${codeHintId} ${codeErrorId}` : codeHintId}
                    onChange={(e) => setReauthCode(e.target.value)}
                  />
                  <span className="profile-field-hint" id={codeHintId}>From your authenticator app. You can also use a recovery code.</span>
                </label>
              )}
              {needsReauthCode && reauthError?.field === "code" && (
                <div className="form-error" role="alert" id={codeErrorId}>{reauthError.message}</div>
              )}
                </div>

                {retryUntil !== null ? (
                  <div className="form-error" role="alert" id={profileErrorId}>
                    Too many attempts. Try again in {retrySeconds} {retrySeconds === 1 ? "second" : "seconds"}.
                  </div>
                ) : (
                  profileError && <div className="form-error" role="alert" id={profileErrorId}>{profileError}</div>
                )}

                <div className="profile-form-actions">
                  <button
                    type="submit"
                    className="nm-btn nm-btn--primary"
                    disabled={profileBusy || avatarBusy || retryUntil !== null}
                    aria-describedby={retryUntil !== null || profileError ? profileErrorId : undefined}
                  >
                    {profileBusy ? "Saving…" : ssoEmailChanged ? `Confirm with ${ssoProvider}` : "Save account details"}
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
              <ChartViewsPreference />
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
                    disabled={colorPrefBusy || avatarBusy}
                    aria-pressed={entityColorsEnabled}
                    onClick={() => void saveColorPreference(!entityColorsEnabled)}
                  >
                    {colorPrefBusy ? "Saving…" : entityColorsEnabled ? "Enabled" : "Disabled"}
                  </button>
                </div>
              </div>
              <div className="profile-pref-row">
                <div className="profile-pref-text">
                  <strong>Dark mode style</strong>
                  <span>Slate is cool blue-grey; Zinc is neutral charcoal. Saved in this browser.</span>
                </div>
                <div className="profile-pref-control">
                  <span className="profile-pref-options" role="group" aria-label="Dark mode style">
                  {(["slate", "zinc"] as const).map((style) => (
                    <button
                      key={style}
                      type="button"
                      className={`nm-btn nm-btn--sm${darkStyle === style ? " nm-btn--active" : " nm-btn--secondary"}`}
                      aria-pressed={darkStyle === style}
                      onClick={() => setDarkStyle(style)}
                    >
                      {style === "slate" ? "Slate" : "Zinc"}
                    </button>
                  ))}
                  </span>
                </div>
              </div>
            </div>
          </section>

          <section className="profile-security-panel profile-panel nm-app-panel">
            <ProfilePanelHeader icon={ShieldCheck} title="Account Security" />
            <div className="profile-security-list">
              <div className="profile-security-row">
                <span><strong>Sign-in method</strong><small>How this account authenticates</small></span>
                <span className="nm-pill">{signInLabel}</span>
              </div>
              <div className="profile-security-row">
                <span><strong>Password access</strong><small>{hasLocalPassword ? "Can be updated on this page" : "Managed by your provider"}</small></span>
                <span className={`nm-pill ${hasLocalPassword ? "nm-pill--online" : "nm-pill--sso"}`}>{hasLocalPassword ? "Protected" : "SSO"}</span>
              </div>
              {hasLocalPassword && (
                <div className="profile-security-row">
                  <span>
                    <strong>Two-factor authentication</strong>
                    <small>
                      {user.totp_enabled
                        ? `${user.recovery_codes_remaining ?? 0} recovery ${(user.recovery_codes_remaining ?? 0) === 1 ? "code" : "codes"} left${user.totp_required ? " · Required by your administrator" : ""}`
                        : user.totp_required ? "Required by your administrator" : "Ask for a code from your authenticator app when you sign in"}
                    </small>
                  </span>
                  <span className="profile-security-actions">
                    <span className={`nm-pill${user.totp_enabled ? " nm-pill--online" : ""}`}>{user.totp_enabled ? "On" : "Off"}</span>
                    {!user.totp_enabled && <button type="button" className="nm-btn nm-btn--sm nm-btn--secondary" onClick={() => openTotpModal("setup")}>Set up</button>}
                    {user.totp_enabled && <button type="button" className="nm-btn nm-btn--sm nm-btn--secondary" onClick={() => openTotpModal("regenerate")}>New recovery codes</button>}
                    {user.totp_enabled && !user.totp_required && <button type="button" className="nm-btn nm-btn--sm nm-btn--danger" onClick={() => openTotpModal("disable")}>Turn off</button>}
                  </span>
                </div>
              )}
              {identities && showSsoRows && identities.length === 0 && (
                <div className="profile-security-row">
                  <span><strong>Single sign-on</strong><small>Also sign in with {ssoProvider}</small></span>
                  <span className="profile-security-actions">
                    <span className="nm-pill">Not linked</span>
                    <button type="button" className="nm-btn nm-btn--sm nm-btn--secondary" onClick={() => openSsoModal({ kind: "link" })}>Link</button>
                  </span>
                </div>
              )}
              {identities && showSsoRows && identities.map((identity) => (
                <div className="profile-security-row" key={identity.id}>
                  <span>
                    <strong>Single sign-on</strong>
                    <small>
                      {[identity.provider_name, identity.email, identity.last_login_at ? `Last used ${formatKeyDate(identity.last_login_at)}` : `Linked ${formatKeyDate(identity.created_at)}`]
                        .filter(Boolean)
                        .join(" · ")}
                    </small>
                    {!hasLocalPassword && <small>Set a NetMap password before unlinking single sign-on.</small>}
                  </span>
                  <span className="profile-security-actions">
                    <span className="nm-pill nm-pill--online">Linked</span>
                    {canUnlinkSso && hasLocalPassword && (
                      <button type="button" className="nm-btn nm-btn--sm nm-btn--danger" aria-label={`Unlink ${identity.provider_name}`} onClick={() => openSsoModal({ kind: "unlink", identity })}>Unlink</button>
                    )}
                  </span>
                </div>
              ))}
              <div className="profile-security-row">
                <span><strong>API access</strong><small>Keys inherit your account permissions</small></span>
                <span className="nm-pill">{activeKeyCount ?? "—"} active</span>
              </div>
            </div>
            {hasLocalPassword && user.totp_enabled && (user.recovery_codes_remaining ?? 0) <= 2 && (
              <div className="profile-security-alert nm-alert nm-alert--warning" role="note">
                <AlertTriangle size={17} aria-hidden="true" />
                <span>You're running low on recovery codes. Generate new ones so you don't get locked out.</span>
              </div>
            )}
          </section>
        </div>
      </div>

      <ApiKeysPanel accessToken={accessToken} onActiveCountChange={setActiveKeyCount} />

      {totpModal === "setup" && (
        <Modal title="Set up two-factor authentication" onCancel={closeTotpModal} dismissible={!setupCodesShown}>
          {totpSetup ? (
            <div className="modal-form">
              <TotpEnrolment start={startTotp} confirm={confirmTotp} onDone={closeTotpModal} onRecoveryCodes={() => setSetupCodesShown(true)} buttonClassName="nm-btn nm-btn--primary" linkClassName="nm-btn nm-btn--sm nm-btn--ghost" doneLabel="Done" />
            </div>
          ) : (
            <form className="modal-form" onSubmit={(e) => void submitTotpSetupPassword(e)}>
              <label className="nm-field">
                Current password
                <input className="nm-input" type="password" autoComplete="current-password" autoFocus required value={totpPassword} onChange={(e) => setTotpPassword(e.target.value)} />
              </label>
              {totpError && <div className="form-error">{totpError}</div>}
              <div className="profile-form-actions">
                <button type="submit" className="nm-btn nm-btn--primary" disabled={totpBusy}>Continue</button>
              </div>
            </form>
          )}
        </Modal>
      )}
      {(totpModal === "disable" || totpModal === "regenerate") && (
        <Modal title={totpModal === "disable" ? "Turn off two-factor authentication" : "New recovery codes"} onCancel={closeTotpModal} dismissible={!newCodes}>
          {newCodes ? (
            <div className="modal-form">
              <RecoveryCodesView codes={newCodes} onDone={closeTotpModal} buttonClassName="nm-btn nm-btn--primary" linkClassName="nm-btn nm-btn--sm nm-btn--ghost" doneLabel="Done" />
            </div>
          ) : (
            <form className="modal-form" onSubmit={(e) => void submitTotpManage(e)}>
              <label className="nm-field">
                Current password
                <input className="nm-input" type="password" autoComplete="current-password" required value={totpPassword} onChange={(e) => setTotpPassword(e.target.value)} />
              </label>
              <label className="nm-field">
                Authentication code
                <input className="nm-input" autoComplete="one-time-code" required value={totpCode} onChange={(e) => setTotpCode(e.target.value)} />
                <span className="profile-field-hint">You can also use a recovery code.</span>
              </label>
              {totpError && <div className="form-error">{totpError}</div>}
              <div className="profile-form-actions">
                <button type="submit" className={`nm-btn ${totpModal === "disable" ? "nm-btn--danger" : "nm-btn--primary"}`} disabled={totpBusy}>
                  {totpModal === "disable" ? "Turn off" : "Generate new codes"}
                </button>
              </div>
            </form>
          )}
        </Modal>
      )}
      {ssoModal && (
        <Modal title={ssoModal.kind === "link" ? "Link single sign-on" : "Unlink single sign-on"} onCancel={closeSsoModal}>
          <form className="modal-form" onSubmit={(e) => void submitSso(e)}>
            <label className="nm-field">
              Current password
              <input
                className="nm-input"
                type="password"
                autoComplete="current-password"
                autoFocus
                required
                maxLength={256}
                value={ssoPassword}
                aria-invalid={ssoError?.field === "password" || undefined}
                aria-describedby={ssoError?.field === "password" ? ssoPasswordErrorId : undefined}
                onChange={(e) => setSsoPassword(e.target.value)}
              />
              <span className="profile-field-hint">
                {ssoModal.kind === "link"
                  ? `Next, you'll sign in with ${ssoProvider} to finish linking.`
                  : "Unlinking signs you out on your other devices."}
              </span>
            </label>
            {ssoError?.field === "password" && <div className="form-error" role="alert" id={ssoPasswordErrorId}>{ssoError.message}</div>}
            {user.totp_enabled && (
              <label className="nm-field">
                Authentication code
                <input
                  className="nm-input"
                  autoComplete="one-time-code"
                  required
                  maxLength={32}
                  value={ssoCode}
                  aria-invalid={ssoError?.field === "code" || undefined}
                  aria-describedby={ssoError?.field === "code" ? ssoCodeErrorId : undefined}
                  onChange={(e) => setSsoCode(e.target.value)}
                />
                <span className="profile-field-hint">You can also use a recovery code.</span>
              </label>
            )}
            {ssoError?.field === "code" && <div className="form-error" role="alert" id={ssoCodeErrorId}>{ssoError.message}</div>}
            {ssoRetry.active ? (
              <div className="form-error" role="alert" id={ssoFormErrorId}>{retryText(ssoRetry.seconds)}</div>
            ) : (
              ssoError?.field === null && <div className="form-error" role="alert" id={ssoFormErrorId}>{ssoError.message}</div>
            )}
            <div className="profile-form-actions">
              <button
                type="submit"
                className={`nm-btn ${ssoModal.kind === "unlink" ? "nm-btn--danger" : "nm-btn--primary"}`}
                disabled={ssoBusy || ssoRetry.active || (ssoModal.kind === "link" && ssoUnavailable)}
                aria-describedby={ssoRetry.active || ssoError?.field === null ? ssoFormErrorId : undefined}
              >
                {ssoBusy ? "Checking…" : ssoModal.kind === "link" ? `Continue to ${ssoProvider}` : "Unlink"}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </section>
  );
}
