from __future__ import annotations

import ipaddress
import json
import re
from bisect import bisect_left, bisect_right
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.exc import IntegrityError
from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from app.api.deps import get_current_user, require_ipam_write
from app.db.session import get_db
from app.models.device import Device
from app.models.dhcp_lease import DhcpLease
from app.models.cloud import CLOUD_ASSET_KINDS, CloudAsset, CloudProvider
from app.models.external_ip import ExternalIpAssignment, ExternalIpPool, ExternalIpRange
from app.models.ip_reservation import IpReservation
from app.models.subnet import Subnet
from app.models.user import User
from app.models.topology_group import TopologyGroup
from app.schemas.ipam import (
    ConflictEntry,
    DhcpImportRequest,
    DhcpLeaseOut,
    IpAddressEntry,
    IpamSummary,
    IpReservationCreate,
    IpReservationOut,
    IpReservationUpdate,
    SubnetCreate,
    SubnetOut,
    SubnetUpdate,
    VlanImportRequest,
    VlanSuggestion,
    ExternalIpAddressEntry,
    ExternalIpAddressPage,
    ExternalIpAssignmentCreate,
    ExternalIpAssignmentOut,
    ExternalIpAssignmentUpdate,
    ExternalIpPoolCreate,
    ExternalIpPoolOut,
    ExternalIpPoolUpdate,
    ExternalIpRangeCreate,
    ExternalIpRangeOut,
    ExternalIpSummary,
    CloudAssetAddressCreate,
    CloudAssetCreate,
    CloudAssetOut,
    CloudAssetUpdate,
    CloudProviderOut,
    ExternalIpDeviceOut,
)
from app.services.ipam.dhcp_parser import auto_parse
from app.services.discovery.scheduled import normalize_mac
from app.services.ipam.subnet_utils import detect_conflicts, enumerate_addresses

router = APIRouter(prefix="/ipam", tags=["ipam"])
EXTERNAL_POOL_MAX_ADDRESSES = 65_536

@dataclass(frozen=True)
class _IpIndex:
    ips: frozenset
    v4: tuple[int, ...]
    v6: tuple[int, ...]


@dataclass(frozen=True)
class _ExternalRange:
    value: str
    version: int
    start: int
    end: int
    overlap_start: int
    overlap_end: int

    @property
    def total(self) -> int:
        return self.end - self.start + 1


@dataclass(frozen=True)
class _IpamIndexes:
    devices: _IpIndex
    dhcp: _IpIndex
    reservations: _IpIndex
    used: _IpIndex


@dataclass(frozen=True)
class _SubnetStats:
    total_hosts: int
    used: int
    free: int
    utilization: float
    device_count: int
    dhcp_count: int
    reservation_count: int


# ── helpers ──────────────────────────────────────────────────────────────────

def _device_ips(db: Session) -> set[str]:
    return set(db.scalars(select(Device.ip_address)).all())


def _dhcp_ips(db: Session) -> set[str]:
    return set(db.scalars(select(DhcpLease.ip_address).where(DhcpLease.is_active == True)).all())  # noqa: E712


def _reserved_ips(db: Session) -> set[str]:
    return set(db.scalars(select(IpReservation.ip_address)).all())


def _parse_ip_set(ips: set[str]) -> frozenset:
    result = set()
    for ip in ips:
        try:
            result.add(ipaddress.ip_address(ip))
        except (TypeError, ValueError):
            pass
    return frozenset(result)


def _build_ip_index(ips: set[str] | frozenset) -> _IpIndex:
    parsed = ips if isinstance(ips, frozenset) else _parse_ip_set(ips)
    return _IpIndex(
        ips=parsed,
        v4=tuple(sorted(int(ip) for ip in parsed if ip.version == 4)),
        v6=tuple(sorted(int(ip) for ip in parsed if ip.version == 6)),
    )


def _build_ipam_indexes(device_ips: set[str], dhcp_ips: set[str], reserved_ips: set[str]) -> _IpamIndexes:
    device_index = _build_ip_index(device_ips)
    dhcp_index = _build_ip_index(dhcp_ips)
    reservation_index = _build_ip_index(reserved_ips)
    return _IpamIndexes(
        devices=device_index,
        dhcp=dhcp_index,
        reservations=reservation_index,
        used=_build_ip_index(device_index.ips | dhcp_index.ips | reservation_index.ips),
    )


def _count_index_in_usable_range(index: _IpIndex, net: ipaddress.IPv4Network | ipaddress.IPv6Network) -> int:
    start = int(net.network_address) + 1
    end = int(net.broadcast_address) - 1
    if end < start:
        return 0
    values = index.v4 if net.version == 4 else index.v6
    return bisect_right(values, end) - bisect_left(values, start)


def _subnet_stats_from_indexes(subnet: Subnet, indexes: _IpamIndexes) -> _SubnetStats:
    try:
        net = ipaddress.ip_network(subnet.cidr, strict=False)
    except ValueError:
        return _SubnetStats(0, 0, 0, 0.0, 0, 0, 0)

    total = max(net.num_addresses - 2, 0)
    used = _count_index_in_usable_range(indexes.used, net)
    if subnet.gateway:
        try:
            gateway = ipaddress.ip_address(subnet.gateway)
        except ValueError:
            gateway = None
        if (
            gateway is not None
            and gateway.version == net.version
            and gateway in net
            and gateway not in (net.network_address, net.broadcast_address)
            and gateway not in indexes.used.ips
        ):
            used += 1

    return _SubnetStats(
        total_hosts=total,
        used=used,
        free=total - used,
        utilization=used / total if total > 0 else 0.0,
        device_count=_count_index_in_usable_range(indexes.devices, net),
        dhcp_count=_count_index_in_usable_range(indexes.dhcp, net),
        reservation_count=_count_index_in_usable_range(indexes.reservations, net),
    )


def _enrich_subnet(
    subnet: Subnet,
    device_ips: set[str],
    dhcp_ips: set[str],
    reserved_ips: set[str] | None = None,
    _parsed_device: frozenset | None = None,
    _parsed_dhcp: frozenset | None = None,
    _parsed_res: frozenset | None = None,
    _indexes: _IpamIndexes | None = None,
) -> SubnetOut:
    out = SubnetOut.model_validate(subnet)
    if _indexes is None:
        _indexes = _build_ipam_indexes(device_ips, dhcp_ips, reserved_ips or set())
    stats = _subnet_stats_from_indexes(subnet, _indexes)
    out.total_hosts = stats.total_hosts
    out.used = stats.used
    out.free = stats.free
    out.utilization = stats.utilization
    out.device_count = stats.device_count
    out.dhcp_count = stats.dhcp_count
    out.reservation_count = stats.reservation_count
    return out


def _is_valid_cidr(cidr: str) -> bool:
    try:
        ipaddress.ip_network(cidr, strict=False)
        return True
    except ValueError:
        return False


def _validate_dhcp_range(cidr: str, start: str | None, end: str | None) -> None:
    if not start and not end:
        return
    if not start or not end:
        raise HTTPException(status_code=422, detail="DHCP range requires both start and end IPs")
    try:
        net = ipaddress.ip_network(cidr, strict=False)
        start_ip = ipaddress.ip_address(start)
        end_ip = ipaddress.ip_address(end)
    except ValueError:
        raise HTTPException(status_code=422, detail="Invalid DHCP range")
    if start_ip.version != net.version or end_ip.version != net.version:
        raise HTTPException(status_code=422, detail="DHCP range IP version must match subnet")
    if start_ip not in net or end_ip not in net:
        raise HTTPException(status_code=422, detail="DHCP range must be inside the subnet")
    if int(start_ip) > int(end_ip):
        raise HTTPException(status_code=422, detail="DHCP range start must be before the end")


def _in_dhcp_range(ip: str, start: str | None, end: str | None) -> bool:
    if not start or not end:
        return False
    try:
        value = ipaddress.ip_address(ip)
        return int(ipaddress.ip_address(start)) <= int(value) <= int(ipaddress.ip_address(end))
    except ValueError:
        return False


def _external_range(value: str, *, validate_public: bool = True) -> _ExternalRange:
    raw = value.strip().replace("–", "-").replace("—", "-")
    try:
        if "/" in raw:
            network = ipaddress.ip_network(raw, strict=False)
            version = network.version
            overlap_start = int(network.network_address)
            overlap_end = int(network.broadcast_address)
            if network.version == 4 and network.prefixlen <= 30:
                start = overlap_start + 1
                end = overlap_end - 1
            else:
                start = overlap_start
                end = overlap_end
            normalized = str(network)
        elif "-" in raw:
            first, last = (part.strip() for part in raw.split("-", 1))
            start_address = ipaddress.ip_address(first)
            end_address = ipaddress.ip_address(last)
            if start_address.version != end_address.version or int(start_address) > int(end_address):
                raise ValueError
            start = overlap_start = int(start_address)
            end = overlap_end = int(end_address)
            network = None
            version = start_address.version
            normalized = f"{start_address}-{end_address}"
        else:
            address = ipaddress.ip_address(raw)
            network = ipaddress.ip_network(f"{address}/{address.max_prefixlen}")
            version = address.version
            start = overlap_start = int(address)
            end = overlap_end = int(address)
            normalized = str(network)
    except ValueError:
        raise HTTPException(status_code=422, detail="Enter a valid public IP address, start-end range, or CIDR")
    allocation_size = overlap_end - overlap_start + 1
    if allocation_size > EXTERNAL_POOL_MAX_ADDRESSES:
        raise HTTPException(status_code=422, detail=f"External ranges are limited to {EXTERNAL_POOL_MAX_ADDRESSES:,} addresses")
    if validate_public:
        for number in range(overlap_start, overlap_end + 1):
            address = ipaddress.ip_address(number)
            if address.is_private or address.is_loopback or address.is_link_local or address.is_multicast or address.is_unspecified:
                raise HTTPException(status_code=422, detail="External ranges must use publicly routable address space")
    return _ExternalRange(
        value=normalized,
        version=version,
        start=start,
        end=end,
        overlap_start=overlap_start,
        overlap_end=overlap_end,
    )


def _external_address(value: str):
    try:
        address = ipaddress.ip_address(value.strip())
    except ValueError:
        raise HTTPException(status_code=422, detail="Invalid external IP address")
    if address.is_private or address.is_loopback or address.is_link_local or address.is_multicast or address.is_unspecified:
        raise HTTPException(status_code=422, detail="External IP records must use publicly routable addresses")
    return address


def _external_interval_value(version: int, start: int, end: int) -> str:
    """Serialize a remaining inclusive address interval without reintroducing removed IPs."""
    first = ipaddress.ip_address(start)
    last = ipaddress.ip_address(end)
    if start == end:
        return f"{first}/{32 if version == 4 else 128}"
    return f"{first}-{last}"


def _as_utc(value: datetime | None) -> datetime | None:
    """SQLite drops tzinfo on read; re-stamp UTC before serialization (GitHub #33)."""
    if value is None:
        return None
    return value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)


def _external_ranges_for_pool(db: Session, pool: ExternalIpPool) -> list[ExternalIpRange]:
    return list(db.scalars(select(ExternalIpRange).where(ExternalIpRange.pool_id == pool.id).order_by(ExternalIpRange.id)).all())


def _cloud_provider_out(provider: CloudProvider | None) -> CloudProviderOut | None:
    if provider is None:
        return None
    try:
        aliases = json.loads(provider.aliases) if provider.aliases else []
    except (TypeError, ValueError):
        aliases = []
    return CloudProviderOut(
        id=provider.id, key=provider.key, name=provider.name,
        aliases=aliases if isinstance(aliases, list) else [],
        icon=provider.icon or "cloud", icon_data=provider.icon_data, builtin=bool(provider.builtin),
    )


def _cloud_asset_out(db: Session, asset: CloudAsset, assignments: list[ExternalIpAssignment] | None = None) -> CloudAssetOut:
    if assignments is None:
        assignments = list(db.scalars(select(ExternalIpAssignment).where(ExternalIpAssignment.asset_id == asset.id)).all())
    provider = db.get(CloudProvider, asset.provider_id) if asset.provider_id else None
    return CloudAssetOut(
        id=asset.id, name=asset.name, kind=asset.kind, provider_id=asset.provider_id,
        provider=_cloud_provider_out(provider), account=asset.account, region=asset.region,
        device_id=asset.device_id, description=asset.description,
        created_at=_as_utc(asset.created_at), updated_at=_as_utc(asset.updated_at),
        address_count=len(assignments),
        in_use=sum(1 for row in assignments if row.status == "in_use"),
        reserved=sum(1 for row in assignments if row.status == "reserved"),
    )


def _assignment_out(db: Session, row: ExternalIpAssignment) -> ExternalIpAssignmentOut:
    asset = db.get(CloudAsset, row.asset_id) if row.asset_id else None
    device = db.get(Device, row.device_id) if row.device_id else None
    return ExternalIpAssignmentOut(
        id=row.id, pool_id=row.pool_id,
        device_id=row.device_id,
        device=ExternalIpDeviceOut.model_validate(device) if device is not None else None,
        asset_id=row.asset_id,
        asset=_cloud_asset_out(db, asset) if asset is not None else None,
        ip_address=row.ip_address, label=row.label, status=row.status, owner=row.owner,
        tags=row.tags, notes=row.notes,
        created_at=_as_utc(row.created_at), updated_at=_as_utc(row.updated_at),
    )


def _resolve_asset(db: Session, asset_id: int | None) -> CloudAsset | None:
    if asset_id is None:
        return None
    asset = db.get(CloudAsset, asset_id)
    if asset is None:
        raise HTTPException(status_code=404, detail="Cloud asset not found")
    return asset


def _resolve_provider(db: Session, provider_id: int | None) -> CloudProvider | None:
    if provider_id is None:
        return None
    provider = db.get(CloudProvider, provider_id)
    if provider is None:
        raise HTTPException(status_code=404, detail="Cloud provider not found")
    return provider


def _external_range_out(row: ExternalIpRange) -> ExternalIpRangeOut:
    return ExternalIpRangeOut(
        id=row.id, pool_id=row.pool_id, cidr=row.cidr,
        total=_external_range(row.cidr, validate_public=False).total, created_at=row.created_at,
    )


def _external_pool_out(db: Session, pool: ExternalIpPool, assignments: list[ExternalIpAssignment]) -> ExternalIpPoolOut:
    ranges = _external_ranges_for_pool(db, pool)
    total = sum(_external_range(row.cidr, validate_public=False).total for row in ranges)
    in_use = sum(1 for row in assignments if row.status == "in_use")
    reserved = sum(1 for row in assignments if row.status == "reserved")
    consumed = in_use + reserved
    provider = db.get(CloudProvider, pool.provider_id) if pool.provider_id else None
    return ExternalIpPoolOut(
        id=pool.id, name=pool.name, provider_id=pool.provider_id, provider=_cloud_provider_out(provider),
        service=pool.service, icon=pool.icon or "cloud", account=pool.account, region=pool.region,
        description=pool.description, created_at=_as_utc(pool.created_at), updated_at=_as_utc(pool.updated_at),
        total=total, in_use=in_use, reserved=reserved, free=max(0, total - consumed),
        utilization=consumed / total if total else 0.0,
        allocations=[_external_range_out(row) for row in ranges],
    )


def _validate_external_assignment(db: Session, pool_id: int | None, address) -> ExternalIpPool:
    if pool_id is None:
        raise HTTPException(status_code=422, detail="External IP addresses must belong to a managed range")
    pool = db.get(ExternalIpPool, pool_id)
    if pool is None:
        raise HTTPException(status_code=404, detail="External IP pool not found")
    ranges = [_external_range(row.cidr, validate_public=False) for row in _external_ranges_for_pool(db, pool)]
    if not any(address.version == item.version and item.start <= int(address) <= item.end for item in ranges):
        raise HTTPException(status_code=422, detail="External IP address is not inside the selected range")
    return pool


# ── summary ──────────────────────────────────────────────────────────────────

@router.get("/summary", response_model=IpamSummary)
def ipam_summary(
    _current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
) -> IpamSummary:
    subnets = db.scalars(select(Subnet)).all()
    devices = db.execute(select(Device.id, Device.ip_address, Device.display_name, Device.hostname)).all()
    device_ips = {row.ip_address for row in devices}
    dhcp_ips = _dhcp_ips(db)
    res_ips = _reserved_ips(db)
    indexes = _build_ipam_indexes(device_ips, dhcp_ips, res_ips)

    total_hosts = used = free = 0
    for s in subnets:
        stats = _subnet_stats_from_indexes(s, indexes)
        total_hosts += stats.total_hosts
        used += stats.used
        free += stats.free

    subnet_rows = [(s.id, s.cidr, s.name) for s in subnets]
    device_rows = [(row.id, row.ip_address, row.display_name or row.hostname or row.ip_address) for row in devices]
    res_rows = db.execute(select(IpReservation.ip_address, IpReservation.label)).all()
    reservation_list = [(row.ip_address, row.label) for row in res_rows]
    conflicts = detect_conflicts(subnet_rows, device_rows, dhcp_ips=dhcp_ips, reservations=reservation_list)

    dhcp_count = db.scalar(select(func.count()).select_from(DhcpLease)) or 0
    reservation_count = db.scalar(select(func.count()).select_from(IpReservation)) or 0

    return IpamSummary(
        subnet_count=len(subnets),
        total_hosts=total_hosts,
        used=used,
        free=free,
        utilization=used / total_hosts if total_hosts > 0 else 0.0,
        conflict_count=len(conflicts),
        dhcp_lease_count=dhcp_count,
        reservation_count=reservation_count,
    )


# ── subnets ──────────────────────────────────────────────────────────────────

@router.get("/subnets", response_model=list[SubnetOut])
def list_subnets(
    _current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
) -> list[SubnetOut]:
    subnets = db.scalars(select(Subnet).order_by(Subnet.name)).all()
    device_ips = _device_ips(db)
    dhcp_ips = _dhcp_ips(db)
    res_ips = _reserved_ips(db)
    indexes = _build_ipam_indexes(device_ips, dhcp_ips, res_ips)
    return [_enrich_subnet(s, device_ips, dhcp_ips, res_ips, _indexes=indexes) for s in subnets]


@router.post("/subnets", response_model=SubnetOut, status_code=201)
def create_subnet(
    payload: SubnetCreate,
    current_user: Annotated[User, Depends(require_ipam_write)],
    db: Annotated[Session, Depends(get_db)],
) -> SubnetOut:
    try:
        ipaddress.ip_network(payload.cidr, strict=False)
    except ValueError:
        raise HTTPException(status_code=422, detail=f"Invalid CIDR: {payload.cidr}")
    _validate_dhcp_range(payload.cidr, payload.dhcp_start, payload.dhcp_end)
    existing = db.scalar(select(Subnet).where(Subnet.cidr == payload.cidr))
    if existing:
        raise HTTPException(status_code=409, detail="A subnet with this CIDR already exists")
    subnet = Subnet(**payload.model_dump())
    db.add(subnet)
    db.commit()
    db.refresh(subnet)
    return _enrich_subnet(subnet, _device_ips(db), _dhcp_ips(db), _reserved_ips(db))


@router.patch("/subnets/{subnet_id}", response_model=SubnetOut)
def update_subnet(
    subnet_id: int,
    payload: SubnetUpdate,
    current_user: Annotated[User, Depends(require_ipam_write)],
    db: Annotated[Session, Depends(get_db)],
) -> SubnetOut:
    subnet = db.get(Subnet, subnet_id)
    if not subnet:
        raise HTTPException(status_code=404, detail="Subnet not found")
    proposed = payload.model_dump(exclude_unset=True)
    next_cidr = proposed.get("cidr", subnet.cidr)
    next_dhcp_start = proposed.get("dhcp_start", subnet.dhcp_start)
    next_dhcp_end = proposed.get("dhcp_end", subnet.dhcp_end)
    if next_cidr is not None:
        try:
            ipaddress.ip_network(next_cidr, strict=False)
        except ValueError:
            raise HTTPException(status_code=422, detail=f"Invalid CIDR: {next_cidr}")
        _validate_dhcp_range(next_cidr, next_dhcp_start, next_dhcp_end)
    for field, val in proposed.items():
        setattr(subnet, field, val)
    subnet.updated_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(subnet)
    return _enrich_subnet(subnet, _device_ips(db), _dhcp_ips(db), _reserved_ips(db))


@router.delete("/subnets/{subnet_id}", status_code=204, response_model=None)
def delete_subnet(
    subnet_id: int,
    current_user: Annotated[User, Depends(require_ipam_write)],
    db: Annotated[Session, Depends(get_db)],
) -> None:
    subnet = db.get(Subnet, subnet_id)
    if not subnet:
        raise HTTPException(status_code=404, detail="Subnet not found")
    db.delete(subnet)
    db.commit()


@router.get("/subnets/{subnet_id}/addresses", response_model=list[IpAddressEntry])
def subnet_addresses(
    subnet_id: int,
    _current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
) -> list[IpAddressEntry]:
    subnet = db.get(Subnet, subnet_id)
    if not subnet:
        raise HTTPException(status_code=404, detail="Subnet not found")

    devices = db.execute(select(Device.ip_address, Device.display_name, Device.hostname, Device.mac_address, Device.vendor)).all()
    device_map = {row.ip_address: row.display_name or row.hostname or row.ip_address for row in devices}
    device_display: dict[str, str | None] = {row.ip_address: row.display_name for row in devices}
    device_hostname: dict[str, str | None] = {row.ip_address: row.hostname for row in devices}
    device_by_mac: dict[str, str | None] = {}
    for row in devices:
        norm = normalize_mac(row.mac_address)
        if norm:
            device_by_mac[norm] = row.display_name or row.hostname
    device_mac: dict[str, str | None] = {row.ip_address: row.mac_address for row in devices}
    device_vendor: dict[str, str | None] = {row.ip_address: row.vendor for row in devices}
    leases = db.execute(select(DhcpLease.ip_address, DhcpLease.hostname, DhcpLease.mac_address).where(DhcpLease.is_active == True)).all()  # noqa: E712
    dhcp_map = {row.ip_address: row.hostname or "" for row in leases}
    dhcp_mac: dict[str, str | None] = {row.ip_address: row.mac_address for row in leases}
    reservations = db.execute(select(IpReservation.ip_address, IpReservation.label, IpReservation.mac_address)).all()
    reservation_map = {row.ip_address: row.label for row in reservations}
    reservation_mac: dict[str, str | None] = {row.ip_address: row.mac_address for row in reservations}

    entries = enumerate_addresses(subnet.cidr, device_map, dhcp_map, subnet.gateway, reservation_map=reservation_map)

    def _entry_display_name(entry) -> str | None:
        if entry.kind == "device":
            return device_display.get(entry.ip) or device_hostname.get(entry.ip)
        if entry.kind == "dhcp":
            lease_mac = dhcp_mac.get(entry.ip)
            if lease_mac:
                matched = device_by_mac.get(normalize_mac(lease_mac) or "")
                if matched:
                    return matched
            return entry.label or None
        if entry.kind in {"reserved", "gateway"}:
            return entry.label
        return None

    return [
        IpAddressEntry(
            ip=e.ip,
            kind=e.kind,
            label=e.label,
            display_name=_entry_display_name(e),
            dhcp_range=_in_dhcp_range(e.ip, subnet.dhcp_start, subnet.dhcp_end),
            mac_address=(
                device_mac.get(e.ip) if e.kind == "device"
                else dhcp_mac.get(e.ip) if e.kind == "dhcp"
                else reservation_mac.get(e.ip) if e.kind == "reserved"
                else None
            ),
            vendor=device_vendor.get(e.ip) if e.kind == "device" else None,
        )
        for e in entries
    ]


@router.get("/subnets/{subnet_id}/next-available", response_model=dict)
def next_available_ip(
    subnet_id: int,
    _current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    subnet = db.get(Subnet, subnet_id)
    if not subnet:
        raise HTTPException(status_code=404, detail="Subnet not found")
    try:
        net = ipaddress.ip_network(subnet.cidr, strict=False)
    except ValueError:
        raise HTTPException(status_code=422, detail=f"Invalid subnet CIDR: {subnet.cidr}")

    used = _parse_ip_set(_device_ips(db) | _dhcp_ips(db) | _reserved_ips(db))
    gateway = None
    if subnet.gateway:
        try:
            gateway = ipaddress.ip_address(subnet.gateway)
        except ValueError:
            gateway = None
    dhcp_bounds: tuple[int, int] | None = None
    if subnet.dhcp_start and subnet.dhcp_end:
        try:
            dhcp_bounds = (int(ipaddress.ip_address(subnet.dhcp_start)), int(ipaddress.ip_address(subnet.dhcp_end)))
        except ValueError:
            dhcp_bounds = None

    # ponytail: linear scan capped at 65536 hosts — the first free IP is almost
    # always near the start; a full bitmap only matters for pathological /8s.
    for index, candidate in enumerate(net.hosts()):
        if index >= 65536:
            break
        if candidate in used or candidate == gateway:
            continue
        if dhcp_bounds and dhcp_bounds[0] <= int(candidate) <= dhcp_bounds[1]:
            continue
        return {"ip": str(candidate)}
    raise HTTPException(status_code=409, detail="No free IP available in this subnet (outside the DHCP pool)")


# ── VLAN import ──────────────────────────────────────────────────────────────

@router.get("/vlan-suggestions", response_model=list[VlanSuggestion])
def vlan_suggestions(
    _current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
) -> list[VlanSuggestion]:
    import ipaddress
    groups = db.scalars(
        select(TopologyGroup).where(
            TopologyGroup.ip_range.isnot(None),
            TopologyGroup.ip_range != "",
        )
    ).all()

    existing_cidrs = {
        str(ipaddress.ip_network(s.cidr, strict=False))
        for s in db.scalars(select(Subnet)).all()
        if _is_valid_cidr(s.cidr)
    }

    result = []
    for g in groups:
        if not g.ip_range or not g.ip_range.strip():
            continue
        try:
            normalized = str(ipaddress.ip_network(g.ip_range.strip(), strict=False))
        except ValueError:
            continue
        result.append(VlanSuggestion(
            id=g.id,
            name=g.name,
            display_name=g.display_name,
            vlan_id=g.vlan_id,
            ip_range=g.ip_range,
            gateway=g.gateway,
            dns_servers=g.dns_servers,
            already_imported=normalized in existing_cidrs,
        ))
    return result


@router.post("/subnets/import-from-vlans", response_model=dict)
def import_subnets_from_vlans(
    payload: VlanImportRequest,
    current_user: Annotated[User, Depends(require_ipam_write)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    import ipaddress

    existing_cidrs = {
        str(ipaddress.ip_network(s.cidr, strict=False))
        for s in db.scalars(select(Subnet)).all()
        if _is_valid_cidr(s.cidr)
    }

    now = datetime.now(timezone.utc)
    imported = 0
    for group_id in payload.group_ids:
        group = db.get(TopologyGroup, group_id)
        if not group or not group.ip_range:
            continue
        try:
            normalized = str(ipaddress.ip_network(group.ip_range.strip(), strict=False))
        except ValueError:
            continue
        if normalized in existing_cidrs:
            continue
        db.add(Subnet(
            name=group.display_name or group.name,
	            cidr=normalized,
	            vlan_id=group.vlan_id,
	            gateway=group.gateway,
	            dhcp_start=group.dhcp_start,
	            dhcp_end=group.dhcp_end,
	            dns_servers=group.dns_servers,
            created_at=now,
            updated_at=now,
        ))
        existing_cidrs.add(normalized)
        imported += 1
    db.commit()
    return {"imported": imported}


# ── IP reservations ───────────────────────────────────────────────────────────

@router.get("/reservations", response_model=list[IpReservationOut])
def list_reservations(
    _current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
) -> list[IpReservationOut]:
    return list(db.scalars(select(IpReservation).order_by(IpReservation.ip_address)).all())


@router.delete("/reservations/expired", response_model=dict)
def delete_expired_reservations(
    current_user: Annotated[User, Depends(require_ipam_write)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    now = datetime.now(timezone.utc)
    expired = db.scalars(
        select(IpReservation).where(IpReservation.expires_at.isnot(None), IpReservation.expires_at < now)
    ).all()
    for reservation in expired:
        db.delete(reservation)
    db.commit()
    return {"deleted": len(expired)}


@router.post("/reservations", response_model=IpReservationOut, status_code=201)
def create_reservation(
    payload: IpReservationCreate,
    current_user: Annotated[User, Depends(require_ipam_write)],
    db: Annotated[Session, Depends(get_db)],
) -> IpReservationOut:
    import ipaddress
    try:
        ipaddress.ip_address(payload.ip_address)
    except ValueError:
        raise HTTPException(status_code=422, detail=f"Invalid IP address: {payload.ip_address}")
    existing = db.scalar(select(IpReservation).where(IpReservation.ip_address == payload.ip_address))
    if existing:
        raise HTTPException(status_code=409, detail="This IP address is already reserved")
    now = datetime.now(timezone.utc)
    reservation = IpReservation(
        **payload.model_dump(),
        reserved_by=current_user.username,
        created_at=now,
        updated_at=now,
    )
    db.add(reservation)
    db.commit()
    db.refresh(reservation)
    return IpReservationOut.model_validate(reservation)


@router.patch("/reservations/{reservation_id}", response_model=IpReservationOut)
def update_reservation(
    reservation_id: int,
    payload: IpReservationUpdate,
    current_user: Annotated[User, Depends(require_ipam_write)],
    db: Annotated[Session, Depends(get_db)],
) -> IpReservationOut:
    reservation = db.get(IpReservation, reservation_id)
    if not reservation:
        raise HTTPException(status_code=404, detail="Reservation not found")
    updates = payload.model_dump(exclude_unset=True)
    if "expires_at" in updates and updates["expires_at"] != reservation.expires_at:
        reservation.reminder_sent_at = None
    for field, val in updates.items():
        setattr(reservation, field, val)
    reservation.updated_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(reservation)
    return IpReservationOut.model_validate(reservation)


@router.delete("/reservations/{reservation_id}", status_code=204, response_model=None)
def delete_reservation(
    reservation_id: int,
    current_user: Annotated[User, Depends(require_ipam_write)],
    db: Annotated[Session, Depends(get_db)],
) -> None:
    reservation = db.get(IpReservation, reservation_id)
    if not reservation:
        raise HTTPException(status_code=404, detail="Reservation not found")
    db.delete(reservation)
    db.commit()


# ── conflicts ─────────────────────────────────────────────────────────────────

@router.get("/conflicts", response_model=list[ConflictEntry])
def list_conflicts(
    _current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
) -> list[ConflictEntry]:
    subnets = db.scalars(select(Subnet)).all()
    devices = db.execute(select(Device.id, Device.ip_address, Device.display_name, Device.hostname)).all()
    dhcp_ips_set = _dhcp_ips(db)
    res_rows = db.execute(select(IpReservation.ip_address, IpReservation.label)).all()
    subnet_rows = [(s.id, s.cidr, s.name) for s in subnets]
    device_rows = [(row.id, row.ip_address, row.display_name or row.hostname or row.ip_address) for row in devices]
    reservation_list = [(row.ip_address, row.label) for row in res_rows]
    return [ConflictEntry(**c) for c in detect_conflicts(subnet_rows, device_rows, dhcp_ips=dhcp_ips_set, reservations=reservation_list)]


# ── DHCP leases ───────────────────────────────────────────────────────────────

@router.get("/dhcp-leases", response_model=list[DhcpLeaseOut])
def list_dhcp_leases(
    _current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
) -> list[DhcpLeaseOut]:
    return list(db.scalars(select(DhcpLease).order_by(DhcpLease.ip_address)).all())


@router.post("/dhcp-leases/import", response_model=dict)
def import_dhcp_leases(
    payload: DhcpImportRequest,
    current_user: Annotated[User, Depends(require_ipam_write)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    parsed = auto_parse(payload.content)
    if not parsed:
        raise HTTPException(status_code=422, detail="Could not parse lease file. Supported formats: ISC dhcpd, dnsmasq.")

    now = datetime.now(timezone.utc)
    existing_map = {row.ip_address: row for row in db.scalars(select(DhcpLease)).all()}
    imported = 0
    for entry in parsed:
        existing = existing_map.get(entry["ip_address"])
        if existing:
            for k, v in entry.items():
                setattr(existing, k, v)
            existing.imported_at = now
        else:
            db.add(DhcpLease(**entry, source="import", imported_at=now))
            imported += 1
    db.commit()
    return {"imported": imported, "total": len(parsed)}


@router.delete("/dhcp-leases", status_code=204, response_model=None)
def clear_dhcp_leases(
    current_user: Annotated[User, Depends(require_ipam_write)],
    db: Annotated[Session, Depends(get_db)],
) -> None:
    db.execute(delete(DhcpLease))
    db.commit()


def _asset_from_legacy_fields(
    db: Session, pool: ExternalIpPool | None,
    provider: str | None, account: str | None, service: str | None, label: str,
) -> CloudAsset:
    """Create or match an asset for a client still sending provider/service/account.

    Mirrors the 0070 backfill so the deprecated write path and the migration agree on
    what constitutes "the same asset".
    """
    provider_id = pool.provider_id if pool is not None else None
    if provider:
        key = re.sub(r"[^a-z0-9]+", "-", provider.strip().lower()).strip("-")[:60]
        found = db.scalar(select(CloudProvider).where(CloudProvider.key == key))
        if found is not None:
            provider_id = found.id
    account_value = (account or (pool.account if pool is not None else None)) or None
    name = label.strip() or "Unnamed asset"
    existing = db.scalar(
        select(CloudAsset).where(
            CloudAsset.name == name,
            CloudAsset.provider_id.is_(provider_id) if provider_id is None else CloudAsset.provider_id == provider_id,
            CloudAsset.account.is_(account_value) if account_value is None else CloudAsset.account == account_value,
        )
    )
    if existing is not None:
        return existing
    kind = re.sub(r"[^a-z0-9]+", "_", service.strip().lower()).strip("_")[:40] if service else None
    asset = CloudAsset(
        name=name, kind=kind or None, provider_id=provider_id, account=account_value,
        region=pool.region if pool is not None else None,
    )
    db.add(asset)
    db.flush()
    return asset


# ── cloud providers and assets ───────────────────────────────────────────────

@router.get("/external/providers", response_model=list[CloudProviderOut])
def list_cloud_providers_for_ipam(
    _current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
) -> list[CloudProviderOut]:
    rows = db.scalars(select(CloudProvider).order_by(CloudProvider.name)).all()
    return [_cloud_provider_out(row) for row in rows]


@router.get("/external/assets", response_model=list[CloudAssetOut])
def list_cloud_assets(
    _current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
    provider_id: int | None = None,
    account: str | None = None,
    kind: str | None = None,
    q: str | None = None,
) -> list[CloudAssetOut]:
    query = select(CloudAsset)
    if provider_id is not None:
        query = query.where(CloudAsset.provider_id == provider_id)
    if account:
        query = query.where(CloudAsset.account == account)
    if kind:
        query = query.where(CloudAsset.kind == kind)
    if q:
        needle = f"%{q.strip().lower()}%"
        query = query.where(func.lower(CloudAsset.name).like(needle))
    assets = list(db.scalars(query.order_by(CloudAsset.name)).all())
    grouped: dict[int, list[ExternalIpAssignment]] = {}
    for row in db.scalars(select(ExternalIpAssignment).where(ExternalIpAssignment.asset_id.is_not(None))).all():
        grouped.setdefault(row.asset_id, []).append(row)  # type: ignore[arg-type]
    return [_cloud_asset_out(db, asset, grouped.get(asset.id, [])) for asset in assets]


@router.post("/external/assets", response_model=CloudAssetOut, status_code=201)
def create_cloud_asset(
    payload: CloudAssetCreate,
    _current_user: Annotated[User, Depends(require_ipam_write)],
    db: Annotated[Session, Depends(get_db)],
) -> CloudAssetOut:
    _resolve_provider(db, payload.provider_id)
    if payload.kind and payload.kind not in CLOUD_ASSET_KINDS:
        raise HTTPException(status_code=422, detail=f"Unknown asset kind '{payload.kind}'")
    if payload.device_id is not None and db.get(Device, payload.device_id) is None:
        raise HTTPException(status_code=404, detail="Device not found")
    asset = CloudAsset(
        name=payload.name.strip(), kind=payload.kind or None, provider_id=payload.provider_id,
        account=(payload.account or None), region=(payload.region or None),
        device_id=payload.device_id, description=(payload.description or None),
    )
    db.add(asset)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=409, detail="An asset with this name already exists for that provider and account")
    db.refresh(asset)
    return _cloud_asset_out(db, asset, [])


@router.patch("/external/assets/{asset_id}", response_model=CloudAssetOut)
def update_cloud_asset(
    asset_id: int,
    payload: CloudAssetUpdate,
    _current_user: Annotated[User, Depends(require_ipam_write)],
    db: Annotated[Session, Depends(get_db)],
) -> CloudAssetOut:
    asset = db.get(CloudAsset, asset_id)
    if asset is None:
        raise HTTPException(status_code=404, detail="Cloud asset not found")
    updates = payload.model_dump(exclude_unset=True)
    if "provider_id" in updates:
        _resolve_provider(db, updates["provider_id"])
    if updates.get("kind") and updates["kind"] not in CLOUD_ASSET_KINDS:
        raise HTTPException(status_code=422, detail=f"Unknown asset kind '{updates['kind']}'")
    if updates.get("device_id") is not None and db.get(Device, updates["device_id"]) is None:
        raise HTTPException(status_code=404, detail="Device not found")
    for field, value in updates.items():
        setattr(asset, field, value.strip() if isinstance(value, str) else value)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=409, detail="An asset with this name already exists for that provider and account")
    db.refresh(asset)
    return _cloud_asset_out(db, asset)


@router.delete("/external/assets/{asset_id}", status_code=204, response_model=None)
def delete_cloud_asset(
    asset_id: int,
    _current_user: Annotated[User, Depends(require_ipam_write)],
    db: Annotated[Session, Depends(get_db)],
) -> None:
    asset = db.get(CloudAsset, asset_id)
    if asset is None:
        raise HTTPException(status_code=404, detail="Cloud asset not found")
    # Addresses survive their asset — they fall back to the Unassigned bucket.
    for row in db.scalars(select(ExternalIpAssignment).where(ExternalIpAssignment.asset_id == asset_id)).all():
        row.asset_id = None
    db.delete(asset)
    db.commit()


# Name used for the per-provider bucket that holds individually-issued cloud addresses
# (elastic IPs and similar), as opposed to a delegated block.
INDIVIDUAL_ALLOCATION_SUFFIX = "individual addresses"


def _cloud_service_label(provider: CloudProvider | None, kind: str | None) -> str:
    labels = {
        "ec2": "Amazon EC2" if provider and provider.key == "aws" else "EC2",
        "vm": "Virtual Machines",
        "load_balancer": "Load Balancing",
        "nat_gateway": "NAT Gateway",
        "k8s_ingress": "Kubernetes",
        "database": "Database",
        "storage": "Storage",
        "cdn": "CDN",
        "other": "Other services",
    }
    if not kind:
        return "Other services"
    return labels.get(kind, kind.replace("_", " ").title())


def _allocation_for_address(db: Session, address, provider: CloudProvider | None, service: str | None = None) -> ExternalIpPool:
    """Find the allocation covering `address`, creating one on demand.

    Cloud addresses arrive one at a time, so an allocation must not be a prerequisite
    the user has to invent before recording an IP. Any existing range that already
    covers the address wins; otherwise the address is filed under the provider's
    individual-address allocation as a /32 (or /128), created if it does not exist.
    """
    for row in db.scalars(select(ExternalIpRange)).all():
        item = _external_range(row.cidr, validate_public=False)
        if address.version == item.version and item.start <= int(address) <= item.end:
            pool = db.get(ExternalIpPool, row.pool_id)
            if pool is not None:
                return pool

    service_name = (service or "").strip() or "Other services"
    name_parts = [provider.name] if provider else []
    if service_name != "Other services":
        name_parts.append(service_name)
    name_parts.append(INDIVIDUAL_ALLOCATION_SUFFIX)
    name = " ".join(name_parts).capitalize() if not provider else " ".join(name_parts)
    pool = db.scalar(
        select(ExternalIpPool).where(
            ExternalIpPool.name == name,
            ExternalIpPool.provider_id.is_(None) if provider is None else ExternalIpPool.provider_id == provider.id,
            ExternalIpPool.service == service_name,
        )
    )
    if pool is None:
        pool = ExternalIpPool(name=name, provider_id=provider.id if provider else None, service=service_name)
        db.add(pool)
        db.flush()
    db.add(ExternalIpRange(pool_id=pool.id, cidr=f"{address}/{address.max_prefixlen}"))
    db.flush()
    return pool


@router.post("/external/assets/{asset_id}/addresses", response_model=ExternalIpAssignmentOut, status_code=201)
def add_address_to_cloud_asset(
    asset_id: int,
    payload: CloudAssetAddressCreate,
    _current_user: Annotated[User, Depends(require_ipam_write)],
    db: Annotated[Session, Depends(get_db)],
) -> ExternalIpAssignmentOut:
    """Attach a public address to an asset — the primary way to record a cloud IP."""
    asset = db.get(CloudAsset, asset_id)
    if asset is None:
        raise HTTPException(status_code=404, detail="Cloud asset not found")
    address = _external_address(payload.ip_address)

    if payload.pool_id is not None:
        pool = _validate_external_assignment(db, payload.pool_id, address)
    else:
        provider = db.get(CloudProvider, asset.provider_id) if asset.provider_id else None
        pool = _allocation_for_address(db, address, provider, _cloud_service_label(provider, asset.kind))

    assignment = ExternalIpAssignment(
        pool_id=pool.id, asset_id=asset.id, ip_address=str(address),
        label=(payload.label or "").strip() or asset.name,
        status=payload.status, owner=payload.owner or None,
        tags=payload.tags or None, notes=payload.notes or None,
    )
    db.add(assignment)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=409, detail="External IP address is already tracked")
    db.refresh(assignment)
    return _assignment_out(db, assignment)


@router.post("/external/assets/{asset_id}/link-device", response_model=CloudAssetOut)
def link_cloud_asset_device(
    asset_id: int,
    payload: dict,
    _current_user: Annotated[User, Depends(require_ipam_write)],
    db: Annotated[Session, Depends(get_db)],
) -> CloudAssetOut:
    asset = db.get(CloudAsset, asset_id)
    if asset is None:
        raise HTTPException(status_code=404, detail="Cloud asset not found")
    device_id = payload.get("device_id")
    if not isinstance(device_id, int):
        raise HTTPException(status_code=422, detail="device_id is required")
    if db.get(Device, device_id) is None:
        raise HTTPException(status_code=404, detail="Device not found")
    asset.device_id = device_id
    db.commit()
    db.refresh(asset)
    return _cloud_asset_out(db, asset)


@router.delete("/external/assets/{asset_id}/link-device", response_model=CloudAssetOut)
def unlink_cloud_asset_device(
    asset_id: int,
    _current_user: Annotated[User, Depends(require_ipam_write)],
    db: Annotated[Session, Depends(get_db)],
) -> CloudAssetOut:
    asset = db.get(CloudAsset, asset_id)
    if asset is None:
        raise HTTPException(status_code=404, detail="Cloud asset not found")
    asset.device_id = None
    db.commit()
    db.refresh(asset)
    return _cloud_asset_out(db, asset)


# ── external IP pools and assignments ───────────────────────────────────────

@router.get("/external/summary", response_model=ExternalIpSummary)
def external_ip_summary(
    _current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
) -> ExternalIpSummary:
    pools = list(db.scalars(select(ExternalIpPool)).all())
    assignments = list(db.scalars(select(ExternalIpAssignment)).all())
    pool_rows: dict[int, list[ExternalIpAssignment]] = {}
    for assignment in assignments:
        if assignment.pool_id is not None:
            pool_rows.setdefault(assignment.pool_id, []).append(assignment)
    enriched = [_external_pool_out(db, pool, pool_rows.get(pool.id, [])) for pool in pools]
    return ExternalIpSummary(
        pool_count=len(pools),
        total=sum(pool.total for pool in enriched),
        in_use=sum(pool.in_use for pool in enriched),
        reserved=sum(pool.reserved for pool in enriched),
        free=sum(pool.free for pool in enriched),
        asset_count=db.scalar(select(func.count()).select_from(CloudAsset)) or 0,
        unassigned_address_count=sum(1 for row in assignments if row.asset_id is None),
    )


@router.get("/external/pools", response_model=list[ExternalIpPoolOut])
def list_external_ip_pools(
    _current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
) -> list[ExternalIpPoolOut]:
    pools = list(db.scalars(select(ExternalIpPool).order_by(ExternalIpPool.name)).all())
    assignments = list(db.scalars(select(ExternalIpAssignment).where(ExternalIpAssignment.pool_id.is_not(None))).all())
    grouped: dict[int, list[ExternalIpAssignment]] = {}
    for row in assignments:
        grouped.setdefault(row.pool_id, []).append(row)  # type: ignore[arg-type]
    return [_external_pool_out(db, pool, grouped.get(pool.id, [])) for pool in pools]


@router.post("/external/pools", response_model=ExternalIpPoolOut, status_code=201)
def create_external_ip_pool(
    payload: ExternalIpPoolCreate,
    _current_user: Annotated[User, Depends(require_ipam_write)],
    db: Annotated[Session, Depends(get_db)],
) -> ExternalIpPoolOut:
    address_range = _external_range(payload.cidr)
    for existing in db.scalars(select(ExternalIpRange)).all():
        existing_range = _external_range(existing.cidr, validate_public=False)
        if address_range.version == existing_range.version and address_range.overlap_start <= existing_range.overlap_end and existing_range.overlap_start <= address_range.overlap_end:
            owner = db.get(ExternalIpPool, existing.pool_id)
            raise HTTPException(status_code=409, detail=f"External allocation overlaps {owner.name if owner else 'another group'} ({existing.cidr})")
    _resolve_provider(db, payload.provider_id)
    pool = ExternalIpPool(
        name=payload.name.strip(), provider_id=payload.provider_id,
        service=(payload.service or "").strip() or None, icon=payload.icon.strip(),
        account=payload.account or None, region=payload.region or None, description=payload.description or None,
    )
    db.add(pool)
    try:
        db.flush()
        db.add(ExternalIpRange(pool_id=pool.id, cidr=address_range.value))
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=409, detail="External IP pool already exists")
    db.refresh(pool)
    return _external_pool_out(db, pool, [])


@router.patch("/external/pools/{pool_id}", response_model=ExternalIpPoolOut)
def update_external_ip_pool(
    pool_id: int,
    payload: ExternalIpPoolUpdate,
    _current_user: Annotated[User, Depends(require_ipam_write)],
    db: Annotated[Session, Depends(get_db)],
) -> ExternalIpPoolOut:
    pool = db.get(ExternalIpPool, pool_id)
    if pool is None:
        raise HTTPException(status_code=404, detail="External IP pool not found")
    updates = payload.model_dump(exclude_unset=True)
    if "provider_id" in updates:
        _resolve_provider(db, updates["provider_id"])
    if "icon" in updates:
        updates["icon"] = (updates["icon"] or "cloud").strip()
    for field, value in updates.items():
        setattr(pool, field, value.strip() if isinstance(value, str) else value)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=409, detail="External IP pool already exists")
    db.refresh(pool)
    assignments = list(db.scalars(select(ExternalIpAssignment).where(ExternalIpAssignment.pool_id == pool_id)).all())
    return _external_pool_out(db, pool, assignments)


@router.delete("/external/pools/{pool_id}", status_code=204, response_model=None)
def delete_external_ip_pool(
    pool_id: int,
    _current_user: Annotated[User, Depends(require_ipam_write)],
    db: Annotated[Session, Depends(get_db)],
) -> None:
    pool = db.get(ExternalIpPool, pool_id)
    if pool is None:
        raise HTTPException(status_code=404, detail="External IP pool not found")
    db.execute(delete(ExternalIpAssignment).where(ExternalIpAssignment.pool_id == pool_id))
    db.execute(delete(ExternalIpRange).where(ExternalIpRange.pool_id == pool_id))
    db.delete(pool)
    db.commit()


@router.post("/external/pools/{pool_id}/ranges", response_model=ExternalIpRangeOut, status_code=201)
def create_external_ip_range(
    pool_id: int,
    payload: ExternalIpRangeCreate,
    _current_user: Annotated[User, Depends(require_ipam_write)],
    db: Annotated[Session, Depends(get_db)],
) -> ExternalIpRangeOut:
    pool = db.get(ExternalIpPool, pool_id)
    if pool is None:
        raise HTTPException(status_code=404, detail="External IP allocation group not found")
    address_range = _external_range(payload.cidr)
    group_total = sum(_external_range(row.cidr, validate_public=False).total for row in _external_ranges_for_pool(db, pool))
    if group_total + address_range.total > EXTERNAL_POOL_MAX_ADDRESSES:
        raise HTTPException(status_code=422, detail=f"Allocation groups are limited to {EXTERNAL_POOL_MAX_ADDRESSES:,} addresses")
    for existing in db.scalars(select(ExternalIpRange)).all():
        item = _external_range(existing.cidr, validate_public=False)
        if address_range.version == item.version and address_range.overlap_start <= item.overlap_end and item.overlap_start <= address_range.overlap_end:
            raise HTTPException(status_code=409, detail=f"External allocation overlaps an existing allocation ({existing.cidr})")
    row = ExternalIpRange(pool_id=pool_id, cidr=address_range.value)
    db.add(row)
    pool.updated_at = datetime.now(timezone.utc)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=409, detail="External allocation already exists")
    db.refresh(row)
    return _external_range_out(row)


@router.patch("/external/pools/{pool_id}/ranges/{range_id}", response_model=ExternalIpRangeOut)
def update_external_ip_range(
    pool_id: int,
    range_id: int,
    payload: ExternalIpRangeCreate,
    _current_user: Annotated[User, Depends(require_ipam_write)],
    db: Annotated[Session, Depends(get_db)],
) -> ExternalIpRangeOut:
    """Resize an allocation. Replaces the old PATCH-the-pool-cidr path.

    Resizing may not orphan an address that is already tracked inside this range.
    """
    row = db.get(ExternalIpRange, range_id)
    if row is None or row.pool_id != pool_id:
        raise HTTPException(status_code=404, detail="External allocation not found")
    address_range = _external_range(payload.cidr)
    previous = _external_range(row.cidr, validate_public=False)
    for existing in db.scalars(select(ExternalIpRange).where(ExternalIpRange.id != range_id)).all():
        item = _external_range(existing.cidr, validate_public=False)
        if address_range.version == item.version and address_range.overlap_start <= item.overlap_end and item.overlap_start <= address_range.overlap_end:
            raise HTTPException(status_code=409, detail=f"External allocation overlaps an existing allocation ({existing.cidr})")
    for assignment in db.scalars(select(ExternalIpAssignment).where(ExternalIpAssignment.pool_id == pool_id)).all():
        address = ipaddress.ip_address(assignment.ip_address)
        was_inside = address.version == previous.version and previous.start <= int(address) <= previous.end
        if was_inside and (address.version != address_range.version or not (address_range.start <= int(address) <= address_range.end)):
            raise HTTPException(status_code=422, detail="New range would exclude existing assignments")
    row.cidr = address_range.value
    pool = db.get(ExternalIpPool, pool_id)
    if pool is not None:
        pool.updated_at = datetime.now(timezone.utc)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=409, detail="External allocation already exists")
    db.refresh(row)
    return _external_range_out(row)


@router.delete("/external/pools/{pool_id}/ranges/{range_id}", status_code=204, response_model=None)
def delete_external_ip_range(
    pool_id: int,
    range_id: int,
    _current_user: Annotated[User, Depends(require_ipam_write)],
    db: Annotated[Session, Depends(get_db)],
) -> None:
    row = db.get(ExternalIpRange, range_id)
    if row is None or row.pool_id != pool_id:
        raise HTTPException(status_code=404, detail="External allocation not found")
    pool = db.get(ExternalIpPool, pool_id)
    if pool is None:
        raise HTTPException(status_code=404, detail="External IP allocation group not found")
    ranges = _external_ranges_for_pool(db, pool)
    if len(ranges) <= 1:
        raise HTTPException(status_code=422, detail="An allocation group must contain at least one address or range")
    address_range = _external_range(row.cidr, validate_public=False)
    for assignment in db.scalars(select(ExternalIpAssignment).where(ExternalIpAssignment.pool_id == pool_id)).all():
        address = ipaddress.ip_address(assignment.ip_address)
        if address.version == address_range.version and address_range.start <= int(address) <= address_range.end:
            raise HTTPException(status_code=409, detail="Remove tracked assignments from this allocation before deleting it")
    db.delete(row)
    pool.updated_at = datetime.now(timezone.utc)
    db.commit()


@router.get("/external/pools/{pool_id}/addresses", response_model=ExternalIpAddressPage)
def list_external_pool_addresses(
    pool_id: int,
    _current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
    offset: int = Query(default=0, ge=0),
    limit: int = Query(default=256, ge=1, le=1024),
) -> ExternalIpAddressPage:
    pool = db.get(ExternalIpPool, pool_id)
    if pool is None:
        raise HTTPException(status_code=404, detail="External IP pool not found")
    ranges = [_external_range(row.cidr, validate_public=False) for row in _external_ranges_for_pool(db, pool)]
    total = sum(item.total for item in ranges)
    assignments = {
        row.ip_address: _assignment_out(db, row)
        for row in db.scalars(select(ExternalIpAssignment).where(ExternalIpAssignment.pool_id == pool_id)).all()
    }
    count = max(0, min(limit, total - offset))
    addresses = []
    range_offset = offset
    current_range = 0
    while current_range < len(ranges) and range_offset >= ranges[current_range].total:
        range_offset -= ranges[current_range].total
        current_range += 1
    for _index in range(count):
        item = ranges[current_range]
        address = str(ipaddress.ip_address(item.start + range_offset))
        assignment = assignments.get(address)
        addresses.append(ExternalIpAddressEntry(
            ip_address=address,
            status=assignment.status if assignment else "available",
            assignment=assignment,
        ))
        range_offset += 1
        if range_offset >= item.total:
            current_range += 1
            range_offset = 0
    return ExternalIpAddressPage(total=total, offset=offset, limit=limit, addresses=addresses)


@router.delete("/external/pools/{pool_id}/addresses/{ip_address}", status_code=204, response_model=None)
def delete_external_pool_address(
    pool_id: int,
    ip_address: str,
    _current_user: Annotated[User, Depends(require_ipam_write)],
    db: Annotated[Session, Depends(get_db)],
) -> None:
    """Remove exactly one address from an allocation, splitting its range if needed.

    An address row is the user's unit of work. Removing one address must therefore not
    delete the rest of its CIDR/range. If it is the allocation's final address, the now
    empty allocation is removed as well because empty allocation groups are invalid.
    """
    pool = db.get(ExternalIpPool, pool_id)
    if pool is None:
        raise HTTPException(status_code=404, detail="External IP pool not found")
    address = _external_address(ip_address)
    ranges = _external_ranges_for_pool(db, pool)
    match: tuple[ExternalIpRange, _ExternalRange] | None = None
    for row in ranges:
        item = _external_range(row.cidr, validate_public=False)
        if address.version == item.version and item.start <= int(address) <= item.end:
            match = (row, item)
            break
    if match is None:
        raise HTTPException(status_code=404, detail="External IP address is not part of this allocation")

    assignment = db.scalar(select(ExternalIpAssignment).where(
        ExternalIpAssignment.pool_id == pool_id,
        ExternalIpAssignment.ip_address == str(address),
    ))
    if assignment is not None:
        db.delete(assignment)

    row, item = match
    remaining: list[str] = []
    number = int(address)
    if item.start < number:
        remaining.append(_external_interval_value(item.version, item.start, number - 1))
    if number < item.end:
        remaining.append(_external_interval_value(item.version, number + 1, item.end))

    if remaining:
        row.cidr = remaining[0]
        for value in remaining[1:]:
            db.add(ExternalIpRange(pool_id=pool_id, cidr=value))
        pool.updated_at = datetime.now(timezone.utc)
    elif len(ranges) > 1:
        db.delete(row)
        pool.updated_at = datetime.now(timezone.utc)
    else:
        db.delete(row)
        db.delete(pool)
    db.commit()


@router.get("/external/assignments", response_model=list[ExternalIpAssignmentOut])
def list_external_ip_assignments(
    _current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
    pool_id: int | None = None,
    asset_id: int | None = None,
) -> list[ExternalIpAssignmentOut]:
    query = select(ExternalIpAssignment).where(ExternalIpAssignment.pool_id.is_not(None))
    if pool_id is not None:
        query = query.where(ExternalIpAssignment.pool_id == pool_id)
    if asset_id is not None:
        query = query.where(ExternalIpAssignment.asset_id == asset_id)
    return [_assignment_out(db, row) for row in db.scalars(query.order_by(ExternalIpAssignment.ip_address)).all()]


@router.post("/external/assignments", response_model=ExternalIpAssignmentOut, status_code=201)
def create_external_ip_assignment(
    payload: ExternalIpAssignmentCreate,
    _current_user: Annotated[User, Depends(require_ipam_write)],
    db: Annotated[Session, Depends(get_db)],
) -> ExternalIpAssignmentOut:
    address = _external_address(payload.ip_address)
    pool = _validate_external_assignment(db, payload.pool_id, address)
    asset = _resolve_asset(db, payload.asset_id)
    if asset is None and (payload.provider or payload.service or payload.account):
        # Deprecated path: a client still sending provider/service/account gets an asset
        # created or matched for it, so the grouping is never silently lost.
        asset = _asset_from_legacy_fields(db, pool, payload.provider, payload.account, payload.service, payload.label)
    if payload.device_id is not None and db.get(Device, payload.device_id) is None:
        raise HTTPException(status_code=404, detail="Device not found")
    assignment = ExternalIpAssignment(
        pool_id=payload.pool_id, device_id=payload.device_id, asset_id=asset.id if asset else None,
        ip_address=str(address), label=payload.label.strip(), status=payload.status,
        owner=payload.owner or None, tags=payload.tags or None, notes=payload.notes or None,
    )
    db.add(assignment)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=409, detail="External IP address is already tracked")
    db.refresh(assignment)
    return _assignment_out(db, assignment)


@router.patch("/external/assignments/{assignment_id}", response_model=ExternalIpAssignmentOut)
def update_external_ip_assignment(
    assignment_id: int,
    payload: ExternalIpAssignmentUpdate,
    _current_user: Annotated[User, Depends(require_ipam_write)],
    db: Annotated[Session, Depends(get_db)],
) -> ExternalIpAssignmentOut:
    assignment = db.get(ExternalIpAssignment, assignment_id)
    if assignment is None:
        raise HTTPException(status_code=404, detail="External IP assignment not found")
    updates = payload.model_dump(exclude_unset=True)
    next_pool_id = updates.get("pool_id", assignment.pool_id)
    next_address = _external_address(updates.get("ip_address", assignment.ip_address))
    _validate_external_assignment(db, next_pool_id, next_address)
    updates["ip_address"] = str(next_address)
    if "asset_id" in updates:
        _resolve_asset(db, updates["asset_id"])
    if updates.get("device_id") is not None and db.get(Device, updates["device_id"]) is None:
        raise HTTPException(status_code=404, detail="Device not found")
    # provider/account/service are deprecated; accept but never write them back.
    for field in ("provider", "account", "service"):
        updates.pop(field, None)
    for field, value in updates.items():
        setattr(assignment, field, value.strip() if isinstance(value, str) else value)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=409, detail="External IP address is already tracked")
    db.refresh(assignment)
    return _assignment_out(db, assignment)


@router.delete("/external/assignments/{assignment_id}", status_code=204, response_model=None)
def delete_external_ip_assignment(
    assignment_id: int,
    _current_user: Annotated[User, Depends(require_ipam_write)],
    db: Annotated[Session, Depends(get_db)],
) -> None:
    assignment = db.get(ExternalIpAssignment, assignment_id)
    if assignment is None:
        raise HTTPException(status_code=404, detail="External IP assignment not found")
    db.delete(assignment)
    db.commit()
