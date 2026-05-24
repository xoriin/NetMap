import { useState, type FormEvent } from "react";
import { Network } from "lucide-react";
import { api } from "../../api/client";

function LoginForm({
  onSubmit,
  appName,
  loginMessage,
  onForgotPassword,
}: {
  onSubmit: (username: string, password: string) => Promise<void>;
  appName?: string;
  loginMessage?: string;
  onForgotPassword: () => void;
}) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setFormError(null);
    setSubmitting(true);
    try {
      await onSubmit(username, password);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="auth-surface">
      <form className="auth-card" onSubmit={submit}>
        <div className="auth-brand">
          <div className="auth-brand-row">
            <div className="auth-brand-icon">
              <Network size={20} />
            </div>
            <span className="auth-brand-name">{appName || "NetMap"}</span>
          </div>
          <p className="auth-slogan">{loginMessage || "The Blueprint for Your Infrastructure"}</p>
        </div>
        <h2 className="auth-form-heading">Sign in</h2>
        <label>
          Username
          <input
            autoComplete="username"
            required
            value={username}
            onChange={(event) => setUsername(event.target.value)}
          />
        </label>
        <label>
          Password
          <input
            autoComplete="current-password"
            required
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>
        {formError && <div className="form-error">{formError}</div>}
        <button type="submit" disabled={submitting}>
          {submitting ? "Signing in..." : "Sign in"}
        </button>
        <button type="button" className="auth-forgot-link" onClick={onForgotPassword}>
          Forgot password?
        </button>
      </form>
    </section>
  );
}

function ForgotPasswordView({ onBack, appName }: { onBack: () => void; appName?: string }) {
  const [identifier, setIdentifier] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setFormError(null);
    setSubmitting(true);
    try {
      await api.requestPasswordReset(identifier);
      setSubmitted(true);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Unable to send reset email");
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
            <span className="auth-brand-name">{appName || "NetMap"}</span>
          </div>
        </div>
        {submitted ? (
          <>
            <h2 className="auth-form-heading">Check your email</h2>
            <p className="auth-reset-info">
              If an account matching <strong>{identifier}</strong> exists, a password reset link has been sent. Check your inbox and follow the link to set a new password.
            </p>
            <button type="button" onClick={onBack}>Back to sign in</button>
          </>
        ) : (
          <form onSubmit={(e) => void submit(e)}>
            <h2 className="auth-form-heading">Reset password</h2>
            <p className="auth-reset-info">
              Enter your username or email address. If an account exists, we'll send a reset link.
            </p>
            <label>
              Username or email
              <input
                required
                autoComplete="username email"
                value={identifier}
                onChange={(event) => setIdentifier(event.target.value)}
              />
            </label>
            {formError && <div className="form-error">{formError}</div>}
            <button type="submit" disabled={submitting}>
              {submitting ? "Sending..." : "Send reset link"}
            </button>
            <button type="button" className="auth-forgot-link" onClick={onBack}>
              Back to sign in
            </button>
          </form>
        )}
      </div>
    </section>
  );
}

export function LoginView({ onSubmit, appName, loginMessage }: { onSubmit: (username: string, password: string) => Promise<void>; appName?: string; loginMessage?: string }) {
  const [view, setView] = useState<"login" | "forgot">("login");

  if (view === "forgot") {
    return <ForgotPasswordView onBack={() => setView("login")} appName={appName} />;
  }

  return <LoginForm onSubmit={onSubmit} appName={appName} loginMessage={loginMessage} onForgotPassword={() => setView("forgot")} />;
}
