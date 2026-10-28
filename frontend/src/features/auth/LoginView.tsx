import { useCallback, useEffect, useState, type FormEvent } from "react";
import { LogIn } from "lucide-react";
import { api, type MfaChallenge, type OidcStatus, type TokenPair } from "../../api/client";
import { TotpCodeStep, TotpSetupStep } from "./TotpSignIn";
import { AuthTextReveal } from "./AuthTextReveal";
import type { SsoMfaStep } from "./ssoCallback";

/** Who asked for the 2FA step: a password sign-in (with its challenge) or single sign-on (challenge in a cookie). */
type MfaStep = { setup: boolean; challenge: string | null };

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
  notice,
}: {
  onSubmit: (username: string, password: string) => Promise<MfaChallenge | null>;
  appName?: string;
  loginMessage?: string;
  onForgotPassword: () => void;
  oidc: OidcStatus | null;
  ssoError: string | null;
  notice: string | null;
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
      <form className="auth-card auth-login-card" onSubmit={submit}>
        <div className="auth-brand">
          <div className="auth-brand-row">
            <div className="auth-brand-icon">
              <img src="/favicon.svg" width="32" height="32" alt="" />
            </div>
            <span className="auth-brand-name"><AuthTextReveal text={appName || "NetMap"} /></span>
          </div>
          <p className="auth-slogan"><AuthTextReveal text={loginMessage || "The Blueprint for Your Infrastructure"} /></p>
        </div>
        <h2 className="auth-form-heading">Sign In</h2>
        {ssoError && <div className="form-error">{ssoError}</div>}
        {notice && <div className="form-error">{notice}</div>}
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
            <h2 className="auth-form-heading">Check Your Email</h2>
            <p className="auth-reset-info">
              If an account matching <strong>{identifier}</strong> exists, a password reset link has been sent. Check your inbox and follow the link to set a new password.
            </p>
            <button type="button" onClick={onBack}>Back to sign in</button>
          </>
        ) : (
          <form onSubmit={(e) => void submit(e)}>
            <h2 className="auth-form-heading">Reset Password</h2>
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

export function LoginView({ onSubmit, onAuthenticated, appName, loginMessage, ssoMfa = null, ssoError = null }: {
  onSubmit: (username: string, password: string) => Promise<MfaChallenge | null>;
  onAuthenticated: (tokens: TokenPair) => void;
  appName?: string;
  loginMessage?: string;
  /** Set when the single sign-on callback still needs the NetMap 2FA code or setup. */
  ssoMfa?: SsoMfaStep | null;
  /** A friendly message for the callback's `sso_error` code. */
  ssoError?: string | null;
}) {
  const [view, setView] = useState<"login" | "forgot">("login");
  const [mfa, setMfa] = useState<MfaStep | null>(() => (ssoMfa ? { setup: ssoMfa === "setup", challenge: null } : null));
  const [notice, setNotice] = useState<string | null>(null);
  const back = useCallback(() => setMfa(null), []);
  const fromSso = mfa !== null && mfa.challenge === null;
  const expired = useCallback(() => {
    setMfa(null);
    // After single sign-on there was no password step here, so use the server's wording.
    setNotice(fromSso ? "Sign-in expired. Enter your password again." : "Your sign-in timed out. Enter your password again.");
  }, [fromSso]);
  const [oidc, setOidc] = useState<OidcStatus | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.oidcStatus()
      .then((status) => { if (!cancelled) setOidc(status); })
      .catch(() => { /* SSO status is optional — the local form still works. */ });
    return () => { cancelled = true; };
  }, []);

  if (mfa) {
    const Step = mfa.setup ? TotpSetupStep : TotpCodeStep;
    return <Step challenge={mfa.challenge} appName={appName} onAuthenticated={onAuthenticated} onExpired={expired} onBack={back} />;
  }

  if (view === "forgot") {
    return <ForgotPasswordView onBack={() => setView("login")} appName={appName} />;
  }

  return (
    <LoginForm
      onSubmit={async (u, p) => {
        setNotice(null);
        const challenge = await onSubmit(u, p);
        if (challenge) setMfa({ setup: challenge.mfa_setup_required, challenge: challenge.challenge });
        return challenge;
      }}
      appName={appName}
      loginMessage={loginMessage}
      onForgotPassword={() => setView("forgot")}
      oidc={oidc}
      ssoError={ssoError}
      notice={notice}
    />
  );
}
