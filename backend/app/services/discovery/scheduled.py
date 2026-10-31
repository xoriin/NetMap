from __future__ import annotations

import json
import logging
import threading
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from ipaddress import ip_address
from typing import Callable, Iterable

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.session import SessionLocal
from app.models.device import Device
from app.models.discovery import DiscoveryObservation, DiscoveryScan, DiscoverySchedule
from app.models.snmp_profile import SnmpProfile
from app.models.topology_group import TopologyGroup
from app.schemas.discovery import DiscoveryHost, DiscoveryStart
from app.services.audit.service import write_audit
from app.services.discovery.scanner import (
    DiscoveryTarget,
    ScanCancelled,
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

DISAPPEARED_MISSED_SCAN_THRESHOLD = 3


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


@dataclass
class DiscoveryScanJob:
    """Everything the network phase needs, resolved before the session is released."""

    scan_id: int
    actor_user_id: int
    schedule_id: int | None
    target: DiscoveryTarget
    scan_type: str
    snmp_targets: list[str]
    snmp_community: str | None
    snmp_port: int
    snmp_timeout: int
    snmp_retries: int
    profile_error: str | None


def prepare_discovery_scan(
    db: Session,
    payload: DiscoveryStart,
    actor_user_id: int,
    *,
    schedule_id: int | None = None,
    queued: bool = False,
) -> DiscoveryScanJob:
    target = validate_target(payload.target, payload.confirm_large_scan)
    snmp_targets = list(payload.snmp_targets)
    if not snmp_targets and payload.topology_group_id is not None:
        group = db.get(TopologyGroup, payload.topology_group_id)
        if group is not None and group.gateway:
            snmp_targets = [group.gateway]
    for snmp_target in snmp_targets:
        ensure_private_address(ip_address(snmp_target))

    # Resolve SNMP credentials before any network I/O so the session can be
    # released for the whole nmap/SNMP phase.
    snmp_community = payload.snmp_community
    snmp_port = payload.snmp_port
    snmp_timeout = payload.snmp_timeout_seconds
    snmp_retries = 1
    profile_error: str | None = None
    if payload.snmp_profile_id is not None:
        profile = db.get(SnmpProfile, payload.snmp_profile_id)
        if profile is None:
            profile_error = "SNMP profile not found"
        else:
            snmp_community = decrypt_profile_community(profile)
            snmp_port = profile.port
            snmp_timeout = profile.timeout_seconds
            snmp_retries = profile.retries

    scan = DiscoveryScan(
        actor_user_id=actor_user_id,
        schedule_id=schedule_id,
        target=target.nmap_target,
        scan_type=payload.scan_type,
        status="queued" if queued else "running",
        host_count=target.host_count,
        started_at=None if queued else datetime.now(timezone.utc),
        progress_done=0,
    )
    db.add(scan)
    db.flush()
    scan_id = scan.id
    write_audit(
        db,
        action="discovery.scan_started" if schedule_id is None else "discovery.scheduled_scan_started",
        actor_user_id=actor_user_id,
        target=f"scan:{scan_id}",
        detail=f"{payload.scan_type} {target.nmap_target}",
    )
    db.commit()
    return DiscoveryScanJob(
        scan_id=scan_id,
        actor_user_id=actor_user_id,
        schedule_id=schedule_id,
        target=target,
        scan_type=payload.scan_type,
        snmp_targets=snmp_targets,
        snmp_community=snmp_community,
        snmp_port=snmp_port,
        snmp_timeout=snmp_timeout,
        snmp_retries=snmp_retries,
        profile_error=profile_error,
    )


SCAN_CANCELLED_MESSAGE = "Scan cancelled"


def run_discovery_scan(
    db: Session,
    job: DiscoveryScanJob,
    on_progress: Callable[[int], None] | None = None,
    cancel_event: threading.Event | None = None,
) -> DiscoveryScan:
    # Nothing here touches the session until the network phase is over
    # (read -> close -> probe -> write).
    results: list[DiscoveryHost] = []
    error: str | None = None
    cancelled = False
    try:
        if job.profile_error is not None:
            raise ValueError(job.profile_error)
        scan_options: dict = {}
        if on_progress is not None:
            scan_options["on_progress"] = on_progress
        if cancel_event is not None:
            scan_options["cancel_event"] = cancel_event
        results = run_nmap_scan(job.target, job.scan_type, **scan_options)
        if job.snmp_community and job.snmp_targets:
            try:
                results = enrich_hosts_from_snmp_arp(
                    results,
                    job.snmp_targets,
                    job.snmp_community,
                    port=job.snmp_port,
                    timeout_seconds=job.snmp_timeout,
                    retries=job.snmp_retries,
                )
            except (TimeoutError, SnmpError, OSError):
                logger.exception("SNMP ARP enrichment failed during discovery scan")
        if cancel_event is not None and cancel_event.is_set():
            raise ScanCancelled()
    except ScanCancelled:
        cancelled = True
    except Exception as exc:
        error = str(exc)

    scan = db.get(DiscoveryScan, job.scan_id)
    assert scan is not None
    scan.completed_at = datetime.now(timezone.utc)
    manual = job.schedule_id is None
    if cancelled:
        scan.status = "cancelled"
        scan.error = SCAN_CANCELLED_MESSAGE
    elif error is None:
        scan.status = "completed"
        scan.progress_done = scan.host_count
        scan.result_count = len(results)
        scan.results_json = serialize_results(results)
        write_audit(
            db,
            action="discovery.scan_completed" if manual else "discovery.scheduled_scan_completed",
            actor_user_id=job.actor_user_id,
            target=f"scan:{job.scan_id}",
            detail=f"{len(results)} hosts",
        )
    else:
        scan.status = "failed"
        scan.error = error
        write_audit(
            db,
            action="discovery.scan_failed" if manual else "discovery.scheduled_scan_failed",
            actor_user_id=job.actor_user_id,
            target=f"scan:{job.scan_id}",
            detail=error,
        )
    db.commit()
    db.refresh(scan)
    return scan


def execute_discovery_scan(
    db: Session,
    payload: DiscoveryStart,
    actor_user_id: int,
    *,
    schedule_id: int | None = None,
) -> DiscoveryScan:
    return run_discovery_scan(db, prepare_discovery_scan(db, payload, actor_user_id, schedule_id=schedule_id))


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

    _resolve_reappeared_observations(db, schedule.id, current_hosts, now)
    resolve_inventoried_new_device_observations(db, now, schedule_id=schedule.id)

    # MAC → device lookup to catch hosts whose IP already belongs to a different device
    scan_macs = {normalize_mac(host.mac_address) for host in current_hosts if normalize_mac(host.mac_address)}
    devices_by_mac: dict[str, Device] = {}
    if scan_macs:
        for candidate in db.scalars(select(Device).where(Device.mac_address.is_not(None))).all():
            normalized = normalize_mac(candidate.mac_address)
            if normalized in scan_macs and normalized not in devices_by_mac:
                devices_by_mac[normalized] = candidate

    for host in current_hosts:
        mac_device = devices_by_mac.get(normalize_mac(host.mac_address) or "")
        if (
            host.existing_device_id is not None
            and mac_device is not None
            and mac_device.id != host.existing_device_id
        ):
            # MAC says this is mac_device, but the found IP belongs to another inventory
            # device — an IP move onto an occupied address is flagged for review, never applied.
            host.existing_device_id = mac_device.id
            observations.append(_upsert_observation(
                db,
                schedule.id,
                scan.id,
                "ip_change",
                host,
                f"Device may have moved to {host.ip_address}, an IP already used by another device",
                {"current_ip": mac_device.ip_address, "found_ip": host.ip_address},
                now,
            ))
            continue
        if host.import_status == "new":
            if _new_device_previously_dismissed(db, schedule.id, host, now):
                continue
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
            device = db.get(Device, host.existing_device_id)
            if device is not None:
                old_ip = device.ip_address
                device.ip_address = host.ip_address
                write_audit(
                    db,
                    action="discovery.auto_ip_update",
                    actor_user_id=schedule.owner_user_id,
                    target=f"device:{device.id}",
                    detail=f"IP updated {old_ip} → {host.ip_address} (MAC match, scheduled scan)",
                )
            for stale in db.scalars(
                select(DiscoveryObservation).where(
                    DiscoveryObservation.schedule_id == schedule.id,
                    DiscoveryObservation.device_id == host.existing_device_id,
                    DiscoveryObservation.observation_type == "ip_change",
                    DiscoveryObservation.status != "resolved",
                )
            ).all():
                stale.status = "resolved"
            other_updates = [f for f in host.proposed_updates if f != "ip_address"]
            if other_updates:
                observations.append(_upsert_observation(
                    db,
                    schedule.id,
                    scan.id,
                    "field_change",
                    host,
                    f"Device details changed at {host.ip_address}",
                    {"proposed_updates": {f: getattr(host, f) for f in other_updates if getattr(host, f) is not None}},
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
    miss_window = _recent_completed_scans(db, schedule_id, scan_id, DISAPPEARED_MISSED_SCAN_THRESHOLD)
    if len(miss_window) < DISAPPEARED_MISSED_SCAN_THRESHOLD:
        return []
    baseline_scan = previous_scan if DISAPPEARED_MISSED_SCAN_THRESHOLD == 1 else miss_window[-1]
    absent_scan_hosts = [current_hosts]
    if DISAPPEARED_MISSED_SCAN_THRESHOLD > 1:
        absent_scan_hosts.extend(deserialize_results(scan.results_json) for scan in miss_window[:-1])

    observations: list[DiscoveryObservation] = []
    previous_hosts = annotate_hosts_with_inventory(deserialize_results(baseline_scan.results_json), db)
    for host in previous_hosts:
        normalized_mac = normalize_mac(host.mac_address)
        if any(_host_seen_in_scan(host.ip_address, normalized_mac, hosts) for hosts in absent_scan_hosts):
            continue
        if _is_intermittent_host(db, schedule_id, host.ip_address, normalized_mac, now):
            continue
        observations.append(_upsert_observation(
            db,
            schedule_id,
            scan_id,
            "disappeared",
            host,
            f"Previously discovered device no longer responds at {host.ip_address}",
            {"previous_scan_id": baseline_scan.id, "missed_scans": DISAPPEARED_MISSED_SCAN_THRESHOLD},
            now,
        ))
    return observations


def _recent_completed_scans(
    db: Session,
    schedule_id: int,
    before_scan_id: int,
    limit: int,
) -> list[DiscoveryScan]:
    if limit <= 0:
        return []
    return list(db.scalars(
        select(DiscoveryScan)
        .where(DiscoveryScan.schedule_id == schedule_id)
        .where(DiscoveryScan.status == "completed")
        .where(DiscoveryScan.id < before_scan_id)
        .order_by(DiscoveryScan.id.desc())
        .limit(limit)
    ).all())


# Suppression windows for transient (typically wifi) hosts that leave and
# rejoin the network between sweeps. MAC-identified dismissals are permanent —
# "resolve" in the review modal is documented as dismiss-forever; IP-only
# identities get a bounded window since DHCP can hand the address to new hardware.
NEW_DEVICE_IP_SUPPRESS_DAYS = 14
DISAPPEARED_FLAP_SUPPRESS_DAYS = 7


def _load_details(details_json: str) -> dict:
    try:
        value = json.loads(details_json)
        return value if isinstance(value, dict) else {}
    except json.JSONDecodeError:
        return {}


def _as_aware_utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def inventoried_new_device_ips(db: Session, observations: Iterable[DiscoveryObservation]) -> set[str]:
    """IPs of unresolved new_device observations that are already in inventory (read-only)."""
    ips = {
        obs.ip_address
        for obs in observations
        if obs.observation_type == "new_device" and obs.status != "resolved" and obs.ip_address
    }
    if not ips:
        return set()
    return set(db.scalars(select(Device.ip_address).where(Device.ip_address.in_(ips))).all())


def resolve_inventoried_new_device_observations(
    db: Session,
    now: datetime | None = None,
    *,
    schedule_id: int | None = None,
) -> int:
    """Resolve unresolved new_device observations whose IP is now in inventory.

    Write-path only (scan pipeline and discovery import); the caller commits.
    """
    query = select(DiscoveryObservation).where(
        DiscoveryObservation.observation_type == "new_device",
        DiscoveryObservation.status != "resolved",
        DiscoveryObservation.ip_address.is_not(None),
        DiscoveryObservation.ip_address.in_(select(Device.ip_address)),
    )
    if schedule_id is not None:
        query = query.where(DiscoveryObservation.schedule_id == schedule_id)
    resolved_at = now or datetime.now(timezone.utc)
    count = 0
    for observation in db.scalars(query).all():
        observation.status = "resolved"
        observation.resolved_at = resolved_at
        count += 1
    return count


def _resolve_reappeared_observations(
    db: Session,
    schedule_id: int,
    current_hosts: list[DiscoveryHost],
    now: datetime,
) -> None:
    """Auto-close open 'disappeared' observations for hosts present in this scan."""
    open_disappeared = db.scalars(
        select(DiscoveryObservation).where(
            DiscoveryObservation.schedule_id == schedule_id,
            DiscoveryObservation.observation_type == "disappeared",
            DiscoveryObservation.status != "resolved",
        )
    ).all()
    for observation in open_disappeared:
        if not observation.ip_address:
            continue
        if _host_seen_in_scan(observation.ip_address, observation.mac_address, current_hosts):
            observation.status = "resolved"
            observation.resolved_at = now
            observation.last_seen_at = now
            details = _load_details(observation.details_json)
            details["auto_resolved"] = "reappeared"
            observation.details_json = json.dumps(details)


def _new_device_previously_dismissed(
    db: Session,
    schedule_id: int,
    host: DiscoveryHost,
    now: datetime,
) -> bool:
    """True when the user already resolved a new-device observation for this host.

    Resolve means "dismiss permanently" in the review UI, so a MAC-identified
    dismissal suppresses re-raising forever; IP-only matches get a bounded
    window because the address may be reassigned to genuinely new hardware.
    """
    normalized_mac = normalize_mac(host.mac_address)
    query = select(DiscoveryObservation).where(
        DiscoveryObservation.schedule_id == schedule_id,
        DiscoveryObservation.observation_type == "new_device",
        DiscoveryObservation.status == "resolved",
    )
    if normalized_mac:
        return db.scalar(query.where(DiscoveryObservation.mac_address == normalized_mac)) is not None
    cutoff = now - timedelta(days=NEW_DEVICE_IP_SUPPRESS_DAYS)
    for observation in db.scalars(
        query.where(DiscoveryObservation.ip_address == host.ip_address)
        .order_by(DiscoveryObservation.id.desc())
        .limit(5)
    ).all():
        resolved_at = observation.resolved_at or observation.last_seen_at
        if resolved_at is not None and _as_aware_utc(resolved_at) >= cutoff:
            return True
    return False


def _is_intermittent_host(
    db: Session,
    schedule_id: int,
    ip_address: str,
    normalized_mac: str | None,
    now: datetime,
) -> bool:
    """True when this host recently disappeared and came back on its own.

    Such hosts (typically wifi clients) are expected to drop out between
    sweeps — re-raising a 'disappeared' observation each cycle is noise.
    """
    query = select(DiscoveryObservation).where(
        DiscoveryObservation.schedule_id == schedule_id,
        DiscoveryObservation.observation_type == "disappeared",
        DiscoveryObservation.status == "resolved",
    )
    if normalized_mac:
        query = query.where(DiscoveryObservation.mac_address == normalized_mac)
    else:
        query = query.where(DiscoveryObservation.ip_address == ip_address)
    cutoff = now - timedelta(days=DISAPPEARED_FLAP_SUPPRESS_DAYS)
    for observation in db.scalars(query.order_by(DiscoveryObservation.id.desc()).limit(5)).all():
        if _load_details(observation.details_json).get("auto_resolved") != "reappeared":
            continue
        resolved_at = observation.resolved_at or observation.last_seen_at
        if resolved_at is not None and _as_aware_utc(resolved_at) >= cutoff:
            return True
    return False


def _host_seen_in_scan(ip_address: str, normalized_mac: str | None, hosts: list[DiscoveryHost]) -> bool:
    for host in hosts:
        if host.ip_address == ip_address:
            return True
        if normalized_mac and normalize_mac(host.mac_address) == normalized_mac:
            return True
    return False


@dataclass(frozen=True)
class ObservationNotification:
    targets: list[str]
    message: str
    settings: dict
    profiles: dict[int, dict]


def prepare_observation_notification(
    db: Session, schedule: DiscoverySchedule, observations: list[DiscoveryObservation]
) -> ObservationNotification | None:
    """Read everything a notification needs while the session is open."""
    targets = json_list(schedule.notification_targets_json)
    if not targets or not observations:
        return None
    open_observations = [obs for obs in observations if obs.status == "open"]
    if not open_observations:
        return None
    notif_settings = load_notification_settings(db)
    profiles = {int(profile["id"]): profile for profile in list_notification_profiles(db, redacted=False)}
    counts: dict[str, int] = {}
    for observation in open_observations:
        counts[observation.observation_type] = counts.get(observation.observation_type, 0) + 1
    count_text = ", ".join(f"{value} {key.replace('_', ' ')}" for key, value in sorted(counts.items()))
    message = f"NetMap scheduled discovery\n\n{schedule.name}: {count_text}"
    return ObservationNotification(targets=targets, message=message, settings=notif_settings, profiles=profiles)


def deliver_observation_notification(notification: ObservationNotification) -> None:
    """Send a prepared notification; must run with no database session held."""
    for target in notification.targets:
        result = send_notification_target(target, notification.message, notification.settings, notification.profiles)
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
            notification = prepare_observation_notification(db, schedule, observations)
            db.commit()
            db.refresh(scan)
        # Notification delivery is network I/O: send it after the session is closed.
        if notification is not None:
            deliver_observation_notification(notification)
        return scan


scheduled_discovery = ScheduledDiscoveryService()
