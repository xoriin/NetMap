from __future__ import annotations

import csv
import hashlib
import hmac
import io
import json
import logging
import sqlite3
import tempfile
from collections.abc import Sequence
from datetime import datetime, timedelta, timezone
from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle
from sqlalchemy import case, desc, func, or_, select
from sqlalchemy.exc import DatabaseError, SQLAlchemyError
from sqlalchemy.orm import Session, selectinload

from app.core.config import settings
from app.db.session import engine
from app.models.device import Device
from app.models.firewall_event import FirewallEvent
from app.services.topology.service import device_to_dict, infer_subnet

BLOCK_ACTIONS = ("block", "deny", "drop")
PASS_ACTIONS = ("pass", "allow", "accept")
logger = logging.getLogger(__name__)


def build_inventory_export(db: Session, export_format: str) -> tuple[str, str, bytes]:
    devices = db.scalars(select(Device).options(selectinload(Device.group)).order_by(Device.hostname, Device.ip_address)).all()
    rows = [serialize_device_export(device) for device in devices]
    timestamp = utc_timestamp()
    if export_format == "json":
        payload = json.dumps(rows, indent=2, default=json_default).encode("utf-8")
        return "application/json", f"netmap-device-inventory-{timestamp}.json", payload

    payload = encode_csv(
        rows,
        fieldnames=[
            "id",
            "hostname",
            "ip_address",
            "mac_address",
            "vendor",
            "device_type",
            "status",
            "icon",
            "color",
            "vlan_id",
            "subnet",
            "topology_group",
            "tags",
            "notes",
            "created_at",
            "updated_at",
        ],
    )
    return "text/csv; charset=utf-8", f"netmap-device-inventory-{timestamp}.csv", payload


def build_firewall_export(
    firewall_db: Session,
    export_format: str,
    *,
    q: str | None = None,
    src_ip: str | None = None,
    dst_ip: str | None = None,
    src_port: int | None = None,
    dst_port: int | None = None,
    action: str | None = None,
    protocol: str | None = None,
    interface: str | None = None,
    start_time: datetime | None = None,
    end_time: datetime | None = None,
    limit: int = 5000,
) -> tuple[str, str, bytes, int]:
    query = apply_firewall_filters(
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
    events = firewall_db.scalars(
        query.order_by(desc(FirewallEvent.received_at), desc(FirewallEvent.id)).limit(limit),
    ).all()
    rows = [serialize_firewall_event_export(event) for event in events]
    timestamp = utc_timestamp()
    if export_format == "json":
        payload = json.dumps(rows, indent=2, default=json_default).encode("utf-8")
        return "application/json", f"netmap-firewall-events-{timestamp}.json", payload, len(rows)

    payload = encode_csv(
        rows,
        fieldnames=[
            "id",
            "received_at",
            "event_time",
            "source_host",
            "src_ip",
            "dst_ip",
            "src_port",
            "dst_port",
            "protocol",
            "action",
            "interface",
            "direction",
            "rule_id",
            "tracker_id",
            "reason",
            "raw_log",
        ],
    )
    return "text/csv; charset=utf-8", f"netmap-firewall-events-{timestamp}.csv", payload, len(rows)


def build_network_report_pdf(db: Session, firewall_db: Session) -> bytes:
    devices = db.scalars(select(Device).options(selectinload(Device.group)).order_by(Device.hostname, Device.ip_address)).all()
    firewall_summary = build_report_firewall_summary(firewall_db)
    subnet_counts = summarize_subnets(devices)

    buffer = io.BytesIO()
    doc = SimpleDocTemplate(
        buffer,
        pagesize=A4,
        leftMargin=36,
        rightMargin=36,
        topMargin=36,
        bottomMargin=36,
        title="NetMap Network Report",
    )
    styles = getSampleStyleSheet()
    story = [
        Paragraph("NetMap Network Report", styles["Title"]),
        Paragraph(datetime.now(timezone.utc).strftime("Generated %Y-%m-%d %H:%M UTC"), styles["Normal"]),
        Spacer(1, 18),
        Paragraph("Topology Snapshot", styles["Heading2"]),
        table_for_pairs(
            [
                ("Devices", str(len(devices))),
                ("Topology groups", str(len({device_to_dict(device)['topology_group'] for device in devices}))),
                ("Firewall events in last 24h", firewall_summary["total_events"]),
            ],
        ),
        Spacer(1, 12),
        Paragraph("Device Inventory", styles["Heading2"]),
        table_for_rows(
            ["Hostname", "IP", "Type", "Status", "Group"],
            [
                [
                    device.hostname or "-",
                    device.ip_address,
                    device.device_type or "-",
                    device.status,
                    device_to_dict(device)["topology_group"],
                ]
                for device in devices[:20]
            ]
            or [["No devices", "-", "-", "-", "-"]],
        ),
        Spacer(1, 12),
        Paragraph("IP Summary", styles["Heading2"]),
        table_for_rows(
            ["Subnet", "Devices"],
            [[subnet, str(count)] for subnet, count in subnet_counts] or [["No subnets", "0"]],
        ),
        Spacer(1, 12),
        Paragraph("Recent Firewall Event Summary", styles["Heading2"]),
        table_for_pairs(
            [
                ("Blocked", firewall_summary["blocked_events"]),
                ("Passed", firewall_summary["passed_events"]),
                ("Retention days", str(settings.firewall_log_retention_days)),
                ("Firewall data", firewall_summary["status"]),
            ],
        ),
        Spacer(1, 12),
        Paragraph("Top Blocked Sources", styles["Heading2"]),
        table_for_rows(
            ["Source", "Blocked events"],
            [[value, str(count)] for value, count in firewall_summary["blocked_sources"]] or [["No data", "0"]],
        ),
        Spacer(1, 12),
        Paragraph("Top Blocked Destinations", styles["Heading2"]),
        table_for_rows(
            ["Destination", "Blocked events"],
            [[value, str(count)] for value, count in firewall_summary["blocked_destinations"]] or [["No data", "0"]],
        ),
        Spacer(1, 12),
        Paragraph("Certificate / Security Summary", styles["Heading2"]),
        Paragraph(
            "Placeholder: certificate inventory and broader security posture reporting are not implemented yet.",
            styles["Normal"],
        ),
    ]
    doc.build(story)
    return buffer.getvalue()


def build_report_firewall_summary(firewall_db: Session) -> dict[str, object]:
    try:
        last_24_hours = datetime.now(timezone.utc) - timedelta(hours=24)
        event_counts_row = firewall_db.execute(
            select(
                func.count().label("total"),
                func.sum(case((FirewallEvent.action.in_(BLOCK_ACTIONS), 1), else_=0)).label("blocked"),
                func.sum(case((FirewallEvent.action.in_(PASS_ACTIONS), 1), else_=0)).label("passed"),
            ).where(FirewallEvent.received_at >= last_24_hours)
        ).one()
        return {
            "available": True,
            "status": "Available",
            "total_events": str(int(event_counts_row.total or 0)),
            "blocked_events": str(int(event_counts_row.blocked or 0)),
            "passed_events": str(int(event_counts_row.passed or 0)),
            "blocked_sources": top_blocked_dimension(firewall_db, FirewallEvent.src_ip),
            "blocked_destinations": top_blocked_dimension(firewall_db, FirewallEvent.dst_ip),
        }
    except (DatabaseError, SQLAlchemyError, sqlite3.Error) as exc:
        logger.warning("Skipping firewall summary in PDF report because firewall.db could not be read", exc_info=True)
        try:
            firewall_db.rollback()
        except SQLAlchemyError:
            pass
        return {
            "available": False,
            "status": "Unavailable - firewall database could not be read",
            "total_events": "Unavailable",
            "blocked_events": "Unavailable",
            "passed_events": "Unavailable",
            "blocked_sources": [],
            "blocked_destinations": [],
        }


_SIG_PREFIX = b"\n--NETMAP-SIG-V1:"
_SIG_SUFFIX = b"\n"
# Total trailer = prefix (17) + 64 hex chars + suffix (1) = 82 bytes
_SIG_TRAILER_LEN = len(_SIG_PREFIX) + 64 + len(_SIG_SUFFIX)

_EXPECTED_TABLES = frozenset({
    "users", "system_settings", "devices",
})
_RELATIONSHIP_TABLES = frozenset({"device_relationships", "links"})


def _sign_backup(db_bytes: bytes, secret: str) -> bytes:
    sig = hmac.new(secret.encode(), db_bytes, hashlib.sha256).hexdigest().encode()
    return db_bytes + _SIG_PREFIX + sig + _SIG_SUFFIX


def _verify_and_strip_backup(data: bytes, secret: str) -> bytes:
    if len(data) < _SIG_TRAILER_LEN:
        raise ValueError("Backup file is missing its integrity signature")
    trailer = data[-_SIG_TRAILER_LEN:]
    if not trailer.startswith(_SIG_PREFIX) or not trailer.endswith(_SIG_SUFFIX):
        raise ValueError(
            "Backup file is missing its integrity signature. "
            "Only backups created by this NetMap instance are accepted."
        )
    db_bytes = data[:-_SIG_TRAILER_LEN]
    provided_sig = trailer[len(_SIG_PREFIX):-len(_SIG_SUFFIX)]
    expected_sig = hmac.new(secret.encode(), db_bytes, hashlib.sha256).hexdigest().encode()
    if not hmac.compare_digest(provided_sig, expected_sig):
        raise ValueError("Backup signature verification failed — the file may have been tampered with")
    return db_bytes


def _validate_backup_schema(db_path: Path) -> None:
    with sqlite3.connect(db_path) as conn:
        tables = {
            row[0]
            for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")
        }
    missing = _EXPECTED_TABLES - tables
    if not tables.intersection(_RELATIONSHIP_TABLES):
        missing = missing | {"device_relationships"}
    if missing:
        raise ValueError(f"Backup is missing expected tables: {', '.join(sorted(missing))}")


def backup_database_bytes() -> tuple[str, bytes]:
    from app.core.secrets import signing_secret
    if not settings.database_url.startswith("sqlite"):
        raise RuntimeError("Database backup is only implemented for SQLite")
    timestamp = utc_timestamp()
    with tempfile.NamedTemporaryFile(suffix=".db", delete=False) as handle:
        temp_path = Path(handle.name)
    source = engine.raw_connection()
    try:
        source_connection = source.driver_connection
        if not isinstance(source_connection, sqlite3.Connection):
            raise RuntimeError("Database backup is only implemented for SQLite")
        with sqlite3.connect(temp_path) as destination:
            source_connection.backup(destination)
        raw = temp_path.read_bytes()
        return f"netmap-backup-{timestamp}.db", _sign_backup(raw, signing_secret())
    finally:
        source.close()
        temp_path.unlink(missing_ok=True)


def restore_database_bytes(payload: bytes) -> None:
    from app.core.secrets import signing_secret
    db_bytes = _verify_and_strip_backup(payload, signing_secret())
    database_path = sqlite_database_path()
    target_path = Path(database_path)
    target_path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(suffix=".db", delete=False) as handle:
        temp_path = Path(handle.name)
        temp_path.write_bytes(db_bytes)
    try:
        _validate_backup_schema(temp_path)
        engine.dispose()
        with sqlite3.connect(temp_path) as source, sqlite3.connect(database_path) as destination:
            source.backup(destination)
    finally:
        engine.dispose()
        temp_path.unlink(missing_ok=True)


def apply_firewall_filters(
    query,
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
):
    if q:
        like = f"%{q.strip()}%"
        query = query.where(
            or_(
                FirewallEvent.raw_log.ilike(like),
                FirewallEvent.src_ip.ilike(like),
                FirewallEvent.dst_ip.ilike(like),
                FirewallEvent.source_host.ilike(like),
                FirewallEvent.rule_id.ilike(like),
                FirewallEvent.reason.ilike(like),
            ),
        )
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


def serialize_device_export(device: Device) -> dict[str, object]:
    data = device_to_dict(device)
    return {
        **data,
        "tags": ", ".join(data["tags"]),
    }


def serialize_firewall_event_export(event: FirewallEvent) -> dict[str, object]:
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


def top_blocked_dimension(db: Session, column, limit: int = 5) -> list[tuple[str, int]]:
    rows = db.execute(
        select(column, func.count())
        .where(FirewallEvent.action.in_(BLOCK_ACTIONS), column.is_not(None))
        .group_by(column)
        .order_by(desc(func.count()))
        .limit(limit),
    ).all()
    return [(str(value), int(count)) for value, count in rows if value]


def summarize_subnets(devices: Sequence[Device]) -> list[tuple[str, int]]:
    counts: dict[str, int] = {}
    for device in devices:
        subnet = device.subnet or infer_subnet(device.ip_address) or "Unknown"
        counts[subnet] = counts.get(subnet, 0) + 1
    return sorted(counts.items(), key=lambda item: (-item[1], item[0]))[:10]


def table_for_pairs(rows: Sequence[tuple[str, str]]) -> Table:
    table = Table([[label, value] for label, value in rows], colWidths=[180, 280])
    table.setStyle(common_table_style())
    return table


def table_for_rows(headers: Sequence[str], rows: Sequence[Sequence[str]]) -> Table:
    table = Table([list(headers), *[list(row) for row in rows]], repeatRows=1)
    style = common_table_style()
    style.add("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#d9e6ef"))
    style.add("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold")
    table.setStyle(style)
    return table


def common_table_style() -> TableStyle:
    return TableStyle(
        [
            ("GRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#b7c9d6")),
            ("BACKGROUND", (0, 0), (-1, -1), colors.white),
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ("PADDING", (0, 0), (-1, -1), 6),
        ],
    )


def encode_csv(rows: Sequence[dict[str, object]], *, fieldnames: Sequence[str]) -> bytes:
    output = io.StringIO()
    writer = csv.DictWriter(output, fieldnames=fieldnames)
    writer.writeheader()
    for row in rows:
        writer.writerow({key: format_csv_value(row.get(key)) for key in fieldnames})
    return output.getvalue().encode("utf-8")


def format_csv_value(value: object) -> str:
    if value is None:
        return ""
    if isinstance(value, datetime):
        return value.astimezone(timezone.utc).isoformat()
    if isinstance(value, list):
        return ", ".join(str(item) for item in value)
    return str(value)


def json_default(value: object) -> str:
    if isinstance(value, datetime):
        return value.astimezone(timezone.utc).isoformat()
    return str(value)


def utc_timestamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")


def sqlite_database_path() -> str:
    if not settings.database_url.startswith("sqlite:///"):
        raise RuntimeError("Database backup is only implemented for SQLite")
    return settings.database_url.removeprefix("sqlite:///")
