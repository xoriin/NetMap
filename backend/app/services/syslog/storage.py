from __future__ import annotations

import logging
import threading
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from sqlalchemy import delete, func, select

from app.core.config import settings
from app.db.firewall_session import FirewallSessionLocal as SessionLocal
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
    event_count: int | None = None  # None = not yet initialised; lazily populated on first call


@dataclass
class IngestionStatus:
    received_packets: int = 0
    stored_events: int = 0
    dropped_unparsed: int = 0
    denied_senders: int = 0
    last_packet_at: datetime | None = None
    last_packet_sender: str | None = None
    last_stored_at: datetime | None = None
    last_stored_sender: str | None = None
    last_drop_at: datetime | None = None
    last_drop_sender: str | None = None
    last_drop_raw: str | None = None
    last_denied_at: datetime | None = None
    last_denied_sender: str | None = None


_retention_status = RetentionStatus()
_retention_status_lock = threading.Lock()
_ingestion_status = IngestionStatus()
_ingestion_status_lock = threading.Lock()


def store_syslog_line(raw_line: bytes | str, sender_host: str | None = None) -> int:
    mark_packet_received(sender_host)
    parsed = parse_syslog_line(raw_line, sender_host)
    if parsed.src_ip is None and parsed.dst_ip is None and parsed.action is None and parsed.protocol is None:
        mark_unparsed_drop(sender_host, parsed.raw_log)
        logger.debug("Dropped unparsed syslog packet from %s: %s", sender_host or "unknown", parsed.raw_log[:512])
        return 0
    event = event_from_parsed(parsed)
    with SessionLocal() as db:
        db.add(event)
        db.commit()
        db.refresh(event)
        update_last_event_received(event.received_at)
        mark_event_stored(sender_host, event.received_at)
        with _retention_status_lock:
            if _retention_status.event_count is not None:
                _retention_status.event_count += 1
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
        with _retention_status_lock:
            if _retention_status.event_count is not None:
                _retention_status.event_count = max(0, _retention_status.event_count - deleted)
    return deleted


def count_events() -> int:
    with _retention_status_lock:
        if _retention_status.event_count is not None:
            return _retention_status.event_count
    with SessionLocal() as db:
        count = int(db.scalar(select(func.count()).select_from(FirewallEvent)) or 0)
    with _retention_status_lock:
        _retention_status.event_count = count
    return count


def get_retention_status() -> RetentionStatus:
    with _retention_status_lock:
        return RetentionStatus(
            last_run_at=_retention_status.last_run_at,
            last_deleted=_retention_status.last_deleted,
            last_error=_retention_status.last_error,
            last_event_received_at=_retention_status.last_event_received_at,
        )


def get_ingestion_status() -> IngestionStatus:
    with _ingestion_status_lock:
        return IngestionStatus(
            received_packets=_ingestion_status.received_packets,
            stored_events=_ingestion_status.stored_events,
            dropped_unparsed=_ingestion_status.dropped_unparsed,
            denied_senders=_ingestion_status.denied_senders,
            last_packet_at=_ingestion_status.last_packet_at,
            last_packet_sender=_ingestion_status.last_packet_sender,
            last_stored_at=_ingestion_status.last_stored_at,
            last_stored_sender=_ingestion_status.last_stored_sender,
            last_drop_at=_ingestion_status.last_drop_at,
            last_drop_sender=_ingestion_status.last_drop_sender,
            last_drop_raw=_ingestion_status.last_drop_raw,
            last_denied_at=_ingestion_status.last_denied_at,
            last_denied_sender=_ingestion_status.last_denied_sender,
        )


def update_retention_status(last_run_at: datetime, last_deleted: int, last_error: str | None) -> None:
    with _retention_status_lock:
        _retention_status.last_run_at = last_run_at
        _retention_status.last_deleted = last_deleted
        _retention_status.last_error = last_error


def mark_packet_received(sender_host: str | None) -> None:
    with _ingestion_status_lock:
        _ingestion_status.received_packets += 1
        _ingestion_status.last_packet_at = datetime.now(timezone.utc)
        _ingestion_status.last_packet_sender = sender_host


def mark_event_stored(sender_host: str | None, stored_at: datetime) -> None:
    with _ingestion_status_lock:
        _ingestion_status.stored_events += 1
        _ingestion_status.last_stored_at = stored_at
        _ingestion_status.last_stored_sender = sender_host


def mark_unparsed_drop(sender_host: str | None, raw_log: str) -> None:
    with _ingestion_status_lock:
        _ingestion_status.dropped_unparsed += 1
        _ingestion_status.last_drop_at = datetime.now(timezone.utc)
        _ingestion_status.last_drop_sender = sender_host
        _ingestion_status.last_drop_raw = raw_log[:512]


def mark_denied_sender(sender_host: str | None) -> None:
    with _ingestion_status_lock:
        _ingestion_status.denied_senders += 1
        _ingestion_status.last_denied_at = datetime.now(timezone.utc)
        _ingestion_status.last_denied_sender = sender_host


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
