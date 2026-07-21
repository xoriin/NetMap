from datetime import datetime, timedelta, timezone

from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.db.session import Base
from app.models.ip_reservation import IpReservation
from app.models.site import Site
from app.models.subnet import Subnet
from app.models.system_setting import SystemSetting
from app.services.ipam import reminders as reminders_module
from app.services.ipam.reminders import IpReservationReminderService


def _session():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(
        engine, tables=[Site.__table__, Subnet.__table__, IpReservation.__table__, SystemSetting.__table__],
    )
    return sessionmaker(bind=engine, autoflush=False, autocommit=False)()


def _patch_notifications(monkeypatch, sent: list[str]):
    monkeypatch.setattr(reminders_module, "load_notification_settings", lambda db: {})
    monkeypatch.setattr(reminders_module, "list_notification_profiles", lambda db, redacted=False: [])

    def fake_send(channel, message, settings, profiles):
        sent.append((channel, message))
        return "ok"

    monkeypatch.setattr(reminders_module, "send_notification_target", fake_send)


def test_reminder_check_skips_when_disabled(monkeypatch):
    db = _session()
    now = datetime.now(timezone.utc)
    db.add(IpReservation(ip_address="10.0.0.5", label="Printer", expires_at=now + timedelta(days=1)))
    db.commit()

    factory = sessionmaker(bind=db.get_bind(), autoflush=False, autocommit=False)
    monkeypatch.setattr(reminders_module, "SessionLocal", factory)
    sent: list[str] = []
    _patch_notifications(monkeypatch, sent)

    service = IpReservationReminderService()
    service._check()

    assert sent == []
    reservation = db.scalar(select(IpReservation))
    assert reservation.reminder_sent_at is None


def test_reminder_check_sends_and_marks_due_reservations(monkeypatch):
    db = _session()
    now = datetime.now(timezone.utc)
    db.add_all([
        SystemSetting(key="ip_reservation_reminder_enabled", value="true"),
        SystemSetting(key="ip_reservation_reminder_days", value="3"),
        SystemSetting(key="ip_reservation_reminder_channels", value='["ntfy"]'),
    ])
    due_soon = IpReservation(ip_address="10.0.0.5", label="Printer", expires_at=now + timedelta(days=2))
    too_far = IpReservation(ip_address="10.0.0.6", label="Camera", expires_at=now + timedelta(days=10))
    already_expired = IpReservation(ip_address="10.0.0.7", label="Old", expires_at=now - timedelta(days=1))
    already_reminded = IpReservation(
        ip_address="10.0.0.8", label="Scanner", expires_at=now + timedelta(days=1),
        reminder_sent_at=now - timedelta(hours=1),
    )
    db.add_all([due_soon, too_far, already_expired, already_reminded])
    db.commit()
    prior_reminder_sent_at = already_reminded.reminder_sent_at

    factory = sessionmaker(bind=db.get_bind(), autoflush=False, autocommit=False)
    monkeypatch.setattr(reminders_module, "SessionLocal", factory)
    sent: list[str] = []
    _patch_notifications(monkeypatch, sent)

    service = IpReservationReminderService()
    service._check()

    assert len(sent) == 1
    channel, message = sent[0]
    assert channel == "ntfy"
    assert "Printer" in message
    assert "Camera" not in message
    assert "Old" not in message
    assert "Scanner" not in message

    db.refresh(due_soon)
    db.refresh(too_far)
    db.refresh(already_reminded)
    assert due_soon.reminder_sent_at is not None
    assert too_far.reminder_sent_at is None
    # untouched — already had a reminder timestamp before this run
    assert already_reminded.reminder_sent_at == prior_reminder_sent_at
