# Security Notes

NetMap is a self-hosted network visibility tool intended for home labs and small
trusted environments. It should not be treated as enterprise-hardened or safe for
direct internet exposure without additional review and deployment hardening.

This document tracks the current security posture and items to revisit before a
public security-focused release.

## Reporting Security Issues

Until a private disclosure channel is published, do not include exploit details,
secrets, logs, database files, or private network data in public issues.

Preferred handling:

1. Open a minimal GitHub issue stating that you have a security concern.
2. Share only the affected area and impact at a high level.
3. Move technical details to a private channel once one is available.

## Supported Scope

Security fixes are expected to target the current `main` branch and current
Docker image line. Older unpublished local builds are not supported.

## Deployment Baseline

For safer deployments:

- Set strong, stable `SECRET_KEY` and `MASTER_KEY` values before first start.
- Set `APP_URL` to the exact external URL users will open in a browser.
- Replace wildcard `TRUSTED_HOSTS` with exact hostnames before internet exposure.
- Set `SECURE_HSTS_ENABLED=true` only once NetMap will only ever be served over HTTPS on this hostname.
- Leave `AUTH_COOKIE_SECURE` unset so auth cookies are `Secure` whenever `APP_URL` is `https://`.
- Restrict syslog ingestion with `SYSLOG_SENDER_ALLOWLIST`.
- Prefer a reverse proxy with HTTPS, request-size limits, access logging, and
  network-level firewall rules.
- Keep the data directory backed up and protected by host filesystem permissions.

## Current Positive Controls

- Passwords are hashed with Argon2.
- Access tokens are short lived.
- Refresh token state is stored server-side and rotated.
- Refresh and access cookies are HttpOnly.
- Cookie-authenticated unsafe requests require a double-submit CSRF token.
- Password reset tokens are stored server-side and marked used after reset.
- Password reset emails use reset links rather than plaintext passwords.
- WebSocket authentication no longer places tokens in the URL query string.
- Frontend auth tokens are no longer persisted in `localStorage`.
- XLSX import support was removed to avoid the vulnerable `xlsx` dependency.
- SVG icon imports are sanitized with DOMPurify before rendering.
- Repeated failed logins trigger a per-account lockout (default: 5 attempts, 15-minute window). Locked accounts can be unlocked by a SuperAdmin via Admin → Users, or via direct database access using `docker exec` if the SuperAdmin account itself is locked — see [Account lockout recovery](README.md#-account-lockout-recovery) in the README.
- Nmap discovery blocks public IP targets and caps scan size.
- Active ping, traceroute, and TCP tools block public targets by default.
- Container defaults drop Linux capabilities and add only `NET_RAW`.

## Known Follow-Up Items

These are not necessarily exploitable in a default trusted-LAN deployment, but
they should be resolved or consciously accepted before calling the project
enterprise-ready.

### Password Reset URL Canonicalization

Password reset links use `APP_URL` when configured, otherwise they fall back to
the request base URL. For public deployments, require `APP_URL` at startup or
reject wildcard `TRUSTED_HOSTS` in production so reset links cannot be influenced
by an unexpected Host header.

### Public Defaults

The README and compose examples still prioritize LAN convenience:

- `TRUSTED_HOSTS: ["*"]`
- syslog listeners enabled
- `SYSLOG_SENDER_ALLOWLIST` optional

This is acceptable for a local-only quick start, but it should be clearly split
from a hardened public deployment profile.

### Backup Restore

Backup restore has a size cap and SQLite header check. A stronger design would
validate schema compatibility, use signed backups, and perform restore through a
staging database before replacing the live database.

### Outbound Notification URLs

Notification integrations can call configured outbound URLs and SMTP hosts.
Because this is SuperAdmin-controlled, it is an administrative trust boundary,
but hardened deployments may want egress allowlists or private-IP blocking for
notification endpoints.

### SVG/Icon Import Surface

DOMPurify reduces risk, but custom SVG import still renders sanitized markup via
`dangerouslySetInnerHTML`. Keep DOMPurify updated and consider replacing custom
SVG imports with a stricter server-side or build-time icon ingestion path.

## Last Review Snapshot

Date: 2026-05-18

Checks performed:

- `npm audit --audit-level=moderate`: passed, 0 vulnerabilities.
- `npm run build`: passed.
- Backend tests were not run in the local environment because `pytest` was not
  installed.
