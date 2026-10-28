/**
 * The backend reports a TLS issuer as its distinguished name, e.g.
 * "countryName=AT, organizationName=ZeroSSL, commonName=ZeroSSL RSA Domain Secure Site CA".
 * Show people the organisation: organizationName (or O), else commonName (or CN),
 * else the raw value. Values may be quoted ("Foo, Inc.") or escape commas (Foo\, Inc.).
 */
function parseIssuer(raw: string): Map<string, string> {
  const fields = new Map<string, string>();
  let key = "";
  let value = "";
  let inKey = true;
  let quoted = false;
  const flush = () => {
    const name = key.trim().toLowerCase();
    if (name && !fields.has(name)) fields.set(name, value.trim());
    key = ""; value = ""; inKey = true;
  };
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (ch === "\\" && i + 1 < raw.length) {
      i += 1;
      if (inKey) key += raw[i]; else value += raw[i];
    } else if (!inKey && ch === '"') {
      quoted = !quoted;
    } else if (inKey && ch === "=") {
      inKey = false;
    } else if (!quoted && (ch === "," || ch === "+")) {
      flush();
    } else if (inKey) {
      key += ch;
    } else {
      value += ch;
    }
  }
  flush();
  return fields;
}

export function issuerOrganisation(issuer: string | null | undefined): string | null {
  if (!issuer) return null;
  const fields = parseIssuer(issuer);
  return fields.get("organizationname") || fields.get("o")
    || fields.get("commonname") || fields.get("cn")
    || issuer;
}
