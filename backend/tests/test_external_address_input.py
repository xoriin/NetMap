import pytest

from app.services.external_addresses import (
    EXTERNAL_MAX_ADDRESSES_PER_ADD,
    AddressInputError,
    count_address_input,
    parse_address_input,
)


def test_single_address():
    assert parse_address_input("104.23.54.68") == ["104.23.54.68"]


def test_single_address_as_slash_32():
    """GitHub #42: a /32 must be accepted, not rejected."""
    assert parse_address_input("104.23.54.68/32") == ["104.23.54.68"]


def test_cidr_excludes_network_and_broadcast():
    result = parse_address_input("203.0.113.0/29")
    assert result[0] == "203.0.113.1"
    assert result[-1] == "203.0.113.6"
    assert len(result) == 6


def test_start_end_range():
    result = parse_address_input("104.23.54.68-104.23.54.71")
    assert result == ["104.23.54.68", "104.23.54.69", "104.23.54.70", "104.23.54.71"]


def test_slash_24_is_allowed():
    assert len(parse_address_input("203.0.113.0/24")) == 254


def test_slash_23_is_rejected():
    with pytest.raises(AddressInputError) as excinfo:
        parse_address_input("203.0.112.0/23")
    assert "510" in str(excinfo.value)
    assert str(EXTERNAL_MAX_ADDRESSES_PER_ADD) in str(excinfo.value)


def test_oversize_start_end_range_is_rejected():
    """A regex on prefix length would let this through — it has no prefix."""
    with pytest.raises(AddressInputError):
        parse_address_input("10.0.0.1-10.0.5.1")


def test_ipv6_single_address():
    assert parse_address_input("2001:db8::1") == ["2001:db8::1"]


def test_ipv6_oversize_prefix_is_rejected():
    """A v6 /24 is astronomically large; the count rule catches what /24 phrasing would not."""
    with pytest.raises(AddressInputError):
        parse_address_input("2001:db8::/24")


def test_reversed_range_is_rejected():
    with pytest.raises(AddressInputError):
        parse_address_input("10.0.0.5-10.0.0.1")


def test_mixed_family_range_is_rejected():
    with pytest.raises(AddressInputError):
        parse_address_input("10.0.0.1-2001:db8::1")


def test_garbage_is_rejected():
    with pytest.raises(AddressInputError):
        parse_address_input("999.999.999.999/24")


def test_empty_is_rejected():
    with pytest.raises(AddressInputError):
        parse_address_input("   ")


def test_count_does_not_materialise_large_inputs():
    assert count_address_input("203.0.113.0/24") == 254
    assert count_address_input("10.0.0.0/8") == 16_777_214
