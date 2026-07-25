from __future__ import annotations

import json
import logging
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone

from sqlalchemy import select

from app.db.retention import delete_rows_before
from app.db.session import SessionLocal
from app.models.alert_event import AlertEvent
from app.models.alert_rule import AlertRule
from app.models.monitor import Monitor, MonitorCheckHistory
from app.models.notification_delivery import NotificationDelivery
from app.services.monitoring.port_checker import check_url
from app.services.notifications import (
    list_notification_profiles,
    load_notification_settings,
    send_notification_target,
)

logger = logging.getLogger(__name__)

TICK_SECONDS = 5
HISTORY_RETAIN_DAYS = 30
MAX_CHECK_WORKERS = 8


class StandaloneMonitorService:
    def __init__(self) -> None:
        self._thread: threading.Thread | None = None
        self._stop = threading.Event()
        self._last_pruned_at: datetime | None = None

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, name="standalone-monitors", daemon=True)
        self._thread.start()
        logger.info("Standalone monitor service started")

    def stop(self) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=10)

    def _run(self) -> None:
        if self._stop.wait(5):
            return
        while True:
            try:
                self._tick()
            except Exception:
                logger.exception("Standalone monitor tick failed")
            if self._stop.wait(TICK_SECONDS):
                break

    def _tick(self) -> None:
        now = datetime.now(timezone.utc)

        # Phase 1 — read what the checks need, then release the connection.
        # HTTP probes and notification sends must never run while a pooled
        # connection is checked out: a stalled target would otherwise pin it
        # (and any transaction on it) for the whole timeout, starving request
        # handlers and other writers.
        with SessionLocal() as db:
            monitors = db.scalars(select(Monitor).where(Monitor.enabled == True)).all()  # noqa: E712
            due = [
                m for m in monitors
                if m.last_checked_at is None
                or (now - self._as_aware(m.last_checked_at)).total_seconds() >= m.check_interval_seconds
            ]
            if not due:
                self._prune_history()
                return

            rules = db.scalars(select(AlertRule).where(
                AlertRule.enabled == True,  # noqa: E712
                AlertRule.event_type.in_(("monitor_down", "monitor_slow")),
            )).all()
            notif_settings = load_notification_settings(db)
            profiles = {
                int(profile["id"]): profile
                for profile in list_notification_profiles(db, redacted=False)
            }
            app_name = self._get_app_name(db)

        # Phase 2 — probe and notify with no session open. `due` and `rules` are
        # detached but still fully loaded, so reading their attributes is safe.
        results: dict[int, object] = {}
        workers = max(1, min(MAX_CHECK_WORKERS, len(due)))
        with ThreadPoolExecutor(max_workers=workers) as executor:
            future_map = {
                executor.submit(
                    check_url, m.url, m.timeout_seconds,
                    method=m.http_method, expected_status_min=m.expected_status_min,
                    expected_status_max=m.expected_status_max, verify_tls=m.verify_tls,
                    follow_redirects=m.follow_redirects,
                ): m.id
                for m in due
            }
            for future in as_completed(future_map):
                monitor_id = future_map[future]
                try:
                    results[monitor_id] = future.result()
                except Exception:
                    logger.exception("Standalone monitor check raised for monitor %d", monitor_id)

        history_rows = []
        # monitor id -> (consecutive_failures, last_status) to persist in phase 3
        monitor_states: dict[int, tuple[int, str | None]] = {}
        new_events: list[AlertEvent] = []
        new_deliveries: list[NotificationDelivery] = []
        rule_updates: list[tuple[int, datetime]] = []

        def fire(rule: AlertRule, monitor: Monitor, message: str) -> None:
            channels = json.loads(rule.channels) if isinstance(rule.channels, str) else rule.channels
            for channel in channels:
                result = send_notification_target(channel, message, notif_settings, profiles)
                new_deliveries.append(NotificationDelivery(
                    rule_name=rule.name,
                    device_id=None,
                    target=channel,
                    status="sent" if result == "ok" else "failed",
                    detail="" if result == "ok" else str(result)[:255],
                    sent_at=now,
                ))
            rule_updates.append((rule.id, now))
            new_events.append(AlertEvent(
                alert_rule_id=rule.id,
                alert_rule_name=rule.name,
                device_id=None,
                event_type=rule.event_type,
                fired_at=now,
                message=message,
            ))

        for monitor in due:
            result = results.get(monitor.id)
            if result is None:
                continue
            was_status = monitor.last_status
            raw_status = "online" if result.open else "offline"
            failures = monitor.consecutive_failures
            new_status = was_status
            if result.open:
                failures = 0
                new_status = "online"
            else:
                failures += 1
                if failures > monitor.max_retries:
                    new_status = "offline"
            monitor_states[monitor.id] = (failures, new_status)

            history_rows.append({
                "monitor_id": monitor.id,
                "checked_at": now,
                "status": raw_status,
                "response_time_ms": round(result.response_time_ms, 2) if result.response_time_ms is not None else None,
                "status_code": result.status_code,
                "error": None if result.open else "Check failed (timeout, connection error, or unexpected status)",
            })

            if was_status != "offline" and new_status == "offline":
                for rule in rules:
                    if rule.event_type != "monitor_down":
                        continue
                    if rule.monitor_id is not None and rule.monitor_id != monitor.id:
                        continue
                    if not self._cooldown_ok(rule, now):
                        continue
                    fire(rule, monitor, self._build_message(
                        "monitor_down", monitor.name, monitor.url, "offline", app_name,
                    ))

            if result.open and result.response_time_ms is not None:
                for rule in rules:
                    if rule.event_type != "monitor_slow" or rule.threshold_ms is None:
                        continue
                    if rule.monitor_id is not None and rule.monitor_id != monitor.id:
                        continue
                    if result.response_time_ms <= rule.threshold_ms:
                        continue
                    if not self._cooldown_ok(rule, now):
                        continue
                    fire(rule, monitor, self._build_message(
                        "monitor_slow", monitor.name, monitor.url, "online", app_name,
                        response_time_ms=result.response_time_ms, threshold_ms=rule.threshold_ms,
                    ))

        # Phase 3 — one short write transaction for everything the tick produced.
        with SessionLocal() as db:
            live_ids: set[int] = set()
            for monitor_id, (failures, last_status) in monitor_states.items():
                row = db.get(Monitor, monitor_id)
                if row is None:  # deleted while the checks were running
                    continue
                live_ids.add(monitor_id)
                row.consecutive_failures = failures
                row.last_status = last_status
                row.last_checked_at = now
            history_rows = [row for row in history_rows if row["monitor_id"] in live_ids]
            if history_rows:
                db.bulk_insert_mappings(MonitorCheckHistory, history_rows)
            for rule_id, triggered_at in rule_updates:
                db_rule = db.get(AlertRule, rule_id)
                if db_rule:
                    db_rule.last_triggered_at = triggered_at
            for event in new_events:
                db.add(event)
            for delivery in new_deliveries:
                db.add(delivery)
            db.commit()

        self._prune_history()

    def _prune_history(self) -> None:
        now = datetime.now(timezone.utc)
        if self._last_pruned_at is not None and (now - self._last_pruned_at).total_seconds() < 86400:
            return
        try:
            cutoff = now.replace(hour=0, minute=0, second=0, microsecond=0) - timedelta(days=HISTORY_RETAIN_DAYS)
            delete_rows_before("monitor_check_history", "checked_at", cutoff)
            self._last_pruned_at = now
        except Exception:
            logger.exception("Failed to prune monitor check history")

    @staticmethod
    def _build_message(
        event_type: str,
        name: str,
        url: str,
        status: str,
        app_name: str,
        response_time_ms: float | None = None,
        threshold_ms: int | None = None,
    ) -> str:
        if event_type == "monitor_down":
            body = f"🔻 Monitor \"{name}\" ({url}) is DOWN"
            return f"{app_name} Alert\n\n{body}"
        if event_type == "monitor_slow":
            rtt_text = f"{response_time_ms:.0f}" if response_time_ms is not None else "?"
            body = f"🐢 Monitor \"{name}\" ({url}) response time {rtt_text} ms is above the {threshold_ms} ms threshold"
            return f"{app_name} Alert\n\n{body}"
        return f"{app_name} Alert\n\n{name} ({url}) status: {status}"

    @staticmethod
    def _as_aware(dt: datetime) -> datetime:
        # SQLite round-trips DateTime(timezone=True) columns as naive — every
        # datetime this app stores is UTC, so a naive value is safely UTC too.
        return dt if dt.tzinfo is not None else dt.replace(tzinfo=timezone.utc)

    @classmethod
    def _cooldown_ok(cls, rule: AlertRule, now: datetime) -> bool:
        if rule.last_triggered_at is None:
            return True
        elapsed = (now - cls._as_aware(rule.last_triggered_at)).total_seconds() / 60
        return elapsed >= rule.cooldown_minutes

    @staticmethod
    def _get_app_name(db) -> str:  # type: ignore[no-untyped-def]
        try:
            from app.models.system_setting import SystemSetting
            row = db.scalar(select(SystemSetting).where(SystemSetting.key == "app_name"))
            return row.value if row else "NetMap"
        except Exception:
            return "NetMap"


standalone_monitor_service = StandaloneMonitorService()
