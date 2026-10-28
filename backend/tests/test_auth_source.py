"""auth_source / sso_issuer / sso_last_login_at on every UserRead response,
not only the Admin -> Users list."""
from sqlalchemy import select

from app.core.security import hash_password
from app.models.oidc import ExternalIdentity
from app.models.user import User
from app.services.auth import issue_token_pair
from app.services.oidc.accounts import login_with_claims
from app.services.oidc.config import get_oidc_config
from tests.oidc_helpers import ISSUER
from tests.test_oidc_flow import _enable_oidc
from tests.test_oidc_flow import client_and_db as client_and_db_fixture

client_and_db = client_and_db_fixture

PASSWORD = "correct horse battery staple"


def _token(db, user):
    access, _refresh = issue_token_pair(db, user, client_ip=None)
    db.commit()
    return {"Authorization": f"Bearer {access}"}


def _provisioned(db):
    _enable_oidc(db, auto_provision="true")
    claims = {"sub": "sso-sub", "email": "sso@example.com", "email_verified": True}
    user = login_with_claims(db, get_oidc_config(db), claims).user
    db.commit()
    return user


def _local(db, *, linked=False):
    user = User(username="alice", email="alice@example.com", password_hash=hash_password(PASSWORD), role="Viewer", is_active=True)
    db.add(user)
    db.flush()
    if linked:
        db.add(ExternalIdentity(issuer=ISSUER, subject="subject-1", user_id=user.id, email="alice@example.com", email_verified=True))
    db.commit()
    return user


def test_me_reports_oidc_for_an_sso_provisioned_user(client_and_db):
    client, db = client_and_db
    user = _provisioned(db)
    body = client.get("/api/v1/auth/me", headers=_token(db, user)).json()
    assert body["auth_source"] == "oidc"
    assert body["sso_issuer"] == ISSUER
    assert body["sso_last_login_at"] is not None and body["sso_last_login_at"].endswith("Z")


def test_me_reports_oidc_for_a_local_user_who_linked_sso(client_and_db):
    client, db = client_and_db
    _enable_oidc(db)
    user = _local(db, linked=True)
    body = client.get("/api/v1/auth/me", headers=_token(db, user)).json()
    assert (body["auth_source"], body["sso_issuer"], body["sso_last_login_at"]) == ("oidc", ISSUER, None)


def test_me_reports_local_for_an_unlinked_user(client_and_db):
    client, db = client_and_db
    _enable_oidc(db)
    user = _local(db, linked=True)
    db.delete(db.scalar(select(ExternalIdentity).where(ExternalIdentity.user_id == user.id)))
    db.commit()
    body = client.get("/api/v1/auth/me", headers=_token(db, user)).json()
    assert (body["auth_source"], body["sso_issuer"], body["sso_last_login_at"]) == ("local", None, None)


def test_profile_and_admin_user_updates_report_the_same_source(client_and_db):
    client, db = client_and_db
    user = _provisioned(db)
    headers = _token(db, user)
    patched = client.patch("/api/v1/auth/me", json={"display_name": "SSO person"}, headers=headers).json()
    assert patched["auth_source"] == "oidc" and patched["sso_issuer"] == ISSUER
    acknowledged = client.post("/api/v1/auth/me/acknowledge-whats-new", headers=headers)
    if acknowledged.status_code == 200:
        assert acknowledged.json()["auth_source"] == "oidc"
    admin = User(username="root", password_hash=hash_password(PASSWORD), role="SuperAdmin", is_active=True)
    db.add(admin)
    db.commit()
    updated = client.patch(f"/api/v1/auth/users/{user.id}", json={"role": "NetworkAdmin"}, headers=_token(db, admin)).json()
    assert updated["auth_source"] == "oidc" and updated["sso_issuer"] == ISSUER
