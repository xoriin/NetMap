export type UserRole = "SuperAdmin" | "NetworkAdmin" | "SecurityAnalyst" | "Viewer";

export type User = {
  id: number;
  username: string;
  role: string;
  is_active: boolean;
  display_name: string | null;
  avatar_data: string | null;
  email: string | null;
};

export type TokenPair = {
  access_token: string;
  token_type: "bearer";
};

export type DashboardSummary = {
  user_count: number;
  device_count: number;
  group_count: number;
  relationship_count: number;
};

export type DeviceStatus = "online" | "offline" | "warning" | "unknown" | "disabled";
export type DeviceIcon = string;

export type Device = {
  id: number;
  display_name: string | null;
  hostname: string | null;
  ip_address: string;
  mac_address: string | null;
  vendor: string | null;
  device_type: string | null;
  status: DeviceStatus;
  monitor_status: DeviceStatus | null;
  last_monitored_at: string | null;
  is_favourite: boolean;
  icon: DeviceIcon;
  color: string | null;
  vlan_id: string | null;
  subnet: string | null;
  topology_group_id: number | null;
  topology_group: string;
  site_id: number | null;
  tags: string[];
  notes: string | null;
  created_at: string;
  updated_at: string;
};

export type Site = {
  id: number;
  name: string;
  display_name: string | null;
  description: string | null;
  address: string | null;
  color: string | null;
  created_at: string;
  updated_at: string;
};

export type DevicePayload = {
  display_name: string | null;
  hostname: string | null;
  ip_address: string | null;
  mac_address: string | null;
  vendor: string | null;
  device_type: string | null;
  status: DeviceStatus;
  icon: DeviceIcon;
  color: string | null;
  vlan_id: string | null;
  subnet: string | null;
  topology_group_id: number | null;
  topology_group: string | null;
  site_id: number | null;
  tags: string[];
  notes: string | null;
};

export type Relationship = {
  id: number;
  source_device_id: number;
  target_device_id: number;
  relationship_type: string;
  allow_outbound: boolean;
  allow_inbound: boolean;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

export type RelationshipPayload = {
  source_device_id: number;
  target_device_id: number;
  relationship_type: string;
  allow_outbound: boolean;
  allow_inbound: boolean;
  notes: string | null;
};

export type TopologyGraph = {
  devices: Device[];
  relationships: Relationship[];
};

export type DeviceLiveStatus = {
  device_id: number;
  status: DeviceStatus;
  latency_ms: number | null;
  last_checked_at: string;
  error: string | null;
};

export type DeviceLiveStatusList = {
  statuses: DeviceLiveStatus[];
};

export type LayoutPosition = {
  x: number;
  y: number;
};

export type TopologyLayout = {
  id: number;
  owner_user_id: number;
  name: string;
  positions: Record<string, LayoutPosition>;
  created_at: string;
  updated_at: string;
};

export type TopologyGroup = {
  id: number;
  name: string;
  display_name: string | null;
  vlan_id: string | null;
  ip_range: string | null;
  gateway: string | null;
  dhcp_start: string | null;
  dhcp_end: string | null;
  dns_servers: string | null;
  description: string | null;
  created_at: string;
  updated_at: string;
};

export type DiscoveryScanType = "ping" | "basic_ports";

export type DiscoveryHost = {
  ip_address: string;
  hostname: string | null;
  mac_address: string | null;
  vendor: string | null;
  status: string;
  open_ports: number[];
};

export type DiscoveryScan = {
  id: number;
  target: string;
  scan_type: string;
  status: string;
  host_count: number;
  result_count: number;
  results: DiscoveryHost[];
  error: string | null;
  created_at: string;
  completed_at: string | null;
};

export type DiscoveryImportResult = {
  created: number;
  updated: number;
};

export type FirewallEvent = {
  id: number;
  received_at: string;
  event_time: string | null;
  source_host: string | null;
  src_ip: string | null;
  dst_ip: string | null;
  src_port: number | null;
  dst_port: number | null;
  protocol: string | null;
  action: string | null;
  interface: string | null;
  direction: string | null;
  rule_id: string | null;
  tracker_id: string | null;
  reason: string | null;
  raw_log: string;
};

export type CorrelatedFirewallEvent = {
  id: number;
  received_at: string;
  event_time: string | null;
  src_ip: string | null;
  dst_ip: string | null;
  src_port: number | null;
  dst_port: number | null;
  protocol: string | null;
  action: string | null;
  interface: string | null;
  direction: string | null;
  rule_id: string | null;
  reason: string | null;
  relation: "source" | "destination" | "both" | "unknown";
};

export type DeviceSecurityEventSummary = {
  device_id: number;
  window_hours: number;
  blocked_count: number;
  passed_count: number;
  total_count: number;
  last_seen_event_time: string | null;
  events: CorrelatedFirewallEvent[];
};

export type DeviceEventCount = {
  device_id: number;
  ip_address: string;
  hostname: string | null;
  event_count: number;
  blocked_count: number;
  passed_count: number;
  last_seen_event_time: string | null;
};

export type DeviceEventCountList = {
  window_hours: number;
  devices: DeviceEventCount[];
};

export type FirewallEventList = {
  retention_days: number;
  total: number;
  offset: number;
  limit: number;
  events: FirewallEvent[];
};

export type FirewallEventSearchParams = {
  q?: string;
  src_ip?: string;
  dst_ip?: string;
  src_port?: number | "";
  dst_port?: number | "";
  action?: string;
  protocol?: string;
  interface?: string;
  start_time?: string;
  end_time?: string;
  limit?: number;
  offset?: number;
  sort_by?: string;
  sort_dir?: "asc" | "desc";
};

export type SyslogStatus = {
  enabled: boolean;
  udp_enabled: boolean;
  tcp_enabled: boolean;
  tls_enabled: boolean;
  udp_port: number;
  tcp_port: number;
  tls_port: number;
  retention_days: number;
  allowlist_enabled: boolean;
  total_events: number;
  retention_last_run_at: string | null;
  retention_last_deleted: number;
  retention_last_error: string | null;
  last_event_received_at: string | null;
};

export type DnsRecordType = "A" | "AAAA" | "MX" | "TXT" | "NS" | "CNAME";

export type DnsRecord = {
  value: string;
};

export type DnsLookupResult = {
  queried_name: string;
  record_type: DnsRecordType;
  records: DnsRecord[];
  source: string;
  duration_ms: number;
};

export type ReverseDnsResult = {
  ip_address: string;
  ptr_records: string[];
  source: string;
  duration_ms: number;
};

export type PingResult = {
  host: string;
  transmitted: number | null;
  received: number | null;
  packet_loss: number | null;
  average_ms: number | null;
  min_ms: number | null;
  max_ms: number | null;
  raw_output: string;
  duration_ms: number;
};

export type TracerouteHop = {
  hop: number;
  address: string | null;
  host: string | null;
  rtt_ms: number | null;
};

export type TracerouteResult = {
  host: string;
  hops: TracerouteHop[];
  raw_output: string;
  duration_ms: number;
};

export type TcpPortCheckResult = {
  host: string;
  port: number;
  reachable: boolean;
  duration_ms: number;
  detail: string;
};

export type SubnetCalculatorResult = {
  cidr: string;
  network: string;
  netmask: string;
  broadcast: string | null;
  first_host: string | null;
  last_host: string | null;
  total_addresses: number;
  usable_hosts: number;
  version: number;
  prefix_length: number;
  calculated_at: string;
};

export type AuditLog = {
  id: number;
  created_at: string;
  action: string;
  actor_user_id: number | null;
  target: string | null;
  detail: string | null;
};

export type AuditLogList = {
  total: number;
  limit: number;
  offset: number;
  records: AuditLog[];
};

export type SystemSettings = {
  app_name: string;
  login_message: string;
  announcement: string;
  live_ping_enabled: boolean;
  idle_timeout_minutes: number;
  active_network_public_targets_enabled: boolean;
};

export type PermissionMeta = {
  key: string;
  label: string;
  description: string;
};

export type RolePermissions = {
  permissions: PermissionMeta[];
  roles: Record<string, string[]>; // role → granted permission keys
};

export type NotificationSettings = {
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
  smtp_tls: string;
};

export type AlertRuleEventType = "device_offline" | "device_online" | "device_warning" | "any_status_change";

export type AlertRule = {
  id: number;
  name: string;
  enabled: boolean;
  event_type: AlertRuleEventType;
  device_id: number | null;
  channels: string[];
  cooldown_minutes: number;
  last_triggered_at: string | null;
  created_at: string;
  updated_at: string;
};

export type AlertRulePayload = {
  name: string;
  enabled: boolean;
  event_type: AlertRuleEventType;
  device_id: number | null;
  channels: string[];
  cooldown_minutes: number;
};

export type AlertEvent = {
  id: number;
  alert_rule_id: number | null;
  alert_rule_name: string;
  device_id: number | null;
  event_type: string;
  fired_at: string;
  message: string;
};

export type PortResult = {
  port: number;
  label: string;
  open: boolean;
};

export type MonitorHistoryPoint = {
  id: number;
  checked_at: string;
  status: string;
  rtt_ms: number | null;
  port_results: PortResult[];
};

export type DeviceMonitorSummary = {
  device_id: number;
  display_name: string | null;
  hostname: string | null;
  ip_address: string;
  status: string;
  topology_group: string | null;
  site_id: number | null;
  site_name: string | null;
  vlan_id: string | null;
  last_checked: string | null;
  uptime_24h: number | null;
  uptime_7d: number | null;
  avg_rtt_24h: number | null;
  latest_port_results: PortResult[];
  heartbeat: string[];
  is_favourite: boolean;
};

export type FleetSummary = {
  total: number;
  online: number;
  offline: number;
  unknown: number;
  avg_rtt_ms: number | null;
  last_checked: string | null;
};

export type PortTarget = {
  id: number;
  device_id: number | null;
  port: number;
  label: string;
  created_at: string;
};

export type DeviceAnalysis = {
  device_id: number;
  baseline_rtt_ms: number | null;
  rtt_stddev: number | null;
  rtt_p50: number | null;
  rtt_p95: number | null;
  current_rtt_ms: number | null;
  anomaly_score: number | null;
  anomaly_level: "normal" | "elevated" | "anomalous" | "insufficient_data";
  trend: "rising" | "falling" | "stable" | "insufficient_data";
  trend_pct: number | null;
  flap_count_24h: number;
  longest_outage_minutes: number | null;
};

export type IpamSubnet = {
  id: number;
  name: string;
  cidr: string;
  description: string | null;
  vlan_id: string | null;
  site_id: number | null;
  gateway: string | null;
  dhcp_start: string | null;
  dhcp_end: string | null;
  dns_servers: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  total_hosts: number;
  used: number;
  free: number;
  utilization: number;
  device_count: number;
  dhcp_count: number;
  reservation_count: number;
};

export type IpAddressEntry = {
  ip: string;
  kind: "network" | "broadcast" | "gateway" | "device" | "dhcp" | "reserved" | "free";
  label: string | null;
  mac_address: string | null;
  vendor: string | null;
  dhcp_range: boolean;
};

export type IpamConflict = {
  type: string;
  severity: "error" | "warning";
  description: string;
  ip: string | null;
  device_id: number | null;
};

export type IpamSummary = {
  subnet_count: number;
  total_hosts: number;
  used: number;
  free: number;
  utilization: number;
  conflict_count: number;
  dhcp_lease_count: number;
  reservation_count: number;
};

export type IpReservation = {
  id: number;
  ip_address: string;
  subnet_id: number | null;
  label: string;
  mac_address: string | null;
  notes: string | null;
  reserved_by: string | null;
  created_at: string;
  updated_at: string;
};

export type IpReservationPayload = {
  ip_address: string;
  subnet_id?: number | null;
  label: string;
  mac_address?: string | null;
  notes?: string | null;
};

export type DhcpLease = {
  id: number;
  ip_address: string;
  mac_address: string | null;
  hostname: string | null;
  expires_at: string | null;
  is_active: boolean;
  source: string;
  imported_at: string;
};

export type SubnetPayload = {
  name: string;
  cidr: string;
  description?: string | null;
  vlan_id?: string | null;
  site_id?: number | null;
  gateway?: string | null;
  dhcp_start?: string | null;
  dhcp_end?: string | null;
  dns_servers?: string | null;
  notes?: string | null;
};

export type VlanSuggestion = {
  id: number;
  name: string;
  display_name: string | null;
  vlan_id: string | null;
  ip_range: string;
  gateway: string | null;
  dns_servers: string | null;
  already_imported: boolean;
};

export type VersionInfo = {
  current: string;
  latest: string | null;
  up_to_date: boolean;
  release_url: string;
};

type RequestOptions = RequestInit & {
  token?: string | null;
};

// Deduplicate concurrent refresh calls (e.g. React StrictMode double-invocation)
// so a single in-flight token rotation isn't hit twice with the same revocable token.
let _pendingRefresh: Promise<TokenPair> | null = null;

export type DownloadResult = {
  blob: Blob;
  filename: string;
};

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers = new Headers(options.headers);
  if (!headers.has("Content-Type") && options.body !== undefined) {
    headers.set("Content-Type", "application/json");
  }
  if (options.token) {
    headers.set("Authorization", `Bearer ${options.token}`);
  }
  addCsrfHeader(headers, options.method);

  const response = await fetch(path, {
    ...options,
    credentials: "include",
    headers,
  });

  if (!response.ok) {
    const status = response.status;
    let message = `HTTP ${status}`;
    try {
      const errorBody = (await response.json()) as { detail?: unknown };
      const detail = errorBody.detail;
      if (typeof detail === "string") {
        message = `${detail} [${status}]`;
      } else if (Array.isArray(detail) && detail.length > 0) {
        // FastAPI validation error: detail is an array of {loc, msg, type} objects
        const msgs = detail
          .map((e) => (e && typeof e === "object" && "msg" in e ? String(e.msg) : String(e)))
          .join("; ");
        message = `${msgs} [${status}]`;
      }
    } catch {
      message = `HTTP ${status}: ${response.statusText || "Unknown error"}`;
    }
    throw new Error(message);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return response.json() as Promise<T>;
}

async function requestBlob(path: string, options: RequestOptions = {}): Promise<DownloadResult> {
  const headers = new Headers(options.headers);
  if (options.token) {
    headers.set("Authorization", `Bearer ${options.token}`);
  }
  addCsrfHeader(headers, options.method);

  const response = await fetch(path, {
    ...options,
    credentials: "include",
    headers,
  });

  if (!response.ok) {
    const status = response.status;
    let message = `HTTP ${status}`;
    try {
      const errorBody = (await response.json()) as { detail?: unknown };
      const detail = errorBody.detail;
      if (typeof detail === "string") {
        message = `${detail} [${status}]`;
      } else if (Array.isArray(detail) && detail.length > 0) {
        // FastAPI validation error: detail is an array of {loc, msg, type} objects
        const msgs = detail
          .map((e) => (e && typeof e === "object" && "msg" in e ? String(e.msg) : String(e)))
          .join("; ");
        message = `${msgs} [${status}]`;
      }
    } catch {
      message = `HTTP ${status}: ${response.statusText || "Unknown error"}`;
    }
    throw new Error(message);
  }

  const disposition = response.headers.get("Content-Disposition") ?? "";
  const filenameMatch = disposition.match(/filename=\"?([^"]+)\"?/i);
  return {
    blob: await response.blob(),
    filename: filenameMatch?.[1] ?? "download.bin",
  };
}

function addCsrfHeader(headers: Headers, method?: string) {
  const requestMethod = (method ?? "GET").toUpperCase();
  if (["GET", "HEAD", "OPTIONS", "TRACE"].includes(requestMethod) || headers.has("X-CSRF-Token")) {
    return;
  }
  const token = readCookie("netmap_csrf");
  if (token) {
    headers.set("X-CSRF-Token", token);
  }
}

function readCookie(name: string): string | null {
  const prefix = `${name}=`;
  for (const part of document.cookie.split(";")) {
    const candidate = part.trim();
    if (candidate.startsWith(prefix)) {
      return decodeURIComponent(candidate.slice(prefix.length));
    }
  }
  return null;
}

export const api = {
  setupStatus: () => request<{ needs_setup: boolean }>("/api/v1/setup/status"),
  createAdmin: (username: string, password: string) =>
    request<User>("/api/v1/setup/admin", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    }),
  login: (username: string, password: string) =>
    request<TokenPair>("/api/v1/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    }),
  refresh: () => {
    if (!_pendingRefresh) {
      _pendingRefresh = request<TokenPair>("/api/v1/auth/refresh", {
        method: "POST",
        body: JSON.stringify({}),
      }).finally(() => { _pendingRefresh = null; });
    }
    return _pendingRefresh;
  },
  logout: (token?: string | null) =>
    request<void>("/api/v1/auth/logout", {
      method: "POST",
      token: token ?? null,
      body: JSON.stringify({}),
    }),
  me: (token: string) => request<User>("/api/v1/auth/me", { token }),
  updateProfile: (token: string, payload: { display_name?: string | null; avatar_data?: string | null; email?: string | null }) =>
    request<User>("/api/v1/auth/me", {
      method: "PATCH",
      token,
      body: JSON.stringify(payload),
    }),
  changePassword: (token: string, currentPassword: string, newPassword: string) =>
    request<void>("/api/v1/auth/change-password", {
      method: "POST",
      token,
      body: JSON.stringify({ current_password: currentPassword, new_password: newPassword }),
    }),
  listUsers: (token: string) => request<User[]>("/api/v1/auth/users", { token }),
  createUser: (
    token: string,
    payload: { username: string; password: string; role: string; is_active: boolean; email?: string },
  ) =>
    request<User>("/api/v1/auth/users", {
      method: "POST",
      token,
      body: JSON.stringify(payload),
    }),
  updateUser: (
    token: string,
    userId: number,
    payload: { role?: string; is_active?: boolean; email?: string | null; avatar_data?: string | null },
  ) =>
    request<User>(`/api/v1/auth/users/${userId}`, {
      method: "PATCH",
      token,
      body: JSON.stringify(payload),
    }),
  dashboardSummary: (token: string) =>
    request<DashboardSummary>("/api/v1/dashboard/summary", { token }),
  topologyGraph: (token: string) => request<TopologyGraph>("/api/v1/topology/graph", { token, cache: "no-store" }),
  topologyLiveStatuses: (
    token: string,
    payload: { device_ids: number[]; timeout_seconds: number },
  ) =>
    request<DeviceLiveStatusList>("/api/v1/topology/devices/live-status", {
      method: "POST",
      token,
      body: JSON.stringify(payload),
    }),
  topologyLayouts: (token: string) => request<TopologyLayout[]>("/api/v1/topology/layouts", { token }),
  topologyGroups: (token: string) => request<TopologyGroup[]>("/api/v1/topology/groups", { token }),
  sites: (token: string) => request<Site[]>("/api/v1/topology/sites", { token, cache: "no-store" }),
  createSite: (
    token: string,
    payload: { name: string; display_name: string | null; description: string | null; address: string | null; color: string | null },
  ) =>
    request<Site>("/api/v1/topology/sites", {
      method: "POST",
      token,
      body: JSON.stringify(payload),
    }),
  updateSite: (
    token: string,
    siteId: number,
    payload: Partial<{ name: string; display_name: string | null; description: string | null; address: string | null; color: string | null }>,
  ) =>
    request<Site>(`/api/v1/topology/sites/${siteId}`, {
      method: "PATCH",
      token,
      body: JSON.stringify(payload),
    }),
  deleteSite: (token: string, siteId: number) =>
    request<void>(`/api/v1/topology/sites/${siteId}`, { method: "DELETE", token }),
  createTopologyGroup: (
    token: string,
    payload: { name: string; display_name: string | null; vlan_id?: string | null; ip_range: string | null; gateway?: string | null; dhcp_start?: string | null; dhcp_end?: string | null; dns_servers?: string | null; description: string | null },
  ) =>
    request<TopologyGroup>("/api/v1/topology/groups", {
      method: "POST",
      token,
      body: JSON.stringify(payload),
    }),
  updateTopologyGroup: (
    token: string,
    groupId: number,
    payload: Partial<{ name: string; display_name: string | null; vlan_id: string | null; ip_range: string | null; gateway: string | null; dhcp_start: string | null; dhcp_end: string | null; dns_servers: string | null; description: string | null }>,
  ) =>
    request<TopologyGroup>(`/api/v1/topology/groups/${groupId}`, {
      method: "PATCH",
      token,
      body: JSON.stringify(payload),
    }),
  deleteTopologyGroup: (token: string, groupId: number) =>
    request<void>(`/api/v1/topology/groups/${groupId}`, {
      method: "DELETE",
      token,
    }),
  bulkUpdateDeviceGroup: (
    token: string,
    payload: { device_ids: number[]; topology_group_id?: number | null; topology_group?: string | null },
  ) =>
    request<{ updated: number }>("/api/v1/topology/devices/bulk-update", {
      method: "POST",
      token,
      body: JSON.stringify(payload),
    }),
  resetGroupAssignments: (token: string) =>
    request<{ updated: number }>("/api/v1/topology/groups/reset-device-assignments", {
      method: "POST",
      token,
    }),
  saveTopologyLayout: (
    token: string,
    payload: { name: string; positions: Record<string, LayoutPosition> },
  ) =>
    request<TopologyLayout>("/api/v1/topology/layouts", {
      method: "POST",
      token,
      body: JSON.stringify(payload),
    }),
  deleteTopologyLayout: (token: string, layoutId: number) =>
    request<void>(`/api/v1/topology/layouts/${layoutId}`, {
      method: "DELETE",
      token,
    }),
  createDevice: (token: string, payload: DevicePayload) =>
    request<Device>("/api/v1/topology/devices", {
      method: "POST",
      token,
      body: JSON.stringify(payload),
    }),
  updateDevice: (token: string, id: number, payload: Partial<DevicePayload>) =>
    request<Device>(`/api/v1/topology/devices/${id}`, {
      method: "PATCH",
      token,
      body: JSON.stringify(payload),
    }),
  toggleFavourite: (token: string, id: number) =>
    request<Device>(`/api/v1/topology/devices/${id}/favourite`, {
      method: "PATCH",
      token,
    }),
  deleteDevice: (token: string, id: number) =>
    request<void>(`/api/v1/topology/devices/${id}`, {
      method: "DELETE",
      token,
    }),
  createRelationship: (token: string, payload: RelationshipPayload) =>
    request<Relationship>("/api/v1/topology/relationships", {
      method: "POST",
      token,
      body: JSON.stringify(payload),
    }),
  updateRelationship: (token: string, id: number, payload: Partial<RelationshipPayload>) =>
    request<Relationship>(`/api/v1/topology/relationships/${id}`, {
      method: "PATCH",
      token,
      body: JSON.stringify(payload),
    }),
  deleteRelationship: (token: string, id: number) =>
    request<void>(`/api/v1/topology/relationships/${id}`, {
      method: "DELETE",
      token,
    }),
  startDiscoveryScan: (
    token: string,
    payload: { target: string; scan_type: DiscoveryScanType; confirm_large_scan: boolean },
  ) =>
    request<DiscoveryScan>("/api/v1/discovery/scans", {
      method: "POST",
      token,
      body: JSON.stringify(payload),
    }),
  importDiscoveryResults: (token: string, scanId: number, ipAddresses: string[], topologyGroupId?: number | null, siteId?: number | null) =>
    request<DiscoveryImportResult>("/api/v1/discovery/import", {
      method: "POST",
      token,
      body: JSON.stringify({ scan_id: scanId, ip_addresses: ipAddresses, topology_group_id: topologyGroupId ?? null, site_id: siteId ?? null }),
    }),
  syslogStatus: (token: string) => request<SyslogStatus>("/api/v1/syslog/status", { token }),
  firewallEvents: (token: string, params: FirewallEventSearchParams = {}) => {
    const search = new URLSearchParams();
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== "") {
        search.set(key, String(value));
      }
    });
    const query = search.toString();
    return request<FirewallEventList>(`/api/v1/syslog/events${query ? `?${query}` : ""}`, {
      token,
    });
  },
  deviceSecurityEvents: (
    token: string,
    deviceId: number,
    params: { window_hours?: number; limit?: number } = {},
  ) => {
    const search = new URLSearchParams();
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null && !(typeof value === "string" && value === "")) {
        search.set(key, String(value));
      }
    });
    const query = search.toString();
    return request<DeviceSecurityEventSummary>(
      `/api/v1/topology/devices/${deviceId}/security-events${query ? `?${query}` : ""}`,
      { token },
    );
  },
  topologyDeviceEventCounts: (
    token: string,
    params: { window_hours?: number; with_events_only?: boolean } = {},
  ) => {
    const search = new URLSearchParams();
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null && !(typeof value === "string" && value === "")) {
        search.set(key, String(value));
      }
    });
    const query = search.toString();
    return request<DeviceEventCountList>(`/api/v1/topology/security/event-counts${query ? `?${query}` : ""}`, {
      token,
    });
  },
  topAffectedDevices: (token: string, params: { window_hours?: number; limit?: number } = {}) => {
    const search = new URLSearchParams();
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null && !(typeof value === "string" && value === "")) {
        search.set(key, String(value));
      }
    });
    const query = search.toString();
    return request<DeviceEventCountList>(`/api/v1/topology/security/top-affected${query ? `?${query}` : ""}`, {
      token,
    });
  },
  dnsLookup: (token: string, payload: { name: string; record_type: DnsRecordType }) =>
    request<DnsLookupResult>("/api/v1/tools/dns", {
      method: "POST",
      token,
      body: JSON.stringify(payload),
    }),
  reverseDns: (token: string, payload: { ip_address: string }) =>
    request<ReverseDnsResult>("/api/v1/tools/reverse-dns", {
      method: "POST",
      token,
      body: JSON.stringify(payload),
    }),
  ping: (token: string, payload: { host: string; count: number; timeout_seconds: number }) =>
    request<PingResult>("/api/v1/tools/ping", {
      method: "POST",
      token,
      body: JSON.stringify(payload),
    }),
  traceroute: (token: string, payload: { host: string; max_hops: number; timeout_seconds: number }) =>
    request<TracerouteResult>("/api/v1/tools/traceroute", {
      method: "POST",
      token,
      body: JSON.stringify(payload),
    }),
  tcpCheck: (token: string, payload: { host: string; port: number; timeout_seconds: number }) =>
    request<TcpPortCheckResult>("/api/v1/tools/tcp-check", {
      method: "POST",
      token,
      body: JSON.stringify(payload),
    }),
  subnetCalculate: (token: string, payload: { cidr: string }) =>
    request<SubnetCalculatorResult>("/api/v1/tools/subnet", {
      method: "POST",
      token,
      body: JSON.stringify(payload),
    }),
  downloadInventory: (token: string, format: "csv" | "json") =>
    requestBlob(`/api/v1/exports/inventory?format=${format}`, { token }),
  downloadFirewallExport: (token: string, params: FirewallEventSearchParams & { format: "csv" | "json"; limit?: number }) => {
    const search = new URLSearchParams();
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== "") {
        search.set(key, String(value));
      }
    });
    return requestBlob(`/api/v1/exports/firewall?${search.toString()}`, { token });
  },
  downloadReport: (token: string) => requestBlob("/api/v1/exports/report.pdf", { token }),
  downloadBackup: (token: string) => requestBlob("/api/v1/exports/backup", { token }),
  restoreBackup: (token: string, payload: Blob) =>
    request<void>("/api/v1/exports/restore", {
      method: "POST",
      token,
      headers: {
        "Content-Type": "application/octet-stream",
      },
      body: payload,
    }),
  adminPublicSettings: () =>
    request<SystemSettings>("/api/v1/admin/settings/public"),
  adminSettings: (token: string) =>
    request<SystemSettings>("/api/v1/admin/settings", { token }),
  updateAdminSettings: (token: string, payload: Partial<SystemSettings>) =>
    request<SystemSettings>("/api/v1/admin/settings", {
      method: "PUT",
      token,
      body: JSON.stringify(payload),
    }),
  getRolePermissions: (token: string) =>
    request<RolePermissions>("/api/v1/admin/role-permissions", { token }),
  updateRolePermissions: (token: string, roles: Record<string, string[]>) =>
    request<RolePermissions>("/api/v1/admin/role-permissions", {
      method: "PUT", token, body: JSON.stringify({ roles }),
    }),
  createRole: (token: string, name: string) =>
    request<RolePermissions>("/api/v1/admin/roles", {
      method: "POST", token, body: JSON.stringify({ name }),
    }),
  deleteRole: (token: string, name: string) =>
    request<RolePermissions>(`/api/v1/admin/roles/${encodeURIComponent(name)}`, {
      method: "DELETE", token,
    }),
  getNotificationSettings: (token: string) =>
    request<NotificationSettings>("/api/v1/admin/notification-settings", { token }),
  updateNotificationSettings: (token: string, payload: Partial<NotificationSettings>) =>
    request<NotificationSettings>("/api/v1/admin/notification-settings", {
      method: "PUT",
      token,
      body: JSON.stringify(payload),
    }),
  testNotification: (token: string, channel: string, message = "NetMap test notification") =>
    request<{ status: string }>("/api/v1/admin/notifications/test", {
      method: "POST",
      token,
      body: JSON.stringify({ channel, message }),
    }),
  listAlertRules: (token: string) =>
    request<AlertRule[]>("/api/v1/alerts/rules", { token }),
  createAlertRule: (token: string, payload: AlertRulePayload) =>
    request<AlertRule>("/api/v1/alerts/rules", { token, method: "POST", body: JSON.stringify(payload) }),
  updateAlertRule: (token: string, id: number, payload: Partial<AlertRulePayload>) =>
    request<AlertRule>(`/api/v1/alerts/rules/${id}`, { token, method: "PATCH", body: JSON.stringify(payload) }),
  deleteAlertRule: (token: string, id: number) =>
    request<void>(`/api/v1/alerts/rules/${id}`, { token, method: "DELETE" }),
  testAlertRule: (token: string, id: number) =>
    request<Record<string, string>>(`/api/v1/alerts/rules/${id}/test`, { token, method: "POST" }),
  listAlertEvents: (token: string, deviceId?: number) =>
    request<AlertEvent[]>(`/api/v1/alerts/events${deviceId !== undefined ? `?device_id=${deviceId}` : ""}`, { token }),
  resetUserPassword: (token: string, userId: number, newPassword: string) =>
    request<void>(`/api/v1/auth/users/${userId}/reset-password`, {
      method: "POST",
      token,
      body: JSON.stringify({ new_password: newPassword }),
    }),
  requestPasswordReset: (usernameOrEmail: string) =>
    request<void>("/api/v1/auth/forgot-password", {
      method: "POST",
      body: JSON.stringify({ username_or_email: usernameOrEmail }),
    }),
  resetPasswordWithToken: (resetToken: string, newPassword: string) =>
    request<void>("/api/v1/auth/reset-password", {
      method: "POST",
      body: JSON.stringify({ reset_token: resetToken, new_password: newPassword }),
    }),
  forceLogoutUser: (token: string, userId: number) =>
    request<void>(`/api/v1/auth/users/${userId}/sessions`, {
      method: "DELETE",
      token,
    }),
  listAuditLogs: (token: string, params: { limit?: number; offset?: number; actor_user_id?: number } = {}) => {
    const search = new URLSearchParams();
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null) search.set(key, String(value));
    });
    const query = search.toString();
    return request<AuditLogList>(`/api/v1/audit/logs${query ? `?${query}` : ""}`, { token });
  },
  importDevices: (token: string, payload: Array<Partial<DevicePayload> & { ip_address: string }>) =>
    request<{ created: number; updated: number; errors: string[] }>("/api/v1/topology/devices/import", {
      method: "POST",
      token,
      body: JSON.stringify({ devices: payload }),
    }),
  // Monitoring
  getMonitoringSummary: (token: string) =>
    request<FleetSummary>("/api/v1/monitoring/summary", { token }),
  listMonitoringDevices: (token: string, changedSince?: string) =>
    request<DeviceMonitorSummary[]>(
      changedSince
        ? `/api/v1/monitoring/devices?changed_since=${encodeURIComponent(changedSince)}`
        : "/api/v1/monitoring/devices",
      { token },
    ),
  getDeviceHistory: (token: string, deviceId: number, hours = 24) =>
    request<MonitorHistoryPoint[]>(`/api/v1/monitoring/devices/${deviceId}/history?hours=${hours}`, { token }),
  getDeviceAnalysis: (token: string, deviceId: number) =>
    request<DeviceAnalysis>(`/api/v1/monitoring/devices/${deviceId}/analysis`, { token }),
  listPortTargets: (token: string) =>
    request<PortTarget[]>("/api/v1/monitoring/port-targets", { token }),
  createPortTarget: (token: string, payload: { device_id: number | null; port: number; label: string }) =>
    request<PortTarget>("/api/v1/monitoring/port-targets", { method: "POST", token, body: JSON.stringify(payload) }),
  deletePortTarget: (token: string, id: number) =>
    request<void>(`/api/v1/monitoring/port-targets/${id}`, { method: "DELETE", token }),
  // IPAM
  getIpamSummary: (token: string) =>
    request<IpamSummary>("/api/v1/ipam/summary", { token }),
  listSubnets: (token: string) =>
    request<IpamSubnet[]>("/api/v1/ipam/subnets", { token }),
  createSubnet: (token: string, payload: SubnetPayload) =>
    request<IpamSubnet>("/api/v1/ipam/subnets", { method: "POST", token, body: JSON.stringify(payload) }),
  updateSubnet: (token: string, id: number, payload: Partial<SubnetPayload>) =>
    request<IpamSubnet>(`/api/v1/ipam/subnets/${id}`, { method: "PATCH", token, body: JSON.stringify(payload) }),
  deleteSubnet: (token: string, id: number) =>
    request<void>(`/api/v1/ipam/subnets/${id}`, { method: "DELETE", token }),
  getSubnetAddresses: (token: string, id: number) =>
    request<IpAddressEntry[]>(`/api/v1/ipam/subnets/${id}/addresses`, { token }),
  getIpamConflicts: (token: string) =>
    request<IpamConflict[]>("/api/v1/ipam/conflicts", { token }),
  listDhcpLeases: (token: string) =>
    request<DhcpLease[]>("/api/v1/ipam/dhcp-leases", { token }),
  importDhcpLeases: (token: string, content: string) =>
    request<{ imported: number; total: number }>("/api/v1/ipam/dhcp-leases/import", {
      method: "POST", token, body: JSON.stringify({ content }),
    }),
  clearDhcpLeases: (token: string) =>
    request<void>("/api/v1/ipam/dhcp-leases", { method: "DELETE", token }),
  getVlanSuggestions: (token: string) =>
    request<VlanSuggestion[]>("/api/v1/ipam/vlan-suggestions", { token }),
  importSubnetsFromVlans: (token: string, groupIds: number[]) =>
    request<{ imported: number }>("/api/v1/ipam/subnets/import-from-vlans", {
      method: "POST", token, body: JSON.stringify({ group_ids: groupIds }),
    }),
  listReservations: (token: string) =>
    request<IpReservation[]>("/api/v1/ipam/reservations", { token }),
  createReservation: (token: string, payload: IpReservationPayload) =>
    request<IpReservation>("/api/v1/ipam/reservations", { method: "POST", token, body: JSON.stringify(payload) }),
  updateReservation: (token: string, id: number, payload: Partial<Omit<IpReservationPayload, "ip_address">>) =>
    request<IpReservation>(`/api/v1/ipam/reservations/${id}`, { method: "PATCH", token, body: JSON.stringify(payload) }),
  deleteReservation: (token: string, id: number) =>
    request<void>(`/api/v1/ipam/reservations/${id}`, { method: "DELETE", token }),
  getVersion: (token: string) => request<VersionInfo>("/api/v1/system/version", { token }),
};
