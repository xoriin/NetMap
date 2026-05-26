from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
import json
from math import isfinite
import socket
import time
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import or_, select
from sqlalchemy.orm import Session, selectinload

from app.api.deps import get_current_user, require_security_view, require_topology_write
from app.db.firewall_session import get_firewall_db
from app.db.session import get_db
from app.models.device import Device
from app.models.relationship import DeviceRelationship
from app.models.site import Site
from app.models.subnet import Subnet
from app.models.topology_group import TopologyGroup
from app.models.topology_layout import TopologyLayout
from app.models.user import User
from app.models.user_device_favourite import UserDeviceFavourite
from app.schemas.group import (
    DeviceBulkUpdateRequest,
    DeviceBulkUpdateResult,
    GroupResetAssignmentsResult,
    TopologyGroupCreate,
    TopologyGroupRead,
    TopologyGroupUpdate,
    validate_group_dhcp_range,
)
from app.schemas.site import SiteCreate, SiteRead, SiteUpdate
from app.schemas.topology import (
    DeviceBulkImportRequest,
    DeviceBulkImportResult,
    DeviceEventCountList,
    DeviceCreate,
    DeviceLiveStatus,
    DeviceLiveStatusList,
    DeviceLiveStatusRequest,
    DeviceRead,
    DeviceSecurityEventSummary,
    DeviceUpdate,
    RelationshipCreate,
    RelationshipRead,
    RelationshipUpdate,
    TopologyLayoutCreate,
    TopologyLayoutRead,
    TopologyGraph,
)
from app.schemas.tools import PingRequest
from app.services.search import build_device_event_counts, correlation_window_start, list_recent_device_events
from app.services.audit.service import write_audit
from app.services.tools.service import ping_host
from app.services.topology.service import device_to_dict, serialize_tags

router = APIRouter(prefix="/topology", tags=["topology"])
TOPOLOGY_AUTOSAVE_LAYOUT_NAME = "__autosave__"


def _sync_group_ipam_subnet(
    db: Session,
    group: TopologyGroup,
    previous_cidr: str | None = None,
    previous_vlan: str | None = None,
) -> None:
    cidr_values = []
    vlan_values = []
    if group.ip_range:
        cidr_values.append(group.ip_range)
    if previous_cidr and previous_cidr != group.ip_range:
        cidr_values.append(previous_cidr)
    if group.vlan_id:
        vlan_values.append(group.vlan_id)
    if previous_vlan and previous_vlan != group.vlan_id:
        vlan_values.append(previous_vlan)

    if not cidr_values and not vlan_values:
        return

    conditions = []
    if cidr_values:
        conditions.append(Subnet.cidr.in_(cidr_values))
    if vlan_values:
        conditions.append(Subnet.vlan_id.in_(vlan_values))

    matches = db.scalars(select(Subnet).where(or_(*conditions))).all()
    seen: set[int] = set()
    for subnet in matches:
        if subnet.id in seen:
            continue
        seen.add(subnet.id)
        if group.ip_range:
            subnet.cidr = group.ip_range
        subnet.vlan_id = group.vlan_id
        subnet.gateway = group.gateway
        subnet.dhcp_start = group.dhcp_start
        subnet.dhcp_end = group.dhcp_end
        subnet.dns_servers = group.dns_servers
MAX_LIVE_STATUS_DEVICES = 64
LIVE_STATUS_FALLBACK_PORTS = (22, 80, 443, 53)


def sync_topology_group_entities(db: Session) -> None:
    device_group_names = db.scalars(select(Device.topology_group).where(Device.topology_group.is_not(None))).all()
    normalized_names = sorted({name.strip() for name in device_group_names if name and name.strip()})
    if not normalized_names:
        return
    existing = db.scalars(select(TopologyGroup.name).where(TopologyGroup.name.in_(normalized_names))).all()
    existing_names = set(existing)
    missing_names = [name for name in normalized_names if name not in existing_names]
    if not missing_names:
        return
    for name in missing_names:
        db.add(TopologyGroup(name=name))
    db.commit()


@router.get("/graph", response_model=TopologyGraph)
def topology_graph(
    _current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
) -> TopologyGraph:
    devices = db.scalars(select(Device).options(selectinload(Device.group)).order_by(Device.hostname, Device.ip_address)).all()
    relationships = db.scalars(select(DeviceRelationship).order_by(DeviceRelationship.id)).all()
    return TopologyGraph(
        devices=[DeviceRead(**device_to_dict(device)) for device in devices],
        relationships=relationships,
    )


@router.get("/devices", response_model=list[DeviceRead])
def list_devices(
    _current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
) -> list[DeviceRead]:
    devices = db.scalars(select(Device).options(selectinload(Device.group)).order_by(Device.hostname, Device.ip_address)).all()
    return [DeviceRead(**device_to_dict(device)) for device in devices]


@router.post("/devices/bulk-update", response_model=DeviceBulkUpdateResult)
def bulk_update_devices(
    payload: DeviceBulkUpdateRequest,
    current_user: Annotated[User, Depends(require_topology_write)],
    db: Annotated[Session, Depends(get_db)],
) -> DeviceBulkUpdateResult:
    devices = db.scalars(select(Device).where(Device.id.in_(payload.device_ids))).all()
    if not devices:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="No matching devices found")

    group: TopologyGroup | None = None
    if payload.topology_group_id is not None:
        group = db.get(TopologyGroup, payload.topology_group_id)
        if group is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Group not found")

    for device in devices:
        if group is not None:
            device.topology_group_id = group.id
            device.topology_group = group.name
        elif payload.topology_group is not None:
            fallback_group = db.scalar(select(TopologyGroup).where(TopologyGroup.name == payload.topology_group))
            if fallback_group is not None:
                device.topology_group_id = fallback_group.id
            else:
                device.topology_group_id = None
            device.topology_group = payload.topology_group
        else:
            device.topology_group_id = None
            device.topology_group = None

    write_audit(
        db,
        action="topology.devices_bulk_updated",
        actor_user_id=current_user.id,
        target=f"count:{len(devices)}",
        detail=f"group={group.name if group is not None else payload.topology_group or 'inferred'}",
    )
    db.commit()
    sync_topology_group_entities(db)
    return DeviceBulkUpdateResult(updated=len(devices))


@router.post("/groups/reset-device-assignments", response_model=GroupResetAssignmentsResult)
def reset_group_assignments(
    current_user: Annotated[User, Depends(require_topology_write)],
    db: Annotated[Session, Depends(get_db)],
) -> GroupResetAssignmentsResult:
    devices = db.scalars(
        select(Device).where(or_(Device.topology_group.is_not(None), Device.topology_group_id.is_not(None)))
    ).all()
    for device in devices:
        device.topology_group_id = None
        device.topology_group = None

    write_audit(
        db,
        action="topology.groups_assignments_reset",
        actor_user_id=current_user.id,
        target=f"count:{len(devices)}",
    )
    db.commit()
    return GroupResetAssignmentsResult(updated=len(devices))


@router.get("/groups", response_model=list[TopologyGroupRead])
def list_topology_groups(
    _current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
) -> list[TopologyGroup]:
    return db.scalars(select(TopologyGroup).order_by(TopologyGroup.name.asc())).all()


@router.post("/groups", response_model=TopologyGroupRead, status_code=status.HTTP_201_CREATED)
def create_topology_group(
    payload: TopologyGroupCreate,
    current_user: Annotated[User, Depends(require_topology_write)],
    db: Annotated[Session, Depends(get_db)],
) -> TopologyGroup:
    existing = db.scalar(select(TopologyGroup).where(TopologyGroup.name == payload.name))
    if existing is not None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Group name already exists")
    group = TopologyGroup(**payload.model_dump())
    db.add(group)
    db.flush()
    _sync_group_ipam_subnet(db, group)
    write_audit(
        db,
        action="topology.group_created",
        actor_user_id=current_user.id,
        target=f"group:{group.name}",
    )
    db.commit()
    db.refresh(group)
    return group


@router.patch("/groups/{group_id}", response_model=TopologyGroupRead)
def update_topology_group(
    group_id: int,
    payload: TopologyGroupUpdate,
    current_user: Annotated[User, Depends(require_topology_write)],
    db: Annotated[Session, Depends(get_db)],
) -> TopologyGroup:
    group = db.get(TopologyGroup, group_id)
    if group is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Group not found")

    updates = payload.model_dump(exclude_unset=True)
    previous_cidr = group.ip_range
    previous_vlan = group.vlan_id
    if {"ip_range", "dhcp_start", "dhcp_end"} & set(updates):
        try:
            validate_group_dhcp_range(
                updates.get("ip_range", group.ip_range),
                updates.get("dhcp_start", group.dhcp_start),
                updates.get("dhcp_end", group.dhcp_end),
            )
        except ValueError as exc:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc)) from exc
    if "name" in updates:
        name_exists = db.scalar(
            select(TopologyGroup).where(TopologyGroup.name == updates["name"], TopologyGroup.id != group.id)
        )
        if name_exists is not None:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Group name already exists")
        old_name = group.name
        new_name = updates["name"]
        if old_name != new_name:
            devices = db.scalars(
                select(Device).where(
                    or_(
                        Device.topology_group_id == group.id,
                        Device.topology_group == old_name,
                    )
                )
            ).all()
            for device in devices:
                device.topology_group_id = group.id
                device.topology_group = new_name

    for field, value in updates.items():
        setattr(group, field, value)
    _sync_group_ipam_subnet(db, group, previous_cidr=previous_cidr, previous_vlan=previous_vlan)

    write_audit(
        db,
        action="topology.group_updated",
        actor_user_id=current_user.id,
        target=f"group:{group.name}",
    )
    db.commit()
    db.refresh(group)
    return group


@router.delete("/groups/{group_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_topology_group(
    group_id: int,
    current_user: Annotated[User, Depends(require_topology_write)],
    db: Annotated[Session, Depends(get_db)],
) -> None:
    group = db.get(TopologyGroup, group_id)
    if group is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Group not found")
    devices = db.scalars(
        select(Device).where(or_(Device.topology_group_id == group.id, Device.topology_group == group.name))
    ).all()
    for device in devices:
        device.topology_group_id = None
        device.topology_group = None
    db.delete(group)
    write_audit(
        db,
        action="topology.group_deleted",
        actor_user_id=current_user.id,
        target=f"group:{group.name}",
    )
    db.commit()


@router.post("/devices/live-status", response_model=DeviceLiveStatusList)
def list_live_device_status(
    payload: DeviceLiveStatusRequest,
    _current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
) -> DeviceLiveStatusList:
    if payload.device_ids:
        target_ids = list(dict.fromkeys(payload.device_ids))
        if len(target_ids) > MAX_LIVE_STATUS_DEVICES:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Live status checks are limited to {MAX_LIVE_STATUS_DEVICES} devices per request",
            )
        devices = db.scalars(
            select(Device).where(Device.id.in_(target_ids)).order_by(Device.hostname, Device.ip_address),
        ).all()
    else:
        devices = db.scalars(select(Device).order_by(Device.hostname, Device.ip_address).limit(MAX_LIVE_STATUS_DEVICES)).all()

    statuses: list[DeviceLiveStatus] = []
    if not devices:
        return DeviceLiveStatusList(statuses=[])

    workers = max(1, min(12, len(devices)))

    def probe(device: Device) -> DeviceLiveStatus:
        checked_at = datetime.now(timezone.utc)
        ping_error: str | None = None
        try:
            result = ping_host(
                PingRequest(
                    host=device.ip_address,
                    count=1,
                    timeout_seconds=max(2, payload.timeout_seconds),
                )
            )
            reachable = (result.received or 0) > 0
            next_status = "online" if reachable else "offline"
            return DeviceLiveStatus(
                device_id=device.id,
                status=next_status,
                latency_ms=result.average_ms,
                last_checked_at=checked_at,
                error=None if reachable else result.raw_output[:200] if result.raw_output else None,
            )
        except Exception as exc:  # noqa: BLE001
            ping_error = str(exc)

        tcp_probe_timeout = max(0.5, float(payload.timeout_seconds))
        for port in LIVE_STATUS_FALLBACK_PORTS:
            try:
                started = time.perf_counter()
                with socket.create_connection((device.ip_address, port), timeout=tcp_probe_timeout):
                    latency_ms = (time.perf_counter() - started) * 1000
                    return DeviceLiveStatus(
                        device_id=device.id,
                        status="online",
                        latency_ms=round(latency_ms, 2),
                        last_checked_at=checked_at,
                        error=f"icmp unavailable, tcp:{port} reachable" if ping_error else None,
                    )
            except OSError:
                continue

        return DeviceLiveStatus(
            device_id=device.id,
            status="offline",
            latency_ms=None,
            last_checked_at=checked_at,
            error=ping_error,
        )

    with ThreadPoolExecutor(max_workers=workers) as executor:
        future_map = {executor.submit(probe, device): device.id for device in devices}
        for future in as_completed(future_map):
            statuses.append(future.result())

    statuses.sort(key=lambda row: row.device_id)
    return DeviceLiveStatusList(statuses=statuses)


@router.get("/sites", response_model=list[SiteRead])
def list_sites(
    _current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
) -> list[Site]:
    return db.scalars(select(Site).order_by(Site.name.asc())).all()


@router.post("/sites", response_model=SiteRead, status_code=status.HTTP_201_CREATED)
def create_site(
    payload: SiteCreate,
    current_user: Annotated[User, Depends(require_topology_write)],
    db: Annotated[Session, Depends(get_db)],
) -> Site:
    existing = db.scalar(select(Site).where(Site.name == payload.name))
    if existing is not None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Site name already exists")
    site = Site(**payload.model_dump())
    db.add(site)
    db.flush()
    write_audit(db, action="topology.site_created", actor_user_id=current_user.id, target=f"site:{site.name}")
    db.commit()
    db.refresh(site)
    return site


@router.patch("/sites/{site_id}", response_model=SiteRead)
def update_site(
    site_id: int,
    payload: SiteUpdate,
    current_user: Annotated[User, Depends(require_topology_write)],
    db: Annotated[Session, Depends(get_db)],
) -> Site:
    site = db.get(Site, site_id)
    if site is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Site not found")

    updates = payload.model_dump(exclude_unset=True)
    if "name" in updates:
        name_exists = db.scalar(select(Site).where(Site.name == updates["name"], Site.id != site.id))
        if name_exists is not None:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Site name already exists")

    for field, value in updates.items():
        setattr(site, field, value)

    write_audit(db, action="topology.site_updated", actor_user_id=current_user.id, target=f"site:{site.name}")
    db.commit()
    db.refresh(site)
    return site


@router.delete("/sites/{site_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_site(
    site_id: int,
    current_user: Annotated[User, Depends(require_topology_write)],
    db: Annotated[Session, Depends(get_db)],
) -> None:
    site = db.get(Site, site_id)
    if site is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Site not found")
    devices = db.scalars(select(Device).where(Device.site_id == site_id)).all()
    for device in devices:
        device.site_id = None
    db.delete(site)
    write_audit(db, action="topology.site_deleted", actor_user_id=current_user.id, target=f"site:{site.name}")
    db.commit()


@router.get("/layouts", response_model=list[TopologyLayoutRead])
def list_topology_layouts(
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
) -> list[TopologyLayoutRead]:
    layouts = db.scalars(
        select(TopologyLayout)
        .where(
            or_(
                TopologyLayout.owner_user_id == current_user.id,
                TopologyLayout.name == TOPOLOGY_AUTOSAVE_LAYOUT_NAME,
            )
        )
        .order_by(TopologyLayout.updated_at.desc(), TopologyLayout.name.asc()),
    ).all()
    return [serialize_topology_layout(layout) for layout in layouts]


@router.post("/layouts", response_model=TopologyLayoutRead, status_code=status.HTTP_201_CREATED)
def save_topology_layout(
    payload: TopologyLayoutCreate,
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
) -> TopologyLayoutRead:
    layout = db.scalar(
        select(TopologyLayout).where(
            TopologyLayout.owner_user_id == current_user.id,
            TopologyLayout.name == payload.name,
        ),
    )
    created = layout is None
    serialized_display_prefs = json.dumps(payload.display_prefs) if payload.display_prefs is not None else None
    if layout is None:
        layout = TopologyLayout(
            owner_user_id=current_user.id,
            name=payload.name,
            positions_json=json.dumps(serialize_layout_positions(payload.positions)),
            display_prefs_json=serialized_display_prefs,
        )
        db.add(layout)
        db.flush()
    else:
        layout.positions_json = json.dumps(serialize_layout_positions(payload.positions))
        if payload.display_prefs is not None:
            layout.display_prefs_json = serialized_display_prefs

    write_audit(
        db,
        action="topology.layout_saved",
        actor_user_id=current_user.id,
        target=f"layout:{layout.name}",
        detail=f"nodes={len(payload.positions)} created={created}",
    )
    db.commit()
    db.refresh(layout)
    return serialize_topology_layout(layout)


@router.delete("/layouts/{layout_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_topology_layout(
    layout_id: int,
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
) -> None:
    layout = db.get(TopologyLayout, layout_id)
    if layout is None or layout.owner_user_id != current_user.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Layout not found")
    write_audit(
        db,
        action="topology.layout_deleted",
        actor_user_id=current_user.id,
        target=f"layout:{layout.name}",
    )
    db.delete(layout)
    db.commit()


@router.get("/devices/{device_id}/security-events", response_model=DeviceSecurityEventSummary)
def list_device_security_events(
    device_id: int,
    _current_user: Annotated[User, Depends(require_security_view)],
    db: Annotated[Session, Depends(get_db)],
    firewall_db: Annotated[Session, Depends(get_firewall_db)],
    window_hours: int = 24,
    limit: int = 25,
) -> DeviceSecurityEventSummary:
    bounded_window = min(max(window_hours, 1), 24 * 7)
    bounded_limit = min(max(limit, 1), 100)
    window_start = correlation_window_start(bounded_window)

    device = db.get(Device, device_id)
    if device is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Device not found")

    events = list_recent_device_events(
        firewall_db,
        device=device,
        window_start=window_start,
        limit=bounded_limit,
    )
    event_counts = build_device_event_counts(firewall_db, [device], window_start=window_start)[device.id]
    return DeviceSecurityEventSummary(
        device_id=device.id,
        window_hours=bounded_window,
        blocked_count=event_counts.blocked_count,
        passed_count=event_counts.passed_count,
        total_count=event_counts.event_count,
        last_seen_event_time=event_counts.last_seen_event_time,
        events=events,
    )


@router.get("/security/event-counts", response_model=DeviceEventCountList)
def list_device_event_counts(
    _current_user: Annotated[User, Depends(require_security_view)],
    db: Annotated[Session, Depends(get_db)],
    firewall_db: Annotated[Session, Depends(get_firewall_db)],
    window_hours: int = 24,
    with_events_only: bool = False,
) -> DeviceEventCountList:
    bounded_window = min(max(window_hours, 1), 24 * 7)
    window_start = correlation_window_start(bounded_window)
    devices = db.scalars(select(Device).order_by(Device.hostname, Device.ip_address)).all()
    event_counts = build_device_event_counts(firewall_db, devices, window_start=window_start)
    rows = [event_counts[device.id] for device in devices]
    if with_events_only:
        rows = [row for row in rows if row.event_count > 0]
    return DeviceEventCountList(window_hours=bounded_window, devices=rows)


@router.get("/security/top-affected", response_model=DeviceEventCountList)
def list_top_affected_devices(
    _current_user: Annotated[User, Depends(require_security_view)],
    db: Annotated[Session, Depends(get_db)],
    firewall_db: Annotated[Session, Depends(get_firewall_db)],
    window_hours: int = 24,
    limit: int = 10,
) -> DeviceEventCountList:
    bounded_window = min(max(window_hours, 1), 24 * 7)
    bounded_limit = min(max(limit, 1), 50)
    window_start = correlation_window_start(bounded_window)
    devices = db.scalars(select(Device).order_by(Device.hostname, Device.ip_address)).all()
    event_counts = build_device_event_counts(firewall_db, devices, window_start=window_start)
    _epoch = datetime.min.replace(tzinfo=timezone.utc)
    rows = sorted(
        event_counts.values(),
        key=lambda row: (row.event_count, row.last_seen_event_time is not None, row.last_seen_event_time or _epoch),
        reverse=True,
    )
    filtered = [row for row in rows if row.event_count > 0][:bounded_limit]
    return DeviceEventCountList(window_hours=bounded_window, devices=filtered)


@router.post("/devices", response_model=DeviceRead, status_code=status.HTTP_201_CREATED)
def create_device(
    payload: DeviceCreate,
    current_user: Annotated[User, Depends(require_topology_write)],
    db: Annotated[Session, Depends(get_db)],
) -> DeviceRead:
    group_id = payload.topology_group_id
    group_name = payload.topology_group
    if group_id is not None:
        group = db.get(TopologyGroup, group_id)
        if group is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Group not found")
        group_name = group.name
    elif group_name is not None:
        group = db.scalar(select(TopologyGroup).where(TopologyGroup.name == group_name))
        if group is not None:
            group_id = group.id

    site_id = payload.site_id
    if site_id is not None and db.get(Site, site_id) is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Site not found")

    device = Device(
        display_name=payload.display_name,
        hostname=payload.hostname,
        ip_address=payload.ip_address or "",
        mac_address=payload.mac_address,
        vendor=payload.vendor,
        device_type=payload.device_type,
        status=payload.status,
        icon=payload.icon,
        color=payload.color,
        vlan_id=payload.vlan_id,
        subnet=payload.subnet,
        topology_group_id=group_id,
        topology_group=group_name,
        site_id=site_id,
        tags=serialize_tags(payload.tags),
        notes=payload.notes,
    )
    db.add(device)
    db.flush()
    write_audit(
        db,
        action="topology.device_created",
        actor_user_id=current_user.id,
        target=f"device:{device.id}",
        detail=device.ip_address,
    )
    db.commit()
    db.refresh(device)
    sync_topology_group_entities(db)
    return DeviceRead(**device_to_dict(device))


@router.post("/devices/import", response_model=DeviceBulkImportResult)
def import_devices(
    payload: DeviceBulkImportRequest,
    current_user: Annotated[User, Depends(require_topology_write)],
    db: Annotated[Session, Depends(get_db)],
) -> DeviceBulkImportResult:
    created = 0
    updated = 0
    errors: list[str] = []
    for device_data in payload.devices:
        try:
            existing = db.scalar(select(Device).where(Device.ip_address == device_data.ip_address))
            if existing is None:
                group_id = device_data.topology_group_id
                group_name = device_data.topology_group
                if group_id is not None:
                    group = db.get(TopologyGroup, group_id)
                    if group is None:
                        group_id = None
                    else:
                        group_name = group.name
                elif group_name is not None:
                    group_obj = db.scalar(select(TopologyGroup).where(TopologyGroup.name == group_name))
                    if group_obj is not None:
                        group_id = group_obj.id
                db.add(Device(
                    display_name=device_data.display_name,
                    hostname=device_data.hostname,
                    ip_address=device_data.ip_address,
                    mac_address=device_data.mac_address,
                    vendor=device_data.vendor,
                    device_type=device_data.device_type,
                    status=device_data.status or "unknown",
                    icon=device_data.icon or "device",
                    color=device_data.color,
                    vlan_id=device_data.vlan_id,
                    subnet=device_data.subnet,
                    topology_group_id=group_id,
                    topology_group=group_name,
                    tags=json.dumps(device_data.tags or []),
                    notes=device_data.notes,
                ))
                created += 1
            else:
                if device_data.hostname:
                    existing.hostname = device_data.hostname
                if device_data.display_name:
                    existing.display_name = device_data.display_name
                if device_data.mac_address:
                    existing.mac_address = device_data.mac_address
                if device_data.vendor:
                    existing.vendor = device_data.vendor
                if device_data.device_type:
                    existing.device_type = device_data.device_type
                updated += 1
        except Exception as exc:  # noqa: BLE001
            errors.append(f"{device_data.ip_address}: {exc}")
    write_audit(
        db,
        action="topology.devices_bulk_imported",
        actor_user_id=current_user.id,
        target=f"count:{created + updated}",
        detail=f"created={created} updated={updated} errors={len(errors)}",
    )
    db.commit()
    sync_topology_group_entities(db)
    return DeviceBulkImportResult(created=created, updated=updated, errors=errors)


@router.get("/devices/favourites", response_model=list[int])
def list_favourites(
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
) -> list[int]:
    return list(db.scalars(
        select(UserDeviceFavourite.device_id)
        .where(UserDeviceFavourite.user_id == current_user.id)
    ).all())


@router.get("/devices/{device_id}", response_model=DeviceRead)
def get_device(
    device_id: int,
    _current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
) -> DeviceRead:
    device = db.get(Device, device_id)
    if device is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Device not found")
    return DeviceRead(**device_to_dict(device))


@router.patch("/devices/{device_id}", response_model=DeviceRead)
def update_device(
    device_id: int,
    payload: DeviceUpdate,
    current_user: Annotated[User, Depends(require_topology_write)],
    db: Annotated[Session, Depends(get_db)],
) -> DeviceRead:
    device = db.get(Device, device_id)
    if device is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Device not found")

    updates = payload.model_dump(exclude_unset=True)
    group_changed = "topology_group_id" in updates or "topology_group" in updates
    if "topology_group_id" in updates:
        group_id = updates["topology_group_id"]
        if group_id is None:
            device.topology_group_id = None
            device.topology_group = None
            updates.pop("topology_group_id")
        else:
            group = db.get(TopologyGroup, group_id)
            if group is None:
                raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Group not found")
            device.topology_group_id = group.id
            device.topology_group = group.name
            updates.pop("topology_group_id")
    if "site_id" in updates:
        site_id_val = updates.pop("site_id")
        if site_id_val is not None and db.get(Site, site_id_val) is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Site not found")
        device.site_id = site_id_val
    if "tags" in updates:
        device.tags = serialize_tags(updates.pop("tags"))
    if "ip_address" in updates and updates["ip_address"] is None:
        updates["ip_address"] = ""
    for field, value in updates.items():
        setattr(device, field, value)

    write_audit(
        db,
        action="topology.device_updated",
        actor_user_id=current_user.id,
        target=f"device:{device.id}",
        detail=device.ip_address,
    )
    db.commit()
    db.refresh(device)
    if group_changed:
        sync_topology_group_entities(db)
    return DeviceRead(**device_to_dict(device))


@router.patch("/devices/{device_id}/favourite", response_model=DeviceRead)
def toggle_favourite(
    device_id: int,
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
) -> DeviceRead:
    device = db.get(Device, device_id)
    if device is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Device not found")
    fav = db.get(UserDeviceFavourite, (current_user.id, device_id))
    if fav:
        db.delete(fav)
        is_fav = False
    else:
        db.add(UserDeviceFavourite(user_id=current_user.id, device_id=device_id))
        is_fav = True
    db.commit()
    result = DeviceRead(**device_to_dict(device))
    result.is_favourite = is_fav
    return result


@router.delete("/devices/{device_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_device(
    device_id: int,
    current_user: Annotated[User, Depends(require_topology_write)],
    db: Annotated[Session, Depends(get_db)],
) -> None:
    device = db.get(Device, device_id)
    if device is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Device not found")

    db.query(DeviceRelationship).filter(
        or_(
            DeviceRelationship.source_device_id == device_id,
            DeviceRelationship.target_device_id == device_id,
        )
    ).delete(synchronize_session=False)
    write_audit(
        db,
        action="topology.device_deleted",
        actor_user_id=current_user.id,
        target=f"device:{device.id}",
        detail=device.ip_address,
    )
    db.delete(device)
    db.commit()


def ensure_device_exists(db: Session, device_id: int) -> None:
    if db.get(Device, device_id) is None:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Device relationship is invalid")


@router.post(
    "/relationships",
    response_model=RelationshipRead,
    status_code=status.HTTP_201_CREATED,
)
def create_relationship(
    payload: RelationshipCreate,
    current_user: Annotated[User, Depends(require_topology_write)],
    db: Annotated[Session, Depends(get_db)],
) -> DeviceRelationship:
    ensure_device_exists(db, payload.source_device_id)
    ensure_device_exists(db, payload.target_device_id)
    relationship = DeviceRelationship(**payload.model_dump())
    db.add(relationship)
    db.flush()
    write_audit(
        db,
        action="topology.relationship_created",
        actor_user_id=current_user.id,
        target=f"relationship:{relationship.id}",
        detail=f"{relationship.source_device_id}->{relationship.target_device_id}",
    )
    db.commit()
    db.refresh(relationship)
    return relationship


@router.patch("/relationships/{relationship_id}", response_model=RelationshipRead)
def update_relationship(
    relationship_id: int,
    payload: RelationshipUpdate,
    current_user: Annotated[User, Depends(require_topology_write)],
    db: Annotated[Session, Depends(get_db)],
) -> DeviceRelationship:
    relationship = db.get(DeviceRelationship, relationship_id)
    if relationship is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Relationship not found")

    updates = payload.model_dump(exclude_unset=True)
    source_id = updates.get("source_device_id", relationship.source_device_id)
    target_id = updates.get("target_device_id", relationship.target_device_id)
    if source_id == target_id:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Relationship is invalid")
    ensure_device_exists(db, source_id)
    ensure_device_exists(db, target_id)

    for field, value in updates.items():
        setattr(relationship, field, value)

    write_audit(
        db,
        action="topology.relationship_updated",
        actor_user_id=current_user.id,
        target=f"relationship:{relationship.id}",
    )
    db.commit()
    db.refresh(relationship)
    return relationship


@router.delete("/relationships/{relationship_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_relationship(
    relationship_id: int,
    current_user: Annotated[User, Depends(require_topology_write)],
    db: Annotated[Session, Depends(get_db)],
) -> None:
    relationship = db.get(DeviceRelationship, relationship_id)
    if relationship is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Relationship not found")
    write_audit(
        db,
        action="topology.relationship_deleted",
        actor_user_id=current_user.id,
        target=f"relationship:{relationship.id}",
    )
    db.delete(relationship)
    db.commit()


def serialize_topology_layout(layout: TopologyLayout) -> TopologyLayoutRead:
    return TopologyLayoutRead(
        id=layout.id,
        owner_user_id=layout.owner_user_id,
        name=layout.name,
        positions=deserialize_layout_positions(layout.positions_json),
        display_prefs=deserialize_display_prefs(layout.display_prefs_json),
        created_at=layout.created_at,
        updated_at=layout.updated_at,
    )


def deserialize_display_prefs(raw: str | None) -> dict | None:
    if not raw:
        return None
    try:
        value = json.loads(raw)
        return value if isinstance(value, dict) else None
    except json.JSONDecodeError:
        return None


def deserialize_layout_positions(raw_positions: str) -> dict:
    try:
        value = json.loads(raw_positions)
    except json.JSONDecodeError:
        return {}
    if not isinstance(value, dict):
        return {}
    positions: dict[str, dict[str, float]] = {}
    for key, position in value.items():
        node_id = str(key).strip()
        if not (node_id.startswith("device-") or node_id.startswith("group-")) or not isinstance(position, dict):
            continue
        try:
            x = float(position["x"])
            y = float(position["y"])
        except (KeyError, TypeError, ValueError):
            continue
        if not isfinite(x) or not isfinite(y):
            continue
        positions[node_id] = {"x": x, "y": y}
    return positions


def serialize_layout_positions(positions: dict) -> dict:
    return {
        key: {"x": value.x, "y": value.y}
        for key, value in positions.items()
    }
