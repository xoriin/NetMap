import json
from datetime import datetime, timezone
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.deps import require_topology_write
from app.core.config import settings
from app.db.session import get_db
from app.models.device import Device
from app.models.discovery import DiscoveryObservation, DiscoveryScan, DiscoverySchedule
from app.models.topology_group import TopologyGroup
from app.models.user import User
from app.schemas.discovery import (
    DiscoveryHost,
    DiscoveryImportRequest,
    DiscoveryImportResult,
    DiscoveryObservationRead,
    DiscoveryObservationUpdate,
    DiscoveryScanRead,
    DiscoveryScheduleCreate,
    DiscoveryScheduleRead,
    DiscoveryScheduleUpdate,
    DiscoveryStart,
)
from app.services.audit.service import write_audit
from app.services.discovery.scanner import (
    deserialize_results,
    serialize_results,
    validate_target,
)
from app.services.discovery.scheduled import (
    annotate_hosts_with_inventory,
    due_datetime,
    execute_discovery_scan,
    json_dump_list,
    json_list,
    normalize_mac,
    schedule_next_run,
    scheduled_discovery,
)

router = APIRouter(prefix="/discovery", tags=["discovery"])
last_scan_by_user: dict[int, datetime] = {}


def enforce_rate_limit(user_id: int) -> None:
    now = datetime.now(timezone.utc)
    last_scan = last_scan_by_user.get(user_id)
    if last_scan is None:
        last_scan_by_user[user_id] = now
        return
    elapsed = (now - last_scan).total_seconds()
    if elapsed < settings.discovery_rate_limit_seconds:
        wait_seconds = int(settings.discovery_rate_limit_seconds - elapsed)
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=f"Scan rate limit active; retry in {wait_seconds} seconds",
        )
    last_scan_by_user[user_id] = now


def scan_to_read(scan: DiscoveryScan) -> DiscoveryScanRead:
    results = deserialize_results(scan.results_json)
    return DiscoveryScanRead(
        id=scan.id,
        schedule_id=scan.schedule_id,
        target=scan.target,
        scan_type=scan.scan_type,
        status=scan.status,
        host_count=scan.host_count,
        result_count=scan.result_count,
        results=results,
        error=scan.error,
        created_at=scan.created_at,
        completed_at=scan.completed_at,
    )


def scan_to_read_with_inventory(scan: DiscoveryScan, db: Session) -> DiscoveryScanRead:
    read = scan_to_read(scan)
    if not read.results:
        return read
    read.results = annotate_hosts_with_inventory(read.results, db)
    return read


@router.post("/scans", response_model=DiscoveryScanRead, status_code=status.HTTP_201_CREATED)
def start_scan(
    payload: DiscoveryStart,
    current_user: Annotated[User, Depends(require_topology_write)],
    db: Annotated[Session, Depends(get_db)],
) -> DiscoveryScanRead:
    enforce_rate_limit(current_user.id)
    try:
        scan = execute_discovery_scan(db, payload, current_user.id)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    return scan_to_read_with_inventory(scan, db)


@router.get("/scans", response_model=list[DiscoveryScanRead])
def list_scans(
    _current_user: Annotated[User, Depends(require_topology_write)],
    db: Annotated[Session, Depends(get_db)],
) -> list[DiscoveryScanRead]:
    scans = db.scalars(select(DiscoveryScan).order_by(DiscoveryScan.created_at.desc()).limit(20)).all()
    return [scan_to_read_with_inventory(scan, db) for scan in scans]


@router.get("/schedules", response_model=list[DiscoveryScheduleRead])
def list_schedules(
    _current_user: Annotated[User, Depends(require_topology_write)],
    db: Annotated[Session, Depends(get_db)],
) -> list[DiscoveryScheduleRead]:
    schedules = db.scalars(select(DiscoverySchedule).order_by(DiscoverySchedule.created_at.desc())).all()
    counts = dict(
        db.execute(
            select(DiscoveryObservation.schedule_id, func.count())
            .where(DiscoveryObservation.status != "resolved")
            .group_by(DiscoveryObservation.schedule_id)
        ).all()
    )
    return [_schedule_to_read(schedule, int(counts.get(schedule.id, 0))) for schedule in schedules]


@router.post("/schedules", response_model=DiscoveryScheduleRead, status_code=status.HTTP_201_CREATED)
def create_schedule(
    payload: DiscoveryScheduleCreate,
    current_user: Annotated[User, Depends(require_topology_write)],
    db: Annotated[Session, Depends(get_db)],
) -> DiscoveryScheduleRead:
    _validate_schedule_payload(payload)
    now = datetime.now(timezone.utc)
    schedule = DiscoverySchedule(
        owner_user_id=current_user.id,
        name=payload.name.strip(),
        target=payload.target.strip(),
        scan_type=payload.scan_type,
        enabled=payload.enabled,
        interval_minutes=payload.interval_minutes,
        confirm_large_scan=payload.confirm_large_scan,
        topology_group_id=payload.topology_group_id,
        site_id=payload.site_id,
        snmp_profile_id=payload.snmp_profile_id,
        snmp_targets_json=json_dump_list(payload.snmp_targets),
        notification_targets_json=json_dump_list(payload.notification_targets),
        created_at=now,
        updated_at=now,
    )
    schedule_next_run(schedule, now)
    db.add(schedule)
    db.flush()
    write_audit(
        db,
        action="discovery.schedule_created",
        actor_user_id=current_user.id,
        target=f"discovery_schedule:{schedule.id}",
        detail=f"{schedule.name} {schedule.target}",
    )
    db.commit()
    db.refresh(schedule)
    return _schedule_to_read(schedule)


@router.patch("/schedules/{schedule_id}", response_model=DiscoveryScheduleRead)
def update_schedule(
    schedule_id: int,
    payload: DiscoveryScheduleUpdate,
    current_user: Annotated[User, Depends(require_topology_write)],
    db: Annotated[Session, Depends(get_db)],
) -> DiscoveryScheduleRead:
    schedule = db.get(DiscoverySchedule, schedule_id)
    if schedule is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Schedule not found")
    update_data = payload.model_dump(exclude_unset=True)
    merged = DiscoveryScheduleCreate(
        name=update_data.get("name", schedule.name),
        target=update_data.get("target", schedule.target),
        scan_type=update_data.get("scan_type", schedule.scan_type),
        enabled=update_data.get("enabled", schedule.enabled),
        interval_minutes=update_data.get("interval_minutes", schedule.interval_minutes),
        confirm_large_scan=update_data.get("confirm_large_scan", schedule.confirm_large_scan),
        topology_group_id=update_data.get("topology_group_id", schedule.topology_group_id),
        site_id=update_data.get("site_id", schedule.site_id),
        snmp_profile_id=update_data.get("snmp_profile_id", schedule.snmp_profile_id),
        snmp_targets=update_data.get("snmp_targets", json_list(schedule.snmp_targets_json)),
        notification_targets=update_data.get("notification_targets", json_list(schedule.notification_targets_json)),
    )
    _validate_schedule_payload(merged)
    for field in ("name", "target", "scan_type", "enabled", "interval_minutes", "confirm_large_scan", "topology_group_id", "site_id", "snmp_profile_id"):
        if field in update_data:
            setattr(schedule, field, update_data[field].strip() if field in {"name", "target"} else update_data[field])
    if "snmp_targets" in update_data:
        schedule.snmp_targets_json = json_dump_list(update_data["snmp_targets"] or [])
    if "notification_targets" in update_data:
        schedule.notification_targets_json = json_dump_list(update_data["notification_targets"] or [])
    schedule.updated_at = datetime.now(timezone.utc)
    if any(field in update_data for field in ("enabled", "interval_minutes", "target", "scan_type")):
        schedule_next_run(schedule, schedule.updated_at)
    write_audit(
        db,
        action="discovery.schedule_updated",
        actor_user_id=current_user.id,
        target=f"discovery_schedule:{schedule.id}",
        detail=schedule.name,
    )
    db.commit()
    db.refresh(schedule)
    return _schedule_to_read(schedule)


@router.delete("/schedules/{schedule_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_schedule(
    schedule_id: int,
    current_user: Annotated[User, Depends(require_topology_write)],
    db: Annotated[Session, Depends(get_db)],
) -> None:
    schedule = db.get(DiscoverySchedule, schedule_id)
    if schedule is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Schedule not found")
    write_audit(
        db,
        action="discovery.schedule_deleted",
        actor_user_id=current_user.id,
        target=f"discovery_schedule:{schedule.id}",
        detail=schedule.name,
    )
    db.delete(schedule)
    db.commit()


@router.post("/schedules/{schedule_id}/run", response_model=DiscoveryScanRead)
def run_schedule_now(
    schedule_id: int,
    _current_user: Annotated[User, Depends(require_topology_write)],
    db: Annotated[Session, Depends(get_db)],
) -> DiscoveryScanRead:
    schedule = db.get(DiscoverySchedule, schedule_id)
    if schedule is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Schedule not found")
    scan = scheduled_discovery.try_run_schedule(schedule_id)
    if scan is None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Schedule is disabled or a scan is already running for this schedule",
        )
    refreshed = db.get(DiscoveryScan, scan.id)
    return scan_to_read_with_inventory(refreshed or scan, db)


@router.get("/observations", response_model=list[DiscoveryObservationRead])
def list_observations(
    _current_user: Annotated[User, Depends(require_topology_write)],
    db: Annotated[Session, Depends(get_db)],
    schedule_id: int | None = None,
    status_filter: str = "open",
) -> list[DiscoveryObservationRead]:
    query = select(DiscoveryObservation)
    if schedule_id is not None:
        query = query.where(DiscoveryObservation.schedule_id == schedule_id)
    if status_filter != "all":
        query = query.where(DiscoveryObservation.status == status_filter)
    observations = db.scalars(query.order_by(DiscoveryObservation.last_seen_at.desc()).limit(200)).all()

    # Auto-resolve open new_device observations whose IP is already in inventory.
    stale = [o for o in observations if o.observation_type == "new_device" and o.status != "resolved" and o.ip_address]
    if stale:
        existing_ips = set(
            db.scalars(
                select(Device.ip_address).where(
                    Device.ip_address.in_([o.ip_address for o in stale])
                )
            ).all()
        )
        now = datetime.now(timezone.utc)
        dirty = False
        for obs in stale:
            if obs.ip_address in existing_ips:
                obs.status = "resolved"
                obs.resolved_at = now
                dirty = True
        if dirty:
            db.commit()

    if status_filter != "all":
        observations = [o for o in observations if o.status == status_filter]
    return [_observation_to_read(observation) for observation in observations]


@router.patch("/observations/{observation_id}", response_model=DiscoveryObservationRead)
def update_observation(
    observation_id: int,
    payload: DiscoveryObservationUpdate,
    current_user: Annotated[User, Depends(require_topology_write)],
    db: Annotated[Session, Depends(get_db)],
) -> DiscoveryObservationRead:
    observation = db.get(DiscoveryObservation, observation_id)
    if observation is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Observation not found")
    observation.status = payload.status
    observation.resolved_at = datetime.now(timezone.utc) if payload.status == "resolved" else None
    write_audit(
        db,
        action="discovery.observation_updated",
        actor_user_id=current_user.id,
        target=f"discovery_observation:{observation.id}",
        detail=payload.status,
    )
    db.commit()
    db.refresh(observation)
    return _observation_to_read(observation)


_APPLY_ALLOWED_FIELDS = {"ip_address", "hostname", "mac_address", "vendor", "device_type", "os_info", "os"}


@router.post("/observations/{observation_id}/apply", response_model=DiscoveryObservationRead)
def apply_observation(
    observation_id: int,
    current_user: Annotated[User, Depends(require_topology_write)],
    db: Annotated[Session, Depends(get_db)],
) -> DiscoveryObservationRead:
    observation = db.get(DiscoveryObservation, observation_id)
    if observation is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Observation not found")

    if observation.observation_type == "new_device":
        if not observation.ip_address:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Observation has no IP address")
        schedule = db.get(DiscoverySchedule, observation.schedule_id)
        device = Device(
            ip_address=observation.ip_address,
            hostname=observation.hostname,
            mac_address=observation.mac_address,
            device_type="discovered",
            status="online",
            icon="device",
            topology_group_id=schedule.topology_group_id if schedule else None,
            site_id=schedule.site_id if schedule else None,
        )
        db.add(device)
        observation.status = "resolved"
        observation.resolved_at = datetime.now(timezone.utc)
        write_audit(
            db,
            action="discovery.observation_applied",
            actor_user_id=current_user.id,
            target=f"device:{observation.ip_address}",
            detail=f"Added new device from observation {observation.id}",
        )
        db.commit()
        db.refresh(observation)
        return _observation_to_read(observation)

    if observation.observation_type not in ("ip_change", "field_change"):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Cannot apply this observation type")
    if observation.device_id is None:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Observation has no matched device")
    device = db.get(Device, observation.device_id)
    if device is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Matched device not found")
    try:
        details = json.loads(observation.details_json or "{}")
    except json.JSONDecodeError:
        details = {}
    proposed: dict = details.get("proposed_updates", {})
    if not isinstance(proposed, dict):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Re-run the discovery schedule to generate a new observation with field values")
    applied: list[str] = []
    for field, value in proposed.items():
        if field in _APPLY_ALLOWED_FIELDS and value is not None:
            setattr(device, field, value)
            applied.append(field)
    if not applied:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="No applicable fields in observation details — re-run the discovery schedule")
    observation.status = "resolved"
    observation.resolved_at = datetime.now(timezone.utc)
    write_audit(
        db,
        action="discovery.observation_applied",
        actor_user_id=current_user.id,
        target=f"device:{device.id}",
        detail=f"Applied {', '.join(applied)} from observation {observation.id}",
    )
    db.commit()
    db.refresh(observation)
    return _observation_to_read(observation)


@router.post("/import", response_model=DiscoveryImportResult)
def import_scan_results(
    payload: DiscoveryImportRequest,
    current_user: Annotated[User, Depends(require_topology_write)],
    db: Annotated[Session, Depends(get_db)],
) -> DiscoveryImportResult:
    scan = db.get(DiscoveryScan, payload.scan_id)
    if scan is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Scan not found")
    if scan.status != "completed":
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Scan is not completed")

    selected = set(payload.ip_addresses)
    results = [
        result
        for result in deserialize_results(scan.results_json)
        if not selected or result.ip_address in selected
    ]
    created = 0
    updated = 0
    skipped_existing = 0
    results_by_mac = {
        normalize_mac(result.mac_address): result
        for result in results
        if normalize_mac(result.mac_address)
    }
    existing_by_mac: dict[str, Device] = {}
    if results_by_mac:
        for device in db.scalars(select(Device).where(Device.mac_address.is_not(None))).all():
            normalized = normalize_mac(device.mac_address)
            if normalized in results_by_mac and normalized not in existing_by_mac:
                existing_by_mac[normalized] = device
    for result in results:
        existing = db.scalar(select(Device).where(Device.ip_address == result.ip_address))
        matched_by_mac = False
        if existing is None:
            normalized_mac = normalize_mac(result.mac_address)
            if normalized_mac:
                existing = existing_by_mac.get(normalized_mac)
                matched_by_mac = existing is not None
        if existing is None:
            db.add(discovery_result_to_device(result, topology_group_id=payload.topology_group_id, site_id=payload.site_id))
            created += 1
            continue
        if payload.mode == "new_only":
            skipped_existing += 1
            continue

        changed = False
        if (
            matched_by_mac
            and payload.update_ip_on_mac_match
            and existing.ip_address != result.ip_address
        ):
            existing.ip_address = result.ip_address
            changed = True
        for field_name in payload.update_fields:
            discovered_value = getattr(result, field_name)
            if not discovered_value:
                continue
            current_value = getattr(existing, field_name)
            should_update = payload.mode == "override_existing" or not current_value
            if should_update and current_value != discovered_value:
                setattr(existing, field_name, discovered_value)
                changed = True
        existing.status = "online"
        if payload.topology_group_id is not None:
            existing.topology_group_id = payload.topology_group_id
            changed = True
        if payload.site_id is not None:
            existing.site_id = payload.site_id
            changed = True
        if changed:
            updated += 1

    if payload.topology_group_id is not None and "/" in scan.target:
        group = db.get(TopologyGroup, payload.topology_group_id)
        if group is not None and not group.ip_range:
            group.ip_range = scan.target

    write_audit(
        db,
        action="discovery.results_imported",
        actor_user_id=current_user.id,
        target=f"scan:{scan.id}",
        detail=f"created={created} updated={updated} skipped_existing={skipped_existing} mode={payload.mode}",
    )
    db.commit()
    return DiscoveryImportResult(created=created, updated=updated, skipped_existing=skipped_existing)


def discovery_result_to_device(result: DiscoveryHost, topology_group_id: int | None = None, site_id: int | None = None) -> Device:
    return Device(
        hostname=result.hostname,
        ip_address=result.ip_address,
        mac_address=result.mac_address,
        vendor=result.vendor,
        os=result.os,
        device_type="discovered",
        status="online",
        icon="device",
        topology_group_id=topology_group_id,
        site_id=site_id,
    )


def _validate_schedule_payload(payload: DiscoveryScheduleCreate) -> None:
    try:
        validate_target(payload.target, payload.confirm_large_scan)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc


def _schedule_to_read(schedule: DiscoverySchedule, open_observation_count: int = 0) -> DiscoveryScheduleRead:
    return DiscoveryScheduleRead(
        id=schedule.id,
        owner_user_id=schedule.owner_user_id,
        name=schedule.name,
        target=schedule.target,
        scan_type=schedule.scan_type,
        enabled=schedule.enabled,
        interval_minutes=schedule.interval_minutes,
        confirm_large_scan=schedule.confirm_large_scan,
        topology_group_id=schedule.topology_group_id,
        site_id=schedule.site_id,
        snmp_profile_id=schedule.snmp_profile_id,
        snmp_targets=json_list(schedule.snmp_targets_json),
        notification_targets=json_list(schedule.notification_targets_json),
        last_run_at=schedule.last_run_at,
        next_run_at=due_datetime(schedule.next_run_at) if schedule.next_run_at else None,
        last_scan_id=schedule.last_scan_id,
        last_status=schedule.last_status,
        last_error=schedule.last_error,
        open_observation_count=open_observation_count,
        created_at=schedule.created_at,
        updated_at=schedule.updated_at,
    )


def _observation_to_read(observation: DiscoveryObservation) -> DiscoveryObservationRead:
    try:
        details = json.loads(observation.details_json or "{}")
    except json.JSONDecodeError:
        details = {}
    return DiscoveryObservationRead(
        id=observation.id,
        schedule_id=observation.schedule_id,
        scan_id=observation.scan_id,
        device_id=observation.device_id,
        observation_type=observation.observation_type,
        status=observation.status,
        ip_address=observation.ip_address,
        mac_address=observation.mac_address,
        hostname=observation.hostname,
        summary=observation.summary,
        details=details if isinstance(details, dict) else {},
        first_seen_at=observation.first_seen_at,
        last_seen_at=observation.last_seen_at,
        resolved_at=observation.resolved_at,
    )
