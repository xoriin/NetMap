from __future__ import annotations

from datetime import datetime, timezone
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from app.api.deps import get_current_user
from app.db.session import get_db
from app.models.device import Device
from app.models.dhcp_lease import DhcpLease
from app.models.subnet import Subnet
from app.models.user import User
from app.models.topology_group import TopologyGroup
from app.schemas.ipam import (
    ConflictEntry,
    DhcpImportRequest,
    DhcpLeaseOut,
    IpAddressEntry,
    IpamSummary,
    SubnetCreate,
    SubnetOut,
    SubnetUpdate,
    VlanImportRequest,
    VlanSuggestion,
)
from app.services.ipam.dhcp_parser import auto_parse
from app.services.ipam.subnet_utils import detect_conflicts, enumerate_addresses, subnet_utilization

router = APIRouter(prefix="/ipam", tags=["ipam"])

_WRITE_ROLES = ("SuperAdmin", "NetworkAdmin")


def _require_write(user: User) -> None:
    if user.role not in _WRITE_ROLES:
        raise HTTPException(status_code=403, detail="Insufficient permissions")


# ── helpers ──────────────────────────────────────────────────────────────────

def _device_ips(db: Session) -> set[str]:
    return set(db.scalars(select(Device.ip_address)).all())


def _dhcp_ips(db: Session) -> set[str]:
    return set(db.scalars(select(DhcpLease.ip_address).where(DhcpLease.is_active == True)).all())  # noqa: E712


def _enrich_subnet(subnet: Subnet, device_ips: set[str], dhcp_ips: set[str]) -> SubnetOut:
    stats = subnet_utilization(subnet.cidr, device_ips, dhcp_ips, subnet.gateway)
    out = SubnetOut.model_validate(subnet)
    out.total_hosts = stats["total_hosts"]
    out.used = stats["used"]
    out.free = stats["free"]
    out.utilization = stats["utilization"]
    # count devices and leases actually in this subnet
    import ipaddress
    try:
        net = ipaddress.ip_network(subnet.cidr, strict=False)
        out.device_count = sum(1 for ip in device_ips if _in_net(ip, net))
        out.dhcp_count = sum(1 for ip in dhcp_ips if _in_net(ip, net))
    except ValueError:
        pass
    return out


def _in_net(ip: str, net) -> bool:  # type: ignore[no-untyped-def]
    import ipaddress
    try:
        return ipaddress.ip_address(ip) in net
    except ValueError:
        return False


def _is_valid_cidr(cidr: str) -> bool:
    import ipaddress
    try:
        ipaddress.ip_network(cidr, strict=False)
        return True
    except ValueError:
        return False


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

    total_hosts = used = free = 0
    for s in subnets:
        stats = subnet_utilization(s.cidr, device_ips, dhcp_ips, s.gateway)
        total_hosts += stats["total_hosts"]
        used += stats["used"]
        free += stats["free"]

    subnet_rows = [(s.id, s.cidr, s.name) for s in subnets]
    device_rows = [(row.id, row.ip_address, row.display_name or row.hostname or row.ip_address) for row in devices]
    conflicts = detect_conflicts(subnet_rows, device_rows)

    dhcp_count = db.scalar(select(func.count()).select_from(DhcpLease)) or 0

    return IpamSummary(
        subnet_count=len(subnets),
        total_hosts=total_hosts,
        used=used,
        free=free,
        utilization=used / total_hosts if total_hosts > 0 else 0.0,
        conflict_count=len(conflicts),
        dhcp_lease_count=dhcp_count,
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
    return [_enrich_subnet(s, device_ips, dhcp_ips) for s in subnets]


@router.post("/subnets", response_model=SubnetOut, status_code=201)
def create_subnet(
    payload: SubnetCreate,
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
) -> SubnetOut:
    _require_write(current_user)
    import ipaddress
    try:
        ipaddress.ip_network(payload.cidr, strict=False)
    except ValueError:
        raise HTTPException(status_code=422, detail=f"Invalid CIDR: {payload.cidr}")
    existing = db.scalar(select(Subnet).where(Subnet.cidr == payload.cidr))
    if existing:
        raise HTTPException(status_code=409, detail="A subnet with this CIDR already exists")
    subnet = Subnet(**payload.model_dump())
    db.add(subnet)
    db.commit()
    db.refresh(subnet)
    return _enrich_subnet(subnet, _device_ips(db), _dhcp_ips(db))


@router.patch("/subnets/{subnet_id}", response_model=SubnetOut)
def update_subnet(
    subnet_id: int,
    payload: SubnetUpdate,
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
) -> SubnetOut:
    _require_write(current_user)
    subnet = db.get(Subnet, subnet_id)
    if not subnet:
        raise HTTPException(status_code=404, detail="Subnet not found")
    for field, val in payload.model_dump(exclude_unset=True).items():
        setattr(subnet, field, val)
    subnet.updated_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(subnet)
    return _enrich_subnet(subnet, _device_ips(db), _dhcp_ips(db))


@router.delete("/subnets/{subnet_id}", status_code=204, response_model=None)
def delete_subnet(
    subnet_id: int,
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
) -> None:
    _require_write(current_user)
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
    device_mac: dict[str, str | None] = {row.ip_address: row.mac_address for row in devices}
    device_vendor: dict[str, str | None] = {row.ip_address: row.vendor for row in devices}
    leases = db.execute(select(DhcpLease.ip_address, DhcpLease.hostname, DhcpLease.mac_address).where(DhcpLease.is_active == True)).all()  # noqa: E712
    dhcp_map = {row.ip_address: row.hostname or "" for row in leases}
    dhcp_mac: dict[str, str | None] = {row.ip_address: row.mac_address for row in leases}

    entries = enumerate_addresses(subnet.cidr, device_map, dhcp_map, subnet.gateway)
    return [
        IpAddressEntry(
            ip=e.ip,
            kind=e.kind,
            label=e.label,
            mac_address=device_mac.get(e.ip) if e.kind == "device" else dhcp_mac.get(e.ip) if e.kind == "dhcp" else None,
            vendor=device_vendor.get(e.ip) if e.kind == "device" else None,
        )
        for e in entries
    ]


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
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    import ipaddress
    _require_write(current_user)

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
            dns_servers=group.dns_servers,
            created_at=now,
            updated_at=now,
        ))
        existing_cidrs.add(normalized)
        imported += 1
    db.commit()
    return {"imported": imported}


# ── conflicts ─────────────────────────────────────────────────────────────────

@router.get("/conflicts", response_model=list[ConflictEntry])
def list_conflicts(
    _current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
) -> list[ConflictEntry]:
    subnets = db.scalars(select(Subnet)).all()
    devices = db.execute(select(Device.id, Device.ip_address, Device.display_name, Device.hostname)).all()
    subnet_rows = [(s.id, s.cidr, s.name) for s in subnets]
    device_rows = [(row.id, row.ip_address, row.display_name or row.hostname or row.ip_address) for row in devices]
    return [ConflictEntry(**c) for c in detect_conflicts(subnet_rows, device_rows)]


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
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    _require_write(current_user)
    parsed = auto_parse(payload.content)
    if not parsed:
        raise HTTPException(status_code=422, detail="Could not parse lease file. Supported formats: ISC dhcpd, dnsmasq.")

    now = datetime.now(timezone.utc)
    imported = 0
    for entry in parsed:
        existing = db.scalar(select(DhcpLease).where(DhcpLease.ip_address == entry["ip_address"]))
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
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
) -> None:
    _require_write(current_user)
    db.execute(delete(DhcpLease))
    db.commit()
