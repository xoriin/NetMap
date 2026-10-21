import { useCallback, useEffect, useMemo, useState, type ChangeEvent, type FormEvent } from "react";
import { ArrowLeft, CalendarClock, ExternalLink, FileUp, Eye, KeyRound, LayoutList, Megaphone, RefreshCw, Siren, SlidersHorizontal } from "lucide-react";
import { PanelSkeleton } from "../../components/Skeleton";
import { useToast } from "../../components/Toast";
import { useConfirm } from "../../components/ConfirmDialog";
import { useTheme } from "../../providers/ThemeProvider";
import { ApiError } from "../../api/client";
import { StatusPageFrame } from "./StatusPageFrame";
import {
  StatusEditorPanelHeader, StatusPageLayoutEditor, draftFromDetail, layoutPayload, layoutProblems, type DraftGroup,
} from "./StatusPageLayoutEditor";
import { statusPagePath, type StatusPagePayload } from "./statusPagesApi";
import { StatusCssErrors } from "./StatusCssErrors";
import { StatusIncidentsPanel } from "./StatusIncidentsPanel";
import { StatusNoticesPanel } from "./StatusNoticesPanel";
import { StatusMaintenancePanel } from "./StatusMaintenancePanel";
import { StatusTokensPanel } from "./StatusTokensPanel";
import {
  SLUG_HINT, cssErrors, isValidAccent, isValidSlug, statusPagesEditorApi,
  type StatusPageDetail, type StatusPageSettings, type StatusPreviewAudience, type StatusSources,
} from "./statusPagesEditorApi";

type EditorTab = "settings" | "layout" | "incidents" | "notices" | "maintenance" | "tokens";

const EDITOR_TABS: { id: EditorTab; label: string; Icon: typeof SlidersHorizontal }[] = [
  { id: "settings", label: "Settings", Icon: SlidersHorizontal },
  { id: "layout", label: "Layout", Icon: LayoutList },
  { id: "incidents", label: "Incidents", Icon: Siren },
  { id: "notices", label: "Notices", Icon: Megaphone },
  { id: "maintenance", label: "Maintenance", Icon: CalendarClock },
  { id: "tokens", label: "Tokens", Icon: KeyRound },
];

const LOGO_TYPES = ["image/png", "image/jpeg", "image/webp"];
const LOGO_MAX_BYTES = 256 * 1024;

type SettingsDraft = {
  name: string;
  slug: string;
  visibility: StatusPageSettings["visibility"];
  title: string;
  accent: string;
  heartbeat_window: StatusPageSettings["heartbeat_window"];
  logo: string | null;
  custom_css: string;
};

function settingsDraft(page: StatusPageDetail): SettingsDraft {
  return {
    name: page.name,
    slug: page.slug,
    visibility: page.visibility,
    title: page.title ?? "",
    accent: page.accent ?? "",
    heartbeat_window: page.heartbeat_window,
    logo: page.logo,
    custom_css: page.custom_css ?? "",
  };
}

function settingsChanges(page: StatusPageDetail, draft: SettingsDraft): Partial<StatusPageSettings> {
  const next: StatusPageSettings = {
    name: draft.name.trim(),
    slug: draft.slug,
    visibility: draft.visibility,
    title: draft.title.trim() || null,
    accent: draft.accent ? draft.accent.toLowerCase() : null,
    heartbeat_window: draft.heartbeat_window,
    logo: draft.logo,
    custom_css: draft.custom_css.trim() ? draft.custom_css : null,
  };
  const changes: Partial<StatusPageSettings> = {};
  (Object.keys(next) as (keyof StatusPageSettings)[]).forEach((key) => {
    if (next[key] !== page[key]) (changes as Record<string, unknown>)[key] = next[key];
  });
  return changes;
}

function readAccentToken(): string {
  const value = getComputedStyle(document.body).getPropertyValue("--nm-accent").trim();
  return isValidAccent(value) ? value.toLowerCase() : "";
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Unable to read the file"));
    reader.readAsDataURL(file);
  });
}

function SettingsForm({
  draft,
  setDraft,
  saving,
  dirty,
  slugError,
  onSlugEdit,
  cssErrors: cssProblems,
  onCssEdit,
  onSave,
  onReset,
}: {
  draft: SettingsDraft;
  setDraft: (update: (current: SettingsDraft) => SettingsDraft) => void;
  saving: boolean;
  dirty: boolean;
  slugError: string | null;
  onSlugEdit: () => void;
  cssErrors: string[];
  onCssEdit: () => void;
  onSave: () => void;
  onReset: () => void;
}) {
  const [logoError, setLogoError] = useState<string | null>(null);
  const { theme } = useTheme();
  const [themeAccent, setThemeAccent] = useState(readAccentToken);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => setThemeAccent(readAccentToken()));
    return () => window.cancelAnimationFrame(frame);
  }, [theme]);
  const nameMissing = !draft.name.trim();
  const slugInvalid = !isValidSlug(draft.slug);
  const accentInvalid = draft.accent !== "" && !isValidAccent(draft.accent);
  const invalid = nameMissing || slugInvalid || accentInvalid;

  async function chooseLogo(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (!LOGO_TYPES.includes(file.type)) { setLogoError("Choose a PNG, JPEG or WebP image."); return; }
    if (file.size > LOGO_MAX_BYTES) { setLogoError("The logo must be 256 KB or smaller."); return; }
    try {
      const logo = await readFileAsDataUrl(file);
      setLogoError(null);
      setDraft((current) => ({ ...current, logo }));
    } catch (err) {
      setLogoError(err instanceof Error ? err.message : "Unable to read the file");
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!invalid && dirty) onSave();
  }

  const update = <K extends keyof SettingsDraft>(key: K, value: SettingsDraft[K]) => setDraft((current) => ({ ...current, [key]: value }));

  return (
    <section className="nm-app-panel status-editor-panel">
      <StatusEditorPanelHeader icon={SlidersHorizontal} title="Page settings" meta={dirty ? "Unsaved changes" : undefined} />
      <form className="status-editor-settings" onSubmit={submit} noValidate>
        <label className="nm-field">
          <span className="nm-field-label">Name</span>
          <input className="nm-input" value={draft.name} maxLength={120} aria-invalid={nameMissing || undefined} onChange={(event) => update("name", event.target.value)} />
          {nameMissing ? <span className="status-editor-error">Name is required.</span> : <small className="status-editor-hint">Only editors see this name.</small>}
        </label>
        <label className="nm-field">
          <span className="nm-field-label">Slug</span>
          <input
            className="nm-input"
            value={draft.slug}
            maxLength={48}
            aria-invalid={slugInvalid || Boolean(slugError) || undefined}
            onChange={(event) => { onSlugEdit(); update("slug", event.target.value.toLowerCase()); }}
          />
          {slugInvalid ? <span className="status-editor-error">{SLUG_HINT}</span>
            : slugError ? <span className="status-editor-error">{slugError}</span>
            : <small className="status-editor-hint">Visitors open {statusPagePath(draft.slug)}.</small>}
        </label>
        <label className="nm-field">
          <span className="nm-field-label">Visibility</span>
          <select className="nm-select" value={draft.visibility} onChange={(event) => update("visibility", event.target.value as SettingsDraft["visibility"])}>
            <option value="public">Public — anyone with the link</option>
            <option value="private">Private — signed-in users only</option>
          </select>
        </label>
        <label className="nm-field">
          <span className="nm-field-label">Title</span>
          <input className="nm-input" value={draft.title} maxLength={200} placeholder={draft.name || "Page title"} onChange={(event) => update("title", event.target.value)} />
          <small className="status-editor-hint">Shown at the top of the page. Leave empty to use the name.</small>
        </label>
        <div className="nm-field">
          <label className="nm-field-label" htmlFor="status-page-accent">Accent colour</label>
          <div className="status-editor-accent">
            <input
              type="color"
              className="nm-color-input"
              aria-label="Pick accent colour"
              value={isValidAccent(draft.accent) ? draft.accent : themeAccent}
              onChange={(event) => update("accent", event.target.value)}
            />
            <input
              id="status-page-accent"
              className="nm-input"
              value={draft.accent}
              maxLength={7}
              placeholder="Default"
              aria-invalid={accentInvalid || undefined}
              onChange={(event) => update("accent", event.target.value.trim())}
            />
            <button type="button" className="nm-btn nm-btn--sm nm-btn--secondary" disabled={!draft.accent} onClick={() => update("accent", "")}>Use default</button>
          </div>
          {accentInvalid && <span className="status-editor-error">Use a #rrggbb colour.</span>}
        </div>
        <div className="status-editor-logo-field">
          <label className="nm-field">
            <span className="nm-field-label">Logo</span>
            <span className="nm-file">
              <FileUp size={17} />
              <span className="nm-file-copy">
                <strong>{draft.logo ? "Replace the logo" : "Choose a logo image"}</strong>
                <small>PNG, JPEG or WebP, 256 KB maximum</small>
              </span>
              <input type="file" accept={LOGO_TYPES.join(",")} onChange={(event) => void chooseLogo(event)} />
            </span>
          </label>
          {draft.logo && (
            <div className="status-editor-logo">
              <img src={draft.logo} alt="Current logo" />
              <button type="button" className="nm-btn nm-btn--sm nm-btn--secondary" onClick={() => update("logo", null)}>Remove logo</button>
            </div>
          )}
          {logoError && <span className="status-editor-error">{logoError}</span>}
        </div>
        <label className="nm-field">
          <span className="nm-field-label">Heartbeat window</span>
          <select className="nm-select" value={draft.heartbeat_window} onChange={(event) => update("heartbeat_window", event.target.value as SettingsDraft["heartbeat_window"])}>
            <option value="1h">Last hour</option>
            <option value="24h">Last 24 hours</option>
          </select>
          <small className="status-editor-hint">The span covered by each row's heartbeat bar.</small>
        </label>
        <div className="nm-field">
          <label className="nm-field-label" htmlFor="status-page-css">Custom CSS</label>
          <textarea
            id="status-page-css"
            className="nm-textarea"
            rows={10}
            spellCheck={false}
            value={draft.custom_css}
            placeholder=".sp-row { … }"
            aria-invalid={cssProblems.length > 0 || undefined}
            aria-describedby={cssProblems.length > 0 ? "status-page-css-errors" : "status-page-css-hint"}
            onChange={(event) => { onCssEdit(); update("custom_css", event.target.value); }}
          />
          {cssProblems.length > 0
            ? <StatusCssErrors id="status-page-css-errors" className="status-editor-css-errors" errors={cssProblems} />
            : <small id="status-page-css-hint" className="status-editor-hint">Applies only to this status page, using the .sp-* classes. Links, images, fonts and imports are not allowed.</small>}
        </div>
        <div className="status-editor-actions">
          <button type="button" className="nm-btn nm-btn--secondary" disabled={!dirty || saving} onClick={onReset}>Discard changes</button>
          <button type="submit" className="nm-btn nm-btn--primary" disabled={!dirty || invalid || saving}>
            {saving ? "Saving…" : "Save settings"}
          </button>
        </div>
      </form>
    </section>
  );
}

function PreviewPanel({ accessToken, pageId, stale, draft, revision }: {
  accessToken: string; pageId: number; stale: boolean; draft?: SettingsDraft; revision: string;
}) {
  const { theme } = useTheme();
  const [audience, setAudience] = useState<StatusPreviewAudience>("public");
  const [payload, setPayload] = useState<StatusPagePayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);
  const [appearance, setAppearance] = useState(draft);

  useEffect(() => {
    const timer = window.setTimeout(() => setAppearance(draft), 200);
    return () => window.clearTimeout(timer);
  }, [draft]);

  const shown = useMemo(() => payload && appearance ? {
    ...payload,
    title: appearance.title.trim() || appearance.name.trim(),
    logo: appearance.logo,
    accent: isValidAccent(appearance.accent) ? appearance.accent : null,
    custom_css: appearance.custom_css,
  } : payload, [payload, appearance]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    statusPagesEditorApi.preview(accessToken, pageId, audience)
      .then((next) => { if (!cancelled) { setPayload(next); setError(null); } })
      .catch((err) => { if (!cancelled) { setPayload(null); setError(err instanceof Error ? err.message : "Unable to build the preview"); } })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [accessToken, pageId, audience, nonce, revision]);

  return (
    <section className="nm-app-panel status-editor-panel status-editor-preview-panel">
      <StatusEditorPanelHeader icon={Eye} title="Preview" meta={audience === "public" ? "As a public visitor" : "As a signed-in user"}>
        <div className="nm-btn-row" role="group" aria-label="Preview audience">
          {(["public", "private"] as const).map((value) => (
            <button
              key={value}
              type="button"
              className={`nm-btn nm-btn--sm nm-btn--secondary${audience === value ? " nm-btn--active" : ""}`}
              aria-pressed={audience === value}
              onClick={() => setAudience(value)}
            >
              {value === "public" ? "Public" : "Private"}
            </button>
          ))}
        </div>
        <button type="button" className="nm-btn nm-btn--sm nm-btn--ghost" onClick={() => setNonce((n) => n + 1)} disabled={loading}>
          <RefreshCw size={14} /> Refresh
        </button>
      </StatusEditorPanelHeader>
      <div className="status-editor-preview-body">
        {stale && <div className="nm-alert nm-alert--info">The preview uses the last saved layout and monitoring settings.</div>}
        {error && <div className="nm-alert nm-alert--error" role="alert">{error}</div>}
        {loading && !shown ? <PanelSkeleton lines={6} /> : shown && (
          <div className="status-editor-preview-frame">
            <StatusPageFrame payload={shown} css={shown.custom_css} title={`Preview of ${shown.title || "status page"}`} colorScheme={theme} />
          </div>
        )}
      </div>
    </section>
  );
}

export function StatusPageEditor({ accessToken, pageId, canManageAlerts, onClose }: {
  accessToken: string;
  pageId: number;
  canManageAlerts: boolean;
  onClose: () => void;
}) {
  const toast = useToast();
  const confirm = useConfirm();
  const [tab, setTab] = useState<EditorTab>("settings");
  const [page, setPage] = useState<StatusPageDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState<SettingsDraft | null>(null);
  const [savingSettings, setSavingSettings] = useState(false);
  const [slugError, setSlugError] = useState<string | null>(null);
  const [cssProblems, setCssProblems] = useState<string[]>([]);
  const [groups, setGroups] = useState<DraftGroup[]>([]);
  const [savedLayout, setSavedLayout] = useState("[]");
  const [savingLayout, setSavingLayout] = useState(false);
  const [sources, setSources] = useState<StatusSources | null>(null);
  const [sourcesError, setSourcesError] = useState<string | null>(null);
  const [previewRevision, setPreviewRevision] = useState(0);

  const adopt = useCallback((detail: StatusPageDetail) => {
    const nextGroups = draftFromDetail(detail);
    setPage(detail);
    setGroups(nextGroups);
    setSavedLayout(JSON.stringify(layoutPayload(nextGroups)));
  }, []);

  useEffect(() => {
    let cancelled = false;
    statusPagesEditorApi.get(accessToken, pageId)
      .then((detail) => { if (!cancelled) { adopt(detail); setDraft(settingsDraft(detail)); } })
      .catch((err) => { if (!cancelled) setLoadError(err instanceof Error ? err.message : "Unable to load the status page"); });
    statusPagesEditorApi.sources(accessToken)
      .then((next) => { if (!cancelled) setSources(next); })
      .catch((err) => { if (!cancelled) setSourcesError(err instanceof Error ? err.message : "Unable to load sources"); });
    return () => { cancelled = true; };
  }, [accessToken, pageId, adopt]);

  const settingsDirty = useMemo(
    () => page !== null && draft !== null && Object.keys(settingsChanges(page, draft)).length > 0,
    [page, draft],
  );
  const layoutDirty = useMemo(() => JSON.stringify(layoutPayload(groups)) !== savedLayout, [groups, savedLayout]);

  async function saveSettings() {
    if (!page || !draft) return;
    setSavingSettings(true);
    setSlugError(null);
    setCssProblems([]);
    try {
      const saved = await statusPagesEditorApi.update(accessToken, page.id, settingsChanges(page, draft));
      const next = { ...page, ...saved };
      setPage(next);
      setDraft(settingsDraft(next));
      setPreviewRevision(value => value + 1);
      toast.success("Settings saved");
    } catch (err) {
      const problems = cssErrors(err);
      if (problems) setCssProblems(problems);
      else if (err instanceof ApiError && err.status === 409) setSlugError("Another status page already uses this slug.");
      else toast.error(err instanceof Error ? err.message : "Unable to save settings");
    } finally {
      setSavingSettings(false);
    }
  }

  async function saveLayout() {
    if (!page || layoutProblems(groups).length > 0) return;
    setSavingLayout(true);
    try {
      adopt(await statusPagesEditorApi.saveLayout(accessToken, page.id, layoutPayload(groups)));
      setPreviewRevision(value => value + 1);
      toast.success("Layout saved");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Unable to save the layout");
    } finally {
      setSavingLayout(false);
    }
  }

  async function close() {
    if (settingsDirty || layoutDirty) {
      const discard = await confirm({
        title: "Discard unsaved changes?",
        message: "Your unsaved settings or layout changes will be lost.",
        confirmLabel: "Discard changes",
      });
      if (!discard) return;
    }
    onClose();
  }

  if (loadError) {
    return (
      <div className="status-editor">
        <div className="nm-alert nm-alert--error" role="alert">{loadError}</div>
        <div><button type="button" className="nm-btn nm-btn--secondary" onClick={onClose}><ArrowLeft size={14} /> All status pages</button></div>
      </div>
    );
  }
  if (!page || !draft) return <PanelSkeleton lines={6} />;

  return (
    <div className="status-editor">
      <div className="status-editor-bar">
        <button type="button" className="nm-btn nm-btn--sm nm-btn--secondary" onClick={() => void close()}>
          <ArrowLeft size={14} /> All status pages
        </button>
        <div className="status-editor-bar-title">
          <strong>{page.name}</strong>
          <span className="status-editor-count">{page.visibility === "public" ? "Public page" : "Private page"}</span>
        </div>
        <a className="nm-btn nm-btn--sm nm-btn--ghost" href={statusPagePath(page.slug)} target="_blank" rel="noopener noreferrer">
          <ExternalLink size={14} /> Open {statusPagePath(page.slug)}
        </a>
      </div>
      <div className="nm-workspace-tabs nm-workspace-tabs--attached" role="tablist" aria-label="Status page editor">
        {EDITOR_TABS.map(({ id, label, Icon }) => (
          <button
            key={id}
            type="button"
            role="tab"
            id={`status-editor-tab-${id}`}
            aria-selected={tab === id}
            aria-controls="status-editor-stage"
            className={`nm-workspace-tab${tab === id ? " is-active" : ""}`}
            onClick={() => setTab(id)}
          >
            <Icon size={14} aria-hidden="true" />
            {label}
            {((id === "settings" && settingsDirty) || (id === "layout" && layoutDirty)) && <span className="status-editor-dirty" aria-label="unsaved changes" />}
          </button>
        ))}
      </div>
      <div className="nm-workspace-stage status-editor-stage">
        <div className="status-editor-panels status-editor-split">
          <div className="status-editor-controls" id="status-editor-stage" role="tabpanel" aria-labelledby={`status-editor-tab-${tab}`}>
            {tab === "settings" && (
              <div className="status-editor-panels">
                <SettingsForm
                  draft={draft}
                  setDraft={(update) => setDraft((current) => (current ? update(current) : current))}
                  saving={savingSettings}
                  dirty={settingsDirty}
                  slugError={slugError}
                  onSlugEdit={() => setSlugError(null)}
                  cssErrors={cssProblems}
                  onCssEdit={() => setCssProblems([])}
                  onSave={() => void saveSettings()}
                  onReset={() => { setDraft(settingsDraft(page)); setSlugError(null); setCssProblems([]); }}
                />
              </div>
            )}
            {tab === "layout" && (
              <StatusPageLayoutEditor
                groups={groups}
                setGroups={setGroups}
                sources={sources}
                sourcesError={sourcesError}
                dirty={layoutDirty}
                saving={savingLayout}
                onSave={() => void saveLayout()}
              />
            )}
            {tab === "incidents" && <StatusIncidentsPanel accessToken={accessToken} page={page} onChanged={() => setPreviewRevision(value => value + 1)} />}
            {tab === "notices" && <StatusNoticesPanel accessToken={accessToken} page={page} />}
            {tab === "maintenance" && <StatusMaintenancePanel accessToken={accessToken} page={page} canManageAlerts={canManageAlerts} />}
            {tab === "tokens" && <StatusTokensPanel accessToken={accessToken} page={page} />}
          </div>
          <PreviewPanel accessToken={accessToken} pageId={page.id} draft={draft}
            revision={`${tab}:${previewRevision}`}
            stale={layoutDirty || draft.heartbeat_window !== page.heartbeat_window} />
        </div>
      </div>
    </div>
  );
}
