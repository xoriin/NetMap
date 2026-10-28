import { useEffect, useRef, useState, type FormEvent } from "react";
import QRCode from "qrcode";
import { Info } from "lucide-react";
import type { TotpSetup } from "../../api/client";

type Props = {
  start: () => Promise<TotpSetup>;
  confirm: (code: string) => Promise<string[]>;
  onDone: () => void;
  onRecoveryCodes?: () => void;
  buttonClassName?: string;
  linkClassName?: string;
  doneLabel?: string;
  /** A live 429 countdown from the caller: shown in place of the error, and Verify waits until it clears. */
  retryMessage?: string | null;
};

type RecoveryCodesViewProps = {
  codes: string[];
  onDone: () => void;
  buttonClassName?: string;
  linkClassName?: string;
  doneLabel?: string;
};

export function RecoveryCodesView({ codes, onDone, buttonClassName, linkClassName, doneLabel = "Continue" }: RecoveryCodesViewProps) {
  const [saved, setSaved] = useState(false);

  function download() {
    const blob = new Blob([`${codes.join("\n")}\n`], { type: "text/plain" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = "netmap-recovery-codes.txt";
    link.click();
    URL.revokeObjectURL(link.href);
  }

  return (
    <div className="totp-enrolment">
      <p className="auth-reset-info">Save these recovery codes somewhere safe. Each one signs you in once if you lose your authenticator.</p>
      <ol className="totp-recovery-codes">{codes.map((c) => <li key={c}>{c}</li>)}</ol>
      <div className="totp-recovery-actions">
        <button type="button" className={linkClassName} onClick={() => void navigator.clipboard.writeText(codes.join("\n"))}>Copy</button>
        <button type="button" className={linkClassName} onClick={download}>Download .txt</button>
      </div>
      <label className="tool-form-inline-check">
        <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
        <span>I've saved these recovery codes</span>
      </label>
      <button type="button" className={buttonClassName} disabled={!saved} onClick={onDone}>{doneLabel}</button>
    </div>
  );
}

export function TotpEnrolment({ start, confirm, onDone, onRecoveryCodes, buttonClassName, linkClassName, doneLabel = "Continue", retryMessage = null }: Props) {
  const [setup, setSetup] = useState<TotpSetup | null>(null);
  const [qr, setQr] = useState<string>("");
  const [code, setCode] = useState("");
  const [codes, setCodes] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const started = useRef<{ start: Props["start"]; promise: Promise<TotpSetup> } | null>(null);

  // When a countdown runs out, drop the throttle error it replaced.
  const throttled = retryMessage !== null;
  useEffect(() => {
    if (!throttled) return;
    return () => setError(null);
  }, [throttled]);

  useEffect(() => {
    let cancelled = false;
    if (started.current?.start !== start) started.current = { start, promise: start() };
    started.current.promise
      .then(async (result) => {
        if (cancelled) return;
        setSetup(result);
        const dataUrl = await QRCode.toDataURL(result.otpauth_uri, { margin: 1, width: 176 });
        if (!cancelled) setQr(dataUrl);
      })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : "Unable to start setup"); });
    return () => { cancelled = true; };
  }, [start]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (throttled) return;
    setBusy(true);
    setError(null);
    try {
      setCodes(await confirm(code));
      onRecoveryCodes?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "That code didn't work");
    } finally {
      setBusy(false);
    }
  }

  if (codes) {
    return <RecoveryCodesView codes={codes} onDone={onDone} buttonClassName={buttonClassName} linkClassName={linkClassName} doneLabel={doneLabel} />;
  }

  return (
    <form className="totp-enrolment" onSubmit={(e) => void submit(e)}>
      <p className="auth-reset-info">Scan this with your authenticator app, then enter the 6-digit code it shows.</p>
      {qr ? <img className="totp-qr" src={qr} width={176} height={176} alt="QR code for your authenticator app" /> : <div className="totp-qr" aria-busy="true" />}
      {setup && (
        <>
          <div className="nm-alert nm-alert--info totp-key-note" role="note">
            <Info size={17} aria-hidden="true" />
            <div className="totp-secret"><strong>Can't scan? Enter this key:</strong><code>{setup.secret}</code></div>
          </div>
          <button type="button" className={linkClassName} aria-label="Copy key" onClick={() => void navigator.clipboard.writeText(setup.secret)}>Copy</button>
        </>
      )}
      <label>
        Authentication code
        <input required autoFocus inputMode="numeric" autoComplete="one-time-code" maxLength={7} value={code} onChange={(e) => setCode(e.target.value)} />
      </label>
      {(retryMessage ?? error) && <div className="form-error">{retryMessage ?? error}</div>}
      <button type="submit" className={buttonClassName} disabled={busy || !setup || throttled}>{busy ? "Verifying…" : "Verify"}</button>
    </form>
  );
}
