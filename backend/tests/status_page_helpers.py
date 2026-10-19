from sqlalchemy import create_engine, text
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.db.session import Base, import_all_models
from app.models.device import Device
from app.models.monitor import Monitor
from app.models.port_target import DevicePortTarget


PRODUCTION_HISTORY_INDEXES = (
    "CREATE INDEX IF NOT EXISTS ix_monitor_history_device_checked_at ON device_monitor_history (device_id, checked_at)",
    "CREATE INDEX IF NOT EXISTS ix_monitor_history_checked_at_rtt ON device_monitor_history (checked_at, rtt_ms)",
    "CREATE INDEX IF NOT EXISTS ix_monitor_history_device_checked_status "
    "ON device_monitor_history (device_id, checked_at, status, rtt_ms)",
    "CREATE INDEX IF NOT EXISTS ix_monitor_history_device_checked_health "
    "ON device_monitor_history (device_id, checked_at, is_healthy, status, rtt_ms)",
    "CREATE INDEX IF NOT EXISTS ix_monitor_check_history_monitor_checked "
    "ON monitor_check_history (monitor_id, checked_at, status, response_time_ms)",
)


def make_engine():
    import_all_models()
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(bind=engine)
    with engine.begin() as conn:
        for ddl in PRODUCTION_HISTORY_INDEXES:
            conn.execute(text(ddl))
    return engine


def make_session() -> Session:
    return sessionmaker(bind=make_engine(), expire_on_commit=False)()


def seed_device(db: Session, **kw) -> Device:
    n = db.query(Device).count() + 1
    kw.setdefault("ip_address", f"10.0.0.{n}")
    kw.setdefault("hostname", f"host{n}")
    device = Device(**kw)
    db.add(device)
    db.commit()
    return device


def seed_monitor(db: Session, **kw) -> Monitor:
    n = db.query(Monitor).count() + 1
    kw.setdefault("name", f"Monitor {n}")
    kw.setdefault("url", f"https://example{n}.test/")
    monitor = Monitor(**kw)
    db.add(monitor)
    db.commit()
    return monitor


def seed_service_check(db: Session, device_id: int | None, **kw) -> DevicePortTarget:
    kw.setdefault("port", 443)
    kw.setdefault("label", "HTTPS")
    target = DevicePortTarget(device_id=device_id, **kw)
    db.add(target)
    db.commit()
    return target


def seed_page(db: Session, slug: str, visibility: str = "public", items=()):
    from app.models.status_page import StatusPage, StatusPageGroup, StatusPageItem

    page = StatusPage(slug=slug, name=slug, visibility=visibility)
    db.add(page)
    db.flush()
    group = StatusPageGroup(page_id=page.id, name="Main")
    db.add(group)
    db.flush()
    for order, (ref, display_name) in enumerate(items):
        db.add(StatusPageItem(
            page_id=page.id, group_id=group.id, kind=ref.kind, device_id=ref.device_id,
            monitor_id=ref.monitor_id, port_target_id=ref.port_target_id,
            display_name=display_name, sort_order=order,
        ))
    db.commit()
    return page
