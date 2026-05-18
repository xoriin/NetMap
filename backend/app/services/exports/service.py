from __future__ import annotations

import csv
import io
import json
import sqlite3
import tempfile
from collections.abc import Sequence
from datetime import datetime, timedelta, timezone
from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle
from sqlalchemy import desc, func, or_, select
from sqlalchemy.orm import Session

from app.core.config import settings
from app.db.session import engine
from app.models.device import Device
from app.models.firewall_event import FirewallEvent
from app.services.topology.service import device_to_dict, infer_subnet

BLOCK_ACTIONS = ("block", "deny", "drop")
PASS_ACTIONS = ("pass", "allow", "accept")


def build_inventory_export(db: Session, export_format: str) -> tuple[str, str, bytes]:
    devices = db.scalars(select(Device).order_by(Device.hostname, Device.ip_address)).all()
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
    db: Session,
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
    events = db.scalars(
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


def build_network_report_pdf(db: Session) -> bytes:
    devices = db.scalars(select(Device).order_by(Device.hostname, Device.ip_address)).all()
    last_24_hours = datetime.now(timezone.utc) - timedelta(hours=24)
    total_events = int(
        db.scalar(
            select(func.count()).select_from(FirewallEvent).where(FirewallEvent.received_at >= last_24_hours),
        )
        or 0
    )
    blocked_events = int(
        db.scalar(
            select(func.count())
            .select_from(FirewallEvent)
            .where(
                FirewallEvent.received_at >= last_24_hours,
                FirewallEvent.action.in_(BLOCK_ACTIONS),
            ),
        )
        or 0
    )
    passed_events = int(
        db.scalar(
            select(func.count())
            .select_from(FirewallEvent)
            .where(
                FirewallEvent.received_at >= last_24_hours,
                FirewallEvent.action.in_(PASS_ACTIONS),
            ),
        )
        or 0
    )

    blocked_sources = top_blocked_dimension(db, FirewallEvent.src_ip)
    blocked_destinations = top_blocked_dimension(db, FirewallEvent.dst_ip)
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
                ("Firewall events in last 24h", str(total_events)),
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
                ("Blocked", str(blocked_events)),
                ("Passed", str(passed_events)),
                ("Retention days", str(settings.firewall_log_retention_days)),
            ],
        ),
        Spacer(1, 12),
        Paragraph("Top Blocked Sources", styles["Heading2"]),
        table_for_rows(
            ["Source", "Blocked events"],
            [[value, str(count)] for value, count in blocked_sources] or [["No data", "0"]],
        ),
        Spacer(1, 12),
        Paragraph("Top Blocked Destinations", styles["Heading2"]),
        table_for_rows(
            ["Destination", "Blocked events"],
            [[value, str(count)] for value, count in blocked_destinations] or [["No data", "0"]],
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


def backup_database_bytes() -> tuple[str, bytes]:
    database_path = sqlite_database_path()
    timestamp = utc_timestamp()
    with tempfile.NamedTemporaryFile(suffix=".db", delete=False) as handle:
        temp_path = Path(handle.name)
    try:
        with sqlite3.connect(database_path) as source, sqlite3.connect(temp_path) as destination:
            source.backup(destination)
        return f"netmap-backup-{timestamp}.db", temp_path.read_bytes()
    finally:
        temp_path.unlink(missing_ok=True)


def restore_database_bytes(payload: bytes) -> None:
    database_path = sqlite_database_path()
    target_path = Path(database_path)
    target_path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(suffix=".db", delete=False) as handle:
        temp_path = Path(handle.name)
        temp_path.write_bytes(payload)
    try:
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
