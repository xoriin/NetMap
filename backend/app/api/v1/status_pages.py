from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.api.deps import require_status_page_manage
from app.db.session import get_db
from app.models.device import Device
from app.models.monitor import Monitor
from app.models.port_target import DevicePortTarget
from app.models.status_page import StatusPage, StatusPageGroup, StatusPageItem
from app.models.system_setting import SystemSetting
from app.models.user import User
from app.schemas.status_pages import (
    ItemExtras,
    LayoutUpdate,
    StatusPageCreate,
    StatusPageDetail,
    StatusPageRead,
    StatusPageUpdate,
)
from app.services.audit.service import write_audit
from app.services.status_pages import events
from app.services.status_pages.sources import SourceRef

router = APIRouter(prefix="/status-pages", tags=["status-pages"])

DEFAULT_CSS_KEY = "status_page_default_css"

CurrentUser = Annotated[User, Depends(require_status_page_manage)]
Db = Annotated[Session, Depends(get_db)]


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


def _source_dict(item: StatusPageItem) -> dict[str, int]:
    if item.kind == "monitor":
        return {"monitor": item.monitor_id}
    if item.kind == "service_check":
        return {"device": item.device_id, "service_check": item.port_target_id}
    return {"device": item.device_id}


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
            "source": _source_dict(item),
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


@router.get("/{page_id}", response_model=StatusPageDetail)
def get_page(page_id: int, _: CurrentUser, db: Db) -> StatusPageDetail:
    return _detail(db, _get_page(db, page_id))


@router.patch("/{page_id}", response_model=StatusPageRead)
def update_page(page_id: int, payload: StatusPageUpdate, current_user: CurrentUser, db: Db) -> StatusPage:
    page = _get_page(db, page_id)
    changes = {field: getattr(payload, field) for field in payload.model_fields_set}
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
    events.notify_pages_changed([page.id])
    return page


@router.delete("/{page_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_page(page_id: int, current_user: CurrentUser, db: Db) -> None:
    page = _get_page(db, page_id)
    page.generation += 1
    db.flush()
    for model in (StatusPageItem, StatusPageGroup):
        for row in db.scalars(select(model).where(model.page_id == page.id)):
            db.delete(row)
    db.flush()
    slug = page.slug
    db.delete(page)
    write_audit(db, "status_page.deleted", current_user.id, f"status_page:{page_id}", f"slug={slug}")
    db.commit()
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
