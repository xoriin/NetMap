import { useState, useEffect, type FormEvent } from "react";
import { Search, Network } from "lucide-react";
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

  const activeTarget = selectedDevice?.ip_address ?? "";
  const [activeTool, setActiveTool] = useState("dns");

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
      setDnsResult(await api.dnsLookup(accessToken, { name: dnsName, record_type: dnsRecordType }));
    } catch (err) {
      setDnsError(err instanceof Error ? err.message : "DNS lookup failed");
    } finally {
      setDnsLoading(false);
    }
  }

  async function runReverseDns(event: FormEvent) {
    event.preventDefault();
    setReverseDnsLoading(true);
    setReverseDnsError(null);
    try {
      setReverseDnsResult(await api.reverseDns(accessToken, { ip_address: reverseDnsIp }));
    } catch (err) {
      setReverseDnsError(err instanceof Error ? err.message : "Reverse DNS lookup failed");
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
      setPingResult(
        await api.ping(accessToken, {
          host: pingHostValue,
          count: Number(pingCount),
          timeout_seconds: Number(pingTimeout),
        }),
      );
    } catch (err) {
      setPingError(err instanceof Error ? err.message : "Ping failed");
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
      setTracerouteResult(
        await api.traceroute(accessToken, {
          host: tracerouteHostValue,
          max_hops: Number(tracerouteMaxHops),
          timeout_seconds: Number(tracerouteTimeout),
        }),
      );
    } catch (err) {
      setTracerouteError(err instanceof Error ? err.message : "Traceroute failed");
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
      setTcpResult(
        await api.tcpCheck(accessToken, {
          host: tcpHostValue,
          port: Number(tcpPort),
          timeout_seconds: Number(tcpTimeout),
          protocol: tcpProtocol,
        }),
      );
    } catch (err) {
      setTcpError(err instanceof Error ? err.message : "Port check failed");
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
      setSubnetResult(await api.subnetCalculate(accessToken, { cidr: `${subnetIp.trim()}/${subnetPrefix}` }));
    } catch (err) {
      setSubnetError(err instanceof Error ? err.message : "Subnet calculation failed");
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
      setSnmpResult(
        await api.snmpProbe(accessToken, {
          host: snmpHost,
          community: snmpProfileId ? null : snmpCommunity,
          profile_id: snmpProfileId ? Number(snmpProfileId) : null,
          port: Number(snmpPort),
          timeout_seconds: Number(snmpTimeout),
        }),
      );
    } catch (err) {
      setSnmpError(err instanceof Error ? err.message : "SNMP probe failed");
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
    <section className="tools-layout" id="tools">
      {selectedDevice && (
        <div className="tool-target-strip tools-target-row">
          <span>Selected topology device</span>
          <strong>{deviceLabel(selectedDevice)}</strong>
          <button type="button" onClick={applySelectedDevice}>
            Use in forms
          </button>
        </div>
      )}
      <div className="tools-content">
        <nav className="tools-nav">
          {([
            { id: "dns",         label: "DNS Lookup",        Icon: Search,               passive: true  },
            { id: "reverse-dns", label: "Reverse DNS",       Icon: IconWorld,             passive: true  },
            { id: "ping",        label: "Ping Test",         Icon: IconWifi,              passive: false },
            { id: "traceroute",  label: "Traceroute",        Icon: Network,               passive: false },
            { id: "tcp",         label: "Port Check",        Icon: IconServer,            passive: false },
            { id: "subnet",      label: "Subnet Calculator", Icon: IconLayoutDashboard,   passive: true  },
            { id: "snmp",        label: "SNMP Probe",        Icon: IconRouter,            passive: false },
            // { id: "lldp",        label: "LLDP Neighbours",   Icon: IconTopologyRing,      passive: false },
          ] as const).map(({ id, label, Icon, passive }) => {
            const available = passive || canRunActiveTools;
            return (
              <button
                key={id}
                type="button"
                className={`tools-nav-item${activeTool === id ? " tools-nav-item--active" : ""}${!available ? " tools-nav-item--locked" : ""}`}
                onClick={() => setActiveTool(id)}
              >
                <Icon size={15} />
                <span className="tools-nav-label">{label}</span>
              </button>
            );
          })}
        </nav>
        <div className="tools-main">
          <div className="tools-main-inner">
          {activeTool === "dns" && <section className="tool-card">
            <div className="tool-card-header">
              <h3>DNS lookup</h3>
              <span className="tool-badge">Passive</span>
            </div>
            <form className="tool-form" onSubmit={runDnsLookup}>
              <label>
                Name
                <input required value={dnsName} onChange={(event) => setDnsName(event.target.value)} />
              </label>
              <label>
                Record type
                <select value={dnsRecordType} onChange={(event) => setDnsRecordType(event.target.value as DnsRecordType)}>
                  <option value="A">A</option>
                  <option value="AAAA">AAAA</option>
                  <option value="MX">MX</option>
                  <option value="TXT">TXT</option>
                  <option value="NS">NS</option>
                  <option value="CNAME">CNAME</option>
                </select>
              </label>
              <div className="tool-form-actions">
                <button type="submit" disabled={dnsLoading}>
                  {dnsLoading ? "Running..." : "Lookup"}
                </button>
              </div>
            </form>
            {dnsError && <div className="form-error">{dnsError}</div>}
            {dnsResult && (
              <div className="tool-result">
                <div className="tool-result-meta">
                  <span>{dnsResult.source}</span>
                  <span>{dnsResult.duration_ms} ms</span>
                </div>
                {dnsResult.records.length === 0 ? (
                  <p className="tool-result-empty">No records returned.</p>
                ) : (
                  <ul className="tool-result-list">
                    {dnsResult.records.map((record) => (
                      <li key={`${dnsResult.record_type}-${record.value}`}>{record.value}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </section>}

          {activeTool === "reverse-dns" && <section className="tool-card">
            <div className="tool-card-header">
              <h3>Reverse DNS</h3>
              <span className="tool-badge">Passive</span>
            </div>
            <form className="tool-form" onSubmit={runReverseDns}>
              <label>
                IP address
                <input required value={reverseDnsIp} placeholder="192.168.1.100" onChange={(event) => setReverseDnsIp(event.target.value)} />
              </label>
              <div className="tool-form-actions">
                <button type="submit" disabled={reverseDnsLoading}>
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

          {activeTool === "ping" && <section className="tool-card">
            <div className="tool-card-header">
              <h3>Ping test</h3>
              <span className={`tool-badge ${canRunActiveTools ? "active" : "locked"}`}>
                {canRunActiveTools ? "Active" : "Restricted"}
              </span>
            </div>
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
                <button type="submit" disabled={pingLoading || !canRunActiveTools}>
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

          {activeTool === "traceroute" && <section className="tool-card">
            <div className="tool-card-header">
              <h3>Traceroute</h3>
              <span className={`tool-badge ${canRunActiveTools ? "active" : "locked"}`}>
                {canRunActiveTools ? "Active" : "Restricted"}
              </span>
            </div>
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
                <button type="submit" disabled={tracerouteLoading || !canRunActiveTools}>
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

          {activeTool === "tcp" && <section className="tool-card">
            <div className="tool-card-header">
              <h3>Port check</h3>
              <span className={`tool-badge ${canRunActiveTools ? "active" : "locked"}`}>
                {canRunActiveTools ? "Active" : "Restricted"}
              </span>
            </div>
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
                <button type="submit" disabled={tcpLoading || !canRunActiveTools}>
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

          {activeTool === "subnet" && <section className="tool-card">
            <div className="tool-card-header">
              <h3>Subnet calculator</h3>
              <span className="tool-badge">Passive</span>
            </div>
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
                <button type="submit" disabled={subnetLoading}>
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

          {activeTool === "snmp" && <section className="tool-card">
            <div className="tool-card-header">
              <h3>SNMP probe</h3>
              <span className={`tool-badge ${canRunActiveTools ? "active" : "locked"}`}>
                {canRunActiveTools ? "Active" : "Restricted"}
              </span>
            </div>
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
                <button type="submit" disabled={snmpLoading || !canRunActiveTools}>
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
    </section>
  );
}
