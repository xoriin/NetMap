from __future__ import annotations

import json
import math
import time
from datetime import datetime, timedelta, timezone
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import Row, case, func, or_, select
from sqlalchemy.orm import Session

from app.api.deps import get_current_user, require_monitoring_write
from app.db.session import get_db
from app.models.device import Device
from app.models.monitor_history import DeviceMonitorHistory
from app.models.port_target import DevicePortTarget
from app.models.site import Site
from app.models.system_setting import SystemSetting
from app.models.topology_group import TopologyGroup
from app.models.user import User
from app.schemas.monitoring import (
    DeviceAnalysis,
    DeviceMonitorSummary,
    FleetSummary,
    MonitorHistoryPoint,
    PortResult,
    PortTargetCreate,
    PortTargetOut,
    PortTargetOrder,
    PortTargetOrderConfig,
)
from app.services.monitoring.health import observed_health, observed_is_healthy

router = APIRouter(prefix="/monitoring", tags=["monitoring"])
SERVICE_CHECK_ORDER_MODE_KEY = "service_check_order_mode"


def _service_check_order_mode(db: Session) -> str:
    row = db.get(SystemSetting, SERVICE_CHECK_ORDER_MODE_KEY)
    return row.value if row is not None and row.value in {"alphabetical", "manual"} else "alphabetical"


def _reindex_service_checks(db: Session, mode: str, target_ids: list[int] | None = None) -> list[DevicePortTarget]:
    rows = list(db.scalars(select(DevicePortTarget)).all())
    if mode == "alphabetical":
        rows.sort(key=lambda row: (row.label.casefold(), row.port, row.id))
    else:
        by_id = {row.id: row for row in rows}
        if target_ids is None or len(target_ids) != len(set(target_ids)) or set(target_ids) != set(by_id):
            raise HTTPException(status_code=400, detail="Manual order must contain every service check exactly once")
        rows = [by_id[target_id] for target_id in target_ids]
    for index, row in enumerate(rows, start=1):
        row.sort_order = index
    return rows

# (device_id, checked_at, status, rtt_ms, port_results) — the heartbeat columns.
_HeartbeatRow = Row[tuple[int, datetime, str, float | None, str, str, bool | None]]

_MONITORING_CACHE_TTL = 10.0  # seconds — short enough for configurable monitor intervals
_fleet_summary_cache: tuple[float, Any] | None = None
_device_summaries_cache: tuple[float, Any] | None = None
_fleet_summary_cache_hits = 0
_fleet_summary_cache_misses = 0
_device_summaries_cache_hits = 0
_device_summaries_cache_misses = 0


def monitoring_cache_status() -> dict[str, object]:
    now_mono = time.monotonic()
    return {
        "ttl_seconds": _MONITORING_CACHE_TTL,
        "fleet_summary": {
            "cached": _fleet_summary_cache is not None,
            "age_seconds": (now_mono - _fleet_summary_cache[0]) if _fleet_summary_cache else None,
            "hits": _fleet_summary_cache_hits,
            "misses": _fleet_summary_cache_misses,
        },
        "device_summaries": {
            "cached": _device_summaries_cache is not None,
            "age_seconds": (now_mono - _device_summaries_cache[0]) if _device_summaries_cache else None,
            "hits": _device_summaries_cache_hits,
            "misses": _device_summaries_cache_misses,
        },
    }


def _parse_port_results(raw: str) -> list[PortResult]:
    try:
        items = json.loads(raw) if raw else []
        results = [PortResult(**item) for item in items]
        return sorted(results, key=lambda item: (item.label.casefold(), item.port, item.target_id or 0))
    except Exception:
        return []


def _as_utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


@router.get("/summary", response_model=FleetSummary)
def fleet_summary(
    _current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
) -> FleetSummary:
    global _fleet_summary_cache, _fleet_summary_cache_hits, _fleet_summary_cache_misses
    now_mono = time.monotonic()
    cached = _fleet_summary_cache
    if cached is not None and now_mono - cached[0] < _MONITORING_CACHE_TTL:
        _fleet_summary_cache_hits += 1
        return cached[1]
    _fleet_summary_cache_misses += 1

    paused_condition = or_(Device.monitoring_paused == True, Device.lifecycle != "active")  # noqa: E712
    status_rows = db.execute(
        select(Device.monitor_status, Device.expected_status, func.count())
        .where(Device.status != "disabled", ~paused_condition)
        .group_by(Device.monitor_status, Device.expected_status)
    ).all()
    total = 0
    online = 0
    offline = 0
    healthy = 0
    unhealthy = 0
    for status, expected_status, count in status_rows:
        total += count
        if status == "online":
            online += count
        elif status == "offline":
            offline += count
        health = observed_health(status, expected_status)
        if health == "healthy":
            healthy += count
        elif health == "unhealthy":
            unhealthy += count
    unknown = total - online - offline
    paused = int(db.scalar(
        select(func.count()).select_from(Device).where(Device.status != "disabled", paused_condition)
    ) or 0)
    total += paused

    last_checked_row = db.scalar(select(func.max(DeviceMonitorHistory.checked_at)))
    since = datetime.now(timezone.utc) - timedelta(hours=1)
    avg_rtt = db.scalar(
        select(func.avg(DeviceMonitorHistory.rtt_ms)).where(
            DeviceMonitorHistory.checked_at >= since,
            DeviceMonitorHistory.rtt_ms.isnot(None),
        )
    )

    result = FleetSummary(
        total=total,
        online=online,
        offline=offline,
        unknown=unknown,
        paused=paused,
        healthy=healthy,
        unhealthy=unhealthy,
        avg_rtt_ms=float(avg_rtt) if avg_rtt is not None else None,
        last_checked=_as_utc(last_checked_row) if last_checked_row else None,
    )
    _fleet_summary_cache = (now_mono, result)
    return result


def _build_device_summaries(
    db: Session,
    devices: list[Device],
) -> list[DeviceMonitorSummary]:
    site_map = {s.id: (s.display_name or s.name) for s in db.scalars(select(Site)).all()}
    group_name_map = {g.id: g.name for g in db.scalars(select(TopologyGroup)).all()}
    now = datetime.now(timezone.utc)
    since_24h = now - timedelta(hours=24)
    since_7d = now - timedelta(days=7)

    device_ids = [device.id for device in devices]
    history_by_device: dict[int, list[_HeartbeatRow]] = {device_id: [] for device_id in device_ids}
    uptime_24h_by_device: dict[int, tuple[int, int, float | None, int]] = {}
    uptime_7d_by_device: dict[int, tuple[int, int, int]] = {}

    if device_ids:
        heartbeat_subq = (
            select(
                DeviceMonitorHistory.id,
                func.row_number().over(
                    partition_by=DeviceMonitorHistory.device_id,
                    order_by=DeviceMonitorHistory.checked_at.desc(),
                ).label("rn"),
            )
            .where(
                DeviceMonitorHistory.device_id.in_(device_ids),
                DeviceMonitorHistory.checked_at >= since_24h,
            )
            .subquery()
        )
        # Rows, not entities: this pulls up to 50 records per device and nothing
        # here needs identity-map tracking or lazy loading, which cost roughly
        # 4x the plain column fetch at fleet scale.
        history_rows = db.execute(
            select(
                DeviceMonitorHistory.device_id,
                DeviceMonitorHistory.checked_at,
                DeviceMonitorHistory.status,
                DeviceMonitorHistory.rtt_ms,
                DeviceMonitorHistory.port_results,
                DeviceMonitorHistory.expected_status,
                DeviceMonitorHistory.is_healthy,
            )
            .join(heartbeat_subq, DeviceMonitorHistory.id == heartbeat_subq.c.id)
            .where(heartbeat_subq.c.rn <= 50)
            .order_by(DeviceMonitorHistory.device_id.asc(), DeviceMonitorHistory.checked_at.desc())
        ).all()
        for row in history_rows:
            history_by_device[row.device_id].append(row)

        uptime_24h_rows = db.execute(
            select(
                DeviceMonitorHistory.device_id,
                func.count().label("total"),
                func.sum(case((DeviceMonitorHistory.status == "online", 1), else_=0)).label("online"),
                func.avg(DeviceMonitorHistory.rtt_ms).label("avg_rtt"),
                func.sum(case(
                    (DeviceMonitorHistory.is_healthy == True, 1),  # noqa: E712
                    (DeviceMonitorHistory.is_healthy == False, 0),  # noqa: E712
                    (DeviceMonitorHistory.status == "online", 1),
                    else_=0,
                )).label("healthy"),
            )
            .where(
                DeviceMonitorHistory.device_id.in_(device_ids),
                DeviceMonitorHistory.checked_at >= since_24h,
            )
            .group_by(DeviceMonitorHistory.device_id)
        ).all()
        uptime_24h_by_device = {
            row.device_id: (int(row.total or 0), int(row.online or 0), row.avg_rtt, int(row.healthy or 0))
            for row in uptime_24h_rows
        }

        uptime_rows = db.execute(
            select(
                DeviceMonitorHistory.device_id,
                func.count().label("total"),
                func.sum(case((DeviceMonitorHistory.status == "online", 1), else_=0)).label("online"),
                func.sum(case(
                    (DeviceMonitorHistory.is_healthy == True, 1),  # noqa: E712
                    (DeviceMonitorHistory.is_healthy == False, 0),  # noqa: E712
                    (DeviceMonitorHistory.status == "online", 1),
                    else_=0,
                )).label("healthy"),
            )
            .where(
                DeviceMonitorHistory.device_id.in_(device_ids),
                DeviceMonitorHistory.checked_at >= since_7d,
            )
            .group_by(DeviceMonitorHistory.device_id)
        ).all()
        uptime_7d_by_device = {
            row.device_id: (int(row.total or 0), int(row.online or 0), int(row.healthy or 0))
            for row in uptime_rows
        }

    one_hour_ago = now - timedelta(hours=1)
    results: list[DeviceMonitorSummary] = []
    for device in devices:
        history_recent = history_by_device.get(device.id, [])
        total_24h, online_24h, avg_rtt_24h, healthy_24h = uptime_24h_by_device.get(device.id, (0, 0, None, 0))
        history_7d_count, online_7d, healthy_7d = uptime_7d_by_device.get(device.id, (0, 0, 0))
        last_record = history_recent[0] if history_recent else None
        heartbeat = [h.status for h in reversed(history_recent)]
        heartbeat_health = []
        for history_row in reversed(history_recent):
            is_healthy = history_row.is_healthy
            if is_healthy is None:
                is_healthy = observed_is_healthy(history_row.status, history_row.expected_status)
            heartbeat_health.append("healthy" if is_healthy is True else "unhealthy" if is_healthy is False else "unknown")
        rtt_sparkline: list[float | None] = [h.rtt_ms for h in reversed(history_recent)]
        recent_hour = [h for h in reversed(history_recent) if _as_utc(h.checked_at) >= one_hour_ago]
        transitions = sum(1 for a, b in zip(recent_hour, recent_hour[1:]) if a.status != b.status)
        is_paused = bool(device.monitoring_paused) or device.lifecycle != "active"

        results.append(
            DeviceMonitorSummary(
                device_id=device.id,
                display_name=device.display_name,
                hostname=device.hostname,
                ip_address=device.ip_address,
                device_type=device.device_type,
                icon=device.icon,
                status="paused" if is_paused else (device.monitor_status or "unknown"),
                expected_status=device.expected_status or "online",
                health_status="paused" if is_paused else observed_health(device.monitor_status, device.expected_status),
                lifecycle=device.lifecycle or "active",
                monitoring_paused=bool(device.monitoring_paused),
                topology_group=device.topology_group or group_name_map.get(device.topology_group_id) or None,
                site_id=device.site_id,
                site_name=site_map.get(device.site_id) if device.site_id else None,
                vlan_id=device.vlan_id or None,
                last_checked=_as_utc(last_record.checked_at) if last_record else None,
                uptime_24h=online_24h / total_24h if total_24h > 0 else None,
                uptime_7d=online_7d / history_7d_count if history_7d_count > 0 else None,
                compliance_24h=healthy_24h / total_24h if total_24h > 0 else None,
                compliance_7d=healthy_7d / history_7d_count if history_7d_count > 0 else None,
                avg_rtt_24h=float(avg_rtt_24h) if avg_rtt_24h is not None else None,
                latest_port_results=_parse_port_results(last_record.port_results) if last_record else [],
                heartbeat=heartbeat,
                heartbeat_health=heartbeat_health,
                rtt_sparkline=rtt_sparkline,
                is_favourite=bool(device.is_favourite),
                flapping=transitions >= 4 and not is_paused,
            )
        )

    return results


def _changed_device_filter(changed_since: datetime):
    since_utc = changed_since if changed_since.tzinfo else changed_since.replace(tzinfo=timezone.utc)
    return or_(
        Device.last_monitored_at > since_utc,
        Device.updated_at > since_utc,
    )


@router.get("/devices", response_model=list[DeviceMonitorSummary])
def list_device_summaries(
    _current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
    changed_since: Annotated[datetime | None, Query()] = None,
) -> list[DeviceMonitorSummary]:
    # Delta path: skip cache, return devices with monitor or metadata changes since the cursor.
    # Deletions and disabled-device removals are reconciled by periodic full refreshes.
    if changed_since is not None:
        devices = db.scalars(
            select(Device).where(
                Device.status != "disabled",
                _changed_device_filter(changed_since),
            )
        ).all()
        if not devices:
            return []
        return _build_device_summaries(db, list(devices))

    # Full path: use TTL cache
    global _device_summaries_cache, _device_summaries_cache_hits, _device_summaries_cache_misses
    now_mono = time.monotonic()
    cached = _device_summaries_cache
    if cached is not None and now_mono - cached[0] < _MONITORING_CACHE_TTL:
        _device_summaries_cache_hits += 1
        return cached[1]
    _device_summaries_cache_misses += 1

    devices = db.scalars(select(Device).where(Device.status != "disabled")).all()
    results = _build_device_summaries(db, list(devices))
    _device_summaries_cache = (now_mono, results)
    return results


@router.get("/devices/{device_id}", response_model=DeviceMonitorSummary)
def get_device_summary(
    device_id: int,
    _current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
) -> DeviceMonitorSummary:
    """Return monitoring detail for one inventory sidebar or drilldown.

    This deliberately bypasses the fleet cache: a selected-device panel should
    reflect an expectation edit immediately and should not load every device
    merely to obtain one current RTT/status summary.
    """
    device = db.get(Device, device_id)
    if not device:
        raise HTTPException(status_code=404, detail="Device not found")
    return _build_device_summaries(db, [device])[0]


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
            checked_at=_as_utc(r.checked_at),
            status=r.status,
            expected_status=r.expected_status or "online",
            is_healthy=r.is_healthy if r.is_healthy is not None else observed_is_healthy(r.status, r.expected_status),
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
    rtts_recent = [
        r.rtt_ms
        for r in rows_7d
        if r.rtt_ms is not None and _as_utc(r.checked_at) >= since_6h
    ]
    rtts_older = [
        r.rtt_ms
        for r in rows_7d
        if r.rtt_ms is not None and since_6_24h <= _as_utc(r.checked_at) < since_6h
    ]
    trend = "insufficient_data"
    trend_pct: float | None = None

    if len(rtts_recent) >= 3 and len(rtts_older) >= 3:
        mean_recent = sum(rtts_recent) / len(rtts_recent)
        mean_older = sum(rtts_older) / len(rtts_older)
        if mean_older > 0:
            trend_pct = (mean_recent - mean_older) / mean_older * 100
            trend = "rising" if trend_pct > 15 else "falling" if trend_pct < -15 else "stable"

    # ── Flap count (status transitions in 24 h) ──────────────────────────────
    rows_24h = [r for r in rows_7d if _as_utc(r.checked_at) >= since_24h]
    flap_count = 0
    for i in range(1, len(rows_24h)):
        if rows_24h[i].status != rows_24h[i - 1].status:
            flap_count += 1

    # ── Longest offline streak (7 days) ──────────────────────────────────────
    longest_outage_minutes: int | None = None
    streak_start: datetime | None = None
    for row in rows_7d:
        checked_at = _as_utc(row.checked_at)
        is_healthy = row.is_healthy if row.is_healthy is not None else observed_is_healthy(row.status, row.expected_status)
        if is_healthy is False:
            if streak_start is None:
                streak_start = checked_at
        else:
            if streak_start is not None:
                duration = int((checked_at - streak_start).total_seconds() / 60)
                longest_outage_minutes = max(longest_outage_minutes or 0, duration)
                streak_start = None
    # handle open streak at end
    if streak_start is not None and rows_7d:
        duration = int((_as_utc(rows_7d[-1].checked_at) - streak_start).total_seconds() / 60)
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


@router.get("/service-checks", response_model=list[PortTargetOut])
@router.get("/port-targets", response_model=list[PortTargetOut])
def list_port_targets(
    _current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
) -> list[PortTargetOut]:
    rows = db.scalars(select(DevicePortTarget)).all()
    if _service_check_order_mode(db) == "alphabetical":
        return sorted(rows, key=lambda row: (row.label.casefold(), row.port, row.id))
    return sorted(rows, key=lambda row: (row.sort_order, row.id))


@router.post("/service-checks", response_model=PortTargetOut, status_code=201)
@router.post("/port-targets", response_model=PortTargetOut, status_code=201)
def create_port_target(
    payload: PortTargetCreate,
    current_user: Annotated[User, Depends(require_monitoring_write)],
    db: Annotated[Session, Depends(get_db)],
) -> PortTargetOut:
    if payload.device_id is not None and db.get(Device, payload.device_id) is None:
        raise HTTPException(status_code=404, detail="Device not found")
    is_http = payload.check_type in ("http", "https")
    target = DevicePortTarget(
        device_id=payload.device_id,
        port=payload.port,
        label=payload.label,
        check_type=payload.check_type,
        http_path=payload.http_path if is_http else None,
        http_method=payload.http_method if is_http else "GET",
        expected_status_min=payload.expected_status_min,
        expected_status_max=payload.expected_status_max,
        timeout_seconds=payload.timeout_seconds if is_http else None,
        verify_tls=payload.verify_tls if is_http else False,
        follow_redirects=payload.follow_redirects if is_http else True,
        enabled=payload.enabled,
        sort_order=(db.scalar(select(func.max(DevicePortTarget.sort_order))) or 0) + 1,
    )
    db.add(target)
    db.flush()
    if _service_check_order_mode(db) == "alphabetical":
        _reindex_service_checks(db, "alphabetical")
    db.commit()
    db.refresh(target)
    return target


@router.get("/service-checks/order-config", response_model=PortTargetOrderConfig)
def get_port_target_order_config(
    _current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
) -> PortTargetOrderConfig:
    return PortTargetOrderConfig(mode=_service_check_order_mode(db))


@router.put("/service-checks/order-config", response_model=list[PortTargetOut])
def set_port_target_order_config(
    payload: PortTargetOrderConfig,
    current_user: Annotated[User, Depends(require_monitoring_write)],
    db: Annotated[Session, Depends(get_db)],
) -> list[PortTargetOut]:
    rows = _reindex_service_checks(db, payload.mode, payload.target_ids)
    setting = db.get(SystemSetting, SERVICE_CHECK_ORDER_MODE_KEY)
    if setting is None:
        db.add(SystemSetting(key=SERVICE_CHECK_ORDER_MODE_KEY, value=payload.mode))
    else:
        setting.value = payload.mode
        setting.updated_at = datetime.now(timezone.utc)
    db.commit()
    return rows


@router.put("/service-checks/order", response_model=list[PortTargetOut])
@router.put("/port-targets/order", response_model=list[PortTargetOut])
def reorder_port_targets(
    payload: PortTargetOrder,
    current_user: Annotated[User, Depends(require_monitoring_write)],
    db: Annotated[Session, Depends(get_db)],
) -> list[PortTargetOut]:
    rows = db.scalars(select(DevicePortTarget)).all()
    existing_ids = {row.id for row in rows}
    if len(payload.target_ids) != len(set(payload.target_ids)) or set(payload.target_ids) != existing_ids:
        raise HTTPException(status_code=400, detail="Order must contain every service check exactly once")
    by_id = {row.id: row for row in rows}
    for index, target_id in enumerate(payload.target_ids, start=1):
        by_id[target_id].sort_order = index
    setting = db.get(SystemSetting, SERVICE_CHECK_ORDER_MODE_KEY)
    if setting is None:
        db.add(SystemSetting(key=SERVICE_CHECK_ORDER_MODE_KEY, value="manual"))
    else:
        setting.value = "manual"
        setting.updated_at = datetime.now(timezone.utc)
    db.commit()
    return [by_id[target_id] for target_id in payload.target_ids]


@router.put("/service-checks/{target_id}", response_model=PortTargetOut)
@router.put("/port-targets/{target_id}", response_model=PortTargetOut)
def update_port_target(
    target_id: int,
    payload: PortTargetCreate,
    current_user: Annotated[User, Depends(require_monitoring_write)],
    db: Annotated[Session, Depends(get_db)],
) -> PortTargetOut:
    target = db.get(DevicePortTarget, target_id)
    if target is None:
        raise HTTPException(status_code=404, detail="Port target not found")
    if payload.device_id is not None and db.get(Device, payload.device_id) is None:
        raise HTTPException(status_code=404, detail="Device not found")
    is_http = payload.check_type in ("http", "https")
    target.device_id = payload.device_id
    target.port = payload.port
    target.label = payload.label
    target.check_type = payload.check_type
    target.http_path = payload.http_path if is_http else None
    target.http_method = payload.http_method if is_http else "GET"
    target.expected_status_min = payload.expected_status_min
    target.expected_status_max = payload.expected_status_max
    target.timeout_seconds = payload.timeout_seconds if is_http else None
    target.verify_tls = payload.verify_tls if is_http else False
    target.follow_redirects = payload.follow_redirects if is_http else True
    target.enabled = payload.enabled
    if _service_check_order_mode(db) == "alphabetical":
        _reindex_service_checks(db, "alphabetical")
    db.commit()
    db.refresh(target)
    return target


@router.delete("/service-checks/{target_id}", status_code=204, response_model=None)
@router.delete("/port-targets/{target_id}", status_code=204, response_model=None)
def delete_port_target(
    target_id: int,
    current_user: Annotated[User, Depends(require_monitoring_write)],
    db: Annotated[Session, Depends(get_db)],
) -> None:
    target = db.get(DevicePortTarget, target_id)
    if not target:
        raise HTTPException(status_code=404, detail="Port target not found")
    db.delete(target)
    db.commit()
