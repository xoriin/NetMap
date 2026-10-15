import { useState, type FormEvent } from "react";
import { IconDatabase } from "@tabler/icons-react";

import { Modal } from "../../components/Modal";

export function EncryptedBackupModal({
  busy,
  onCancel,
  onDownload,
}: {
  busy: boolean;
  onCancel: () => void;
  onDownload: (passphrase: string) => Promise<void>;
}) {
  const [passphrase, setPassphrase] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (passphrase.length < 12) {
      setError("Use a passphrase of at least 12 characters.");
      return;
    }
    if (passphrase !== confirmation) {
      setError("The passphrases do not match.");
      return;
    }
    setError(null);
    try {
      await onDownload(passphrase);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Encrypted backup failed");
    }
  }

  return (
    <Modal
      title="Download encrypted backup"
      titleIcon={<IconDatabase size={18} />}
      onCancel={onCancel}
      headerSubmitLabel={busy ? "Encrypting…" : "Download"}
      headerSubmitFormId="encrypted-backup-form"
      headerSubmitDisabled={busy || passphrase.length < 12 || passphrase !== confirmation}
    >
      <form id="encrypted-backup-form" className="modal-form" onSubmit={submit}>
        <p className="tool-note">
          This passphrase is not stored by NetMap and is required to restore the backup.
        </p>
        <label>
          Passphrase
          <input
            autoFocus
            autoComplete="new-password"
            maxLength={256}
            minLength={12}
            type="password"
            value={passphrase}
            onChange={(event) => setPassphrase(event.target.value)}
          />
        </label>
        <label>
          Confirm passphrase
          <input
            autoComplete="new-password"
            maxLength={256}
            minLength={12}
            type="password"
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
          />
        </label>
        {error && <div className="form-error">{error}</div>}
      </form>
    </Modal>
  );
}
