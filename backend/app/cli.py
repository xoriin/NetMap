from __future__ import annotations

import argparse
import os
import pwd
import sys


def _drop_privileges(name: str) -> None:
    entry = pwd.getpwnam(name)
    os.setgroups([])
    os.setgid(entry.pw_gid)
    os.setuid(entry.pw_uid)


def _reset_2fa(db, username: str) -> int:
    from sqlalchemy import select

    from app.db.session import import_all_models
    from app.models.user import User
    from app.services import totp
    from app.services.audit.service import write_audit
    from app.services.auth import revoke_all_user_refresh_tokens

    import_all_models()
    user = db.scalar(select(User).where(User.username == username))
    if user is None:
        print(f"No user named {username}", file=sys.stderr)
        return 1
    totp.disable(db, user)
    revoke_all_user_refresh_tokens(db, user_id=user.id, reason="mfa_reset")
    write_audit(db, action="auth.mfa_reset", target=f"user:{user.username}", detail="source=console")
    db.commit()
    print(f"Two-factor authentication reset for {username}. Their sessions were signed out.")
    return 0


def main(argv: list[str] | None = None, *, session_factory=None) -> int:
    parser = argparse.ArgumentParser(prog="netmap-admin")
    commands = parser.add_subparsers(dest="command", required=True)
    reset = commands.add_parser("reset-2fa", help="Turn off two-factor authentication for a user")
    reset.add_argument("username")
    args = parser.parse_args(argv)

    if os.geteuid() != 0:
        print("netmap-admin must be run as root (docker exec runs as root by default).", file=sys.stderr)
        return 2
    try:
        _drop_privileges("netmap")
    except KeyError:
        print("netmap-admin: user 'netmap' not found; run this inside the NetMap container.", file=sys.stderr)
        return 3

    if session_factory is None:
        from app.db.session import SessionLocal

        session_factory = SessionLocal
    db = session_factory()
    try:
        return _reset_2fa(db, args.username)
    finally:
        db.close()


if __name__ == "__main__":
    raise SystemExit(main())
