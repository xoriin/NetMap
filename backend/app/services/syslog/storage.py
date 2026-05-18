from __future__ import annotations

import logging
import threading
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from sqlalchemy import delete, func, select

from app.core.config import settings
from app.db.session import SessionLocal
from app.models.firewall_event import FirewallEvent
from app.services.syslog.parser import ParsedFirewallEvent, parse_syslog_line
from app.websocket.firewall_events import firewall_event_broadcaster

logger = logging.getLogger(__name__)


@dataclass
class RetentionStatus:
    last_run_at: datetime | None = None
    last_deleted: int = 0
    last_error: str | None = None
    last_event_received_at: datetime | None = None


_retention_status = RetentionStatus()
_retention_status_lock = threading.Lock()


def store_syslog_line(raw_line: bytes | str, sender_host: str | None = None) -> int:
    parsed = parse_syslog_line(raw_line, sender_host)
    event = event_from_parsed(parsed)
    with SessionLocal() as db:
        db.add(event)
        db.commit()
        db.refresh(event)
        update_last_event_received(event.received_at)
        firewall_event_broadcaster.publish(serialize_event(event))
        return event.id


def event_from_parsed(parsed: ParsedFirewallEvent) -> FirewallEvent:
    return FirewallEvent(
        event_time=parsed.event_time,
        source_host=parsed.source_host,
        src_ip=parsed.src_ip,
        dst_ip=parsed.dst_ip,
        src_port=parsed.src_port,
        dst_port=parsed.dst_port,
        protocol=parsed.protocol,
        action=parsed.action,
        interface=parsed.interface,
        direction=parsed.direction,
        rule_id=parsed.rule_id,
        tracker_id=parsed.tracker_id,
        reason=parsed.reason,
        raw_log=parsed.raw_log,
    )


def cleanup_expired_events() -> int:
    retention_days = max(1, settings.firewall_log_retention_days)
    cutoff = datetime.now(timezone.utc) - timedelta(days=retention_days)
    started_at = datetime.now(timezone.utc)
    try:
        with SessionLocal() as db:
            result = db.execute(delete(FirewallEvent).where(FirewallEvent.received_at < cutoff))
            db.commit()
        deleted = int(result.rowcount or 0)
    except Exception as exc:
        update_retention_status(started_at, 0, str(exc))
        raise
    update_retention_status(started_at, deleted, None)
    if deleted:
        logger.info("Deleted %s firewall events older than %s days", deleted, retention_days)
    return deleted


def count_events() -> int:
    with SessionLocal() as db:
        return int(db.scalar(select(func.count()).select_from(FirewallEvent)) or 0)


def get_retention_status() -> RetentionStatus:
    with _retention_status_lock:
        return RetentionStatus(
            last_run_at=_retention_status.last_run_at,
            last_deleted=_retention_status.last_deleted,
            last_error=_retention_status.last_error,
            last_event_received_at=_retention_status.last_event_received_at,
        )


def update_retention_status(last_run_at: datetime, last_deleted: int, last_error: str | None) -> None:
    with _retention_status_lock:
        _retention_status.last_run_at = last_run_at
        _retention_status.last_deleted = last_deleted
        _retention_status.last_error = last_error


def update_last_event_received(received_at: datetime) -> None:
    with _retention_status_lock:
        _retention_status.last_event_received_at = received_at


def serialize_event(event: FirewallEvent) -> dict[str, object]:
    return {
        "id": event.id,
        "received_at": event.received_at,
        "event_time": event.event_time,
        "source_host": event.source_host,
        "src_ip": event.src_ip,
        "dst_ip": event.dst_ip,
        "src_port": event.src_port,
        "dst_port": event.dst_port,
        "protocol": event.protocol,
        "action": event.action,
        "interface": event.interface,
        "direction": event.direction,
        "rule_id": event.rule_id,
        "tracker_id": event.tracker_id,
        "reason": event.reason,
        "raw_log": event.raw_log,
    }
