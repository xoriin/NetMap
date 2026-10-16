from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.device import Device
from app.models.lldp import LldpNeighbour
from app.services.discovery.scheduled import normalize_mac
from app.services.snmp import SnmpClient, value_to_text

# LLDP-MIB OID bases
_REM_TABLE = (1, 0, 8802, 1, 1, 2, 1, 4, 1, 1)
_REM_MAN_ADDR_TABLE = (1, 0, 8802, 1, 1, 2, 1, 4, 2, 1)
_LOC_PORT_TABLE = (1, 0, 8802, 1, 1, 2, 1, 3, 7, 1)

# lldpRemTable column numbers
_COL_CHASSIS_ID_SUBTYPE = 4
_COL_CHASSIS_ID = 5
_COL_PORT_ID_SUBTYPE = 6
_COL_PORT_ID = 7
_COL_PORT_DESC = 8
_COL_SYS_NAME = 9

# lldpLocPortTable column numbers
_COL_LOC_PORT_ID = 3
_COL_LOC_PORT_DESC = 4

# lldpRemManAddrTable column numbers
_COL_MAN_ADDR_IF_ID = 4

# Chassis/port ID subtypes
_SUBTYPE_MAC = 4
_SUBTYPE_NETWORK_ADDR = 5

# Network address subtypes (within networkAddress value)
_ADDR_TYPE_IPV4 = 1


@dataclass
class _RemEntry:
    chassis_id_subtype: int = 0
    chassis_id_raw: bytes | None = None
    port_id_subtype: int = 0
    port_id_raw: bytes | None = None
    port_desc: str | None = None
    sys_name: str | None = None
    mgmt_addr: str | None = None  # filled from management address table


@dataclass
class LldpNeighbourData:
    local_port_index: int
    local_port_id: str | None
    local_port_desc: str | None
    remote_chassis_id: str
    remote_port_id: str | None
    remote_port_desc: str | None
    remote_sys_name: str | None
    remote_mgmt_addr: str | None


def _decode_chassis_id(subtype: int, raw: bytes | None) -> str | None:
    if raw is None:
        return None
    if subtype == _SUBTYPE_MAC and len(raw) == 6:
        return ":".join(f"{b:02X}" for b in raw)
    if subtype == _SUBTYPE_NETWORK_ADDR and len(raw) >= 5 and raw[0] == _ADDR_TYPE_IPV4:
        return ".".join(str(b) for b in raw[1:5])
    try:
        return raw.decode("utf-8", errors="replace").strip("\x00") or None
    except Exception:
        return raw.hex()


def _decode_port_id(subtype: int, raw: bytes | None) -> str | None:
    if raw is None:
        return None
    if subtype == 3 and len(raw) == 6:  # macAddress port ID
        return ":".join(f"{b:02X}" for b in raw)
    try:
        return raw.decode("utf-8", errors="replace").strip("\x00") or None
    except Exception:
        return raw.hex()


def walk_lldp_neighbours(
    host: str,
    community: str,
    *,
    port: int = 161,
    timeout_seconds: int = 5,
) -> list[LldpNeighbourData]:
    client = SnmpClient(host, community, port=port, timeout_seconds=timeout_seconds)

    # Walk lldpRemTable — indexed by (timeMark, localPortNum, remIndex)
    # OID suffix after base: (col, timeMark, localPortNum, remIndex)
    rem_rows: dict[tuple[int, int, int], _RemEntry] = {}
    for oid, value in client.walk(_REM_TABLE):
        suffix = oid[len(_REM_TABLE):]
        if len(suffix) != 4:
            continue
        col, time_mark, local_port, rem_idx = suffix
        key = (time_mark, local_port, rem_idx)
        entry = rem_rows.setdefault(key, _RemEntry())
        if col == _COL_CHASSIS_ID_SUBTYPE and isinstance(value, int):
            entry.chassis_id_subtype = value
        elif col == _COL_CHASSIS_ID and isinstance(value, bytes):
            entry.chassis_id_raw = value
        elif col == _COL_PORT_ID_SUBTYPE and isinstance(value, int):
            entry.port_id_subtype = value
        elif col == _COL_PORT_ID and isinstance(value, bytes):
            entry.port_id_raw = value
        elif col == _COL_PORT_DESC:
            entry.port_desc = value_to_text(value)
        elif col == _COL_SYS_NAME:
            entry.sys_name = value_to_text(value)

    # Walk lldpRemManAddrTable — address encoded in OID suffix
    # suffix after base: (col, timeMark, localPortNum, remIndex, addrSubtype, addrLen, addr octets…)
    for oid, _value in client.walk(_REM_MAN_ADDR_TABLE):
        suffix = oid[len(_REM_MAN_ADDR_TABLE):]
        if len(suffix) < 7:
            continue
        col = suffix[0]
        if col != _COL_MAN_ADDR_IF_ID:
            continue
        time_mark, local_port, rem_idx = suffix[1], suffix[2], suffix[3]
        addr_subtype, addr_len = suffix[4], suffix[5]
        addr_octets = suffix[6:]
        key = (time_mark, local_port, rem_idx)
        if key not in rem_rows:
            continue
        entry = rem_rows[key]
        if entry.mgmt_addr is not None:
            continue  # already have one
        if addr_subtype == _ADDR_TYPE_IPV4 and addr_len == 4 and len(addr_octets) >= 4:
            entry.mgmt_addr = ".".join(str(b) for b in addr_octets[:4])

    # Walk lldpLocPortTable for local port descriptions
    # OID suffix after base: (col, portNum)
    loc_port_ids: dict[int, str | None] = {}
    loc_port_descs: dict[int, str | None] = {}
    for oid, value in client.walk(_LOC_PORT_TABLE):
        suffix = oid[len(_LOC_PORT_TABLE):]
        if len(suffix) != 2:
            continue
        col, port_num = suffix
        if col == _COL_LOC_PORT_ID:
            loc_port_ids[port_num] = value_to_text(value)
        elif col == _COL_LOC_PORT_DESC:
            loc_port_descs[port_num] = value_to_text(value)

    neighbours: list[LldpNeighbourData] = []
    for (time_mark, local_port, _rem_idx), entry in rem_rows.items():
        chassis_id = _decode_chassis_id(entry.chassis_id_subtype, entry.chassis_id_raw)
        if not chassis_id:
            continue
        neighbours.append(LldpNeighbourData(
            local_port_index=local_port,
            local_port_id=loc_port_ids.get(local_port),
            local_port_desc=loc_port_descs.get(local_port),
            remote_chassis_id=chassis_id,
            remote_port_id=_decode_port_id(entry.port_id_subtype, entry.port_id_raw),
            remote_port_desc=entry.port_desc,
            remote_sys_name=entry.sys_name,
            remote_mgmt_addr=entry.mgmt_addr,
        ))
    return neighbours


def _match_device(db: Session, chassis_id: str, mgmt_addr: str | None, sys_name: str | None) -> int | None:
    """Return devices.id for the best inventory match, or None."""
    norm_chassis = normalize_mac(chassis_id)
    if norm_chassis:
        for device in db.scalars(select(Device).where(Device.mac_address.is_not(None))).all():
            if normalize_mac(device.mac_address) == norm_chassis:
                return device.id

    if mgmt_addr:
        device = db.scalars(select(Device).where(Device.ip_address == mgmt_addr).limit(1)).first()
        if device:
            return device.id

    if sys_name:
        sys_name_lower = sys_name.strip().lower()
        for device in db.scalars(select(Device).where(Device.hostname.is_not(None))).all():
            if device.hostname and device.hostname.strip().lower() == sys_name_lower:
                return device.id

    return None


def upsert_lldp_neighbours(
    db: Session,
    source_device_id: int,
    neighbours: list[LldpNeighbourData],
) -> list[LldpNeighbour]:
    now = datetime.now(timezone.utc)
    results: list[LldpNeighbour] = []
    for n in neighbours:
        matched_id = _match_device(db, n.remote_chassis_id, n.remote_mgmt_addr, n.remote_sys_name)
        existing = db.scalars(
            select(LldpNeighbour).where(
                LldpNeighbour.source_device_id == source_device_id,
                LldpNeighbour.local_port_index == n.local_port_index,
                LldpNeighbour.remote_chassis_id == n.remote_chassis_id,
            ).limit(1)
        ).first()
        if existing:
            existing.local_port_id = n.local_port_id
            existing.local_port_desc = n.local_port_desc
            existing.remote_port_id = n.remote_port_id
            existing.remote_port_desc = n.remote_port_desc
            existing.remote_sys_name = n.remote_sys_name
            existing.remote_mgmt_addr = n.remote_mgmt_addr
            existing.matched_device_id = matched_id
            existing.last_seen = now
            results.append(existing)
        else:
            row = LldpNeighbour(
                source_device_id=source_device_id,
                local_port_index=n.local_port_index,
                local_port_id=n.local_port_id,
                local_port_desc=n.local_port_desc,
                remote_chassis_id=n.remote_chassis_id,
                remote_port_id=n.remote_port_id,
                remote_port_desc=n.remote_port_desc,
                remote_sys_name=n.remote_sys_name,
                remote_mgmt_addr=n.remote_mgmt_addr,
                matched_device_id=matched_id,
                dismissed=False,
                last_seen=now,
                created_at=now,
            )
            db.add(row)
            results.append(row)
    db.flush()
    return results
