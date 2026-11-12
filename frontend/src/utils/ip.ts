export const DISCOVERY_MAX_HOSTS_WITHOUT_CONFIRMATION = 256;

export function prefixToMask(prefix: number): string {
  if (prefix === 0) return "0.0.0.0";
  const mask = (0xFFFFFFFF << (32 - prefix)) >>> 0;
  return [(mask >>> 24) & 0xFF, (mask >>> 16) & 0xFF, (mask >>> 8) & 0xFF, mask & 0xFF].join(".");
}

export function wildcardMask(netmask: string): string {
  return netmask.split(".").map((o) => 255 - Number(o)).join(".");
}

export function ipClass(ip: string): string {
  const first = Number(ip.split(".")[0]);
  if (first < 128) return "A";
  if (first < 192) return "B";
  if (first < 224) return "C";
  if (first < 240) return "D";
  return "E";
}

export function ipType(ip: string): string {
  const [a, b] = ip.split(".").map(Number);
  if (a === 10) return "Private";
  if (a === 172 && b >= 16 && b <= 31) return "Private";
  if (a === 192 && b === 168) return "Private";
  if (a === 127) return "Loopback";
  if (a === 169 && b === 254) return "Link-local";
  return "Public";
}

export function ipSortKey(value: string) {
  const match = value.match(/(\d+)\.(\d+)\.(\d+)\.(\d+)/);
  if (!match) return value;
  return match.slice(1).map((part) => part.padStart(3, "0")).join(".");
}

export function parseIpv4Parts(value: string) {
  const parts = value.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  return parts;
}

export function ipv4ToNumber(parts: number[]) {
  return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
}

export function estimateScanTarget(rawTarget: string) {
  const target = rawTarget.trim();
  if (!target) {
    return { hostCount: 0, label: "Enter a private target", help: "Single IP, IP range, and CIDR notation are supported." };
  }
  if (target.includes("/") && !target.includes(":")) {
    const [, prefixRaw] = target.split("/", 2);
    const prefix = Number(prefixRaw);
    if (Number.isInteger(prefix) && prefix >= 0 && prefix <= 32) {
      const hostCount = 2 ** (32 - prefix);
      return {
        hostCount,
        label: `${hostCount} IPv4 addresses`,
        help: hostCount > DISCOVERY_MAX_HOSTS_WITHOUT_CONFIRMATION ? "This is larger than a /24 and requires confirmation." : "Private /24-sized scans can start directly.",
      };
    }
  }
  if (target.includes("-")) {
    const [start, end] = target.split("-", 2).map((value) => value.trim());
    const startParts = parseIpv4Parts(start);
    const endParts = parseIpv4Parts(end);
    if (startParts && endParts) {
      const startValue = ipv4ToNumber(startParts);
      const endValue = ipv4ToNumber(endParts);
      const hostCount = Math.max(0, endValue - startValue + 1);
      return {
        hostCount,
        label: `${hostCount} IPv4 addresses`,
        help: hostCount > DISCOVERY_MAX_HOSTS_WITHOUT_CONFIRMATION ? "Large ranges require confirmation." : "Range is within the normal scan size.",
      };
    }
  }
  return { hostCount: 1, label: "1 target address", help: "Single-target scans can start directly." };
}

export function cidrUsableHosts(cidr: string | null | undefined): number | null {
  if (!cidr) return null;
  const match = cidr.match(/\/(\d+)$/);
  if (!match) return null;
  const prefix = parseInt(match[1], 10);
  if (prefix < 0 || prefix > 32) return null;
  if (prefix === 32) return 1;
  if (prefix === 31) return 2;
  return Math.pow(2, 32 - prefix) - 2;
}

export function formatUsableHosts(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}
