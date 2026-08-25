import { useEffect, useState, type FormEvent } from "react";
import { LogIn } from "lucide-react";
import { api, type OidcStatus } from "../../api/client";

const SSO_ERROR_MESSAGES: Record<string, string> = {
  provider_unreachable: "Could not reach the identity provider. Try again or contact your administrator.",
  provider_denied: "Sign-in was cancelled or denied at the identity provider.",
  provider_error: "The identity provider returned an error. Please try again.",
  invalid_state: "The sign-in attempt expired or was invalid. Please try again.",
  email_unverified: "Your email address is not verified with the identity provider.",
  email_domain_denied: "Your email domain is not allowed to sign in here.",
  email_missing: "The identity provider did not supply an email address for your account.",
  account_not_linked: "No NetMap account is linked to this identity. Contact your administrator.",
  account_disabled: "This account is disabled. Contact your administrator.",
  sso_disabled: "Single sign-on is not enabled on this server.",
};

function ssoErrorMessage(code: string): string {
  return SSO_ERROR_MESSAGES[code] ?? "Single sign-on failed a security check. Please try again or contact your administrator.";
}

function consumeSsoErrorParam(): string | null {
  const params = new URLSearchParams(window.location.search);
  const code = params.get("sso_error");
  if (!code) return null;
  params.delete("sso_error");
  const query = params.toString();
  window.history.replaceState(null, "", `${window.location.pathname}${query ? `?${query}` : ""}`);
  return ssoErrorMessage(code);
}

function SsoButton({ providerName }: { providerName: string }) {
  return (
    <a
      href="/api/v1/auth/oidc/login"
      className="auth-sso-btn"
    >
      <LogIn size={16} aria-hidden="true" />
      Continue with {providerName}
    </a>
  );
}

function LoginForm({
  onSubmit,
  appName,
  loginMessage,
  onForgotPassword,
  oidc,
  ssoError,
}: {
  onSubmit: (username: string, password: string) => Promise<void>;
  appName?: string;
  loginMessage?: string;
  onForgotPassword: () => void;
  oidc: OidcStatus | null;
  ssoError: string | null;
}) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [showLocalForm, setShowLocalForm] = useState(false);

  const ssoEnabled = oidc?.enabled === true;
  const ssoRequired = ssoEnabled && oidc?.require_sso === true;
  const localFormVisible = !ssoRequired || showLocalForm;

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
              <img src="/favicon.svg" width="32" height="32" alt="" />
            </div>
            <span className="auth-brand-name">{appName || "NetMap"}</span>
          </div>
          <p className="auth-slogan">{loginMessage || "The Blueprint for Your Infrastructure"}</p>
        </div>
        <h2 className="auth-form-heading">Sign in</h2>
        {ssoError && <div className="form-error">{ssoError}</div>}
        {ssoRequired && <SsoButton providerName={oidc?.provider_name || "SSO"} />}
        {localFormVisible && (
          <>
            <label>
              Username
              <input
                autoComplete="username"
                autoFocus={!ssoRequired}
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
          </>
        )}
        {ssoEnabled && !ssoRequired && (
          <>
            <div className="auth-divider"><span>or</span></div>
            <SsoButton providerName={oidc?.provider_name || "SSO"} />
          </>
        )}
        {ssoRequired && !showLocalForm && (
          <button type="button" className="auth-forgot-link" onClick={() => setShowLocalForm(true)}>
            Local sign-in (administrators)
          </button>
        )}
        {localFormVisible && (
          <button type="button" className="auth-forgot-link" onClick={onForgotPassword}>
            Forgot password?
          </button>
        )}
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
            <div className="auth-brand-icon">
              <img src="/favicon.svg" width="32" height="32" alt="" />
            </div>
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
                autoFocus
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
  const [oidc, setOidc] = useState<OidcStatus | null>(null);
  const [ssoError, setSsoError] = useState<string | null>(null);

  useEffect(() => {
    setSsoError(consumeSsoErrorParam());
    let cancelled = false;
    api.oidcStatus()
      .then((status) => { if (!cancelled) setOidc(status); })
      .catch(() => { /* SSO status is optional — the local form still works. */ });
    return () => { cancelled = true; };
  }, []);

  if (view === "forgot") {
    return <ForgotPasswordView onBack={() => setView("login")} appName={appName} />;
  }

  return (
    <LoginForm
      onSubmit={onSubmit}
      appName={appName}
      loginMessage={loginMessage}
      onForgotPassword={() => setView("forgot")}
      oidc={oidc}
      ssoError={ssoError}
    />
  );
}
