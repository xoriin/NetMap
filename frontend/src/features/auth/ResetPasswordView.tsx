import { useState, type FormEvent } from "react";
import { Network } from "lucide-react";
import { api } from "../../api/client";

export function ResetPasswordView({ resetToken, onSuccess }: { resetToken: string; onSuccess: () => void }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (password !== confirm) {
      setFormError("Passwords do not match");
      return;
    }
    setFormError(null);
    setSubmitting(true);
    try {
      await api.resetPasswordWithToken(resetToken, password);
      setDone(true);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Unable to reset password — the link may have expired");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="auth-surface">
      <div className="auth-card">
        <div className="auth-brand">
          <div className="auth-brand-row">
            <div className="auth-brand-icon"><Network size={20} /></div>
            <span className="auth-brand-name">NetMap</span>
          </div>
        </div>
        {done ? (
          <>
            <h2 className="auth-form-heading">Password Updated</h2>
            <p className="auth-reset-info">Your password has been reset. You can now sign in with your new password.</p>
            <button type="button" onClick={onSuccess}>Go to sign in</button>
          </>
        ) : (
          <form onSubmit={(e) => void submit(e)}>
            <h2 className="auth-form-heading">Set New Password</h2>
            <p className="auth-reset-info">Choose a strong password of at least 12 characters.</p>
            <label>
              New password
              <input
                required
                type="password"
                minLength={12}
                autoComplete="new-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </label>
            <label>
              Confirm new password
              <input
                required
                type="password"
                minLength={12}
                autoComplete="new-password"
                value={confirm}
                onChange={(event) => setConfirm(event.target.value)}
              />
            </label>
            {formError && <div className="form-error">{formError}</div>}
            <button type="submit" disabled={submitting}>
              {submitting ? "Resetting..." : "Reset password"}
            </button>
          </form>
        )}
      </div>
    </section>
  );
}
