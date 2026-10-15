from unittest.mock import Mock

import anyio
import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from starlette.requests import Request

from app.api.deps import get_db, require_backup_manage, require_super_admin
from app.api.v1 import exports
from app.services.exports.service import ENCRYPTED_BACKUP_MAGIC


def _request(chunks: list[bytes], content_length: str | None = None) -> Request:
    messages = iter(
        {
            "type": "http.request",
            "body": chunk,
            "more_body": index < len(chunks) - 1,
        }
        for index, chunk in enumerate(chunks)
    )

    async def receive():
        return next(messages)

    headers = [] if content_length is None else [(b"content-length", content_length.encode())]
    return Request({"type": "http", "method": "POST", "path": "/", "headers": headers}, receive)


def test_backup_upload_rejects_declared_oversize_before_reading(monkeypatch):
    monkeypatch.setattr(exports, "MAX_BACKUP_SIZE", 8)
    with pytest.raises(HTTPException) as raised:
        anyio.run(exports._read_backup_payload, _request([b"unused"], "9"))
    assert raised.value.status_code == 413


def test_backup_upload_stops_stream_when_limit_is_crossed(monkeypatch):
    monkeypatch.setattr(exports, "MAX_BACKUP_SIZE", 8)
    with pytest.raises(HTTPException) as raised:
        anyio.run(exports._read_backup_payload, _request([b"12345", b"6789"]))
    assert raised.value.status_code == 413


def _client(user, db) -> TestClient:
    app = FastAPI()
    app.include_router(exports.router, prefix="/api/v1")
    app.dependency_overrides[require_backup_manage] = lambda: user
    app.dependency_overrides[require_super_admin] = lambda: user
    app.dependency_overrides[get_db] = lambda: db
    return TestClient(app)


def test_encrypted_backup_endpoint_never_audits_passphrase(monkeypatch):
    user = Mock(id=7)
    db = Mock()
    audit = Mock()
    monkeypatch.setattr(exports, "write_audit", audit)
    monkeypatch.setattr(
        exports,
        "encrypted_backup_database_bytes",
        lambda passphrase: ("netmap-backup-test.nmbak", ENCRYPTED_BACKUP_MAGIC + b"encrypted"),
    )

    response = _client(user, db).post(
        "/api/v1/exports/backup/encrypted",
        json={"passphrase": "correct horse battery staple"},
    )

    assert response.status_code == 200
    assert response.content.startswith(ENCRYPTED_BACKUP_MAGIC)
    assert "netmap-backup-test.nmbak" in response.headers["content-disposition"]
    assert "correct horse battery staple" not in repr(audit.call_args)


def test_restore_validation_passes_header_only_to_decryption(monkeypatch):
    user = Mock(id=7)
    db = Mock()
    validate = Mock(return_value={
        "valid": True,
        "encrypted": True,
        "size_bytes": 10,
        "table_count": 4,
    })
    monkeypatch.setattr(exports, "validate_restore_bytes", validate)
    payload = ENCRYPTED_BACKUP_MAGIC + b"encrypted"

    response = _client(user, db).post(
        "/api/v1/exports/restore/validate",
        content=payload,
        headers={
            "Content-Type": "application/octet-stream",
            "X-NetMap-Backup-Passphrase": "correct horse battery staple",
        },
    )

    assert response.status_code == 200
    assert response.json()["encrypted"] is True
    validate.assert_called_once_with(payload, "correct horse battery staple")
