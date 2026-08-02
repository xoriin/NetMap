export type UserRole = "SuperAdmin" | "NetworkAdmin" | "SecurityAnalyst" | "Viewer";

export type User = {
  id: number;
  username: string;
  role: string;
  is_active: boolean;
  display_name: string | null;
  avatar_data: string | null;
  email: string | null;
  auth_source?: "local" | "oidc";
  sso_issuer?: string | null;
  sso_last_login_at?: string | null;
  whats_new_acknowledged_version?: string | null;
  /** Per-user opt-out for coloured entity chips. Defaults to on. */
  entity_colors_enabled?: boolean;
};

export type OidcStatus = {
  enabled: boolean;
  provider_name: string;
  require_sso: boolean;
};

export type OidcSettings = {
  enabled: boolean;
  issuer: string;
  client_id: string;
  client_secret_set: boolean;
  redirect_url: string;
  effective_redirect_url: string;
  scopes: string;
  allowed_email_domains: string;
  auto_provision: boolean;
  provider_name: string;
  link_by_email: boolean;
  allow_unverified_email: boolean;
  group_claim: string;
  role_mappings: string;
  manage_roles: boolean;
  default_role: string;
  allow_super_admin: boolean;
  require_sso: boolean;
  env_configured: boolean;
};

export type OidcSettingsUpdate = Partial<{
  enabled: boolean;
  issuer: string;
  client_id: string;
  client_secret: string;
  redirect_url: string;
  scopes: string;
  allowed_email_domains: string;
  auto_provision: boolean;
  provider_name: string;
  link_by_email: boolean;
  allow_unverified_email: boolean;
  group_claim: string;
  role_mappings: string;
  manage_roles: boolean;
  default_role: string;
  allow_super_admin: boolean;
  require_sso: boolean;
}>;

export type OidcTestResult = {
  ok: boolean;
  checks: { name: string; ok: boolean; message: string }[];
};

export type TokenPair = {
  access_token: string;
  token_type: "bearer";
};

export type ApiKey = {
  id: number;
  name: string;
  prefix: string;
  suffix: string | null;
  created_at: string;
  expires_at: string | null;
  last_used_at: string | null;
  last_used_ip: string | null;
  revoked_at: string | null;
};

export type ApiKeyAdmin = ApiKey & {
  user_id: number;
  username: string;
};

export type ApiKeyCreateResponse = ApiKey & {
  key: string;
};

export type ApiKeyExpiryDays = 30 | 90 | 365 | null;

export type DashboardSummary = {
  user_count: number;
  device_count: number;
  group_count: number;
  relationship_count: number;
};

export type DeviceStatus = "online" | "offline" | "warning" | "unknown" | "disabled";
export type DeviceIcon = string;

export type DeviceLifecycle = "planned" | "active" | "retired" | "ignored";

export type DeviceTypeOption = {
  id: number | null;
  value: string;
  label: string;
  icon: string;
  is_builtin: boolean;
  /** Explicit chip colour; null falls back to the name-derived palette colour. */
  color: string | null;
};

export type Device = {
  id: number;
  display_name: string | null;
  hostname: string | null;
  ip_address: string;
  mac_address: string | null;
  vendor: string | null;
  os: string | null;
  device_type: string | null;
  status: DeviceStatus;
  lifecycle: DeviceLifecycle;
  monitoring_paused: boolean;
  expected_status: "online" | "offline";
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
  snmp_profile_id: number | null;
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
  os: string | null;
  device_type: string | null;
  status: DeviceStatus;
  lifecycle?: DeviceLifecycle;
  monitoring_paused?: boolean;
  expected_status?: "online" | "offline";
  icon: DeviceIcon;
  color: string | null;
  vlan_id: string | null;
  subnet: string | null;
  topology_group_id: number | null;
  topology_group: string | null;
  site_id: number | null;
  snmp_profile_id: number | null;
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
  link_speed_mbps: number | null;
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
  link_speed_mbps?: number | null;
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

export type TopologyDisplayPrefs = {
  groupDisplayPrefs?: Record<string, {
    nodeScalePercent: number;
    spacingScalePercent: number;
    maxDevicesPerRow: number;
    labelFontSize?: number;
    layoutShape?: "grid" | "radial";
    maxRings?: number;
  }>;
  edgeLabelFontSize?: number;
  nodeLabelFontSize?: number;
  groupZoneOpacityPercent?: number;
  showGroupZoneBorders?: boolean;
  hiddenGroupNames?: string[];
  showNodeIcons?: boolean;
  showNodeLabels?: boolean;
};

export type TopologyLayout = {
  id: number;
  owner_user_id: number;
  name: string;
  positions: Record<string, LayoutPosition>;
  display_prefs: TopologyDisplayPrefs | null;
  share_code: string | null;
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
  color: string | null;
  created_at: string;
  updated_at: string;
};

export type DiscoveryScanType = "ping" | "basic_ports";

export type DiscoveryHost = {
  ip_address: string;
  hostname: string | null;
  mac_address: string | null;
  vendor: string | null;
  os: string | null;
  status: string;
  open_ports: number[];
  existing_device_id: number | null;
  import_status: "new" | "existing" | "changed";
  proposed_updates: Array<"ip_address" | "hostname" | "mac_address" | "vendor" | "os">;
};

export type DiscoveryScan = {
  id: number;
  schedule_id: number | null;
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
  skipped_existing: number;
};

export type DiscoverySchedule = {
  id: number;
  owner_user_id: number;
  name: string;
  target: string;
  scan_type: DiscoveryScanType;
  enabled: boolean;
  interval_minutes: number;
  confirm_large_scan: boolean;
  topology_group_id: number | null;
  site_id: number | null;
  snmp_profile_id: number | null;
  snmp_targets: string[];
  notification_targets: string[];
  last_run_at: string | null;
  next_run_at: string | null;
  last_scan_id: number | null;
  last_status: string | null;
  last_error: string | null;
  open_observation_count: number;
  created_at: string;
  updated_at: string;
};

export type DiscoveryObservation = {
  id: number;
  schedule_id: number;
  scan_id: number | null;
  device_id: number | null;
  observation_type: "new_device" | "ip_change" | "field_change" | "disappeared" | string;
  status: "open" | "acknowledged" | "resolved";
  ip_address: string | null;
  mac_address: string | null;
  hostname: string | null;
  summary: string;
  details: Record<string, unknown>;
  first_seen_at: string;
  last_seen_at: string;
  resolved_at: string | null;
};

export type DiscoverySchedulePayload = {
  name: string;
  target: string;
  scan_type: DiscoveryScanType;
  enabled: boolean;
  interval_minutes: number;
  confirm_large_scan: boolean;
  topology_group_id?: number | null;
  site_id?: number | null;
  snmp_profile_id?: number | null;
  snmp_targets?: string[];
  notification_targets?: string[];
};

export type SnmpInterfaceResult = {
  index: number;
  name: string | null;
  oper_status: string | null;
};

export type SnmpArpEntryResult = {
  ip_address: string;
  mac_address: string;
  vendor: string | null;
  interface_index: number | null;
};

export type SnmpProbeResult = {
  host: string;
  sys_name: string | null;
  sys_descr: string | null;
  sys_uptime_seconds: number | null;
  interfaces: SnmpInterfaceResult[];
  arp_entries: SnmpArpEntryResult[];
  duration_ms: number;
};

export type SnmpProfile = {
  id: number;
  name: string;
  version: string;
  port: number;
  timeout_seconds: number;
  retries: number;
  created_at: string;
  updated_at: string;
};

export type LldpNeighbour = {
  id: number;
  source_device_id: number;
  local_port_index: number;
  local_port_id: string | null;
  local_port_desc: string | null;
  remote_chassis_id: string;
  remote_port_id: string | null;
  remote_port_desc: string | null;
  remote_sys_name: string | null;
  remote_mgmt_addr: string | null;
  matched_device_id: number | null;
  dismissed: boolean;
  last_seen: string;
  created_at: string;
};

export type LldpScanResult = {
  source_device_id: number;
  neighbours: LldpNeighbour[];
  error: string | null;
};

export type SnmpEnrichmentChange = {
  device_id: number;
  ip_address: string;
  field: string;
  current: string | null;
  suggested: string;
  source: string;
};

export type SnmpEnrichmentPreview = {
  source_device_id: number;
  source_profile_id: number;
  changes: SnmpEnrichmentChange[];
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
  received_packets: number;
  stored_events: number;
  dropped_unparsed: number;
  denied_senders: number;
  last_packet_at: string | null;
  last_packet_sender: string | null;
  last_stored_at: string | null;
  last_stored_sender: string | null;
  last_drop_at: string | null;
  last_drop_sender: string | null;
  last_drop_raw: string | null;
  last_denied_at: string | null;
  last_denied_sender: string | null;
};

export type DnsRecordType = "A" | "AAAA" | "MX" | "TXT" | "NS" | "CNAME";

export type DnsRecord = {
  value: string;
  ttl: number | null;
};

export type DnsLookupResult = {
  queried_name: string;
  record_type: DnsRecordType;
  records: DnsRecord[];
  source: string;
  dns_server: string | null;
  response_code: string;
  canonical_name: string | null;
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
  protocol: string;
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

export type RestoreValidationResult = {
  valid: boolean;
  size_bytes: number;
  table_count: number;
  devices: number | null;
  users: number | null;
  subnets: number | null;
};

export type SystemSettings = {
  app_name: string;
  login_message: string;
  announcement: string;
  support_email: string;
  support_url: string;
  live_ping_enabled: boolean;
  monitor_interval_seconds: number;
  idle_timeout_minutes: number;
  active_network_public_targets_enabled: boolean;
  ip_reservation_default_expiry_enabled: boolean;
  ip_reservation_reminder_enabled: boolean;
  ip_reservation_reminder_days: number;
  ip_reservation_reminder_channels: string[];
  backup_schedule_enabled: boolean;
  backup_schedule_interval_hours: number;
  backup_retention_count: number;
};

export type ScheduledBackup = {
  filename: string;
  size_bytes: number;
  created_at: string;
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

export type NotificationProfile = {
  id: number;
  name: string;
  provider: "apprise" | "ntfy" | "telegram" | "signal" | "smtp";
  enabled: boolean;
  config: Record<string, string>;
  created_at: string;
  updated_at: string;
};

export type NotificationProfilePayload = {
  name: string;
  provider: "apprise" | "ntfy" | "telegram" | "signal" | "smtp" | "webhook";
  enabled: boolean;
  config: Record<string, string>;
};

export type AlertRuleEventType = "device_offline" | "device_online" | "device_warning" | "any_status_change" | "device_unexpected_state" | "device_expected_state_restored" | "rtt_above" | "device_flapping" | "ping_loss_above" | "service_down" | "service_slow" | "monitor_down" | "monitor_slow" | "monitor_certificate_expiry";

export type AlertRule = {
  id: number;
  name: string;
  enabled: boolean;
  event_type: AlertRuleEventType;
  device_id: number | null;
  port_target_id: number | null;
  monitor_id: number | null;
  channels: string[];
  cooldown_minutes: number;
  threshold_ms: number | null;
  loss_pct_threshold: number | null;
  loss_window_minutes: number | null;
  last_triggered_at: string | null;
  created_at: string;
  updated_at: string;
};

export type AlertRulePayload = {
  name: string;
  enabled: boolean;
  event_type: AlertRuleEventType;
  device_id: number | null;
  port_target_id: number | null;
  monitor_id: number | null;
  channels: string[];
  cooldown_minutes: number;
  threshold_ms: number | null;
  loss_pct_threshold: number | null;
  loss_window_minutes: number | null;
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
  target_id: number | null;
  port: number;
  label: string;
  check_type: string;
  open: boolean;
  status: string | null;
  response_time_ms: number | null;
  status_code: number | null;
  error: string | null;
};

export type NotificationDelivery = {
  id: number;
  rule_name: string;
  device_id: number | null;
  target: string;
  status: "sent" | "failed";
  detail: string;
  sent_at: string;
};

export type MonitorHistoryPoint = {
  id: number;
  checked_at: string;
  status: string;
  expected_status: "online" | "offline";
  is_healthy: boolean | null;
  rtt_ms: number | null;
  port_results: PortResult[];
};

export type DeviceMonitorSummary = {
  device_id: number;
  display_name: string | null;
  hostname: string | null;
  ip_address: string;
  device_type: string | null;
  icon: DeviceIcon | null;
  status: string;
  expected_status: "online" | "offline";
  health_status: "healthy" | "unhealthy" | "unknown" | "paused";
  lifecycle: DeviceLifecycle;
  monitoring_paused: boolean;
  topology_group: string | null;
  site_id: number | null;
  site_name: string | null;
  vlan_id: string | null;
  last_checked: string | null;
  uptime_24h: number | null;
  uptime_7d: number | null;
  compliance_24h: number | null;
  compliance_7d: number | null;
  avg_rtt_24h: number | null;
  latest_port_results: PortResult[];
  heartbeat: string[];
  heartbeat_health: string[];
  rtt_sparkline: (number | null)[];
  is_favourite: boolean;
  flapping: boolean;
};

export type FleetSummary = {
  total: number;
  online: number;
  offline: number;
  unknown: number;
  paused: number;
  healthy: number;
  unhealthy: number;
  avg_rtt_ms: number | null;
  last_checked: string | null;
};

export type ServiceCheckType = "tcp" | "udp" | "dhcp" | "http" | "https";
export type HttpMethod = "GET" | "HEAD" | "POST" | "PUT" | "DELETE" | "OPTIONS" | "PATCH";

export type PortTarget = {
  id: number;
  device_id: number | null;
  port: number;
  label: string;
  check_type: ServiceCheckType;
  http_path: string | null;
  http_method: HttpMethod;
  expected_status_min: number;
  expected_status_max: number;
  timeout_seconds: number | null;
  verify_tls: boolean;
  follow_redirects: boolean;
  enabled: boolean;
  created_at: string;
};

export type MonitorStatus = "online" | "offline" | null;

export type Monitor = {
  id: number;
  name: string;
  description: string | null;
  tags: string[];
  url: string;
  http_method: HttpMethod;
  expected_status_min: number;
  expected_status_max: number;
  timeout_seconds: number;
  verify_tls: boolean;
  follow_redirects: boolean;
  max_redirects: number;
  accepted_status_codes: string;
  body_encoding: MonitorBodyEncoding;
  auth_type: MonitorAuthType;
  auth_username: string | null;
  oauth_token_url: string | null;
  oauth_client_id: string | null;
  oauth_scopes: string | null;
  oauth_audience: string | null;
  oauth_auth_method: MonitorOauthAuthMethod;
  keyword: string | null;
  keyword_inverted: boolean;
  json_path: string | null;
  json_operator: MonitorJsonOperator;
  expected_value: string | null;
  cache_bust: boolean;
  upside_down: boolean;
  check_interval_seconds: number;
  max_retries: number;
  retry_interval_seconds: number;
  certificate_expiry_alert: boolean;
  certificate_expiry_days: number;
  has_request_headers: boolean;
  has_request_body: boolean;
  has_auth_password: boolean;
  has_bearer_token: boolean;
  has_oauth_client_secret: boolean;
  has_proxy_url: boolean;
  has_tls_ca: boolean;
  has_tls_cert: boolean;
  has_tls_key: boolean;
  enabled: boolean;
  consecutive_failures: number;
  last_status: MonitorStatus;
  last_checked_at: string | null;
  last_cert_expires_at: string | null;
  last_cert_issuer: string | null;
  uptime_24h: number | null;
  uptime_7d: number | null;
  avg_response_time_24h: number | null;
  created_at: string;
  updated_at: string;
};

export type MonitorBodyEncoding = "json" | "text" | "form" | "xml";
export type MonitorAuthType = "none" | "basic" | "bearer" | "oauth2" | "mtls";
export type MonitorOauthAuthMethod = "client_secret_basic" | "client_secret_post";
export type MonitorJsonOperator = "equals" | "not_equals" | "contains" | "not_contains" | "exists" | "not_exists" | "gt" | "gte" | "lt" | "lte";

export type MonitorPayload = {
  name: string;
  url: string;
  description?: string | null;
  tags?: string[];
  http_method?: HttpMethod;
  expected_status_min?: number;
  expected_status_max?: number;
  timeout_seconds?: number;
  verify_tls?: boolean;
  follow_redirects?: boolean;
  max_redirects?: number;
  accepted_status_codes?: string;
  request_headers?: Record<string, string> | null;
  request_body?: string | null;
  body_encoding?: MonitorBodyEncoding;
  auth_type?: MonitorAuthType;
  auth_username?: string | null;
  auth_password?: string | null;
  bearer_token?: string | null;
  oauth_token_url?: string | null;
  oauth_client_id?: string | null;
  oauth_client_secret?: string | null;
  oauth_scopes?: string | null;
  oauth_audience?: string | null;
  oauth_auth_method?: MonitorOauthAuthMethod;
  proxy_url?: string | null;
  tls_ca?: string | null;
  tls_cert?: string | null;
  tls_key?: string | null;
  keyword?: string | null;
  keyword_inverted?: boolean;
  json_path?: string | null;
  json_operator?: MonitorJsonOperator;
  expected_value?: string | null;
  cache_bust?: boolean;
  upside_down?: boolean;
  check_interval_seconds?: number;
  max_retries?: number;
  retry_interval_seconds?: number;
  certificate_expiry_alert?: boolean;
  certificate_expiry_days?: number;
  enabled?: boolean;
};

export type MonitorCheckHistoryPoint = {
  id: number;
  checked_at: string;
  status: "online" | "offline";
  response_time_ms: number | null;
  status_code: number | null;
  error: string | null;
  assertion_detail: string | null;
  response_size_bytes: number | null;
  cert_expires_at: string | null;
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
  display_name: string | null;
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

export type ExternalIpPool = {
  id: number;
  name: string;
  cidr: string;
  provider: string | null;
  account: string | null;
  description: string | null;
  created_at: string;
  updated_at: string;
  total: number;
  in_use: number;
  reserved: number;
  free: number;
  utilization: number;
};

export type ExternalIpAssignment = {
  id: number;
  pool_id: number;
  ip_address: string;
  label: string;
  status: "available" | "reserved" | "in_use";
  provider: string | null;
  account: string | null;
  owner: string | null;
  service: string | null;
  tags: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

export type ExternalIpAssignmentPayload = Omit<ExternalIpAssignment, "id" | "created_at" | "updated_at">;
export type ExternalIpPoolPayload = Pick<ExternalIpPool, "name" | "cidr" | "provider" | "account" | "description">;

export type ExternalIpAddressPage = {
  total: number;
  offset: number;
  limit: number;
  addresses: Array<{
    ip_address: string;
    status: "available" | "reserved" | "in_use";
    assignment: ExternalIpAssignment | null;
  }>;
};

export type ExternalIpSummary = {
  pool_count: number;
  total: number;
  in_use: number;
  reserved: number;
  free: number;
};

export type IpReservation = {
  id: number;
  ip_address: string;
  subnet_id: number | null;
  label: string;
  mac_address: string | null;
  notes: string | null;
  reserved_by: string | null;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
};

export type IpReservationPayload = {
  ip_address: string;
  subnet_id?: number | null;
  label: string;
  mac_address?: string | null;
  notes?: string | null;
  expires_at?: string | null;
};

export type SavedSecuritySearch = {
  id: number;
  name: string;
  filters: Record<string, unknown>;
  created_at: string;
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

export type ChangelogSection = {
  category: string;
  items: string[];
};

export type ChangelogRelease = {
  version: string;
  sections: ChangelogSection[];
};

export type VersionInfo = {
  current: string;
  channel: string | null;
  latest: string | null;
  up_to_date: boolean;
  release_url: string;
  current_release_url: string;
  whats_new: ChangelogRelease[];
};

type DiagCacheEntry = {
  cached: boolean;
  age_seconds: number | null;
  hits: number;
  misses: number;
};

export type SystemDiagnostics = {
  generated_at: string;
  database: {
    main: { exists: boolean; bytes: number; wal_bytes: number; shm_bytes: number; total_bytes: number };
    firewall: { exists: boolean; bytes: number; wal_bytes: number; shm_bytes: number; total_bytes: number };
  };
  monitoring: {
    last_checked_at: string | null;
    device_status_counts: Record<string, number>;
    cache: {
      ttl_seconds: number;
      fleet_summary: DiagCacheEntry;
      device_summaries: DiagCacheEntry;
    };
  };
  syslog: {
    total_events: number;
    retention_last_run_at: string | null;
    retention_last_deleted: number;
    retention_last_error: string | null;
    last_event_received_at: string | null;
  };
  process: { pid: number };
};

type RequestOptions = RequestInit & {
  token?: string | null;
};

/**
 * Typed API failure. `status` is the HTTP status code; `detail` is the parsed
 * FastAPI `detail` payload when one was present. `message` stays human-readable
 * so existing `err.message` rendering keeps working.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly detail: unknown;

  constructor(status: number, message: string, detail?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.detail = detail;
  }
}

// Deduplicate concurrent refresh calls (e.g. React StrictMode double-invocation)
// so a single in-flight token rotation isn't hit twice with the same revocable token.
let _pendingRefresh: Promise<TokenPair> | null = null;

type TokenRefreshListener = (tokens: TokenPair) => void;
const _tokenRefreshListeners = new Set<TokenRefreshListener>();

/**
 * Notifies whenever the client rotates the access token (proactive refresh or
 * transparent 401 retry) so app state can adopt the new token.
 */
export function subscribeTokenRefresh(listener: TokenRefreshListener): () => void {
  _tokenRefreshListeners.add(listener);
  return () => _tokenRefreshListeners.delete(listener);
}

function notifyTokenRefresh(tokens: TokenPair) {
  _tokenRefreshListeners.forEach((listener) => listener(tokens));
}

async function toApiError(response: Response): Promise<ApiError> {
  const status = response.status;
  let message = `HTTP ${status}`;
  let detail: unknown;
  try {
    const errorBody = (await response.json()) as { detail?: unknown };
    detail = errorBody.detail;
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
  return new ApiError(status, message, detail);
}

/**
 * A 401 on an authenticated non-auth endpoint usually means the in-memory
 * access token expired (e.g. laptop sleep past the proactive refresh window).
 * Rotate via the HttpOnly refresh cookie once and hand back the new token;
 * returns null when recovery is not applicable or the refresh itself failed.
 */
async function recoverExpiredToken(path: string, options: RequestOptions): Promise<string | null> {
  if (!options.token || path.startsWith("/api/v1/auth/") || path.startsWith("/api/v1/setup/")) {
    return null;
  }
  try {
    const refreshed = await api.refresh();
    return refreshed.access_token;
  } catch {
    return null;
  }
}

function buildHeaders(options: RequestOptions, json: boolean): Headers {
  const headers = new Headers(options.headers);
  if (json && !headers.has("Content-Type") && options.body !== undefined) {
    headers.set("Content-Type", "application/json");
  }
  if (options.token) {
    headers.set("Authorization", `Bearer ${options.token}`);
  }
  addCsrfHeader(headers, options.method);
  return headers;
}

async function request<T>(path: string, options: RequestOptions = {}, isRetry = false): Promise<T> {
  const response = await fetch(path, {
    ...options,
    credentials: "include",
    headers: buildHeaders(options, true),
  });

  if (!response.ok) {
    if (response.status === 401 && !isRetry) {
      const newToken = await recoverExpiredToken(path, options);
      if (newToken) {
        return request<T>(path, { ...options, token: newToken }, true);
      }
    }
    throw await toApiError(response);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return response.json() as Promise<T>;
}

export type DownloadResult = {
  blob: Blob;
  filename: string;
};

export type ExportSummary = {
  inventory_rows: number | null;
  firewall_events: number | null;
  exports_last_30_days: number;
  last_export_at: string | null;
  last_export_type: string | null;
  last_export_detail: string | null;
};

async function requestBlob(path: string, options: RequestOptions = {}, isRetry = false): Promise<DownloadResult> {
  const response = await fetch(path, {
    ...options,
    credentials: "include",
    headers: buildHeaders(options, false),
  });

  if (!response.ok) {
    if (response.status === 401 && !isRetry) {
      const newToken = await recoverExpiredToken(path, options);
      if (newToken) {
        return requestBlob(path, { ...options, token: newToken }, true);
      }
    }
    throw await toApiError(response);
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
      })
        .then((tokens) => {
          notifyTokenRefresh(tokens);
          return tokens;
        })
        .finally(() => { _pendingRefresh = null; });
    }
    return _pendingRefresh;
  },
  logout: (token?: string | null) =>
    request<void>("/api/v1/auth/logout", {
      method: "POST",
      token: token ?? null,
      body: JSON.stringify({}),
    }),
  oidcStatus: () => request<OidcStatus>("/api/v1/auth/oidc/status"),
  getOidcSettings: (token: string) => request<OidcSettings>("/api/v1/admin/oidc-settings", { token }),
  updateOidcSettings: (token: string, payload: OidcSettingsUpdate) =>
    request<OidcSettings>("/api/v1/admin/oidc-settings", {
      method: "PUT",
      token,
      body: JSON.stringify(payload),
    }),
  testOidcProvider: (token: string) =>
    request<OidcTestResult>("/api/v1/admin/oidc-settings/test", {
      method: "POST",
      token,
      body: JSON.stringify({}),
    }),
  me: (token: string) => request<User>("/api/v1/auth/me", { token }),
  updateProfile: (token: string, payload: { display_name?: string | null; avatar_data?: string | null; email?: string | null; entity_colors_enabled?: boolean }) =>
    request<User>("/api/v1/auth/me", {
      method: "PATCH",
      token,
      body: JSON.stringify(payload),
    }),
  acknowledgeWhatsNew: (token: string, version: string) =>
    request<User>("/api/v1/auth/me/acknowledge-whats-new", {
      method: "POST",
      token,
      body: JSON.stringify({ version }),
    }),
  changePassword: (token: string, currentPassword: string, newPassword: string) =>
    request<void>("/api/v1/auth/change-password", {
      method: "POST",
      token,
      body: JSON.stringify({ current_password: currentPassword, new_password: newPassword }),
    }),
  listApiKeys: (token: string) => request<ApiKey[]>("/api/v1/api-keys", { token }),
  createApiKey: (token: string, name: string, expiresInDays: ApiKeyExpiryDays) =>
    request<ApiKeyCreateResponse>("/api/v1/api-keys", {
      method: "POST",
      token,
      body: JSON.stringify({ name, expires_in_days: expiresInDays }),
    }),
  revokeApiKey: (token: string, keyId: number) =>
    request<void>(`/api/v1/api-keys/${keyId}`, { method: "DELETE", token }),
  listAllApiKeys: (token: string) => request<ApiKeyAdmin[]>("/api/v1/api-keys/admin/all", { token }),
  adminRevokeApiKey: (token: string, keyId: number) =>
    request<void>(`/api/v1/api-keys/admin/${keyId}`, { method: "DELETE", token }),
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
    payload: Partial<{ name: string; display_name: string | null; vlan_id: string | null; ip_range: string | null; gateway: string | null; dhcp_start: string | null; dhcp_end: string | null; dns_servers: string | null; description: string | null; color: string | null }>,
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
    payload: { device_ids: number[]; topology_group_id?: number | null; topology_group?: string | null; site_id?: number | null },
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
    payload: { name: string; positions: Record<string, LayoutPosition>; display_prefs?: TopologyDisplayPrefs | null },
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
  shareTopologyLayout: (token: string, layoutId: number) =>
    request<{ id: number; name: string; share_code: string }>(`/api/v1/topology/layouts/${layoutId}/share`, {
      method: "POST",
      token,
    }),
  revokeTopologyLayoutShare: (token: string, layoutId: number) =>
    request<void>(`/api/v1/topology/layouts/${layoutId}/share`, {
      method: "DELETE",
      token,
    }),
  importTopologyLayout: (token: string, code: string, name?: string) =>
    request<TopologyLayout>("/api/v1/topology/layouts/import", {
      method: "POST",
      token,
      body: JSON.stringify(name ? { code, name } : { code }),
    }),
  previewSharedTopologyLayout: (token: string, code: string) =>
    request<TopologyLayout>(`/api/v1/topology/layouts/shared/${encodeURIComponent(code)}`, { token }),
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
  getFavourites: (token: string) =>
    request<number[]>("/api/v1/topology/devices/favourites", { token }),
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
    payload: {
      target: string;
      scan_type: DiscoveryScanType;
      confirm_large_scan: boolean;
      topology_group_id?: number | null;
      snmp_community?: string | null;
      snmp_profile_id?: number | null;
      snmp_targets?: string[];
      snmp_port?: number;
      snmp_timeout_seconds?: number;
    },
  ) =>
    request<DiscoveryScan>("/api/v1/discovery/scans", {
      method: "POST",
      token,
      body: JSON.stringify(payload),
    }),
  importDiscoveryResults: (
    token: string,
    scanId: number,
    ipAddresses: string[],
    topologyGroupId?: number | null,
    siteId?: number | null,
    mode?: "new_only" | "fill_missing" | "override_existing",
    updateFields?: Array<"hostname" | "mac_address" | "vendor" | "os">,
    updateIpOnMacMatch?: boolean,
  ) =>
    request<DiscoveryImportResult>("/api/v1/discovery/import", {
      method: "POST",
      token,
      body: JSON.stringify({
        scan_id: scanId,
        ip_addresses: ipAddresses,
        topology_group_id: topologyGroupId ?? null,
        site_id: siteId ?? null,
        mode: mode ?? "fill_missing",
        update_fields: updateFields ?? ["hostname", "mac_address", "vendor"],
        update_ip_on_mac_match: updateIpOnMacMatch ?? false,
      }),
    }),
  listDiscoverySchedules: (token: string) =>
    request<DiscoverySchedule[]>("/api/v1/discovery/schedules", { token }),
  createDiscoverySchedule: (token: string, payload: DiscoverySchedulePayload) =>
    request<DiscoverySchedule>("/api/v1/discovery/schedules", {
      method: "POST",
      token,
      body: JSON.stringify(payload),
    }),
  updateDiscoverySchedule: (token: string, id: number, payload: Partial<DiscoverySchedulePayload>) =>
    request<DiscoverySchedule>(`/api/v1/discovery/schedules/${id}`, {
      method: "PATCH",
      token,
      body: JSON.stringify(payload),
    }),
  deleteDiscoverySchedule: (token: string, id: number) =>
    request<void>(`/api/v1/discovery/schedules/${id}`, { method: "DELETE", token }),
  runDiscoverySchedule: (token: string, id: number) =>
    request<DiscoveryScan>(`/api/v1/discovery/schedules/${id}/run`, { method: "POST", token }),
  listDiscoveryObservations: (
    token: string,
    params: { schedule_id?: number; status_filter?: "open" | "acknowledged" | "resolved" | "all" } = {},
  ) => {
    const search = new URLSearchParams();
    if (params.schedule_id !== undefined) search.set("schedule_id", String(params.schedule_id));
    if (params.status_filter) search.set("status_filter", params.status_filter);
    const query = search.toString();
    return request<DiscoveryObservation[]>(`/api/v1/discovery/observations${query ? `?${query}` : ""}`, { token });
  },
  updateDiscoveryObservation: (token: string, id: number, status: "open" | "acknowledged" | "resolved") =>
    request<DiscoveryObservation>(`/api/v1/discovery/observations/${id}`, {
      method: "PATCH",
      token,
      body: JSON.stringify({ status }),
    }),
  applyObservation: (token: string, id: number) =>
    request<DiscoveryObservation>(`/api/v1/discovery/observations/${id}/apply`, { method: "POST", token }),
  resolveAllObservations: (token: string) =>
    request<{ resolved: number }>("/api/v1/discovery/observations/resolve-all", { method: "POST", token }),
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
  tcpCheck: (token: string, payload: { host: string; port: number; timeout_seconds: number; protocol: "tcp" | "udp" }) =>
    request<TcpPortCheckResult>("/api/v1/tools/port-check", {
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
  snmpProbe: (
    token: string,
    payload: { host: string; community?: string | null; profile_id?: number | null; port: number; timeout_seconds: number },
  ) =>
    request<SnmpProbeResult>("/api/v1/tools/snmp/probe", {
      method: "POST",
      token,
      body: JSON.stringify(payload),
    }),
  listSnmpProfiles: (token: string) => request<SnmpProfile[]>("/api/v1/tools/snmp/profiles", { token }),
  createSnmpProfile: (
    token: string,
    payload: { name: string; community: string; port: number; timeout_seconds: number; retries: number },
  ) =>
    request<SnmpProfile>("/api/v1/tools/snmp/profiles", {
      method: "POST",
      token,
      body: JSON.stringify(payload),
    }),
  updateSnmpProfile: (
    token: string,
    profileId: number,
    payload: Partial<{ name: string; community: string; port: number; timeout_seconds: number; retries: number }>,
  ) =>
    request<SnmpProfile>(`/api/v1/tools/snmp/profiles/${profileId}`, {
      method: "PATCH",
      token,
      body: JSON.stringify(payload),
    }),
  deleteSnmpProfile: (token: string, profileId: number) =>
    request<void>(`/api/v1/tools/snmp/profiles/${profileId}`, {
      method: "DELETE",
      token,
    }),
  previewSnmpArpEnrichment: (token: string, deviceId: number) =>
    request<SnmpEnrichmentPreview>(`/api/v1/topology/devices/${deviceId}/snmp/arp-enrichment`, { token }),
  applySnmpArpEnrichment: (token: string, deviceId: number, deviceIds?: number[]) =>
    request<{ updated: number }>(`/api/v1/topology/devices/${deviceId}/snmp/arp-enrichment/apply`, {
      method: "POST",
      token,
      body: JSON.stringify({ apply_all: !deviceIds, device_ids: deviceIds ?? [] }),
    }),
  downloadInventory: (token: string, format: "csv" | "json") =>
    requestBlob(`/api/v1/exports/inventory?format=${format}`, { token }),
  getExportSummary: (token: string) => request<ExportSummary>("/api/v1/exports/summary", { token }),
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
  validateRestoreBackup: (token: string, payload: Blob) =>
    request<RestoreValidationResult>("/api/v1/exports/restore/validate", {
      method: "POST",
      token,
      headers: {
        "Content-Type": "application/octet-stream",
      },
      body: payload,
    }),
  listScheduledBackups: (token: string) =>
    request<ScheduledBackup[]>("/api/v1/exports/scheduled-backups", { token }),
  downloadScheduledBackup: (token: string, filename: string) =>
    requestBlob(`/api/v1/exports/scheduled-backups/${encodeURIComponent(filename)}`, { token }),
  deleteScheduledBackup: (token: string, filename: string) =>
    request<void>(`/api/v1/exports/scheduled-backups/${encodeURIComponent(filename)}`, { method: "DELETE", token }),
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
  listNotificationProfiles: (token: string) =>
    request<NotificationProfile[]>("/api/v1/admin/notification-profiles", { token }),
  createNotificationProfile: (token: string, payload: NotificationProfilePayload) =>
    request<NotificationProfile>("/api/v1/admin/notification-profiles", {
      method: "POST",
      token,
      body: JSON.stringify(payload),
    }),
  updateNotificationProfile: (token: string, id: number, payload: Partial<NotificationProfilePayload>) =>
    request<NotificationProfile>(`/api/v1/admin/notification-profiles/${id}`, {
      method: "PATCH",
      token,
      body: JSON.stringify(payload),
    }),
  deleteNotificationProfile: (token: string, id: number) =>
    request<void>(`/api/v1/admin/notification-profiles/${id}`, { method: "DELETE", token }),
  testNotificationProfile: (token: string, id: number) =>
    request<{ status: string }>(`/api/v1/admin/notification-profiles/${id}/test`, { method: "POST", token }),
  listDeviceTypes: (token: string) =>
    request<DeviceTypeOption[]>("/api/v1/admin/device-types", { token }),
  createDeviceType: (token: string, payload: { label: string; value?: string | null; icon?: string }) =>
    request<DeviceTypeOption>("/api/v1/admin/device-types", {
      method: "POST",
      token,
      body: JSON.stringify(payload),
    }),
  updateDeviceType: (token: string, value: string, payload: { label?: string; value?: string | null; icon?: string }) =>
    request<DeviceTypeOption>(`/api/v1/admin/device-types/${encodeURIComponent(value)}`, {
      method: "PUT",
      token,
      body: JSON.stringify(payload),
    }),
  deleteDeviceType: (token: string, value: string) =>
    request<void>(`/api/v1/admin/device-types/${encodeURIComponent(value)}`, { method: "DELETE", token }),
  /** Replaces the whole map; omitted types fall back to their automatic colour. */
  updateDeviceTypeColors: (token: string, colors: Record<string, string>) =>
    request<DeviceTypeOption[]>("/api/v1/admin/device-type-colors", {
      method: "PUT",
      token,
      body: JSON.stringify({ colors }),
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
  listNotificationDeliveries: (token: string, limit = 100) =>
    request<NotificationDelivery[]>(`/api/v1/alerts/deliveries?limit=${limit}`, { token }),
  resetUserPassword: (token: string, userId: number, newPassword: string) =>
    request<void>(`/api/v1/auth/users/${userId}/reset-password`, {
      method: "POST",
      token,
      body: JSON.stringify({ new_password: newPassword }),
    }),
  unlockUserLogin: (token: string, userId: number) =>
    request<void>(`/api/v1/auth/users/${userId}/unlock-login`, {
      method: "POST",
      token,
      body: JSON.stringify({}),
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
  listAuditLogs: (token: string, params: { limit?: number; offset?: number; actor_user_id?: number; category?: "login" } = {}) => {
    const search = new URLSearchParams();
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null) search.set(key, String(value));
    });
    const query = search.toString();
    return request<AuditLogList>(`/api/v1/audit/logs${query ? `?${query}` : ""}`, { token });
  },
  exportLoginHistory: (token: string, actorUserId?: number) => {
    const query = actorUserId !== undefined ? `?actor_user_id=${actorUserId}` : "";
    return requestBlob(`/api/v1/audit/logs/export${query}`, { token });
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
  getMonitoringDevice: (token: string, deviceId: number) =>
    request<DeviceMonitorSummary>(`/api/v1/monitoring/devices/${deviceId}`, { token }),
  getDeviceHistory: (token: string, deviceId: number, hours = 24) =>
    request<MonitorHistoryPoint[]>(`/api/v1/monitoring/devices/${deviceId}/history?hours=${hours}`, { token }),
  getDeviceAnalysis: (token: string, deviceId: number) =>
    request<DeviceAnalysis>(`/api/v1/monitoring/devices/${deviceId}/analysis`, { token }),
  listPortTargets: (token: string) =>
    request<PortTarget[]>("/api/v1/monitoring/service-checks", { token }),
  createPortTarget: (token: string, payload: {
    device_id: number | null; port: number; label: string; check_type?: ServiceCheckType; http_path?: string | null;
    http_method?: HttpMethod; expected_status_min?: number; expected_status_max?: number;
    timeout_seconds?: number | null; verify_tls?: boolean; follow_redirects?: boolean; enabled?: boolean;
  }) =>
    request<PortTarget>("/api/v1/monitoring/service-checks", { method: "POST", token, body: JSON.stringify(payload) }),
  deletePortTarget: (token: string, id: number) =>
    request<void>(`/api/v1/monitoring/service-checks/${id}`, { method: "DELETE", token }),
  listMonitors: (token: string) =>
    request<Monitor[]>("/api/v1/monitors", { token }),
  createMonitor: (token: string, payload: MonitorPayload) =>
    request<Monitor>("/api/v1/monitors", { method: "POST", token, body: JSON.stringify(payload) }),
  updateMonitor: (token: string, id: number, payload: Partial<MonitorPayload>) =>
    request<Monitor>(`/api/v1/monitors/${id}`, { method: "PATCH", token, body: JSON.stringify(payload) }),
  deleteMonitor: (token: string, id: number) =>
    request<void>(`/api/v1/monitors/${id}`, { method: "DELETE", token }),
  getMonitorHistory: (token: string, id: number, hours = 24) =>
    request<MonitorCheckHistoryPoint[]>(`/api/v1/monitors/${id}/history?hours=${hours}`, { token }),
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
  deleteExpiredReservations: (token: string) =>
    request<{ deleted: number }>("/api/v1/ipam/reservations/expired", { method: "DELETE", token }),
  getNextAvailableIp: (token: string, subnetId: number) =>
    request<{ ip: string }>(`/api/v1/ipam/subnets/${subnetId}/next-available`, { token }),
  getExternalIpSummary: (token: string) =>
    request<ExternalIpSummary>("/api/v1/ipam/external/summary", { token }),
  listExternalIpPools: (token: string) =>
    request<ExternalIpPool[]>("/api/v1/ipam/external/pools", { token }),
  createExternalIpPool: (token: string, payload: ExternalIpPoolPayload) =>
    request<ExternalIpPool>("/api/v1/ipam/external/pools", { method: "POST", token, body: JSON.stringify(payload) }),
  updateExternalIpPool: (token: string, id: number, payload: Partial<ExternalIpPoolPayload>) =>
    request<ExternalIpPool>(`/api/v1/ipam/external/pools/${id}`, { method: "PATCH", token, body: JSON.stringify(payload) }),
  deleteExternalIpPool: (token: string, id: number) =>
    request<void>(`/api/v1/ipam/external/pools/${id}`, { method: "DELETE", token }),
  getExternalPoolAddresses: (token: string, id: number, offset = 0, limit = 256) =>
    request<ExternalIpAddressPage>(`/api/v1/ipam/external/pools/${id}/addresses?offset=${offset}&limit=${limit}`, { token }),
  listExternalIpAssignments: (token: string) =>
    request<ExternalIpAssignment[]>("/api/v1/ipam/external/assignments", { token }),
  createExternalIpAssignment: (token: string, payload: ExternalIpAssignmentPayload) =>
    request<ExternalIpAssignment>("/api/v1/ipam/external/assignments", { method: "POST", token, body: JSON.stringify(payload) }),
  updateExternalIpAssignment: (token: string, id: number, payload: Partial<ExternalIpAssignmentPayload>) =>
    request<ExternalIpAssignment>(`/api/v1/ipam/external/assignments/${id}`, { method: "PATCH", token, body: JSON.stringify(payload) }),
  deleteExternalIpAssignment: (token: string, id: number) =>
    request<void>(`/api/v1/ipam/external/assignments/${id}`, { method: "DELETE", token }),
  listSavedSecuritySearches: (token: string) =>
    request<SavedSecuritySearch[]>("/api/v1/syslog/searches", { token }),
  createSavedSecuritySearch: (token: string, name: string, filters: Record<string, unknown>) =>
    request<SavedSecuritySearch>("/api/v1/syslog/searches", { method: "POST", token, body: JSON.stringify({ name, filters }) }),
  deleteSavedSecuritySearch: (token: string, id: number) =>
    request<void>(`/api/v1/syslog/searches/${id}`, { method: "DELETE", token }),
  getVersion: (token: string) => request<VersionInfo>("/api/v1/system/version", { token }),
  getSystemDiagnostics: (token: string) => request<SystemDiagnostics>("/api/v1/system/diagnostics", { token }),
  lldpScan: (token: string, deviceId: number) =>
    request<LldpScanResult>(`/api/v1/lldp/scan/${deviceId}`, { method: "POST", token }),
  listLldpNeighbours: (token: string, params?: { source_device_id?: number; dismissed?: boolean }) => {
    const qs = new URLSearchParams();
    if (params?.source_device_id !== undefined) qs.set("source_device_id", String(params.source_device_id));
    if (params?.dismissed !== undefined) qs.set("dismissed", String(params.dismissed));
    const q = qs.toString();
    return request<LldpNeighbour[]>(`/api/v1/lldp/neighbours${q ? `?${q}` : ""}`, { token });
  },
  patchLldpNeighbour: (token: string, id: number, payload: { dismissed?: boolean; matched_device_id?: number }) =>
    request<LldpNeighbour>(`/api/v1/lldp/neighbours/${id}`, {
      method: "PATCH",
      token,
      body: JSON.stringify(payload),
    }),
  lldpCreateLink: (token: string, neighbourId: number) =>
    request<{ relationship_id: number; created: boolean }>(`/api/v1/lldp/neighbours/${neighbourId}/create-link`, {
      method: "POST",
      token,
    }),
};
