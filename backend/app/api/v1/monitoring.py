from __future__ import annotations

import json
import math
from datetime import datetime, timedelta, timezone
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, select, text
from sqlalchemy.orm import Session

from app.api.deps import get_current_user
from app.db.session import get_db
from app.models.device import Device
from app.models.monitor_history import DeviceMonitorHistory
from app.models.port_target import DevicePortTarget
from app.models.site import Site
from app.models.user import User
from app.schemas.monitoring import (
    DeviceAnalysis,
    DeviceMonitorSummary,
    FleetSummary,
    MonitorHistoryPoint,
    PortResult,
    PortTargetCreate,
    PortTargetOut,
)

router = APIRouter(prefix="/monitoring", tags=["monitoring"])


def _parse_port_results(raw: str) -> list[PortResult]:
    try:
        items = json.loads(raw) if raw else []
        return [PortResult(**item) for item in items]
    except Exception:
        return []


@router.get("/summary", response_model=FleetSummary)
def fleet_summary(
    _current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
) -> FleetSummary:
    # All non-disabled devices — same set seen by inventory/topology
    devices = db.scalars(select(Device).where(Device.status != "disabled")).all()

    online = sum(1 for d in devices if d.monitor_status == "online")
    offline = sum(1 for d in devices if d.monitor_status == "offline")
    unknown = len(devices) - online - offline

    # RTT average and last-checked timestamp still come from history
    last_checked_row = db.scalar(select(func.max(DeviceMonitorHistory.checked_at)))
    since = datetime.now(timezone.utc) - timedelta(hours=1)
    rtt_rows = db.scalars(
        select(DeviceMonitorHistory.rtt_ms).where(
            DeviceMonitorHistory.checked_at >= since,
            DeviceMonitorHistory.rtt_ms.isnot(None),
        )
    ).all()

    return FleetSummary(
        total=len(devices),
        online=online,
        offline=offline,
        unknown=unknown,
        avg_rtt_ms=sum(rtt_rows) / len(rtt_rows) if rtt_rows else None,
        last_checked=last_checked_row,
    )


@router.get("/devices", response_model=list[DeviceMonitorSummary])
def list_device_summaries(
    _current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
) -> list[DeviceMonitorSummary]:
    devices = db.scalars(select(Device).where(Device.status != "disabled")).all()
    site_map = {s.id: (s.display_name or s.name) for s in db.scalars(select(Site)).all()}
    now = datetime.now(timezone.utc)
    since_24h = now - timedelta(hours=24)
    since_7d = now - timedelta(days=7)

    results: list[DeviceMonitorSummary] = []
    for device in devices:
        history_24h = db.scalars(
            select(DeviceMonitorHistory)
            .where(DeviceMonitorHistory.device_id == device.id, DeviceMonitorHistory.checked_at >= since_24h)
            .order_by(DeviceMonitorHistory.checked_at.desc())
        ).all()

        history_7d_count = db.scalar(
            select(func.count())
            .where(DeviceMonitorHistory.device_id == device.id, DeviceMonitorHistory.checked_at >= since_7d)
        ) or 0
        online_7d = db.scalar(
            select(func.count())
            .where(
                DeviceMonitorHistory.device_id == device.id,
                DeviceMonitorHistory.checked_at >= since_7d,
                DeviceMonitorHistory.status == "online",
            )
        ) or 0

        last_record = history_24h[0] if history_24h else None
        online_24h = sum(1 for h in history_24h if h.status == "online")
        rtts = [h.rtt_ms for h in history_24h if h.rtt_ms is not None]

        heartbeat = [h.status for h in reversed(history_24h[:50])]

        results.append(
            DeviceMonitorSummary(
                device_id=device.id,
                display_name=device.display_name,
                hostname=device.hostname,
                ip_address=device.ip_address,
                status=device.monitor_status or "unknown",
                topology_group=device.topology_group or None,
                site_id=device.site_id,
                site_name=site_map.get(device.site_id) if device.site_id else None,
                vlan_id=device.vlan_id or None,
                last_checked=last_record.checked_at if last_record else None,
                uptime_24h=online_24h / len(history_24h) if history_24h else None,
                uptime_7d=online_7d / history_7d_count if history_7d_count > 0 else None,
                avg_rtt_24h=sum(rtts) / len(rtts) if rtts else None,
                latest_port_results=_parse_port_results(last_record.port_results) if last_record else [],
                heartbeat=heartbeat,
                is_favourite=bool(device.is_favourite),
            )
        )

    return results


@router.get("/devices/{device_id}/history", response_model=list[MonitorHistoryPoint])
def device_history(
    device_id: int,
    _current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
    hours: int = 24,
) -> list[MonitorHistoryPoint]:
    device = db.get(Device, device_id)
    if not device:
        raise HTTPException(status_code=404, detail="Device not found")

    since = datetime.now(timezone.utc) - timedelta(hours=min(hours, 24 * 30))
    rows = db.scalars(
        select(DeviceMonitorHistory)
        .where(DeviceMonitorHistory.device_id == device_id, DeviceMonitorHistory.checked_at >= since)
        .order_by(DeviceMonitorHistory.checked_at.asc())
    ).all()

    return [
        MonitorHistoryPoint(
            id=r.id,
            checked_at=r.checked_at,
            status=r.status,
            rtt_ms=r.rtt_ms,
            port_results=_parse_port_results(r.port_results),
        )
        for r in rows
    ]


@router.get("/devices/{device_id}/analysis", response_model=DeviceAnalysis)
def device_analysis(
    device_id: int,
    _current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
) -> DeviceAnalysis:
    device = db.get(Device, device_id)
    if not device:
        raise HTTPException(status_code=404, detail="Device not found")

    now = datetime.now(timezone.utc)
    since_7d = now - timedelta(days=7)
    since_24h = now - timedelta(hours=24)
    since_6h = now - timedelta(hours=6)
    since_6_24h = now - timedelta(hours=24)  # start of 6–24h window (end = since_6h)

    rows_7d = db.scalars(
        select(DeviceMonitorHistory)
        .where(DeviceMonitorHistory.device_id == device_id, DeviceMonitorHistory.checked_at >= since_7d)
        .order_by(DeviceMonitorHistory.checked_at.asc())
    ).all()

    # ── RTT baseline (7-day) ─────────────────────────────────────────────────
    rtts_7d = [r.rtt_ms for r in rows_7d if r.rtt_ms is not None]
    baseline_rtt: float | None = None
    rtt_stddev: float | None = None
    rtt_p50: float | None = None
    rtt_p95: float | None = None

    if rtts_7d:
        baseline_rtt = sum(rtts_7d) / len(rtts_7d)
        if len(rtts_7d) >= 2:
            variance = sum((x - baseline_rtt) ** 2 for x in rtts_7d) / len(rtts_7d)
            rtt_stddev = math.sqrt(variance)
        sorted_rtts = sorted(rtts_7d)
        n = len(sorted_rtts)
        rtt_p50 = sorted_rtts[int(n * 0.50)]
        rtt_p95 = sorted_rtts[min(n - 1, int(n * 0.95))]

    # ── Current RTT (latest record) ──────────────────────────────────────────
    current_rtt: float | None = rows_7d[-1].rtt_ms if rows_7d else None

    # ── Anomaly score ────────────────────────────────────────────────────────
    anomaly_score: float | None = None
    if len(rtts_7d) < 10:
        anomaly_level = "insufficient_data"
    elif current_rtt is None:
        anomaly_level = "insufficient_data"
    elif rtt_stddev and rtt_stddev > 0:
        anomaly_score = (current_rtt - baseline_rtt) / rtt_stddev  # type: ignore[operator]
        abs_z = abs(anomaly_score)
        anomaly_level = "anomalous" if abs_z > 3 else "elevated" if abs_z > 2 else "normal"
    else:
        anomaly_level = "normal"

    # ── Trend: recent 6 h vs 6–24 h window ──────────────────────────────────
    rtts_recent = [r.rtt_ms for r in rows_7d if r.rtt_ms is not None and r.checked_at >= since_6h]
    rtts_older = [r.rtt_ms for r in rows_7d if r.rtt_ms is not None and since_6_24h <= r.checked_at < since_6h]
    trend = "insufficient_data"
    trend_pct: float | None = None

    if len(rtts_recent) >= 3 and len(rtts_older) >= 3:
        mean_recent = sum(rtts_recent) / len(rtts_recent)
        mean_older = sum(rtts_older) / len(rtts_older)
        if mean_older > 0:
            trend_pct = (mean_recent - mean_older) / mean_older * 100
            trend = "rising" if trend_pct > 15 else "falling" if trend_pct < -15 else "stable"

    # ── Flap count (status transitions in 24 h) ──────────────────────────────
    rows_24h = [r for r in rows_7d if r.checked_at >= since_24h]
    flap_count = 0
    for i in range(1, len(rows_24h)):
        if rows_24h[i].status != rows_24h[i - 1].status:
            flap_count += 1

    # ── Longest offline streak (7 days) ──────────────────────────────────────
    longest_outage_minutes: int | None = None
    streak_start: datetime | None = None
    for row in rows_7d:
        if row.status == "offline":
            if streak_start is None:
                streak_start = row.checked_at
        else:
            if streak_start is not None:
                duration = int((row.checked_at - streak_start).total_seconds() / 60)
                longest_outage_minutes = max(longest_outage_minutes or 0, duration)
                streak_start = None
    # handle open streak at end
    if streak_start is not None and rows_7d:
        duration = int((rows_7d[-1].checked_at - streak_start).total_seconds() / 60)
        longest_outage_minutes = max(longest_outage_minutes or 0, duration)

    return DeviceAnalysis(
        device_id=device_id,
        baseline_rtt_ms=round(baseline_rtt, 2) if baseline_rtt is not None else None,
        rtt_stddev=round(rtt_stddev, 2) if rtt_stddev is not None else None,
        rtt_p50=round(rtt_p50, 2) if rtt_p50 is not None else None,
        rtt_p95=round(rtt_p95, 2) if rtt_p95 is not None else None,
        current_rtt_ms=round(current_rtt, 2) if current_rtt is not None else None,
        anomaly_score=round(anomaly_score, 2) if anomaly_score is not None else None,
        anomaly_level=anomaly_level,
        trend=trend,
        trend_pct=round(trend_pct, 1) if trend_pct is not None else None,
        flap_count_24h=flap_count,
        longest_outage_minutes=longest_outage_minutes,
    )


@router.get("/port-targets", response_model=list[PortTargetOut])
def list_port_targets(
    _current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
) -> list[PortTargetOut]:
    return list(db.scalars(select(DevicePortTarget).order_by(DevicePortTarget.device_id.nulls_first(), DevicePortTarget.port)))


@router.post("/port-targets", response_model=PortTargetOut, status_code=201)
def create_port_target(
    payload: PortTargetCreate,
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
) -> PortTargetOut:
    if current_user.role not in ("SuperAdmin", "NetworkAdmin"):
        raise HTTPException(status_code=403, detail="Insufficient permissions")
    target = DevicePortTarget(
        device_id=payload.device_id,
        port=payload.port,
        label=payload.label,
    )
    db.add(target)
    db.commit()
    db.refresh(target)
    return target


@router.delete("/port-targets/{target_id}", status_code=204, response_model=None)
def delete_port_target(
    target_id: int,
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
) -> None:
    if current_user.role not in ("SuperAdmin", "NetworkAdmin"):
        raise HTTPException(status_code=403, detail="Insufficient permissions")
    target = db.get(DevicePortTarget, target_id)
    if not target:
        raise HTTPException(status_code=404, detail="Port target not found")
    db.delete(target)
    db.commit()
