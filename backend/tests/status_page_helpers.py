from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.db.session import Base, import_all_models
from app.models.device import Device
from app.models.monitor import Monitor
from app.models.port_target import DevicePortTarget


def make_session() -> Session:
    import_all_models()
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(bind=engine)
    return sessionmaker(bind=engine, expire_on_commit=False)()


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
