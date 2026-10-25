import { ChartPanel, ChartOptionsSlot } from "../../../components/ChartPanel";
import { AdminTaskPanel } from "../AdminTaskPanel";
import { useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent } from "react";
import { IconCloud, IconPalette } from "@tabler/icons-react";
import { Bell, CircleCheck, CirclePause, Send, Upload } from "lucide-react";
import { api, type EmailBrandingSettings, type NotificationDelivery, type NotificationProfile } from "../../../api/client";
import { useApiQuery } from "../../../hooks/useApiQuery";
import { Modal } from "../../../components/Modal";
import { PanelSkeleton } from "../../../components/Skeleton";
import { DashStat } from "../../../components/DashStat";
import { ColumnChart, CountUp, DonutChart, SparkBars, type ChartColor, type ChartItem } from "../../../components/Charts";
import {
  notificationMethodCatalog, appriseSupportedMethods, emptyProfileForm,
  providerForMethod, buildNotificationConfig, profileFormIsComplete,
  populateFormFromProfile, notificationProfileMethodLabel, legacyChannelLabels,
  type NotificationMethodId, type NotificationProfileForm,
} from "../notificationProfiles";

const HISTORY_DAYS = 14;
const DELIVERY_LIMIT = 500;
const TYPE_COLORS: ChartColor[] = ["--dash-blue", "--dash-amber", "--dash-purple"];
const motion = (index: number) => ({ "--nm-motion-i": index }) as CSSProperties;

function dayKey(date: Date) {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function deliveryHistory(deliveries: NotificationDelivery[], profiles: NotificationProfile[]) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const days = Array.from({ length: HISTORY_DAYS }, (_, i) => new Date(today.getTime() - (HISTORY_DAYS - 1 - i) * 86_400_000));
  const index = new Map(days.map((d, i) => [dayKey(d), i]));
  const rows = days.map((d) => ({ label: d.toLocaleDateString(undefined, { day: "numeric", month: "short" }), sent: 0, failed: 0 }));
  const perProfile = new Map(profiles.map((p) => [p.id, Array(HISTORY_DAYS).fill(0) as number[]]));
  const inWindow: NotificationDelivery[] = [];
  for (const delivery of deliveries) {
    const i = index.get(dayKey(new Date(delivery.sent_at)));
    if (i === undefined) continue;
    inWindow.push(delivery);
    rows[i][delivery.status === "failed" ? "failed" : "sent"] += 1;
    const id = delivery.target.startsWith("profile:") ? Number(delivery.target.slice(8)) : NaN;
    if (delivery.status === "sent") perProfile.get(id)?.splice(i, 1, (perProfile.get(id)?.[i] ?? 0) + 1);
  }
  const oldest = deliveries[deliveries.length - 1];
  const truncated = deliveries.length >= DELIVERY_LIMIT && oldest !== undefined && new Date(oldest.sent_at) >= days[0];
  return { rows, perProfile, inWindow, truncated };
}

export function NotificationsTab({
  accessToken,
  onError,
  onSuccess,
  canManageBranding,
}: {
  accessToken: string;
  onError: (message: string | null) => void;
  onSuccess: (message: string | null) => void;
  canManageBranding: boolean;
}) {
  const [profileForm, setProfileForm] = useState<NotificationProfileForm>(emptyProfileForm);
  const [profileTestResult, setProfileTestResult] = useState<Record<number, string>>({});
  const [profileBusy, setProfileBusy] = useState(false);
  const [editingProfileId, setEditingProfileId] = useState<number | null>(null);
  const [showProfileModal, setShowProfileModal] = useState(false);

  const profilesQuery = useApiQuery(() => api.listNotificationProfiles(accessToken), [accessToken]);
  const brandingQuery = useApiQuery(
    canManageBranding ? () => api.getEmailBranding(accessToken) : null,
    [accessToken, canManageBranding],
  );
  const [brandingBusy, setBrandingBusy] = useState(false);
  const [brandingForm, setBrandingForm] = useState<EmailBrandingSettings>({
    email_brand_theme: "login_banner",
    email_brand_name: "",
    email_brand_accent: "#1d9ab0",
    email_brand_logo: "",
    email_brand_footer: "",
    email_brand_url: "",
    email_brand_show_support: true,
  });
  const [brandingPreviewHtml, setBrandingPreviewHtml] = useState("");
  const logoInputRef = useRef<HTMLInputElement>(null);
  const previewBoxRef = useRef<HTMLDivElement>(null);
  const previewFrameRef = useRef<HTMLIFrameElement>(null);
  const notificationProfiles = profilesQuery.data ?? [];
  const deliveriesQuery = useApiQuery(() => api.listNotificationDeliveries(accessToken, DELIVERY_LIMIT), [accessToken]);
  const history = useMemo(() => deliveryHistory(deliveriesQuery.data ?? [], notificationProfiles), [deliveriesQuery.data, notificationProfiles]);

  useEffect(() => {
    if (brandingQuery.data) setBrandingForm(brandingQuery.data);
  }, [brandingQuery.data]);

  // Render the preview through the real email template. Half-typed colours and URLs are left
  // out so the saved values stand in until the field is valid again.
  useEffect(() => {
    if (!canManageBranding || !brandingQuery.data) return;
    const url = brandingForm.email_brand_url.trim();
    const payload: Partial<EmailBrandingSettings> = {
      email_brand_theme: brandingForm.email_brand_theme,
      email_brand_name: brandingForm.email_brand_name.trim(),
      email_brand_logo: brandingForm.email_brand_logo,
      email_brand_footer: brandingForm.email_brand_footer.trim(),
      email_brand_show_support: brandingForm.email_brand_show_support,
      ...(/^#[0-9A-Fa-f]{6}$/.test(brandingForm.email_brand_accent) ? { email_brand_accent: brandingForm.email_brand_accent } : {}),
      ...(url === "" || /^https?:\/\/[^/\s]+/.test(url) ? { email_brand_url: url } : {}),
    };
    let cancelled = false;
    const timer = window.setTimeout(() => {
      api.previewEmailBranding(accessToken, payload)
        .then((result) => { if (!cancelled) setBrandingPreviewHtml(result.html); })
        .catch(() => { /* keep the last good preview */ });
    }, 250);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [accessToken, canManageBranding, brandingQuery.data, brandingForm]);

  // The preview box takes the form column's height and scrolls. Lay the email out at its own
  // canvas width (600px card + 12px gutters), show it at a readable 80%, and size the box to the
  // zoomed email plus its scrollbar so there is no dead space beside it.
  function fitBrandingPreview() {
    const box = previewBoxRef.current;
    const frame = previewFrameRef.current;
    const body = frame?.contentDocument?.body;
    if (!box || !frame || !body || box.clientHeight === 0) return;
    const canvasWidth = 624;
    const zoom = 0.8;
    frame.style.width = `${canvasWidth}px`;
    frame.style.zoom = String(zoom);
    frame.style.height = `${Math.max(body.offsetHeight, box.clientHeight / zoom)}px`;
    box.style.width = `${Math.ceil(canvasWidth * zoom) + box.offsetWidth - box.clientWidth}px`;
  }

  useEffect(() => {
    const box = previewBoxRef.current;
    if (!box) return;
    const observer = new ResizeObserver(() => fitBrandingPreview());
    observer.observe(box);
    return () => observer.disconnect();
  }, [brandingPreviewHtml]);

  async function chooseBrandLogo(file?: File) {
    if (!file) return;
    if (file.size > 256 * 1024) {
      onError("Email logos must be 256 KB or smaller.");
      return;
    }
    if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
      onError("Use a PNG, JPEG, or WebP email logo.");
      return;
    }
    try {
      const dataUri = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error("Could not read the selected logo"));
        reader.readAsDataURL(file);
      });
      setBrandingForm((current) => ({ ...current, email_brand_logo: dataUri }));
      onError(null);
    } catch (error) {
      onError(error instanceof Error ? error.message : "Unable to read logo");
    }
  }

  async function saveEmailBranding(event: FormEvent) {
    event.preventDefault();
    setBrandingBusy(true);
    onError(null); onSuccess(null);
    try {
      const saved = await api.updateEmailBranding(accessToken, {
        ...brandingForm,
        email_brand_name: brandingForm.email_brand_name.trim(),
        email_brand_footer: brandingForm.email_brand_footer.trim(),
        email_brand_url: brandingForm.email_brand_url.trim(),
      });
      setBrandingForm(saved);
      brandingQuery.setData(saved);
      onSuccess("Email branding saved.");
    } catch (error) {
      onError(error instanceof Error ? error.message : "Unable to save email branding");
    } finally {
      setBrandingBusy(false);
    }
  }

  async function saveNotificationProfile(event: FormEvent) {
    event.preventDefault();
    setProfileBusy(true);
    onError(null); onSuccess(null);
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
        profilesQuery.setData((current) => (current ?? []).map((p) => p.id === updated.id ? updated : p));
        setProfileForm(emptyProfileForm);
        setEditingProfileId(null);
        setShowProfileModal(false);
        onSuccess(`Notification method "${updated.name}" updated.`);
      } else {
        const profile = await api.createNotificationProfile(accessToken, {
          name: profileForm.name.trim(),
          provider: providerForMethod(profileForm.method),
          enabled: profileForm.enabled,
          config: buildNotificationConfig(profileForm),
        });
        profilesQuery.setData((current) => [...(current ?? []), profile].sort((a, b) => a.name.localeCompare(b.name)));
        setProfileForm(emptyProfileForm);
        setShowProfileModal(false);
        onSuccess(`Notification method "${profile.name}" created.`);
      }
    } catch (err) {
      onError(err instanceof Error ? err.message : editingProfileId !== null ? "Unable to update notification method" : "Unable to create notification method");
    } finally {
      setProfileBusy(false);
    }
  }

  async function toggleNotificationProfile(profile: NotificationProfile) {
    setProfileBusy(true);
    onError(null); onSuccess(null);
    try {
      const updated = await api.updateNotificationProfile(accessToken, profile.id, { enabled: !profile.enabled });
      profilesQuery.setData((current) => (current ?? []).map((item) => item.id === updated.id ? updated : item));
    } catch (err) {
      onError(err instanceof Error ? err.message : "Unable to update notification profile");
    } finally {
      setProfileBusy(false);
    }
  }

  async function deleteNotificationProfile(profile: NotificationProfile) {
    setProfileBusy(true);
    onError(null); onSuccess(null);
    try {
      await api.deleteNotificationProfile(accessToken, profile.id);
      profilesQuery.setData((current) => (current ?? []).filter((item) => item.id !== profile.id));
      onSuccess(`Notification profile "${profile.name}" deleted.`);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Unable to delete notification profile");
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

  const sentTotal = history.inWindow.filter((d) => d.status === "sent").length;
  const failures = history.inWindow.filter((d) => d.status === "failed");
  const attempts = sentTotal + failures.length;
  const activeCount = notificationProfiles.filter((p) => p.enabled).length;
  const disabled = notificationProfiles.filter((p) => !p.enabled);
  const typeCounts = new Map<string, number>();
  for (const profile of notificationProfiles) typeCounts.set(notificationProfileMethodLabel(profile), (typeCounts.get(notificationProfileMethodLabel(profile)) ?? 0) + 1);
  const typeEntries = [...typeCounts.entries()].sort((a, b) => b[1] - a[1]);
  const typeItems: ChartItem[] = typeEntries.slice(0, TYPE_COLORS.length).map(([label, value], i) => ({ label, value, color: TYPE_COLORS[i] }));
  if (typeEntries.length > TYPE_COLORS.length) typeItems.push({ label: "Other", value: typeEntries.slice(TYPE_COLORS.length).reduce((sum, [, n]) => sum + n, 0), color: "--nm-text-faint" });
  const targetName = (target: string) => {
    const id = target.startsWith("profile:") ? Number(target.slice(8)) : NaN;
    return notificationProfiles.find((p) => p.id === id)?.name ?? legacyChannelLabels[target] ?? target;
  };
  const guided = notificationMethodCatalog.filter((m) => m.id !== "custom").map((m) => m.label);
  const viaApprise = appriseSupportedMethods.filter((name) => !guided.some((g) => g.toLowerCase().startsWith(name.toLowerCase())));
  const scrollTo = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  const historyOk = !deliveriesQuery.error;

  return (
    <div className="admin-tab-content nm-motion">
      <div className="nm-bento nm-bento--four nm-bento--chart">
        <ChartPanel><section className="panel admin-panel nm-app-panel admin-system-card nm-motion-item nm-hero-visual" aria-label={`Deliveries, last ${HISTORY_DAYS} days`} style={motion(0)}>
          <div className="admin-panel-header nm-app-panel-header">
            <h2 className="admin-section-title"><Send size={16} />Deliveries, Last {HISTORY_DAYS} Days</h2>
            <ul className="nm-header-legend" aria-hidden="true">
              <li><span className="nm-chart-swatch" style={{ background: "var(--dash-green)" }} />Sent</li>
              <li><span className="nm-chart-swatch" style={{ background: "var(--dash-red)" }} />Failed</li>
            </ul>
            <ChartOptionsSlot />
          </div>
          <div className="nm-chart-body">
            {deliveriesQuery.isLoading ? <PanelSkeleton lines={5} />
              : !historyOk ? <p className="tool-note nm-chart-empty">Delivery history is unavailable.</p>
              : <>
                  <ColumnChart viewId="admin.notifications.deliveries" label={`Notification deliveries per day, last ${HISTORY_DAYS} days, sent and failed`} rows={history.rows}
                    series={[{ key: "sent", label: "Sent", color: "--dash-green" }, { key: "failed", label: "Failed", color: "--dash-red" }]} height={168} />
                  {attempts === 0 && <p className="tool-note nm-chart-empty">No deliveries in the last {HISTORY_DAYS} days.</p>}
                  {history.truncated && <p className="tool-note nm-chart-empty">Based on the latest {DELIVERY_LIMIT} deliveries.</p>}
                </>}
          </div>
        </section></ChartPanel>
        <div className="dash-stats nm-bento-stats nm-summary-band">
          <DashStat accent="teal" className="nm-motion-item" icon={<Send size={20} />} label="Methods" value={<CountUp value={notificationProfiles.length} />}
            sub={typeEntries.map(([label]) => label).join(", ") || "None yet"} onClick={() => scrollTo("admin-notification-methods")} />
          <DashStat accent="green" className="nm-motion-item" icon={<CircleCheck size={20} />} label="Active" value={`${activeCount} of ${notificationProfiles.length}`}
            sub={disabled.length ? `${disabled.map((p) => p.name).join(", ")} disabled` : "All receiving alerts"} onClick={() => scrollTo("admin-notification-methods")} />
          <DashStat accent="green" className="nm-motion-item" icon={<Send size={20} />} label={`Sent, ${HISTORY_DAYS} days`} value={historyOk ? <CountUp value={sentTotal} /> : "—"}
            sub={attempts ? `${((sentTotal / attempts) * 100).toFixed(1)}% delivered` : "No deliveries"} onClick={() => scrollTo("admin-notification-methods")} />
          <DashStat accent="red" className="nm-motion-item" icon={<CirclePause size={20} />} label={`Failed, ${HISTORY_DAYS} days`} value={historyOk ? <CountUp value={failures.length} /> : "—"}
            sub={failures[0] ? `Last: ${targetName(failures[0].target)}, ${new Date(failures[0].sent_at).toLocaleDateString(undefined, { day: "numeric", month: "short" })}` : "No failures"}
            onClick={() => scrollTo("admin-notification-methods")} />
        </div>
      </div>

      <div className="nm-console nm-console--even">
        <div className="nm-console-main">
          <section id="admin-notification-methods" className="panel admin-panel nm-app-panel nm-fill nm-motion-item" aria-label="Notification Methods" style={motion(1)}>
            <div className="admin-panel-header nm-app-panel-header">
              <h2 className="admin-section-title notif-provider-heading"><IconCloud size={16} />Notification Methods</h2>
              <div className="admin-panel-actions">
                <button
                  type="button"
                  className="nm-btn nm-btn--primary"
                  onClick={() => { setEditingProfileId(null); setProfileForm(emptyProfileForm); setShowProfileModal(true); }}
                >
                  + Add method
                </button>
                <button type="button" className="nm-btn" disabled={profileBusy} onClick={() => { void profilesQuery.reload(); void deliveriesQuery.reload(); }}>
                  Refresh
                </button>
              </div>
            </div>
            <p className="tool-note">Reusable methods that alerts and reminders send to.</p>
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
                  <div className="notif-spark">
                    <SparkBars values={history.perProfile.get(profile.id) ?? []} label={`${profile.name}: sends per day, last ${HISTORY_DAYS} days`} />
                    <span className="notif-spark-label">{(() => { const sent = (history.perProfile.get(profile.id) ?? []).reduce((a, b) => a + b, 0); return sent ? `${sent.toLocaleString()} sent · ${HISTORY_DAYS} d` : `No sends · ${HISTORY_DAYS} d`; })()}</span>
                  </div>
                  <div className="notif-method-actions">
                    <button type="button" className="nm-btn nm-btn--sm nm-btn--secondary" disabled={profileBusy} onClick={() => void testNotificationProfile(profile)}>
                      Test
                    </button>
                    <button type="button" className="nm-btn nm-btn--sm nm-btn--secondary" disabled={profileBusy} onClick={() => { setEditingProfileId(profile.id); setProfileForm(populateFormFromProfile(profile)); setShowProfileModal(true); }}>
                      Edit
                    </button>
                    <button type="button" className="nm-btn nm-btn--sm nm-btn--secondary" disabled={profileBusy} onClick={() => void toggleNotificationProfile(profile)}>
                      {profile.enabled ? "Disable" : "Enable"}
                    </button>
                    <button type="button" className="nm-btn nm-btn--sm nm-btn--danger" disabled={profileBusy} onClick={() => void deleteNotificationProfile(profile)}>
                      Delete
                    </button>
                  </div>
                </div>
              ))}
            </div>
            <div className="admin-services">
              <div>
                <span className="admin-services-label">Guided setup</span>
                <div className="admin-service-chips">{guided.map((name) => <span key={name} className="notif-method-tag">{name}</span>)}</div>
              </div>
              <div>
                <span className="admin-services-label">Through Custom Apprise URL</span>
                <div className="admin-service-chips">{viaApprise.map((name) => <span key={name} className="notif-method-tag">{name}</span>)}<span className="notif-method-tag">and more</span></div>
              </div>
            </div>
          </section>
        </div>
        <aside className="nm-console-side">
          <ChartPanel><section className="panel admin-panel nm-app-panel admin-system-card nm-motion-item" aria-label="Methods by Type" style={motion(2)}>
            <div className="admin-system-card-header nm-app-panel-header"><h2 className="admin-section-title"><Bell size={16} />Methods by Type</h2><ChartOptionsSlot /></div>
            <div className="nm-chart-body">
              {typeItems.length
                ? <DonutChart viewId="admin.notifications.methods" label="Methods by Type" items={typeItems} centre={<CountUp value={notificationProfiles.length} />} sub={notificationProfiles.length === 1 ? "method" : "methods"} />
                : <p className="tool-note nm-chart-empty">No notification methods yet.</p>}
            </div>
          </section></ChartPanel>
          <section className="panel admin-panel nm-app-panel admin-system-card nm-fill nm-motion-item" aria-label="Recent Failures" style={motion(3)}>
            <div className="admin-system-card-header nm-app-panel-header"><h2 className="admin-section-title"><CirclePause size={16} />Recent Failures</h2></div>
            {failures.length ? (
              <ul className="nm-event-list">
                {failures.slice(0, 5).map((failure) => (
                  <li key={failure.id}>
                    <span className="dash-status-dot dash-status-dot--offline" aria-hidden="true" />
                    <span><strong>{targetName(failure.target)}</strong><small>{failure.detail || "Failed"} · {failure.rule_name}</small></span>
                    <time dateTime={failure.sent_at}>{new Date(failure.sent_at).toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</time>
                  </li>
                ))}
              </ul>
            ) : <div className="admin-system-card-body"><p className="tool-note nm-chart-empty">{historyOk ? `No failed deliveries in the last ${HISTORY_DAYS} days.` : "Delivery history is unavailable."}</p></div>}
          </section>
        </aside>
      </div>

      {canManageBranding && (
        <section className="panel admin-panel nm-app-panel email-branding-panel nm-motion-item" aria-label="Email Branding" style={motion(4)}>
          <div className="admin-panel-header nm-app-panel-header">
            <h2 className="admin-section-title"><IconPalette size={16} />Email Branding</h2>
          </div>
          {brandingQuery.isLoading ? <PanelSkeleton lines={7} /> : brandingQuery.error ? <div className="form-error">{brandingQuery.error}</div> : (
            <form className="tool-form email-branding-form" onSubmit={saveEmailBranding}>
              <AdminTaskPanel title="Message Appearance" icon={<IconPalette size={18} />}>
              <div className="email-branding-fields">
                <div className="nm-form-row">
                  <label className="nm-field"><span>Template</span><select className="nm-select" value={brandingForm.email_brand_theme} onChange={(event) => setBrandingForm((current) => ({ ...current, email_brand_theme: event.target.value as EmailBrandingSettings["email_brand_theme"] }))}><option value="login_banner">Login banner</option><option value="clean_stripe">Clean stripe</option></select></label>
                  <label className="nm-field"><span>Brand name</span><input className="nm-input" maxLength={80} placeholder="Uses the application name" value={brandingForm.email_brand_name} onChange={(event) => setBrandingForm((current) => ({ ...current, email_brand_name: event.target.value }))} /></label>
                </div>
                <div className="nm-form-row">
                  <label className="nm-field"><span>Accent colour</span><span className="email-branding-colour"><input type="color" className="nm-color-input" value={brandingForm.email_brand_accent} onChange={(event) => setBrandingForm((current) => ({ ...current, email_brand_accent: event.target.value }))} /><input className="nm-input" maxLength={7} pattern="#[0-9A-Fa-f]{6}" value={brandingForm.email_brand_accent} onChange={(event) => setBrandingForm((current) => ({ ...current, email_brand_accent: event.target.value }))} /></span></label>
                  <label className="nm-field"><span>Installation URL</span><input className="nm-input" type="url" maxLength={500} placeholder="https://netmap.example.com" value={brandingForm.email_brand_url} onChange={(event) => setBrandingForm((current) => ({ ...current, email_brand_url: event.target.value }))} /></label>
                </div>
                <label className="nm-field"><span>Footer text</span><input className="nm-input" maxLength={300} placeholder="Managed by your IT team" value={brandingForm.email_brand_footer} onChange={(event) => setBrandingForm((current) => ({ ...current, email_brand_footer: event.target.value }))} /></label>
                <div className="email-branding-actions">
                  <button className="nm-btn" type="button" onClick={() => logoInputRef.current?.click()}><Upload size={14} />{brandingForm.email_brand_logo ? "Replace logo" : "Upload logo"}</button>
                  <input ref={logoInputRef} type="file" accept="image/png,image/jpeg,image/webp" hidden aria-label="Email logo file" onChange={(event) => { void chooseBrandLogo(event.target.files?.[0]); event.target.value = ""; }} />
                  {brandingForm.email_brand_logo && <button className="nm-btn nm-btn--ghost" type="button" onClick={() => setBrandingForm((current) => ({ ...current, email_brand_logo: "" }))}>Use NetMap logo</button>}
                </div>
                <label className="tool-form-inline-check">
                  <input type="checkbox" checked={brandingForm.email_brand_show_support} onChange={(event) => setBrandingForm((current) => ({ ...current, email_brand_show_support: event.target.checked }))} />
                  <span className="tool-form-check-copy">
                    <span>Include support details</span>
                    <span className="tool-note">Adds the support email and URL from System settings to the email footer.</span>
                  </span>
                </label>
                <button className="nm-btn nm-btn--primary email-branding-save" type="submit" disabled={brandingBusy}>{brandingBusy ? "Saving…" : "Save email branding"}</button>
              </div>
              </AdminTaskPanel>
              <AdminTaskPanel title="Message Preview" icon={<IconPalette size={18} />} className="admin-email-preview-task">
              <div className="email-branding-preview" ref={previewBoxRef}>
                {brandingPreviewHtml ? (
                  <iframe
                    ref={previewFrameRef}
                    title="Email branding preview"
                    className="email-branding-preview-frame"
                    sandbox="allow-same-origin"
                    srcDoc={brandingPreviewHtml}
                    onLoad={fitBrandingPreview}
                  />
                ) : <PanelSkeleton lines={9} />}
              </div>
              </AdminTaskPanel>
            </form>
          )}
        </section>
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
            {profileForm.method === "webhook" && (
              <>
                <label>
                  Webhook URL
                  <input required placeholder="https://example.com/netmap-alerts" value={profileForm.webhook_url} onChange={(e) => setProfileForm((c) => ({ ...c, webhook_url: e.target.value }))} />
                </label>
                <label>
                  Bearer token (optional)
                  <input type="password" value={profileForm.webhook_token} onChange={(e) => setProfileForm((c) => ({ ...c, webhook_token: e.target.value }))} />
                </label>
                <p className="tool-note">{'NetMap sends a POST request with the JSON body {"title": "NetMap", "message": "…"}.'}</p>
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
    </div>
  );
}
