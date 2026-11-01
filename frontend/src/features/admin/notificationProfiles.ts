/**
 * Notification-profile subsystem for the Admin workspace: method catalog,
 * profile form model, Apprise URL builders, and profile<->form mapping.
 * Extracted from AdminWorkspace.tsx (frontend reconstruction, B4 phase 1).
 */
import type { NotificationProfile } from "../../api/client";

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

export const legacyChannelLabels: Record<string, string> = {
  smtp: "Email (SMTP)",
  ntfy: "ntfy",
  telegram: "Telegram",
  signal: "Signal",
};

export const notificationMethodLabels: Record<string, string> = {
  ntfy: "ntfy",
  telegram: "Telegram",
  signal: "Signal",
  smtp: "Email (SMTP)",
  discord: "Discord",
  slack: "Slack",
  gotify: "Gotify",
  pushover: "Pushover",
  google_chat: "Google Chat",
  custom: "Custom Apprise URL",
};

export const notificationMethodCatalog = [
  { id: "ntfy", label: "ntfy", description: "ntfy topic push notifications" },
  { id: "telegram", label: "Telegram", description: "Telegram bot messages" },
  { id: "signal", label: "Signal", description: "Signal REST API messages" },
  { id: "smtp", label: "Email (SMTP)", description: "Email through an SMTP server" },
  { id: "discord", label: "Discord", description: "Discord webhook alerts" },
  { id: "slack", label: "Slack", description: "Slack incoming webhook alerts" },
  { id: "gotify", label: "Gotify", description: "Self-hosted Gotify app notifications" },
  { id: "pushover", label: "Pushover", description: "Pushover user/app notifications" },
  { id: "google_chat", label: "Google Chat", description: "Google Chat incoming webhook alerts" },
  { id: "webhook", label: "Generic webhook", description: "POST a JSON payload to any HTTP(S) endpoint" },
  { id: "custom", label: "Custom Apprise URL", description: "Any Apprise-supported notification service" },
] as const;

export type NotificationMethodId = typeof notificationMethodCatalog[number]["id"];

export type NotificationProfileForm = {
  name: string;
  method: NotificationMethodId;
  title: string;
  enabled: boolean;
  ntfy_url: string;
  ntfy_token: string;
  telegram_bot_token: string;
  telegram_chat_id: string;
  signal_url: string;
  signal_number: string;
  signal_recipient: string;
  smtp_host: string;
  smtp_port: string;
  smtp_user: string;
  smtp_password: string;
  smtp_from: string;
  smtp_to: string;
  smtp_tls: boolean;
  discord_webhook_id: string;
  discord_webhook_token: string;
  slack_token_a: string;
  slack_token_b: string;
  slack_token_c: string;
  slack_channel: string;
  gotify_base_url: string;
  gotify_token: string;
  pushover_user_key: string;
  pushover_app_token: string;
  google_chat_workspace: string;
  google_chat_key: string;
  google_chat_token: string;
  webhook_url: string;
  webhook_token: string;
  custom_url: string;
};

export const emptyProfileForm: NotificationProfileForm = {
  name: "",
  method: "ntfy",
  title: "NetMap",
  enabled: true,
  ntfy_url: "",
  ntfy_token: "",
  telegram_bot_token: "",
  telegram_chat_id: "",
  signal_url: "",
  signal_number: "",
  signal_recipient: "",
  smtp_host: "",
  smtp_port: "587",
  smtp_user: "",
  smtp_password: "",
  smtp_from: "",
  smtp_to: "",
  smtp_tls: true,
  discord_webhook_id: "",
  discord_webhook_token: "",
  slack_token_a: "",
  slack_token_b: "",
  slack_token_c: "",
  slack_channel: "",
  gotify_base_url: "",
  gotify_token: "",
  pushover_user_key: "",
  pushover_app_token: "",
  google_chat_workspace: "",
  google_chat_key: "",
  google_chat_token: "",
  webhook_url: "",
  webhook_token: "",
  custom_url: "",
};

function encSegment(value: string): string {
  return encodeURIComponent(value.trim());
}

function stripUrlScheme(value: string): string {
  return value.trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "");
}

export function buildAppriseUrl(form: NotificationProfileForm): string {
  switch (form.method) {
    case "discord":
      return `discord://${encSegment(form.discord_webhook_id)}/${encSegment(form.discord_webhook_token)}`;
    case "slack": {
      const channel = form.slack_channel.trim() ? `/${encSegment(form.slack_channel)}` : "";
      return `slack://${encSegment(form.slack_token_a)}/${encSegment(form.slack_token_b)}/${encSegment(form.slack_token_c)}${channel}`;
    }
    case "gotify":
      return `gotifys://${stripUrlScheme(form.gotify_base_url)}/${encSegment(form.gotify_token)}`;
    case "pushover":
      return `pover://${encSegment(form.pushover_user_key)}@${encSegment(form.pushover_app_token)}`;
    case "google_chat":
      return `gchat://${encSegment(form.google_chat_workspace)}/${encSegment(form.google_chat_key)}/${encSegment(form.google_chat_token)}`;
    case "custom":
      return form.custom_url.trim();
    default:
      return "";
  }
}

export function providerForMethod(method: NotificationMethodId): "apprise" | "ntfy" | "telegram" | "signal" | "smtp" | "webhook" {
  if (method === "ntfy" || method === "telegram" || method === "signal" || method === "smtp" || method === "webhook") {
    return method;
  }
  return "apprise";
}

export function buildNotificationConfig(form: NotificationProfileForm): Record<string, string> {
  if (form.method === "ntfy") {
    return { ntfy_url: form.ntfy_url.trim(), ntfy_token: form.ntfy_token, method: form.method, method_label: "ntfy" };
  }
  if (form.method === "telegram") {
    return { telegram_bot_token: form.telegram_bot_token, telegram_chat_id: form.telegram_chat_id.trim(), method: form.method, method_label: "Telegram" };
  }
  if (form.method === "signal") {
    return { signal_url: form.signal_url.trim(), signal_number: form.signal_number.trim(), signal_recipient: form.signal_recipient.trim(), method: form.method, method_label: "Signal" };
  }
  if (form.method === "smtp") {
    return {
      smtp_host: form.smtp_host.trim(),
      smtp_port: form.smtp_port.trim() || "587",
      smtp_user: form.smtp_user.trim(),
      smtp_password: form.smtp_password,
      smtp_from: form.smtp_from.trim(),
      smtp_to: form.smtp_to.trim(),
      smtp_tls: form.smtp_tls ? "true" : "false",
      method: form.method,
      method_label: "Email (SMTP)",
    };
  }
  if (form.method === "webhook") {
    return { webhook_url: form.webhook_url.trim(), webhook_token: form.webhook_token, method: form.method, method_label: "Generic webhook" };
  }
  const method = notificationMethodCatalog.find((item) => item.id === form.method);
  return {
    url: buildAppriseUrl(form),
    title: form.title.trim() || "NetMap",
    method: form.method,
    method_label: method?.label ?? notificationMethodLabels[form.method] ?? "Apprise",
  };
}

export function profileFormIsComplete(form: NotificationProfileForm): boolean {
  if (!form.name.trim()) return false;
  if (form.method === "ntfy") return !!form.ntfy_url.trim();
  if (form.method === "telegram") return !!form.telegram_bot_token.trim() && !!form.telegram_chat_id.trim();
  if (form.method === "signal") return !!form.signal_url.trim() && !!form.signal_number.trim() && !!form.signal_recipient.trim();
  if (form.method === "smtp") return !!form.smtp_host.trim() && !!form.smtp_to.trim();
  if (form.method === "discord") return !!form.discord_webhook_id.trim() && !!form.discord_webhook_token.trim();
  if (form.method === "slack") return !!form.slack_token_a.trim() && !!form.slack_token_b.trim() && !!form.slack_token_c.trim();
  if (form.method === "gotify") return !!form.gotify_base_url.trim() && !!form.gotify_token.trim();
  if (form.method === "pushover") return !!form.pushover_user_key.trim() && !!form.pushover_app_token.trim();
  if (form.method === "google_chat") return !!form.google_chat_workspace.trim() && !!form.google_chat_key.trim() && !!form.google_chat_token.trim();
  if (form.method === "webhook") return !!form.webhook_url.trim();
  return !!form.custom_url.trim();
}

export function populateFormFromProfile(profile: NotificationProfile): NotificationProfileForm {
  const cfg = profile.config;
  const method = (cfg.method as NotificationMethodId) ?? "ntfy";
  const base: NotificationProfileForm = { ...emptyProfileForm, name: profile.name, method, enabled: profile.enabled };
  switch (method) {
    case "ntfy":
      return { ...base, ntfy_url: cfg.ntfy_url ?? "", ntfy_token: cfg.ntfy_token ?? "" };
    case "telegram":
      return { ...base, telegram_bot_token: cfg.telegram_bot_token ?? "", telegram_chat_id: cfg.telegram_chat_id ?? "" };
    case "signal":
      return { ...base, signal_url: cfg.signal_url ?? "", signal_number: cfg.signal_number ?? "", signal_recipient: cfg.signal_recipient ?? "" };
    case "smtp":
      return {
        ...base,
        smtp_host: cfg.smtp_host ?? "",
        smtp_port: cfg.smtp_port ?? "587",
        smtp_user: cfg.smtp_user ?? "",
        smtp_password: cfg.smtp_password ?? "",
        smtp_from: cfg.smtp_from ?? "",
        smtp_to: cfg.smtp_to ?? "",
        smtp_tls: cfg.smtp_tls !== "false",
      };
    case "webhook":
      return { ...base, webhook_url: cfg.webhook_url ?? "", webhook_token: cfg.webhook_token ?? "" };
    default:
      return { ...base, title: cfg.title ?? "NetMap" };
  }
}


/** Human label for an alert channel target ("profile:<id>" or a legacy channel key). */
export function notificationTargetLabel(profiles: NotificationProfile[], target: string): string {
  if (target.startsWith("profile:")) {
    const id = Number(target.slice("profile:".length));
    const profile = profiles.find((item) => item.id === id);
    return profile ? profile.name : `Profile #${id}`;
  }
  return legacyChannelLabels[target] ?? target;
}

/** Human label for the delivery method a saved profile uses. */
export function notificationProfileMethodLabel(profile: NotificationProfile): string {
  const method = profile.config.method || "";
  return profile.config.method_label || notificationMethodLabels[method] || "Custom Apprise URL";
}
