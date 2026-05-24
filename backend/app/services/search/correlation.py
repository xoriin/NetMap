from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from sqlalchemy import Select, case, func, or_, select
from sqlalchemy.orm import Session

from app.models.device import Device
from app.models.firewall_event import FirewallEvent
from app.schemas.topology import CorrelatedFirewallEvent, DeviceEventCount

BLOCKED_ACTIONS = {"block", "deny", "drop"}
PASSED_ACTIONS = {"pass", "allow", "accept"}


@dataclass
class _Counter:
    event_count: int = 0
    blocked_count: int = 0
    passed_count: int = 0
    last_seen_event_time: datetime | None = None


def correlation_window_start(window_hours: int) -> datetime:
    bounded_hours = min(max(window_hours, 1), 24 * 7)
    return datetime.now(timezone.utc) - timedelta(hours=bounded_hours)


def _apply_aggregate(
    stats: _Counter,
    action: str | None,
    cnt: int,
    last_seen: datetime | None,
) -> None:
    stats.event_count += cnt
    action_lower = (action or "").strip().lower()
    if action_lower in BLOCKED_ACTIONS:
        stats.blocked_count += cnt
    elif action_lower in PASSED_ACTIONS:
        stats.passed_count += cnt
    if last_seen is not None and (
        stats.last_seen_event_time is None or last_seen > stats.last_seen_event_time
    ):
        stats.last_seen_event_time = last_seen


def _build_event_count_result(
    devices: list[Device], counts: dict[int, _Counter]
) -> dict[int, DeviceEventCount]:
    return {
        device.id: DeviceEventCount(
            device_id=device.id,
            ip_address=device.ip_address,
            hostname=device.hostname,
            event_count=counts[device.id].event_count,
            blocked_count=counts[device.id].blocked_count,
            passed_count=counts[device.id].passed_count,
            last_seen_event_time=counts[device.id].last_seen_event_time,
        )
        for device in devices
    }


def build_device_event_counts(
    firewall_db: Session,
    devices: list[Device],
    *,
    window_start: datetime,
) -> dict[int, DeviceEventCount]:
    ip_to_device_ids: dict[str, set[int]] = {}
    for device in devices:
        ip_value = (device.ip_address or "").strip()
        if not ip_value:
            continue
        ip_to_device_ids.setdefault(ip_value, set()).add(device.id)

    counts: dict[int, _Counter] = {device.id: _Counter() for device in devices}
    if not ip_to_device_ids:
        return _build_event_count_result(devices, counts)

    ips = list(ip_to_device_ids.keys())

    # Count each event once per device. When a device IP appears as both source and destination,
    # the source aggregate owns the count and the destination aggregate ignores that event.
    for row in firewall_db.execute(
        select(
            FirewallEvent.src_ip,
            FirewallEvent.action,
            func.count().label("cnt"),
            func.max(FirewallEvent.received_at).label("last_seen"),
        )
        .where(FirewallEvent.received_at >= window_start, FirewallEvent.src_ip.in_(ips))
        .group_by(FirewallEvent.src_ip, FirewallEvent.action)
    ):
        for device_id in ip_to_device_ids.get(row.src_ip or "", set()):
            _apply_aggregate(counts[device_id], row.action, row.cnt, row.last_seen)

    # Aggregate by dst_ip, excluding same-IP source/destination rows already counted above.
    for row in firewall_db.execute(
        select(
            FirewallEvent.dst_ip,
            FirewallEvent.action,
            func.count().label("cnt"),
            func.max(FirewallEvent.received_at).label("last_seen"),
        )
        .where(
            FirewallEvent.received_at >= window_start,
            FirewallEvent.dst_ip.in_(ips),
            case((FirewallEvent.src_ip.is_(None), ""), else_=FirewallEvent.src_ip) != FirewallEvent.dst_ip,
        )
        .group_by(FirewallEvent.dst_ip, FirewallEvent.action)
    ):
        for device_id in ip_to_device_ids.get(row.dst_ip or "", set()):
            _apply_aggregate(counts[device_id], row.action, row.cnt, row.last_seen)

    return _build_event_count_result(devices, counts)


def list_recent_device_events(
    firewall_db: Session,
    *,
    device: Device,
    window_start: datetime,
    limit: int,
) -> list[CorrelatedFirewallEvent]:
    ip_value = device.ip_address.strip()
    if not ip_value:
        return []

    query: Select[tuple[FirewallEvent]] = (
        select(FirewallEvent)
        .where(FirewallEvent.received_at >= window_start)
        .where(or_(FirewallEvent.src_ip == ip_value, FirewallEvent.dst_ip == ip_value))
        .order_by(FirewallEvent.received_at.desc(), FirewallEvent.id.desc())
        .limit(limit)
    )
    events = firewall_db.scalars(query).all()

    return [
        CorrelatedFirewallEvent(
            id=event.id,
            received_at=event.received_at,
            event_time=event.event_time,
            src_ip=event.src_ip,
            dst_ip=event.dst_ip,
            src_port=event.src_port,
            dst_port=event.dst_port,
            protocol=event.protocol,
            action=event.action,
            interface=event.interface,
            direction=event.direction,
            rule_id=event.rule_id,
            reason=event.reason,
            relation=event_relation(event, ip_value),
        )
        for event in events
    ]


def event_relation(event: FirewallEvent, ip_address: str) -> str:
    is_src = event.src_ip == ip_address
    is_dst = event.dst_ip == ip_address
    if is_src and is_dst:
        return "both"
    if is_src:
        return "source"
    if is_dst:
        return "destination"
    return "unknown"
