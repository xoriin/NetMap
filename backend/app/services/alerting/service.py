from __future__ import annotations

import json
import logging
import threading
from datetime import datetime, timezone

from sqlalchemy import select

from app.db.session import SessionLocal
from app.models.alert_event import AlertEvent
from app.models.alert_rule import AlertRule
from app.models.device import Device
from app.models.monitor_history import DeviceMonitorHistory
from app.models.port_target import DevicePortTarget
from app.schemas.tools import PingRequest
from app.services.monitoring.port_checker import check_port
from app.services.notifications import load_notification_settings, send_notification
from app.services.tools.service import ping_host

logger = logging.getLogger(__name__)

DEFAULT_INTERVAL_SECONDS = 300
HISTORY_RETAIN_DAYS = 30


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
            from app.models.system_setting import SystemSetting
            with SessionLocal() as db:
                row = db.scalar(select(SystemSetting).where(SystemSetting.key == "monitor_interval_seconds"))
                if row:
                    return max(30, int(row.value))
        except Exception:
            pass
        return DEFAULT_INTERVAL_SECONDS

    def _run(self) -> None:
        if self._stop.wait(30):
            return
        while True:
            try:
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
            notif_settings = load_notification_settings(db)
            app_name = self._get_app_name(db)
            port_targets = db.scalars(select(DevicePortTarget)).all()

        if not devices:
            self._initialized = True
            return

        # Build per-device port list (global targets + device-specific)
        global_ports = [(pt.port, pt.label) for pt in port_targets if pt.device_id is None]
        device_extra_ports: dict[int, list[tuple[int, str]]] = {}
        for pt in port_targets:
            if pt.device_id is not None:
                device_extra_ports.setdefault(pt.device_id, []).append((pt.port, pt.label))

        checked_at = datetime.now(timezone.utc)
        current: dict[int, str] = {}
        rtt_map: dict[int, float | None] = {}
        port_map: dict[int, list[dict]] = {}

        for device in devices:
            try:
                result = ping_host(PingRequest(host=device.ip_address, count=2, timeout_seconds=2))
                if result.received > 0:
                    current[device.id] = "online"
                    rtt_map[device.id] = result.average_ms
                else:
                    current[device.id] = "offline"
                    rtt_map[device.id] = None
            except Exception:
                current[device.id] = "unknown"
                rtt_map[device.id] = None

            # Port checks
            ports_to_check = global_ports + device_extra_ports.get(device.id, [])
            port_results = []
            for port, label in ports_to_check:
                open_ = check_port(device.ip_address, port)
                port_results.append({"port": port, "label": label, "open": open_})
            port_map[device.id] = port_results

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
                    result = send_notification(channel, message, notif_settings)
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
