from pydantic import BaseModel

from app.schemas.datetimes import UtcDatetime


class LldpNeighbourRead(BaseModel):
    id: int
    source_device_id: int
    local_port_index: int
    local_port_id: str | None
    local_port_desc: str | None
    remote_chassis_id: str
    remote_port_id: str | None
    remote_port_desc: str | None
    remote_sys_name: str | None
    remote_mgmt_addr: str | None
    matched_device_id: int | None
    dismissed: bool
    last_seen: UtcDatetime
    created_at: UtcDatetime

    model_config = {"from_attributes": True}


class LldpNeighbourPatch(BaseModel):
    dismissed: bool | None = None
    matched_device_id: int | None = None


class LldpScanResult(BaseModel):
    source_device_id: int
    neighbours: list[LldpNeighbourRead]
    error: str | None = None
