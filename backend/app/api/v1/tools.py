from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import require_super_admin, require_tools_active, require_tools_passive
from app.api.v1.admin import load_settings
from app.db.session import get_db
from app.models.user import User
from app.schemas.tools import (
    DnsLookupRequest,
    DnsLookupResult,
    PingRequest,
    PingResult,
    ReverseDnsRequest,
    ReverseDnsResult,
    SnmpProbeRequest,
    SnmpProbeResult,
    SnmpProfileCreate,
    SnmpProfileRead,
    SnmpProfileUpdate,
    SubnetCalculatorRequest,
    SubnetCalculatorResult,
    TcpPortCheckRequest,
    TcpPortCheckResult,
    TracerouteRequest,
    TracerouteResult,
)
from app.services.audit.service import write_audit
from app.core.capabilities import ActiveNetworkToolUnavailable
from app.services.tools.service import (
    dns_lookup,
    enforce_rate_limit,
    ensure_active_target_allowed,
    ping_host,
    reverse_dns,
    subnet_calculate,
    tcp_port_check,
    traceroute_host,
)
from app.services.snmp import SnmpError, probe_snmp_v2c
from app.models.snmp_profile import SnmpProfile
from app.services.snmp_profiles import (
    create_profile,
    decrypt_profile_community,
    profile_to_dict,
    update_profile,
)

router = APIRouter(prefix="/tools", tags=["tools"])


def _enforce_tool_rate_limit(user_id: int) -> None:
    try:
        enforce_rate_limit(user_id)
    except RuntimeError as exc:
        raise HTTPException(status_code=status.HTTP_429_TOO_MANY_REQUESTS, detail=str(exc)) from exc


def _public_active_targets_enabled(db: Session) -> bool:
    value = load_settings(db).get("active_network_public_targets_enabled", "false")
    return str(value).lower() not in ("false", "0", "")


@router.post("/dns", response_model=DnsLookupResult)
def lookup_dns(
    payload: DnsLookupRequest,
    current_user: Annotated[User, Depends(require_tools_passive)],
    db: Annotated[Session, Depends(get_db)],
) -> DnsLookupResult:
    _enforce_tool_rate_limit(current_user.id)
    try:
        return dns_lookup(payload)
    except TimeoutError as exc:
        raise HTTPException(status_code=status.HTTP_504_GATEWAY_TIMEOUT, detail=str(exc)) from exc


@router.post("/reverse-dns", response_model=ReverseDnsResult)
def lookup_reverse_dns(
    payload: ReverseDnsRequest,
    current_user: Annotated[User, Depends(require_tools_passive)],
    db: Annotated[Session, Depends(get_db)],
) -> ReverseDnsResult:
    _enforce_tool_rate_limit(current_user.id)
    try:
        return reverse_dns(payload)
    except TimeoutError as exc:
        raise HTTPException(status_code=status.HTTP_504_GATEWAY_TIMEOUT, detail=str(exc)) from exc


@router.post("/ping", response_model=PingResult)
def run_ping(
    payload: PingRequest,
    current_user: Annotated[User, Depends(require_tools_active)],
    db: Annotated[Session, Depends(get_db)],
) -> PingResult:
    _enforce_tool_rate_limit(current_user.id)
    write_audit(
        db,
        action="tools.ping",
        actor_user_id=current_user.id,
        target=payload.host,
        detail=f"count={payload.count}",
    )
    db.commit()
    try:
        return ping_host(payload, allow_public_targets=_public_active_targets_enabled(db))
    except ActiveNetworkToolUnavailable as exc:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(exc)) from exc
    except FileNotFoundError as exc:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Ping is unavailable") from exc
    except TimeoutError as exc:
        raise HTTPException(status_code=status.HTTP_504_GATEWAY_TIMEOUT, detail="Ping timed out") from exc
    except Exception as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc


@router.post("/traceroute", response_model=TracerouteResult)
def run_traceroute(
    payload: TracerouteRequest,
    current_user: Annotated[User, Depends(require_tools_active)],
    db: Annotated[Session, Depends(get_db)],
) -> TracerouteResult:
    _enforce_tool_rate_limit(current_user.id)
    write_audit(
        db,
        action="tools.traceroute",
        actor_user_id=current_user.id,
        target=payload.host,
        detail=f"max_hops={payload.max_hops}",
    )
    db.commit()
    try:
        return traceroute_host(payload, allow_public_targets=_public_active_targets_enabled(db))
    except ActiveNetworkToolUnavailable as exc:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(exc)) from exc
    except FileNotFoundError as exc:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Traceroute is unavailable") from exc
    except TimeoutError as exc:
        raise HTTPException(status_code=status.HTTP_504_GATEWAY_TIMEOUT, detail="Traceroute timed out") from exc
    except Exception as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc


@router.post("/tcp-check", response_model=TcpPortCheckResult)
def run_tcp_check(
    payload: TcpPortCheckRequest,
    current_user: Annotated[User, Depends(require_tools_active)],
    db: Annotated[Session, Depends(get_db)],
) -> TcpPortCheckResult:
    _enforce_tool_rate_limit(current_user.id)
    write_audit(
        db,
        action="tools.tcp_check",
        actor_user_id=current_user.id,
        target=f"{payload.host}:{payload.port}",
    )
    db.commit()
    try:
        return tcp_port_check(payload, allow_public_targets=_public_active_targets_enabled(db))
    except Exception as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc


@router.post("/subnet", response_model=SubnetCalculatorResult)
def calculate_subnet(
    payload: SubnetCalculatorRequest,
    current_user: Annotated[User, Depends(require_tools_passive)],
    db: Annotated[Session, Depends(get_db)],
) -> SubnetCalculatorResult:
    _enforce_tool_rate_limit(current_user.id)
    return subnet_calculate(payload)


@router.post("/snmp/probe", response_model=SnmpProbeResult)
def run_snmp_probe(
    payload: SnmpProbeRequest,
    current_user: Annotated[User, Depends(require_tools_active)],
    db: Annotated[Session, Depends(get_db)],
) -> SnmpProbeResult:
    _enforce_tool_rate_limit(current_user.id)
    write_audit(
        db,
        action="tools.snmp_probe",
        actor_user_id=current_user.id,
        target=f"{payload.host}:{payload.port}",
    )
    db.commit()
    try:
        community = payload.community
        port = payload.port
        timeout_seconds = payload.timeout_seconds
        retries = 1
        if payload.profile_id is not None:
            profile = db.get(SnmpProfile, payload.profile_id)
            if profile is None:
                raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="SNMP profile not found")
            community = decrypt_profile_community(profile)
            port = profile.port
            timeout_seconds = profile.timeout_seconds
            retries = profile.retries
        if not community:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="SNMP community or profile is required")
        ensure_active_target_allowed(payload.host, allow_public_targets=_public_active_targets_enabled(db))
        return probe_snmp_v2c(
            payload.host,
            community,
            port=port,
            timeout_seconds=timeout_seconds,
            retries=retries,
        )
    except TimeoutError as exc:
        raise HTTPException(status_code=status.HTTP_504_GATEWAY_TIMEOUT, detail=str(exc)) from exc
    except SnmpError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc


@router.get("/snmp/profiles", response_model=list[SnmpProfileRead])
def list_snmp_profiles(
    _current_user: Annotated[User, Depends(require_tools_active)],
    db: Annotated[Session, Depends(get_db)],
) -> list[SnmpProfileRead]:
    profiles = db.scalars(select(SnmpProfile).order_by(SnmpProfile.name)).all()
    return [SnmpProfileRead(**profile_to_dict(profile)) for profile in profiles]


@router.post("/snmp/profiles", response_model=SnmpProfileRead, status_code=status.HTTP_201_CREATED)
def create_snmp_profile(
    payload: SnmpProfileCreate,
    current_user: Annotated[User, Depends(require_super_admin)],
    db: Annotated[Session, Depends(get_db)],
) -> SnmpProfileRead:
    profile = create_profile(
        db,
        name=payload.name.strip(),
        community=payload.community,
        port=payload.port,
        timeout_seconds=payload.timeout_seconds,
        retries=payload.retries,
    )
    db.flush()
    write_audit(
        db,
        action="tools.snmp_profile_created",
        actor_user_id=current_user.id,
        target=f"snmp_profile:{profile.id}",
        detail=profile.name,
    )
    db.commit()
    db.refresh(profile)
    return SnmpProfileRead(**profile_to_dict(profile))


@router.patch("/snmp/profiles/{profile_id}", response_model=SnmpProfileRead)
def update_snmp_profile(
    profile_id: int,
    payload: SnmpProfileUpdate,
    current_user: Annotated[User, Depends(require_super_admin)],
    db: Annotated[Session, Depends(get_db)],
) -> SnmpProfileRead:
    profile = db.get(SnmpProfile, profile_id)
    if profile is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="SNMP profile not found")
    update_profile(profile, **payload.model_dump(exclude_unset=True))
    write_audit(
        db,
        action="tools.snmp_profile_updated",
        actor_user_id=current_user.id,
        target=f"snmp_profile:{profile.id}",
        detail=profile.name,
    )
    db.commit()
    db.refresh(profile)
    return SnmpProfileRead(**profile_to_dict(profile))


@router.delete("/snmp/profiles/{profile_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_snmp_profile(
    profile_id: int,
    current_user: Annotated[User, Depends(require_super_admin)],
    db: Annotated[Session, Depends(get_db)],
) -> None:
    profile = db.get(SnmpProfile, profile_id)
    if profile is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="SNMP profile not found")
    write_audit(
        db,
        action="tools.snmp_profile_deleted",
        actor_user_id=current_user.id,
        target=f"snmp_profile:{profile.id}",
        detail=profile.name,
    )
    db.delete(profile)
    db.commit()
