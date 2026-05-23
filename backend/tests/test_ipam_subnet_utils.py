from app.services.ipam.subnet_utils import subnet_utilization


def test_subnet_utilization_counts_large_subnet_without_enumerating_hosts():
    stats = subnet_utilization(
        "10.0.0.0/16",
        device_ips={"10.0.1.10", "10.0.2.20", "192.168.1.5"},
        dhcp_ips={"10.0.3.30"},
        gateway="10.0.0.1",
        reserved_ips={"10.0.4.40"},
    )

    assert stats["valid"] is True
    assert stats["total_hosts"] == 65534
    assert stats["used"] == 5
    assert stats["free"] == 65529
