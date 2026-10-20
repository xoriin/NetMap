"""Inventory must use the scheduler's public-device probing policy."""

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from app.api.v1 import topology
from app.db.session import Base
from app.models.device import Device
from app.models.site import Site
from app.models.topology_group import TopologyGroup
from app.schemas.tools import PingResult
from app.schemas.topology import DeviceLiveStatusRequest
from app.services.tools import service as tools_service


@pytest.mark.parametrize("address", ["8.8.8.8", "2606:4700:4700::1111", "192.168.1.1"])
def test_inventory_live_ping_matches_monitoring_public_target_policy(monkeypatch, address):
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine, tables=[Device.__table__, Site.__table__, TopologyGroup.__table__])
    calls = []

    def ping(payload, *, allow_public_targets=None):
        calls.append((payload.host, allow_public_targets))
        if allow_public_targets is not True:
            raise ValueError("Public active network targets are blocked")
        return PingResult(host=payload.host, transmitted=1, received=1, average_ms=4.2, raw_output="", duration_ms=5)

    monkeypatch.setattr(topology, "ping_host", ping)
    def no_tcp(*args, **kwargs):
        raise OSError("TCP is unavailable")
    monkeypatch.setattr(topology.socket, "create_connection", no_tcp)
    with Session(engine) as db:
        device = Device(ip_address=address, hostname="public device")
        db.add(device)
        db.commit()
        result = topology.list_live_device_status(DeviceLiveStatusRequest(device_ids=[device.id]), _current_user=None, db=db)
        assert result.statuses[0].status == "online"
        assert result.statuses[0].latency_ms == 4.2
        assert calls == [(address, True)]


def test_interactive_tools_keep_public_target_restriction(monkeypatch):
    monkeypatch.setattr(tools_service.settings, "active_network_public_targets_enabled", False)
    with pytest.raises(ValueError, match="Public active network targets are blocked"):
        tools_service._ensure_resolved_ip_allowed("8.8.8.8")
    tools_service._ensure_resolved_ip_allowed("192.168.1.1")
