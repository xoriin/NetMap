"""Parsing and bounds for external IP address input.

One rule governs every accepted shape: parse it, count it, reject anything over
the cap. Counting rather than pattern-matching is what makes a start-end range
and IPv6 obey the same limit as a CIDR.
"""

import ipaddress

EXTERNAL_MAX_ADDRESSES_PER_ADD = 256


class AddressInputError(ValueError):
    """Raised for input that is unparseable or larger than the cap."""


def _split_range(text: str) -> tuple[str, str] | None:
    if "-" not in text:
        return None
    start, _, end = text.partition("-")
    return start.strip(), end.strip()


def _range_bounds(start_text: str, end_text: str) -> tuple[int, int, int]:
    try:
        start = ipaddress.ip_address(start_text)
        end = ipaddress.ip_address(end_text)
    except ValueError as exc:
        raise AddressInputError("Enter a valid start and end address") from exc
    if start.version != end.version:
        raise AddressInputError("Start and end must be the same IP version")
    if int(end) < int(start):
        raise AddressInputError("End address must not be before the start address")
    return int(start), int(end), int(end) - int(start) + 1


def _network(text: str) -> ipaddress.IPv4Network | ipaddress.IPv6Network:
    try:
        return ipaddress.ip_network(text, strict=False)
    except ValueError as exc:
        raise AddressInputError("Enter a valid IP address, CIDR, or range") from exc


def count_address_input(raw: str) -> int:
    """Address count without materialising them. Does not enforce the cap."""
    text = raw.strip()
    if not text:
        raise AddressInputError("Enter an IP address or range")
    bounds = _split_range(text)
    if bounds is not None:
        return _range_bounds(*bounds)[2]
    network = _network(text)
    if network.version == 4 and network.prefixlen <= 30:
        return network.num_addresses - 2
    if network.version == 6 and network.prefixlen < 127:
        return network.num_addresses - 1
    return network.num_addresses


def _guard(count: int) -> None:
    if count > EXTERNAL_MAX_ADDRESSES_PER_ADD:
        raise AddressInputError(
            f"Too large — {count:,} addresses, limit is {EXTERNAL_MAX_ADDRESSES_PER_ADD}"
        )


def parse_address_input(raw: str) -> list[str]:
    """Expand one address, CIDR, or start-end range into address strings."""
    text = raw.strip()
    if not text:
        raise AddressInputError("Enter an IP address or range")
    bounds = _split_range(text)
    if bounds is not None:
        start, end, count = _range_bounds(*bounds)
        _guard(count)
        return [str(ipaddress.ip_address(value)) for value in range(start, end + 1)]
    network = _network(text)
    _guard(count_address_input(text))
    return [str(host) for host in network.hosts()]
