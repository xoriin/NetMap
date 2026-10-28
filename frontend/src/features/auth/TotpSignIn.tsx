import { useCallback, useEffect, useId, useState, type FormEvent } from "react";
import { api, ApiError, type TokenPair } from "../../api/client";
import { TotpEnrolment } from "./TotpEnrolment";

const EXPIRED = "Sign-in expired. Enter your password again.";

function isExpired(err: unknown) {
  return err instanceof ApiError && err.status === 401 && err.detail === EXPIRED;
}

/** Seconds until a 429 can be retried, from Retry-After or the "Retry in N seconds" detail. */
function retryAfter(err: unknown): number | null {
  if (!(err instanceof ApiError) || err.status !== 429) return null;
  const fromDetail = typeof err.detail === "string" ? err.detail.match(/(\d+)\s*seconds?/i) : null;
  const seconds = err.retryAfterSeconds ?? (fromDetail ? Number(fromDetail[1]) : null);
  return seconds !== null && seconds > 0 ? seconds : null;
}

function retryMessage(seconds: number) {
  return `Too many attempts. Try again in ${seconds} ${seconds === 1 ? "second" : "seconds"}.`;
}

function errorMessage(err: unknown, fallback: string): string {
  const seconds = retryAfter(err);
  if (seconds !== null) return retryMessage(seconds);
  if (err instanceof ApiError && typeof err.detail === "string") return err.detail;
  return err instanceof Error ? err.message : fallback;
}

/**
 * A live countdown for a 429: `begin(err)` starts it (returning false when the
 * error isn't a throttle) and `message` reads "Try again in N seconds" until it
 * runs out, then null again.
 */
function useRetryCountdown() {
  const [retryUntil, setRetryUntil] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (retryUntil === null) return;
    const timer = window.setInterval(() => {
      const current = Date.now();
      setNow(current);
      if (current >= retryUntil) setRetryUntil(null);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [retryUntil]);

  const begin = useCallback((err: unknown) => {
    const seconds = retryAfter(err);
    if (seconds === null) return false;
    const current = Date.now();
    setNow(current);
    setRetryUntil(current + seconds * 1000);
    return true;
  }, []);

  const message = retryUntil === null ? null : retryMessage(Math.max(0, Math.ceil((retryUntil - now) / 1000)));
  return { message, begin };
}

type StepProps = {
  /** The password sign-in's challenge; null after single sign-on, where it lives in an HttpOnly cookie. */
  challenge: string | null;
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
  const retry = useRetryCountdown();
  const errorId = useId();

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (retry.message) return;
    setBusy(true);
    setError(null);
    try {
      onAuthenticated(await api.loginTotp(challenge, code));
    } catch (err) {
      if (isExpired(err)) onExpired();
      else if (!retry.begin(err)) setError(errorMessage(err, "That code didn't work"));
    } finally {
      setBusy(false);
    }
  }

  const shownError = retry.message ?? error;
  const describedBy = shownError ? errorId : undefined;

  return (
    <section className="auth-surface">
      <form className="auth-card" onSubmit={(e) => void submit(e)}>
        <Brand appName={appName} />
        <h2 className="auth-form-heading">Two-Factor Authentication</h2>
        <p className="auth-reset-info">
          {useRecovery ? "Enter one of the recovery codes you saved when you set this up." : "Enter the 6-digit code from your authenticator app."}
        </p>
        {useRecovery ? (
          <label key="recovery">
            Recovery code
            <input required autoFocus autoComplete="off" placeholder="XXXXX-XXXXX" maxLength={11} value={code} aria-invalid={Boolean(error) || undefined} aria-describedby={describedBy} onChange={(e) => setCode(e.target.value)} />
          </label>
        ) : (
          <label key="totp">
            Authentication code
            <input required autoFocus inputMode="numeric" autoComplete="one-time-code" maxLength={7} value={code} aria-invalid={Boolean(error) || undefined} aria-describedby={describedBy} onChange={(e) => setCode(e.target.value)} />
          </label>
        )}
        {shownError && <div className="form-error" role="alert" id={errorId}>{shownError}</div>}
        <button type="submit" disabled={busy || retry.message !== null}>{busy ? "Verifying…" : "Verify"}</button>
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
  const retry = useRetryCountdown();
  const beginRetry = retry.begin;

  const start = useCallback(() => api.loginTotpSetup(challenge).catch((err) => {
    if (isExpired(err)) onExpired();
    throw new Error(errorMessage(err, "Unable to start setup"));
  }), [challenge, onExpired]);

  const confirm = useCallback(async (code: string) => {
    try {
      const result = await api.loginTotpSetupConfirm(challenge, code);
      if (result.access_token) setTokens({ access_token: result.access_token, token_type: "bearer" });
      return result.recovery_codes;
    } catch (err) {
      if (isExpired(err)) onExpired();
      else beginRetry(err);
      throw new Error(errorMessage(err, "That code didn't work"));
    }
  }, [challenge, onExpired, beginRetry]);

  return (
    <section className="auth-surface">
      <div className="auth-card">
        <Brand appName={appName} />
        <h2 className="auth-form-heading">Set Up Two-Factor Authentication</h2>
        <p className="auth-reset-info">Your administrator requires two-factor authentication for this account.</p>
        <TotpEnrolment start={start} confirm={confirm} onDone={() => tokens && onAuthenticated(tokens)} retryMessage={retry.message} linkClassName="auth-forgot-link" />
        {!tokens && <button type="button" className="auth-forgot-link" onClick={onBack}>Back to sign in</button>}
      </div>
    </section>
  );
}
