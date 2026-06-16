import { useState, type FormEvent } from "react";
import { api, type User } from "../../api/client";

export function ProfileWorkspace({
  accessToken,
  user,
  onUserUpdate,
}: {
  accessToken: string;
  user: User;
  onUserUpdate: (user: User) => void;
}) {
  const [displayName, setDisplayName] = useState(user.display_name ?? "");
  const [profileEmail, setProfileEmail] = useState(user.email ?? "");
  const [avatarPreview, setAvatarPreview] = useState<string | null>(user.avatar_data ?? null);
  const [profileBusy, setProfileBusy] = useState(false);
  const [profileSuccess, setProfileSuccess] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [pwBusy, setPwBusy] = useState(false);
  const [pwSuccess, setPwSuccess] = useState(false);
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
    setProfileSuccess(false);
    try {
      const updated = await api.updateProfile(accessToken, {
        display_name: displayName.trim() || null,
        avatar_data: avatarPreview,
        email: profileEmail.trim() || null,
      });
      onUserUpdate(updated);
      setProfileSuccess(true);
      setTimeout(() => setProfileSuccess(false), 3000);
    } catch (err) {
      setProfileError(err instanceof Error ? err.message : "Failed to save profile");
    } finally {
      setProfileBusy(false);
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
    setPwSuccess(false);
    try {
      await api.changePassword(accessToken, currentPassword, newPassword);
      setPwSuccess(true);
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setTimeout(() => setPwSuccess(false), 3000);
    } catch (err) {
      setPwError(err instanceof Error ? err.message : "Failed to change password");
    } finally {
      setPwBusy(false);
    }
  }

  const initials = (user.display_name || user.username).slice(0, 2).toUpperCase();

  return (
    <section className="profile-layout">
      <div className="profile-grid">
        <section className="panel profile-panel">
          <h2>Account details</h2>
          <form className="profile-form" onSubmit={saveProfile}>
            <div className="profile-avatar-row">
              <div className="profile-avatar">
                {avatarPreview
                  ? <img src={avatarPreview} alt="Profile avatar" className="profile-avatar-img" />
                  : <span className="profile-avatar-initials">{initials}</span>
                }
              </div>
              <div className="profile-avatar-actions">
                <label className="profile-avatar-upload-btn">
                  Upload photo
                  <input
                    type="file"
                    accept="image/*"
                    style={{ display: "none" }}
                    onChange={(e) => { const f = e.target.files?.[0]; if (f) handleAvatarFile(f); }}
                  />
                </label>
                {avatarPreview && (
                  <button type="button" className="profile-avatar-remove-btn" onClick={() => setAvatarPreview(null)}>
                    Remove
                  </button>
                )}
              </div>
            </div>

            <label className="profile-field-label">
              Username
              <input value={user.username} disabled className="profile-input" />
            </label>

            <label className="profile-field-label">
              Display name
              <input
                className="profile-input"
                placeholder={user.username}
                value={displayName}
                maxLength={100}
                onChange={(e) => setDisplayName(e.target.value)}
              />
            </label>

            <label className="profile-field-label">
              Email
              <input
                className="profile-input"
                type="email"
                maxLength={254}
                placeholder="Optional — used for password reset notifications"
                value={profileEmail}
                onChange={(e) => setProfileEmail(e.target.value)}
              />
            </label>

            <label className="profile-field-label">
              Role
              <input value={user.role} disabled className="profile-input" />
            </label>

            {profileError && <div className="form-error">{profileError}</div>}
            {profileSuccess && <div className="success-banner">Profile saved.</div>}

            <div className="profile-form-actions">
              <button type="submit" className="nm-btn nm-btn--primary" disabled={profileBusy}>
                {profileBusy ? "Saving…" : "Save profile"}
              </button>
            </div>
          </form>
        </section>

        <section className="panel profile-panel">
          <h2>Change password</h2>
          <form className="profile-form" onSubmit={changePassword}>
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

            {pwError && <div className="form-error">{pwError}</div>}
            {pwSuccess && <div className="success-banner">Password changed successfully.</div>}

            <div className="profile-form-actions">
              <button type="submit" className="nm-btn nm-btn--primary" disabled={pwBusy}>
                {pwBusy ? "Updating…" : "Change password"}
              </button>
            </div>
          </form>
        </section>
      </div>
    </section>
  );
}
