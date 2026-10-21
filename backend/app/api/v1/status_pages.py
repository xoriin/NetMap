from datetime import datetime, timedelta, timezone
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from pydantic import AwareDatetime
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.api.deps import get_current_user, require_status_page_manage
from app.api.v1.status_public import resolve, serve_snapshot
from app.db.session import get_db
from app.models.device import Device
from app.models.monitor import Monitor
from app.models.port_target import DevicePortTarget
from app.models.status_page import (
    StatusIncident,
    StatusIncidentAlias,
    StatusIncidentPage,
    StatusIncidentUpdate,
    StatusIntegrationToken,
    StatusIntegrationTokenPage,
    StatusNotice,
    StatusPage,
    StatusPageGroup,
    StatusPageItem,
)
from app.models.system_setting import SystemSetting
from app.models.user import User
from app.schemas.status_pages import (
    IncidentBoardVisibility,
    IncidentCreate,
    IncidentPublish,
    IncidentResolve,
    IncidentUpdateCreate,
    ItemExtras,
    LayoutUpdate,
    MaintenanceCreate,
    MaintenanceUpdate,
    NoticeManagerRead,
    NoticeRead,
    NoticeSet,
    StatusPageCreate,
    StatusPageDetail,
    StatusPageRead,
    StatusPageUpdate,
    StatusPreviewDraft,
    TokenCreate,
    TokenCreated,
    TokenRead,
)
from app.services.audit.service import write_audit
from app.services.status_pages import events, incidents, maintenance, notices, tokens
from app.services.status_pages.cache import RegistryEntry, status_cache
from app.services.status_pages.css import validate_css
from app.services.status_pages.incidents import (
    PUBLISHED_EVENT,
    IncidentConflict,
    IncidentError,
    IncidentNotFound,
    PersonActor,
    Ticket,
)
from app.services.status_pages.projection import build_page_payload, load_page, project_page
from app.services.status_pages.sources import SourceRef, iso, source_dict

router = APIRouter(prefix="/status-pages", tags=["status-pages"])

DEFAULT_CSS_KEY = "status_page_default_css"

CurrentUser = Annotated[User, Depends(require_status_page_manage)]
Db = Annotated[Session, Depends(get_db)]


def checked_css(text: str | None) -> str | None:
    if text is None or not text.strip():
        return None
    result = validate_css(text)
    if not result.ok:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"message": "Custom CSS was not saved", "css_errors": list(result.errors)},
        )
    return text


def _registry_entry(page: StatusPage) -> RegistryEntry:
    return RegistryEntry(page.id, page.slug, page.visibility, page.generation)


def _get_page(db: Session, page_id: int) -> StatusPage:
    page = db.get(StatusPage, page_id)
    if page is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Status page not found")
    return page


def _slug_taken(db: Session, slug: str, exclude_id: int | None = None) -> bool:
    query = select(StatusPage.id).where(StatusPage.slug == slug)
    if exclude_id is not None:
        query = query.where(StatusPage.id != exclude_id)
    return db.scalar(query) is not None


def _slug_conflict() -> HTTPException:
    return HTTPException(status_code=status.HTTP_409_CONFLICT, detail="That slug is already used by another status page")


def _detail(db: Session, page: StatusPage) -> StatusPageDetail:
    groups = db.scalars(
        select(StatusPageGroup).where(StatusPageGroup.page_id == page.id).order_by(StatusPageGroup.sort_order, StatusPageGroup.id)
    ).all()
    items = db.scalars(
        select(StatusPageItem).where(StatusPageItem.page_id == page.id).order_by(StatusPageItem.sort_order, StatusPageItem.id)
    ).all()
    by_group: dict[int, list] = {}
    for item in items:
        by_group.setdefault(item.group_id, []).append({
            "id": item.id,
            "source": source_dict(SourceRef.from_item(item)),
            "source_key": SourceRef.from_item(item).key,
            "display_name": item.display_name,
            "extras": ItemExtras(**(item.extras or {})),
        })
    return StatusPageDetail(
        **StatusPageRead.model_validate(page).model_dump(),
        groups=[
            {"id": g.id, "name": g.name, "collapsed_by_default": g.collapsed_by_default, "items": by_group.get(g.id, [])}
            for g in groups
        ],
    )


@router.get("", response_model=list[StatusPageRead])
def list_pages(_: CurrentUser, db: Db) -> list[StatusPage]:
    return list(db.scalars(select(StatusPage).order_by(StatusPage.name, StatusPage.id)))


@router.post("", response_model=StatusPageRead, status_code=status.HTTP_201_CREATED)
def create_page(payload: StatusPageCreate, current_user: CurrentUser, db: Db) -> StatusPage:
    if _slug_taken(db, payload.slug):
        raise _slug_conflict()
    default_css = db.get(SystemSetting, DEFAULT_CSS_KEY)
    page = StatusPage(**payload.model_dump(), custom_css=default_css.value if default_css else None)
    db.add(page)
    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        raise _slug_conflict()
    write_audit(db, "status_page.created", current_user.id, f"status_page:{page.id}", f"slug={page.slug} visibility={page.visibility}")
    db.commit()
    status_cache.register_page(_registry_entry(page))
    events.notify_pages_changed([page.id])
    return page


@router.get("/sources")
def list_sources(_: CurrentUser, db: Db) -> dict:
    devices = db.scalars(select(Device).order_by(Device.display_name, Device.hostname, Device.id)).all()
    targets = db.scalars(select(DevicePortTarget).order_by(DevicePortTarget.sort_order, DevicePortTarget.id)).all()
    monitors = db.scalars(select(Monitor).order_by(Monitor.name, Monitor.id)).all()

    def check(target: DevicePortTarget) -> dict:
        return {
            "id": target.id, "label": target.label, "port": target.port, "check_type": target.check_type,
            "enabled": target.enabled, "global": target.device_id is None,
        }

    return {
        "devices": [
            {
                "id": d.id,
                "name": d.display_name or d.hostname or d.ip_address,
                "ip_address": d.ip_address,
                "service_checks": [check(t) for t in targets if t.device_id in (None, d.id)],
            }
            for d in devices
        ],
        "monitors": [{"id": m.id, "name": m.name, "url": m.url} for m in monitors],
    }


INCIDENT_LIST_LIMIT = 200


def _service_error(exc: Exception) -> HTTPException:
    if isinstance(exc, IncidentNotFound):
        return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc))
    if isinstance(exc, IncidentConflict):
        return HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc))
    return HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc))


def _ticket(payload) -> Ticket | None:
    return Ticket(payload.url, payload.label) if payload is not None else None


def _incident_detail(db: Session, rows: list[StatusIncident]) -> list[dict]:
    ids = [row.id for row in rows]
    pages: dict[int, list[int]] = {i: [] for i in ids}
    items: dict[int, list[dict]] = {i: [] for i in ids}
    updates: dict[int, list[dict]] = {i: [] for i in ids}
    breaching = incidents.breaching_incident_ids(db, ids)
    hidden = incidents.hidden_page_ids(db, ids)
    if ids:
        for row in db.scalars(select(StatusIncidentPage).where(StatusIncidentPage.incident_id.in_(ids))):
            pages[row.incident_id].append(row.page_id)
        for row in db.scalars(
            select(StatusIncidentAlias).where(StatusIncidentAlias.incident_id.in_(ids)).order_by(StatusIncidentAlias.id)
        ):
            items[row.incident_id].append({"page_id": row.page_id, "source_key": row.source_key, "display_name": row.display_name})
        for row in db.scalars(
            select(StatusIncidentUpdate).where(
                StatusIncidentUpdate.incident_id.in_(ids), StatusIncidentUpdate.event_code.is_distinct_from(PUBLISHED_EVENT),
                StatusIncidentUpdate.event_code.is_distinct_from(incidents.BOARD_VISIBILITY_EVENT),
            ).order_by(StatusIncidentUpdate.id)
        ):
            updates[row.incident_id].append({
                "id": row.id, "at": iso(row.created_at), "page_id": row.page_id, "author": row.author_label,
                "author_kind": row.author_kind, "is_public": row.is_public, "status": row.status_change,
                "message": row.message, "event_code": row.event_code,
            })
    return [
        {
            "id": row.id, "title": row.title, "severity": row.severity, "status": row.status, "source": row.source,
            "opened_at": iso(row.opened_at), "resolved_at": iso(row.resolved_at),
            "ticket": {"url": row.ticket_url, "label": row.ticket_label} if row.ticket_url else None,
            "page_ids": sorted(pages[row.id]), "hidden_page_ids": sorted(hidden[row.id]),
            "items": items[row.id], "updates": updates[row.id],
            "breaching": row.id in breaching,
        }
        for row in rows
    ]


def _one_incident(db: Session, incident_id: int) -> dict:
    return _incident_detail(db, [incidents.get_incident(db, incident_id)])[0]


@router.get("/incidents")
def list_incidents(_: CurrentUser, db: Db) -> list[dict]:
    rows = list(db.scalars(
        select(StatusIncident).order_by(StatusIncident.opened_at.desc(), StatusIncident.id.desc()).limit(INCIDENT_LIST_LIMIT)
    ))
    return _incident_detail(db, rows)


@router.post("/incidents", status_code=status.HTTP_201_CREATED)
def open_incident(payload: IncidentCreate, current_user: CurrentUser, db: Db) -> dict:
    try:
        incident = incidents.open_manual_incident(
            db, PersonActor(current_user), payload.title, payload.severity, payload.message, payload.is_public,
            payload.page_ids, [item.to_ref() for item in payload.items], _ticket(payload.ticket),
        )
    except (IncidentError, IncidentNotFound) as exc:
        db.rollback()
        raise _service_error(exc)
    return _one_incident(db, incident.id)


@router.post("/incidents/{incident_id}/updates", status_code=status.HTTP_201_CREATED)
def add_incident_update(incident_id: int, payload: IncidentUpdateCreate, current_user: CurrentUser, db: Db) -> dict:
    try:
        incidents.add_update(
            db, PersonActor(current_user), incident_id, payload.message, payload.is_public, payload.page_id,
            payload.status_change, _ticket(payload.ticket),
        )
    except (IncidentError, IncidentNotFound) as exc:
        db.rollback()
        raise _service_error(exc)
    return _one_incident(db, incident_id)


@router.post("/incidents/{incident_id}/resolve")
def resolve_incident(incident_id: int, payload: IncidentResolve, current_user: CurrentUser, db: Db) -> dict:
    try:
        incidents.resolve(db, PersonActor(current_user), incident_id, payload.reason)
    except (IncidentError, IncidentNotFound) as exc:
        db.rollback()
        raise _service_error(exc)
    return _one_incident(db, incident_id)


@router.post("/incidents/{incident_id}/publish")
def publish_incident(incident_id: int, payload: IncidentPublish, current_user: CurrentUser, db: Db) -> dict:
    try:
        incidents.publish_to_pages(db, PersonActor(current_user), incident_id, payload.page_ids)
    except (IncidentError, IncidentNotFound) as exc:
        db.rollback()
        raise _service_error(exc)
    return _one_incident(db, incident_id)


@router.put("/incidents/{incident_id}/pages/{page_id}/visibility")
def set_incident_board_visibility(
    incident_id: int, page_id: int, payload: IncidentBoardVisibility, current_user: CurrentUser, db: Db,
) -> dict:
    try:
        incidents.set_board_visibility(db, PersonActor(current_user), incident_id, page_id, payload.visible)
    except (IncidentError, IncidentNotFound) as exc:
        db.rollback()
        raise _service_error(exc)
    return _one_incident(db, incident_id)


@router.delete("/notices/{notice_id}", status_code=status.HTTP_204_NO_CONTENT)
def clear_any_notice(notice_id: int, current_user: CurrentUser, db: Db) -> None:
    try:
        notices.clear_notice(db, PersonActor(current_user), notice_id)
    except IncidentNotFound as exc:
        db.rollback()
        raise _service_error(exc)


def _token_state(db: Session, rows: list[StatusIntegrationToken]) -> tuple[dict[int, list[int]], dict[int, User], dict[int, bool]]:
    ids = [row.id for row in rows]
    pages: dict[int, list[int]] = {i: [] for i in ids}
    if ids:
        for link in db.scalars(
            select(StatusIntegrationTokenPage).where(StatusIntegrationTokenPage.token_id.in_(ids))
            .order_by(StatusIntegrationTokenPage.page_id)
        ):
            pages[link.token_id].append(link.page_id)
    creators = {u.id: u for u in db.scalars(select(User).where(
        User.id.in_({row.created_by_user_id for row in rows if row.created_by_user_id is not None})
    ))}
    now = datetime.now(timezone.utc)
    active = {
        row.id: bool(pages[row.id]) and tokens.is_active(row, now) and tokens.creator_may_manage(creators.get(row.created_by_user_id))
        for row in rows
    }
    return pages, creators, active


def _token_reads(db: Session, rows: list[StatusIntegrationToken]) -> list[dict]:
    pages, creators, active = _token_state(db, rows)
    return [
        {
            "id": row.id, "name": row.name, "prefix": row.prefix, "page_ids": pages[row.id],
            "created_by": creator.username if (creator := creators.get(row.created_by_user_id)) else None,
            "created_at": row.created_at, "expires_at": row.expires_at, "revoked_at": row.revoked_at,
            "last_used_at": row.last_used_at, "active": active[row.id],
        }
        for row in rows
    ]


@router.get("/tokens", response_model=list[TokenRead])
def list_tokens(_: CurrentUser, db: Db) -> list[dict]:
    rows = list(db.scalars(select(StatusIntegrationToken).order_by(StatusIntegrationToken.created_at.desc(), StatusIntegrationToken.id.desc())))
    return _token_reads(db, rows)


@router.post("/tokens", response_model=TokenCreated, status_code=status.HTTP_201_CREATED)
def create_token(payload: TokenCreate, current_user: CurrentUser, db: Db) -> dict:
    try:
        token, secret = tokens.create_token(db, current_user, payload.name, payload.page_ids, payload.expires_at)
    except tokens.TokenError as exc:
        db.rollback()
        raise _service_error(exc)
    return {**_token_reads(db, [token])[0], "secret": secret, "name_is_public": True}


@router.delete("/tokens/{token_id}", status_code=status.HTTP_204_NO_CONTENT)
def revoke_token(token_id: int, current_user: CurrentUser, db: Db) -> None:
    token = db.get(StatusIntegrationToken, token_id)
    if token is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Integration token not found")
    tokens.revoke_token(db, current_user, token)


def _window_reads(db: Session, rows: list[maintenance.LoadedWindow]) -> list[dict]:
    users = {u.id: u.username for u in db.scalars(select(User).where(
        User.id.in_({w.window.created_by_user_id for w in rows if w.window.created_by_user_id is not None})
    ))}
    token_names = {t.id: t.name for t in db.scalars(select(StatusIntegrationToken).where(
        StatusIntegrationToken.id.in_({w.window.created_by_token_id for w in rows if w.window.created_by_token_id is not None})
    ))}
    now = datetime.now(timezone.utc)
    return [
        {
            "id": w.window.id, "title": w.window.title, "description": w.window.description,
            "starts_at": w.start.isoformat(), "ends_at": w.end.isoformat(), "suppress_alerts": w.window.suppress_alerts,
            "state": "active" if w.active(now) else "finished" if w.end <= now else "upcoming",
            "items": [{"source": source_dict(SourceRef.from_key(key)), "source_key": key} for key in w.keys],
            "page_ids": sorted(w.page_ids),
            "created_by": users.get(w.window.created_by_user_id),
            "created_by_token": token_names.get(w.window.created_by_token_id),
            "created_at": iso(w.window.created_at),
        }
        for w in rows
    ]


def _maintenance_error(exc: Exception) -> HTTPException:
    if isinstance(exc, maintenance.MaintenanceForbidden):
        return HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=exc.detail)
    return _service_error(exc)


MaintenanceFailure = (IncidentError, IncidentNotFound, maintenance.MaintenanceForbidden)


MAINTENANCE_LIST_DAYS = 30


@router.get("/maintenance")
def list_maintenance(_: CurrentUser, db: Db, since: AwareDatetime | None = None) -> list[dict]:
    """Upcoming and active windows plus those that ended after `since` (default: the last 30 days)."""
    since = since or datetime.now(timezone.utc) - timedelta(days=MAINTENANCE_LIST_DAYS)
    return _window_reads(db, maintenance.load_windows(db, ending_after=since))


@router.post("/maintenance", status_code=status.HTTP_201_CREATED)
def create_maintenance(payload: MaintenanceCreate, current_user: CurrentUser, db: Db) -> dict:
    refs = [item.to_ref() for item in payload.items]
    _validate_sources(db, refs)
    try:
        window = maintenance.create_window(
            db, PersonActor(current_user), payload.title, payload.description, payload.starts_at, payload.ends_at,
            refs, payload.page_ids, payload.suppress_alerts,
        )
    except MaintenanceFailure as exc:
        db.rollback()
        raise _maintenance_error(exc)
    return _window_reads(db, [maintenance.get_window(db, window.id)])[0]


@router.patch("/maintenance/{window_id}")
def update_maintenance(window_id: int, payload: MaintenanceUpdate, current_user: CurrentUser, db: Db) -> dict:
    changes = {name: getattr(payload, name) for name in payload.model_fields_set}
    if "items" in changes:
        changes["items"] = [item.to_ref() for item in payload.items]
        _validate_sources(db, changes["items"])
    try:
        maintenance.update_window(db, PersonActor(current_user), window_id, changes)
    except MaintenanceFailure as exc:
        db.rollback()
        raise _maintenance_error(exc)
    return _window_reads(db, [maintenance.get_window(db, window_id)])[0]


@router.delete("/maintenance/{window_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_maintenance(window_id: int, current_user: CurrentUser, db: Db) -> None:
    try:
        maintenance.delete_window(db, PersonActor(current_user), window_id)
    except MaintenanceFailure as exc:
        db.rollback()
        raise _maintenance_error(exc)


@router.get("/{page_id}/notices", response_model=list[NoticeManagerRead])
def list_page_notices(page_id: int, current_user: CurrentUser, db: Db) -> list[dict]:
    _get_page(db, page_id)
    rows = list(db.scalars(select(StatusNotice).where(StatusNotice.page_id == page_id).order_by(StatusNotice.id)))
    token_rows = list(db.scalars(select(StatusIntegrationToken).where(
        StatusIntegrationToken.id.in_({n.owner_id for n in rows if n.owner_kind == "token"})
    )))
    _, _, active = _token_state(db, token_rows)
    return [
        {
            **NoticeRead.model_validate(n).model_dump(), "owner_id": n.owner_id,
            "mine": n.owner_kind == "user" and n.owner_id == current_user.id,
            "token_active": active.get(n.owner_id, False) if n.owner_kind == "token" else None,
        }
        for n in rows
    ]


@router.put("/{page_id}/notice", response_model=NoticeRead)
def set_own_notice(page_id: int, payload: NoticeSet, current_user: CurrentUser, db: Db) -> StatusNotice:
    try:
        return notices.set_notice(
            db, PersonActor(current_user), page_id, payload.level, payload.title, payload.body, payload.link,
            payload.expires_at,
        )
    except (IncidentError, IncidentNotFound) as exc:
        db.rollback()
        raise _service_error(exc)


@router.delete("/{page_id}/notice", status_code=status.HTTP_204_NO_CONTENT)
def clear_own_notice(page_id: int, current_user: CurrentUser, db: Db) -> None:
    try:
        notices.clear_own_notice(db, PersonActor(current_user), page_id)
    except IncidentNotFound as exc:
        db.rollback()
        raise _service_error(exc)


@router.get("/{slug}/view")
def view_page(slug: str, request: Request, _: Annotated[User, Depends(get_current_user)]) -> Response:
    entry = resolve(slug)
    return entry if isinstance(entry, Response) else serve_snapshot(request, entry, entry.visibility)


@router.get("/{page_id}/preview")
def preview_page(page_id: int, _: CurrentUser, db: Db, audience: Literal["public", "private"] = "public") -> dict:
    return build_page_payload(db, _get_page(db, page_id), audience, datetime.now(timezone.utc), status_cache.history.cycle())


@router.post("/{page_id}/preview")
def preview_draft(
    page_id: int, payload: StatusPreviewDraft, _: CurrentUser, db: Db,
    audience: Literal["public", "private"] = "public",
) -> dict:
    saved = _get_page(db, page_id)
    # Transient copies only: never flush draft layout or modify the saved page/cache.
    page = StatusPage(**{column.key: getattr(saved, column.key) for column in StatusPage.__table__.columns})
    if payload.heartbeat_window is not None:
        page.heartbeat_window = payload.heartbeat_window
    groups, items = None, None
    if payload.groups is not None:
        owned_groups = set(db.scalars(select(StatusPageGroup.id).where(StatusPageGroup.page_id == page_id)))
        owned_items = {i.id: i for i in db.scalars(select(StatusPageItem).where(StatusPageItem.page_id == page_id))}
        groups, items, seen_groups, seen_items, keys, refs = [], [], set(), set(), set(), []
        for order, group in enumerate(payload.groups):
            if group.id is not None and (group.id not in owned_groups or group.id in seen_groups):
                raise _unprocessable("Group does not belong to this page or appears twice")
            if group.id is not None:
                seen_groups.add(group.id)
            gid = group.id if group.id is not None else -(order + 1)
            groups.append(StatusPageGroup(id=gid, page_id=page_id, name=group.name,
                                          collapsed_by_default=group.collapsed_by_default, sort_order=order))
            for item_order, item in enumerate(group.items):
                if item.id is not None and (item.id not in owned_items or item.id in seen_items):
                    raise _unprocessable("Item does not belong to this page or appears twice")
                if item.id is not None:
                    seen_items.add(item.id)
                ref = item.source.to_ref()
                if ref.key in keys:
                    raise _unprocessable("A source can appear only once on a page")
                keys.add(ref.key)
                refs.append(ref)
                iid = item.id if item.id is not None else -(len(items) + 1)
                items.append(StatusPageItem(id=iid, page_id=page_id, group_id=gid, kind=ref.kind,
                                            device_id=ref.device_id, monitor_id=ref.monitor_id, port_target_id=ref.port_target_id,
                                            display_name=item.display_name, extras=item.extras.model_dump(), sort_order=item_order))
        _validate_sources(db, refs)
    cycle = status_cache.history.cycle()
    return project_page(load_page(db, page, datetime.now(timezone.utc), cycle, groups=groups, items=items), audience, cycle)


@router.get("/{page_id}", response_model=StatusPageDetail)
def get_page(page_id: int, _: CurrentUser, db: Db) -> StatusPageDetail:
    return _detail(db, _get_page(db, page_id))


@router.patch("/{page_id}", response_model=StatusPageRead)
def update_page(page_id: int, payload: StatusPageUpdate, current_user: CurrentUser, db: Db) -> StatusPage:
    page = _get_page(db, page_id)
    changes = {field: getattr(payload, field) for field in payload.model_fields_set}
    if "custom_css" in changes:
        changes["custom_css"] = checked_css(changes["custom_css"])
    if "slug" in changes and changes["slug"] != page.slug and _slug_taken(db, changes["slug"], page.id):
        raise _slug_conflict()
    bump = any(field in changes and changes[field] != getattr(page, field) for field in ("slug", "visibility"))
    for field, value in changes.items():
        setattr(page, field, value)
    if bump:
        page.generation += 1
    detail = ",".join(sorted(changes)) or "none"
    write_audit(db, "status_page.updated", current_user.id, f"status_page:{page.id}", f"fields={detail}")
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise _slug_conflict()
    if bump:
        status_cache.remove_page_sync(page.id, replacement=_registry_entry(page))
    events.notify_pages_changed([page.id])
    return page


@router.delete("/{page_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_page(page_id: int, current_user: CurrentUser, db: Db) -> None:
    page = _get_page(db, page_id)
    cached = status_cache.entry(page_id)
    page.generation += 1
    db.flush()
    for model in (StatusPageItem, StatusPageGroup):
        for row in db.scalars(select(model).where(model.page_id == page.id)):
            db.delete(row)
    incidents.delete_page_records(db, page.id)
    db.flush()
    slug = page.slug
    db.delete(page)
    write_audit(db, "status_page.deleted", current_user.id, f"status_page:{page_id}", f"slug={slug}")
    db.commit()
    if cached is not None:
        status_cache.remove_page_sync(page_id, only=cached)
    if status_cache.entry(page_id) is not None and db.scalar(select(StatusPage.id).where(StatusPage.id == page_id)) is None:
        status_cache.remove_page_sync(page_id)
    events.notify_pages_changed([page_id])


def _unprocessable(detail: str) -> HTTPException:
    return HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=detail)


def _validate_sources(db: Session, refs: list[SourceRef]) -> None:
    device_ids = {r.device_id for r in refs if r.device_id is not None}
    monitor_ids = {r.monitor_id for r in refs if r.monitor_id is not None}
    target_ids = {r.port_target_id for r in refs if r.port_target_id is not None}
    devices = set(db.scalars(select(Device.id).where(Device.id.in_(device_ids)))) if device_ids else set()
    monitors = set(db.scalars(select(Monitor.id).where(Monitor.id.in_(monitor_ids)))) if monitor_ids else set()
    targets = (
        {t.id: t.device_id for t in db.scalars(select(DevicePortTarget).where(DevicePortTarget.id.in_(target_ids)))}
        if target_ids else {}
    )
    for ref in refs:
        if ref.device_id is not None and ref.device_id not in devices:
            raise _unprocessable(f"Device {ref.device_id} does not exist")
        if ref.monitor_id is not None and ref.monitor_id not in monitors:
            raise _unprocessable(f"Monitor {ref.monitor_id} does not exist")
        if ref.port_target_id is not None:
            if ref.port_target_id not in targets:
                raise _unprocessable(f"Service check {ref.port_target_id} does not exist")
            if targets[ref.port_target_id] not in (None, ref.device_id):
                raise _unprocessable(f"Service check {ref.port_target_id} does not apply to device {ref.device_id}")


@router.put("/{page_id}/layout", response_model=StatusPageDetail)
def replace_layout(page_id: int, payload: LayoutUpdate, current_user: CurrentUser, db: Db) -> StatusPageDetail:
    page = _get_page(db, page_id)
    existing_groups = {g.id: g for g in db.scalars(select(StatusPageGroup).where(StatusPageGroup.page_id == page.id))}
    existing_items = {i.id: i for i in db.scalars(select(StatusPageItem).where(StatusPageItem.page_id == page.id))}

    refs: list[SourceRef] = []
    seen_groups: set[int] = set()
    seen_items: set[int] = set()
    seen_keys: set[str] = set()
    for group in payload.groups:
        if group.id is not None:
            if group.id not in existing_groups or group.id in seen_groups:
                raise _unprocessable(f"Group {group.id} does not belong to this page")
            seen_groups.add(group.id)
        for item in group.items:
            if item.id is not None:
                if item.id not in existing_items or item.id in seen_items:
                    raise _unprocessable(f"Item {item.id} does not belong to this page")
                seen_items.add(item.id)
            ref = item.source.to_ref()
            if ref.key in seen_keys:
                raise _unprocessable("A source can appear only once on a page")
            seen_keys.add(ref.key)
            refs.append(ref)
    _validate_sources(db, refs)

    keep: dict[int, StatusPageItem] = {}
    for group in payload.groups:
        for item in group.items:
            row = existing_items.get(item.id) if item.id is not None else None
            if row is not None and SourceRef.from_item(row) == item.source.to_ref():
                keep[row.id] = row
    for item_id, row in existing_items.items():
        if item_id not in keep:
            db.delete(row)
    for group_id, row in existing_groups.items():
        if group_id not in seen_groups:
            db.delete(row)
    db.flush()

    for group_order, group in enumerate(payload.groups):
        row = existing_groups.get(group.id) if group.id is not None else None
        if row is None:
            row = StatusPageGroup(page_id=page.id, name=group.name)
            db.add(row)
        row.name = group.name
        row.collapsed_by_default = group.collapsed_by_default
        row.sort_order = group_order
        db.flush()
        for item_order, item in enumerate(group.items):
            ref = item.source.to_ref()
            target = keep.get(item.id) if item.id is not None else None
            if target is None:
                target = StatusPageItem(
                    page_id=page.id, kind=ref.kind, device_id=ref.device_id,
                    monitor_id=ref.monitor_id, port_target_id=ref.port_target_id,
                )
                db.add(target)
            target.group_id = row.id
            target.display_name = item.display_name
            target.extras = item.extras.model_dump()
            target.sort_order = item_order
    write_audit(
        db, "status_page.layout_updated", current_user.id, f"status_page:{page.id}",
        f"groups={len(payload.groups)} items={len(refs)}",
    )
    db.commit()
    events.notify_pages_changed([page.id])
    return _detail(db, page)
