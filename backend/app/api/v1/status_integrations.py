"""Inbound status API for page-scoped integration tokens; every call is audited except 401 (no token identity) and 429 (flood protection)."""

import hashlib
import json
from collections.abc import Callable
from datetime import datetime, timezone
from typing import Annotated

from fastapi import APIRouter, Depends, Header, HTTPException, Request, Response, status
from fastapi.exceptions import RequestValidationError
from fastapi.routing import APIRoute
from fastapi.responses import JSONResponse
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.network import request_client_ip
from app.db.session import get_db
from app.models.status_page import (
    StatusIdempotencyKey,
    StatusIncident,
    StatusIncidentPage,
    StatusIntegrationToken,
    StatusPage,
    StatusPageItem,
)
from app.schemas.status_pages import IncidentResolve, IntegrationIncidentCreate, IntegrationIncidentUpdate, NoticeSet
from app.services.api_keys.throttle import clear_lookup_failures, is_lookup_locked, record_lookup_failure
from app.services.audit.service import write_audit
from app.services.status_pages import incidents, notices, tokens
from app.services.status_pages.incidents import IncidentConflict, IncidentError, IncidentNotFound, Ticket, TokenActor
from app.services.status_pages.sources import SourceRef

_OPS = {
    "set_notice": "notice_set",
    "clear_notice": "notice_cleared",
    "open_incident": "incident_opened",
    "add_incident_update": "incident_updated",
    "resolve_incident": "incident_resolved",
}


class AuditedRoute(APIRoute):
    def get_route_handler(self):
        handler = super().get_route_handler()

        async def audited(request: Request) -> Response:
            try:
                return await handler(request)
            except RequestValidationError:
                refuse = getattr(request.state, "status_integration_refuse", None)
                if refuse is not None:
                    refuse(status.HTTP_422_UNPROCESSABLE_CONTENT)
                raise

        return audited


router = APIRouter(prefix="/status-integrations", tags=["status-integrations"], route_class=AuditedRoute)

integration_bearer = HTTPBearer(
    auto_error=False,
    scheme_name="StatusIntegrationAuth",
    description="A status page integration token (`nmsp_<prefix>_<secret>`). Accepted only by these routes.",
)

IDEMPOTENCY_KEY_MAX = 120
INVALID_TOKEN = "Invalid or inactive status integration token"
NOT_FOUND = "Not found"
OUT_OF_SCOPE = "This token may not post to that page"
LOCKED_OUT = "Too many failed status integration token attempts; try again later"

Db = Annotated[Session, Depends(get_db)]


def _unauthorized() -> HTTPException:
    return HTTPException(status.HTTP_401_UNAUTHORIZED, INVALID_TOKEN, headers={"WWW-Authenticate": "Bearer"})


def current_token(
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(integration_bearer)], request: Request, db: Db,
) -> StatusIntegrationToken:
    if credentials is None:
        raise _unauthorized()
    client_ip = request_client_ip(request)
    if is_lookup_locked(db, client_ip):
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, LOCKED_OUT)
    try:
        token = tokens.authenticate(db, credentials.credentials, datetime.now(timezone.utc))
    except tokens.TokenRejected:
        db.rollback()
        if record_lookup_failure(db, client_ip):
            write_audit(
                db, "status_integration.auth_failed", None, f"ip:{client_ip or '-'}",
                "failed status integration token lookups exceeded threshold; source locked out",
            )
        db.commit()
        raise _unauthorized()
    clear_lookup_failures(db, client_ip)
    db.commit()
    token_id, token_name = token.id, token.name
    op = _OPS.get(getattr(request.scope.get("route"), "name", ""), "call")
    target = request.path_params.get("slug") or request.path_params.get("incident_id") or "-"

    def refuse(code: int) -> None:
        db.rollback()
        _audit(db, token_id, token_name, op, f"target={target} refused={code}")
        db.commit()

    request.state.status_integration_refuse = refuse
    return token


Token = Annotated[StatusIntegrationToken, Depends(current_token)]
IdempotencyKey = Annotated[str | None, Header(alias="Idempotency-Key")]


def _not_found() -> HTTPException:
    return HTTPException(status.HTTP_404_NOT_FOUND, NOT_FOUND)


def _out_of_scope() -> HTTPException:
    return HTTPException(status.HTTP_403_FORBIDDEN, OUT_OF_SCOPE)


def _service_error(exc: Exception) -> HTTPException:
    if isinstance(exc, IncidentNotFound):
        return _not_found()
    if isinstance(exc, IncidentConflict):
        return HTTPException(status.HTTP_409_CONFLICT, str(exc))
    return HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, str(exc))


def _find_key(db: Session, token_id: int, operation: str, key: str) -> StatusIdempotencyKey | None:
    return db.scalar(select(StatusIdempotencyKey).where(
        StatusIdempotencyKey.token_id == token_id, StatusIdempotencyKey.operation == operation,
        StatusIdempotencyKey.key == key,
    ))


def _fingerprint(payload: BaseModel | None) -> str:
    data = payload.model_dump(mode="json") if payload is not None else None
    return hashlib.sha256(json.dumps(data, sort_keys=True).encode()).hexdigest()


def _replay(row: StatusIdempotencyKey, fingerprint: str) -> tuple[int, dict]:
    stored = json.loads(row.result_json) if row.result_json else {}
    if stored.get("fingerprint") not in (None, fingerprint):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Idempotency-Key was already used with a different request")
    if "status" not in stored:
        raise HTTPException(status.HTTP_409_CONFLICT, "A request with this Idempotency-Key is still in progress")
    return stored["status"], stored["body"]


def _audit(db: Session, token_id: int, token_name: str, op: str, detail: str) -> None:
    write_audit(db, f"status_integration.{op}", None, f"token:{token_name}", f"token_id={token_id} {detail}")


def _write(
    db: Session, token: StatusIntegrationToken, op: str, target: str, key: str | None, payload: BaseModel | None,
    action: Callable[[], tuple[int, dict | None]], *, idempotent: bool = True,
) -> Response:
    token_id, token_name = token.id, token.name
    retry_after = tokens.write_limiter.check(token_id)
    if retry_after is not None:
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS, "Status integration write limit exceeded",
            headers={"Retry-After": str(retry_after)},
        )
    detail = f"target={target}"
    try:
        return _run(db, token_id, token_name, op, target, detail, key, payload, action, idempotent)
    except HTTPException as exc:
        db.rollback()
        _audit(db, token_id, token_name, op, f"{detail} refused={exc.status_code}")
        db.commit()
        raise


def _run(
    db: Session, token_id: int, token_name: str, op: str, target: str, detail: str, key: str | None,
    payload: BaseModel | None, action: Callable[[], tuple[int, dict | None]], idempotent: bool,
) -> Response:
    row = None
    if idempotent:
        if not key:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Idempotency-Key header is required")
        if len(key) > IDEMPOTENCY_KEY_MAX:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Idempotency-Key must be at most {IDEMPOTENCY_KEY_MAX} characters")
        operation = op if target == "-" else f"{op}:{target}"
        fingerprint = _fingerprint(payload)
        existing = _find_key(db, token_id, operation, key)
        if existing is None:
            row = StatusIdempotencyKey(
                token_id=token_id, operation=operation, key=key, result_json=json.dumps({"fingerprint": fingerprint}),
            )
            db.add(row)
            try:
                db.flush()
            except IntegrityError:
                db.rollback()
                row, existing = None, _find_key(db, token_id, operation, key)
                if existing is None:
                    raise
        if existing is not None:
            code, body = _replay(existing, fingerprint)
            _audit(db, token_id, token_name, op, f"{detail} replayed=yes status={code}")
            db.commit()
            return JSONResponse(body, status_code=code, headers={"Idempotent-Replayed": "true"})
    _audit(db, token_id, token_name, op, detail)
    try:
        code, body = action()
    except (IncidentError, IncidentNotFound) as exc:
        raise _service_error(exc) from None
    if row is not None:
        row.result_json = json.dumps({"fingerprint": fingerprint, "status": code, "body": body})
    db.commit()
    return Response(status_code=code) if body is None else JSONResponse(body, status_code=code)


def _page_by_slug(db: Session, slug: str, scope: set[int]) -> StatusPage:
    page = db.scalar(select(StatusPage).where(StatusPage.slug == slug))
    if page is None or page.id not in scope:
        raise _out_of_scope()
    return page


def _iso(value: datetime | None) -> str | None:
    if value is None:
        return None
    return (value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value).isoformat()


def _incident_body(db: Session, incident_id: int) -> dict:
    incident = db.get(StatusIncident, incident_id)
    slugs = db.scalars(
        select(StatusPage.slug).join(StatusIncidentPage, StatusIncidentPage.page_id == StatusPage.id)
        .where(StatusIncidentPage.incident_id == incident_id).order_by(StatusPage.slug)
    ).all()
    return {
        "id": incident.id, "title": incident.title, "severity": incident.severity, "status": incident.status,
        "opened_at": _iso(incident.opened_at), "resolved_at": _iso(incident.resolved_at),
        "ticket": {"url": incident.ticket_url, "label": incident.ticket_label} if incident.ticket_url else None,
        "pages": list(slugs),
    }


def _notice_body(notice, slug: str) -> dict:
    return {
        "id": notice.id, "page": slug, "level": notice.level, "title": notice.title, "body": notice.body,
        "link": notice.link, "expires_at": _iso(notice.expires_at),
    }


def _owned_incident(db: Session, token_id: int, incident_id: int, scope: set[int]) -> StatusIncident:
    incident = db.get(StatusIncident, incident_id)
    if incident is None or incident.source != "token" or incident.created_by_token_id != token_id:
        raise _not_found()
    audience = incidents.audience_page_ids(db, incident.id)
    if not audience or not audience <= scope:
        raise _not_found()
    return incident


def _item_audience(db: Session, refs: list[SourceRef], scope: set[int]) -> list[int]:
    shown: dict[str, set[int]] = {}
    for item in db.scalars(select(StatusPageItem).where(StatusPageItem.page_id.in_(scope))):
        shown.setdefault(SourceRef.from_item(item).key, set()).add(item.page_id)
    audience: set[int] = set()
    for ref in refs:
        pages = shown.get(ref.key)
        if not pages:
            raise _not_found()
        audience |= pages
    return sorted(audience)


def _ticket(url: str | None, label: str | None) -> Ticket | None:
    return Ticket(url, label) if url is not None else None


@router.put("/pages/{slug}/notice")
def set_notice(slug: str, payload: NoticeSet, token: Token, db: Db, idempotency_key: IdempotencyKey = None) -> Response:
    def action():
        page = _page_by_slug(db, slug, tokens.scope_page_ids(db, token.id))
        notice = notices.set_notice(
            db, TokenActor(token), page.id, payload.level, payload.title, payload.body, payload.link, payload.expires_at,
        )
        return status.HTTP_200_OK, _notice_body(notice, slug)

    return _write(db, token, "notice_set", slug, idempotency_key, payload, action)


@router.delete("/pages/{slug}/notice", status_code=status.HTTP_204_NO_CONTENT)
def clear_notice(slug: str, token: Token, db: Db) -> Response:
    def action():
        page = _page_by_slug(db, slug, tokens.scope_page_ids(db, token.id))
        notices.clear_own_notice(db, TokenActor(token), page.id)
        return status.HTTP_204_NO_CONTENT, None

    return _write(db, token, "notice_cleared", slug, None, None, action, idempotent=False)


@router.post("/incidents", status_code=status.HTTP_201_CREATED)
def open_incident(
    payload: IntegrationIncidentCreate, token: Token, db: Db, idempotency_key: IdempotencyKey = None,
) -> Response:
    def action():
        scope = tokens.scope_page_ids(db, token.id)
        refs = [item.to_ref() for item in payload.items]
        if refs:
            page_ids = _item_audience(db, refs, scope)
        else:
            page_ids = sorted({_page_by_slug(db, slug, scope).id for slug in payload.pages})
        incident = incidents.open_manual_incident(
            db, TokenActor(token), payload.title, payload.severity, payload.message, payload.is_public, page_ids, refs,
            _ticket(payload.ticket_url, payload.ticket_label),
        )
        return status.HTTP_201_CREATED, _incident_body(db, incident.id)

    return _write(db, token, "incident_opened", "-", idempotency_key, payload, action)


@router.post("/incidents/{incident_id}/updates", status_code=status.HTTP_201_CREATED)
def add_incident_update(
    incident_id: int, payload: IntegrationIncidentUpdate, token: Token, db: Db, idempotency_key: IdempotencyKey = None,
) -> Response:
    def action():
        _owned_incident(db, token.id, incident_id, tokens.scope_page_ids(db, token.id))
        incidents.add_update(
            db, TokenActor(token), incident_id, payload.message, payload.is_public, None, payload.status,
            _ticket(payload.ticket_url, payload.ticket_label),
        )
        return status.HTTP_201_CREATED, _incident_body(db, incident_id)

    return _write(db, token, "incident_updated", str(incident_id), idempotency_key, payload, action)


@router.post("/incidents/{incident_id}/resolve")
def resolve_incident(
    incident_id: int, payload: IncidentResolve, token: Token, db: Db, idempotency_key: IdempotencyKey = None,
) -> Response:
    def action():
        _owned_incident(db, token.id, incident_id, tokens.scope_page_ids(db, token.id))
        incidents.resolve(db, TokenActor(token), incident_id, payload.reason)
        return status.HTTP_200_OK, _incident_body(db, incident_id)

    return _write(db, token, "incident_resolved", str(incident_id), idempotency_key, payload, action)
