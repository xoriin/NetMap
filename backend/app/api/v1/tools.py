from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.api.deps import require_tools_active, require_tools_passive
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
    ping_host,
    reverse_dns,
    subnet_calculate,
    tcp_port_check,
    traceroute_host,
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
