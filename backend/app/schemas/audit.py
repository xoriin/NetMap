from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field


class AuditLogRead(BaseModel):
    id: int
    actor_user_id: int | None = None
    action: str
    target: str | None = None
    detail: str | None = None
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)


class AuditLogList(BaseModel):
    total: int
    limit: int
    offset: int
    records: list[AuditLogRead] = Field(default_factory=list)
