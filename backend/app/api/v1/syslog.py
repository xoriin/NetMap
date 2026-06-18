import asyncio
import re
from typing import Annotated

from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query, WebSocket, WebSocketDisconnect, status
from sqlalchemy import Select, asc, desc, func, or_, select, text
from sqlalchemy.orm import Session

from app.api.deps import require_security_view
from app.core.config import settings
from app.core.security import decode_token
from app.core.validation import normalize_ip, validate_port, validate_syslog_field
from app.db.firewall_session import FirewallSessionLocal, get_firewall_db
from app.db.session import SessionLocal
from app.models.firewall_event import FirewallEvent
from app.models.user import User
from app.schemas.firewall_event import FirewallEventList, FirewallEventRead, SyslogStatus
from app.services.rbac.permissions import has_permission
from app.services.syslog.storage import count_events, get_ingestion_status, get_retention_status
from app.websocket.firewall_events import firewall_event_broadcaster

router = APIRouter(prefix="/syslog", tags=["syslog"])

_active_ws_connections = 0
FTS_TERM_RE = re.compile(r"[A-Za-z0-9_]+")

SORT_COLUMNS = {
    "received_at": FirewallEvent.received_at,
    "event_time": FirewallEvent.event_time,
    "src_ip": FirewallEvent.src_ip,
    "dst_ip": FirewallEvent.dst_ip,
    "src_port": FirewallEvent.src_port,
    "dst_port": FirewallEvent.dst_port,
    "action": FirewallEvent.action,
    "protocol": FirewallEvent.protocol,
    "interface": FirewallEvent.interface,
}


def fts_query(raw_query: str) -> str | None:
    terms = FTS_TERM_RE.findall(raw_query)
    if not terms:
        return None
    return " AND ".join(f'"{term.replace(chr(34), chr(34) * 2)}"*' for term in terms)


@router.get("/status", response_model=SyslogStatus)
def syslog_status(_current_user: Annotated[User, Depends(require_security_view)]) -> SyslogStatus:
    retention_status = get_retention_status()
    ingestion_status = get_ingestion_status()
    return SyslogStatus(
        enabled=settings.syslog_enabled,
        udp_enabled=settings.syslog_udp_enabled,
        tcp_enabled=settings.syslog_tcp_enabled,
        tls_enabled=settings.syslog_tls_enabled,
        udp_port=settings.syslog_udp_port,
        tcp_port=settings.syslog_tcp_port,
        tls_port=settings.syslog_tls_port,
        retention_days=settings.firewall_log_retention_days,
        allowlist_enabled=bool(settings.syslog_sender_allowlist),
        total_events=count_events(),
        retention_last_run_at=retention_status.last_run_at,
        retention_last_deleted=retention_status.last_deleted,
        retention_last_error=retention_status.last_error,
        last_event_received_at=retention_status.last_event_received_at,
        received_packets=ingestion_status.received_packets,
        stored_events=ingestion_status.stored_events,
        dropped_unparsed=ingestion_status.dropped_unparsed,
        denied_senders=ingestion_status.denied_senders,
        last_packet_at=ingestion_status.last_packet_at,
        last_packet_sender=ingestion_status.last_packet_sender,
        last_stored_at=ingestion_status.last_stored_at,
        last_stored_sender=ingestion_status.last_stored_sender,
        last_drop_at=ingestion_status.last_drop_at,
        last_drop_sender=ingestion_status.last_drop_sender,
        last_drop_raw=ingestion_status.last_drop_raw,
        last_denied_at=ingestion_status.last_denied_at,
        last_denied_sender=ingestion_status.last_denied_sender,
    )


@router.get("/events", response_model=FirewallEventList)
def list_firewall_events(
    _current_user: Annotated[User, Depends(require_security_view)],
    db: Annotated[Session, Depends(get_firewall_db)],
    limit: Annotated[int, Query(ge=1, le=500)] = 100,
    offset: Annotated[int, Query(ge=0)] = 0,
    q: Annotated[str | None, Query(max_length=120)] = None,
    src_ip: Annotated[str | None, Query(max_length=64)] = None,
    dst_ip: Annotated[str | None, Query(max_length=64)] = None,
    src_port: Annotated[int | None, Query(ge=0, le=65535)] = None,
    dst_port: Annotated[int | None, Query(ge=0, le=65535)] = None,
    action: Annotated[str | None, Query(max_length=40)] = None,
    protocol: Annotated[str | None, Query(max_length=40)] = None,
    interface: Annotated[str | None, Query(max_length=80)] = None,
    start_time: datetime | None = None,
    end_time: datetime | None = None,
    sort_by: Annotated[str, Query(pattern="^(received_at|event_time|src_ip|dst_ip|src_port|dst_port|action|protocol|interface)$")] = "received_at",
    sort_dir: Annotated[str, Query(pattern="^(asc|desc)$")] = "desc",
) -> FirewallEventList:
    try:
        if src_ip:
            src_ip = normalize_ip(src_ip)
        if dst_ip:
            dst_ip = normalize_ip(dst_ip)
        if src_port is not None:
            src_port = validate_port(src_port)
        if dst_port is not None:
            dst_port = validate_port(dst_port)
        if action:
            action = validate_syslog_field(action, max_length=40).lower()
        if protocol:
            protocol = validate_syslog_field(protocol, max_length=40).lower()
        if interface:
            interface = validate_syslog_field(interface, max_length=80)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc

    query = apply_event_filters(
        select(FirewallEvent),
        q=q,
        src_ip=src_ip,
        dst_ip=dst_ip,
        src_port=src_port,
        dst_port=dst_port,
        action=action,
        protocol=protocol,
        interface=interface,
        start_time=start_time,
        end_time=end_time,
    )
    count_query = apply_event_filters(
        select(func.count()).select_from(FirewallEvent),
        q=q,
        src_ip=src_ip,
        dst_ip=dst_ip,
        src_port=src_port,
        dst_port=dst_port,
        action=action,
        protocol=protocol,
        interface=interface,
        start_time=start_time,
        end_time=end_time,
    )
    sort_column = SORT_COLUMNS[sort_by]
    sort_clause = asc(sort_column) if sort_dir == "asc" else desc(sort_column)
    events = db.scalars(query.order_by(sort_clause, FirewallEvent.id.desc()).offset(offset).limit(limit)).all()
    return FirewallEventList(
        retention_days=settings.firewall_log_retention_days,
        total=int(db.scalar(count_query) or 0),
        offset=offset,
        limit=limit,
        events=[event_to_read(event) for event in events],
    )


@router.websocket("/events/live")
async def live_firewall_events(websocket: WebSocket) -> None:
    global _active_ws_connections
    # Accept first so we can read the auth token; do NOT reserve a slot yet.
    await websocket.accept()
    try:
        raw = await asyncio.wait_for(websocket.receive_text(), timeout=5.0)
        user = get_websocket_user(raw.strip())
    except asyncio.TimeoutError:
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
        return
    if user is None or not has_permission(str(user.role), "security_view"):
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
        return
    # Authenticated — now check the shared quota.
    if _active_ws_connections >= settings.syslog_ws_max_connections:
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
        return
    _active_ws_connections += 1
    try:
        await firewall_event_broadcaster.register(websocket)
        try:
            while True:
                await websocket.receive_text()
        except WebSocketDisconnect:
            pass
        finally:
            await firewall_event_broadcaster.disconnect(websocket)
    finally:
        _active_ws_connections -= 1


def get_websocket_user(token: str | None) -> User | None:
    if not token:
        return None
    payload = decode_token(token, "access")
    if payload is None or payload.get("sub") is None:
        return None
    with SessionLocal() as db:
        user = db.get(User, int(payload["sub"]))
        if user is None or not user.is_active:
            return None
        return user


def apply_event_filters(
    query: Select[tuple[FirewallEvent]] | Select[tuple[int]],
    *,
    q: str | None,
    src_ip: str | None,
    dst_ip: str | None,
    src_port: int | None,
    dst_port: int | None,
    action: str | None,
    protocol: str | None,
    interface: str | None,
    start_time: datetime | None,
    end_time: datetime | None,
) -> Select:
    if q:
        search_value = q.strip()
        if not search_value:
            return query
        like = f"%{q.strip()}%"
        conditions = [
            FirewallEvent.src_ip.ilike(like),
            FirewallEvent.dst_ip.ilike(like),
            FirewallEvent.source_host.ilike(like),
            FirewallEvent.rule_id.ilike(like),
            FirewallEvent.reason.ilike(like),
        ]
        raw_fts_query = fts_query(search_value)
        if raw_fts_query is not None:
            raw_log_matches = select(text("rowid")).select_from(text("firewall_events_fts")).where(
                text("firewall_events_fts MATCH :fts_query")
            ).params(fts_query=raw_fts_query)
            conditions.insert(0, FirewallEvent.id.in_(raw_log_matches))
        query = query.where(or_(*conditions))
    if src_ip:
        query = query.where(FirewallEvent.src_ip == src_ip.strip())
    if dst_ip:
        query = query.where(FirewallEvent.dst_ip == dst_ip.strip())
    if src_port is not None:
        query = query.where(FirewallEvent.src_port == src_port)
    if dst_port is not None:
        query = query.where(FirewallEvent.dst_port == dst_port)
    if action:
        query = query.where(FirewallEvent.action == action.strip().lower())
    if protocol:
        query = query.where(FirewallEvent.protocol == protocol.strip().lower())
    if interface:
        query = query.where(FirewallEvent.interface == interface.strip())
    if start_time:
        query = query.where(FirewallEvent.received_at >= start_time)
    if end_time:
        query = query.where(FirewallEvent.received_at <= end_time)
    return query


def event_to_read(event: FirewallEvent) -> FirewallEventRead:
    return FirewallEventRead(
        id=event.id,
        received_at=event.received_at,
        event_time=event.event_time,
        source_host=event.source_host,
        src_ip=event.src_ip,
        dst_ip=event.dst_ip,
        src_port=event.src_port,
        dst_port=event.dst_port,
        protocol=event.protocol,
        action=event.action,
        interface=event.interface,
        direction=event.direction,
        rule_id=event.rule_id,
        tracker_id=event.tracker_id,
        reason=event.reason,
        raw_log=event.raw_log,
    )
