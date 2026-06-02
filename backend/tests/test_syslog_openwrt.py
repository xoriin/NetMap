from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.db.firewall_session import FirewallBase
from app.models.firewall_event import FirewallEvent
from app.services.syslog import storage
from app.services.syslog.parser import parse_syslog_line


def test_openwrt_kernel_firewall_log_parses_uppercase_iptables_fields():
    raw = (
        "<4>Jan  2 03:04:05 OpenWrt kern.warn kernel: [12345.678901] "
        "DROP IN=br-lan OUT=eth0 SRC=192.168.1.20 DST=8.8.8.8 LEN=60 "
        "PROTO=TCP SPT=53144 DPT=443"
    )

    parsed = parse_syslog_line(raw, "192.168.1.1")

    assert parsed.source_host == "OpenWrt"
    assert parsed.src_ip == "192.168.1.20"
    assert parsed.dst_ip == "8.8.8.8"
    assert parsed.src_port == 53144
    assert parsed.dst_port == 443
    assert parsed.protocol == "tcp"
    assert parsed.action == "drop"
    assert parsed.interface == "br-lan"
    assert parsed.direction == "in"


def test_syslog_ingestion_counters_track_stored_and_unparsed(monkeypatch):
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    FirewallBase.metadata.create_all(bind=engine, tables=[FirewallEvent.__table__])
    monkeypatch.setattr(storage, "SessionLocal", sessionmaker(bind=engine, autoflush=False, autocommit=False))
    monkeypatch.setattr(storage.firewall_event_broadcaster, "publish", lambda _event: None)
    monkeypatch.setattr(storage, "_ingestion_status", storage.IngestionStatus())

    stored = storage.store_syslog_line(
        "DROP SRC=192.168.1.20 DST=8.8.8.8 PROTO=UDP SPT=12345 DPT=53",
        "192.168.1.1",
    )
    dropped = storage.store_syslog_line("OpenWrt logread started", "192.168.1.1")
    status = storage.get_ingestion_status()

    assert stored > 0
    assert dropped == 0
    assert status.received_packets == 2
    assert status.stored_events == 1
    assert status.dropped_unparsed == 1
    assert status.last_drop_raw == "OpenWrt logread started"
