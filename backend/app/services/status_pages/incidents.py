from __future__ import annotations

from collections import defaultdict
from collections.abc import Iterable
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Literal
from urllib.parse import urlsplit

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.models.status_page import (
    StatusIncident,
    StatusIncidentAlias,
    StatusIncidentPage,
    StatusIncidentSource,
    StatusIncidentUpdate,
    StatusIntegrationToken,
    StatusNotice,
    StatusPage,
    StatusPageItem,
)
from app.models.user import User
from app.services.audit.service import write_audit
from app.services.status_pages import copy, events
from app.services.status_pages.sources import ItemState, SourceRef, _utc

Severity = Literal["performance", "partial", "major"]
IncidentStatus = Literal["investigating", "identified", "monitoring", "resolved"]
Audience = Literal["public", "private"]

SEVERITIES = ("performance", "partial", "major")
STATUSES = ("investigating", "identified", "monitoring", "resolved")
MANUAL_FAMILY = "manual"
PUBLISHED_EVENT = "published"
PAST_WINDOW = timedelta(days=30)
PUBLIC_PERSON_LABEL = "Status team"
NETMAP_LABEL = "NetMap"

TITLE_MAX = 200
MESSAGE_MAX = 5000
REASON_MAX = 500
URL_MAX = 2048
LABEL_MAX = 120


class IncidentError(ValueError):
    pass


class IncidentConflict(IncidentError):
    pass


class IncidentNotFound(LookupError):
    pass


@dataclass(frozen=True)
class PersonActor:
    user: User


@dataclass(frozen=True)
class TokenActor:
    token: StatusIntegrationToken


@dataclass(frozen=True)
class NetmapActor:
    pass


Actor = PersonActor | TokenActor | NetmapActor


@dataclass(frozen=True)
class Ticket:
    url: str
    label: str | None = None


def now_or_utc(now: datetime | None) -> datetime:
    return _utc(now) if now is not None else datetime.now(timezone.utc)


def clean_text(value: str | None, name: str, limit: int, required: bool = False) -> str | None:
    if value is None:
        if required:
            raise IncidentError(f"{name} is required")
        return None
    value = value.strip()
    if not value:
        if required:
            raise IncidentError(f"{name} is required")
        return None
    if len(value) > limit:
        raise IncidentError(f"{name} must be at most {limit} characters")
    return value


def clean_http_url(value: str | None, name: str = "Link") -> str | None:
    value = clean_text(value, name, URL_MAX)
    if value is None:
        return None
    if any(ch.isspace() or ord(ch) < 32 for ch in value):
        raise IncidentError(f"{name} must be an http or https address")
    try:
        parts = urlsplit(value)
    except ValueError:
        raise IncidentError(f"{name} must be an http or https address") from None
    if parts.scheme.lower() not in ("http", "https") or not parts.hostname:
        raise IncidentError(f"{name} must be an http or https address")
    return value


def _clean_ticket(ticket: Ticket | None) -> Ticket | None:
    if ticket is None:
        return None
    url = clean_http_url(ticket.url, "Ticket link")
    if url is None:
        raise IncidentError("Ticket link is required")
    return Ticket(url, clean_text(ticket.label, "Ticket label", LABEL_MAX))


def actor_kind(actor: Actor) -> str:
    if isinstance(actor, PersonActor):
        return "person"
    if isinstance(actor, TokenActor):
        return "token"
    return "netmap"


def actor_label(actor: Actor) -> str:
    if isinstance(actor, PersonActor):
        return (actor.user.display_name or actor.user.username)[:LABEL_MAX]
    if isinstance(actor, TokenActor):
        return actor.token.name[:LABEL_MAX]
    return NETMAP_LABEL


def audit(db: Session, actor: Actor, action: str, target: str, detail: str) -> None:
    user_id = actor.user.id if isinstance(actor, PersonActor) else None
    if isinstance(actor, TokenActor):
        detail = f"token={actor.token.name} {detail}"
    write_audit(db, action, user_id, target, detail)


def _update_row(
    incident_id: int, actor: Actor, now: datetime, *, message: str | None = None, is_public: bool = True,
    page_id: int | None = None, status_change: str | None = None, event_code: str | None = None,
    event_data: dict | None = None,
) -> StatusIncidentUpdate:
    return StatusIncidentUpdate(
        incident_id=incident_id, page_id=page_id, created_at=now, author_kind=actor_kind(actor),
        author_user_id=actor.user.id if isinstance(actor, PersonActor) else None,
        author_token_id=actor.token.id if isinstance(actor, TokenActor) else None,
        author_label=actor_label(actor), message=message, is_public=is_public, status_change=status_change,
        event_code=event_code, event_data=event_data,
    )


def get_incident(db: Session, incident_id: int) -> StatusIncident:
    incident = db.get(StatusIncident, incident_id)
    if incident is None:
        raise IncidentNotFound("Incident not found")
    return incident


def audience_page_ids(db: Session, incident_id: int) -> set[int]:
    return set(db.scalars(select(StatusIncidentPage.page_id).where(StatusIncidentPage.incident_id == incident_id)))


def _existing_pages(db: Session, page_ids: Iterable[int]) -> list[int]:
    wanted = list(dict.fromkeys(page_ids))
    if not wanted:
        raise IncidentError("Choose at least one status page")
    found = set(db.scalars(select(StatusPage.id).where(StatusPage.id.in_(wanted))))
    missing = [p for p in wanted if p not in found]
    if missing:
        raise IncidentError(f"Status page {missing[0]} does not exist")
    return wanted


def _page_aliases(db: Session, page_ids: Iterable[int]) -> dict[int, dict[str, str]]:
    found: dict[int, dict[str, str]] = defaultdict(dict)
    rows = db.scalars(
        select(StatusPageItem).where(StatusPageItem.page_id.in_(list(page_ids))).order_by(StatusPageItem.id)
    )
    for item in rows:
        found[item.page_id][SourceRef.from_item(item).key] = item.display_name
    return found


def _attach_page(db: Session, incident_id: int, page_id: int, keys: Iterable[str], aliases: dict[str, str]) -> None:
    db.add(StatusIncidentPage(incident_id=incident_id, page_id=page_id))
    for key in keys:
        if key in aliases:
            db.add(StatusIncidentSource(
                incident_id=incident_id, source_key=key, condition_family=MANUAL_FAMILY, page_id=page_id, active=False,
            ))
            db.add(StatusIncidentAlias(incident_id=incident_id, page_id=page_id, source_key=key, display_name=aliases[key]))


def commit_and_notify(db: Session, page_ids: Iterable[int]) -> None:
    db.commit()
    events.notify_pages_changed(sorted(set(page_ids)))


def open_manual_incident(
    db: Session, actor: Actor, title: str, severity: Severity, message: str, is_public: bool,
    page_ids: list[int], items: list[SourceRef], ticket: Ticket | None, *, now: datetime | None = None,
) -> StatusIncident:
    now = now_or_utc(now)
    title = clean_text(title, "Title", TITLE_MAX, required=True)
    message = clean_text(message, "Message", MESSAGE_MAX, required=True)
    if severity not in SEVERITIES:
        raise IncidentError("Severity must be performance, partial or major")
    ticket = _clean_ticket(ticket)
    pages = _existing_pages(db, page_ids)
    aliases = _page_aliases(db, pages)
    keys = list(dict.fromkeys(ref.key for ref in items))
    for key in keys:
        if not any(key in aliases[p] for p in pages):
            raise IncidentError(f"{key} is not shown on any selected status page")

    incident = StatusIncident(
        title=title, severity=severity, status="investigating", source=actor_kind(actor), opened_at=now,
        ticket_url=ticket.url if ticket else None, ticket_label=ticket.label if ticket else None,
        created_by_user_id=actor.user.id if isinstance(actor, PersonActor) else None,
        created_by_token_id=actor.token.id if isinstance(actor, TokenActor) else None,
    )
    db.add(incident)
    db.flush()
    for page_id in pages:
        _attach_page(db, incident.id, page_id, keys, aliases[page_id])
    db.add(_update_row(incident.id, actor, now, message=message, is_public=is_public))
    audit(db, actor, "status_incident.opened", f"status_incident:{incident.id}",
          f"pages={','.join(map(str, pages))} items={len(keys)} severity={severity}")
    commit_and_notify(db, pages)
    return incident


def add_update(
    db: Session, actor: Actor, incident_id: int, message: str | None, is_public: bool, page_id: int | None,
    status_change: IncidentStatus | None, ticket: Ticket | None, *, now: datetime | None = None,
) -> StatusIncidentUpdate:
    now = now_or_utc(now)
    incident = get_incident(db, incident_id)
    audience = audience_page_ids(db, incident.id)
    message = clean_text(message, "Message", MESSAGE_MAX)
    ticket = _clean_ticket(ticket)
    if page_id is not None and page_id not in audience:
        raise IncidentError("That status page is not in this incident's audience")
    if status_change is not None and status_change not in STATUSES:
        raise IncidentError("Unknown incident status")
    if status_change is not None and incident.status == "resolved":
        raise IncidentConflict("This incident is already resolved")
    if message is None and status_change is None and ticket is None:
        raise IncidentError("Add a message, a status change or a ticket link")
    if ticket is not None:
        incident.ticket_url, incident.ticket_label = ticket.url, ticket.label
    resolving = status_change == "resolved"
    if status_change is not None and not resolving:
        incident.status = status_change
    update = _update_row(incident.id, actor, now, message=message, is_public=is_public, page_id=page_id,
                         status_change=None if resolving else status_change)
    if message is not None or not resolving:
        db.add(update)
    if resolving:
        resolved = _mark_resolved(db, incident, actor, now)
        if message is None:
            update = resolved
    audit(db, actor, "status_incident.updated", f"status_incident:{incident.id}",
          f"public={is_public} page={page_id or 'all'} status={status_change or '-'} ticket={ticket is not None}")
    commit_and_notify(db, audience)
    return update


def _mark_resolved(db: Session, incident: StatusIncident, actor: Actor, now: datetime) -> StatusIncidentUpdate:
    incident.status, incident.resolved_at, incident.resolution_reason = "resolved", now, "manual"
    event = _update_row(incident.id, actor, now, status_change="resolved", event_code="resolved_manual", event_data={})
    db.add(event)
    return event


def resolve(db: Session, actor: Actor, incident_id: int, reason: str | None, *, now: datetime | None = None) -> None:
    now = now_or_utc(now)
    incident = get_incident(db, incident_id)
    reason = clean_text(reason, "Reason", REASON_MAX)
    if incident.status == "resolved":
        raise IncidentConflict("This incident is already resolved")
    _mark_resolved(db, incident, actor, now)
    if reason:
        db.add(_update_row(incident.id, actor, now, message=reason, is_public=False))
    audit(db, actor, "status_incident.resolved", f"status_incident:{incident.id}", f"reason={'yes' if reason else 'no'}")
    commit_and_notify(db, audience_page_ids(db, incident.id))


def publish_to_pages(
    db: Session, actor: Actor, incident_id: int, page_ids: list[int], *, now: datetime | None = None,
) -> None:
    now = now_or_utc(now)
    incident = get_incident(db, incident_id)
    if incident.status == "resolved":
        raise IncidentError("A resolved incident cannot be published to more pages")
    pages = _existing_pages(db, page_ids)
    audience = audience_page_ids(db, incident.id)
    added = [p for p in pages if p not in audience]
    if not added:
        return
    keys = list(dict.fromkeys(db.scalars(
        select(StatusIncidentSource.source_key).where(StatusIncidentSource.incident_id == incident.id)
        .order_by(StatusIncidentSource.id)
    )))
    aliases = _page_aliases(db, added)
    for page_id in added:
        _attach_page(db, incident.id, page_id, keys, aliases[page_id])
        db.add(_update_row(incident.id, actor, now, is_public=False, page_id=page_id, event_code=PUBLISHED_EVENT))
    audit(db, actor, "status_incident.published", f"status_incident:{incident.id}", f"pages={','.join(map(str, added))}")
    commit_and_notify(db, added)


def delete_page_records(db: Session, page_id: int) -> None:
    for model in (StatusNotice, StatusIncidentAlias, StatusIncidentSource, StatusIncidentUpdate, StatusIncidentPage):
        db.execute(delete(model).where(model.page_id == page_id))


@dataclass
class LoadedIncident:
    incident: StatusIncident
    page_ids: set[int]
    marks: dict[int, int] = field(default_factory=dict)
    updates: list[StatusIncidentUpdate] = field(default_factory=list)
    aliases: dict[int, dict[str, str]] = field(default_factory=lambda: defaultdict(dict))
    sources: dict[int, list[str]] = field(default_factory=lambda: defaultdict(list))


@dataclass(frozen=True)
class PageLocal:
    states: dict[str, ItemState]
    item_count: int


def is_listed(incident: StatusIncident, now: datetime) -> bool:
    if incident.status != "resolved":
        return True
    resolved = _utc(incident.resolved_at)
    return resolved is not None and resolved > _utc(now) - PAST_WINDOW


def load_page_incidents(db: Session, page_id: int, now: datetime) -> list[LoadedIncident]:
    ids = list(db.scalars(select(StatusIncidentPage.incident_id).where(StatusIncidentPage.page_id == page_id)))
    if not ids:
        return []
    found = {
        i.id: LoadedIncident(i, set())
        for i in db.scalars(select(StatusIncident).where(StatusIncident.id.in_(ids)))
        if is_listed(i, now)
    }
    if not found:
        return []
    ids = list(found)
    for row in db.execute(
        select(StatusIncidentPage.incident_id, StatusIncidentPage.page_id).where(StatusIncidentPage.incident_id.in_(ids))
    ):
        found[row.incident_id].page_ids.add(row.page_id)
    for update in db.scalars(
        select(StatusIncidentUpdate).where(
            StatusIncidentUpdate.incident_id.in_(ids),
            (StatusIncidentUpdate.page_id.is_(None)) | (StatusIncidentUpdate.page_id == page_id),
        ).order_by(StatusIncidentUpdate.id)
    ):
        loaded = found[update.incident_id]
        if update.event_code == PUBLISHED_EVENT:
            loaded.marks[page_id] = update.id
        else:
            loaded.updates.append(update)
    for alias in db.scalars(
        select(StatusIncidentAlias).where(StatusIncidentAlias.incident_id.in_(ids), StatusIncidentAlias.page_id == page_id)
        .order_by(StatusIncidentAlias.id)
    ):
        found[alias.incident_id].aliases[page_id][alias.source_key] = alias.display_name
    for source in db.scalars(
        select(StatusIncidentSource).where(StatusIncidentSource.incident_id.in_(ids), StatusIncidentSource.page_id == page_id)
        .order_by(StatusIncidentSource.id)
    ):
        keys = found[source.incident_id].sources[page_id]
        if source.source_key not in keys:
            keys.append(source.source_key)
    return sorted(found.values(), key=lambda li: (_utc(li.incident.opened_at), li.incident.id), reverse=True)


def _is_automatic(incident: StatusIncident) -> bool:
    return incident.source == "netmap" and bool(incident.condition_family) and incident.condition_family != MANUAL_FAMILY


def _severity(incident: StatusIncident, keys: list[str], local: PageLocal | None) -> Severity:
    if not _is_automatic(incident):
        return incident.severity if incident.severity in SEVERITIES else "partial"
    if incident.condition_family != "availability":
        return "performance"
    down = sum(local.states.get(key) == "down" for key in keys) if local else 0
    return "major" if local and local.item_count and down * 2 > local.item_count else "partial"


def _author(update: StatusIncidentUpdate) -> str:
    if update.author_kind == "person":
        return PUBLIC_PERSON_LABEL
    if update.author_kind == "token":
        return update.author_label or "Integration"
    return NETMAP_LABEL


def _iso(value: datetime | None) -> str | None:
    value = _utc(value)
    return value.isoformat() if value else None


def project_incident(
    loaded: LoadedIncident, page: StatusPage, audience: Audience, local: PageLocal | None = None,
) -> dict | None:
    incident = loaded.incident
    if page.id not in loaded.page_ids:
        return None
    aliases = loaded.aliases.get(page.id, {})
    keys = loaded.sources.get(page.id, [])
    if _is_automatic(incident):
        names = [aliases[key] for key in keys if key in aliases]
        if not names:
            return None
        title = copy.auto_title(incident.condition_family, names)
    else:
        title = incident.title
    mark = loaded.marks.get(page.id, 0)
    updates = []
    for update in loaded.updates:
        if update.page_id not in (None, page.id):
            continue
        if update.page_id is None and update.id < mark:
            continue
        if not update.is_public and audience != "private":
            continue
        message = copy.render_event(update.event_code, update.event_data or {}, aliases) if update.event_code else update.message
        if update.event_code and message is None:
            continue
        if message is None and update.status_change is None:
            continue
        updates.append({
            "id": update.id,
            "at": _iso(update.created_at),
            "status": update.status_change,
            "message": message,
            "author": _author(update),
            "internal": not update.is_public,
        })
    ticket = {"url": incident.ticket_url, "label": incident.ticket_label} if incident.ticket_url else None
    return {
        "id": incident.id,
        "title": title,
        "severity": _severity(incident, keys, local),
        "status": incident.status,
        "opened_at": _iso(incident.opened_at),
        "resolved_at": _iso(incident.resolved_at),
        "ticket": ticket,
        "updates": updates,
    }
