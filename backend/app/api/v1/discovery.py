from datetime import datetime, timezone
from ipaddress import ip_address
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import require_topology_write
from app.core.config import settings
from app.db.session import get_db
from app.models.device import Device
from app.models.discovery import DiscoveryScan
from app.models.snmp_profile import SnmpProfile
from app.models.topology_group import TopologyGroup
from app.models.user import User
from app.schemas.discovery import (
    DiscoveryHost,
    DiscoveryImportRequest,
    DiscoveryImportResult,
    DiscoveryScanRead,
    DiscoveryStart,
)
from app.services.audit.service import write_audit
from app.services.discovery.scanner import (
    deserialize_results,
    enrich_hosts_from_snmp_arp,
    ensure_private_address,
    run_nmap_scan,
    serialize_results,
    validate_target,
)
from app.services.snmp import SnmpError
from app.services.snmp_profiles import decrypt_profile_community

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
    return DiscoveryScanRead(
        id=scan.id,
        target=scan.target,
        scan_type=scan.scan_type,
        status=scan.status,
        host_count=scan.host_count,
        result_count=scan.result_count,
        results=deserialize_results(scan.results_json),
        error=scan.error,
        created_at=scan.created_at,
        completed_at=scan.completed_at,
    )


@router.post("/scans", response_model=DiscoveryScanRead, status_code=status.HTTP_201_CREATED)
def start_scan(
    payload: DiscoveryStart,
    current_user: Annotated[User, Depends(require_topology_write)],
    db: Annotated[Session, Depends(get_db)],
) -> DiscoveryScanRead:
    try:
        target = validate_target(payload.target, payload.confirm_large_scan)
        snmp_targets = list(payload.snmp_targets)
        if not snmp_targets and payload.topology_group_id is not None:
            group = db.get(TopologyGroup, payload.topology_group_id)
            if group is not None and group.gateway:
                snmp_targets = [group.gateway]
        for snmp_target in snmp_targets:
            ensure_private_address(ip_address(snmp_target))
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    enforce_rate_limit(current_user.id)

    scan = DiscoveryScan(
        actor_user_id=current_user.id,
        target=target.nmap_target,
        scan_type=payload.scan_type,
        status="running",
        host_count=target.host_count,
    )
    db.add(scan)
    db.flush()
    write_audit(
        db,
        action="discovery.scan_started",
        actor_user_id=current_user.id,
        target=f"scan:{scan.id}",
        detail=f"{payload.scan_type} {target.nmap_target}",
    )
    db.commit()
    db.refresh(scan)

    try:
        results = run_nmap_scan(target, payload.scan_type)
        snmp_community = payload.snmp_community
        snmp_port = payload.snmp_port
        snmp_timeout = payload.snmp_timeout_seconds
        snmp_retries = 1
        if payload.snmp_profile_id is not None:
            profile = db.get(SnmpProfile, payload.snmp_profile_id)
            if profile is None:
                raise ValueError("SNMP profile not found")
            snmp_community = decrypt_profile_community(profile)
            snmp_port = profile.port
            snmp_timeout = profile.timeout_seconds
            snmp_retries = profile.retries
        if snmp_community and snmp_targets:
            try:
                results = enrich_hosts_from_snmp_arp(
                    results,
                    snmp_targets,
                    snmp_community,
                    port=snmp_port,
                    timeout_seconds=snmp_timeout,
                    retries=snmp_retries,
                )
            except (TimeoutError, SnmpError, OSError):
                pass
        scan.status = "completed"
        scan.result_count = len(results)
        scan.results_json = serialize_results(results)
        scan.completed_at = datetime.now(timezone.utc)
        write_audit(
            db,
            action="discovery.scan_completed",
            actor_user_id=current_user.id,
            target=f"scan:{scan.id}",
            detail=f"{len(results)} hosts",
        )
    except Exception as exc:
        scan.status = "failed"
        scan.error = str(exc)
        scan.completed_at = datetime.now(timezone.utc)
        write_audit(
            db,
            action="discovery.scan_failed",
            actor_user_id=current_user.id,
            target=f"scan:{scan.id}",
            detail=str(exc),
        )
    db.commit()
    db.refresh(scan)
    return scan_to_read(scan)


@router.get("/scans", response_model=list[DiscoveryScanRead])
def list_scans(
    _current_user: Annotated[User, Depends(require_topology_write)],
    db: Annotated[Session, Depends(get_db)],
) -> list[DiscoveryScanRead]:
    scans = db.scalars(select(DiscoveryScan).order_by(DiscoveryScan.created_at.desc()).limit(20)).all()
    return [scan_to_read(scan) for scan in scans]


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
    for result in results:
        existing = db.scalar(select(Device).where(Device.ip_address == result.ip_address))
        if existing is None:
            db.add(discovery_result_to_device(result, topology_group_id=payload.topology_group_id, site_id=payload.site_id))
            created += 1
            continue
        existing.hostname = result.hostname or existing.hostname
        existing.mac_address = result.mac_address or existing.mac_address
        existing.vendor = result.vendor or existing.vendor
        existing.status = "online"
        if payload.topology_group_id is not None:
            existing.topology_group_id = payload.topology_group_id
        if payload.site_id is not None:
            existing.site_id = payload.site_id
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
        detail=f"created={created} updated={updated}",
    )
    db.commit()
    return DiscoveryImportResult(created=created, updated=updated)


def discovery_result_to_device(result: DiscoveryHost, topology_group_id: int | None = None, site_id: int | None = None) -> Device:
    return Device(
        hostname=result.hostname,
        ip_address=result.ip_address,
        mac_address=result.mac_address,
        vendor=result.vendor,
        device_type="discovered",
        status="online",
        icon="device",
        topology_group_id=topology_group_id,
        site_id=site_id,
    )
