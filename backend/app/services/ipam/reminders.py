from __future__ import annotations

import logging
import threading
from datetime import datetime, timedelta, timezone

from sqlalchemy import select

from app.db.session import SessionLocal
from app.models.ip_reservation import IpReservation
from app.services.notifications import (
    list_notification_profiles,
    load_notification_settings,
    send_notification_target,
)

logger = logging.getLogger(__name__)

CHECK_INTERVAL_SECONDS = 6 * 3600
DEFAULT_REMINDER_DAYS = 3


class IpReservationReminderService:
    def __init__(self) -> None:
        self._thread: threading.Thread | None = None
        self._stop = threading.Event()

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, name="ip-reservation-reminders", daemon=True)
        self._thread.start()
        logger.info("IP reservation reminder service started")

    def stop(self) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=10)

    def _run(self) -> None:
        if self._stop.wait(30):
            return
        while True:
            try:
                self._check()
            except Exception:
                logger.exception("IP reservation reminder check failed")
            if self._stop.wait(CHECK_INTERVAL_SECONDS):
                break

    @staticmethod
    def _load_settings(db) -> tuple[bool, int, list[str]]:  # type: ignore[no-untyped-def]
        from app.api.v1.admin import load_settings
        from app.schemas.admin import SystemSettingsRead

        parsed = SystemSettingsRead(**load_settings(db))
        return (
            parsed.ip_reservation_reminder_enabled,
            parsed.ip_reservation_reminder_days,
            parsed.ip_reservation_reminder_channels,
        )

    def _check(self) -> None:
        with SessionLocal() as db:
            enabled, days, channels = self._load_settings(db)
            if not enabled or not channels:
                return

            now = datetime.now(timezone.utc)
            horizon = now + timedelta(days=days)
            due = db.scalars(
                select(IpReservation).where(
                    IpReservation.expires_at.isnot(None),
                    IpReservation.expires_at > now,
                    IpReservation.expires_at <= horizon,
                    IpReservation.reminder_sent_at.is_(None),
                )
            ).all()
            if not due:
                return

            notif_settings = load_notification_settings(db)
            profiles = {
                int(profile["id"]): profile
                for profile in list_notification_profiles(db, redacted=False)
            }
            app_name = self._get_app_name(db)

            message = self._build_message(app_name, due)
            for channel in channels:
                result = send_notification_target(channel, message, notif_settings, profiles)
                logger.info("IP reservation expiry reminder sent via %s: %s", channel, result)

            reminded_at = now
            for reservation in due:
                reservation.reminder_sent_at = reminded_at
            db.commit()

    @staticmethod
    def _build_message(app_name: str, due: list[IpReservation]) -> str:
        lines = [
            f"• {r.label} ({r.ip_address}) expires {r.expires_at.strftime('%Y-%m-%d')}"
            for r in due
        ]
        body = "\n".join(lines)
        return f"{app_name} Alert\n\n📅 {len(due)} IP reservation(s) expiring soon:\n{body}"

    @staticmethod
    def _get_app_name(db) -> str:  # type: ignore[no-untyped-def]
        try:
            from app.models.system_setting import SystemSetting
            row = db.scalar(select(SystemSetting).where(SystemSetting.key == "app_name"))
            return row.value if row else "NetMap"
        except Exception:
            return "NetMap"


ip_reservation_reminder_service = IpReservationReminderService()
