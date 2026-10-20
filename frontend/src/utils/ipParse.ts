function parseIpv4(text: string): bigint | null {
  const parts = text.split(".");
  if (parts.length !== 4) return null;
  let value = 0n;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = (value << 8n) | BigInt(octet);
  }
  return value;
}

/** Expands `::` compression and a trailing dotted-quad into exactly eight groups. */
function ipv6Groups(text: string): string[] | null {
  if (text.includes("%")) return null;
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const flatten = (chunk: string): string[] | null => {
    if (chunk === "") return [];
    const pieces = chunk.split(":");
    const out: string[] = [];
    for (let index = 0; index < pieces.length; index += 1) {
      const piece = pieces[index];
      if (piece.includes(".")) {
        if (index !== pieces.length - 1) return null;
        const embedded = parseIpv4(piece);
        if (embedded === null) return null;
        out.push(((embedded >> 16n) & 0xffffn).toString(16), (embedded & 0xffffn).toString(16));
      } else {
        if (!/^[0-9a-fA-F]{1,4}$/.test(piece)) return null;
        out.push(piece);
      }
    }
    return out;
  };
  const head = flatten(halves[0]);
  const tail = halves.length === 2 ? flatten(halves[1]) : [];
  if (head === null || tail === null) return null;
  if (halves.length === 2) {
    const missing = 8 - head.length - tail.length;
    if (missing < 1) return null;
    return [...head, ...Array<string>(missing).fill("0"), ...tail];
  }
  return head.length === 8 ? head : null;
}

export function parseIp(text: string): { value: bigint; version: 4 | 6 } | null {
  if (text.includes(":")) {
    const groups = ipv6Groups(text);
    if (groups === null) return null;
    let value = 0n;
    for (const group of groups) value = (value << 16n) | BigInt(parseInt(group, 16));
    return { value, version: 6 };
  }
  const value = parseIpv4(text);
  return value === null ? null : { value, version: 4 };
}

/** True when both strings parse to the same IPv4 or IPv6 address, whatever their spelling. */
export function sameIp(left: string | null | undefined, right: string | null | undefined) {
  const a = parseIp((left ?? "").trim());
  const b = parseIp((right ?? "").trim());
  return a !== null && b !== null && a.version === b.version && a.value === b.value;
}
