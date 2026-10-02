import { useCallback, useState, type FormEvent } from "react";
import { api, ApiError, type TokenPair } from "../../api/client";
import { TotpEnrolment } from "./TotpEnrolment";

const EXPIRED = "Sign-in expired. Enter your password again.";

function isExpired(err: unknown) {
  return err instanceof ApiError && err.status === 401 && err.detail === EXPIRED;
}

type StepProps = {
  challenge: string;
  appName?: string;
  onAuthenticated: (tokens: TokenPair) => void;
  onExpired: () => void;
  onBack: () => void;
};

function Brand({ appName }: { appName?: string }) {
  return (
    <div className="auth-brand">
      <div className="auth-brand-row">
        <div className="auth-brand-icon"><img src="/favicon.svg" width="32" height="32" alt="" /></div>
        <span className="auth-brand-name">{appName || "NetMap"}</span>
      </div>
    </div>
  );
}

export function TotpCodeStep({ challenge, appName, onAuthenticated, onExpired, onBack }: StepProps) {
  const [useRecovery, setUseRecovery] = useState(false);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onAuthenticated(await api.loginTotp(challenge, code));
    } catch (err) {
      if (isExpired(err)) onExpired();
      else setError(err instanceof Error ? err.message : "That code didn't work");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="auth-surface">
      <form className="auth-card" onSubmit={(e) => void submit(e)}>
        <Brand appName={appName} />
        <h2 className="auth-form-heading">Two-factor authentication</h2>
        <p className="auth-reset-info">
          {useRecovery ? "Enter one of the recovery codes you saved when you set this up." : "Enter the 6-digit code from your authenticator app."}
        </p>
        {useRecovery ? (
          <label key="recovery">
            Recovery code
            <input required autoFocus autoComplete="off" placeholder="XXXXX-XXXXX" maxLength={11} value={code} onChange={(e) => setCode(e.target.value)} />
          </label>
        ) : (
          <label key="totp">
            Authentication code
            <input required autoFocus inputMode="numeric" autoComplete="one-time-code" maxLength={7} value={code} onChange={(e) => setCode(e.target.value)} />
          </label>
        )}
        {error && <div className="form-error">{error}</div>}
        <button type="submit" disabled={busy}>{busy ? "Verifying…" : "Verify"}</button>
        <button type="button" className="auth-forgot-link" onClick={() => { setUseRecovery(!useRecovery); setCode(""); setError(null); }}>
          {useRecovery ? "Use your authenticator app" : "Use a recovery code"}
        </button>
        <button type="button" className="auth-forgot-link" onClick={onBack}>Back to sign in</button>
      </form>
    </section>
  );
}

export function TotpSetupStep({ challenge, appName, onAuthenticated, onExpired, onBack }: StepProps) {
  const [tokens, setTokens] = useState<TokenPair | null>(null);

  const start = useCallback(() => api.loginTotpSetup(challenge).catch((err) => {
    if (isExpired(err)) onExpired();
    throw err;
  }), [challenge, onExpired]);

  const confirm = useCallback(async (code: string) => {
    try {
      const result = await api.loginTotpSetupConfirm(challenge, code);
      if (result.access_token) setTokens({ access_token: result.access_token, token_type: "bearer" });
      return result.recovery_codes;
    } catch (err) {
      if (isExpired(err)) onExpired();
      throw err;
    }
  }, [challenge, onExpired]);

  return (
    <section className="auth-surface">
      <div className="auth-card">
        <Brand appName={appName} />
        <h2 className="auth-form-heading">Set up two-factor authentication</h2>
        <p className="auth-reset-info">Your administrator requires two-factor authentication for this account.</p>
        <TotpEnrolment start={start} confirm={confirm} onDone={() => tokens && onAuthenticated(tokens)} linkClassName="auth-forgot-link" />
        {!tokens && <button type="button" className="auth-forgot-link" onClick={onBack}>Back to sign in</button>}
      </div>
    </section>
  );
}
