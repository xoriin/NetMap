import { useState, type ReactNode } from "react";
import "./admin-preview.css";
import {
  Activity, Bell, Database, Gauge, KeyRound, LayoutDashboard, Network,
  Save, Server, Settings, Shield, SlidersHorizontal, Users, Wrench,
  type LucideIcon,
} from "lucide-react";

type DesignId = "flat" | "console" | "console-top" | "sections";

const designs: Array<{ id: DesignId; label: string; eyebrow: string; description: string }> = [
  {
    id: "flat",
    label: "Flat workspace",
    eyebrow: "Option A",
    description: "Folder tabs, one dominant form and a quiet information column with no enclosing page frame.",
  },
  {
    id: "console",
    label: "Admin console",
    eyebrow: "Option B",
    description: "A compact local navigation rail and denser control-centre layout for frequent administration.",
  },
  {
    id: "console-top",
    label: "Top-nav console",
    eyebrow: "Option B2",
    description: "The same compact control-centre hierarchy as B, without a second permanent sidebar.",
  },
  {
    id: "sections",
    label: "Section canvas",
    eyebrow: "Option C",
    description: "A single attached window divided by spacing and separators instead of many independent cards.",
  },
];

const adminSections: Array<{ label: string; Icon: LucideIcon }> = [
  { label: "System", Icon: Settings },
  { label: "Devices & Icons", Icon: Network },
  { label: "Users", Icon: Users },
  { label: "Groups", Icon: Shield },
  { label: "SNMP Profiles", Icon: Server },
  { label: "Notifications", Icon: Bell },
  { label: "Alerts", Icon: Activity },
  { label: "Automation", Icon: SlidersHorizontal },
  { label: "Security", Icon: KeyRound },
];

function SummaryCards({ compact = false }: { compact?: boolean }) {
  const cards = [
    { label: "Devices", value: "85", Icon: Network, tone: "teal" },
    { label: "Links", value: "5", Icon: Activity, tone: "blue" },
    { label: "Groups", value: "6", Icon: Shield, tone: "violet" },
    { label: "Users", value: "4", Icon: Users, tone: "green" },
  ];
  return (
    <div className={`admin-design-stats${compact ? " is-compact" : ""}`}>
      {cards.map(({ label, value, Icon, tone }) => (
        <div className={`admin-design-stat is-${tone}`} key={label}>
          <span><Icon size={compact ? 16 : 19} /></span>
          <strong>{value}</strong>
          <small>{label}</small>
        </div>
      ))}
    </div>
  );
}

function FolderNavigation() {
  return (
    <div className="admin-design-folder-tabs" role="tablist" aria-label="Template administration sections">
      {adminSections.map(({ label, Icon }, index) => (
        <button type="button" role="tab" aria-selected={index === 0} className={index === 0 ? "is-active" : ""} key={label}>
          <Icon size={13} />{label}
        </button>
      ))}
    </div>
  );
}

function AppSettings({ idPrefix, divided = false }: { idPrefix: string; divided?: boolean }) {
  return (
    <form className={`admin-design-settings${divided ? " is-divided" : ""}`}>
      <div className="admin-design-form-heading">
        <span><Settings size={18} /></span>
        <div><strong>App settings</strong><small>Identity, monitoring and account defaults</small></div>
      </div>
      <div className="admin-design-form-grid">
        <label htmlFor={`${idPrefix}-name`}>App name
          <input id={`${idPrefix}-name`} value="Xorin Net" readOnly />
        </label>
        <label htmlFor={`${idPrefix}-email`}>Support email
          <input id={`${idPrefix}-email`} value="help@example.com" readOnly />
        </label>
        <label className="is-wide" htmlFor={`${idPrefix}-login`}>Login page message
          <textarea id={`${idPrefix}-login`} value="Test Changes" rows={2} readOnly />
        </label>
        <label className="is-wide" htmlFor={`${idPrefix}-announcement`}>Announcement banner
          <textarea id={`${idPrefix}-announcement`} value="For all new accounts, please message your mother" rows={2} readOnly />
        </label>
      </div>
      <div className="admin-design-checks">
        <label><input type="checkbox" defaultChecked /> Enable live ping monitoring</label>
        <label><input type="checkbox" defaultChecked /> Allow public active network targets</label>
        <label><input type="checkbox" defaultChecked /> Default new IP reservations to +90 days</label>
      </div>
      <div className="admin-design-form-actions">
        <button type="button" className="nm-btn nm-btn--sm">Reset</button>
        <button type="button" className="nm-btn nm-btn--sm nm-btn--primary"><Save size={14} />Save settings</button>
      </div>
    </form>
  );
}

function InfoBlock({ icon: Icon, title, action, children }: {
  icon: LucideIcon;
  title: string;
  action?: string;
  children: ReactNode;
}) {
  return (
    <section className="admin-design-info-block">
      <header>
        <span><Icon size={16} /></span><strong>{title}</strong>
        {action && <button type="button" className="nm-btn nm-btn--sm">{action}</button>}
      </header>
      <div>{children}</div>
    </section>
  );
}

function VersionBlock() {
  return (
    <InfoBlock icon={Gauge} title="Version" action="What's new">
      <dl><dt>Installed</dt><dd>v1.4.0</dd><dt>Latest</dt><dd className="is-success">v1.4.0 — up to date</dd></dl>
    </InfoBlock>
  );
}

function SyslogBlock() {
  return (
    <InfoBlock icon={Database} title="Syslog configuration">
      <dl>
        <dt>Retention</dt><dd>7 days</dd><dt>UDP listener</dt><dd>enabled :1514</dd>
        <dt>TLS listener</dt><dd>disabled</dd><dt>Stored events</dt><dd>0</dd>
        <dt>Last cleanup</dt><dd>01/08/2026, 10:55</dd>
      </dl>
    </InfoBlock>
  );
}

function DiagnosticsBlock() {
  return (
    <InfoBlock icon={Wrench} title="System diagnostics" action="Load">
      <p>Fetch current runtime, database and monitoring diagnostics.</p>
    </InfoBlock>
  );
}

function FlatWorkspace() {
  return (
    <div className="admin-design-template admin-design-template--flat" data-design="flat">
      <SummaryCards />
      <FolderNavigation />
      <div className="admin-design-flat-grid">
        <AppSettings idPrefix="flat" />
        <aside className="admin-design-info-stack"><VersionBlock /><SyslogBlock /><DiagnosticsBlock /></aside>
      </div>
    </div>
  );
}

function AdminConsole() {
  return (
    <div className="admin-design-template admin-design-template--console" data-design="console">
      <SummaryCards compact />
      <div className="admin-design-console-frame">
        <nav aria-label="Console administration sections">
          <div className="admin-design-console-brand"><LayoutDashboard size={17} /><strong>Administration</strong></div>
          {adminSections.map(({ label, Icon }, index) => (
            <button type="button" className={index === 0 ? "is-active" : ""} key={label}><Icon size={14} />{label}</button>
          ))}
        </nav>
        <main>
          <div className="admin-design-console-title"><div><small>System</small><h3>Application configuration</h3></div><span className="nm-pill nm-pill--success">Healthy</span></div>
          <div className="admin-design-console-grid">
            <AppSettings idPrefix="console" divided />
            <aside className="admin-design-info-stack"><VersionBlock /><SyslogBlock /><DiagnosticsBlock /></aside>
          </div>
        </main>
      </div>
    </div>
  );
}

function TopNavConsole() {
  return (
    <div className="admin-design-template admin-design-template--console-top" data-design="console-top">
      <SummaryCards compact />
      <div className="admin-design-top-console">
        <header>
          <div><LayoutDashboard size={18} /><span><small>Administration</small><strong>System control centre</strong></span></div>
          <span className="nm-pill nm-pill--success">Healthy</span>
        </header>
        <nav aria-label="Top console administration sections">
          {adminSections.map(({ label, Icon }, index) => (
            <button type="button" className={index === 0 ? "is-active" : ""} key={label}><Icon size={13} />{label}</button>
          ))}
        </nav>
        <main className="admin-design-console-grid">
          <AppSettings idPrefix="console-top" divided />
          <aside className="admin-design-info-stack"><VersionBlock /><SyslogBlock /><DiagnosticsBlock /></aside>
        </main>
      </div>
    </div>
  );
}

function SectionCanvas() {
  return (
    <div className="admin-design-template admin-design-template--sections" data-design="sections">
      <SummaryCards />
      <FolderNavigation />
      <div className="admin-design-section-window">
        <div className="admin-design-section-title"><div><Settings size={19} /><span><strong>System</strong><small>Application and service configuration</small></span></div><button type="button" className="nm-btn nm-btn--sm nm-btn--primary"><Save size={14} />Save all</button></div>
        <div className="admin-design-section-columns">
          <AppSettings idPrefix="sections" divided />
          <div className="admin-design-section-info">
            <VersionBlock />
            <SyslogBlock />
            <DiagnosticsBlock />
            <InfoBlock icon={Database} title="Database backup & restore" action="Open"><p>Download, validate or restore a signed NetMap backup.</p></InfoBlock>
          </div>
        </div>
      </div>
    </div>
  );
}

export function AdminDesignPreviewWorkspace() {
  const [activeDesign, setActiveDesign] = useState<DesignId>("console-top");
  return (
    <section className="admin-design-preview">
      <div className="admin-design-intro">
        <div><span>Visual review only</span><h2>Choose an Admin workspace direction</h2><p>These static templates reuse the current System-page content. Nothing here saves data or changes the live Admin page.</p></div>
      </div>
      <div className="admin-design-choices" role="tablist" aria-label="Admin design alternatives">
        {designs.map((design) => (
          <button type="button" role="tab" aria-selected={activeDesign === design.id} className={activeDesign === design.id ? "is-active" : ""} onClick={() => setActiveDesign(design.id)} key={design.id}>
            <small>{design.eyebrow}</small><strong>{design.label}</strong><span>{design.description}</span>
          </button>
        ))}
      </div>
      <div className="admin-design-review-stage" role="tabpanel">
        {activeDesign === "flat" && <FlatWorkspace />}
        {activeDesign === "console" && <AdminConsole />}
        {activeDesign === "console-top" && <TopNavConsole />}
        {activeDesign === "sections" && <SectionCanvas />}
      </div>
    </section>
  );
}
