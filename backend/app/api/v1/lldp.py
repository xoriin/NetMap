from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import require_tools_active, require_tools_passive, require_topology_write
from app.db.session import get_db
from app.models.device import Device
from app.models.lldp import LldpNeighbour
from app.models.relationship import DeviceRelationship
from app.models.user import User
from app.schemas.lldp import LldpNeighbourPatch, LldpNeighbourRead, LldpScanResult
from app.services.lldp import upsert_lldp_neighbours, walk_lldp_neighbours
from app.services.snmp import SnmpError

router = APIRouter(prefix="/lldp", tags=["lldp"])


def _get_snmp_creds(device: Device, db: Session) -> tuple[Any, int]:
    """Return (v2c community or SNMPv3 credentials, port) from the device's SNMP profile, or raise 422."""
    if device.snmp_profile_id is None:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Device has no SNMP credential profile assigned.",
        )
    from app.models.snmp_profile import SnmpProfile
    from app.services.snmp_profiles import profile_credentials
    profile = db.get(SnmpProfile, device.snmp_profile_id)
    if profile is None:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="SNMP credential profile not found.",
        )
    return profile_credentials(profile), profile.port


@router.post("/scan/{device_id}", response_model=LldpScanResult)
def scan_lldp(
    device_id: int,
    db: Annotated[Session, Depends(get_db)],
    current_user: Annotated[User, Depends(require_tools_active)],
) -> LldpScanResult:
    device = db.get(Device, device_id)
    if device is None:
        raise HTTPException(status_code=404, detail="Device not found.")

    community, snmp_port = _get_snmp_creds(device, db)

    try:
        neighbours = walk_lldp_neighbours(
            device.ip_address,
            community,
            port=snmp_port,
            timeout_seconds=5,
        )
    except (SnmpError, TimeoutError, OSError) as exc:
        return LldpScanResult(
            source_device_id=device_id,
            neighbours=[],
            error=str(exc),
        )

    rows = upsert_lldp_neighbours(db, device_id, neighbours)
    db.commit()
    return LldpScanResult(
        source_device_id=device_id,
        neighbours=[LldpNeighbourRead.model_validate(r) for r in rows],
    )


@router.get("/neighbours", response_model=list[LldpNeighbourRead])
def list_neighbours(
    db: Annotated[Session, Depends(get_db)],
    current_user: Annotated[User, Depends(require_tools_passive)],
    source_device_id: int | None = None,
    dismissed: bool | None = None,
) -> list[LldpNeighbour]:
    q = select(LldpNeighbour)
    if source_device_id is not None:
        q = q.where(LldpNeighbour.source_device_id == source_device_id)
    if dismissed is not None:
        q = q.where(LldpNeighbour.dismissed == dismissed)
    q = q.order_by(LldpNeighbour.last_seen.desc())
    return list(db.scalars(q).all())


@router.patch("/neighbours/{neighbour_id}", response_model=LldpNeighbourRead)
def patch_neighbour(
    neighbour_id: int,
    payload: LldpNeighbourPatch,
    db: Annotated[Session, Depends(get_db)],
    current_user: Annotated[User, Depends(require_tools_active)],
) -> LldpNeighbour:
    row = db.get(LldpNeighbour, neighbour_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Neighbour not found.")
    if payload.dismissed is not None:
        row.dismissed = payload.dismissed
    if payload.matched_device_id is not None:
        if db.get(Device, payload.matched_device_id) is None:
            raise HTTPException(status_code=422, detail="Matched device not found.")
        row.matched_device_id = payload.matched_device_id
    db.commit()
    db.refresh(row)
    return row


@router.post("/neighbours/{neighbour_id}/create-link", response_model=dict)
def create_link_from_neighbour(
    neighbour_id: int,
    db: Annotated[Session, Depends(get_db)],
    current_user: Annotated[User, Depends(require_topology_write)],
) -> dict:
    row = db.get(LldpNeighbour, neighbour_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Neighbour not found.")
    if row.matched_device_id is None:
        raise HTTPException(
            status_code=422,
            detail="No matched device — assign a device before creating a link.",
        )

    # Check for an existing relationship in either direction
    existing = db.scalars(
        select(DeviceRelationship).where(
            (
                (DeviceRelationship.source_device_id == row.source_device_id)
                & (DeviceRelationship.target_device_id == row.matched_device_id)
            ) | (
                (DeviceRelationship.source_device_id == row.matched_device_id)
                & (DeviceRelationship.target_device_id == row.source_device_id)
            )
        ).limit(1)
    ).first()

    if existing:
        return {"relationship_id": existing.id, "created": False}

    port_label = row.local_port_desc or row.local_port_id or f"port {row.local_port_index}"
    rel = DeviceRelationship(
        source_device_id=row.source_device_id,
        target_device_id=row.matched_device_id,
        relationship_type="link",
        notes=f"LLDP: {port_label}",
    )
    db.add(rel)
    db.commit()
    db.refresh(rel)
    return {"relationship_id": rel.id, "created": True}
