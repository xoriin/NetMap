import { useState } from "react";
import type { NotificationDelivery, NotificationProfile } from "../../api/client";
import { Modal } from "../../components/Modal";
import { formatEventTime } from "../../utils/format";
import { notificationProfileMethodLabel, notificationTargetLabel } from "./notificationProfiles";

export function deliveryMethodLabel(profiles: NotificationProfile[], target: string): string {
  if (!target.startsWith("profile:")) return "";
  const profile = profiles.find((item) => item.id === Number(target.slice("profile:".length)));
  return profile ? notificationProfileMethodLabel(profile) : "";
}

/** The last non-empty line of the message: the part that says what happened. */
export function deliverySummary(message: string | undefined): string {
  const lines = (message ?? "").split("\n").map((line) => line.trim()).filter(Boolean);
  return lines[lines.length - 1] ?? "";
}

export function AlertDeliveryModal({ delivery, related, profiles, triggerName, sourceName, onClose }: {
  delivery: NotificationDelivery;
  related: NotificationDelivery[];
  profiles: NotificationProfile[];
  triggerName: string;
  sourceName: string;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const sent = delivery.status === "sent";
  const via = (target: string) => {
    const method = deliveryMethodLabel(profiles, target);
    return `${notificationTargetLabel(profiles, target)}${method ? ` · ${method}` : ""}`;
  };

  async function copy() {
    try {
      await navigator.clipboard.writeText(delivery.message);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }

  return (
    <Modal
      title={delivery.rule_name || "Alert notification"}
      size="lg"
      onCancel={onClose}
      modalClassName="alert-delivery-modal"
      headerExtra={<span className={`nm-pill ${sent ? "nm-pill--online" : "nm-pill--offline"}`}>{sent ? "Sent" : "Failed"}</span>}
    >
      <section className="mon-hero-section" aria-label="What was sent">
        <div className="mon-hero-section-title">
          What Was Sent
          {delivery.message && (
            <button type="button" className="nm-btn nm-btn--sm alert-delivery-copy" onClick={() => void copy()}>
              {copied ? "Copied" : "Copy"}
            </button>
          )}
        </div>
        {delivery.message
          ? <pre className="alert-delivery-message">{delivery.message}</pre>
          : <p className="tool-note alert-delivery-empty">The message text was not recorded for notifications sent before NetMap 1.8.0. Newer notifications keep it for 30 days.</p>}
      </section>
      <section className="mon-hero-section" aria-label="Delivery">
        <div className="mon-hero-section-title">Delivery</div>
        <div className="mon-analysis-body">
          <div className="mon-analysis-row"><span className="dash-panel-meta">Sent</span><strong className="mon-analysis-val">{formatEventTime(delivery.sent_at)}</strong></div>
          <div className="mon-analysis-row"><span className="dash-panel-meta">Sent via</span><strong className="mon-analysis-val">{via(delivery.target)}</strong></div>
          <div className="mon-analysis-row">
            <span className="dash-panel-meta">Result</span>
            <strong className={`mon-analysis-val${sent ? "" : " mon-analysis-val--warn"}`}>{sent ? "Accepted by the provider" : delivery.detail || "Failed"}</strong>
          </div>
          <div className="mon-analysis-row"><span className="dash-panel-meta">Rule</span><strong className="mon-analysis-val">{[delivery.rule_name, triggerName].filter(Boolean).join(" · ") || "—"}</strong></div>
          <div className="mon-analysis-row"><span className="dash-panel-meta">Device or endpoint</span><strong className="mon-analysis-val">{sourceName || "—"}</strong></div>
        </div>
      </section>
      {related.length > 0 && (
        <section className="mon-hero-section" aria-label="Same alert, other methods">
          <div className="mon-hero-section-title">Same Alert, Other Methods</div>
          <ul className="alert-delivery-related">
            {related.map((other) => (
              <li key={other.id}>
                <span>{via(other.target)}</span>
                <span className={`notif-result${other.status === "sent" ? " ok" : " err"}`}>{other.status === "sent" ? "Sent" : other.detail || "Failed"}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </Modal>
  );
}
