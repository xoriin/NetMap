from __future__ import annotations

import hmac
import math
import threading
import time
from collections import deque
from datetime import datetime

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.status_page import StatusIntegrationToken, StatusIntegrationTokenPage, StatusPage
from app.models.user import User, UserRole
from app.services.api_keys.service import generate_scheme_key, hash_key
from app.services.audit.service import write_audit
from app.services.rbac.permissions import has_permission
from app.services.status_pages.incidents import LABEL_MAX, IncidentError, clean_text, now_or_utc
from app.services.status_pages.sources import _utc

TOKEN_SCHEME = "nmsp"
WRITE_LIMIT = 60
WRITE_WINDOW_SECONDS = 60.0


class TokenRejected(Exception):
    pass


class TokenError(ValueError):
    pass


def creator_may_manage(user: User | None) -> bool:
    if user is None or not user.is_active:
        return False
    return user.role == UserRole.SUPER_ADMIN or has_permission(user.role, "status_page_manage")


def scope_page_ids(db: Session, token_id: int) -> set[int]:
    return set(db.scalars(select(StatusIntegrationTokenPage.page_id).where(StatusIntegrationTokenPage.token_id == token_id)))


def is_active(token: StatusIntegrationToken, now: datetime) -> bool:
    if token.revoked_at is not None:
        return False
    expires = _utc(token.expires_at)
    return expires is None or expires > _utc(now)


def create_token(
    db: Session, creator: User, name: str, page_ids: list[int], expires_at: datetime | None,
    *, now: datetime | None = None,
) -> tuple[StatusIntegrationToken, str]:
    now = now_or_utc(now)
    try:
        name = clean_text(name, "Name", LABEL_MAX, required=True)
    except IncidentError as exc:
        raise TokenError(str(exc)) from None
    wanted = sorted(set(page_ids))
    if not wanted:
        raise TokenError("Choose at least one status page")
    found = set(db.scalars(select(StatusPage.id).where(StatusPage.id.in_(wanted))))
    missing = [p for p in wanted if p not in found]
    if missing:
        raise TokenError(f"Status page {missing[0]} does not exist")
    expires_at = _utc(expires_at)
    if expires_at is not None and expires_at <= now:
        raise TokenError("Expiry must be in the future")
    raw, prefix, digest = generate_scheme_key(TOKEN_SCHEME)
    token = StatusIntegrationToken(
        name=name, prefix=prefix, hash=digest, created_by_user_id=creator.id, created_at=now, expires_at=expires_at,
    )
    db.add(token)
    db.flush()
    for page_id in wanted:
        db.add(StatusIntegrationTokenPage(token_id=token.id, page_id=page_id))
    write_audit(
        db, "status_integration_token.created", creator.id, f"token:{name}",
        f"id={token.id} pages={','.join(map(str, wanted))} expires={expires_at.isoformat() if expires_at else 'never'}",
    )
    db.commit()
    return token, raw


def revoke_token(db: Session, actor: User, token: StatusIntegrationToken, *, now: datetime | None = None) -> None:
    if token.revoked_at is None:
        token.revoked_at = now_or_utc(now)
    write_audit(db, "status_integration_token.revoked", actor.id, f"token:{token.name}", f"id={token.id}")
    db.commit()


def authenticate(db: Session, raw: str, now: datetime) -> StatusIntegrationToken:
    parts = raw.split("_", 2) if raw else []
    if len(parts) != 3 or parts[0] != TOKEN_SCHEME or not parts[1] or not parts[2]:
        raise TokenRejected()
    digest = hash_key(raw)
    token = None
    for candidate in db.scalars(select(StatusIntegrationToken).where(StatusIntegrationToken.prefix == parts[1])):
        if hmac.compare_digest(candidate.hash, digest):
            token = candidate
    if token is None or not is_active(token, now):
        raise TokenRejected()
    creator = db.get(User, token.created_by_user_id) if token.created_by_user_id is not None else None
    if not creator_may_manage(creator):
        raise TokenRejected()
    token.last_used_at = _utc(now)
    return token


class WriteLimiter:
    def __init__(self, limit: int = WRITE_LIMIT, window: float = WRITE_WINDOW_SECONDS) -> None:
        self.limit = limit
        self.window = window
        self._lock = threading.Lock()
        self._hits: dict[int, deque[float]] = {}

    def reset(self) -> None:
        with self._lock:
            self._hits.clear()

    def check(self, token_id: int, now: float | None = None) -> int | None:
        now = time.monotonic() if now is None else now
        with self._lock:
            hits = self._hits.setdefault(token_id, deque())
            while hits and hits[0] <= now - self.window:
                hits.popleft()
            if len(hits) >= self.limit:
                return max(1, math.ceil(hits[0] + self.window - now))
            hits.append(now)
            return None


write_limiter = WriteLimiter()
