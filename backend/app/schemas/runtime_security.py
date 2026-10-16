from pydantic import BaseModel


class RuntimeSecurityStatusRead(BaseModel):
    warnings: list[str]
