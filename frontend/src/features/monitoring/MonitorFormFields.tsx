import { useState, type Dispatch, type SetStateAction } from "react";
import { Globe2 } from "lucide-react";
import type {
  HttpMethod,
  Monitor,
  MonitorAuthType,
  MonitorBodyEncoding,
  MonitorJsonOperator,
  MonitorOauthAuthMethod,
} from "../../api/client";

export type MonitorFormState = {
  name: string;
  description: string;
  tags_text: string;
  url: string;
  http_method: HttpMethod;
  expected_status_min: number;
  expected_status_max: number;
  timeout_seconds: number;
  verify_tls: boolean;
  follow_redirects: boolean;
  max_redirects: number;
  accepted_status_codes: string;
  request_headers_text: string;
  request_body: string;
  body_encoding: MonitorBodyEncoding;
  auth_type: MonitorAuthType;
  auth_username: string;
  auth_password: string;
  bearer_token: string;
  oauth_token_url: string;
  oauth_client_id: string;
  oauth_client_secret: string;
  oauth_scopes: string;
  oauth_audience: string;
  oauth_auth_method: MonitorOauthAuthMethod;
  proxy_url: string;
  tls_ca: string;
  tls_cert: string;
  tls_key: string;
  keyword: string;
  keyword_inverted: boolean;
  json_path: string;
  json_operator: MonitorJsonOperator;
  expected_value: string;
  cache_bust: boolean;
  upside_down: boolean;
  check_interval_seconds: number;
  max_retries: number;
  retry_interval_seconds: number;
  certificate_expiry_alert: boolean;
  certificate_expiry_days: number;
  enabled: boolean;
};

type Props = {
  form: MonitorFormState;
  setForm: Dispatch<SetStateAction<MonitorFormState>>;
  editingMonitor: Monitor | null;
  httpMethods: HttpMethod[];
  intervalOptions: { value: number; label: string }[];
};

const JSON_OPERATORS: { value: MonitorJsonOperator; label: string }[] = [
  { value: "equals", label: "Equals" },
  { value: "not_equals", label: "Does not equal" },
  { value: "contains", label: "Contains" },
  { value: "not_contains", label: "Does not contain" },
  { value: "exists", label: "Exists" },
  { value: "not_exists", label: "Does not exist" },
  { value: "gt", label: "Greater than" },
  { value: "gte", label: "Greater than or equal" },
  { value: "lt", label: "Less than" },
  { value: "lte", label: "Less than or equal" },
];

export function MonitorFormFields({ form, setForm, editingMonitor, httpMethods, intervalOptions }: Props) {
  const [activeSection, setActiveSection] = useState<"general" | "request" | "validation" | "security">("general");
  const update = <K extends keyof MonitorFormState>(key: K, value: MonitorFormState[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
  };
  const methodHasBody = !["GET", "HEAD", "OPTIONS"].includes(form.http_method);
  const secretHint = (configured: boolean, noun: string) => configured
    ? `${noun} is configured. Leave this blank to keep the stored value.`
    : undefined;

  const sections = [
    { id: "general" as const, label: "General" },
    { id: "request" as const, label: "Request" },
    { id: "validation" as const, label: "Validation" },
    { id: "security" as const, label: "Security" },
  ];

  return <div className="monitor-form-shell">
    <div className="monitor-form-intro">
      <div className="monitor-form-intro-icon"><Globe2 size={21} /></div>
      <div>
        <strong>{editingMonitor ? "Configure endpoint monitor" : "Create an endpoint monitor"}</strong>
        <span>Start with the target, then add only the request and validation options this endpoint needs.</span>
      </div>
      <span className={`nm-pill ${form.enabled ? "monitor-form-state--enabled" : "monitor-form-state--paused"}`}>{form.enabled ? "Enabled" : "Paused"}</span>
    </div>
    <div className="monitor-form-tabbed-window">
      <nav className="mon-panel-tabs monitor-form-nav" role="tablist" aria-label="Monitor settings sections">
        {sections.map(({ id, label }) => <button
          key={id}
          type="button"
          role="tab"
          aria-selected={activeSection === id}
          className={`mon-panel-tab monitor-form-nav-item${activeSection === id ? " active" : ""}`}
          onClick={() => setActiveSection(id)}
        >
          {label}
        </button>)}
      </nav>
      <div className="monitor-form-window">
        <div className={`monitor-form-sections monitor-form-sections--${activeSection}`}>
    {activeSection === "general" && <>
    <section className="monitor-form-section">
      <div className="monitor-form-section-title">Endpoint</div>
      <div className="nm-form-row monitor-form-row--name-method">
        <label>Name
          <input className="nm-input" maxLength={120} value={form.name} onChange={(event) => update("name", event.target.value)} placeholder="e.g. Company website" autoFocus />
        </label>
        <label>Method
          <select className="nm-select" value={form.http_method} onChange={(event) => update("http_method", event.target.value as HttpMethod)}>
            {httpMethods.map((method) => <option key={method} value={method}>{method}</option>)}
          </select>
        </label>
      </div>
      <label>URL
        <input className="nm-input" maxLength={2048} value={form.url} onChange={(event) => update("url", event.target.value)} placeholder="https://example.com/health" />
      </label>
      <div className="nm-form-row">
        <label>Description
          <input className="nm-input" maxLength={4000} value={form.description} onChange={(event) => update("description", event.target.value)} placeholder="What this endpoint checks" />
        </label>
        <label>Tags
          <input className="nm-input" value={form.tags_text} onChange={(event) => update("tags_text", event.target.value)} placeholder="production, public, api" />
        </label>
      </div>
    </section>

    <section className="monitor-form-section">
      <div className="monitor-form-section-title">Schedule and failure handling</div>
      <div className={`nm-form-row ${form.max_retries > 0 ? "monitor-form-row--four" : "monitor-form-row--three"}`}>
        <label>Check interval
          <select className="nm-select" value={form.check_interval_seconds} onChange={(event) => update("check_interval_seconds", Number(event.target.value))}>
            {intervalOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </label>
        <label>Timeout (seconds)
          <input className="nm-input" type="number" min={1} max={60} value={form.timeout_seconds} onChange={(event) => update("timeout_seconds", Number(event.target.value))} />
        </label>
        <label>Retries before down
          <input className="nm-input" type="number" min={0} max={10} value={form.max_retries} onChange={(event) => update("max_retries", Number(event.target.value))} />
        </label>
        {form.max_retries > 0 && <label>Retry interval (seconds)
          <input className="nm-input" type="number" min={5} max={86400} value={form.retry_interval_seconds} onChange={(event) => update("retry_interval_seconds", Number(event.target.value))} />
        </label>}
      </div>
      <div className="monitor-form-check-grid">
        <Check label="Enabled" checked={form.enabled} onChange={(value) => update("enabled", value)} />
      </div>
    </section>
    </>}

    {activeSection === "request" &&
    <section className="monitor-form-section">
      <div className="monitor-form-section-title">Request</div>
      {methodHasBody && <>
        <label>Body encoding
          <select className="nm-select" value={form.body_encoding} onChange={(event) => update("body_encoding", event.target.value as MonitorBodyEncoding)}>
            <option value="json">JSON</option><option value="form">Form URL encoded (JSON object)</option><option value="text">Plain text</option><option value="xml">XML</option>
          </select>
        </label>
        <label>Request body
          <textarea className="nm-input monitor-form-textarea" value={form.request_body} onChange={(event) => update("request_body", event.target.value)} placeholder={editingMonitor?.has_request_body ? "Leave blank to keep the stored body" : form.body_encoding === "form" ? '{"key":"value"}' : "Request payload"} />
          {editingMonitor?.has_request_body && <span className="tool-note tool-note--hint">{secretHint(true, "A request body")}</span>}
        </label>
      </>}
      <label>Custom headers (JSON)
        <textarea className="nm-input monitor-form-textarea" value={form.request_headers_text} onChange={(event) => update("request_headers_text", event.target.value)} placeholder={editingMonitor?.has_request_headers ? "Leave blank to keep stored headers" : '{"X-Health-Key":"value"}'} />
        {editingMonitor?.has_request_headers && <span className="tool-note tool-note--hint">{secretHint(true, "Custom headers")}</span>}
      </label>
      <Check label="Add a cache-busting query parameter" checked={form.cache_bust} onChange={(value) => update("cache_bust", value)} />
    </section>}

    {activeSection === "security" && <>
    <section className="monitor-form-section">
      <div className="monitor-form-section-title">Authentication</div>
      <label>Authentication type
        <select className="nm-select" value={form.auth_type} onChange={(event) => update("auth_type", event.target.value as MonitorAuthType)}>
          <option value="none">None</option><option value="basic">HTTP Basic</option><option value="bearer">Bearer token</option><option value="oauth2">OAuth2 client credentials</option><option value="mtls">Mutual TLS</option>
        </select>
      </label>
      {form.auth_type === "basic" && <div className="nm-form-row">
        <label>Username<input className="nm-input" value={form.auth_username} onChange={(event) => update("auth_username", event.target.value)} /></label>
        <SecretField label="Password" value={form.auth_password} onChange={(value) => update("auth_password", value)} configured={editingMonitor?.has_auth_password} />
      </div>}
      {form.auth_type === "bearer" && <SecretField label="Bearer token" value={form.bearer_token} onChange={(value) => update("bearer_token", value)} configured={editingMonitor?.has_bearer_token} />}
      {form.auth_type === "oauth2" && <>
        <label>Token URL<input className="nm-input" value={form.oauth_token_url} onChange={(event) => update("oauth_token_url", event.target.value)} placeholder="https://identity.example.com/oauth/token" /></label>
        <div className="nm-form-row">
          <label>Client ID<input className="nm-input" value={form.oauth_client_id} onChange={(event) => update("oauth_client_id", event.target.value)} /></label>
          <SecretField label="Client secret" value={form.oauth_client_secret} onChange={(value) => update("oauth_client_secret", value)} configured={editingMonitor?.has_oauth_client_secret} />
        </div>
        <div className="nm-form-row">
          <label>Client authentication
            <select className="nm-select" value={form.oauth_auth_method} onChange={(event) => update("oauth_auth_method", event.target.value as MonitorOauthAuthMethod)}>
              <option value="client_secret_basic">HTTP Basic</option><option value="client_secret_post">Request body</option>
            </select>
          </label>
          <label>Scopes<input className="nm-input" value={form.oauth_scopes} onChange={(event) => update("oauth_scopes", event.target.value)} placeholder="read:health" /></label>
        </div>
        <label>Audience<input className="nm-input" value={form.oauth_audience} onChange={(event) => update("oauth_audience", event.target.value)} /></label>
      </>}
      {form.auth_type === "mtls" && <div className="monitor-form-pem-grid">
        <PemField label="Client certificate (PEM)" value={form.tls_cert} onChange={(value) => update("tls_cert", value)} configured={editingMonitor?.has_tls_cert} />
        <PemField label="Private key (PEM)" value={form.tls_key} onChange={(value) => update("tls_key", value)} configured={editingMonitor?.has_tls_key} />
      </div>}
    </section>

    <section className="monitor-form-section">
      <div className="monitor-form-section-title">TLS, redirects and proxy</div>
      <div className="monitor-form-check-grid">
        <Check label="Verify TLS certificate" checked={form.verify_tls} onChange={(value) => update("verify_tls", value)} />
        <Check label="Follow redirects" checked={form.follow_redirects} onChange={(value) => update("follow_redirects", value)} />
        <Check label="Certificate expiry warning" checked={form.certificate_expiry_alert} onChange={(value) => update("certificate_expiry_alert", value)} />
      </div>
      <div className="nm-form-row">
        {form.follow_redirects && <label>Maximum redirects<input className="nm-input" type="number" min={0} max={20} value={form.max_redirects} onChange={(event) => update("max_redirects", Number(event.target.value))} /></label>}
        {form.certificate_expiry_alert && <label>Warn within (days)<input className="nm-input" type="number" min={1} max={365} value={form.certificate_expiry_days} onChange={(event) => update("certificate_expiry_days", Number(event.target.value))} /></label>}
      </div>
      <SecretField label="Proxy URL" value={form.proxy_url} onChange={(value) => update("proxy_url", value)} configured={editingMonitor?.has_proxy_url} placeholder="http://user:password@proxy.example.com:8080" />
      <PemField label="Custom CA certificate (PEM)" value={form.tls_ca} onChange={(value) => update("tls_ca", value)} configured={editingMonitor?.has_tls_ca} />
    </section>
    </>}

    {activeSection === "validation" &&
    <section className="monitor-form-section">
      <div className="monitor-form-section-title">Response assertions</div>
      <div className="nm-form-row">
        <label>Accepted status codes
          <input className="nm-input" value={form.accepted_status_codes} onChange={(event) => update("accepted_status_codes", event.target.value)} placeholder="200-299,301,304" />
          <span className="tool-note tool-note--hint">Comma-separated codes or ranges.</span>
        </label>
        <div className="monitor-form-option-cell">
          <Check label="Invert the final monitor result" checked={form.upside_down} onChange={(value) => update("upside_down", value)} />
        </div>
      </div>
      <label>Required keyword
        <input className="nm-input" value={form.keyword} onChange={(event) => update("keyword", event.target.value)} placeholder="healthy" />
      </label>
      {form.keyword && <Check label="Fail when the keyword is present" checked={form.keyword_inverted} onChange={(value) => update("keyword_inverted", value)} />}
      <div className="nm-form-row monitor-form-row--three">
        <label>JSON path<input className="nm-input" value={form.json_path} onChange={(event) => update("json_path", event.target.value)} placeholder="$.status" /></label>
        <label>Operator
          <select className="nm-select" value={form.json_operator} onChange={(event) => update("json_operator", event.target.value as MonitorJsonOperator)}>
            {JSON_OPERATORS.map((operator) => <option key={operator.value} value={operator.value}>{operator.label}</option>)}
          </select>
        </label>
        {!(["exists", "not_exists"] as MonitorJsonOperator[]).includes(form.json_operator) && <label>Expected value<input className="nm-input" value={form.expected_value} onChange={(event) => update("expected_value", event.target.value)} /></label>}
      </div>
    </section>}
        </div>
      </div>
    </div>
  </div>;
}

function Check({ label, checked, onChange }: { label: string; checked: boolean; onChange: (value: boolean) => void }) {
  return <label className="tool-form-inline-check"><input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />{label}</label>;
}

function SecretField({ label, value, onChange, configured, placeholder }: { label: string; value: string; onChange: (value: string) => void; configured?: boolean; placeholder?: string }) {
  return <label>{label}
    <input className="nm-input" type="password" autoComplete="new-password" value={value} onChange={(event) => onChange(event.target.value)} placeholder={configured ? "Leave blank to keep stored value" : placeholder} />
    {configured && <span className="tool-note tool-note--hint">A value is configured. Leave blank to keep it.</span>}
  </label>;
}

function PemField({ label, value, onChange, configured }: { label: string; value: string; onChange: (value: string) => void; configured?: boolean }) {
  return <label>{label}
    <textarea className="nm-input monitor-form-textarea monitor-form-textarea--pem" value={value} onChange={(event) => onChange(event.target.value)} placeholder={configured ? "Leave blank to keep stored value" : "-----BEGIN ...-----"} />
    {configured && <span className="tool-note tool-note--hint">A value is configured. Leave blank to keep it.</span>}
  </label>;
}
