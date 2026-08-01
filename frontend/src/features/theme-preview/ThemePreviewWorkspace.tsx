import {
  AlertTriangle,
  Bell,
  Check,
  ChevronDown,
  ChevronRight,
  CircleCheck,
  CircleX,
  Clock3,
  Database,
  Eye,
  EyeOff,
  FileUp,
  Gauge,
  Info,
  KeyRound,
  Layers3,
  LoaderCircle,
  LockKeyhole,
  Map,
  Monitor,
  MousePointer2,
  Network,
  Palette,
  Play,
  Plus,
  RefreshCw,
  ScanLine,
  Search,
  Server,
  ShieldCheck,
  SlidersHorizontal,
  TableProperties,
  Trash2,
  UserRound,
  UserX,
  Wifi,
  Wrench,
} from "lucide-react";
import "./theme-preview.css";
import { useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";

const DEFAULT_TABLE_COL_WIDTHS = [190, 260, 130, 130, 120, 100];
const DEFAULT_TABLE_COL_PCTS = [19, 27, 14, 14, 13, 13];
const TABLE_COL_WIDTHS_KEY = "netmap.themePreviewColumnWidths.v2";
const TABLE_MIN_COL_WIDTH = 80;

function loadTableColWidths(): number[] | null {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(TABLE_COL_WIDTHS_KEY) ?? "null");
    if (Array.isArray(parsed) && parsed.length === DEFAULT_TABLE_COL_WIDTHS.length && parsed.every((width) => typeof width === "number" && Number.isFinite(width))) {
      return parsed.map((width) => Math.max(TABLE_MIN_COL_WIDTH, width));
    }
  } catch {
    // Ignore malformed review-only preferences and use the documented defaults.
  }
  return null;
}

const sampleRows = [
  { name: "Core router", address: "10.30.20.1", type: "Gateway", state: "Online", latency: "12 ms" },
  { name: "Public website", address: "https://example.com", type: "HTTP", state: "Online", latency: "184 ms" },
  { name: "Backup NAS", address: "10.30.20.18", type: "Storage", state: "Warning", latency: "48 ms" },
];

const previewReservedIps = new Set([7, 22, 48, 63, 82, 91, 188, 201, 218, 231, 242, 250]);
const previewUsedIps = new Set<number>();
for (let offset = 0; previewUsedIps.size < 38; offset += 1) {
  const candidate = 2 + ((offset * 37) % 98);
  if (!previewReservedIps.has(candidate)) previewUsedIps.add(candidate);
}

function previewIpClass(index: number) {
  if (index === 0 || index === 255) return "is-system";
  if (index === 1) return "is-gateway";
  if (index >= 100 && index <= 177) return "is-dhcp";
  if (previewReservedIps.has(index)) return "is-reserved";
  if (previewUsedIps.has(index)) return "is-used";
  return "";
}

function previewIpKind(index: number) {
  const state = previewIpClass(index);
  if (state === "is-system") return index === 0 ? "Network" : "Broadcast";
  if (state === "is-gateway") return "Gateway";
  if (state === "is-dhcp") return "DHCP pool";
  if (state === "is-reserved") return "Reserved";
  if (state === "is-used") return "Device";
  return "Available";
}

function PreviewHeader({ icon: Icon, title, trailing }: { icon: typeof Server; title: string; trailing?: ReactNode }) {
  return (
    <div className="theme-lab-panel-header">
      <div className="theme-lab-panel-title">
        <span className="theme-lab-panel-icon"><Icon size={18} /></span>
        <span className="theme-lab-title-separator" aria-hidden="true">-</span>
        <strong>{title}</strong>
      </div>
      {trailing}
    </div>
  );
}

function RttWave({ label = "Example response-time wave" }: { label?: string }) {
  return (
    <svg className="theme-lab-rtt-wave" viewBox="0 0 240 56" preserveAspectRatio="none" role="img" aria-label={label}>
      <path className="theme-lab-rtt-area" d="M0 42 L10 38 L20 40 L30 31 L40 34 L50 27 L60 30 L70 22 L80 26 L90 29 L100 20 L110 24 L120 18 L130 23 L140 30 L150 25 L160 28 L170 19 L180 22 L190 16 L200 24 L210 20 L220 27 L230 21 L240 23 L240 56 L0 56 Z" />
      <polyline className="theme-lab-rtt-line" points="0,42 10,38 20,40 30,31 40,34 50,27 60,30 70,22 80,26 90,29 100,20 110,24 120,18 130,23 140,30 150,25 160,28 170,19 180,22 190,16 200,24 210,20 220,27 230,21 240,23" />
    </svg>
  );
}

function ThemeSample({ mode }: { mode: "light" | "dark" }) {
  const title = mode === "light" ? "Light theme" : "Dark theme";
  return (
    <div className={`theme-lab-theme-sample theme-lab-theme-sample--${mode}`}>
      <div className="theme-lab-sample-label">{title}</div>
      <div className="theme-lab-panel theme-lab-panel--shadow">
        <PreviewHeader icon={Palette} title="Appearance" trailing={<span className="theme-lab-status">Active</span>} />
        <div className="theme-lab-panel-body">
          <label className="theme-lab-field">
            <span>Panel name</span>
            <input type="text" value="Network overview" readOnly />
          </label>
          <div className="theme-lab-inline-actions">
            <button type="button" className="theme-lab-button">Cancel</button>
            <button type="button" className="theme-lab-button theme-lab-button--primary">Save changes</button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function ThemePreviewWorkspace() {
  const [tableColWidths, setTableColWidths] = useState(loadTableColWidths);
  const [activeTab, setActiveTab] = useState("General");
  const [secretVisible, setSecretVisible] = useState(false);
  const [toggleEnabled, setToggleEnabled] = useState(true);
  const [selectedRows, setSelectedRows] = useState<string[]>([]);
  const [sortAscending, setSortAscending] = useState(true);
  const [advancedOpen, setAdvancedOpen] = useState(true);
  const [choiceMenuOpen, setChoiceMenuOpen] = useState(true);
  const [choiceValue, setChoiceValue] = useState("Brisbane office");
  const [confirmValue, setConfirmValue] = useState("");
  const [scanRunning, setScanRunning] = useState(false);
  const [authPreview, setAuthPreview] = useState<"login" | "setup" | "reset">("login");
  const [ipamPreview, setIpamPreview] = useState<"map" | "list" | "strip">("map");
  const [hoveredPreviewIp, setHoveredPreviewIp] = useState(4);
  const resizingRef = useRef<{ columnIndex: number; startX: number; startWidth: number; widths: number[] } | null>(null);
  const tableRef = useRef<HTMLTableElement | null>(null);
  const tableWidth = tableColWidths?.reduce((total, width) => total + width, 0) ?? null;

  function startTableColumnResize(columnIndex: number, event: ReactMouseEvent<HTMLElement>) {
    event.preventDefault();
    const renderedWidths = tableColWidths ?? (
      tableRef.current
        ? Array.from(tableRef.current.querySelectorAll<HTMLElement>("thead th")).map((header) => header.getBoundingClientRect().width)
        : DEFAULT_TABLE_COL_WIDTHS
    );
    resizingRef.current = {
      columnIndex,
      startX: event.clientX,
      startWidth: renderedWidths[columnIndex],
      widths: [...renderedWidths],
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    function onMove(moveEvent: globalThis.MouseEvent) {
      const resize = resizingRef.current;
      if (!resize) return;
      const nextWidths = [...resize.widths];
      nextWidths[resize.columnIndex] = Math.max(TABLE_MIN_COL_WIDTH, resize.startWidth + moveEvent.clientX - resize.startX);
      setTableColWidths(nextWidths);
      window.localStorage.setItem(TABLE_COL_WIDTHS_KEY, JSON.stringify(nextWidths));
    }

    function onUp() {
      resizingRef.current = null;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    }

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }

  function resetTableColumnWidths() {
    window.localStorage.removeItem(TABLE_COL_WIDTHS_KEY);
    setTableColWidths(null);
  }

  return (
    <section className="theme-lab-workspace">
      <div className="theme-lab-intro">
        <div>
          <span className="theme-lab-kicker">Dev review page</span>
          <h2>Application panel system</h2>
          <p>This page changes no existing workspace. Review the proposed components here before they are rolled out page by page.</p>
        </div>
        <div className="theme-lab-decisions" aria-label="Agreed design decisions">
          <span>44px headers</span>
          <span>Icon - Title</span>
          <span>16px bodies</span>
          <span>Solid surfaces</span>
        </div>
      </div>

      <section className="theme-lab-review-section">
        <div className="theme-lab-section-heading">
          <div>
            <span className="theme-lab-step">01</span>
            <h3>Standard panel</h3>
          </div>
          <p>Compact attached header, clear body well, restrained border and very light elevation.</p>
        </div>
        <div className="theme-lab-panel theme-lab-panel--shadow">
          <PreviewHeader icon={Server} title="Service configuration" trailing={<span className="theme-lab-status">Enabled</span>} />
          <div className="theme-lab-panel-body theme-lab-form-grid">
            <label className="theme-lab-field">
              <span>Display name</span>
              <input type="text" value="Public website" readOnly />
            </label>
            <label className="theme-lab-field">
              <span>Check interval</span>
              <select defaultValue="60">
                <option value="60">Every minute</option>
              </select>
            </label>
            <div className="theme-lab-helper">Supporting text remains muted, while labels and values keep the brighter popup contrast.</div>
            <div className="theme-lab-inline-actions">
              <button type="button" className="nm-btn nm-btn--secondary">Cancel</button>
              <button type="button" className="nm-btn nm-btn--primary">Save changes</button>
            </div>
          </div>
        </div>
      </section>

      <section className="theme-lab-review-section">
        <div className="theme-lab-section-heading">
          <div>
            <span className="theme-lab-step">02</span>
            <h3>Summary cards</h3>
          </div>
          <p>Approved direction: solid, simple cards with colour confined to the icon and thin top accent.</p>
        </div>
        <div className="theme-lab-stat-grid">
          <div className="theme-lab-stat theme-lab-stat--cyan"><span><Monitor size={18} /></span><strong>85</strong><small>Devices</small></div>
          <div className="theme-lab-stat theme-lab-stat--green"><span><CircleCheck size={18} /></span><strong>78</strong><small>Online</small></div>
          <div className="theme-lab-stat theme-lab-stat--blue"><span><Gauge size={18} /></span><strong>42 ms</strong><small>Avg response</small></div>
        </div>
      </section>

      <section className="theme-lab-review-section">
        <div className="theme-lab-section-heading">
          <div>
            <span className="theme-lab-step">03</span>
            <h3>Purpose-built table window</h3>
          </div>
          <p>Title, result count, filters and actions share one attached 44px header. Drag a column divider to resize; double-click one to reset.</p>
        </div>
        <div className="theme-lab-panel theme-lab-panel--shadow theme-lab-table-window">
          <div className="theme-lab-panel-header theme-lab-table-header">
            <div className="theme-lab-panel-title">
              <span className="theme-lab-panel-icon"><TableProperties size={18} /></span>
              <span className="theme-lab-title-separator" aria-hidden="true">-</span>
              <strong>Assets</strong>
              <span className="theme-lab-result-count">3 results</span>
            </div>
            <div className="theme-lab-table-tools">
              <select aria-label="Filter status" defaultValue="all"><option value="all">All statuses</option></select>
              <label className="theme-lab-search"><Search size={14} /><input aria-label="Search assets" placeholder="Search assets" /></label>
              <button type="button" className="nm-btn nm-btn--sm nm-btn--primary"><Plus size={14} />Add asset</button>
            </div>
          </div>
          <div className="theme-lab-table-scroll">
            <table
              className={`theme-lab-table${tableColWidths ? " theme-lab-table--resized" : ""}`}
              ref={tableRef}
              style={tableWidth === null ? undefined : ({ width: tableWidth } as CSSProperties)}
            >
              <colgroup>
                {tableColWidths
                  ? tableColWidths.map((width, index) => <col key={index} style={{ width }} />)
                  : DEFAULT_TABLE_COL_PCTS.map((width, index) => <col key={index} style={{ width: `${width}%` }} />)}
              </colgroup>
              <thead>
                <tr>
                  {["Name", "Address", "Type", "Status", "Response", ""].map((label, index) => (
                    <th
                      key={label || "actions"}
                      aria-label={label || "Actions"}
                      onMouseDown={(event) => {
                        const bounds = event.currentTarget.getBoundingClientRect();
                        if (bounds.right - event.clientX <= 12) startTableColumnResize(index, event);
                      }}
                      onDoubleClick={(event) => {
                        const bounds = event.currentTarget.getBoundingClientRect();
                        if (bounds.right - event.clientX <= 12) resetTableColumnWidths();
                      }}
                    >
                      {label}
                      <span
                        className="theme-lab-col-resize-handle"
                        onMouseDown={(event) => {
                          event.stopPropagation();
                          startTableColumnResize(index, event);
                        }}
                        onDoubleClick={(event) => {
                          event.stopPropagation();
                          resetTableColumnWidths();
                        }}
                        title="Drag to resize · double-click to reset all columns"
                      />
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sampleRows.map((row) => (
                  <tr key={row.name}>
                    <td><strong>{row.name}</strong></td>
                    <td><code>{row.address}</code></td>
                    <td>{row.type}</td>
                    <td><span className={`theme-lab-row-state${row.state === "Warning" ? " theme-lab-row-state--warning" : ""}`}>{row.state}</span></td>
                    <td>{row.latency}</td>
                    <td><button type="button" className="nm-btn nm-btn--sm nm-btn--secondary">View</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="theme-lab-table-footer"><span>Showing 1–3 of 3 assets</span><span>Page 1 of 1</span></div>
        </div>
      </section>

      <section className="theme-lab-review-section">
        <div className="theme-lab-section-heading">
          <div>
            <span className="theme-lab-step">04</span>
            <h3>Elevation comparison</h3>
          </div>
          <p>Approved direction: a very light shadow adds separation, especially in light mode.</p>
        </div>
        <div className="theme-lab-panel theme-lab-panel--shadow">
          <PreviewHeader icon={Database} title="Storage" trailing={<ShieldCheck size={18} aria-label="Protected" />} />
          <div className="theme-lab-panel-body"><p className="theme-lab-copy">The panel lifts gently from the page without looking like a popup or casting a heavy halo.</p></div>
        </div>
      </section>

      <section className="theme-lab-review-section">
        <div className="theme-lab-section-heading">
          <div>
            <span className="theme-lab-step">05</span>
            <h3>Light and dark parity</h3>
          </div>
          <p>These examples stay fixed while the sidebar theme control lets you test the complete page in either mode.</p>
        </div>
        <div className="theme-lab-theme-grid">
          <ThemeSample mode="light" />
          <ThemeSample mode="dark" />
        </div>
      </section>

      <section className="theme-lab-review-section">
        <div className="theme-lab-section-heading">
          <div><span className="theme-lab-step">06</span><h3>Tabs and navigation states</h3></div>
          <p>Attached folder tabs use the same restrained teal for hover, keyboard focus and selection.</p>
        </div>
        <div className="theme-lab-tab-demo">
          <div className="theme-lab-folder-tabs" role="tablist" aria-label="Example settings sections">
            {["General", "Request", "Validation", "Security"].map((tab) => (
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === tab}
                className={activeTab === tab ? "is-active" : ""}
                key={tab}
                onClick={() => setActiveTab(tab)}
              >{tab}</button>
            ))}
          </div>
          <div className="theme-lab-tab-surface" role="tabpanel">
            <span className="theme-lab-panel-icon"><SlidersHorizontal size={18} /></span>
            <div><strong>{activeTab} settings</strong><p>The tab is physically attached to one stable content surface, so switching sections never snaps the window.</p></div>
          </div>
        </div>
      </section>

      <section className="theme-lab-review-section">
        <div className="theme-lab-section-heading">
          <div><span className="theme-lab-step">07</span><h3>Forms and field states</h3></div>
          <p>Every common input is shown together, including help, validation, read-only and disabled states.</p>
        </div>
        <div className="theme-lab-panel theme-lab-panel--shadow">
          <PreviewHeader icon={SlidersHorizontal} title="Connection settings" trailing={<span className="theme-lab-status">Required fields</span>} />
          <div className="theme-lab-panel-body theme-lab-control-grid">
            <label className="theme-lab-field"><span>Name</span><input defaultValue="Core gateway" /></label>
            <label className="theme-lab-field"><span>Device type</span><select defaultValue="router"><option value="router">Router</option><option value="switch">Switch</option></select></label>
            <label className="theme-lab-field theme-lab-field--wide"><span>Description</span><textarea defaultValue="Primary route to the internet" /></label>
            <label className="theme-lab-field"><span>Maintenance date</span><input type="date" defaultValue="2026-08-14" /></label>
            <label className="theme-lab-field"><span>API secret</span><span className="theme-lab-secret"><input type={secretVisible ? "text" : "password"} defaultValue="example-token" /><button type="button" onClick={() => setSecretVisible((visible) => !visible)} aria-label={secretVisible ? "Hide example secret" : "Show example secret"}>{secretVisible ? <EyeOff size={15} /> : <Eye size={15} />}</button></span></label>
            <label className="theme-lab-field theme-lab-field--error"><span>Host address</span><input defaultValue="not-an-address" aria-invalid="true" /><small>Enter a valid hostname or IP address.</small></label>
            <label className="theme-lab-field"><span>Generated identifier</span><input value="nm-core-01" readOnly /><small>Read-only values remain legible.</small></label>
            <label className="theme-lab-field"><span>Inherited setting</span><input value="Managed by administrator" disabled /></label>
            <div className="theme-lab-field theme-lab-field--wide"><span>Import configuration</span><label className="theme-lab-file"><FileUp size={17} /><span><strong>Choose a JSON or CSV file</strong><small>Maximum file size 10 MB</small></span><input type="file" /></label></div>
            <fieldset className="theme-lab-options">
              <legend>Probe protocol</legend>
              <label><input type="radio" name="preview-protocol" defaultChecked /> ICMP</label>
              <label><input type="radio" name="preview-protocol" /> TCP</label>
              <label><input type="checkbox" defaultChecked /> Record history</label>
            </fieldset>
            <div className="theme-lab-toggle-row"><div><strong>Active monitoring</strong><small>Run checks on the configured interval.</small></div><button type="button" role="switch" aria-checked={toggleEnabled} className={`theme-lab-toggle${toggleEnabled ? " is-on" : ""}`} onClick={() => setToggleEnabled((enabled) => !enabled)}><span /></button></div>
          </div>
        </div>
      </section>

      <section className="theme-lab-review-section">
        <div className="theme-lab-section-heading">
          <div><span className="theme-lab-step">08</span><h3>Actions and feedback</h3></div>
          <p>Button hierarchy stays calm; feedback uses a narrow colour cue rather than filling the entire panel.</p>
        </div>
        <div className="theme-lab-panel theme-lab-panel--shadow">
          <PreviewHeader icon={Bell} title="Action hierarchy" />
          <div className="theme-lab-panel-body">
            <div className="theme-lab-button-showcase">
              <button type="button" className="nm-btn nm-btn--primary">Save changes</button>
              <button type="button" className="nm-btn nm-btn--secondary">Cancel</button>
              <button type="button" className="nm-btn nm-btn--ghost"><RefreshCw size={14} />Refresh</button>
              <button type="button" className="nm-btn nm-btn--danger"><Trash2 size={14} />Delete</button>
              <button type="button" className="nm-btn nm-btn--secondary" disabled>Disabled</button>
              <button type="button" className="nm-btn nm-btn--secondary" disabled><LoaderCircle className="theme-lab-spinner" size={14} />Saving</button>
            </div>
            <div className="theme-lab-feedback-grid">
              <div className="theme-lab-alert theme-lab-alert--info"><Info size={17} /><span><strong>Information</strong><small>A discovery scan can continue in the background.</small></span></div>
              <div className="theme-lab-alert theme-lab-alert--success"><CircleCheck size={17} /><span><strong>Changes saved</strong><small>The new settings are already active.</small></span></div>
              <div className="theme-lab-alert theme-lab-alert--warning"><AlertTriangle size={17} /><span><strong>Certificate expiring</strong><small>Renew it within the next seven days.</small></span></div>
              <div className="theme-lab-alert theme-lab-alert--error"><CircleX size={17} /><span><strong>Connection failed</strong><small>Check the address and authentication details.</small></span></div>
            </div>
          </div>
        </div>
      </section>

      <section className="theme-lab-review-section">
        <div className="theme-lab-section-heading">
          <div><span className="theme-lab-step">09</span><h3>Table interaction states</h3></div>
          <p>Selection, bulk actions, sorting, pagination, loading and empty results all retain the same window structure.</p>
        </div>
        <div className="theme-lab-state-grid">
          <div className="theme-lab-panel theme-lab-panel--shadow theme-lab-mini-table-window">
            <PreviewHeader icon={TableProperties} title="Selectable rows" trailing={<button type="button" className="nm-btn nm-btn--sm nm-btn--secondary" onClick={() => setSortAscending((value) => !value)}>Name {sortAscending ? "↑" : "↓"}</button>} />
            {selectedRows.length > 0 && <div className="theme-lab-bulk-bar"><strong>{selectedRows.length} selected</strong><button type="button" className="nm-btn nm-btn--sm nm-btn--secondary">Assign group</button><button type="button" className="nm-btn nm-btn--sm nm-btn--danger">Delete</button></div>}
            <div className="theme-lab-mini-rows">
              {[...sampleRows].sort((a, b) => sortAscending ? a.name.localeCompare(b.name) : b.name.localeCompare(a.name)).map((row) => (
                <label className={selectedRows.includes(row.name) ? "is-selected" : ""} key={row.name}><input type="checkbox" checked={selectedRows.includes(row.name)} onChange={(event) => setSelectedRows((rows) => event.target.checked ? [...rows, row.name] : rows.filter((name) => name !== row.name))} /><span><strong>{row.name}</strong><small>{row.address}</small></span><span className={`theme-lab-row-state${row.state === "Warning" ? " theme-lab-row-state--warning" : ""}`}>{row.state}</span></label>
              ))}
            </div>
            <div className="theme-lab-table-footer"><span>3 assets</span><span>‹ Prev &nbsp; 1 / 1 &nbsp; Next ›</span></div>
          </div>
          <div className="theme-lab-table-state-stack">
            <div className="theme-lab-panel theme-lab-panel--shadow"><PreviewHeader icon={Clock3} title="Loading" /><div className="theme-lab-skeleton-list" aria-label="Loading table example"><i /><i /><i /></div></div>
            <div className="theme-lab-panel theme-lab-panel--shadow"><PreviewHeader icon={Search} title="No results" /><div className="theme-lab-empty"><Search size={22} /><strong>No matching assets</strong><small>Clear the filters or try a broader search.</small><button type="button" className="nm-btn nm-btn--sm nm-btn--secondary">Clear filters</button></div></div>
          </div>
        </div>
      </section>

      <section className="theme-lab-review-section">
        <div className="theme-lab-section-heading">
          <div><span className="theme-lab-step">10</span><h3>Nested and collapsible content</h3></div>
          <p>Subsections stay quieter than their parent, while footer actions keep deliberate distance from the content.</p>
        </div>
        <div className="theme-lab-panel theme-lab-panel--shadow">
          <PreviewHeader icon={Layers3} title="Advanced configuration" trailing={<button type="button" className="theme-lab-collapse" aria-expanded={advancedOpen} onClick={() => setAdvancedOpen((open) => !open)}>{advancedOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />} {advancedOpen ? "Collapse" : "Expand"}</button>} />
          {advancedOpen && <div className="theme-lab-panel-body"><div className="theme-lab-nested"><div><LockKeyhole size={17} /><span><strong>Transport security</strong><small>Optional certificate and client authentication.</small></span></div><label className="theme-lab-field"><span>Minimum TLS version</span><select defaultValue="1.2"><option value="1.2">TLS 1.2</option><option value="1.3">TLS 1.3</option></select></label></div><div className="theme-lab-panel-actions"><button type="button" className="nm-btn nm-btn--secondary">Cancel</button><button type="button" className="nm-btn nm-btn--primary">Apply configuration</button></div></div>}
        </div>
      </section>

      <section className="theme-lab-review-section">
        <div className="theme-lab-section-heading">
          <div><span className="theme-lab-step">11</span><h3>Detail view and popup hierarchy</h3></div>
          <p>Both use the same palette; the popup receives slightly stronger elevation and a compact title bar.</p>
        </div>
        <div className="theme-lab-hierarchy-grid">
          <div className="theme-lab-panel theme-lab-panel--shadow"><PreviewHeader icon={Server} title="Device overview" trailing={<span className="theme-lab-row-state">Online</span>} /><div className="theme-lab-detail-body"><div className="theme-lab-detail-hero"><span className="theme-lab-panel-icon"><Server size={18} /></span><div><strong>Core gateway</strong><small>10.30.20.1 · Router</small></div></div><dl><div><dt>Uptime</dt><dd>99.98%</dd></div><div><dt>Last checked</dt><dd>12 seconds ago</dd></div><div><dt>Response</dt><dd>12 ms</dd></div></dl></div></div>
          <div className="theme-lab-popup-stage"><div className="theme-lab-popup-card"><PreviewHeader icon={Plus} title="Add location" trailing={<button type="button" className="theme-lab-icon-button" aria-label="Close example"><CircleX size={17} /></button>} /><div className="theme-lab-panel-body"><label className="theme-lab-field"><span>Location name</span><input placeholder="e.g. Brisbane office" /></label><div className="theme-lab-panel-actions"><button type="button" className="nm-btn nm-btn--secondary">Cancel</button><button type="button" className="nm-btn nm-btn--primary">Add location</button></div></div></div></div>
        </div>
      </section>

      <section className="theme-lab-review-section">
        <div className="theme-lab-section-heading">
          <div><span className="theme-lab-step">12</span><h3>Operational data visuals</h3></div>
          <p>Charts, health strips and progress indicators stay readable without turning the panel into a colour wash.</p>
        </div>
        <div className="theme-lab-panel theme-lab-panel--shadow">
          <PreviewHeader icon={Gauge} title="Service health" trailing={<span className="theme-lab-status">Last 24 hours</span>} />
          <div className="theme-lab-data-grid">
            <div className="theme-lab-donut" aria-label="98 percent healthy"><span><strong>98%</strong><small>Healthy</small></span></div>
            <div className="theme-lab-metric-stack"><div><span><strong>Response time</strong><small>42 ms average</small></span><div className="theme-lab-spark"><RttWave /></div></div><div><span><strong>Availability</strong><small>One brief interruption</small></span><div className="theme-lab-heartbeat">{Array.from({ length: 24 }, (_, index) => <i className={index === 16 ? "is-down" : index === 15 ? "is-warning" : ""} key={index} />)}</div></div><div><span><strong>Storage used</strong><small>68 GB of 100 GB</small></span><div className="theme-lab-progress"><i style={{ width: "68%" }} /></div></div></div>
          </div>
        </div>
      </section>

      <section className="theme-lab-review-section">
        <div className="theme-lab-section-heading">
          <div><span className="theme-lab-step">13</span><h3>Responsive behaviour</h3></div>
          <p>The same components reflow at tablet and mobile widths; controls wrap instead of compressing their contents.</p>
        </div>
        <div className="theme-lab-responsive-grid">
          {[{ label: "Desktop", size: "100%", rows: 3 }, { label: "Tablet", size: "74%", rows: 2 }, { label: "Mobile", size: "46%", rows: 1 }].map((frame) => <div className="theme-lab-device-frame" key={frame.label}><span>{frame.label}</span><div style={{ width: frame.size }}><header><i /><strong>Assets</strong><button type="button">+</button></header><nav><i /><i /><i /></nav>{Array.from({ length: frame.rows }, (_, index) => <p key={index}><i /><i /><i /></p>)}</div></div>)}
        </div>
      </section>

      <section className="theme-lab-review-section">
        <div className="theme-lab-section-heading">
          <div><span className="theme-lab-step">14</span><h3>Device monitoring popup</h3></div>
          <p>A high-density popup example for approving the real Monitoring drilldown before it is migrated.</p>
        </div>
        <div className="theme-lab-monitor-stage">
          <div className="theme-lab-monitor-popup">
            <div className="theme-lab-monitor-header">
              <div className="theme-lab-monitor-identity"><span className="theme-lab-monitor-live" /><span className="theme-lab-panel-icon"><Server size={19} /></span><div><strong>Core gateway</strong><small>10.30.20.1 · Router · Online</small></div></div>
              <div className="theme-lab-monitor-actions"><button type="button" className="nm-btn nm-btn--sm nm-btn--secondary">View device</button><button type="button" className="nm-btn nm-btn--sm nm-btn--secondary">Pause monitoring</button><button type="button" className="theme-lab-icon-button" aria-label="Close monitoring popup example"><CircleX size={17} /></button></div>
            </div>
            <div className="theme-lab-monitor-stats">
              {[{ label: "24 h uptime", value: "99.98%", tone: "good" }, { label: "7 d uptime", value: "99.94%", tone: "good" }, { label: "Avg RTT", value: "12.4 ms" }, { label: "Current RTT", value: "11 ms" }, { label: "Last checked", value: "12 sec ago" }].map((stat) => <div key={stat.label}><small>{stat.label}</small><strong className={stat.tone === "good" ? "is-good" : ""}>{stat.value}</strong></div>)}
            </div>
            <div className="theme-lab-monitor-body">
              <div className="theme-lab-monitor-column">
                <div className="theme-lab-monitor-section"><header><span><Gauge size={15} />Analysis</span><small>7-day baseline</small></header><dl><div><dt>Trend</dt><dd><span className="theme-lab-neutral-pill">Stable · 1.2%</span></dd></div><div><dt>Anomaly</dt><dd><span className="theme-lab-row-state">Normal</span></dd></div><div><dt>Baseline RTT</dt><dd>12.8 ms ± 1.4</dd></div><div><dt>p50 / p95</dt><dd>12.1 / 16.8 ms</dd></div><div><dt>Flaps (24 h)</dt><dd>0</dd></div></dl></div>
                <div className="theme-lab-monitor-section"><header><span><Monitor size={15} />Service status</span><small>latest check</small></header><div className="theme-lab-service-list"><div><i /><strong>HTTPS</strong><small>TCP :443 · HTTP 200 · 64 ms</small><span className="theme-lab-row-state">Open</span></div><div><i /><strong>SSH</strong><small>TCP :22 · 9 ms</small><span className="theme-lab-row-state">Open</span></div><div><i className="is-warning" /><strong>DNS</strong><small>UDP :53 · timeout</small><span className="theme-lab-row-state theme-lab-row-state--warning">Slow</span></div></div></div>
                <div className="theme-lab-monitor-section"><header><span><Bell size={15} />Alert rules</span><small>1 active</small></header><div className="theme-lab-monitor-alert"><i /><span><strong>Gateway goes offline</strong><small>Device offline · Email and webhook</small></span><span className="theme-lab-row-state">Enabled</span></div></div>
              </div>
              <div className="theme-lab-monitor-column">
                <div className="theme-lab-monitor-section"><header><span><Clock3 size={15} />Heartbeat</span><select aria-label="Monitoring popup history range" defaultValue="24"><option value="24">Last 24 h</option><option value="168">Last 7 days</option></select></header><div className="theme-lab-monitor-heartbeat">{Array.from({ length: 52 }, (_, index) => <i className={index === 37 ? "is-warning" : ""} key={index} />)}</div><div className="theme-lab-monitor-axis"><span>24 hours ago</span><span>Now</span></div></div>
                <div className="theme-lab-monitor-section"><header><span><AlertTriangle size={15} />Incident log</span><small>1 resolved</small></header><div className="theme-lab-monitor-incident"><i /><span><strong>Brief packet loss</strong><small>Yesterday, 14:22 → 14:24</small></span><span className="theme-lab-neutral-pill">2 min</span></div></div>
                <div className="theme-lab-monitor-section"><header><span><Gauge size={15} />Response time</span><small>52 data points</small></header><div className="theme-lab-monitor-chart"><RttWave label="Device RTT wave" /></div><div className="theme-lab-monitor-axis"><span>Typical range 10–17 ms</span><span>Latest 11 ms</span></div></div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="theme-lab-review-section">
        <div className="theme-lab-section-heading">
          <div><span className="theme-lab-step">15</span><h3>Overlays and choice controls</h3></div>
          <p>Dropdowns, searchable choices, tooltips, chips and swatches share one compact overlay surface.</p>
        </div>
        <div className="theme-lab-overlay-grid">
          <div className="theme-lab-panel theme-lab-panel--shadow theme-lab-choice-panel">
            <PreviewHeader icon={MousePointer2} title="Choice controls" />
            <div className="theme-lab-panel-body theme-lab-choice-body">
              <div className="theme-lab-field"><span>Location combobox</span><div className="theme-lab-combobox"><button type="button" aria-expanded={choiceMenuOpen} onClick={() => setChoiceMenuOpen((open) => !open)}><Map size={15} /><span>{choiceValue}</span><ChevronDown size={14} /></button>{choiceMenuOpen && <div className="theme-lab-choice-menu" role="listbox" aria-label="Example locations"><label><Search size={13} /><input aria-label="Filter example locations" placeholder="Search locations" /></label>{["Brisbane office", "Sydney data centre", "Remote site"].map((choice) => <button type="button" role="option" aria-selected={choiceValue === choice} className={choiceValue === choice ? "is-selected" : ""} key={choice} onClick={() => { setChoiceValue(choice); setChoiceMenuOpen(false); }}><span className="theme-lab-swatch" style={{ background: choice === "Brisbane office" ? "#39b6c7" : choice === "Sydney data centre" ? "#8b78d4" : "#da9d4b" }} />{choice}{choiceValue === choice && <Check size={14} />}</button>)}</div>}</div></div>
              <div className="theme-lab-field"><span>Compact action menu</span><div className="theme-lab-action-menu"><button type="button" className="nm-btn nm-btn--secondary">Options <ChevronDown size={14} /></button><div role="menu"><button type="button"><Wrench size={14} />Edit settings</button><button type="button"><RefreshCw size={14} />Run again</button><hr /><button type="button" className="is-danger"><Trash2 size={14} />Delete item</button></div></div></div>
            </div>
          </div>
          <div className="theme-lab-overlay-stack">
            <div className="theme-lab-panel theme-lab-panel--shadow"><PreviewHeader icon={Palette} title="Chips and badges" /><div className="theme-lab-chip-showcase"><span className="theme-lab-entity-chip"><i style={{ background: "#39b6c7" }} />Production</span><span className="theme-lab-entity-chip"><Server size={13} />Router</span><span className="theme-lab-row-state">Online</span><span className="theme-lab-row-state theme-lab-row-state--warning">Warning</span><span className="theme-lab-neutral-pill">Paused</span></div></div>
            <div className="theme-lab-panel theme-lab-panel--shadow"><PreviewHeader icon={Info} title="Tooltip and focus" /><div className="theme-lab-tooltip-stage"><button type="button" className="theme-lab-tooltip-target" aria-describedby="preview-tooltip"><Info size={16} />Hover or focus</button><div className="theme-lab-tooltip" id="preview-tooltip" role="tooltip"><strong>Monitoring interval</strong><span>How often NetMap checks this target.</span></div></div></div>
          </div>
        </div>
      </section>

      <section className="theme-lab-review-section">
        <div className="theme-lab-section-heading">
          <div><span className="theme-lab-step">16</span><h3>Confirmations, notifications and failures</h3></div>
          <p>Critical prompts are explicit, transient feedback stays compact, and blocked states always provide a next step.</p>
        </div>
        <div className="theme-lab-feedback-stage">
          <div className="theme-lab-confirm-card">
            <PreviewHeader icon={AlertTriangle} title="Delete 12 devices" />
            <div className="theme-lab-confirm-body"><div className="theme-lab-confirm-warning"><AlertTriangle size={20} /><div><strong>This cannot be undone</strong><p>The selected devices and their monitoring history will be permanently removed.</p></div></div><label className="theme-lab-field"><span>Type <code>delete</code> to continue</span><input value={confirmValue} onChange={(event) => setConfirmValue(event.target.value)} placeholder="delete" /></label><div className="theme-lab-panel-actions"><button type="button" className="nm-btn nm-btn--secondary">Cancel</button><button type="button" className="nm-btn nm-btn--danger" disabled={confirmValue !== "delete"}><Trash2 size={14} />Delete devices</button></div></div>
          </div>
          <div className="theme-lab-toast-column" aria-label="Notification examples">
            <div className="theme-lab-toast theme-lab-toast--success"><CircleCheck size={18} /><span><strong>Settings saved</strong><small>Your monitoring changes are active.</small></span><CircleX size={14} /></div>
            <div className="theme-lab-toast theme-lab-toast--info"><Info size={18} /><span><strong>Scan running</strong><small>You can safely leave this page.</small></span><CircleX size={14} /></div>
            <div className="theme-lab-toast theme-lab-toast--error"><CircleX size={18} /><span><strong>Save failed</strong><small>The server did not accept the change.</small></span><CircleX size={14} /></div>
          </div>
        </div>
        <div className="theme-lab-failure-grid">
          <div className="theme-lab-failure-card"><span><UserX size={22} /></span><div><strong>Access restricted</strong><p>You need Network Admin permission to manage discovery schedules.</p></div><button type="button" className="nm-btn nm-btn--sm nm-btn--secondary">Return to overview</button></div>
          <div className="theme-lab-failure-card theme-lab-failure-card--error"><span><Wrench size={22} /></span><div><strong>This panel could not load</strong><p>The rest of the workspace remains available. Retry this panel when you are ready.</p></div><button type="button" className="nm-btn nm-btn--sm nm-btn--secondary"><RefreshCw size={14} />Retry panel</button></div>
        </div>
      </section>

      <section className="theme-lab-review-section">
        <div className="theme-lab-section-heading">
          <div><span className="theme-lab-step">17</span><h3>Scans and long-running work</h3></div>
          <p>Progress communicates the current phase, retained results and whether the user may safely leave.</p>
        </div>
        <div className="theme-lab-panel theme-lab-panel--shadow">
          <PreviewHeader icon={ScanLine} title="Network discovery" trailing={<span className={`theme-lab-status${scanRunning ? " is-running" : ""}`}>{scanRunning ? "Running" : "Ready"}</span>} />
          <div className="theme-lab-scan-body">
            <div className="theme-lab-scan-summary"><span className="theme-lab-panel-icon"><Network size={18} /></span><div><strong>10.30.20.0/24</strong><small>ARP, ping and service detection · estimated 2–4 minutes</small></div><button type="button" className="nm-btn nm-btn--primary" onClick={() => setScanRunning((running) => !running)}>{scanRunning ? <><CircleX size={14} />Stop scan</> : <><Play size={14} />Start scan</>}</button></div>
            <div className="theme-lab-progress-track"><i style={{ width: scanRunning ? "62%" : "0%" }} /></div>
            <div className="theme-lab-scan-steps">{[{ label: "Prepare", state: "done" }, { label: "Discover hosts", state: scanRunning ? "active" : "waiting" }, { label: "Detect services", state: "waiting" }, { label: "Review results", state: "waiting" }].map((step, index) => <div className={`is-${step.state}`} key={step.label}><span>{step.state === "done" ? <Check size={13} /> : index + 1}</span><strong>{step.label}</strong><small>{step.state === "done" ? "Complete" : step.state === "active" ? "158 of 254 addresses" : "Waiting"}</small></div>)}</div>
            <div className="theme-lab-scan-log"><span><LoaderCircle className={scanRunning ? "theme-lab-spinner" : ""} size={15} /></span><code>{scanRunning ? "Scanning 10.30.20.158 · 18 hosts discovered · 7 new" : "Ready to scan. Existing inventory will not be changed until results are reviewed."}</code></div>
          </div>
        </div>
      </section>

      <section className="theme-lab-review-section">
        <div className="theme-lab-section-heading">
          <div><span className="theme-lab-step">18</span><h3>Specialised workspace surfaces</h3></div>
          <p>IPAM and Topology keep their task-specific visuals while using the same surface, overlay and control hierarchy.</p>
        </div>
        <div className="theme-lab-special-grid">
          <div className="theme-lab-panel theme-lab-panel--shadow">
            <PreviewHeader icon={Network} title="IP address views" trailing={<span className="theme-lab-result-count">10.30.20.0/24</span>} />
            <div className="theme-lab-ipam-preview">
              <div className="theme-lab-ipam-variants" role="tablist" aria-label="IP address layout examples">{(["map", "list", "strip"] as const).map((view) => <button type="button" role="tab" aria-selected={ipamPreview === view} className={ipamPreview === view ? "is-active" : ""} key={view} onClick={() => setIpamPreview(view)}>{view === "map" ? "Dense map" : view === "list" ? "Compact list" : "Utilization strip"}</button>)}</div>
              {ipamPreview === "map" && <div className="theme-lab-ip-map-wrap"><div className="theme-lab-ip-map-label"><span>All 256 positions</span><small>Eight rows · 32 addresses per row · hover for details</small></div><div className="theme-lab-ip-map-scroll"><div className="theme-lab-ip-map-rows">{Array.from({ length: 8 }, (_, rowIndex) => <div className="theme-lab-ip-map-row" key={rowIndex}><span>.{rowIndex * 32}–.{rowIndex * 32 + 31}</span><div>{Array.from({ length: 32 }, (_, columnIndex) => { const index = rowIndex * 32 + columnIndex; const state = previewIpClass(index); return <button type="button" aria-label={`10.30.20.${index}`} aria-describedby="theme-lab-ip-detail" className={`theme-lab-ip-map-cell ${state}${hoveredPreviewIp === index ? " is-inspected" : ""}`} key={index} onMouseEnter={() => setHoveredPreviewIp(index)} onFocus={() => setHoveredPreviewIp(index)} />; })}</div></div>)}</div></div><div className="theme-lab-ip-legend"><span><i className="is-used" />Device</span><span><i className="is-dhcp" />DHCP pool</span><span><i className="is-reserved" />Reserved</span><span><i />Free</span><span><i className="is-system" />Network / broadcast</span></div></div>}
              {ipamPreview === "list" && <div className="theme-lab-ip-list"><header><span>Address</span><span>Assignment</span><span>Status</span></header>{[{ ip: ".1", name: "Core gateway", status: "Online" }, { ip: ".4", name: "Core switch", status: "Online" }, { ip: ".7", name: "Reserved · Printer", status: "Reserved" }, { ip: ".9", name: "Backup NAS", status: "Online" }].map((row) => <div key={row.ip}><code>10.30.20{row.ip}</code><span>{row.name}</span><span className={row.status === "Online" ? "is-online" : ""}>{row.status}</span></div>)}<footer><span>Showing assigned and reserved addresses</span><span>38 results · 1 / 2</span></footer></div>}
              {ipamPreview === "strip" && <div className="theme-lab-ip-strip-view"><div className="theme-lab-ip-strip">{Array.from({ length: 256 }, (_, index) => <i className={previewIpClass(index)} key={index} title={`10.30.20.${index}`} />)}</div><div className="theme-lab-ip-usage"><div><strong>254</strong><small>Usable</small></div><div><strong>38</strong><small>Assigned</small></div><div><strong>78</strong><small>DHCP pool</small></div><div><strong>126</strong><small>Available</small></div></div><div className="theme-lab-progress"><i style={{ width: "50.4%" }} /></div><p>128 of 254 usable addresses are assigned, reserved or inside the DHCP pool.</p></div>}
              {ipamPreview === "map" && <div className="theme-lab-ip-tooltip" id="theme-lab-ip-detail"><header><i className={previewIpClass(hoveredPreviewIp) || "is-free"} />10.30.20.{hoveredPreviewIp} <span>{previewIpKind(hoveredPreviewIp)}</span></header><dl>{previewIpKind(hoveredPreviewIp) === "Device" && <><div><dt>Name</dt><dd>Example device</dd></div><div><dt>MAC</dt><dd>00:1A:2B:3C:4D:5E</dd></div><div><dt>Status</dt><dd className="is-good">Online</dd></div></>}{previewIpKind(hoveredPreviewIp) === "DHCP pool" && <><div><dt>Range</dt><dd>Dynamic assignment pool</dd></div><div><dt>Status</dt><dd className="is-good">Available</dd></div></>}{previewIpKind(hoveredPreviewIp) === "Reserved" && <><div><dt>Reservation</dt><dd>Printer allocation</dd></div><div><dt>Status</dt><dd>Unused</dd></div></>}{previewIpKind(hoveredPreviewIp) === "Gateway" && <><div><dt>Role</dt><dd>Default gateway</dd></div><div><dt>Status</dt><dd className="is-good">Online</dd></div></>}{previewIpKind(hoveredPreviewIp) === "Available" && <><div><dt>Status</dt><dd className="is-good">Available</dd></div><div><dt>Action</dt><dd>Click to reserve</dd></div></>}{previewIpKind(hoveredPreviewIp) === "Network" && <div><dt>Role</dt><dd>Network address</dd></div>}{previewIpKind(hoveredPreviewIp) === "Broadcast" && <div><dt>Role</dt><dd>Broadcast address</dd></div>}</dl></div>}
            </div>
          </div>
          <div className="theme-lab-panel theme-lab-panel--shadow"><PreviewHeader icon={Map} title="Topology canvas controls" trailing={<span className="theme-lab-result-count">85 devices</span>} /><div className="theme-lab-topology-preview"><div className="theme-lab-topo-toolbar"><button type="button"><Search size={14} />Find</button><button type="button"><Network size={14} />Path</button><button type="button"><Layers3 size={14} />Layouts</button></div><svg viewBox="0 0 420 180" role="img" aria-label="Example topology canvas"><path d="M75 90 L205 46 L342 88 M205 46 L210 142 M75 90 L210 142" /><g transform="translate(49 66)"><rect width="52" height="48" rx="8" /><circle cx="26" cy="17" r="7" /><text x="26" y="36">Gateway</text></g><g transform="translate(179 22)"><rect width="52" height="48" rx="8" /><circle cx="26" cy="17" r="7" /><text x="26" y="36">Switch</text></g><g transform="translate(316 64)"><rect width="52" height="48" rx="8" /><circle cx="26" cy="17" r="7" /><text x="26" y="36">Server</text></g><g transform="translate(184 118)"><rect width="52" height="48" rx="8" /><circle cx="26" cy="17" r="7" /><text x="26" y="36">NAS</text></g></svg><div className="theme-lab-topo-float"><MousePointer2 size={14} /><span><strong>Core switch</strong><small>10.30.20.5 · Online</small></span></div><div className="theme-lab-minimap"><i /><i /><i /><i /><span /></div></div></div>
        </div>
      </section>

      <section className="theme-lab-review-section">
        <div className="theme-lab-section-heading">
          <div><span className="theme-lab-step">19</span><h3>Authentication screens</h3></div>
          <p>Login, first-time setup and password reset retain the cleaner palette without becoming workspace panels.</p>
        </div>
        <div className="theme-lab-auth-stage">
          <div className="theme-lab-auth-switch" role="tablist" aria-label="Authentication screen examples">{(["login", "setup", "reset"] as const).map((view) => <button type="button" role="tab" aria-selected={authPreview === view} className={authPreview === view ? "is-active" : ""} key={view} onClick={() => setAuthPreview(view)}>{view === "login" ? "Login" : view === "setup" ? "First-time setup" : "Password reset"}</button>)}</div>
          <div className="theme-lab-auth-card">
            <div className="theme-lab-auth-brand"><span><Network size={22} /></span><strong>NetMap</strong></div>
            {authPreview === "login" && <><div className="theme-lab-auth-copy"><h4>Welcome back</h4><p>Sign in to manage your network.</p></div><label className="theme-lab-field"><span>Email</span><input type="email" placeholder="you@example.com" /></label><label className="theme-lab-field"><span>Password</span><input type="password" placeholder="Enter your password" /></label><button type="button" className="nm-btn nm-btn--primary theme-lab-auth-submit"><KeyRound size={14} />Sign in</button><button type="button" className="theme-lab-auth-link">Forgot your password?</button></>}
            {authPreview === "setup" && <><div className="theme-lab-auth-copy"><h4>Create the administrator</h4><p>Set up the first SuperAdmin account.</p></div><label className="theme-lab-field"><span>Full name</span><input placeholder="Network administrator" /></label><label className="theme-lab-field"><span>Email</span><input type="email" placeholder="admin@example.com" /></label><label className="theme-lab-field"><span>Password</span><input type="password" placeholder="At least 12 characters" /></label><button type="button" className="nm-btn nm-btn--primary theme-lab-auth-submit"><UserRound size={14} />Create account</button></>}
            {authPreview === "reset" && <><div className="theme-lab-auth-copy"><h4>Reset your password</h4><p>We will send a secure reset link if the account exists.</p></div><div className="theme-lab-alert theme-lab-alert--info"><Info size={17} /><span><strong>No account details are revealed</strong><small>The response is identical for every email address.</small></span></div><label className="theme-lab-field"><span>Email</span><input type="email" placeholder="you@example.com" /></label><button type="button" className="nm-btn nm-btn--primary theme-lab-auth-submit">Send reset link</button><button type="button" className="theme-lab-auth-link">Back to sign in</button></>}
          </div>
        </div>
      </section>
    </section>
  );
}
