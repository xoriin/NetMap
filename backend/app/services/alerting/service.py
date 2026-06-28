from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor, as_completed
import json
import logging
import socket
import threading
import time
from datetime import datetime, timezone

from sqlalchemy import select

from app.db.session import SessionLocal
from app.models.alert_event import AlertEvent
from app.models.alert_rule import AlertRule
from app.models.device import Device
from app.models.monitor_history import DeviceMonitorHistory
from app.models.port_target import DevicePortTarget
from app.models.system_setting import SystemSetting
from app.schemas.tools import PingRequest
from app.services.monitoring.port_checker import check_port
from app.services.notifications import (
    list_notification_profiles,
    load_notification_settings,
    send_notification_target,
)
from app.services.tools.service import ping_host

logger = logging.getLogger(__name__)

DEFAULT_INTERVAL_SECONDS = 300
HISTORY_RETAIN_DAYS = 30
LIVE_STATUS_FALLBACK_PORTS = (80, 443, 22, 8080, 53, 8443)
LIVE_STATUS_FALLBACK_TIMEOUT_SECONDS = 0.5
MONITOR_STATUS_WORKERS = 12


class AlertMonitorService:
    def __init__(self) -> None:
        self._thread: threading.Thread | None = None
        self._stop = threading.Event()
        self._known: dict[int, str] = {}
        self._initialized = False
        self._last_pruned_at: datetime | None = None

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, name="alert-monitor", daemon=True)
        self._thread.start()
        logger.info("Alert monitor started")

    def stop(self) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=10)

    def _get_interval(self) -> int:
        try:
            with SessionLocal() as db:
                row = db.scalar(select(SystemSetting).where(SystemSetting.key == "monitor_interval_seconds"))
                if row:
                    return min(3600, max(30, int(row.value)))
        except Exception:
            pass
        return DEFAULT_INTERVAL_SECONDS

    def _live_ping_enabled(self) -> bool:
        try:
            with SessionLocal() as db:
                row = db.scalar(select(SystemSetting).where(SystemSetting.key == "live_ping_enabled"))
                if row:
                    return str(row.value).lower() not in ("false", "0", "")
        except Exception:
            pass
        return True

    def _run(self) -> None:
        if self._stop.wait(5):
            return
        while True:
            try:
                if self._live_ping_enabled():
                    self._check()
            except Exception:
                logger.exception("Alert monitor check failed")
            interval = self._get_interval()
            if self._stop.wait(interval):
                break

    def _check(self) -> None:
        with SessionLocal() as db:
            devices = db.scalars(select(Device).where(Device.status != "disabled")).all()
            rules = db.scalars(select(AlertRule).where(AlertRule.enabled == True)).all()  # noqa: E712
            port_targets = db.scalars(select(DevicePortTarget).where(DevicePortTarget.enabled == True)).all()  # noqa: E712
            notif_settings = load_notification_settings(db)
            profiles = {
                int(profile["id"]): profile
                for profile in list_notification_profiles(db, redacted=False)
            }
            app_name = self._get_app_name(db)

        if not devices:
            self._initialized = True
            return

        # Build per-device port list (global targets + device-specific)
        global_ports = [pt for pt in port_targets if pt.device_id is None]
        device_extra_ports: dict[int, list[DevicePortTarget]] = {}
        for pt in port_targets:
            if pt.device_id is not None:
                device_extra_ports.setdefault(pt.device_id, []).append(pt)

        checked_at = datetime.now(timezone.utc)
        current: dict[int, str] = {}
        rtt_map: dict[int, float | None] = {}
        port_map: dict[int, list[dict]] = {}

        workers = max(1, min(MONITOR_STATUS_WORKERS, len(devices)))
        with ThreadPoolExecutor(max_workers=workers) as executor:
            future_map = {executor.submit(self._probe_device_status, device): device.id for device in devices}
            for future in as_completed(future_map):
                device_id = future_map[future]
                try:
                    status, rtt_ms = future.result()
                except Exception:
                    logger.exception("Probe thread raised for device %d", device_id)
                    status, rtt_ms = "unknown", None
                current[device_id] = status
                rtt_map[device_id] = rtt_ms

        port_tasks: list[tuple[str, int, object]] = [
            (device.ip_address, device.id, target)
            for device in devices
            for target in (global_ports + device_extra_ports.get(device.id, []))
        ]
        if port_tasks:
            port_workers = max(1, min(MONITOR_STATUS_WORKERS, len(port_tasks)))
            port_future_map: dict = {}
            with ThreadPoolExecutor(max_workers=port_workers) as port_ex:
                for ip, device_id, target in port_tasks:
                    f = port_ex.submit(check_port, ip, target.port, 2.0, protocol=target.check_type)
                    port_future_map[f] = (device_id, target)
                for future in as_completed(port_future_map):
                    device_id, target = port_future_map[future]
                    try:
                        open_ = future.result()
                    except Exception:
                        open_ = False
                    port_map.setdefault(device_id, []).append({
                        "target_id": target.id,
                        "port": target.port,
                        "label": target.label,
                        "check_type": target.check_type,
                        "open": open_,
                        "status": "open" if open_ else "closed",
                    })

        # Persist history and update device monitor_status
        with SessionLocal() as db:
            history_rows = []
            device_updates = []
            for device in devices:
                status = current.get(device.id, "unknown")
                history_rows.append({
                    "device_id": device.id,
                    "checked_at": checked_at,
                    "status": status,
                    "rtt_ms": rtt_map.get(device.id),
                    "port_results": json.dumps(port_map.get(device.id, [])),
                })
                device_updates.append({
                    "id": device.id,
                    "monitor_status": status,
                    "last_monitored_at": checked_at,
                })
            if history_rows:
                db.bulk_insert_mappings(DeviceMonitorHistory, history_rows)
            if device_updates:
                db.bulk_update_mappings(Device, device_updates)
            db.commit()

        self._prune_history()

        if not self._initialized:
            self._known = current
            self._initialized = True
            logger.debug("Alert monitor: initial state learned for %d devices", len(current))
            return

        if not rules:
            self._known = current
            return

        device_map = {d.id: d for d in devices}
        now = checked_at

        rule_updates: list[tuple[int, datetime]] = []
        new_events: list[AlertEvent] = []

        for device_id, new_status in current.items():
            old_status = self._known.get(device_id, "unknown")
            if new_status == old_status:
                continue

            device = device_map[device_id]
            label = device.display_name or device.hostname or device.ip_address

            for rule in rules:
                if rule.device_id is not None and rule.device_id != device_id:
                    continue
                if not self._event_matches(rule.event_type, old_status, new_status):
                    continue
                if not self._cooldown_ok(rule, now):
                    continue

                channels = json.loads(rule.channels) if isinstance(rule.channels, str) else rule.channels
                message = self._build_message(rule.event_type, label, device.ip_address, new_status, app_name)

                for channel in channels:
                    result = send_notification_target(channel, message, notif_settings, profiles)
                    logger.info("Alert '%s' fired via %s: %s", rule.name, channel, result)

                rule_updates.append((rule.id, now))
                new_events.append(AlertEvent(
                    alert_rule_id=rule.id,
                    alert_rule_name=rule.name,
                    device_id=device_id,
                    event_type=rule.event_type,
                    fired_at=now,
                    message=message,
                ))

        if rule_updates or new_events:
            with SessionLocal() as db:
                for rule_id, triggered_at in rule_updates:
                    db_rule = db.get(AlertRule, rule_id)
                    if db_rule:
                        db_rule.last_triggered_at = triggered_at
                for event in new_events:
                    db.add(event)
                db.commit()

        self._known = current

    def _probe_device_status(self, device: Device) -> tuple[str, float | None]:
        try:
            result = ping_host(PingRequest(host=device.ip_address, count=3, timeout_seconds=3), allow_public_targets=True)
            if (result.received or 0) > 0:
                return "online", result.average_ms
            logger.debug(
                "ICMP probe got 0 replies for %s (transmitted=%s, output=%r) — trying TCP fallback",
                device.ip_address, result.transmitted,
                (result.raw_output or "")[:200],
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("ICMP probe failed for %s: %s — trying TCP fallback", device.ip_address, exc)

        for port in LIVE_STATUS_FALLBACK_PORTS:
            try:
                started = time.perf_counter()
                with socket.create_connection(
                    (device.ip_address, port),
                    timeout=LIVE_STATUS_FALLBACK_TIMEOUT_SECONDS,
                ):
                    return "online", round((time.perf_counter() - started) * 1000, 2)
            except OSError:
                continue

        logger.debug("All probes failed for %s — marking offline", device.ip_address)
        return "offline", None

    def _prune_history(self) -> None:
        now = datetime.now(timezone.utc)
        if self._last_pruned_at is not None and (now - self._last_pruned_at).total_seconds() < 86400:
            return
        try:
            from sqlalchemy import text
            from datetime import timedelta
            cutoff = now.replace(hour=0, minute=0, second=0, microsecond=0) - timedelta(days=HISTORY_RETAIN_DAYS)
            with SessionLocal() as db:
                db.execute(
                    text("DELETE FROM device_monitor_history WHERE checked_at < :cutoff"),
                    {"cutoff": cutoff.isoformat()},
                )
                db.commit()
            self._last_pruned_at = now
        except Exception:
            logger.exception("Failed to prune monitor history")

    @staticmethod
    def _event_matches(event_type: str, old_status: str, new_status: str) -> bool:
        if event_type == "any_status_change":
            return True
        if event_type == "device_offline":
            return new_status == "offline" and old_status != "offline"
        if event_type == "device_online":
            return new_status == "online" and old_status != "online"
        if event_type == "device_warning":
            return new_status == "warning"
        return False

    @staticmethod
    def _cooldown_ok(rule: AlertRule, now: datetime) -> bool:
        if rule.last_triggered_at is None:
            return True
        elapsed = (now - rule.last_triggered_at).total_seconds() / 60
        return elapsed >= rule.cooldown_minutes

    @staticmethod
    def _build_message(event_type: str, label: str, ip: str, status: str, app_name: str) -> str:
        descriptions = {
            "device_offline": f"⚠️ {label} ({ip}) is now OFFLINE",
            "device_online": f"✅ {label} ({ip}) is back ONLINE",
            "device_warning": f"⚠️ {label} ({ip}) has a WARNING status",
            "any_status_change": f"ℹ️ {label} ({ip}) status changed to {status.upper()}",
        }
        body = descriptions.get(event_type, f"{label} ({ip}) status: {status}")
        return f"{app_name} Alert\n\n{body}"

    @staticmethod
    def _get_app_name(db) -> str:  # type: ignore[no-untyped-def]
        try:
            from app.models.system_setting import SystemSetting
            row = db.scalar(select(SystemSetting).where(SystemSetting.key == "app_name"))
            return row.value if row else "NetMap"
        except Exception:
            return "NetMap"


alert_monitor = AlertMonitorService()
