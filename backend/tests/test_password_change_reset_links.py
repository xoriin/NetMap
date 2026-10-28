"""A reset link issued before a password change must not work afterwards."""
from app.core.security import create_password_reset_token
from app.models.password_reset_token import PasswordResetToken
from tests.test_session_version import PASSWORD, _login, _user
from tests.test_session_version import client_and_db as client_and_db_fixture

client_and_db = client_and_db_fixture


def test_password_change_invalidates_pending_reset_links(client_and_db):
    from app.api.v1 import auth as auth_api

    client, db = client_and_db
    user = _user(db)
    reset_token = create_password_reset_token(user.id)
    auth_api._store_reset_token(db, reset_token, user.id)
    db.commit()
    access, _ = _login(client)
    changed = client.post(
        "/api/v1/auth/change-password",
        headers={"Authorization": f"Bearer {access}"},
        json={"current_password": PASSWORD, "new_password": "another long password"},
    )
    assert changed.status_code == 204, changed.text
    db.expire_all()
    assert db.query(PasswordResetToken).one().used_at is not None
    reused = client.post("/api/v1/auth/reset-password", json={"reset_token": reset_token, "new_password": "attacker password!!"})
    assert reused.status_code == 400
