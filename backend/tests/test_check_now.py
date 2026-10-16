from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.main import app  # noqa: F401 - register all model relationships
from app.db.session import Base
from app.models.device import Device
from app.models.port_target import DevicePortTarget
from app.models.monitor_history import DeviceMonitorHistory
from app.models.alert_rule import AlertRule
from app.models.alert_event import AlertEvent
from app.services.alerting import service
from app.api.v1.monitoring import check_device_now


@pytest.mark.parametrize("learn_fleet", [True, False])
def test_scoped_checks_preserve_other_devices_and_repeat_alerts(monkeypatch, learn_fleet):
    engine = create_engine('sqlite://', connect_args={'check_same_thread': False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine)
    with factory() as db:
        db.add_all([Device(id=n, ip_address=f'10.0.0.{n}', status='online', lifecycle='active', monitoring_paused=False) for n in [1, 2]])
        db.add_all([DevicePortTarget(id=1, port=443, label='Global', enabled=True), DevicePortTarget(id=2, device_id=1, port=22, label='SSH', enabled=True), DevicePortTarget(id=3, device_id=2, port=80, label='Other', enabled=True), DevicePortTarget(id=4, device_id=1, port=25, label='Disabled', enabled=False)])
        db.add_all([AlertRule(name=event, event_type=event, channels='["email"]', cooldown_minutes=0, enabled=True) for event in ['device_offline', 'device_online']])
        db.commit()
    monkeypatch.setattr(service, 'SessionLocal', factory)
    monkeypatch.setattr(service, 'load_notification_settings', lambda db: {})
    monkeypatch.setattr(service, 'list_notification_profiles', lambda *a, **kw: [])
    delivered=[]
    monkeypatch.setattr(service, 'send_notification_target', lambda *a: delivered.append(a) or 'ok')
    worker=service.AlertMonitorService()
    monkeypatch.setattr(worker, '_prune_history', lambda: None)
    monkeypatch.setattr(worker, '_get_app_name', lambda db: 'NetMap')
    probes=[]
    state=['online']
    monkeypatch.setattr(worker, '_probe_device_status', lambda d: probes.append(d.id) or (state[0], 1.0))
    ports=[]
    monkeypatch.setattr(service, 'check_port', lambda ip, port, *a, **kw: ports.append((ip, port)) or SimpleNamespace(open=True, response_time_ms=1, status_code=None, error=None))
    assert worker._check() if learn_fleet else worker._check(1)
    if not learn_fleet:
        worker._known[2] = "online"
        worker._known_ports[(2, 3)] = True
    for status in ['offline', 'online', 'offline', 'online']:
        state[0]=status
        probes.clear()
        ports.clear()
        assert worker._check(1)
        assert probes==[1]
        assert set(ports)=={('10.0.0.1',443),('10.0.0.1',22)}
        assert worker._known[2]=='online'
        assert (2,3) in worker._known_ports
    with factory() as db:
        assert len(db.scalars(select(AlertEvent)).all())==4
        histories=db.scalars(select(DeviceMonitorHistory).where(DeviceMonitorHistory.device_id==2)).all()
        assert len(histories)==(1 if learn_fleet else 0)
    assert len(delivered)==4
    worker._check_lock.acquire()
    try:
        assert worker._check(1) is False
    finally:
        worker._check_lock.release()


def test_check_now_rejects_unavailable_devices_and_closes_session(monkeypatch):
    calls=[]
    monkeypatch.setattr(service.alert_monitor, '_check', lambda device_id: calls.append(device_id) or True)
    class DB:
        def __init__(self, device): self.device=device
        def get(self, *args): return self.device
        def close(self): calls.append('closed')
    for device, code in [(None,404),(SimpleNamespace(status='online', monitoring_paused=True, lifecycle='active'),409)]:
        with pytest.raises(HTTPException) as exc:
            check_device_now(1,None,DB(device))
        assert exc.value.status_code==code
    result=check_device_now(1,None,DB(SimpleNamespace(status='online',monitoring_paused=False,lifecycle='active')))
    assert result['checked']
    assert calls==['closed',1]
