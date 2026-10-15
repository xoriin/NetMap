from datetime import datetime, timedelta, timezone
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from app.models import device, site, snmp_profile, topology_group  # noqa: F401
from app.models.alert_rule import AlertRule
from app.services.alerting.service import AlertMonitorService
from app.services.monitors.service import StandaloneMonitorService

@pytest.mark.parametrize('service', [AlertMonitorService, StandaloneMonitorService])
def test_cooldown_survives_sqlite_roundtrip(service):
    engine = create_engine('sqlite://')
    AlertRule.__table__.create(engine)
    now = datetime(2026, 9, 10, 0, 0, tzinfo=timezone.utc)
    with Session(engine) as db:
        row = AlertRule(name='Repeated outage', event_type='device_offline', channels='[]', cooldown_minutes=30)
        db.add(row)
        db.commit()
        assert service._cooldown_ok(row, now)
        for minutes, expected in [(29, False), (30, True), (31, True)]:
            row.last_triggered_at = now - timedelta(minutes=minutes)
            db.commit()
            db.refresh(row)
            assert row.last_triggered_at.tzinfo is None
            assert service._cooldown_ok(row, now) is expected
        row.last_triggered_at = (now - timedelta(minutes=30)).astimezone(timezone(timedelta(hours=10)))
        assert service._cooldown_ok(row, now)
        assert service._cooldown_ok(row, now.replace(tzinfo=None))
