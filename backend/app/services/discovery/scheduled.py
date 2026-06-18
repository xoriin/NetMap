from __future__ import annotations

import json
import logging
import threading
from datetime import datetime, timedelta, timezone
from ipaddress import ip_address
from typing import Iterable

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.db.session import SessionLocal
from app.models.device import Device
from app.models.discovery import DiscoveryObservation, DiscoveryScan, DiscoverySchedule
from app.models.snmp_profile import SnmpProfile
from app.models.topology_group import TopologyGroup
from app.schemas.discovery import DiscoveryHost, DiscoveryStart
from app.services.audit.service import write_audit
from app.services.discovery.scanner import (
    deserialize_results,
    enrich_hosts_from_snmp_arp,
    ensure_private_address,
    run_nmap_scan,
    serialize_results,
    validate_target,
)
from app.services.notifications import list_notification_profiles, load_notification_settings, send_notification_target
from app.services.snmp import SnmpError
from app.services.snmp_profiles import decrypt_profile_community

logger = logging.getLogger(__name__)


def normalize_mac(mac_address: str | None) -> str | None:
    if not mac_address:
        return None
    value = "".join(ch for ch in mac_address.lower() if ch in "0123456789abcdef")
    if len(value) != 12:
        return None
    return ":".join(value[idx:idx + 2] for idx in range(0, 12, 2))


def json_list(raw: str | None) -> list[str]:
    if not raw:
        return []
    try:
        value = json.loads(raw)
    except json.JSONDecodeError:
        return []
    return [str(item) for item in value if str(item).strip()] if isinstance(value, list) else []


def json_dump_list(values: Iterable[str]) -> str:
    return json.dumps([value for value in values if value])


def execute_discovery_scan(
    db: Session,
    payload: DiscoveryStart,
    actor_user_id: int,
    *,
    schedule_id: int | None = None,
) -> DiscoveryScan:
    target = validate_target(payload.target, payload.confirm_large_scan)
    snmp_targets = list(payload.snmp_targets)
    if not snmp_targets and payload.topology_group_id is not None:
        group = db.get(TopologyGroup, payload.topology_group_id)
        if group is not None and group.gateway:
            snmp_targets = [group.gateway]
    for snmp_target in snmp_targets:
        ensure_private_address(ip_address(snmp_target))

    scan = DiscoveryScan(
        actor_user_id=actor_user_id,
        schedule_id=schedule_id,
        target=target.nmap_target,
        scan_type=payload.scan_type,
        status="running",
        host_count=target.host_count,
    )
    db.add(scan)
    db.flush()
    write_audit(
        db,
        action="discovery.scan_started" if schedule_id is None else "discovery.scheduled_scan_started",
        actor_user_id=actor_user_id,
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
                logger.exception("SNMP ARP enrichment failed during discovery scan")
        scan.status = "completed"
        scan.result_count = len(results)
        scan.results_json = serialize_results(results)
        scan.completed_at = datetime.now(timezone.utc)
        write_audit(
            db,
            action="discovery.scan_completed" if schedule_id is None else "discovery.scheduled_scan_completed",
            actor_user_id=actor_user_id,
            target=f"scan:{scan.id}",
            detail=f"{len(results)} hosts",
        )
    except Exception as exc:
        scan.status = "failed"
        scan.error = str(exc)
        scan.completed_at = datetime.now(timezone.utc)
        write_audit(
            db,
            action="discovery.scan_failed" if schedule_id is None else "discovery.scheduled_scan_failed",
            actor_user_id=actor_user_id,
            target=f"scan:{scan.id}",
            detail=str(exc),
        )
    db.commit()
    db.refresh(scan)
    return scan


def annotate_hosts_with_inventory(hosts: list[DiscoveryHost], db: Session) -> list[DiscoveryHost]:
    if not hosts:
        return hosts
    ips = [host.ip_address for host in hosts]
    macs = [normalize_mac(host.mac_address) for host in hosts if normalize_mac(host.mac_address)]
    existing_by_ip = {
        device.ip_address: device
        for device in db.scalars(select(Device).where(Device.ip_address.in_(ips))).all()
    }
    existing_by_mac: dict[str, Device] = {}
    if macs:
        for device in db.scalars(select(Device).where(Device.mac_address.is_not(None))).all():
            normalized = normalize_mac(device.mac_address)
            if normalized in macs and normalized not in existing_by_mac:
                existing_by_mac[normalized] = device
    for host in hosts:
        existing = existing_by_ip.get(host.ip_address)
        matched_by_mac = False
        if existing is None:
            normalized_mac = normalize_mac(host.mac_address)
            if normalized_mac:
                existing = existing_by_mac.get(normalized_mac)
                matched_by_mac = existing is not None
        if existing is None:
            host.import_status = "new"
            host.existing_device_id = None
            host.proposed_updates = []
            continue
        host.existing_device_id = existing.id
        proposed: list[str] = []
        if matched_by_mac and host.ip_address != existing.ip_address:
            proposed.append("ip_address")
        if host.hostname and host.hostname != existing.hostname:
            proposed.append("hostname")
        if host.mac_address and normalize_mac(host.mac_address) != normalize_mac(existing.mac_address):
            proposed.append("mac_address")
        if host.vendor and host.vendor != existing.vendor:
            proposed.append("vendor")
        if host.os and host.os != existing.os:
            proposed.append("os")
        host.proposed_updates = proposed
        host.import_status = "changed" if proposed else "existing"
    return hosts


def create_observations_for_scan(
    db: Session,
    schedule: DiscoverySchedule,
    scan: DiscoveryScan,
    previous_scan: DiscoveryScan | None,
) -> list[DiscoveryObservation]:
    if scan.status != "completed":
        return []
    now = datetime.now(timezone.utc)
    current_hosts = annotate_hosts_with_inventory(deserialize_results(scan.results_json), db)
    observations: list[DiscoveryObservation] = []

    for host in current_hosts:
        if host.import_status == "new":
            observations.append(_upsert_observation(
                db,
                schedule.id,
                scan.id,
                "new_device",
                host,
                f"New device found at {host.ip_address}",
                {"open_ports": host.open_ports},
                now,
            ))
        elif host.import_status == "changed" and "ip_address" in host.proposed_updates:
            observations.append(_upsert_observation(
                db,
                schedule.id,
                scan.id,
                "ip_change",
                host,
                f"Device appears to have moved to {host.ip_address}",
                {"proposed_updates": {f: getattr(host, f) for f in host.proposed_updates if getattr(host, f) is not None}},
                now,
            ))
        elif host.import_status == "changed":
            observations.append(_upsert_observation(
                db,
                schedule.id,
                scan.id,
                "field_change",
                host,
                f"Device details changed at {host.ip_address}",
                {"proposed_updates": {f: getattr(host, f) for f in host.proposed_updates if getattr(host, f) is not None}},
                now,
            ))

    if previous_scan is not None and previous_scan.status == "completed":
        observations.extend(_disappeared_observations(db, schedule.id, scan.id, previous_scan, current_hosts, now))

    db.commit()
    return observations


def _upsert_observation(
    db: Session,
    schedule_id: int,
    scan_id: int,
    observation_type: str,
    host: DiscoveryHost,
    summary: str,
    details: dict,
    now: datetime,
) -> DiscoveryObservation:
    normalized_mac = normalize_mac(host.mac_address)
    query = select(DiscoveryObservation).where(
        DiscoveryObservation.schedule_id == schedule_id,
        DiscoveryObservation.observation_type == observation_type,
        DiscoveryObservation.status != "resolved",
    )
    if host.existing_device_id is not None:
        query = query.where(DiscoveryObservation.device_id == host.existing_device_id)
    elif normalized_mac:
        query = query.where(DiscoveryObservation.mac_address == normalized_mac)
    else:
        query = query.where(DiscoveryObservation.ip_address == host.ip_address)
    existing = db.scalar(query)
    if existing is not None:
        existing.scan_id = scan_id
        existing.ip_address = host.ip_address
        existing.mac_address = normalized_mac
        existing.hostname = host.hostname
        existing.summary = summary
        existing.details_json = json.dumps(details)
        existing.last_seen_at = now
        return existing
    observation = DiscoveryObservation(
        schedule_id=schedule_id,
        scan_id=scan_id,
        device_id=host.existing_device_id,
        observation_type=observation_type,
        status="open",
        ip_address=host.ip_address,
        mac_address=normalized_mac,
        hostname=host.hostname,
        summary=summary,
        details_json=json.dumps(details),
        first_seen_at=now,
        last_seen_at=now,
    )
    db.add(observation)
    return observation


def _disappeared_observations(
    db: Session,
    schedule_id: int,
    scan_id: int,
    previous_scan: DiscoveryScan,
    current_hosts: list[DiscoveryHost],
    now: datetime,
) -> list[DiscoveryObservation]:
    current_ips = {host.ip_address for host in current_hosts}
    current_macs = {normalize_mac(host.mac_address) for host in current_hosts if normalize_mac(host.mac_address)}
    observations: list[DiscoveryObservation] = []
    previous_hosts = annotate_hosts_with_inventory(deserialize_results(previous_scan.results_json), db)
    for host in previous_hosts:
        normalized_mac = normalize_mac(host.mac_address)
        if host.ip_address in current_ips or (normalized_mac and normalized_mac in current_macs):
            continue
        observations.append(_upsert_observation(
            db,
            schedule_id,
            scan_id,
            "disappeared",
            host,
            f"Previously discovered device no longer responds at {host.ip_address}",
            {"previous_scan_id": previous_scan.id},
            now,
        ))
    return observations


def send_observation_notifications(db: Session, schedule: DiscoverySchedule, observations: list[DiscoveryObservation]) -> None:
    targets = json_list(schedule.notification_targets_json)
    if not targets or not observations:
        return
    open_observations = [obs for obs in observations if obs.status == "open"]
    if not open_observations:
        return
    notif_settings = load_notification_settings(db)
    profiles = {int(profile["id"]): profile for profile in list_notification_profiles(db, redacted=False)}
    counts: dict[str, int] = {}
    for observation in open_observations:
        counts[observation.observation_type] = counts.get(observation.observation_type, 0) + 1
    count_text = ", ".join(f"{value} {key.replace('_', ' ')}" for key, value in sorted(counts.items()))
    message = f"NetMap scheduled discovery\n\n{schedule.name}: {count_text}"
    for target in targets:
        result = send_notification_target(target, message, notif_settings, profiles)
        logger.info("Scheduled discovery notification via %s: %s", target, result)


def schedule_next_run(schedule: DiscoverySchedule, now: datetime | None = None) -> None:
    current = now or datetime.now(timezone.utc)
    schedule.next_run_at = current + timedelta(minutes=schedule.interval_minutes)


def due_datetime(value: datetime | None) -> datetime:
    if value is None:
        return datetime.now(timezone.utc)
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value


class ScheduledDiscoveryService:
    def __init__(self) -> None:
        self._thread: threading.Thread | None = None
        self._stop = threading.Event()
        self._running_schedule_ids: set[int] = set()
        self._running_lock = threading.Lock()

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, name="scheduled-discovery", daemon=True)
        self._thread.start()
        logger.info("Scheduled discovery service started")

    def stop(self) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=10)

    def _run(self) -> None:
        if self._stop.wait(45):
            return
        while not self._stop.is_set():
            try:
                self.run_due_once()
            except Exception:
                logger.exception("Scheduled discovery tick failed")
            if self._stop.wait(60):
                break

    def run_due_once(self) -> None:
        now = datetime.now(timezone.utc)
        with SessionLocal() as db:
            schedules = db.scalars(
                select(DiscoverySchedule)
                .where(DiscoverySchedule.enabled == True)  # noqa: E712
                .where((DiscoverySchedule.next_run_at.is_(None)) | (DiscoverySchedule.next_run_at <= now))
                .order_by(DiscoverySchedule.next_run_at.asc())
                .limit(3)
            ).all()
        for schedule in schedules:
            with self._running_lock:
                if schedule.id in self._running_schedule_ids:
                    continue
                self._running_schedule_ids.add(schedule.id)
            try:
                self.run_schedule(schedule.id)
            finally:
                with self._running_lock:
                    self._running_schedule_ids.discard(schedule.id)

    def try_run_schedule(self, schedule_id: int) -> DiscoveryScan | None:
        """Run a schedule exactly once, refusing concurrent runs for the same id."""
        with self._running_lock:
            if schedule_id in self._running_schedule_ids:
                return None
            self._running_schedule_ids.add(schedule_id)
        try:
            return self.run_schedule(schedule_id)
        finally:
            with self._running_lock:
                self._running_schedule_ids.discard(schedule_id)

    def run_schedule(self, schedule_id: int) -> DiscoveryScan | None:
        with SessionLocal() as db:
            schedule = db.get(DiscoverySchedule, schedule_id)
            if schedule is None or not schedule.enabled:
                return None
            previous_scan = db.get(DiscoveryScan, schedule.last_scan_id) if schedule.last_scan_id else None
            payload = DiscoveryStart(
                target=schedule.target,
                scan_type=schedule.scan_type,  # type: ignore[arg-type]
                confirm_large_scan=schedule.confirm_large_scan,
                topology_group_id=schedule.topology_group_id,
                snmp_profile_id=schedule.snmp_profile_id,
                snmp_targets=json_list(schedule.snmp_targets_json),
            )
            scan = execute_discovery_scan(db, payload, schedule.owner_user_id, schedule_id=schedule.id)
            schedule.last_run_at = datetime.now(timezone.utc)
            schedule.last_scan_id = scan.id
            schedule.last_status = scan.status
            schedule.last_error = scan.error
            schedule_next_run(schedule, schedule.last_run_at)
            observations = create_observations_for_scan(db, schedule, scan, previous_scan)
            send_observation_notifications(db, schedule, observations)
            db.commit()
            return scan


scheduled_discovery = ScheduledDiscoveryService()
