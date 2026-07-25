from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor, as_completed
import json
import logging
import socket
import threading
import time
from datetime import datetime, timedelta, timezone

from sqlalchemy import case, func, select

from app.db.retention import delete_rows_before
from app.db.session import SessionLocal
from app.models.alert_event import AlertEvent
from app.models.alert_rule import AlertRule
from app.models.device import Device
from app.models.monitor_history import DeviceMonitorHistory
from app.models.notification_delivery import NotificationDelivery
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
HTTP_CHECK_TIMEOUT_SECONDS = 5.0
FLAP_WINDOW_SECONDS = 3600
FLAP_MIN_TRANSITIONS = 4
DEFAULT_LOSS_WINDOW_MINUTES = 60
MIN_LOSS_SAMPLE_SIZE = 3


class AlertMonitorService:
    def __init__(self) -> None:
        self._thread: threading.Thread | None = None
        self._stop = threading.Event()
        self._known: dict[int, str] = {}
        # (device_id, port_target_id) -> was it open on the previous poll
        self._known_ports: dict[tuple[int, int], bool] = {}
        self._flap_times: dict[int, list[datetime]] = {}
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
            devices = db.scalars(select(Device).where(
                Device.status != "disabled",
                Device.monitoring_paused == False,  # noqa: E712
                Device.lifecycle == "active",
            )).all()
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

        current_ports: dict[tuple[int, int], dict] = {}  # (device_id, target_id) -> latest result

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
                    is_http = target.check_type in ("http", "https")
                    timeout = target.timeout_seconds if (is_http and target.timeout_seconds) else (HTTP_CHECK_TIMEOUT_SECONDS if is_http else 2.0)
                    f = port_ex.submit(
                        check_port, ip, target.port, timeout,
                        protocol=target.check_type, http_path=target.http_path,
                        http_method=target.http_method,
                        expected_status_min=target.expected_status_min,
                        expected_status_max=target.expected_status_max,
                        verify_tls=target.verify_tls,
                        follow_redirects=target.follow_redirects,
                    )
                    port_future_map[f] = (device_id, target)
                for future in as_completed(port_future_map):
                    device_id, target = port_future_map[future]
                    try:
                        result = future.result()
                        open_, response_ms, status_code = result.open, result.response_time_ms, result.status_code
                    except Exception:
                        open_, response_ms, status_code = False, None, None
                    entry = {
                        "target_id": target.id,
                        "port": target.port,
                        "label": target.label,
                        "check_type": target.check_type,
                        "open": open_,
                        "status": "open" if open_ else "closed",
                        "response_time_ms": round(response_ms, 2) if response_ms is not None else None,
                        "status_code": status_code,
                    }
                    port_map.setdefault(device_id, []).append(entry)
                    current_ports[(device_id, target.id)] = entry

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

        known_ports_now = {key: entry["open"] for key, entry in current_ports.items()}

        if not self._initialized:
            self._known = current
            self._known_ports = known_ports_now
            self._initialized = True
            logger.debug("Alert monitor: initial state learned for %d devices", len(current))
            return

        if not rules:
            self._known = current
            self._known_ports = known_ports_now
            return

        device_map = {d.id: d for d in devices}
        now = checked_at

        rule_updates: list[tuple[int, datetime]] = []
        new_events: list[AlertEvent] = []
        new_deliveries: list[NotificationDelivery] = []

        def fire(rule: AlertRule, device_id: int, message: str) -> None:
            channels = json.loads(rule.channels) if isinstance(rule.channels, str) else rule.channels
            for channel in channels:
                result = send_notification_target(channel, message, notif_settings, profiles)
                logger.info("Alert '%s' fired via %s: %s", rule.name, channel, result)
                new_deliveries.append(NotificationDelivery(
                    rule_name=rule.name,
                    device_id=device_id,
                    target=channel,
                    status="sent" if result == "ok" else "failed",
                    detail="" if result == "ok" else str(result)[:255],
                    sent_at=now,
                ))
            rule_updates.append((rule.id, now))
            new_events.append(AlertEvent(
                alert_rule_id=rule.id,
                alert_rule_name=rule.name,
                device_id=device_id,
                event_type=rule.event_type,
                fired_at=now,
                message=message,
            ))

        for device_id, new_status in current.items():
            old_status = self._known.get(device_id, "unknown")
            if new_status == old_status:
                continue

            self._flap_times.setdefault(device_id, []).append(now)

            device = device_map[device_id]
            label = device.display_name or device.hostname or device.ip_address

            for rule in rules:
                if rule.device_id is not None and rule.device_id != device_id:
                    continue
                if not self._event_matches(rule.event_type, old_status, new_status):
                    continue
                if not self._cooldown_ok(rule, now):
                    continue
                fire(rule, device_id, self._build_message(rule.event_type, label, device.ip_address, new_status, app_name))

        for rule, device_id, rtt in self._rtt_breaches(rules, rtt_map, now):
            device = device_map[device_id]
            label = device.display_name or device.hostname or device.ip_address
            fire(rule, device_id, self._build_message(
                "rtt_above", label, device.ip_address, "online", app_name,
                rtt_ms=rtt, threshold_ms=rule.threshold_ms,
            ))

        for rule, device_id, loss_pct in self._ping_loss_breaches(rules, set(device_map), now):
            device = device_map[device_id]
            label = device.display_name or device.hostname or device.ip_address
            fire(rule, device_id, self._build_message(
                "ping_loss_above", label, device.ip_address, "online", app_name,
                loss_pct=loss_pct, loss_pct_threshold=rule.loss_pct_threshold,
            ))

        # Service checks (port/service targets): edge-triggered down, threshold-based slow response
        for rule, device_id, service_label in self._service_down_breaches(rules, self._known_ports, current_ports, now):
            device = device_map.get(device_id)
            if device is None:
                continue
            label = device.display_name or device.hostname or device.ip_address
            fire(rule, device_id, self._build_message(
                "service_down", label, device.ip_address, "offline", app_name,
                service_label=service_label,
            ))

        for rule, device_id, response_ms, service_label in self._service_slow_breaches(rules, current_ports, now):
            device = device_map.get(device_id)
            if device is None:
                continue
            label = device.display_name or device.hostname or device.ip_address
            fire(rule, device_id, self._build_message(
                "service_slow", label, device.ip_address, "online", app_name,
                rtt_ms=response_ms, threshold_ms=rule.threshold_ms, service_label=service_label,
            ))

        # Flapping: devices with too many status transitions inside the window
        cutoff = now - timedelta(seconds=FLAP_WINDOW_SECONDS)
        self._flap_times = {
            device_id: kept
            for device_id, times in self._flap_times.items()
            if (kept := [t for t in times if t >= cutoff]) and device_id in device_map
        }
        flap_counts = {
            device_id: len(times)
            for device_id, times in self._flap_times.items()
            if len(times) >= FLAP_MIN_TRANSITIONS
        }
        for rule in rules:
            if rule.event_type != "device_flapping":
                continue
            if not self._cooldown_ok(rule, now):
                continue
            for device_id, flap_count in flap_counts.items():
                if rule.device_id is not None and rule.device_id != device_id:
                    continue
                device = device_map[device_id]
                label = device.display_name or device.hostname or device.ip_address
                fire(rule, device_id, self._build_message(
                    "device_flapping", label, device.ip_address, current.get(device_id, "unknown"),
                    app_name, flap_count=flap_count,
                ))

        if rule_updates or new_events or new_deliveries:
            with SessionLocal() as db:
                for rule_id, triggered_at in rule_updates:
                    db_rule = db.get(AlertRule, rule_id)
                    if db_rule:
                        db_rule.last_triggered_at = triggered_at
                for event in new_events:
                    db.add(event)
                for delivery in new_deliveries:
                    db.add(delivery)
                db.commit()

        self._known = current
        self._known_ports = known_ports_now

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
            cutoff = now.replace(hour=0, minute=0, second=0, microsecond=0) - timedelta(days=HISTORY_RETAIN_DAYS)
            delete_rows_before("device_monitor_history", "checked_at", cutoff)
            delete_rows_before("notification_deliveries", "sent_at", cutoff)
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

    @classmethod
    def _rtt_breaches(
        cls,
        rules: list[AlertRule],
        rtt_map: dict[int, float | None],
        now: datetime,
    ) -> list[tuple[AlertRule, int, float]]:
        """Return (rule, device_id, rtt_ms) for every rtt_above rule breach this cycle."""
        breaches: list[tuple[AlertRule, int, float]] = []
        for rule in rules:
            if rule.event_type != "rtt_above" or rule.threshold_ms is None:
                continue
            if not cls._cooldown_ok(rule, now):
                continue
            for device_id, rtt in rtt_map.items():
                if rule.device_id is not None and rule.device_id != device_id:
                    continue
                if rtt is None or rtt <= rule.threshold_ms:
                    continue
                breaches.append((rule, device_id, rtt))
        return breaches

    @classmethod
    def _ping_loss_breaches(
        cls,
        rules: list[AlertRule],
        device_ids: set[int],
        now: datetime,
    ) -> list[tuple[AlertRule, int, float]]:
        """Return (rule, device_id, loss_pct) for every ping_loss_above rule breach this cycle."""
        loss_rules = [r for r in rules if r.event_type == "ping_loss_above" and r.loss_pct_threshold is not None]
        if not loss_rules:
            return []

        breaches: list[tuple[AlertRule, int, float]] = []
        with SessionLocal() as db:
            for rule in loss_rules:
                if not cls._cooldown_ok(rule, now):
                    continue
                window_minutes = rule.loss_window_minutes or DEFAULT_LOSS_WINDOW_MINUTES
                cutoff = now - timedelta(minutes=window_minutes)
                query = select(
                    DeviceMonitorHistory.device_id,
                    func.count(DeviceMonitorHistory.id),
                    func.sum(case((DeviceMonitorHistory.status == "offline", 1), else_=0)),
                ).where(DeviceMonitorHistory.checked_at >= cutoff)
                if rule.device_id is not None:
                    query = query.where(DeviceMonitorHistory.device_id == rule.device_id)
                query = query.group_by(DeviceMonitorHistory.device_id)
                for device_id, total, offline_count in db.execute(query).all():
                    if device_id not in device_ids or total < MIN_LOSS_SAMPLE_SIZE:
                        continue
                    loss_pct = (offline_count or 0) / total * 100
                    if loss_pct >= rule.loss_pct_threshold:
                        breaches.append((rule, device_id, loss_pct))
        return breaches

    @classmethod
    def _service_down_breaches(
        cls,
        rules: list[AlertRule],
        known_ports: dict[tuple[int, int], bool],
        current_ports: dict[tuple[int, int], dict],
        now: datetime,
    ) -> list[tuple[AlertRule, int, str]]:
        """Return (rule, device_id, service_label) for every up->down service transition this cycle."""
        down_rules = [r for r in rules if r.event_type == "service_down"]
        if not down_rules:
            return []
        breaches: list[tuple[AlertRule, int, str]] = []
        for (device_id, target_id), entry in current_ports.items():
            was_open = known_ports.get((device_id, target_id))
            # was_open is None the first time this target is seen — nothing to compare yet
            if was_open is None or was_open is False or entry["open"]:
                continue
            for rule in down_rules:
                if rule.port_target_id is not None and rule.port_target_id != target_id:
                    continue
                if not cls._cooldown_ok(rule, now):
                    continue
                breaches.append((rule, device_id, entry["label"]))
        return breaches

    @classmethod
    def _service_slow_breaches(
        cls,
        rules: list[AlertRule],
        current_ports: dict[tuple[int, int], dict],
        now: datetime,
    ) -> list[tuple[AlertRule, int, float, str]]:
        """Return (rule, device_id, response_time_ms, service_label) for every service_slow breach this cycle."""
        slow_rules = [r for r in rules if r.event_type == "service_slow" and r.threshold_ms is not None]
        if not slow_rules:
            return []
        breaches: list[tuple[AlertRule, int, float, str]] = []
        for rule in slow_rules:
            if not cls._cooldown_ok(rule, now):
                continue
            for (device_id, target_id), entry in current_ports.items():
                if rule.port_target_id is not None and rule.port_target_id != target_id:
                    continue
                response_ms = entry.get("response_time_ms")
                if response_ms is None or response_ms <= rule.threshold_ms:
                    continue
                breaches.append((rule, device_id, response_ms, entry["label"]))
        return breaches

    @staticmethod
    def _cooldown_ok(rule: AlertRule, now: datetime) -> bool:
        if rule.last_triggered_at is None:
            return True
        elapsed = (now - rule.last_triggered_at).total_seconds() / 60
        return elapsed >= rule.cooldown_minutes

    @staticmethod
    def _build_message(
        event_type: str,
        label: str,
        ip: str,
        status: str,
        app_name: str,
        rtt_ms: float | None = None,
        threshold_ms: int | None = None,
        flap_count: int | None = None,
        loss_pct: float | None = None,
        loss_pct_threshold: float | None = None,
        service_label: str | None = None,
    ) -> str:
        if event_type == "rtt_above":
            rtt_text = f"{rtt_ms:.0f}" if rtt_ms is not None else "?"
            body = f"🐢 {label} ({ip}) RTT {rtt_text} ms is above the {threshold_ms} ms threshold"
            return f"{app_name} Alert\n\n{body}"
        if event_type == "ping_loss_above":
            loss_text = f"{loss_pct:.0f}" if loss_pct is not None else "?"
            threshold_text = f"{loss_pct_threshold:.0f}" if loss_pct_threshold is not None else "?"
            body = f"📶 {label} ({ip}) ping loss {loss_text}% is above the {threshold_text}% threshold"
            return f"{app_name} Alert\n\n{body}"
        if event_type == "service_down":
            service_text = service_label or "Service check"
            body = f"🔻 {service_text} on {label} ({ip}) is DOWN"
            return f"{app_name} Alert\n\n{body}"
        if event_type == "service_slow":
            service_text = service_label or "Service check"
            rtt_text = f"{rtt_ms:.0f}" if rtt_ms is not None else "?"
            body = f"🐢 {service_text} on {label} ({ip}) response time {rtt_text} ms is above the {threshold_ms} ms threshold"
            return f"{app_name} Alert\n\n{body}"
        if event_type == "device_flapping":
            count_text = str(flap_count) if flap_count is not None else "repeated"
            body = f"🔁 {label} ({ip}) is flapping — {count_text} status changes in the last hour"
            return f"{app_name} Alert\n\n{body}"
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
