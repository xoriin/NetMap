import { useState, useEffect, type FormEvent, type ReactNode } from "react";
import "./tools.css";
import { Bookmark, CheckCircle2, Clock3, Copy, Download, Network, RotateCcw, Search, Trash2 } from "lucide-react";
import { IconWifi, IconServer, IconWorld, IconLayoutDashboard, IconRouter, IconTopologyRing } from "@tabler/icons-react";
import {
  api,
  type DnsRecordType, type DnsLookupResult, type ReverseDnsResult,
  type PingResult, type TracerouteResult, type TcpPortCheckResult,
  type SubnetCalculatorResult, type SnmpProbeResult, type SnmpProfile,
  type LldpNeighbour, type Device, type TopologyGraph, type User,
} from "../../api/client";
import { SUBNET_REF } from "../../constants";
import { deviceLabel, formatMs } from "../../utils/format";
import { prefixToMask, wildcardMask, ipClass, ipType } from "../../utils/ip";

function ToolPanelHeader({ icon, title, badge }: { icon: ReactNode; title: string; badge: ReactNode }) {
  return (
    <div className="tool-card-header nm-app-panel-header">
      <span className="tool-panel-identity">
        <span className="tool-panel-icon" aria-hidden="true">{icon}</span>
        <span className="tool-panel-separator" aria-hidden="true">-</span>
        <span className="tool-panel-title">{title}</span>
      </span>
      {badge}
    </div>
  );
}

const TOOL_DEFINITIONS = [
  {
    id: "dns",
    label: "DNS Lookup",
    description: "Resolve names and inspect DNS records",
    Icon: Search,
    passive: true,
    guide: "Resolves a domain name using the configured DNS path and returns records with query timing.",
    steps: ["Enter a domain or hostname.", "Select the record type to resolve.", "Run the lookup and inspect the returned records."],
  },
  {
    id: "reverse-dns",
    label: "Reverse DNS",
    description: "Resolve an IP address to hostnames",
    Icon: IconWorld,
    passive: true,
    guide: "Looks up PTR records for an IP address without sending active probes to the target device.",
    steps: ["Enter an IPv4 or IPv6 address.", "Run the reverse lookup.", "Review every hostname returned by DNS."],
  },
  {
    id: "ping",
    label: "Ping Test",
    description: "Measure reachability and latency",
    Icon: IconWifi,
    passive: false,
    guide: "Sends a controlled ICMP probe to measure reachability, packet loss and average round-trip time.",
    steps: ["Enter a host or IP address.", "Choose the packet count and timeout.", "Run the test and review loss and latency."],
  },
  {
    id: "traceroute",
    label: "Traceroute",
    description: "Trace the network path to a target",
    Icon: Network,
    passive: false,
    guide: "Traces the routed path to a target and reports each responding hop with its round-trip time.",
    steps: ["Enter the destination host.", "Set the maximum hops and timeout.", "Run the trace and inspect each hop."],
  },
  {
    id: "tcp",
    label: "Port Check",
    description: "Test TCP or UDP service reachability",
    Icon: IconServer,
    passive: false,
    guide: "Tests whether a specific TCP or UDP service can be reached from the NetMap host.",
    steps: ["Enter the service host.", "Choose protocol, port and timeout.", "Run the check and review the result."],
  },
  {
    id: "subnet",
    label: "Subnet Calculator",
    description: "Calculate CIDR address boundaries",
    Icon: IconLayoutDashboard,
    passive: true,
    guide: "Calculates network boundaries, masks and usable host capacity locally without probing the network.",
    steps: ["Enter an IP address.", "Choose the prefix or subnet mask.", "Calculate and review the address range."],
  },
  {
    id: "snmp",
    label: "SNMP Probe",
    description: "Query an SNMP-enabled device",
    Icon: IconRouter,
    passive: false,
    guide: "Queries an SNMP endpoint for system identity, uptime, interfaces and ARP information.",
    steps: ["Select a saved profile or manual community.", "Enter the target host and connection settings.", "Run the probe and inspect returned device data."],
  },
] as const;

// LLDP remains implemented behind its currently hidden selector.
type ToolId = (typeof TOOL_DEFINITIONS)[number]["id"] | "lldp";

type ToolRunStatus = "success" | "error";
type ToolRun = {
  id: string;
  tool: Exclude<ToolId, "lldp">;
  target: string;
  summary: string;
  status: ToolRunStatus;
  ranAt: string;
  durationMs: number | null;
  inputs: Record<string, string | number>;
  result: unknown | null;
};

type SavedToolResult = ToolRun & { savedAt: string };

const TOOLS_RECENT_KEY = "netmap.tools.recent_v1";
const TOOLS_SAVED_KEY = "netmap.tools.saved_v1";

function loadStoredRuns<T>(key: string, limit: number): T[] {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(key) || "[]");
    return Array.isArray(parsed) ? parsed.slice(0, limit) as T[] : [];
  } catch {
    return [];
  }
}

function toolDefinition(tool: ToolRun["tool"]) {
  return TOOL_DEFINITIONS.find((item) => item.id === tool) ?? TOOL_DEFINITIONS[0];
}

function relativeRunTime(value: string) {
  const elapsed = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(elapsed) || elapsed < 60_000) return "just now";
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m ago`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h ago`;
  return new Date(value).toLocaleDateString();
}

export function ToolsWorkspace({
  accessToken,
  graph,
  selectedDevice,
  userRole,
}: {
  accessToken: string;
  graph: TopologyGraph;
  selectedDevice: Device | null;
  userRole: User["role"];
}) {
  const canRunActiveTools = userRole === "SuperAdmin" || userRole === "NetworkAdmin";
  const [dnsName, setDnsName] = useState("");
  const [dnsRecordType, setDnsRecordType] = useState<DnsRecordType>("A");
  const [dnsResult, setDnsResult] = useState<DnsLookupResult | null>(null);
  const [dnsError, setDnsError] = useState<string | null>(null);
  const [dnsLoading, setDnsLoading] = useState(false);
  const [reverseDnsIp, setReverseDnsIp] = useState("");
  const [reverseDnsResult, setReverseDnsResult] = useState<ReverseDnsResult | null>(null);
  const [reverseDnsError, setReverseDnsError] = useState<string | null>(null);
  const [reverseDnsLoading, setReverseDnsLoading] = useState(false);
  const [pingHostValue, setPingHostValue] = useState("");
  const [pingCount, setPingCount] = useState("4");
  const [pingTimeout, setPingTimeout] = useState("3");
  const [pingResult, setPingResult] = useState<PingResult | null>(null);
  const [pingError, setPingError] = useState<string | null>(null);
  const [pingLoading, setPingLoading] = useState(false);
  const [tracerouteHostValue, setTracerouteHostValue] = useState("");
  const [tracerouteMaxHops, setTracerouteMaxHops] = useState("20");
  const [tracerouteTimeout, setTracerouteTimeout] = useState("3");
  const [tracerouteResult, setTracerouteResult] = useState<TracerouteResult | null>(null);
  const [tracerouteError, setTracerouteError] = useState<string | null>(null);
  const [tracerouteLoading, setTracerouteLoading] = useState(false);
  const [tcpHostValue, setTcpHostValue] = useState("");
  const [tcpPort, setTcpPort] = useState("443");
  const [tcpTimeout, setTcpTimeout] = useState("3");
  const [tcpProtocol, setTcpProtocol] = useState<"tcp" | "udp">("tcp");
  const [tcpResult, setTcpResult] = useState<TcpPortCheckResult | null>(null);
  const [tcpError, setTcpError] = useState<string | null>(null);
  const [tcpLoading, setTcpLoading] = useState(false);
  const [subnetIp, setSubnetIp] = useState("");
  const [subnetPrefix, setSubnetPrefix] = useState(24);
  const [subnetSubmittedIp, setSubnetSubmittedIp] = useState("");
  const [subnetResult, setSubnetResult] = useState<SubnetCalculatorResult | null>(null);
  const [subnetError, setSubnetError] = useState<string | null>(null);
  const [subnetLoading, setSubnetLoading] = useState(false);
  const [snmpHost, setSnmpHost] = useState("");
  const [snmpProfiles, setSnmpProfiles] = useState<SnmpProfile[]>([]);
  const [snmpProfileId, setSnmpProfileId] = useState("");
  const [snmpCommunity, setSnmpCommunity] = useState("public");
  const [snmpPort, setSnmpPort] = useState("161");
  const [snmpTimeout, setSnmpTimeout] = useState("3");
  const [snmpResult, setSnmpResult] = useState<SnmpProbeResult | null>(null);
  const [snmpError, setSnmpError] = useState<string | null>(null);
  const [snmpLoading, setSnmpLoading] = useState(false);
  const [lldpDeviceId, setLldpDeviceId] = useState<string>(() => String(selectedDevice?.id ?? ""));
  const [lldpNeighbours, setLldpNeighbours] = useState<LldpNeighbour[]>([]);
  const [lldpError, setLldpError] = useState<string | null>(null);
  const [lldpLoading, setLldpLoading] = useState(false);
  const [lldpScanned, setLldpScanned] = useState(false);
  const [recentRuns, setRecentRuns] = useState<ToolRun[]>(() => loadStoredRuns<ToolRun>(TOOLS_RECENT_KEY, 30));
  const [savedResults, setSavedResults] = useState<SavedToolResult[]>(() => loadStoredRuns<SavedToolResult>(TOOLS_SAVED_KEY, 15));

  const activeTarget = selectedDevice?.ip_address ?? "";
  const [activeTool, setActiveTool] = useState<ToolId>("dns");
  const activeToolDefinition = TOOL_DEFINITIONS.find((tool) => tool.id === activeTool) ?? TOOL_DEFINITIONS[0];

  useEffect(() => {
    window.localStorage.setItem(TOOLS_RECENT_KEY, JSON.stringify(recentRuns));
  }, [recentRuns]);

  useEffect(() => {
    let compact = savedResults;
    while (compact.length > 0) {
      try {
        window.localStorage.setItem(TOOLS_SAVED_KEY, JSON.stringify(compact));
        if (compact.length !== savedResults.length) setSavedResults(compact);
        return;
      } catch {
        // Large SNMP responses can exceed browser storage. Drop the oldest
        // saved result until the newest useful set fits.
        compact = compact.slice(0, -1);
      }
    }
    window.localStorage.removeItem(TOOLS_SAVED_KEY);
    if (savedResults.length > 0) setSavedResults([]);
  }, [savedResults]);

  function recordRun(run: Omit<ToolRun, "id" | "ranAt">) {
    const entry: ToolRun = {
      ...run,
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      ranAt: new Date().toISOString(),
    };
    setRecentRuns((current) => [entry, ...current].slice(0, 30));
    return entry;
  }

  function saveRun(run: ToolRun) {
    if (run.status !== "success" || run.result === null) return;
    setSavedResults((current) => {
      if (current.some((item) => item.id === run.id)) return current;
      return [{ ...run, savedAt: new Date().toISOString() }, ...current].slice(0, 15);
    });
  }

  function restoreRun(run: ToolRun) {
    setActiveTool(run.tool);
    if (run.tool === "dns") {
      setDnsName(String(run.inputs.name || ""));
      setDnsRecordType(String(run.inputs.recordType || "A") as DnsRecordType);
      if (run.result) setDnsResult(run.result as DnsLookupResult);
    } else if (run.tool === "reverse-dns") {
      setReverseDnsIp(String(run.inputs.ip || ""));
      if (run.result) setReverseDnsResult(run.result as ReverseDnsResult);
    } else if (run.tool === "ping") {
      setPingHostValue(String(run.inputs.host || ""));
      setPingCount(String(run.inputs.count || "4"));
      setPingTimeout(String(run.inputs.timeout || "3"));
      if (run.result) setPingResult(run.result as PingResult);
    } else if (run.tool === "traceroute") {
      setTracerouteHostValue(String(run.inputs.host || ""));
      setTracerouteMaxHops(String(run.inputs.maxHops || "20"));
      setTracerouteTimeout(String(run.inputs.timeout || "3"));
      if (run.result) setTracerouteResult(run.result as TracerouteResult);
    } else if (run.tool === "tcp") {
      setTcpHostValue(String(run.inputs.host || ""));
      setTcpPort(String(run.inputs.port || "443"));
      setTcpTimeout(String(run.inputs.timeout || "3"));
      setTcpProtocol(String(run.inputs.protocol || "tcp") as "tcp" | "udp");
      if (run.result) setTcpResult(run.result as TcpPortCheckResult);
    } else if (run.tool === "subnet") {
      setSubnetIp(String(run.inputs.ip || ""));
      setSubnetPrefix(Number(run.inputs.prefix || 24));
      if (run.result) setSubnetResult(run.result as SubnetCalculatorResult);
    } else if (run.tool === "snmp") {
      setSnmpHost(String(run.inputs.host || ""));
      setSnmpProfileId(String(run.inputs.profileId || ""));
      setSnmpPort(String(run.inputs.port || "161"));
      setSnmpTimeout(String(run.inputs.timeout || "3"));
      if (run.result) setSnmpResult(run.result as SnmpProbeResult);
    }
  }

  async function copyRun(run: ToolRun) {
    await navigator.clipboard.writeText(JSON.stringify(run.result, null, 2));
  }

  function exportRun(run: ToolRun) {
    const blob = new Blob([JSON.stringify(run.result, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `netmap-${run.tool}-${run.target.replace(/[^a-z0-9.-]+/gi, "-")}.json`;
    link.click();
    URL.revokeObjectURL(url);
  }

  useEffect(() => {
    if (!selectedDevice) {
      return;
    }
    const ip = selectedDevice.ip_address ?? "";
    setReverseDnsIp(ip);
    setPingHostValue((current) => current || ip);
    setTracerouteHostValue((current) => current || ip);
    setTcpHostValue((current) => current || ip);
    setSnmpHost((current) => current || ip);
    setLldpDeviceId((current) => current || String(selectedDevice.id));
    if (selectedDevice.subnet) {
      const parts = selectedDevice.subnet.split("/");
      setSubnetIp(parts[0]);
      if (parts.length === 2) setSubnetPrefix(Number(parts[1]) || 24);
    } else {
      setSubnetIp((cur) => cur || selectedDevice.ip_address || "");
    }
  }, [selectedDevice]);

  useEffect(() => {
    api.listSnmpProfiles(accessToken).then(setSnmpProfiles).catch(() => {});
  }, [accessToken]);

  async function runDnsLookup(event: FormEvent) {
    event.preventDefault();
    setDnsLoading(true);
    setDnsError(null);
    try {
      const result = await api.dnsLookup(accessToken, { name: dnsName, record_type: dnsRecordType });
      setDnsResult(result);
      recordRun({ tool: "dns", target: dnsName, status: "success", summary: `${result.records.length} ${result.record_type} record${result.records.length === 1 ? "" : "s"}`, durationMs: result.duration_ms, inputs: { name: dnsName, recordType: dnsRecordType }, result });
    } catch (err) {
      const message = err instanceof Error ? err.message : "DNS lookup failed";
      setDnsError(message);
      recordRun({ tool: "dns", target: dnsName, status: "error", summary: message, durationMs: null, inputs: { name: dnsName, recordType: dnsRecordType }, result: null });
    } finally {
      setDnsLoading(false);
    }
  }

  async function runReverseDns(event: FormEvent) {
    event.preventDefault();
    setReverseDnsLoading(true);
    setReverseDnsError(null);
    try {
      const result = await api.reverseDns(accessToken, { ip_address: reverseDnsIp });
      setReverseDnsResult(result);
      recordRun({ tool: "reverse-dns", target: reverseDnsIp, status: "success", summary: `${result.ptr_records.length} PTR record${result.ptr_records.length === 1 ? "" : "s"}`, durationMs: result.duration_ms, inputs: { ip: reverseDnsIp }, result });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Reverse DNS lookup failed";
      setReverseDnsError(message);
      recordRun({ tool: "reverse-dns", target: reverseDnsIp, status: "error", summary: message, durationMs: null, inputs: { ip: reverseDnsIp }, result: null });
    } finally {
      setReverseDnsLoading(false);
    }
  }

  async function runPing(event: FormEvent) {
    event.preventDefault();
    if (!canRunActiveTools) {
      return;
    }
    setPingLoading(true);
    setPingError(null);
    try {
      const result = await api.ping(accessToken, {
          host: pingHostValue,
          count: Number(pingCount),
          timeout_seconds: Number(pingTimeout),
        });
      setPingResult(result);
      recordRun({ tool: "ping", target: pingHostValue, status: "success", summary: `${result.packet_loss ?? 0}% loss · ${formatMs(result.average_ms)} average`, durationMs: result.duration_ms, inputs: { host: pingHostValue, count: pingCount, timeout: pingTimeout }, result });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Ping failed";
      setPingError(message);
      recordRun({ tool: "ping", target: pingHostValue, status: "error", summary: message, durationMs: null, inputs: { host: pingHostValue, count: pingCount, timeout: pingTimeout }, result: null });
    } finally {
      setPingLoading(false);
    }
  }

  async function runTraceroute(event: FormEvent) {
    event.preventDefault();
    if (!canRunActiveTools) {
      return;
    }
    setTracerouteLoading(true);
    setTracerouteError(null);
    try {
      const result = await api.traceroute(accessToken, {
          host: tracerouteHostValue,
          max_hops: Number(tracerouteMaxHops),
          timeout_seconds: Number(tracerouteTimeout),
        });
      setTracerouteResult(result);
      recordRun({ tool: "traceroute", target: tracerouteHostValue, status: "success", summary: `${result.hops.length} hop${result.hops.length === 1 ? "" : "s"} traced`, durationMs: result.duration_ms, inputs: { host: tracerouteHostValue, maxHops: tracerouteMaxHops, timeout: tracerouteTimeout }, result });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Traceroute failed";
      setTracerouteError(message);
      recordRun({ tool: "traceroute", target: tracerouteHostValue, status: "error", summary: message, durationMs: null, inputs: { host: tracerouteHostValue, maxHops: tracerouteMaxHops, timeout: tracerouteTimeout }, result: null });
    } finally {
      setTracerouteLoading(false);
    }
  }

  async function runTcpCheck(event: FormEvent) {
    event.preventDefault();
    if (!canRunActiveTools) {
      return;
    }
    setTcpLoading(true);
    setTcpError(null);
    try {
      const result = await api.tcpCheck(accessToken, {
          host: tcpHostValue,
          port: Number(tcpPort),
          timeout_seconds: Number(tcpTimeout),
          protocol: tcpProtocol,
        });
      setTcpResult(result);
      recordRun({ tool: "tcp", target: `${tcpHostValue}:${tcpPort}`, status: "success", summary: `${tcpProtocol.toUpperCase()} service ${result.reachable ? "reachable" : "unreachable"}`, durationMs: result.duration_ms, inputs: { host: tcpHostValue, port: tcpPort, timeout: tcpTimeout, protocol: tcpProtocol }, result });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Port check failed";
      setTcpError(message);
      recordRun({ tool: "tcp", target: `${tcpHostValue}:${tcpPort}`, status: "error", summary: message, durationMs: null, inputs: { host: tcpHostValue, port: tcpPort, timeout: tcpTimeout, protocol: tcpProtocol }, result: null });
    } finally {
      setTcpLoading(false);
    }
  }

  async function runSubnetCalculation(event: FormEvent) {
    event.preventDefault();
    setSubnetLoading(true);
    setSubnetError(null);
    setSubnetSubmittedIp(subnetIp.trim());
    try {
      const result = await api.subnetCalculate(accessToken, { cidr: `${subnetIp.trim()}/${subnetPrefix}` });
      setSubnetResult(result);
      recordRun({ tool: "subnet", target: result.cidr, status: "success", summary: `${result.usable_hosts.toLocaleString()} usable hosts`, durationMs: null, inputs: { ip: subnetIp.trim(), prefix: subnetPrefix }, result });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Subnet calculation failed";
      setSubnetError(message);
      recordRun({ tool: "subnet", target: `${subnetIp.trim()}/${subnetPrefix}`, status: "error", summary: message, durationMs: null, inputs: { ip: subnetIp.trim(), prefix: subnetPrefix }, result: null });
    } finally {
      setSubnetLoading(false);
    }
  }

  async function runSnmpProbe(event: FormEvent) {
    event.preventDefault();
    if (!canRunActiveTools) {
      return;
    }
    setSnmpLoading(true);
    setSnmpError(null);
    try {
      const result = await api.snmpProbe(accessToken, {
          host: snmpHost,
          community: snmpProfileId ? null : snmpCommunity,
          profile_id: snmpProfileId ? Number(snmpProfileId) : null,
          port: Number(snmpPort),
          timeout_seconds: Number(snmpTimeout),
        });
      setSnmpResult(result);
      recordRun({ tool: "snmp", target: snmpHost, status: "success", summary: `${result.interfaces.length} interfaces · ${result.arp_entries.length} ARP rows`, durationMs: result.duration_ms, inputs: { host: snmpHost, profileId: snmpProfileId, port: snmpPort, timeout: snmpTimeout }, result });
    } catch (err) {
      const message = err instanceof Error ? err.message : "SNMP probe failed";
      setSnmpError(message);
      recordRun({ tool: "snmp", target: snmpHost, status: "error", summary: message, durationMs: null, inputs: { host: snmpHost, profileId: snmpProfileId, port: snmpPort, timeout: snmpTimeout }, result: null });
    } finally {
      setSnmpLoading(false);
    }
  }

  function applySelectedDevice() {
    if (!selectedDevice) {
      return;
    }
    const ip = selectedDevice.ip_address ?? "";
    setReverseDnsIp(ip);
    setPingHostValue(ip);
    setTracerouteHostValue(ip);
    setTcpHostValue(ip);
    setSnmpHost(ip);
    if (selectedDevice.subnet) {
      const parts = selectedDevice.subnet.split("/");
      setSubnetIp(parts[0]);
      if (parts.length === 2) setSubnetPrefix(Number(parts[1]) || 24);
    }
  }

  return (
    <section className="tools-layout tools-workspace" id="tools">
      {selectedDevice && (
        <div className="tool-target-strip tools-target-row nm-app-panel">
          <span>Selected topology device</span>
          <strong>{deviceLabel(selectedDevice)}</strong>
          <button type="button" className="nm-btn nm-btn--sm nm-btn--secondary" onClick={applySelectedDevice}>
            Use in forms
          </button>
        </div>
      )}
      <div className="tools-summary-grid nm-summary-band" aria-label="Tools summary">
        <div className="tools-summary-card nm-app-panel">
          <span className="tools-summary-icon"><IconLayoutDashboard size={20} /></span>
          <span><small>Available tools</small><strong>{TOOL_DEFINITIONS.length}</strong><em>Network diagnostics</em></span>
        </div>
        <div className="tools-summary-card nm-app-panel">
          <span className="tools-summary-icon tools-summary-icon--passive"><Clock3 size={20} /></span>
          <span><small>Recent checks</small><strong>{recentRuns.length}</strong><em>Stored on this browser</em></span>
        </div>
        <div className="tools-summary-card nm-app-panel">
          <span className="tools-summary-icon tools-summary-icon--active"><Bookmark size={20} /></span>
          <span><small>Saved results</small><strong>{savedResults.length}</strong><em>Reusable diagnostic evidence</em></span>
        </div>
        <div className="tools-summary-card nm-app-panel">
          <span className="tools-summary-icon tools-summary-icon--access"><IconTopologyRing size={20} /></span>
          <span><small>Access level</small><strong className="tools-summary-access">{canRunActiveTools ? "Full" : "Passive"}</strong><em>{canRunActiveTools ? "All tools available" : "Active checks restricted"}</em></span>
        </div>
      </div>
      <div className="tools-console-grid">
      <div className="tools-window">
        <nav className="tools-nav nm-workspace-tabs nm-workspace-tabs--attached" role="tablist" aria-label="Network tools">
          {TOOL_DEFINITIONS.map(({ id, label, Icon, passive }) => {
            const available = passive || canRunActiveTools;
            return (
              <button
                key={id}
                type="button"
                className={`tools-nav-item nm-workspace-tab${activeTool === id ? " tools-nav-item--active is-active" : ""}${!available ? " tools-nav-item--locked" : ""}`}
                role="tab"
                aria-selected={activeTool === id}
                aria-controls="tools-active-stage"
                onClick={() => setActiveTool(id)}
              >
                <Icon size={15} />
                <span className="tools-nav-label">{label}</span>
              </button>
            );
          })}
        </nav>
        <div className="tools-content nm-workspace-stage" id="tools-active-stage" role="tabpanel">
        <div className="tools-main">
          <div className="tools-main-inner">
          {activeTool === "dns" && <section className="tool-card nm-app-panel">
            <ToolPanelHeader icon={<Search size={18} />} title="DNS lookup" badge={<span className="tool-badge">Passive</span>} />
            <div className="dns-tool-layout">
              <div className="dns-query-column">
                <form className="tool-form dns-query-form" onSubmit={runDnsLookup}>
                  <label>
                    Query
                    <input required placeholder="example.com" value={dnsName} onChange={(event) => setDnsName(event.target.value)} />
                  </label>
                  <label>
                    Record type
                    <select value={dnsRecordType} onChange={(event) => setDnsRecordType(event.target.value as DnsRecordType)}>
                      <option value="A">A — IPv4 address</option>
                      <option value="AAAA">AAAA — IPv6 address</option>
                      <option value="MX">MX — Mail exchange</option>
                      <option value="TXT">TXT — Text record</option>
                      <option value="NS">NS — Name server</option>
                      <option value="CNAME">CNAME — Canonical name</option>
                    </select>
                  </label>
                  <div className="dns-common-types" aria-label="Common DNS record types">
                    <span>Common types</span>
                    {(["A", "AAAA", "CNAME", "MX", "TXT", "NS"] as DnsRecordType[]).map((type) => (
                      <button key={type} type="button" className={dnsRecordType === type ? "is-active" : ""} onClick={() => setDnsRecordType(type)}>{type}</button>
                    ))}
                  </div>
                  <div className="tool-form-actions dns-form-actions">
                    <button type="submit" className="nm-btn nm-btn--primary" disabled={dnsLoading}>
                      <Search size={15} />{dnsLoading ? "Running..." : "Lookup"}
                    </button>
                    <button type="button" className="nm-btn nm-btn--secondary" onClick={() => { setDnsName(""); setDnsResult(null); setDnsError(null); }}>Clear</button>
                  </div>
                </form>
                {dnsError && <div className="form-error">{dnsError}</div>}
                <section className="dns-recent-panel" aria-label="Recent DNS lookups">
                  <div className="dns-section-heading"><span>Recent lookups</span><small>{recentRuns.filter((run) => run.tool === "dns").length}</small></div>
                  <div className="dns-recent-list">
                    {recentRuns.filter((run) => run.tool === "dns").length === 0 && <p>No DNS lookups yet.</p>}
                    {recentRuns.filter((run) => run.tool === "dns").slice(0, 6).map((run) => (
                      <button type="button" key={run.id} onClick={() => restoreRun(run)}>
                        <Clock3 size={13} />
                        <span><strong>{run.target}</strong><small>{String(run.inputs.recordType || "A")}</small></span>
                        <time>{relativeRunTime(run.ranAt)}</time>
                      </button>
                    ))}
                  </div>
                </section>
              </div>

              <div className="dns-results-column">
                {!dnsResult && !dnsLoading && (
                  <div className="dns-result-placeholder">
                    <Search size={24} />
                    <strong>Run a DNS lookup</strong>
                    <span>Record details, resolver metadata and response timing will appear here.</span>
                  </div>
                )}
                {dnsResult && (
                  <div className="dns-result-workspace">
                    <div className="dns-section-heading"><span>Summary</span><small>{dnsResult.queried_name}</small></div>
                    <div className="dns-summary-grid">
                      <div><small>Status</small><strong className={dnsResult.response_code === "NOERROR" ? "is-success" : "is-warning"}>{dnsResult.response_code || "Complete"}</strong></div>
                      <div><small>Query time</small><strong>{dnsResult.duration_ms} ms</strong></div>
                      <div><small>DNS server</small><strong>{dnsResult.dns_server || dnsResult.source}</strong></div>
                      <div><small>Record type</small><strong>{dnsResult.record_type}</strong></div>
                      <div><small>Answers</small><strong>{dnsResult.records.length}</strong></div>
                    </div>

                    <section className="dns-answer-panel">
                      <div className="dns-section-heading">
                        <span>Answers</span>
                        {dnsResult.records.length > 0 && <button type="button" onClick={() => void navigator.clipboard.writeText(dnsResult.records.map((record) => record.value).join("\n"))}><Copy size={13} /> Copy all</button>}
                      </div>
                      {dnsResult.records.length === 0 ? (
                        <p className="tool-result-empty">No {dnsResult.record_type} records were returned.</p>
                      ) : (
                        <div className="dns-answer-table" role="table" aria-label="DNS answers">
                          <div className="dns-answer-row is-header" role="row"><span>Value</span><span>TTL</span><span aria-label="Actions" /></div>
                          {dnsResult.records.map((record) => (
                            <div className="dns-answer-row" role="row" key={`${dnsResult.record_type}-${record.value}`}>
                              <code>{record.value}</code>
                              <span>{record.ttl != null ? `${record.ttl}s` : "—"}</span>
                              <button type="button" onClick={() => void navigator.clipboard.writeText(record.value)} aria-label={`Copy ${record.value}`}><Copy size={14} /></button>
                            </div>
                          ))}
                        </div>
                      )}
                    </section>

                    {dnsResult.canonical_name && dnsResult.canonical_name !== dnsResult.queried_name && (
                      <div className="dns-canonical-row"><span>Canonical name</span><code>{dnsResult.canonical_name}</code></div>
                    )}
                    <details className="dns-detail-row">
                      <summary>Query details <span>{dnsResult.source}</span></summary>
                      <dl><dt>Queried name</dt><dd>{dnsResult.queried_name}</dd><dt>Resolver</dt><dd>{dnsResult.dns_server || dnsResult.source}</dd><dt>Response</dt><dd>{dnsResult.response_code}</dd></dl>
                    </details>
                    <details className="dns-detail-row">
                      <summary>Raw response <span>{dnsResult.records.length}</span></summary>
                      <pre>{JSON.stringify(dnsResult, null, 2)}</pre>
                    </details>
                    <div className="dns-tool-tip"><IconWorld size={16} /><span><strong>Tip:</strong> Use Reverse DNS to resolve a hostname from an IP address.</span><button type="button" onClick={() => setActiveTool("reverse-dns")}>Run Reverse DNS</button></div>
                  </div>
                )}
              </div>
            </div>
          </section>}

          {activeTool === "reverse-dns" && <section className="tool-card nm-app-panel">
            <ToolPanelHeader icon={<IconWorld size={18} />} title="Reverse DNS" badge={<span className="tool-badge">Passive</span>} />
            <form className="tool-form" onSubmit={runReverseDns}>
              <label>
                IP address
                <input required value={reverseDnsIp} placeholder="192.168.1.100" onChange={(event) => setReverseDnsIp(event.target.value)} />
              </label>
              <div className="tool-form-actions">
                <button type="submit" className="nm-btn nm-btn--primary" disabled={reverseDnsLoading}>
                  {reverseDnsLoading ? "Running..." : "Lookup"}
                </button>
              </div>
            </form>
            {reverseDnsError && <div className="form-error">{reverseDnsError}</div>}
            {reverseDnsResult && (
              <div className="tool-result">
                <div className="tool-result-meta">
                  <span>{reverseDnsResult.source}</span>
                  <span>{reverseDnsResult.duration_ms} ms</span>
                </div>
                {reverseDnsResult.ptr_records.length === 0 ? (
                  <p className="tool-result-empty">No PTR records returned.</p>
                ) : (
                  <ul className="tool-result-list">
                    {reverseDnsResult.ptr_records.map((record) => (
                      <li key={record}>{record}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </section>}

          {activeTool === "ping" && <section className="tool-card nm-app-panel">
            <ToolPanelHeader
              icon={<IconWifi size={18} />}
              title="Ping test"
              badge={<span className={`tool-badge ${canRunActiveTools ? "active" : "locked"}`}>{canRunActiveTools ? "Active" : "Restricted"}</span>}
            />
            <form className="tool-form" onSubmit={runPing}>
              <label>
                Host
                <input required disabled={!canRunActiveTools} placeholder="192.168.1.1" value={pingHostValue} onChange={(event) => setPingHostValue(event.target.value)} />
              </label>
              <div className="tool-form-grid">
                <label>
                  Count
                  <input
                    min={1}
                    max={10}
                    required
                    type="number"
                    disabled={!canRunActiveTools}
                    value={pingCount}
                    onChange={(event) => setPingCount(event.target.value)}
                  />
                </label>
                <label>
                  Timeout
                  <input
                    min={1}
                    max={30}
                    required
                    type="number"
                    disabled={!canRunActiveTools}
                    value={pingTimeout}
                    onChange={(event) => setPingTimeout(event.target.value)}
                  />
                </label>
              </div>
              <div className="tool-form-actions">
                <button type="submit" className="nm-btn nm-btn--primary" disabled={pingLoading || !canRunActiveTools}>
                  {pingLoading ? "Running..." : "Ping"}
                </button>
              </div>
            </form>
            {!canRunActiveTools && <p className="tool-note">Active tools are disabled for this role.</p>}
            {pingError && <div className="form-error">{pingError}</div>}
            {pingResult && (
              <div className="tool-result">
                <div className="tool-result-meta">
                  <span>{pingResult.host}</span>
                  <span>{pingResult.duration_ms} ms</span>
                </div>
                <dl className="tool-result-pairs">
                  <dt>Packets</dt>
                  <dd>{`${pingResult.received ?? 0}/${pingResult.transmitted ?? 0}`}</dd>
                  <dt>Loss</dt>
                  <dd>{pingResult.packet_loss !== null ? `${pingResult.packet_loss}%` : "-"}</dd>
                  <dt>Avg RTT</dt>
                  <dd>{formatMs(pingResult.average_ms)}</dd>
                </dl>
                <pre className="tool-output">{pingResult.raw_output}</pre>
              </div>
            )}
          </section>}

          {activeTool === "traceroute" && <section className="tool-card nm-app-panel">
            <ToolPanelHeader
              icon={<Network size={18} />}
              title="Traceroute"
              badge={<span className={`tool-badge ${canRunActiveTools ? "active" : "locked"}`}>{canRunActiveTools ? "Active" : "Restricted"}</span>}
            />
            <form className="tool-form" onSubmit={runTraceroute}>
              <label>
                Host
                <input required disabled={!canRunActiveTools} placeholder="192.168.1.1" value={tracerouteHostValue} onChange={(event) => setTracerouteHostValue(event.target.value)} />
              </label>
              <div className="tool-form-grid">
                <label>
                  Max hops
                  <input
                    min={1}
                    max={64}
                    required
                    type="number"
                    disabled={!canRunActiveTools}
                    value={tracerouteMaxHops}
                    onChange={(event) => setTracerouteMaxHops(event.target.value)}
                  />
                </label>
                <label>
                  Timeout
                  <input
                    min={1}
                    max={60}
                    required
                    type="number"
                    disabled={!canRunActiveTools}
                    value={tracerouteTimeout}
                    onChange={(event) => setTracerouteTimeout(event.target.value)}
                  />
                </label>
              </div>
              <div className="tool-form-actions">
                <button type="submit" className="nm-btn nm-btn--primary" disabled={tracerouteLoading || !canRunActiveTools}>
                  {tracerouteLoading ? "Running..." : "Trace route"}
                </button>
              </div>
            </form>
            {!canRunActiveTools && <p className="tool-note">Active tools are disabled for this role.</p>}
            {tracerouteError && <div className="form-error">{tracerouteError}</div>}
            {tracerouteResult && (
              <div className="tool-result">
                <div className="tool-result-meta">
                  <span>{tracerouteResult.host}</span>
                  <span>{tracerouteResult.duration_ms} ms</span>
                </div>
                {tracerouteResult.hops.length === 0 ? (
                  <p className="tool-result-empty">No hops parsed from traceroute output.</p>
                ) : (
                  <div className="tool-hop-list">
                    {tracerouteResult.hops.map((hop) => (
                      <div className="tool-hop-row" key={`${hop.hop}-${hop.address || "unknown"}`}>
                        <span>Hop {hop.hop}</span>
                        <span>{hop.address || hop.host || "*"}</span>
                        <span>{formatMs(hop.rtt_ms)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </section>}

          {activeTool === "tcp" && <section className="tool-card nm-app-panel">
            <ToolPanelHeader
              icon={<IconServer size={18} />}
              title="Port check"
              badge={<span className={`tool-badge ${canRunActiveTools ? "active" : "locked"}`}>{canRunActiveTools ? "Active" : "Restricted"}</span>}
            />
            <form className="tool-form" onSubmit={runTcpCheck}>
              <label>
                Host
                <input required disabled={!canRunActiveTools} placeholder="192.168.1.1" value={tcpHostValue} onChange={(event) => setTcpHostValue(event.target.value)} />
              </label>
              <div className="tool-form-grid">
                <label>
                  Protocol
                  <select value={tcpProtocol} disabled={!canRunActiveTools} onChange={(event) => setTcpProtocol(event.target.value as "tcp" | "udp")}>
                    <option value="tcp">TCP</option>
                    <option value="udp">UDP</option>
                  </select>
                </label>
                <label>
                  Port
                  <input
                    min={1}
                    max={65535}
                    required
                    type="number"
                    disabled={!canRunActiveTools}
                    value={tcpPort}
                    onChange={(event) => setTcpPort(event.target.value)}
                  />
                </label>
                <label>
                  Timeout
                  <input
                    min={1}
                    max={30}
                    required
                    type="number"
                    disabled={!canRunActiveTools}
                    value={tcpTimeout}
                    onChange={(event) => setTcpTimeout(event.target.value)}
                  />
                </label>
              </div>
              <div className="tool-form-actions">
                <button type="submit" className="nm-btn nm-btn--primary" disabled={tcpLoading || !canRunActiveTools}>
                  {tcpLoading ? "Running..." : "Check port"}
                </button>
              </div>
            </form>
            {!canRunActiveTools && <p className="tool-note">Active tools are disabled for this role.</p>}
            {tcpError && <div className="form-error">{tcpError}</div>}
            {tcpResult && (
              <div className="tool-result">
                <div className="tool-result-meta">
                  <span>{`${tcpResult.protocol.toUpperCase()} ${tcpResult.host}:${tcpResult.port}`}</span>
                  <span>{tcpResult.duration_ms} ms</span>
                </div>
                <p className={tcpResult.reachable ? "tool-status success" : "tool-status danger"}>
                  {tcpResult.reachable ? "Reachable" : "Unreachable"}
                </p>
                <p className="tool-note">{tcpResult.detail}</p>
              </div>
            )}
          </section>}

          {activeTool === "subnet" && <section className="tool-card nm-app-panel">
            <ToolPanelHeader icon={<IconLayoutDashboard size={18} />} title="Subnet calculator" badge={<span className="tool-badge">Passive</span>} />
            <form className="tool-form" onSubmit={runSubnetCalculation}>
              <div className="subnet-input-row">
                <label className="subnet-ip-label">
                  IP Address
                  <input required placeholder="192.168.1.0" value={subnetIp} onChange={(e) => setSubnetIp(e.target.value)} />
                </label>
                <label className="subnet-prefix-label">
                  Prefix / Mask
                  <select value={subnetPrefix} onChange={(e) => setSubnetPrefix(Number(e.target.value))}>
                    {Array.from({ length: 32 }, (_, i) => i + 1).map((p) => (
                      <option key={p} value={p}>{`/${p} — ${prefixToMask(p)}`}</option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="tool-form-actions">
                <button type="submit" className="nm-btn nm-btn--primary" disabled={subnetLoading}>
                  {subnetLoading ? "Calculating…" : "Calculate"}
                </button>
              </div>
            </form>
            {subnetError && <div className="form-error">{subnetError}</div>}
            {subnetResult && (
              <div className="tool-result">
                <dl className="subnet-result-dl">
                  <div className="subnet-row subnet-row--highlight">
                    <dt>Usable host range</dt>
                    <dd>
                      {subnetResult.first_host && subnetResult.last_host
                        ? `${subnetResult.first_host} – ${subnetResult.last_host}`
                        : "N/A (host address)"}
                    </dd>
                  </div>
                  <div className="subnet-row">
                    <dt>Network address</dt>
                    <dd>{subnetResult.network}/{subnetResult.prefix_length}</dd>
                  </div>
                  {subnetResult.broadcast && (
                    <div className="subnet-row">
                      <dt>Broadcast address</dt>
                      <dd>{subnetResult.broadcast}</dd>
                    </div>
                  )}
                  <div className="subnet-row">
                    <dt>Subnet mask</dt>
                    <dd>{subnetResult.netmask}</dd>
                  </div>
                  <div className="subnet-row">
                    <dt>Wildcard mask</dt>
                    <dd>{wildcardMask(subnetResult.netmask)}</dd>
                  </div>
                  <div className="subnet-row">
                    <dt>Total hosts</dt>
                    <dd>{subnetResult.total_addresses.toLocaleString()}</dd>
                  </div>
                  <div className="subnet-row">
                    <dt>Usable hosts</dt>
                    <dd>{subnetResult.usable_hosts.toLocaleString()}</dd>
                  </div>
                  {subnetResult.version === 4 && subnetSubmittedIp && (
                    <>
                      <div className="subnet-row">
                        <dt>IP class</dt>
                        <dd>Class {ipClass(subnetSubmittedIp)}</dd>
                      </div>
                      <div className="subnet-row">
                        <dt>IP type</dt>
                        <dd>{ipType(subnetSubmittedIp)}</dd>
                      </div>
                    </>
                  )}
                </dl>
                <div className="subnet-ref">
                  <div className="subnet-ref-title">Common subnet reference</div>
                  <table className="subnet-ref-table">
                    <thead>
                      <tr>
                        <th>Prefix</th>
                        <th>Subnet mask</th>
                        <th>Usable hosts</th>
                      </tr>
                    </thead>
                    <tbody>
                      {SUBNET_REF.map((row) => (
                        <tr key={row.prefix} className={row.prefix === subnetResult.prefix_length ? "subnet-ref-current" : ""}>
                          <td>/{row.prefix}</td>
                          <td>{row.mask}</td>
                          <td>{row.hosts.toLocaleString()}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </section>}

          {activeTool === "snmp" && <section className="tool-card nm-app-panel">
            <ToolPanelHeader
              icon={<IconRouter size={18} />}
              title="SNMP probe"
              badge={<span className={`tool-badge ${canRunActiveTools ? "active" : "locked"}`}>{canRunActiveTools ? "Active" : "Restricted"}</span>}
            />
            <form className="tool-form" onSubmit={runSnmpProbe}>
              <label>
                Profile
                <select disabled={!canRunActiveTools} value={snmpProfileId} onChange={(event) => setSnmpProfileId(event.target.value)}>
                  <option value="">Manual community</option>
                  {snmpProfiles.map((profile) => (
                    <option key={profile.id} value={String(profile.id)}>
                      {profile.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Host
                <input required disabled={!canRunActiveTools} placeholder="192.168.1.1" value={snmpHost} onChange={(event) => setSnmpHost(event.target.value)} />
              </label>
              {!snmpProfileId && <label>
                Community
                <input required disabled={!canRunActiveTools} value={snmpCommunity} onChange={(event) => setSnmpCommunity(event.target.value)} />
              </label>}
              <div className="tool-form-grid">
                {!snmpProfileId && <label>
                  Port
                  <input
                    min={1}
                    max={65535}
                    required
                    type="number"
                    disabled={!canRunActiveTools}
                    value={snmpPort}
                    onChange={(event) => setSnmpPort(event.target.value)}
                  />
                </label>}
                {!snmpProfileId && <label>
                  Timeout
                  <input
                    min={1}
                    max={15}
                    required
                    type="number"
                    disabled={!canRunActiveTools}
                    value={snmpTimeout}
                    onChange={(event) => setSnmpTimeout(event.target.value)}
                  />
                </label>}
              </div>
              <div className="tool-form-actions">
                <button type="submit" className="nm-btn nm-btn--primary" disabled={snmpLoading || !canRunActiveTools}>
                  {snmpLoading ? "Running..." : "Probe"}
                </button>
              </div>
            </form>
            {!canRunActiveTools && <p className="tool-note">Active tools are disabled for this role.</p>}
            {snmpError && <div className="form-error">{snmpError}</div>}
            {snmpResult && (
              <div className="tool-result">
                <div className="tool-result-meta">
                  <span>{snmpResult.host}</span>
                  <span>{snmpResult.duration_ms} ms</span>
                </div>
                <dl className="tool-result-pairs">
                  <dt>System name</dt>
                  <dd>{snmpResult.sys_name || "-"}</dd>
                  <dt>Uptime</dt>
                  <dd>{snmpResult.sys_uptime_seconds !== null ? formatMs(snmpResult.sys_uptime_seconds * 1000) : "-"}</dd>
                  <dt>Interfaces</dt>
                  <dd>{snmpResult.interfaces.length}</dd>
                  <dt>ARP rows</dt>
                  <dd>{snmpResult.arp_entries.length}</dd>
                </dl>
                {snmpResult.sys_descr && <p className="tool-note">{snmpResult.sys_descr}</p>}
                {snmpResult.interfaces.length > 0 && (
                  <div className="tool-hop-list">
                    {snmpResult.interfaces.slice(0, 12).map((item) => (
                      <div className="tool-hop-row" key={`if-${item.index}`}>
                        <span>{`if${item.index}`}</span>
                        <span>{item.name || "-"}</span>
                        <span>{item.oper_status || "-"}</span>
                      </div>
                    ))}
                  </div>
                )}
                {snmpResult.arp_entries.length > 0 && (
                  <div className="tool-hop-list">
                    {snmpResult.arp_entries.slice(0, 20).map((item) => (
                      <div className="tool-hop-row" key={`${item.ip_address}-${item.mac_address}`}>
                        <span>{item.ip_address}</span>
                        <span>{item.mac_address}</span>
                        <span>{item.vendor || `if${item.interface_index ?? "-"}`}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </section>}

          {activeTool === "lldp" && <section className="tool-card">
            <form onSubmit={async (e) => {
              e.preventDefault();
              const id = Number(lldpDeviceId);
              if (!id) return;
              setLldpLoading(true);
              setLldpError(null);
              setLldpNeighbours([]);
              try {
                const result = await api.lldpScan(accessToken, id);
                if (result.error) setLldpError(result.error);
                setLldpNeighbours(result.neighbours);
                setLldpScanned(true);
              } catch (err) {
                setLldpError(err instanceof Error ? err.message : "Scan failed.");
              } finally {
                setLldpLoading(false);
              }
            }}>
              <div className="tool-form-header">
                <h3>LLDP Neighbours</h3>
              </div>
              <label>
                Device (must have SNMP profile assigned)
                <select
                  value={lldpDeviceId}
                  onChange={(e) => setLldpDeviceId(e.target.value)}
                  disabled={!canRunActiveTools}
                >
                  <option value="">— select a device —</option>
                  {graph.devices.map((d) => (
                    <option key={d.id} value={String(d.id)}>
                      {deviceLabel(d)} ({d.ip_address})
                    </option>
                  ))}
                </select>
              </label>
              <button type="submit" disabled={lldpLoading || !canRunActiveTools || !lldpDeviceId}>
                {lldpLoading ? "Scanning…" : "Scan LLDP"}
              </button>
            </form>
            {lldpError && <div className="form-error">{lldpError}</div>}
            {lldpNeighbours.length > 0 && (
              <div className="tool-result">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Local port</th>
                      <th>Remote name</th>
                      <th>Chassis ID</th>
                      <th>Mgmt IP</th>
                      <th>Remote port</th>
                      <th>Matched device</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {lldpNeighbours.map((n) => {
                      const matched = n.matched_device_id
                        ? graph.devices.find((d) => d.id === n.matched_device_id)
                        : null;
                      return (
                        <tr key={n.id} style={{ opacity: n.dismissed ? 0.4 : 1 }}>
                          <td>{n.local_port_desc || n.local_port_id || `port ${n.local_port_index}`}</td>
                          <td>{n.remote_sys_name || "—"}</td>
                          <td style={{ fontFamily: "monospace", fontSize: 12 }}>{n.remote_chassis_id}</td>
                          <td>{n.remote_mgmt_addr || "—"}</td>
                          <td>{n.remote_port_desc || n.remote_port_id || "—"}</td>
                          <td>{matched ? deviceLabel(matched) : <span className="text-muted">unmatched</span>}</td>
                          <td style={{ display: "flex", gap: 6 }}>
                            {!n.dismissed && matched && (
                              <button
                                type="button"
                                className="btn-xs btn-primary"
                                onClick={async () => {
                                  try {
                                    await api.lldpCreateLink(accessToken, n.id);
                                    setLldpNeighbours((prev) => prev.map((x) => x.id === n.id ? { ...x, dismissed: true } : x));
                                  } catch { /* ignore */ }
                                }}
                              >
                                Create link
                              </button>
                            )}
                            <button
                              type="button"
                              className="btn-xs"
                              onClick={async () => {
                                const dismissed = !n.dismissed;
                                await api.patchLldpNeighbour(accessToken, n.id, { dismissed });
                                setLldpNeighbours((prev) => prev.map((x) => x.id === n.id ? { ...x, dismissed } : x));
                              }}
                            >
                              {n.dismissed ? "Restore" : "Dismiss"}
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            {!lldpLoading && !lldpError && !lldpScanned && (
              <p className="tool-result-empty">Select a device with an SNMP profile assigned and click Scan LLDP.</p>
            )}
            {!lldpLoading && !lldpError && lldpScanned && lldpNeighbours.length === 0 && (
              <p className="tool-result-empty">No LLDP neighbours found. The device responded via SNMP but its LLDP-MIB table is empty — check that the LLDP daemon is configured to expose its neighbour table via SNMP (see notes below).</p>
            )}
          </section>}

          </div>
        </div>
      </div>
      </div>
        <aside className="tools-support-rail" aria-label="Tool activity and guidance">
          <section className="tools-activity nm-app-panel" aria-label="Recent activity">
            <div className="tools-side-header">
              <span>Recent activity</span>
              {recentRuns.length > 0 && (
                <button type="button" className="tools-header-action" onClick={() => setRecentRuns([])}>Clear</button>
              )}
            </div>
            <div className="tools-run-list">
              {recentRuns.length === 0 && <p className="tools-rail-empty">Completed checks will appear here.</p>}
              {recentRuns.slice(0, 6).map((run) => {
                const definition = toolDefinition(run.tool);
                const Icon = definition.Icon;
                return (
                  <article className="tools-run-item" key={run.id}>
                    <button type="button" className="tools-run-main" onClick={() => restoreRun(run)} aria-label={`Open ${definition.label} result for ${run.target}`}>
                      <span className={`tools-run-icon is-${run.status}`}><Icon size={15} /></span>
                      <span className="tools-run-copy">
                        <strong>{definition.label}</strong>
                        <span>{run.target || "No target"}</span>
                        <small>{run.summary}</small>
                      </span>
                      <time>{relativeRunTime(run.ranAt)}</time>
                    </button>
                    {run.status === "success" && run.result !== null && (
                      <div className="tools-run-actions">
                        <button type="button" onClick={() => saveRun(run)} disabled={savedResults.some((item) => item.id === run.id)} aria-label={`Save ${definition.label} result`} title="Save result"><Bookmark size={14} /></button>
                        <button type="button" onClick={() => void copyRun(run)} aria-label={`Copy ${definition.label} result`} title="Copy JSON"><Copy size={14} /></button>
                        <button type="button" onClick={() => exportRun(run)} aria-label={`Export ${definition.label} result`} title="Export JSON"><Download size={14} /></button>
                      </div>
                    )}
                  </article>
                );
              })}
            </div>
          </section>

          <section className="tools-saved nm-app-panel" aria-label="Saved results">
            <div className="tools-side-header"><span>Saved results</span><small>{savedResults.length}</small></div>
            <div className="tools-run-list">
              {savedResults.length === 0 && <p className="tools-rail-empty">Save a completed check to keep its result and inputs.</p>}
              {savedResults.slice(0, 5).map((run) => {
                const definition = toolDefinition(run.tool);
                return (
                  <article className="tools-saved-item" key={run.id}>
                    <button type="button" className="tools-saved-main" onClick={() => restoreRun(run)}>
                      <span><CheckCircle2 size={14} />{definition.label}</span>
                      <strong>{run.target}</strong>
                      <small>{run.summary}</small>
                    </button>
                    <div className="tools-run-actions">
                      <button type="button" onClick={() => restoreRun(run)} aria-label={`Load ${definition.label} inputs`} title="Load inputs and result"><RotateCcw size={14} /></button>
                      <button type="button" onClick={() => exportRun(run)} aria-label={`Export saved ${definition.label} result`} title="Export JSON"><Download size={14} /></button>
                      <button type="button" onClick={() => setSavedResults((current) => current.filter((item) => item.id !== run.id))} aria-label={`Remove saved ${definition.label} result`} title="Remove"><Trash2 size={14} /></button>
                    </div>
                  </article>
                );
              })}
            </div>
          </section>

          <section className="tools-guide nm-app-panel" aria-label={`${activeToolDefinition.label} guide`}>
          <div className="tools-side-header">
            <span>How {activeToolDefinition.label} works</span>
            <span className={`tool-badge ${activeToolDefinition.passive ? "" : canRunActiveTools ? "active" : "locked"}`}>
              {activeToolDefinition.passive ? "Passive" : canRunActiveTools ? "Active" : "Restricted"}
            </span>
          </div>
          <div className="tools-guide-body">
            <p>{activeToolDefinition.guide}</p>
            <ol>
              {activeToolDefinition.steps.map((step, index) => (
                <li key={step}><span>{index + 1}</span><p>{step}</p></li>
              ))}
            </ol>
            <div className="tools-guide-note">
              <strong>Current target</strong>
              <span>{selectedDevice ? deviceLabel(selectedDevice) : "Enter a target in the tool form"}</span>
            </div>
          </div>
          </section>
        </aside>
      </div>
    </section>
  );
}
