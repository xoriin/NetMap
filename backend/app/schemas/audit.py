from pydantic import BaseModel, ConfigDict, Field

from app.schemas.datetimes import UtcDatetime


class AuditLogRead(BaseModel):
    id: int
    actor_user_id: int | None = None
    action: str
    target: str | None = None
    detail: str | None = None
    created_at: UtcDatetime

    model_config = ConfigDict(from_attributes=True)


class AuditLogList(BaseModel):
    total: int
    limit: int
    offset: int
    records: list[AuditLogRead] = Field(default_factory=list)


class AuditDay(BaseModel):
    date: str
    signed_in: int = 0
    failed: int = 0


class AuditActionCount(BaseModel):
    action: str
    count: int


class AuditActorCount(BaseModel):
    actor_user_id: int
    username: str
    count: int


class AuditSummary(BaseModel):
    days: list[AuditDay]
    by_action: list[AuditActionCount]
    by_actor: list[AuditActorCount]
    total: int
    failed_total: int
