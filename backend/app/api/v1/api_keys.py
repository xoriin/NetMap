from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy.orm import Session

from app.api.deps import get_current_user, require_super_admin
from app.core.network import request_client_ip
from app.db.session import get_db
from app.models.user import User
from app.schemas.api_key import ApiKeyAdminRead, ApiKeyCreateRequest, ApiKeyCreateResponse, ApiKeyRead
from app.services.api_keys.service import (
    create_api_key,
    get_key,
    list_all_keys,
    list_keys_for_user,
    revoke_key,
)
from app.services.audit.service import write_audit

router = APIRouter(prefix="/api-keys", tags=["api-keys"])


@router.post("", response_model=ApiKeyCreateResponse, status_code=status.HTTP_201_CREATED)
def create_key(
    payload: ApiKeyCreateRequest,
    current_user: Annotated[User, Depends(get_current_user)],
    request: Request,
    db: Annotated[Session, Depends(get_db)],
) -> ApiKeyCreateResponse:
    key, plaintext = create_api_key(
        db,
        current_user,
        name=payload.name.strip(),
        expires_in_days=payload.expires_in_days,
        created_ip=request_client_ip(request),
    )
    write_audit(
        db,
        action="apikey.created",
        actor_user_id=current_user.id,
        target=f"apikey:{key.id}",
        detail=f"name={key.name} expires={key.expires_at.isoformat() if key.expires_at else 'never'}",
    )
    db.commit()
    db.refresh(key)
    return ApiKeyCreateResponse(
        id=key.id,
        name=key.name,
        prefix=key.prefix,
        created_at=key.created_at,
        expires_at=key.expires_at,
        last_used_at=key.last_used_at,
        last_used_ip=key.last_used_ip,
        revoked_at=key.revoked_at,
        key=plaintext,
    )


@router.get("", response_model=list[ApiKeyRead])
def list_my_keys(
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
) -> list[ApiKeyRead]:
    return [ApiKeyRead.model_validate(key) for key in list_keys_for_user(db, current_user.id)]


@router.delete("/admin/{key_id}", status_code=status.HTTP_204_NO_CONTENT)
def admin_revoke_key(
    key_id: int,
    current_user: Annotated[User, Depends(require_super_admin)],
    db: Annotated[Session, Depends(get_db)],
) -> None:
    key = get_key(db, key_id)
    if key is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="API key not found")
    revoke_key(db, key, reason=f"revoked by admin:{current_user.id}")
    write_audit(
        db,
        action="apikey.revoked",
        actor_user_id=current_user.id,
        target=f"apikey:{key.id}",
        detail=f"revoked_by=admin:{current_user.id} owner_user_id={key.user_id}",
    )
    db.commit()


@router.get("/admin/all", response_model=list[ApiKeyAdminRead])
def admin_list_all_keys(
    _current_user: Annotated[User, Depends(require_super_admin)],
    db: Annotated[Session, Depends(get_db)],
) -> list[ApiKeyAdminRead]:
    return [
        ApiKeyAdminRead(
            id=key.id,
            name=key.name,
            prefix=key.prefix,
            created_at=key.created_at,
            expires_at=key.expires_at,
            last_used_at=key.last_used_at,
            last_used_ip=key.last_used_ip,
            revoked_at=key.revoked_at,
            user_id=key.user_id,
            username=username,
        )
        for key, username in list_all_keys(db)
    ]


@router.delete("/{key_id}", status_code=status.HTTP_204_NO_CONTENT)
def revoke_my_key(
    key_id: int,
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
) -> None:
    key = get_key(db, key_id)
    if key is None or key.user_id != current_user.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="API key not found")
    revoke_key(db, key, reason="revoked by owner")
    write_audit(
        db,
        action="apikey.revoked",
        actor_user_id=current_user.id,
        target=f"apikey:{key.id}",
        detail="revoked_by=self",
    )
    db.commit()
