import { useState, useEffect, useMemo, type FormEvent } from "react";
import { Settings, Shield, Check, X, Pencil, UserCircle } from "lucide-react";
import {
  IconUsers, IconShieldCheck, IconCloud, IconAlertCircle,
  IconDatabase, IconDeviceDesktop, IconBolt, IconPalette, IconServer, IconCalendarClock,
} from "@tabler/icons-react";
import {
  api,
  type User, type SyslogStatus, type SystemSettings, type NotificationSettings,
  type NotificationProfile,
  type AlertRule, type AlertRulePayload, type AlertRuleEventType,
  type RolePermissions, type VersionInfo, type SystemDiagnostics,
  type DashboardSummary, type TopologyGraph, type AuditLog, type SnmpProfile,
  type DiscoverySchedule, type DiscoveryObservation, type DiscoverySchedulePayload,
  type DiscoveryScanType, type TopologyGroup, type Site,
} from "../../api/client";
import { builtInIconPack, allRuntimePacks, type IconPack } from "../../icons";
import { userInitials, formatEventTime } from "../../utils/format";
import { triggerDownload } from "../../utils/download";
import { IconManagerModal } from "../../components/IconManagerModal";
import { Modal } from "../../components/Modal";

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

const legacyChannelLabels: Record<string, string> = {
  smtp: "Email (SMTP)",
  ntfy: "ntfy",
  telegram: "Telegram",
  signal: "Signal",
};

const notificationMethodLabels: Record<string, string> = {
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

const notificationMethodCatalog = [
  { id: "ntfy", label: "ntfy", description: "ntfy topic push notifications" },
  { id: "telegram", label: "Telegram", description: "Telegram bot messages" },
  { id: "signal", label: "Signal", description: "Signal REST API messages" },
  { id: "smtp", label: "Email (SMTP)", description: "Email through an SMTP server" },
  { id: "discord", label: "Discord", description: "Discord webhook alerts" },
  { id: "slack", label: "Slack", description: "Slack incoming webhook alerts" },
  { id: "gotify", label: "Gotify", description: "Self-hosted Gotify app notifications" },
  { id: "pushover", label: "Pushover", description: "Pushover user/app notifications" },
  { id: "google_chat", label: "Google Chat", description: "Google Chat incoming webhook alerts" },
  { id: "custom", label: "Custom Apprise URL", description: "Any Apprise-supported notification service" },
] as const;

const appriseSupportedMethods = [
  "Discord", "Slack", "Gotify", "Pushover", "Google Chat", "Matrix", "Mattermost",
  "Rocket.Chat", "Webex Teams", "ntfy", "Email", "Mailgun", "Opsgenie", "PagerDuty",
  "Telegram", "Signal", "SMS gateways", "Custom JSON/webhook",
];

type NotificationMethodId = typeof notificationMethodCatalog[number]["id"];

type NotificationProfileForm = {
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
  custom_url: string;
};

const emptyProfileForm: NotificationProfileForm = {
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
  custom_url: "",
};

function encSegment(value: string): string {
  return encodeURIComponent(value.trim());
}

function stripUrlScheme(value: string): string {
  return value.trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "");
}

function buildAppriseUrl(form: NotificationProfileForm): string {
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

function providerForMethod(method: NotificationMethodId): "apprise" | "ntfy" | "telegram" | "signal" | "smtp" {
  if (method === "ntfy" || method === "telegram" || method === "signal" || method === "smtp") {
    return method;
  }
  return "apprise";
}

function buildNotificationConfig(form: NotificationProfileForm): Record<string, string> {
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
  const method = notificationMethodCatalog.find((item) => item.id === form.method);
  return {
    url: buildAppriseUrl(form),
    title: form.title.trim() || "NetMap",
    method: form.method,
    method_label: method?.label ?? notificationMethodLabels[form.method] ?? "Apprise",
  };
}

function profileFormIsComplete(form: NotificationProfileForm): boolean {
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
  return !!form.custom_url.trim();
}

function populateFormFromProfile(profile: NotificationProfile): NotificationProfileForm {
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
    default:
      return { ...base, title: cfg.title ?? "NetMap" };
  }
}

export function AdminWorkspace({
  accessToken,
  graph,
  summary,
  activeIconPackId,
  iconPackError,
  iconPackLoading,
  iconPacks,
  localIconPacks,
  onSelectIconPack,
  onAddLocalIconPack,
  onRemoveLocalIconPack,
  onSettingsChange,
  versionInfo,
}: {
  accessToken: string;
  graph: TopologyGraph;
  summary: DashboardSummary | null;
  activeIconPackId: string;
  iconPackError: string | null;
  iconPackLoading: boolean;
  iconPacks: IconPack[];
  localIconPacks: IconPack[];
  onSelectIconPack: (packId: string) => void;
  onAddLocalIconPack: (pack: IconPack) => void;
  onRemoveLocalIconPack: (packId: string) => void;
  onSettingsChange: (settings: SystemSettings) => void;
  versionInfo: VersionInfo | null;
}) {
  const [activeTab, setActiveTab] = useState<"system" | "users" | "security" | "notifications" | "alerts" | "groups" | "credentials" | "automation">("system");
  const [users, setUsers] = useState<User[]>([]);
  const [userSearch, setUserSearch] = useState("");
  const [syslogStatus, setSyslogStatus] = useState<SyslogStatus | null>(null);
  const [auditLogs, setAuditLogs] = useState<AuditLog[]>([]);
  const [auditLogsTotal, setAuditLogsTotal] = useState(0);
  const [auditOffset, setAuditOffset] = useState(0);
  const [auditUserFilter, setAuditUserFilter] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyUserId, setBusyUserId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [resetPasswordForm, setResetPasswordForm] = useState<{ userId: number | null; password: string }>({ userId: null, password: "" });
  const [editingEmailId, setEditingEmailId] = useState<number | null>(null);
  const [editingEmailValue, setEditingEmailValue] = useState("");
  const [settingsForm, setSettingsForm] = useState<SystemSettings>({ app_name: "NetMap", login_message: "", announcement: "", live_ping_enabled: true, monitor_interval_seconds: 300, idle_timeout_minutes: 15, active_network_public_targets_enabled: false });
  const [monitorIntervalRaw, setMonitorIntervalRaw] = useState("300");
  const [idleTimeoutRaw, setIdleTimeoutRaw] = useState("15");
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [restoreFile, setRestoreFile] = useState<File | null>(null);
  const [backupBusy, setBackupBusy] = useState<string | null>(null);
  const [createForm, setCreateForm] = useState({ username: "", password: "", email: "", role: "Viewer", is_active: true });
  const [iconModalOpen, setIconModalOpen] = useState(false);
  const [notifSettings, setNotifSettings] = useState<NotificationSettings>({
    ntfy_url: "", ntfy_token: "",
    telegram_bot_token: "", telegram_chat_id: "",
    signal_url: "", signal_number: "", signal_recipient: "",
    smtp_host: "", smtp_port: "587", smtp_user: "", smtp_password: "", smtp_from: "", smtp_to: "", smtp_tls: "true",
  });
  const [notifBusy, setNotifBusy] = useState(false);
  const [notifTestResult, setNotifTestResult] = useState<Record<string, string>>({});
  const [notificationProfiles, setNotificationProfiles] = useState<NotificationProfile[]>([]);
  const [profileForm, setProfileForm] = useState<NotificationProfileForm>(emptyProfileForm);
  const [profileTestResult, setProfileTestResult] = useState<Record<number, string>>({});
  const [profileBusy, setProfileBusy] = useState(false);
  const [editingProfileId, setEditingProfileId] = useState<number | null>(null);
  const [showProfileModal, setShowProfileModal] = useState(false);
  const [alertRules, setAlertRules] = useState<AlertRule[]>([]);
  const [alertRulesBusy, setAlertRulesBusy] = useState(false);
  const [alertRulesError, setAlertRulesError] = useState<string | null>(null);
  const [alertTestResults, setAlertTestResults] = useState<Record<number, Record<string, string>>>({});
  const [alertTestBusy, setAlertTestBusy] = useState<number | null>(null);
  const [showAlertForm, setShowAlertForm] = useState(false);
  const [editingAlertRule, setEditingAlertRule] = useState<AlertRule | null>(null);
  const [alertForm, setAlertForm] = useState<AlertRulePayload>({
    name: "",
    enabled: true,
    event_type: "device_offline",
    device_id: null,
    channels: [],
    cooldown_minutes: 30,
  });
  const [rolePermissions, setRolePermissions] = useState<RolePermissions | null>(null);
  const [localRolePerms, setLocalRolePerms] = useState<Record<string, string[]>>({});
  const [groupsBusy, setGroupsBusy] = useState(false);
  const [showNewGroupForm, setShowNewGroupForm] = useState(false);
  const [newGroupName, setNewGroupName] = useState("");
  const [diagnostics, setDiagnostics] = useState<SystemDiagnostics | null>(null);
  const [diagBusy, setDiagBusy] = useState(false);
  const [snmpProfiles, setSnmpProfiles] = useState<SnmpProfile[]>([]);
  const [snmpProfileForm, setSnmpProfileForm] = useState({ name: "", community: "", port: "161", timeout_seconds: "3", retries: "1" });
  const [snmpProfilesBusy, setSnmpProfilesBusy] = useState(false);

  const [schedules, setSchedules] = useState<DiscoverySchedule[]>([]);
  const [observations, setObservations] = useState<DiscoveryObservation[]>([]);
  const [automationGroups, setAutomationGroups] = useState<TopologyGroup[]>([]);
  const [automationSites, setAutomationSites] = useState<Site[]>([]);
  const [automationBusy, setAutomationBusy] = useState(false);
  const [schedForm, setSchedForm] = useState<{
    name: string; target: string; scan_type: DiscoveryScanType;
    interval_minutes: string; enabled: boolean; group_id: string; notif_profile_id: string;
  }>({ name: "", target: "", scan_type: "ping", interval_minutes: "1440", enabled: true, group_id: "", notif_profile_id: "" });

  async function loadAdminData() {
    setLoading(true);
    setError(null);
    try {
      const [userRows, syslog, settingsData] = await Promise.all([
        api.listUsers(accessToken),
        api.syslogStatus(accessToken),
        api.adminSettings(accessToken),
      ]);
      setUsers(userRows);
      setSyslogStatus(syslog);
      setSettingsForm(settingsData);
      setMonitorIntervalRaw(String(settingsData.monitor_interval_seconds));
      setIdleTimeoutRaw(String(settingsData.idle_timeout_minutes));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load admin data");
    } finally {
      setLoading(false);
    }
  }

  async function loadAuditLogs(offset = 0, userId: number | null = null) {
    try {
      const params: { limit: number; offset: number; actor_user_id?: number } = { limit: 50, offset };
      if (userId !== null) params.actor_user_id = userId;
      const result = await api.listAuditLogs(accessToken, params);
      setAuditLogs(result.records);
      setAuditLogsTotal(result.total);
      setAuditOffset(offset);
      setAuditUserFilter(userId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load audit logs");
    }
  }

  useEffect(() => { void loadAdminData(); }, [accessToken]);
  useEffect(() => { if (activeTab === "security") void loadAuditLogs(0, null); }, [activeTab]);
  useEffect(() => {
    if (activeTab !== "notifications") return;
    void api.getNotificationSettings(accessToken).then(setNotifSettings).catch(() => {});
    void loadNotificationProfiles();
  }, [activeTab, accessToken]);
  useEffect(() => {
    if (activeTab !== "alerts") return;
    void loadAlertRules();
    void loadNotificationProfiles();
  }, [activeTab]);
  useEffect(() => {
    if (activeTab !== "groups") return;
    void api.getRolePermissions(accessToken).then((data) => {
      setRolePermissions(data);
      setLocalRolePerms(data.roles);
    }).catch(() => {});
  }, [activeTab, accessToken]);
  useEffect(() => { if (activeTab === "credentials") void loadSnmpProfiles(); }, [activeTab]);
  useEffect(() => { if (activeTab === "automation") void loadAutomation(); }, [activeTab]);

  async function loadSnmpProfiles() {
    setSnmpProfilesBusy(true);
    try {
      setSnmpProfiles(await api.listSnmpProfiles(accessToken));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load SNMP profiles");
    } finally {
      setSnmpProfilesBusy(false);
    }
  }

  async function createSnmpProfile(event: FormEvent) {
    event.preventDefault();
    setSnmpProfilesBusy(true);
    setError(null); setSuccess(null);
    try {
      const created = await api.createSnmpProfile(accessToken, {
        name: snmpProfileForm.name.trim(),
        community: snmpProfileForm.community,
        port: Number(snmpProfileForm.port),
        timeout_seconds: Number(snmpProfileForm.timeout_seconds),
        retries: Number(snmpProfileForm.retries),
      });
      setSnmpProfiles((current) => [...current, created].sort((a, b) => a.name.localeCompare(b.name)));
      setSnmpProfileForm({ name: "", community: "", port: "161", timeout_seconds: "3", retries: "1" });
      setSuccess(`SNMP profile "${created.name}" created.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to create SNMP profile");
    } finally {
      setSnmpProfilesBusy(false);
    }
  }

  async function deleteSnmpProfile(profile: SnmpProfile) {
    setSnmpProfilesBusy(true);
    setError(null); setSuccess(null);
    try {
      await api.deleteSnmpProfile(accessToken, profile.id);
      setSnmpProfiles((current) => current.filter((item) => item.id !== profile.id));
      setSuccess(`SNMP profile "${profile.name}" deleted.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to delete SNMP profile");
    } finally {
      setSnmpProfilesBusy(false);
    }
  }

  async function saveRolePermissions() {
    setGroupsBusy(true);
    setError(null); setSuccess(null);
    try {
      const updated = await api.updateRolePermissions(accessToken, localRolePerms);
      setRolePermissions(updated);
      setLocalRolePerms(updated.roles);
      setSuccess("Role permissions saved.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to save role permissions");
    } finally {
      setGroupsBusy(false);
    }
  }

  async function createGroup(name: string) {
    if (!name.trim()) return;
    setGroupsBusy(true);
    setError(null); setSuccess(null);
    try {
      const updated = await api.createRole(accessToken, name.trim());
      setRolePermissions(updated);
      setLocalRolePerms(updated.roles);
      setNewGroupName("");
      setShowNewGroupForm(false);
      setSuccess(`Role "${name.trim()}" created.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to create role");
    } finally {
      setGroupsBusy(false);
    }
  }

  async function deleteGroup(name: string) {
    setGroupsBusy(true);
    setError(null); setSuccess(null);
    try {
      const updated = await api.deleteRole(accessToken, name);
      setRolePermissions(updated);
      setLocalRolePerms(updated.roles);
      setSuccess(`Role "${name}" deleted. Affected users reassigned to Viewer.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to delete role");
    } finally {
      setGroupsBusy(false);
    }
  }

  async function saveNotifSettings() {
    setNotifBusy(true);
    setError(null); setSuccess(null);
    try {
      const updated = await api.updateNotificationSettings(accessToken, notifSettings);
      setNotifSettings(updated);
      setSuccess("Notification settings saved.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to save notification settings");
    } finally { setNotifBusy(false); }
  }

  async function testNotif(channel: string) {
    setNotifTestResult((c) => ({ ...c, [channel]: "Sending…" }));
    try {
      await api.updateNotificationSettings(accessToken, notifSettings);
      const res = await api.testNotification(accessToken, channel);
      setNotifTestResult((c) => ({ ...c, [channel]: res.status === "ok" ? "Sent successfully" : res.status }));
    } catch (err) {
      setNotifTestResult((c) => ({ ...c, [channel]: err instanceof Error ? err.message : "Failed" }));
    }
  }

  async function loadNotificationProfiles() {
    try {
      setNotificationProfiles(await api.listNotificationProfiles(accessToken));
    } catch {
      // Legacy notification settings still work if profile loading fails.
    }
  }

  async function saveNotificationProfile(event: FormEvent) {
    event.preventDefault();
    setProfileBusy(true);
    setError(null); setSuccess(null);
    try {
      if (editingProfileId !== null) {
        const isApprise = providerForMethod(profileForm.method) === "apprise";
        const hasCredentials = !isApprise || profileFormIsComplete(profileForm);
        const updated = await api.updateNotificationProfile(accessToken, editingProfileId, {
          name: profileForm.name.trim(),
          enabled: profileForm.enabled,
          ...(hasCredentials && {
            provider: providerForMethod(profileForm.method),
            config: buildNotificationConfig(profileForm),
          }),
        });
        setNotificationProfiles((current) => current.map((p) => p.id === updated.id ? updated : p));
        setProfileForm(emptyProfileForm);
        setEditingProfileId(null);
        setShowProfileModal(false);
        setSuccess(`Notification method "${updated.name}" updated.`);
      } else {
        const profile = await api.createNotificationProfile(accessToken, {
          name: profileForm.name.trim(),
          provider: providerForMethod(profileForm.method),
          enabled: profileForm.enabled,
          config: buildNotificationConfig(profileForm),
        });
        setNotificationProfiles((current) => [...current, profile].sort((a, b) => a.name.localeCompare(b.name)));
        setProfileForm(emptyProfileForm);
        setShowProfileModal(false);
        setSuccess(`Notification method "${profile.name}" created.`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : editingProfileId !== null ? "Unable to update notification method" : "Unable to create notification method");
    } finally {
      setProfileBusy(false);
    }
  }

  async function toggleNotificationProfile(profile: NotificationProfile) {
    setProfileBusy(true);
    setError(null); setSuccess(null);
    try {
      const updated = await api.updateNotificationProfile(accessToken, profile.id, { enabled: !profile.enabled });
      setNotificationProfiles((current) => current.map((item) => item.id === updated.id ? updated : item));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to update notification profile");
    } finally {
      setProfileBusy(false);
    }
  }

  async function deleteNotificationProfile(profile: NotificationProfile) {
    setProfileBusy(true);
    setError(null); setSuccess(null);
    try {
      await api.deleteNotificationProfile(accessToken, profile.id);
      setNotificationProfiles((current) => current.filter((item) => item.id !== profile.id));
      setAlertForm((current) => ({ ...current, channels: current.channels.filter((channel) => channel !== `profile:${profile.id}`) }));
      setSuccess(`Notification profile "${profile.name}" deleted.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to delete notification profile");
    } finally {
      setProfileBusy(false);
    }
  }

  async function testNotificationProfile(profile: NotificationProfile) {
    setProfileTestResult((current) => ({ ...current, [profile.id]: "Sending…" }));
    try {
      const result = await api.testNotificationProfile(accessToken, profile.id);
      setProfileTestResult((current) => ({ ...current, [profile.id]: result.status === "ok" ? "Sent successfully" : result.status }));
    } catch (err) {
      setProfileTestResult((current) => ({ ...current, [profile.id]: err instanceof Error ? err.message : "Failed" }));
    }
  }

  async function loadAlertRules() {
    try {
      const rules = await api.listAlertRules(accessToken);
      setAlertRules(rules);
    } catch {
      // silent
    }
  }

  async function saveAlertRule() {
    setAlertRulesBusy(true);
    setAlertRulesError(null);
    try {
      if (editingAlertRule) {
        await api.updateAlertRule(accessToken, editingAlertRule.id, alertForm);
      } else {
        await api.createAlertRule(accessToken, alertForm);
      }
      setShowAlertForm(false);
      setEditingAlertRule(null);
      await loadAlertRules();
    } catch (err) {
      setAlertRulesError(err instanceof Error ? err.message : "Failed to save rule");
    } finally {
      setAlertRulesBusy(false);
    }
  }

  async function deleteAlertRule(id: number) {
    try {
      await api.deleteAlertRule(accessToken, id);
      await loadAlertRules();
    } catch {
      // silent
    }
  }

  async function toggleAlertRule(rule: AlertRule) {
    await api.updateAlertRule(accessToken, rule.id, { enabled: !rule.enabled });
    await loadAlertRules();
  }

  async function runAlertTest(ruleId: number) {
    setAlertTestBusy(ruleId);
    setAlertTestResults((prev) => ({ ...prev, [ruleId]: {} }));
    try {
      const raw = await api.testAlertRule(accessToken, ruleId);
      // Backend returns "ok" on success — normalise to a readable label
      const normalised = Object.fromEntries(
        Object.entries(raw).map(([ch, res]) => [ch, res === "ok" ? "Sent successfully" : res])
      );
      setAlertTestResults((prev) => ({ ...prev, [ruleId]: normalised }));
    } catch (err) {
      setAlertTestResults((prev) => ({ ...prev, [ruleId]: { error: err instanceof Error ? err.message : "Test failed" } }));
    } finally {
      setAlertTestBusy(null);
    }
  }

  function notificationTargetLabel(target: string): string {
    if (target.startsWith("profile:")) {
      const id = Number(target.slice("profile:".length));
      const profile = notificationProfiles.find((item) => item.id === id);
      return profile ? profile.name : `Profile #${id}`;
    }
    return legacyChannelLabels[target] ?? target;
  }

  function notificationProfileMethodLabel(profile: NotificationProfile): string {
    const method = profile.config.method || "";
    return profile.config.method_label || notificationMethodLabels[method] || "Custom Apprise URL";
  }

  async function updateUser(userId: number, payload: { role?: string; is_active?: boolean; email?: string | null; avatar_data?: string | null }) {
    setBusyUserId(userId);
    setError(null); setSuccess(null);
    try {
      const updated = await api.updateUser(accessToken, userId, payload);
      setUsers((current) => current.map((u) => (u.id === updated.id ? updated : u)));
      setSuccess(`Updated ${updated.username}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to update user");
    } finally { setBusyUserId(null); }
  }

  function handleAdminAvatarUpload(userId: number, file: File) {
    if (!file.type.startsWith("image/")) { setError("Please select an image file."); return; }
    if (file.size > 2 * 1024 * 1024) { setError("Image must be under 2 MB."); return; }
    const reader = new FileReader();
    reader.onload = (e) => { void updateUser(userId, { avatar_data: e.target?.result as string }); };
    reader.readAsDataURL(file);
  }

  async function saveEmail(userId: number, email: string) {
    setEditingEmailId(null);
    const value = email.trim() || null;
    const user = users.find((u) => u.id === userId);
    if (value === (user?.email ?? null)) return;
    await updateUser(userId, { email: value });
  }

  async function resetPassword(event: FormEvent) {
    event.preventDefault();
    if (resetPasswordForm.userId === null || !resetPasswordForm.password) return;
    setBusyUserId(resetPasswordForm.userId);
    setError(null); setSuccess(null);
    try {
      await api.resetUserPassword(accessToken, resetPasswordForm.userId, resetPasswordForm.password);
      const user = users.find((u) => u.id === resetPasswordForm.userId);
      setSuccess(`Password reset for ${user?.username ?? "user"}`);
      setResetPasswordForm({ userId: null, password: "" });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to reset password");
    } finally { setBusyUserId(null); }
  }

  async function forceLogout(userId: number) {
    setBusyUserId(userId);
    setError(null); setSuccess(null);
    try {
      await api.forceLogoutUser(accessToken, userId);
      const user = users.find((u) => u.id === userId);
      setSuccess(`Logged out all sessions for ${user?.username ?? "user"}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to force logout");
    } finally { setBusyUserId(null); }
  }

  async function unlockLogin(userId: number) {
    setBusyUserId(userId);
    setError(null); setSuccess(null);
    try {
      await api.unlockUserLogin(accessToken, userId);
      const user = users.find((u) => u.id === userId);
      setSuccess(`Login lockout cleared for ${user?.username ?? "user"}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to unlock login");
    } finally { setBusyUserId(null); }
  }

  async function createUser(event: FormEvent) {
    event.preventDefault();
    setError(null); setSuccess(null);
    try {
      const created = await api.createUser(accessToken, createForm);
      setUsers((current) => [...current, created].sort((a, b) => a.username.localeCompare(b.username)));
      setCreateForm({ username: "", password: "", email: "", role: "Viewer", is_active: true });
      setSuccess(`Created ${created.username}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to create user");
    }
  }

  async function saveSettings(event: FormEvent) {
    event.preventDefault();
    setSettingsBusy(true);
    setError(null); setSuccess(null);
    try {
      const updated = await api.updateAdminSettings(accessToken, settingsForm);
      setSettingsForm(updated);
      setMonitorIntervalRaw(String(updated.monitor_interval_seconds));
      setIdleTimeoutRaw(String(updated.idle_timeout_minutes));
      onSettingsChange(updated);
      setSuccess("Settings saved");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to save settings");
    } finally { setSettingsBusy(false); }
  }

  async function runBackup() {
    setBackupBusy("backup");
    setError(null); setSuccess(null);
    try {
      const result = await api.downloadBackup(accessToken);
      triggerDownload(result);
      setSuccess(`Downloaded ${result.filename}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Backup failed");
    } finally { setBackupBusy(null); }
  }

  async function runRestore() {
    if (!restoreFile) return;
    setBackupBusy("restore");
    setError(null); setSuccess(null);
    try {
      await api.restoreBackup(accessToken, restoreFile);
      setSuccess(`Restored from ${restoreFile.name}`);
      setRestoreFile(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Restore failed");
    } finally { setBackupBusy(null); }
  }

  async function loadDiagnostics() {
    setDiagBusy(true);
    try {
      const data = await api.getSystemDiagnostics(accessToken);
      setDiagnostics(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load diagnostics");
    } finally {
      setDiagBusy(false);
    }
  }

  async function loadAutomation() {
    setAutomationBusy(true);
    try {
      const [nextSchedules, nextObservations, nextGroups, nextSites, nextProfiles] = await Promise.all([
        api.listDiscoverySchedules(accessToken),
        api.listDiscoveryObservations(accessToken, { status_filter: "all" }),
        api.topologyGroups(accessToken),
        api.sites(accessToken),
        api.listNotificationProfiles(accessToken),
      ]);
      setSchedules(nextSchedules);
      setObservations(nextObservations);
      setAutomationGroups(nextGroups);
      setAutomationSites(nextSites);
      setNotificationProfiles(nextProfiles);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load automation data");
    } finally {
      setAutomationBusy(false);
    }
  }

  async function createSchedule(event: FormEvent) {
    event.preventDefault();
    if (!schedForm.target.trim()) return;
    setAutomationBusy(true);
    setError(null); setSuccess(null);
    try {
      const payload: DiscoverySchedulePayload = {
        name: schedForm.name.trim() || schedForm.target.trim(),
        target: schedForm.target.trim(),
        scan_type: schedForm.scan_type,
        enabled: schedForm.enabled,
        interval_minutes: Number(schedForm.interval_minutes),
        confirm_large_scan: false,
        topology_group_id: schedForm.group_id ? Number(schedForm.group_id) : null,
        notification_targets: schedForm.notif_profile_id ? [`profile:${schedForm.notif_profile_id}`] : [],
      };
      await api.createDiscoverySchedule(accessToken, payload);
      setSchedForm({ name: "", target: "", scan_type: "ping", interval_minutes: "1440", enabled: true, group_id: "", notif_profile_id: "" });
      await loadAutomation();
      setSuccess("Schedule created.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create schedule");
    } finally {
      setAutomationBusy(false);
    }
  }

  async function toggleSchedule(schedule: DiscoverySchedule) {
    setAutomationBusy(true);
    try {
      await api.updateDiscoverySchedule(accessToken, schedule.id, { enabled: !schedule.enabled });
      await loadAutomation();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update schedule");
    } finally {
      setAutomationBusy(false);
    }
  }

  async function runScheduleNow(schedule: DiscoverySchedule) {
    setAutomationBusy(true);
    try {
      const result = await api.runDiscoverySchedule(accessToken, schedule.id);
      await loadAutomation();
      if (result.error) setError(`Scan completed with error: ${result.error}`);
      else setSuccess(`Scan completed — ${schedule.name}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to run schedule");
    } finally {
      setAutomationBusy(false);
    }
  }

  async function deleteSchedule(schedule: DiscoverySchedule) {
    if (!confirm(`Delete schedule "${schedule.name}"?`)) return;
    setAutomationBusy(true);
    try {
      await api.deleteDiscoverySchedule(accessToken, schedule.id);
      await loadAutomation();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete schedule");
    } finally {
      setAutomationBusy(false);
    }
  }

  async function updateObservation(observation: DiscoveryObservation, status: "acknowledged" | "resolved") {
    try {
      await api.updateDiscoveryObservation(accessToken, observation.id, status);
      setObservations((prev) => prev.map((o) => o.id === observation.id ? { ...o, status } : o));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update observation");
    }
  }

  async function applyObservation(observation: DiscoveryObservation) {
    setAutomationBusy(true);
    try {
      const updated = await api.applyObservation(accessToken, observation.id);
      setObservations((prev) => prev.map((o) => o.id === observation.id ? updated : o));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to apply observation");
    } finally {
      setAutomationBusy(false);
    }
  }

  const filteredUsers = useMemo(
    () => users.filter((u) => !userSearch || u.username.toLowerCase().includes(userSearch.toLowerCase())),
    [users, userSearch],
  );
  const adminTabs = [
    { id: "system", label: "System", Icon: Settings },
    { id: "users", label: "Users", Icon: IconUsers },
    { id: "groups", label: "Groups", Icon: IconShieldCheck },
    { id: "credentials", label: "SNMP Profiles", Icon: IconServer },
    { id: "notifications", label: "Notifications", Icon: IconCloud },
    { id: "alerts", label: "Alerts", Icon: IconAlertCircle },
    { id: "automation", label: "Automation", Icon: IconCalendarClock },
    { id: "security", label: "Security", Icon: Shield },
  ] as const;

  return (
    <section className="admin-layout">
      <div className="admin-tabs">
        {adminTabs.map(({ id, label, Icon }) => (
          <button key={id} type="button" className={`admin-tab-btn${activeTab === id ? " active" : ""}`} onClick={() => setActiveTab(id)}>
            <Icon size={14} aria-hidden="true" />
            {label}
          </button>
        ))}
      </div>

      {error && <div className="form-error">{error}</div>}
      {success && <div className="success-banner">{success}</div>}

      {activeTab === "users" && (
        <div className="admin-tab-content">
          <section className="panel admin-panel">
            <div className="admin-panel-header">
              <h2 className="admin-section-title"><IconUsers size={16} />Users</h2>
              <button type="button" className="ipam-btn" onClick={() => void loadAdminData()}>Refresh</button>
            </div>
            <input className="admin-search" type="search" placeholder="Search users…" value={userSearch} onChange={(e) => setUserSearch(e.target.value)} />
            {loading ? <p>Loading…</p> : (
              <div className="admin-users-table">
                <div className="admin-users-header">
                  <span>User</span>
                  <span className="admin-col-center">Role</span>
                  <span className="admin-col-center">Status</span>
                  <span className="admin-col-center">Actions</span>
                </div>
                {filteredUsers.map((row) => (
                  <div className="admin-users-row" key={row.id}>
                    <div className="admin-user-identity">
                      <div className="admin-user-avatar-wrap">
                        <label className={`admin-user-avatar admin-user-avatar--${row.role.toLowerCase()}`} title="Upload photo">
                          {row.avatar_data
                            ? <img src={row.avatar_data} alt={row.username} className="admin-avatar-img" />
                            : <span className="admin-avatar-initials">{userInitials(row.username)}</span>
                          }
                          <span className="admin-avatar-overlay" aria-hidden="true">
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>
                          </span>
                          <input type="file" accept="image/*" style={{ display: "none" }} onChange={(e) => { const f = e.target.files?.[0]; if (f) handleAdminAvatarUpload(row.id, f); e.target.value = ""; }} />
                        </label>
                        {row.avatar_data && (
                          <button type="button" className="admin-avatar-clear" title="Remove photo" onClick={() => void updateUser(row.id, { avatar_data: null })}>×</button>
                        )}
                      </div>
                      <div className="admin-user-info">
                        <span className="admin-user-name">{row.username}</span>
                        {editingEmailId === row.id ? (
                          <div className="admin-email-edit-row">
                            <input
                              className="admin-email-input"
                              type="email"
                              autoFocus
                              maxLength={254}
                              placeholder="Email address"
                              value={editingEmailValue}
                              onChange={(e) => setEditingEmailValue(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") { e.preventDefault(); void saveEmail(row.id, editingEmailValue); }
                                if (e.key === "Escape") setEditingEmailId(null);
                              }}
                              onBlur={() => void saveEmail(row.id, editingEmailValue)}
                            />
                            <button type="button" className="admin-email-btn admin-email-btn--save" onMouseDown={(e) => { e.preventDefault(); void saveEmail(row.id, editingEmailValue); }}><Check size={11} /></button>
                            <button type="button" className="admin-email-btn" onMouseDown={(e) => { e.preventDefault(); setEditingEmailId(null); }}><X size={11} /></button>
                          </div>
                        ) : (
                          <button
                            type="button"
                            className="admin-email-display"
                            onClick={() => { setEditingEmailId(row.id); setEditingEmailValue(row.email ?? ""); }}
                          >
                            {row.email
                              ? <span className="admin-user-email">{row.email}</span>
                              : <span className="admin-email-placeholder">Add email…</span>
                            }
                            <Pencil size={10} className="admin-email-pencil" />
                          </button>
                        )}
                      </div>
                    </div>
                    <div>
                      <select
                        className={`admin-role-select admin-role-select--${row.role.toLowerCase()}`}
                        value={row.role}
                        disabled={busyUserId === row.id}
                        onChange={(e) => void updateUser(row.id, { role: e.target.value })}
                      >
                        <option value="SuperAdmin">SuperAdmin</option>
                        <option value="NetworkAdmin">NetworkAdmin</option>
                        <option value="SecurityAnalyst">SecurityAnalyst</option>
                        <option value="Viewer">Viewer</option>
                        {Object.keys(localRolePerms).filter(r => !["SuperAdmin","NetworkAdmin","SecurityAnalyst","Viewer"].includes(r)).sort().map(r => (
                          <option key={r} value={r}>{r}</option>
                        ))}
                      </select>
                    </div>
                    <div className="admin-col-center">
                      <label className="admin-status-toggle">
                        <input type="checkbox" checked={row.is_active} disabled={busyUserId === row.id} onChange={(e) => void updateUser(row.id, { is_active: e.target.checked })} />
                        <span className={`admin-status-pill ${row.is_active ? "active" : "suspended"}`}>
                          {row.is_active ? "Active" : "Disabled"}
                        </span>
                      </label>
                    </div>
                    <div className="admin-row-actions">
                      <button type="button" className="admin-action-btn" disabled={busyUserId === row.id} onClick={() => setResetPasswordForm({ userId: row.id, password: "" })}>Reset PW</button>
                      <button type="button" className="admin-action-btn" disabled={busyUserId === row.id} onClick={() => void unlockLogin(row.id)}>Unlock</button>
                      <button type="button" className="admin-action-btn admin-action-btn--danger" disabled={busyUserId === row.id} onClick={() => void forceLogout(row.id)}>Logout</button>
                      <button type="button" className="admin-action-btn" onClick={() => { setActiveTab("security"); void loadAuditLogs(0, row.id); }}>Audit</button>
                    </div>
                  </div>
                ))}
              </div>
            )}
            {resetPasswordForm.userId !== null && (
              <form className="tool-form admin-reset-form" onSubmit={resetPassword}>
                <h3>Reset password — {users.find((u) => u.id === resetPasswordForm.userId)?.username}</h3>
                <label>
                  New password (min 12 chars)
                  <input required minLength={12} type="password" value={resetPasswordForm.password} onChange={(e) => setResetPasswordForm((c) => ({ ...c, password: e.target.value }))} />
                </label>
                <div className="admin-reset-actions">
                  <button type="submit" className="ipam-btn ipam-btn--primary" disabled={busyUserId === resetPasswordForm.userId}>Save</button>
                  <button type="button" className="ipam-btn" onClick={() => setResetPasswordForm({ userId: null, password: "" })}>Cancel</button>
                </div>
              </form>
            )}
            <form className="tool-form admin-create-form" onSubmit={createUser}>
              <h3>Add user</h3>
              <div className="tool-form-grid">
                <label>Username <input required minLength={3} maxLength={80} value={createForm.username} onChange={(e) => setCreateForm((c) => ({ ...c, username: e.target.value }))} /></label>
                <label>Password <input required minLength={12} type="password" value={createForm.password} onChange={(e) => setCreateForm((c) => ({ ...c, password: e.target.value }))} /></label>
              </div>
              <div className="tool-form-grid">
                <label>Email <input type="email" maxLength={254} placeholder="Optional — for password reset emails" value={createForm.email} onChange={(e) => setCreateForm((c) => ({ ...c, email: e.target.value }))} /></label>
                <label>Role
                  <select value={createForm.role} onChange={(e) => setCreateForm((c) => ({ ...c, role: e.target.value }))}>
                    <option value="Viewer">Viewer</option>
                    <option value="SecurityAnalyst">SecurityAnalyst</option>
                    <option value="NetworkAdmin">NetworkAdmin</option>
                    <option value="SuperAdmin">SuperAdmin</option>
                    {Object.keys(localRolePerms).filter(r => !["SuperAdmin","NetworkAdmin","SecurityAnalyst","Viewer"].includes(r)).sort().map(r => (
                      <option key={r} value={r}>{r}</option>
                    ))}
                  </select>
                </label>
              </div>
              <label className="inline-toggle"><input checked={createForm.is_active} type="checkbox" onChange={(e) => setCreateForm((c) => ({ ...c, is_active: e.target.checked }))} />Active on create</label>
              <button type="submit" className="ipam-btn ipam-btn--primary">Create user</button>
            </form>
          </section>
        </div>
      )}

      {activeTab === "security" && (
        <div className="admin-tab-content">
          <section className="panel admin-panel">
            <div className="admin-panel-header">
              <h2 className="admin-section-title"><Shield size={16} />{auditUserFilter ? `Activity — ${users.find((u) => u.id === auditUserFilter)?.username ?? "user"}` : "Login & Audit History"}</h2>
              <div className="admin-panel-actions">
                {auditUserFilter && <button type="button" className="ipam-btn" onClick={() => void loadAuditLogs(0, null)}>All users</button>}
                <button type="button" className="ipam-btn" onClick={() => void loadAuditLogs(auditOffset, auditUserFilter)}>Refresh</button>
              </div>
            </div>
            <div className="audit-log-table">
              <div className="audit-log-header">
                <span>Time</span>
                <span>Event</span>
                <span>Actor</span>
                <span>Context</span>
              </div>
              {auditLogs.length === 0 && <p className="audit-empty">No audit records found.</p>}
              {auditLogs.map((log) => {
                const dt = new Date(log.created_at);
                const category = log.action.split(".")[0];
                const actor = log.actor_user_id
                  ? (users.find((u) => u.id === log.actor_user_id)?.username ?? `#${log.actor_user_id}`)
                  : "system";
                return (
                  <div className="audit-log-row" key={log.id}>
                    <div className="audit-time-cell">
                      <span className="audit-date">{dt.toLocaleDateString()}</span>
                      <span className="audit-time">{dt.toLocaleTimeString()}</span>
                    </div>
                    <div className="audit-event-cell">
                      <span className={`audit-category-badge audit-category-badge--${category}`}>{category}</span>
                      <span className="audit-action">{log.action.includes(".") ? log.action.slice(log.action.indexOf(".") + 1) : log.action}</span>
                    </div>
                    <span className="audit-actor">{actor}</span>
                    <div className="audit-context-cell">
                      {log.target && <span className="audit-target">{log.target}</span>}
                      {log.detail && <span className="audit-detail">{log.detail}</span>}
                      {!log.target && !log.detail && <span className="audit-detail">—</span>}
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="audit-pagination">
              <button type="button" className="ipam-btn" disabled={auditOffset === 0} onClick={() => void loadAuditLogs(Math.max(0, auditOffset - 50), auditUserFilter)}>← Prev</button>
              <span>{auditOffset + 1}–{Math.min(auditOffset + 50, auditLogsTotal)} of {auditLogsTotal}</span>
              <button type="button" className="ipam-btn" disabled={auditOffset + 50 >= auditLogsTotal} onClick={() => void loadAuditLogs(auditOffset + 50, auditUserFilter)}>Next →</button>
            </div>
          </section>
        </div>
      )}

      {activeTab === "system" && (
        <div className="admin-tab-content">
          <div className="admin-system-stats">
            <div className="admin-system-stat">
              <span className="admin-system-stat-icon admin-system-stat-icon--teal"><IconDeviceDesktop size={22} /></span>
              <div>
                <strong>{summary?.device_count ?? graph.devices.length}</strong>
                <span>Devices</span>
              </div>
            </div>
            <div className="admin-system-stat">
              <span className="admin-system-stat-icon admin-system-stat-icon--blue"><IconBolt size={22} /></span>
              <div>
                <strong>{summary?.relationship_count ?? graph.relationships.length}</strong>
                <span>Links</span>
              </div>
            </div>
            <div className="admin-system-stat">
              <span className="admin-system-stat-icon admin-system-stat-icon--purple"><IconUsers size={22} /></span>
              <div>
                <strong>{summary?.group_count ?? new Set(graph.devices.map((d) => d.topology_group).filter(Boolean)).size}</strong>
                <span>Groups</span>
              </div>
            </div>
            <div className="admin-system-stat">
              <span className="admin-system-stat-icon admin-system-stat-icon--teal"><UserCircle size={22} /></span>
              <div>
                <strong>{users.length}</strong>
                <span>Users</span>
              </div>
            </div>
          </div>
          <div className="system-tab-grid">
            <div className="system-tab-col">
              <section className="panel admin-panel">
                <h2 className="admin-section-title"><Settings size={16} />App settings</h2>
                <form className="tool-form" onSubmit={saveSettings}>
                  <label>App name <input maxLength={80} value={settingsForm.app_name} onChange={(e) => setSettingsForm((c) => ({ ...c, app_name: e.target.value }))} /></label>
                  <label>Login page message <textarea maxLength={300} rows={2} value={settingsForm.login_message} onChange={(e) => setSettingsForm((c) => ({ ...c, login_message: e.target.value }))} /></label>
                  <label>
                    Announcement banner
                    <textarea maxLength={500} rows={3} placeholder="Leave empty to hide. Shown to all logged-in users." value={settingsForm.announcement} onChange={(e) => setSettingsForm((c) => ({ ...c, announcement: e.target.value }))} />
                  </label>
                  <label className="tool-form-inline-check">
                    <input type="checkbox" checked={settingsForm.live_ping_enabled} onChange={(e) => setSettingsForm((c) => ({ ...c, live_ping_enabled: e.target.checked }))} />
                    Enable live ping monitoring
                    <span className="tool-note" style={{ margin: 0 }}>Uncheck to disable all background ping checks across the app</span>
                  </label>
                  <label>
                    Live ping interval (seconds)
                    {(() => {
                      const n = parseInt(monitorIntervalRaw, 10);
                      const err = monitorIntervalRaw.trim() === "" || isNaN(n) ? "Must be a number" : n < 30 ? "Minimum is 30 seconds" : n > 3600 ? "Maximum is 3600 seconds (1 hour)" : null;
                      return (
                        <>
                          <input
                            type="text"
                            inputMode="numeric"
                            placeholder="e.g. 300"
                            value={monitorIntervalRaw}
                            onChange={(e) => {
                              const raw = e.target.value;
                              setMonitorIntervalRaw(raw);
                              const parsed = parseInt(raw, 10);
                              if (!isNaN(parsed) && parsed >= 30 && parsed <= 3600) {
                                setSettingsForm((c) => ({ ...c, monitor_interval_seconds: parsed }));
                              }
                            }}
                            style={err ? { borderColor: "var(--dash-red)" } : undefined}
                          />
                          {err
                            ? <span className="tool-note" style={{ margin: 0, color: "var(--dash-red)" }}>{err}</span>
                            : <span className="tool-note" style={{ margin: 0 }}>How often NetMap runs background ping and service checks. Default is 300 seconds.</span>
                          }
                        </>
                      );
                    })()}
                  </label>
                  <label className="tool-form-inline-check">
                    <input type="checkbox" checked={settingsForm.active_network_public_targets_enabled} onChange={(e) => setSettingsForm((c) => ({ ...c, active_network_public_targets_enabled: e.target.checked }))} />
                    Allow public active network targets
                    <span className="tool-note" style={{ margin: 0 }}>Enables public IP and hostname targets for ping, traceroute, and TCP checks</span>
                  </label>
                  <label>
                    Idle session timeout (minutes)
                    {(() => {
                      const n = parseInt(idleTimeoutRaw, 10);
                      const err = idleTimeoutRaw.trim() === "" || isNaN(n) ? "Must be a number" : n < 1 ? "Minimum is 1 minute" : n > 480 ? "Maximum is 480 minutes (8 hours)" : null;
                      return (
                        <>
                          <input
                            type="text"
                            inputMode="numeric"
                            placeholder="e.g. 15"
                            value={idleTimeoutRaw}
                            onChange={(e) => {
                              const raw = e.target.value;
                              setIdleTimeoutRaw(raw);
                              const parsed = parseInt(raw, 10);
                              if (!isNaN(parsed) && parsed >= 1 && parsed <= 480) {
                                setSettingsForm((c) => ({ ...c, idle_timeout_minutes: parsed }));
                              }
                            }}
                            style={err ? { borderColor: "var(--dash-red)" } : undefined}
                          />
                          {err
                            ? <span className="tool-note" style={{ margin: 0, color: "var(--dash-red)" }}>{err}</span>
                            : <span className="tool-note" style={{ margin: 0 }}>Users are logged out after this many minutes of inactivity (1–480). Set to 480 to effectively disable.</span>
                          }
                        </>
                      );
                    })()}
                  </label>
                  <button type="submit" className="ipam-btn ipam-btn--primary" disabled={settingsBusy || (() => { const n = parseInt(idleTimeoutRaw, 10); const m = parseInt(monitorIntervalRaw, 10); return isNaN(n) || n < 1 || n > 480 || isNaN(m) || m < 30 || m > 3600; })()}>
                    {settingsBusy ? "Saving…" : "Save settings"}
                  </button>
                </form>
              </section>
              <section className="panel admin-panel">
                <h2 className="admin-section-title"><IconDatabase size={16} />Database backup &amp; restore</h2>
                <p className="tool-note">SuperAdmin only. Operates directly on the SQLite database file.</p>
                <div className="tool-form">
                  <button type="button" className="ipam-btn ipam-btn--primary" disabled={backupBusy === "backup"} onClick={() => void runBackup()}>
                    {backupBusy === "backup" ? "Preparing…" : "Download backup"}
                  </button>
                  <label>
                    Restore from backup
                    <input accept=".db,application/octet-stream" type="file" disabled={backupBusy === "restore"} onChange={(e) => setRestoreFile(e.target.files?.[0] ?? null)} />
                  </label>
                  {restoreFile && (
                    <button type="button" className="ipam-btn ipam-btn--primary" disabled={backupBusy === "restore"} onClick={() => void runRestore()}>
                      {backupBusy === "restore" ? "Restoring…" : `Restore ${restoreFile.name}`}
                    </button>
                  )}
                </div>
              </section>
            </div>
            <div className="system-tab-col">
              {versionInfo && (
                <section className="panel admin-panel">
                  <h2 className="admin-section-title"><IconCloud size={16} />Version</h2>
                  <dl className="admin-config-grid">
                    <dt>Installed</dt>
                    <dd>{versionInfo.channel ? `${versionInfo.channel}: ` : "v"}{versionInfo.current}</dd>
                    <dt>Latest</dt>
                    <dd>
                      {versionInfo.latest ? (
                        versionInfo.up_to_date ? (
                          <span style={{ color: "var(--dash-green)" }}>v{versionInfo.latest} — up to date</span>
                        ) : (
                          <a href={versionInfo.release_url} target="_blank" rel="noreferrer" style={{ color: "var(--dash-yellow)" }}>
                            v{versionInfo.latest} — update available
                          </a>
                        )
                      ) : (
                        <span style={{ opacity: 0.5 }}>unavailable</span>
                      )}
                    </dd>
                  </dl>
                </section>
              )}
              <section className="panel admin-panel">
                <div className="system-icon-header">
                  <div>
                    <h2 className="admin-section-title" style={{ margin: 0 }}><IconPalette size={16} />Icons</h2>
                    <p className="tool-note" style={{ margin: "2px 0 0" }}>
                      Active: <strong>{[builtInIconPack, ...iconPacks, ...localIconPacks].find((p) => p.id === activeIconPackId)?.name ?? "Built-in"}</strong>
                      {" · "}{allRuntimePacks.length} pack{allRuntimePacks.length !== 1 ? "s" : ""}
                    </p>
                  </div>
                  <button type="button" className="ipam-btn ipam-btn--primary" onClick={() => setIconModalOpen(true)}>
                    Manage icons →
                  </button>
                </div>
              </section>
              <section className="panel admin-panel">
                <h2 className="admin-section-title"><IconDatabase size={16} />Syslog configuration</h2>
                {syslogStatus ? (
                  <dl className="admin-config-grid">
                    <dt>Firewall retention</dt><dd>{syslogStatus.retention_days} days</dd>
                    <dt>UDP listener</dt><dd>{syslogStatus.udp_enabled ? `enabled :${syslogStatus.udp_port}` : "disabled"}</dd>
                    <dt>TCP listener</dt><dd>{syslogStatus.tcp_enabled ? `enabled :${syslogStatus.tcp_port}` : "disabled"}</dd>
                    <dt>TLS listener</dt><dd>{syslogStatus.tls_enabled ? `enabled :${syslogStatus.tls_port}` : "disabled"}</dd>
                    <dt>Allowlist</dt><dd>{syslogStatus.allowlist_enabled ? "enabled" : "off"}</dd>
                    <dt>Stored events</dt><dd>{syslogStatus.total_events.toLocaleString()}</dd>
                    <dt>Received packets</dt><dd>{syslogStatus.received_packets.toLocaleString()}</dd>
                    <dt>Stored since start</dt><dd>{syslogStatus.stored_events.toLocaleString()}</dd>
                    <dt>Dropped unparsed</dt><dd>{syslogStatus.dropped_unparsed.toLocaleString()}</dd>
                    <dt>Denied senders</dt><dd>{syslogStatus.denied_senders.toLocaleString()}</dd>
                    <dt>Last packet</dt><dd>{syslogStatus.last_packet_at ? `${new Date(syslogStatus.last_packet_at).toLocaleString()} from ${syslogStatus.last_packet_sender ?? "unknown"}` : "n/a"}</dd>
                    <dt>Last stored</dt><dd>{syslogStatus.last_stored_at ? `${new Date(syslogStatus.last_stored_at).toLocaleString()} from ${syslogStatus.last_stored_sender ?? "unknown"}` : "n/a"}</dd>
                    <dt>Last parse drop</dt><dd>{syslogStatus.last_drop_at ? `${new Date(syslogStatus.last_drop_at).toLocaleString()} from ${syslogStatus.last_drop_sender ?? "unknown"}` : "n/a"}</dd>
                    {syslogStatus.last_drop_raw && (
                      <>
                        <dt>Dropped sample</dt><dd><code>{syslogStatus.last_drop_raw}</code></dd>
                      </>
                    )}
                    <dt>Last cleanup</dt><dd>{syslogStatus.retention_last_run_at ? new Date(syslogStatus.retention_last_run_at).toLocaleString() : "n/a"}</dd>
                    <dt>Last event</dt><dd>{syslogStatus.last_event_received_at ? new Date(syslogStatus.last_event_received_at).toLocaleString() : "n/a"}</dd>
                  </dl>
                ) : <p>Loading…</p>}
              </section>
              <section className="panel admin-panel">
                <div className="system-icon-header">
                  <h2 className="admin-section-title"><IconServer size={16} />System diagnostics</h2>
                  <button type="button" className="ipam-btn ipam-btn--primary" disabled={diagBusy} onClick={() => void loadDiagnostics()}>
                    {diagBusy ? "Loading…" : diagnostics ? "Refresh" : "Load"}
                  </button>
                </div>
                {diagnostics ? (
                  <dl className="admin-config-grid">
                    <dt>Main DB</dt>
                    <dd>{fmtBytes(diagnostics.database.main.total_bytes)}{diagnostics.database.main.wal_bytes > 0 ? ` (WAL: ${fmtBytes(diagnostics.database.main.wal_bytes)})` : ""}</dd>
                    <dt>Firewall DB</dt>
                    <dd>{fmtBytes(diagnostics.database.firewall.total_bytes)}{diagnostics.database.firewall.wal_bytes > 0 ? ` (WAL: ${fmtBytes(diagnostics.database.firewall.wal_bytes)})` : ""}</dd>
                    <dt>Last monitor check</dt>
                    <dd>{diagnostics.monitoring.last_checked_at ? new Date(diagnostics.monitoring.last_checked_at).toLocaleString() : "n/a"}</dd>
                    <dt>Device statuses</dt>
                    <dd>{Object.entries(diagnostics.monitoring.device_status_counts).map(([s, n]) => `${s}: ${n}`).join(", ") || "—"}</dd>
                    <dt>Cache — fleet</dt>
                    <dd>{diagnostics.monitoring.cache.fleet_summary.cached
                      ? `hit · ${diagnostics.monitoring.cache.fleet_summary.age_seconds?.toFixed(0) ?? "?"}s old · ${diagnostics.monitoring.cache.fleet_summary.hits}h/${diagnostics.monitoring.cache.fleet_summary.misses}m`
                      : "cold"}</dd>
                    <dt>Cache — devices</dt>
                    <dd>{diagnostics.monitoring.cache.device_summaries.cached
                      ? `hit · ${diagnostics.monitoring.cache.device_summaries.age_seconds?.toFixed(0) ?? "?"}s old · ${diagnostics.monitoring.cache.device_summaries.hits}h/${diagnostics.monitoring.cache.device_summaries.misses}m`
                      : "cold"}</dd>
                    <dt>Syslog events</dt>
                    <dd>{diagnostics.syslog.total_events.toLocaleString()}</dd>
                    <dt>Last syslog event</dt>
                    <dd>{diagnostics.syslog.last_event_received_at ? new Date(diagnostics.syslog.last_event_received_at).toLocaleString() : "n/a"}</dd>
                    <dt>Retention last run</dt>
                    <dd>{diagnostics.syslog.retention_last_run_at ? new Date(diagnostics.syslog.retention_last_run_at).toLocaleString() : "n/a"}</dd>
                    {diagnostics.syslog.retention_last_error && (
                      <>
                        <dt>Retention error</dt>
                        <dd style={{ color: "var(--dash-red)" }}>{diagnostics.syslog.retention_last_error}</dd>
                      </>
                    )}
                    <dt>Process PID</dt>
                    <dd>{diagnostics.process.pid}</dd>
                    <dt>Generated</dt>
                    <dd style={{ opacity: 0.7 }}>{new Date(diagnostics.generated_at).toLocaleString()}</dd>
                  </dl>
                ) : (
                  <p className="tool-note">Click Load to fetch current runtime diagnostics.</p>
                )}
              </section>
            </div>
          </div>
          {iconModalOpen && (
            <IconManagerModal
              activeIconPackId={activeIconPackId}
              iconPacks={iconPacks}
              localIconPacks={localIconPacks}
              iconPackLoading={iconPackLoading}
              iconPackError={iconPackError}
              onSelectIconPack={onSelectIconPack}
              onAddLocalIconPack={onAddLocalIconPack}
              onRemoveLocalIconPack={onRemoveLocalIconPack}
              onClose={() => setIconModalOpen(false)}
            />
          )}
        </div>
      )}

      {activeTab === "credentials" && (
        <div className="admin-tab-content">
          <section className="panel admin-panel">
            <div className="admin-panel-header">
              <h2 className="admin-section-title"><IconServer size={16} />SNMP profiles</h2>
              <button type="button" className="ipam-btn" disabled={snmpProfilesBusy} onClick={() => void loadSnmpProfiles()}>
                Refresh
              </button>
            </div>
            <p className="tool-note">
              SNMPv2c profiles store reusable community strings for probes, discovery ARP enrichment, and assigned router/L3-switch devices.
            </p>
            <form className="tool-form admin-create-form" onSubmit={createSnmpProfile}>
              <h3>Add SNMP profile</h3>
              <div className="tool-form-grid">
                <label>
                  Name
                  <input required maxLength={120} placeholder="Core network SNMP" value={snmpProfileForm.name} onChange={(e) => setSnmpProfileForm((c) => ({ ...c, name: e.target.value }))} />
                </label>
                <label>
                  Community
                  <input required maxLength={128} type="password" value={snmpProfileForm.community} onChange={(e) => setSnmpProfileForm((c) => ({ ...c, community: e.target.value }))} />
                </label>
              </div>
              <div className="tool-form-grid">
                <label>
                  Port
                  <input required min={1} max={65535} type="number" value={snmpProfileForm.port} onChange={(e) => setSnmpProfileForm((c) => ({ ...c, port: e.target.value }))} />
                </label>
                <label>
                  Timeout
                  <input required min={1} max={15} type="number" value={snmpProfileForm.timeout_seconds} onChange={(e) => setSnmpProfileForm((c) => ({ ...c, timeout_seconds: e.target.value }))} />
                </label>
                <label>
                  Retries
                  <input required min={0} max={3} type="number" value={snmpProfileForm.retries} onChange={(e) => setSnmpProfileForm((c) => ({ ...c, retries: e.target.value }))} />
                </label>
              </div>
              <button type="submit" className="ipam-btn ipam-btn--primary" disabled={snmpProfilesBusy}>
                {snmpProfilesBusy ? "Saving..." : "Create profile"}
              </button>
            </form>
            <div className="admin-users-table">
              <div className="admin-users-header">
                <span>Profile</span>
                <span className="admin-col-center">Version</span>
                <span className="admin-col-center">Connection</span>
                <span className="admin-col-center">Actions</span>
              </div>
              {snmpProfiles.map((profile) => (
                <div className="admin-users-row" key={profile.id}>
                  <div className="admin-user-identity">
                    <span className="admin-user-name">{profile.name}</span>
                  </div>
                  <span className="admin-col-center">{profile.version}</span>
                  <span className="admin-col-center">:{profile.port} · {profile.timeout_seconds}s · {profile.retries} retries</span>
                  <div className="admin-row-actions">
                    <button type="button" className="admin-action-btn admin-action-btn--danger" disabled={snmpProfilesBusy} onClick={() => void deleteSnmpProfile(profile)}>
                      Delete
                    </button>
                  </div>
                </div>
              ))}
              {snmpProfiles.length === 0 && <p className="audit-empty">No SNMP profiles configured.</p>}
            </div>
          </section>
        </div>
      )}

      {activeTab === "notifications" && (
        <div className="admin-tab-content">
          <section className="panel admin-panel" style={{ marginBottom: 16 }}>
            <div className="admin-panel-header">
              <h2 className="admin-section-title notif-provider-heading"><IconCloud size={16} />Notification methods</h2>
              <div className="admin-panel-actions">
                <button
                  type="button"
                  className="ipam-btn ipam-btn--primary"
                  onClick={() => { setEditingProfileId(null); setProfileForm(emptyProfileForm); setShowProfileModal(true); }}
                >
                  + Add method
                </button>
                <button type="button" className="ipam-btn" disabled={profileBusy} onClick={() => void loadNotificationProfiles()}>
                  Refresh
                </button>
              </div>
            </div>
            <p className="tool-note">Create reusable notification methods. Common services have guided fields; Custom Apprise URL covers the wider Apprise catalog.</p>
            <details className="notif-apprise-details">
              <summary>Services available via Custom Apprise URL</summary>
              <p className="tool-note" style={{ margin: '6px 0 0' }}>{appriseSupportedMethods.join(", ")} and more.</p>
            </details>
            <div className="notif-methods-table">
              {notificationProfiles.length === 0 ? (
                <p className="audit-empty">No notification methods configured yet. Click <strong>+ Add method</strong> to get started.</p>
              ) : notificationProfiles.map((profile) => (
                <div className="notif-method-row" key={profile.id}>
                  <div className="notif-method-info">
                    <span className="notif-method-name">{profile.name}</span>
                    <div className="notif-method-meta">
                      <span className="notif-method-tag">{notificationProfileMethodLabel(profile)}</span>
                      <span className={`notif-status-badge notif-status-badge--${profile.enabled ? "active" : "off"}`}>
                        {profile.enabled ? "Active" : "Disabled"}
                      </span>
                    </div>
                    {profileTestResult[profile.id] && (
                      <span className={`notif-result${profileTestResult[profile.id] === "Sent successfully" ? " ok" : " err"}`} style={{ display: "block", marginTop: 5 }}>
                        {profileTestResult[profile.id]}
                      </span>
                    )}
                  </div>
                  <div className="notif-method-actions">
                    <button type="button" className="admin-action-btn" disabled={profileBusy} onClick={() => void testNotificationProfile(profile)}>
                      Test
                    </button>
                    <button type="button" className="admin-action-btn" disabled={profileBusy} onClick={() => { setEditingProfileId(profile.id); setProfileForm(populateFormFromProfile(profile)); setShowProfileModal(true); }}>
                      Edit
                    </button>
                    <button type="button" className="admin-action-btn" disabled={profileBusy} onClick={() => void toggleNotificationProfile(profile)}>
                      {profile.enabled ? "Disable" : "Enable"}
                    </button>
                    <button type="button" className="admin-action-btn admin-action-btn--danger" disabled={profileBusy} onClick={() => void deleteNotificationProfile(profile)}>
                      Delete
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </section>
        </div>
      )}

      {showProfileModal && (
        <Modal
          title={editingProfileId !== null ? `Edit — ${profileForm.name || "notification method"}` : "Add notification method"}
          onCancel={() => { setShowProfileModal(false); setEditingProfileId(null); setProfileForm(emptyProfileForm); }}
          headerSubmitLabel={profileBusy ? "Saving…" : editingProfileId !== null ? "Update" : "Save"}
          headerSubmitFormId="notif-profile-form"
          headerSubmitDisabled={profileBusy || (editingProfileId === null ? !profileFormIsComplete(profileForm) : !profileForm.name.trim())}
        >
          <form id="notif-profile-form" className="modal-form" onSubmit={saveNotificationProfile}>
            <div className="notif-modal-type-section">
              <label>
                Notification type
                <select
                  value={profileForm.method}
                  onChange={(e) => setProfileForm((c) => ({ ...c, method: e.target.value as NotificationMethodId }))}
                >
                  {notificationMethodCatalog.map((m) => (
                    <option key={m.id} value={m.id}>{m.label}</option>
                  ))}
                </select>
              </label>
              <p className="notif-modal-type-desc">
                {notificationMethodCatalog.find((m) => m.id === profileForm.method)?.description}
              </p>
            </div>
            <label>
              Name
              <input required maxLength={120} placeholder="e.g. Home Alerts" value={profileForm.name} onChange={(e) => setProfileForm((c) => ({ ...c, name: e.target.value }))} />
            </label>
            {providerForMethod(profileForm.method) === "apprise" && (
              <label>
                Title <span className="tool-note">(optional — shown in notification)</span>
                <input maxLength={80} placeholder="NetMap" value={profileForm.title} onChange={(e) => setProfileForm((c) => ({ ...c, title: e.target.value }))} />
              </label>
            )}
            {profileForm.method === "ntfy" && (
              <div className="modal-form-row">
                <label>
                  Topic URL
                  <input required placeholder="https://ntfy.sh/my-topic" value={profileForm.ntfy_url} onChange={(e) => setProfileForm((c) => ({ ...c, ntfy_url: e.target.value }))} />
                </label>
                <label>
                  Access token <span className="tool-note">(optional)</span>
                  <input type="password" placeholder="tk_..." value={profileForm.ntfy_token} onChange={(e) => setProfileForm((c) => ({ ...c, ntfy_token: e.target.value }))} />
                </label>
              </div>
            )}
            {profileForm.method === "telegram" && (
              <div className="modal-form-row">
                <label>
                  Bot token
                  <input required type="password" placeholder="123456:ABC-DEF..." value={profileForm.telegram_bot_token} onChange={(e) => setProfileForm((c) => ({ ...c, telegram_bot_token: e.target.value }))} />
                </label>
                <label>
                  Chat ID
                  <input required placeholder="-100123456789" value={profileForm.telegram_chat_id} onChange={(e) => setProfileForm((c) => ({ ...c, telegram_chat_id: e.target.value }))} />
                </label>
              </div>
            )}
            {profileForm.method === "signal" && (
              <>
                <label>
                  REST API URL
                  <input required placeholder="http://localhost:8080" value={profileForm.signal_url} onChange={(e) => setProfileForm((c) => ({ ...c, signal_url: e.target.value }))} />
                </label>
                <div className="modal-form-row">
                  <label>
                    Sender number
                    <input required placeholder="+447700000000" value={profileForm.signal_number} onChange={(e) => setProfileForm((c) => ({ ...c, signal_number: e.target.value }))} />
                  </label>
                  <label>
                    Recipient number
                    <input required placeholder="+447700000001" value={profileForm.signal_recipient} onChange={(e) => setProfileForm((c) => ({ ...c, signal_recipient: e.target.value }))} />
                  </label>
                </div>
              </>
            )}
            {profileForm.method === "smtp" && (
              <>
                <div className="modal-form-row">
                  <label>
                    SMTP host
                    <input required placeholder="smtp.gmail.com" value={profileForm.smtp_host} onChange={(e) => setProfileForm((c) => ({ ...c, smtp_host: e.target.value }))} />
                  </label>
                  <label>
                    Port
                    <input placeholder="587" value={profileForm.smtp_port} onChange={(e) => setProfileForm((c) => ({ ...c, smtp_port: e.target.value }))} />
                  </label>
                </div>
                <div className="modal-form-row">
                  <label>
                    Username
                    <input placeholder="you@example.com" value={profileForm.smtp_user} onChange={(e) => setProfileForm((c) => ({ ...c, smtp_user: e.target.value }))} />
                  </label>
                  <label>
                    Password
                    <input type="password" value={profileForm.smtp_password} onChange={(e) => setProfileForm((c) => ({ ...c, smtp_password: e.target.value }))} />
                  </label>
                </div>
                <div className="modal-form-row">
                  <label>
                    From address
                    <input placeholder="netmap@example.com" value={profileForm.smtp_from} onChange={(e) => setProfileForm((c) => ({ ...c, smtp_from: e.target.value }))} />
                  </label>
                  <label>
                    Send alerts to
                    <input required placeholder="admin@example.com" value={profileForm.smtp_to} onChange={(e) => setProfileForm((c) => ({ ...c, smtp_to: e.target.value }))} />
                  </label>
                </div>
                <label className="checkbox-label">
                  <input type="checkbox" checked={profileForm.smtp_tls} onChange={(e) => setProfileForm((c) => ({ ...c, smtp_tls: e.target.checked }))} />
                  <span>Use STARTTLS</span>
                </label>
              </>
            )}
            {profileForm.method === "discord" && (
              <div className="modal-form-row">
                <label>
                  Webhook ID
                  <input required type="password" value={profileForm.discord_webhook_id} onChange={(e) => setProfileForm((c) => ({ ...c, discord_webhook_id: e.target.value }))} />
                </label>
                <label>
                  Webhook token
                  <input required type="password" value={profileForm.discord_webhook_token} onChange={(e) => setProfileForm((c) => ({ ...c, discord_webhook_token: e.target.value }))} />
                </label>
              </div>
            )}
            {profileForm.method === "slack" && (
              <>
                <div className="modal-form-row">
                  <label>
                    Token A
                    <input required type="password" placeholder="T00000000" value={profileForm.slack_token_a} onChange={(e) => setProfileForm((c) => ({ ...c, slack_token_a: e.target.value }))} />
                  </label>
                  <label>
                    Token B
                    <input required type="password" placeholder="B00000000" value={profileForm.slack_token_b} onChange={(e) => setProfileForm((c) => ({ ...c, slack_token_b: e.target.value }))} />
                  </label>
                </div>
                <div className="modal-form-row">
                  <label>
                    Token C
                    <input required type="password" placeholder="XXXXXXXXXXXXXXXX" value={profileForm.slack_token_c} onChange={(e) => setProfileForm((c) => ({ ...c, slack_token_c: e.target.value }))} />
                  </label>
                  <label>
                    Channel <span className="tool-note">(optional)</span>
                    <input placeholder="#alerts" value={profileForm.slack_channel} onChange={(e) => setProfileForm((c) => ({ ...c, slack_channel: e.target.value }))} />
                  </label>
                </div>
              </>
            )}
            {profileForm.method === "gotify" && (
              <div className="modal-form-row">
                <label>
                  Server URL
                  <input required placeholder="https://gotify.example.com" value={profileForm.gotify_base_url} onChange={(e) => setProfileForm((c) => ({ ...c, gotify_base_url: e.target.value }))} />
                </label>
                <label>
                  App token
                  <input required type="password" value={profileForm.gotify_token} onChange={(e) => setProfileForm((c) => ({ ...c, gotify_token: e.target.value }))} />
                </label>
              </div>
            )}
            {profileForm.method === "pushover" && (
              <div className="modal-form-row">
                <label>
                  User key
                  <input required type="password" value={profileForm.pushover_user_key} onChange={(e) => setProfileForm((c) => ({ ...c, pushover_user_key: e.target.value }))} />
                </label>
                <label>
                  Application token
                  <input required type="password" value={profileForm.pushover_app_token} onChange={(e) => setProfileForm((c) => ({ ...c, pushover_app_token: e.target.value }))} />
                </label>
              </div>
            )}
            {profileForm.method === "google_chat" && (
              <>
                <div className="modal-form-row">
                  <label>
                    Workspace
                    <input required type="password" value={profileForm.google_chat_workspace} onChange={(e) => setProfileForm((c) => ({ ...c, google_chat_workspace: e.target.value }))} />
                  </label>
                  <label>
                    Webhook key
                    <input required type="password" value={profileForm.google_chat_key} onChange={(e) => setProfileForm((c) => ({ ...c, google_chat_key: e.target.value }))} />
                  </label>
                </div>
                <label>
                  Webhook token
                  <input required type="password" value={profileForm.google_chat_token} onChange={(e) => setProfileForm((c) => ({ ...c, google_chat_token: e.target.value }))} />
                </label>
              </>
            )}
            {profileForm.method === "custom" && (
              <label>
                Apprise URL
                <input required type="password" placeholder="jsons://example.com/webhook" value={profileForm.custom_url} onChange={(e) => setProfileForm((c) => ({ ...c, custom_url: e.target.value }))} />
              </label>
            )}
            {editingProfileId !== null && providerForMethod(profileForm.method) === "apprise" && (
              <p className="tool-note">Leave credential fields blank to keep existing values.</p>
            )}
            <label className="checkbox-label">
              <input type="checkbox" checked={profileForm.enabled} onChange={(e) => setProfileForm((c) => ({ ...c, enabled: e.target.checked }))} />
              <span>Enabled</span>
            </label>
          </form>
        </Modal>
      )}

      {activeTab === "alerts" && (
        <div className="admin-tab-content">
          <section className="panel admin-panel">
            <div className="admin-panel-header">
              <h2 className="admin-section-title"><IconAlertCircle size={16} />Alert Rules</h2>
              <div className="admin-panel-actions">
                <button type="button" className="ipam-btn ipam-btn--primary" onClick={() => {
                  setEditingAlertRule(null);
                  setAlertForm({ name: "", enabled: true, event_type: "device_offline", device_id: null, channels: [], cooldown_minutes: 30 });
                  setShowAlertForm(true);
                }}>+ Add rule</button>
              </div>
            </div>
            <p className="tool-note">Rules run on the configured live ping interval in the background. Notifications are sent via the channels configured in the Notifications tab.</p>
            {alertRulesError && <div className="form-error">{alertRulesError}</div>}

            {showAlertForm && (
              <div className="tool-form" style={{ marginBottom: 16, padding: '14px 16px', background: 'rgba(29,154,176,0.04)', borderRadius: 8, border: '1px solid rgba(29,154,176,0.15)' }}>
                <label>Rule name
                  <input value={alertForm.name} maxLength={120} onChange={(e) => setAlertForm(f => ({...f, name: e.target.value}))} placeholder="e.g. Core router offline" />
                </label>
                <label>Trigger
                  <select value={alertForm.event_type} onChange={(e) => setAlertForm(f => ({...f, event_type: e.target.value as AlertRuleEventType}))}>
                    <option value="device_offline">Device goes offline</option>
                    <option value="device_online">Device comes back online</option>
                    <option value="device_warning">Device status becomes Warning</option>
                    <option value="any_status_change">Any status change</option>
                  </select>
                </label>
                <label>Device
                  <select value={alertForm.device_id ?? ""} onChange={(e) => setAlertForm(f => ({...f, device_id: e.target.value ? Number(e.target.value) : null}))}>
                    <option value="">All devices</option>
                    {graph.devices.map(d => (
                      <option key={d.id} value={d.id}>{d.display_name || d.hostname || d.ip_address}</option>
                    ))}
                  </select>
                </label>
                <fieldset style={{ border: '1px solid #d0dde6', borderRadius: 6, padding: '8px 12px' }}>
                  <legend style={{ fontSize: 12, fontWeight: 700, color: '#314656', padding: '0 4px' }}>Notify via saved methods</legend>
                  {alertForm.channels.filter((channel) => !channel.startsWith("profile:")).map(ch => (
                    <label key={ch} className="tool-form-inline-check" style={{ marginBottom: 4 }}>
                      <input type="checkbox" checked
                        onChange={(e) => setAlertForm(f => ({
                          ...f,
                          channels: e.target.checked ? f.channels : f.channels.filter(c => c !== ch)
                        }))} />
                      {legacyChannelLabels[ch] ?? ch} <span className="tool-note">(legacy)</span>
                    </label>
                  ))}
                  {notificationProfiles.map(profile => {
                    const target = `profile:${profile.id}`;
                    return (
                      <label key={target} className="tool-form-inline-check" style={{ marginBottom: 4 }}>
                        <input type="checkbox" checked={alertForm.channels.includes(target)}
                          onChange={(e) => setAlertForm(f => ({
                            ...f,
                            channels: e.target.checked ? [...f.channels, target] : f.channels.filter(c => c !== target)
                          }))} />
                        {profile.name} <span className="tool-note">({notificationProfileMethodLabel(profile)}{profile.enabled ? "" : ", disabled"})</span>
                      </label>
                    );
                  })}
                  {notificationProfiles.length === 0 && (
                    <p className="tool-note" style={{ margin: '6px 0 0' }}>Add notification methods in Notifications to target alert rules.</p>
                  )}
                </fieldset>
                <label>Cooldown
                  <select value={alertForm.cooldown_minutes} onChange={(e) => setAlertForm(f => ({...f, cooldown_minutes: Number(e.target.value)}))}>
                    <option value={5}>5 minutes</option>
                    <option value={15}>15 minutes</option>
                    <option value={30}>30 minutes</option>
                    <option value={60}>1 hour</option>
                    <option value={240}>4 hours</option>
                    <option value={1440}>24 hours</option>
                  </select>
                </label>
                <label className="tool-form-inline-check">
                  <input type="checkbox" checked={alertForm.enabled} onChange={(e) => setAlertForm(f => ({...f, enabled: e.target.checked}))} />
                  Enabled
                </label>
                <div className="ipam-form-actions">
                  <button type="button" className="ipam-btn ipam-btn--primary" disabled={alertRulesBusy || !alertForm.name || alertForm.channels.length === 0} onClick={() => void saveAlertRule()}>
                    {alertRulesBusy ? "Saving…" : editingAlertRule ? "Update rule" : "Create rule"}
                  </button>
                  <button type="button" className="ipam-btn" onClick={() => { setShowAlertForm(false); setEditingAlertRule(null); }}>Cancel</button>
                </div>
              </div>
            )}

            {alertRules.length === 0 ? (
              <p className="tool-note">No alert rules yet. Add one to start receiving automated notifications.</p>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ borderBottom: '2px solid rgba(175,198,216,0.5)', textAlign: 'left' }}>
                    <th style={{ padding: '8px 10px', fontWeight: 700, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em', color: '#7a96a8' }}>Name</th>
                    <th style={{ padding: '8px 10px', fontWeight: 700, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em', color: '#7a96a8' }}>Trigger</th>
                    <th style={{ padding: '8px 10px', fontWeight: 700, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em', color: '#7a96a8' }}>Device</th>
                    <th style={{ padding: '8px 10px', fontWeight: 700, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em', color: '#7a96a8' }}>Channels</th>
                    <th style={{ padding: '8px 10px', fontWeight: 700, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em', color: '#7a96a8' }}>Cooldown</th>
                    <th style={{ padding: '8px 10px', fontWeight: 700, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em', color: '#7a96a8' }}>Status</th>
                    <th style={{ padding: '8px 10px' }}></th>
                  </tr>
                </thead>
                <tbody>
                  {alertRules.map(rule => {
                    const triggerLabels: Record<string, string> = {
                      device_offline: "Goes offline",
                      device_online: "Comes online",
                      device_warning: "Warning status",
                      any_status_change: "Any status change",
                    };
                    const deviceName = rule.device_id
                      ? (() => { const d = graph.devices.find(x => x.id === rule.device_id); return d ? (d.display_name || d.hostname || d.ip_address) : `#${rule.device_id}`; })()
                      : "All devices";
                    const testResult = alertTestResults[rule.id];
                    return (
                      <tr key={rule.id} style={{ borderBottom: '1px solid rgba(175,198,216,0.3)' }}>
                        <td style={{ padding: '10px 10px', fontWeight: 600 }}>{rule.name}</td>
                        <td style={{ padding: '10px 10px', color: '#4a6474' }}>{triggerLabels[rule.event_type] ?? rule.event_type}</td>
                        <td style={{ padding: '10px 10px', color: '#4a6474', fontSize: 12 }}>{deviceName}</td>
                        <td style={{ padding: '10px 10px', fontSize: 12 }}>{rule.channels.map(notificationTargetLabel).join(", ") || "—"}</td>
                        <td style={{ padding: '10px 10px', color: '#4a6474', fontSize: 12 }}>{rule.cooldown_minutes >= 60 ? `${rule.cooldown_minutes / 60}h` : `${rule.cooldown_minutes}m`}</td>
                        <td style={{ padding: '10px 10px' }}>
                          <span className={`alert-status-pill${rule.enabled ? " alert-status-pill--active" : ""}`}>
                            {rule.enabled ? "Active" : "Paused"}
                          </span>
                        </td>
                        <td style={{ padding: '10px 10px' }}>
                          <div className="admin-panel-actions">
                            <button type="button" className="admin-action-btn" disabled={alertTestBusy === rule.id} onClick={() => void runAlertTest(rule.id)}>
                              {alertTestBusy === rule.id ? "Testing…" : "Test"}
                            </button>
                            <button type="button" className="admin-action-btn" onClick={() => void toggleAlertRule(rule)}>
                              {rule.enabled ? "Pause" : "Enable"}
                            </button>
                            <button type="button" className="admin-action-btn" onClick={() => {
                              setEditingAlertRule(rule);
                              setAlertForm({ name: rule.name, enabled: rule.enabled, event_type: rule.event_type, device_id: rule.device_id, channels: rule.channels, cooldown_minutes: rule.cooldown_minutes });
                              setShowAlertForm(true);
                            }}>Edit</button>
                            <button type="button" className="admin-action-btn admin-action-btn--danger" onClick={() => void deleteAlertRule(rule.id)}>Delete</button>
                          </div>
                          {testResult && Object.keys(testResult).length > 0 && (
                            <div className="alert-test-results">
                              {Object.entries(testResult).map(([ch, res]) => (
                                <span key={ch} className={`notif-result${res === "Sent successfully" ? " ok" : " err"}`}>
                                  {notificationTargetLabel(ch)}: {res}
                                </span>
                              ))}
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </section>
        </div>
      )}

      {activeTab === "groups" && (
        <div className="admin-tab-content">
          <section className="panel admin-panel">
            <div className="admin-panel-header">
              <h2 className="admin-section-title"><IconShieldCheck size={16} />Role Permissions</h2>
              <div style={{ display: "flex", gap: 8 }}>
                <button type="button" className="ipam-btn" onClick={() => { setShowNewGroupForm((v) => !v); setNewGroupName(""); }}>
                  {showNewGroupForm ? "Cancel" : "+ New group"}
                </button>
                <button type="button" className="ipam-btn ipam-btn--primary" disabled={groupsBusy} onClick={() => void saveRolePermissions()}>
                  {groupsBusy ? "Saving…" : "Save changes"}
                </button>
              </div>
            </div>
            <p className="tool-note">SuperAdmin always has full access. Use the checkboxes below to configure which permissions each role is granted. Custom groups can be assigned to users.</p>

            {showNewGroupForm && (
              <div className="rbac-new-group-form">
                <input
                  className="rbac-new-group-input"
                  type="text"
                  placeholder="Group name (e.g. ReadOnly)"
                  maxLength={40}
                  value={newGroupName}
                  onChange={(e) => setNewGroupName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") void createGroup(newGroupName); }}
                  autoFocus
                />
                <button
                  type="button"
                  className="ipam-btn ipam-btn--primary"
                  disabled={groupsBusy || !newGroupName.trim() || !/^[A-Za-z][A-Za-z0-9_-]*$/.test(newGroupName.trim())}
                  onClick={() => void createGroup(newGroupName)}
                >
                  Create
                </button>
                {newGroupName && !/^[A-Za-z][A-Za-z0-9_-]*$/.test(newGroupName.trim()) && (
                  <span className="rbac-name-error">Must start with a letter, then letters/numbers/- only</span>
                )}
              </div>
            )}

            {rolePermissions ? (() => {
              const BUILT_IN = ["NetworkAdmin", "SecurityAnalyst", "Viewer"] as const;
              const customRoles = Object.keys(localRolePerms).filter(r => !["SuperAdmin", "NetworkAdmin", "SecurityAnalyst", "Viewer"].includes(r)).sort();
              const allRoles = [...BUILT_IN, ...customRoles];
              return (
                <div className="rbac-roles-grid">
                  {allRoles.map((role) => {
                    const isCustom = !["NetworkAdmin", "SecurityAnalyst", "Viewer"].includes(role);
                    const label = role === "NetworkAdmin" ? "Network Admin" : role === "SecurityAnalyst" ? "Security Analyst" : role;
                    return (
                      <div key={role} className={`rbac-role-card${isCustom ? " rbac-role-card--custom" : ""}`}>
                        <div className="rbac-role-header">
                          <h3 className="rbac-role-name">{label}</h3>
                          <button
                            type="button"
                            className="rbac-delete-btn"
                            title={`Delete "${role}" group`}
                            disabled={groupsBusy}
                            onClick={() => { if (confirm(`Delete role "${role}"? Users assigned this role will be moved to Viewer.`)) void deleteGroup(role); }}
                          >✕</button>
                        </div>
                        <ul className="rbac-perm-list">
                          {rolePermissions.permissions.map((perm) => {
                            const granted = (localRolePerms[role] ?? []).includes(perm.key);
                            return (
                              <li key={perm.key} className="rbac-perm-row">
                                <label className="rbac-perm-label">
                                  <input
                                    type="checkbox"
                                    checked={granted}
                                    onChange={(e) => {
                                      setLocalRolePerms((prev) => {
                                        const current = prev[role] ?? [];
                                        return {
                                          ...prev,
                                          [role]: e.target.checked
                                            ? [...current, perm.key]
                                            : current.filter((k) => k !== perm.key),
                                        };
                                      });
                                    }}
                                  />
                                  <span className="rbac-perm-label-text">
                                    <strong>{perm.label}</strong>
                                    <span className="rbac-perm-desc">{perm.description}</span>
                                  </span>
                                </label>
                              </li>
                            );
                          })}
                        </ul>
                      </div>
                    );
                  })}
                </div>
              );
            })() : (
              <p>Loading permissions…</p>
            )}
          </section>
        </div>
      )}

      {activeTab === "automation" && (
        <div className="admin-tab-content">
          <section className="panel admin-panel">
            <div className="admin-panel-header">
              <h2 className="admin-section-title"><IconCalendarClock size={16} />Scheduled scans</h2>
              <button type="button" className="ipam-btn" disabled={automationBusy} onClick={() => void loadAutomation()}>Refresh</button>
            </div>
            <p className="tool-note">
              Scheduled scans automatically probe your network at a set interval and record observations for new devices, IP address changes, field changes, and hosts that disappear.
            </p>
            <form className="tool-form admin-create-form" onSubmit={(e) => void createSchedule(e)}>
              <h3>New schedule</h3>
              <div className="tool-form-grid">
                <label>
                  Target <span className="tool-note" style={{ fontWeight: "normal" }}>(IP, CIDR, or range)</span>
                  <input
                    required
                    placeholder="192.168.1.0/24"
                    value={schedForm.target}
                    onChange={(e) => setSchedForm((f) => ({ ...f, target: e.target.value }))}
                  />
                </label>
                <label>
                  Name <span className="tool-note" style={{ fontWeight: "normal" }}>(optional)</span>
                  <input
                    placeholder="Home network"
                    value={schedForm.name}
                    onChange={(e) => setSchedForm((f) => ({ ...f, name: e.target.value }))}
                  />
                </label>
              </div>
              <div className="tool-form-grid">
                <label>
                  Scan type
                  <select value={schedForm.scan_type} onChange={(e) => setSchedForm((f) => ({ ...f, scan_type: e.target.value as DiscoveryScanType }))}>
                    <option value="ping">Ping only — host discovery</option>
                    <option value="basic_ports">Ping + port scan — common ports</option>
                  </select>
                </label>
                <label>
                  Interval
                  <select value={schedForm.interval_minutes} onChange={(e) => setSchedForm((f) => ({ ...f, interval_minutes: e.target.value }))}>
                    <option value="15">Every 15 minutes</option>
                    <option value="30">Every 30 minutes</option>
                    <option value="60">Every hour</option>
                    <option value="360">Every 6 hours</option>
                    <option value="720">Every 12 hours</option>
                    <option value="1440">Every 24 hours</option>
                  </select>
                </label>
              </div>
              <div className="tool-form-grid">
                <label>
                  Group <span className="tool-note" style={{ fontWeight: "normal" }}>(optional)</span>
                  <select value={schedForm.group_id} onChange={(e) => setSchedForm((f) => ({ ...f, group_id: e.target.value }))}>
                    <option value="">— none —</option>
                    {automationGroups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                  </select>
                </label>
                <label>
                  Notify on change <span className="tool-note" style={{ fontWeight: "normal" }}>(optional)</span>
                  <select value={schedForm.notif_profile_id} onChange={(e) => setSchedForm((f) => ({ ...f, notif_profile_id: e.target.value }))}>
                    <option value="">— none —</option>
                    {notificationProfiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                </label>
              </div>
              <label className="checkbox-label">
                <input type="checkbox" checked={schedForm.enabled} onChange={(e) => setSchedForm((f) => ({ ...f, enabled: e.target.checked }))} />
                Enable immediately
              </label>
              <button type="submit" className="ipam-btn ipam-btn--primary" disabled={automationBusy || !schedForm.target.trim()}>
                {automationBusy ? "Saving…" : "Create schedule"}
              </button>
            </form>

            {schedules.length > 0 && (
              <div className="admin-users-table" style={{ marginTop: 12 }}>
                <div className="admin-users-header" style={{ gridTemplateColumns: "1fr 1fr auto auto auto auto auto" }}>
                  <span>Name</span>
                  <span>Target</span>
                  <span>Type</span>
                  <span>Interval</span>
                  <span>Last run</span>
                  <span>Status</span>
                  <span>Actions</span>
                </div>
                {schedules.map((sched) => (
                  <div key={sched.id} className="admin-users-row" style={{ gridTemplateColumns: "1fr 1fr auto auto auto auto auto", alignItems: "center" }}>
                    <span style={{ fontWeight: 500 }}>
                      {sched.name}
                      {sched.open_observation_count > 0 && (
                        <span className="scan-observation-badge scan-observation-badge--new_device" style={{ marginLeft: 6, fontSize: 10 }}>
                          {sched.open_observation_count} open
                        </span>
                      )}
                    </span>
                    <span className="mono">{sched.target}</span>
                    <span>{sched.scan_type === "ping" ? "Ping" : "Port scan"}</span>
                    <span>{sched.interval_minutes < 60 ? `${sched.interval_minutes}m` : `${sched.interval_minutes / 60}h`}</span>
                    <span style={{ fontSize: 11, color: "var(--color-text-muted)" }}>
                      {sched.last_run_at ? new Date(sched.last_run_at).toLocaleString() : "Never"}
                      {sched.last_error && <span style={{ color: "var(--color-danger)", marginLeft: 4 }}>· error</span>}
                    </span>
                    <span>
                      <span className={`status-pill status-pill--${sched.enabled ? "online" : "unknown"}`}>
                        {sched.enabled ? "Active" : "Paused"}
                      </span>
                    </span>
                    <div style={{ display: "flex", gap: 4 }}>
                      <button type="button" className="ipam-btn" style={{ padding: "2px 8px", fontSize: 12 }} disabled={automationBusy} onClick={() => void runScheduleNow(sched)}>Run</button>
                      <button type="button" className="ipam-btn" style={{ padding: "2px 8px", fontSize: 12 }} disabled={automationBusy} onClick={() => void toggleSchedule(sched)}>{sched.enabled ? "Pause" : "Enable"}</button>
                      <button type="button" className="ipam-btn ipam-btn--danger" style={{ padding: "2px 8px", fontSize: 12 }} disabled={automationBusy} onClick={() => void deleteSchedule(sched)}>Delete</button>
                    </div>
                  </div>
                ))}
              </div>
            )}
            {schedules.length === 0 && !automationBusy && (
              <p className="tool-note" style={{ marginTop: 8 }}>No schedules yet. Create one above.</p>
            )}
          </section>

          {(() => {
            const openObs = observations.filter((o) => o.status !== "resolved");
            const resolvedObs = observations.filter((o) => o.status === "resolved");
            const obsTypeLabel: Record<string, string> = {
              new_device: "New device",
              ip_change: "IP change",
              field_change: "Field change",
              disappeared: "Disappeared",
            };
            return (
              <section className="panel admin-panel" style={{ marginTop: 16 }}>
                <div className="admin-panel-header">
                  <h2 className="admin-section-title"><IconCalendarClock size={16} />Change observations</h2>
                  <span className="tool-note">{openObs.length} open · {resolvedObs.length} resolved</span>
                </div>
                <p className="tool-note">
                  Each scheduled scan logs what changed on your network. Acknowledge to mark as seen; resolve to dismiss.
                </p>
                {openObs.length === 0 && <p className="tool-note">No open observations.</p>}
                {openObs.length > 0 && (
                  <div className="scan-observation-list">
                    {openObs.map((obs) => (
                      <div key={obs.id} className="scan-observation-row">
                        <div>
                          <span className={`scan-observation-badge scan-observation-badge--${obs.observation_type}`}>
                            {obsTypeLabel[obs.observation_type] ?? obs.observation_type}
                          </span>
                          <strong>{obs.summary}</strong>
                          <span>
                            {[obs.hostname, obs.ip_address, obs.mac_address].filter(Boolean).join(" · ")}
                            {" · seen "}{new Date(obs.last_seen_at).toLocaleString()}
                            {" · "}{schedules.find((s) => s.id === obs.schedule_id)?.name ?? `scan #${obs.schedule_id}`}
                          </span>
                        </div>
                        <div className="scan-schedule-actions">
                          {(obs.observation_type === "new_device" || obs.observation_type === "ip_change" || obs.observation_type === "field_change") && (
                            <button
                              type="button"
                              className="ipam-btn ipam-btn--primary"
                              disabled={automationBusy}
                              onClick={() => void applyObservation(obs)}
                            >
                              {obs.observation_type === "new_device" ? "Add to inventory" : "Apply"}
                            </button>
                          )}
                          {obs.status === "open" && (
                            <button type="button" className="ipam-btn" disabled={automationBusy} onClick={() => void updateObservation(obs, "acknowledged")}>Acknowledge</button>
                          )}
                          <button type="button" className="ipam-btn ipam-btn--danger" disabled={automationBusy} onClick={() => void updateObservation(obs, "resolved")}>Resolve</button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            );
          })()}
        </div>
      )}

    </section>
  );
}
