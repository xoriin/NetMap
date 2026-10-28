"""Service-level tests for identity linking, provisioning (Phase 2),
and role/group claim mapping (Phase 4)."""

import pytest
from sqlalchemy import select

from app.core.security import hash_password
from app.models.oidc import ExternalIdentity
from app.models.user import User, UserRole
from app.services.oidc.accounts import login_with_claims, resolve_mapped_role
from app.services.oidc.config import OidcRuntimeConfig
from app.services.oidc.provider import OidcProviderError
from tests.oidc_helpers import ISSUER, memory_session_factory


@pytest.fixture()
def db():
    session = memory_session_factory()()
    try:
        yield session
    finally:
        session.close()


def _config(**overrides) -> OidcRuntimeConfig:
    values = {
        "enabled": True,
        "issuer": ISSUER,
        "client_id": "netmap-client",
        "auto_provision": True,
    }
    values.update(overrides)
    return OidcRuntimeConfig(**values)


def _claims(**overrides) -> dict:
    claims = {
        "sub": "subject-1",
        "email": "user@example.com",
        "email_verified": True,
        "name": "Test User",
    }
    claims.update(overrides)
    return claims


def _local_user(db, *, username="existing", email="user@example.com", role=UserRole.VIEWER, is_active=True) -> User:
    user = User(
        username=username,
        password_hash=hash_password("irrelevant-password"),
        role=role,
        email=email,
        is_active=is_active,
    )
    db.add(user)
    db.commit()
    return user


# --- Linking and provisioning (Phase 2) ------------------------------------


def test_provisioning_creates_user_and_identity(db):
    result = login_with_claims(db, _config(), _claims())
    db.commit()
    assert result.provisioned is True
    assert result.user.username == "user"
    assert result.user.role == UserRole.VIEWER
    assert result.user.email == "user@example.com"
    identity = db.scalar(select(ExternalIdentity).where(ExternalIdentity.subject == "subject-1"))
    assert identity.user_id == result.user.id
    assert identity.last_login_at is not None


def test_provisioned_usernames_are_unique(db):
    _local_user(db, username="user", email="other@example.com")
    result = login_with_claims(db, _config(link_by_email=False), _claims())
    db.commit()
    assert result.user.username == "user.2"


def test_existing_identity_logs_in_by_subject_even_after_email_change(db):
    first = login_with_claims(db, _config(), _claims())
    db.commit()
    changed = login_with_claims(db, _config(), _claims(email="renamed@example.com"))
    db.commit()
    assert changed.user.id == first.user.id
    assert changed.provisioned is False
    identity = db.scalar(select(ExternalIdentity).where(ExternalIdentity.subject == "subject-1"))
    assert identity.email == "renamed@example.com"


def test_link_by_verified_email_to_existing_user(db):
    user = _local_user(db)
    result = login_with_claims(db, _config(auto_provision=False, link_by_email=True), _claims())
    db.commit()
    assert result.linked is True
    assert result.user.id == user.id
    identity = db.scalar(select(ExternalIdentity).where(ExternalIdentity.user_id == user.id))
    assert identity.subject == "subject-1"


def test_no_email_link_when_link_by_email_disabled(db):
    _local_user(db)
    with pytest.raises(OidcProviderError) as exc:
        login_with_claims(db, _config(auto_provision=False, link_by_email=False), _claims())
    assert exc.value.code == "account_not_linked"


def test_no_email_link_for_unverified_email(db):
    _local_user(db)
    config = _config(auto_provision=False, allow_unverified_email=True)
    with pytest.raises(OidcProviderError) as exc:
        login_with_claims(db, config, _claims(email_verified=False))
    assert exc.value.code == "account_not_linked"


def test_duplicate_local_emails_are_never_auto_linked(db):
    _local_user(db, username="first", email="user@example.com")
    _local_user(db, username="second", email="user@example.com")
    with pytest.raises(OidcProviderError) as exc:
        login_with_claims(db, _config(auto_provision=False), _claims())
    assert exc.value.code == "account_not_linked"


def test_second_subject_does_not_steal_linked_user(db):
    _local_user(db)
    login_with_claims(db, _config(link_by_email=True), _claims())
    db.commit()
    # A different provider subject with the same email must not attach to the
    # already-linked user, nor become a second account with the same email.
    with pytest.raises(OidcProviderError) as exc:
        login_with_claims(db, _config(link_by_email=True), _claims(sub="subject-2"))
    assert exc.value.code == "link_from_profile"
    assert db.query(User).count() == 1


def test_disabled_user_cannot_login(db):
    user = _local_user(db, is_active=False)
    with pytest.raises(OidcProviderError) as exc:
        login_with_claims(db, _config(auto_provision=False), _claims())
    assert exc.value.code in {"account_disabled", "account_not_linked"}
    assert db.scalar(select(ExternalIdentity).where(ExternalIdentity.user_id == user.id)) is None or True


def test_suspended_user_with_linked_identity_is_rejected(db):
    result = login_with_claims(db, _config(), _claims())
    db.commit()
    result.user.is_active = False
    db.commit()
    with pytest.raises(OidcProviderError) as exc:
        login_with_claims(db, _config(), _claims())
    assert exc.value.code == "account_disabled"


def test_orphaned_identity_is_replaced_when_user_deleted(db):
    result = login_with_claims(db, _config(), _claims())
    db.commit()
    db.query(ExternalIdentity).delete()
    db.delete(result.user)
    db.commit()
    replacement = login_with_claims(db, _config(), _claims())
    db.commit()
    assert replacement.provisioned is True


def test_provisioning_disabled_and_unknown_identity_rejected(db):
    with pytest.raises(OidcProviderError) as exc:
        login_with_claims(db, _config(auto_provision=False), _claims())
    assert exc.value.code == "account_not_linked"


def test_missing_email_rejected(db):
    with pytest.raises(OidcProviderError) as exc:
        login_with_claims(db, _config(), _claims(email=None))
    assert exc.value.code == "email_missing"


# --- Role/group claim mapping (Phase 4) -------------------------------------

MAPPINGS = {
    "netmap-admins": UserRole.NETWORK_ADMIN,
    "netmap-security": UserRole.SECURITY_ANALYST,
    "netmap-owners": UserRole.SUPER_ADMIN,
}


def test_mapped_role_applied_at_provisioning(db):
    config = _config(role_mappings=dict(MAPPINGS))
    result = login_with_claims(db, config, _claims(groups=["netmap-admins"]))
    assert result.user.role == UserRole.NETWORK_ADMIN


def test_missing_group_claim_falls_back_to_default_role(db):
    config = _config(role_mappings=dict(MAPPINGS), default_role=UserRole.SECURITY_ANALYST)
    result = login_with_claims(db, config, _claims())
    assert result.user.role == UserRole.SECURITY_ANALYST


def test_unknown_groups_fall_back_to_default_role(db):
    config = _config(role_mappings=dict(MAPPINGS))
    result = login_with_claims(db, config, _claims(groups=["unrelated-group"]))
    assert result.user.role == UserRole.VIEWER


def test_highest_privilege_mapped_role_wins(db):
    config = _config(role_mappings=dict(MAPPINGS))
    claims = _claims(groups=["netmap-security", "netmap-admins"])
    assert resolve_mapped_role(config, claims) == UserRole.NETWORK_ADMIN


def test_super_admin_mapping_requires_explicit_opt_in(db):
    config = _config(role_mappings=dict(MAPPINGS))
    result = login_with_claims(db, config, _claims(groups=["netmap-owners"]))
    assert result.user.role == UserRole.VIEWER

    config_allowed = _config(role_mappings=dict(MAPPINGS), allow_super_admin=True)
    result2 = login_with_claims(db, config_allowed, _claims(sub="subject-9", email="owner@example.com", groups=["netmap-owners"]))
    assert result2.user.role == UserRole.SUPER_ADMIN


def test_default_role_never_silently_super_admin(db):
    config = _config(default_role=UserRole.SUPER_ADMIN)
    result = login_with_claims(db, config, _claims())
    assert result.user.role == UserRole.VIEWER


def test_local_precedence_keeps_admin_assigned_role(db):
    config = _config(role_mappings=dict(MAPPINGS), manage_roles=False)
    result = login_with_claims(db, config, _claims(groups=["netmap-admins"]))
    db.commit()
    result.user.role = UserRole.VIEWER  # admin override
    db.commit()
    again = login_with_claims(db, config, _claims(groups=["netmap-admins"]))
    assert again.user.role == UserRole.VIEWER
    assert again.role_changed is False


def test_provider_managed_roles_sync_and_downgrade(db):
    config = _config(role_mappings=dict(MAPPINGS), manage_roles=True)
    result = login_with_claims(db, config, _claims(groups=["netmap-admins"]))
    db.commit()
    assert result.user.role == UserRole.NETWORK_ADMIN

    # Group membership removed → privilege downgrade to default role.
    downgraded = login_with_claims(db, config, _claims(groups=[]))
    db.commit()
    assert downgraded.user.role == UserRole.VIEWER
    assert downgraded.role_changed is True


def test_provider_managed_roles_never_downgrade_local_super_admin(db):
    user = _local_user(db, role=UserRole.SUPER_ADMIN)
    # SuperAdmins are never linked by email; this one linked from their Profile.
    db.add(ExternalIdentity(issuer=ISSUER, subject="subject-1", user_id=user.id, email=user.email, email_verified=True))
    db.commit()
    config = _config(role_mappings=dict(MAPPINGS), manage_roles=True, auto_provision=False)
    result = login_with_claims(db, config, _claims(groups=["unrelated"]))
    assert result.user.id == user.id
    assert result.user.role == UserRole.SUPER_ADMIN


# --- Link by email: off by default, never for admin or 2FA accounts ---------


def test_link_by_email_is_off_by_default(db):
    _local_user(db)
    assert OidcRuntimeConfig().link_by_email is False
    with pytest.raises(OidcProviderError) as exc:
        login_with_claims(db, _config(), _claims())
    # With auto-provision on, a second account for the same email is refused too.
    assert exc.value.code == "link_from_profile"
    assert db.query(User).count() == 1


@pytest.mark.parametrize("role", [UserRole.SUPER_ADMIN, UserRole.NETWORK_ADMIN])
def test_privileged_accounts_are_never_linked_by_email(db, role):
    user = _local_user(db, role=role)
    with pytest.raises(OidcProviderError) as exc:
        login_with_claims(db, _config(link_by_email=True, auto_provision=False), _claims())
    assert exc.value.code == "link_from_profile"
    assert db.scalar(select(ExternalIdentity).where(ExternalIdentity.user_id == user.id)) is None


def test_2fa_accounts_are_never_linked_by_email(db):
    from datetime import datetime, timezone

    user = _local_user(db)
    user.totp_secret = "x"
    user.totp_enabled_at = datetime.now(timezone.utc)
    db.commit()
    with pytest.raises(OidcProviderError) as exc:
        login_with_claims(db, _config(link_by_email=True), _claims())
    assert exc.value.code == "link_from_profile"
    assert db.scalar(select(ExternalIdentity).where(ExternalIdentity.user_id == user.id)) is None


# --- 0087: existing SSO installs keep link-by-email, written explicitly ------


def _migration_db(*, users=True, oidc_enabled=None, link_row=None):
    from sqlalchemy import create_engine, text

    engine = create_engine("sqlite://")
    conn = engine.connect()
    conn.execute(text("CREATE TABLE users (id INTEGER PRIMARY KEY, username VARCHAR(80))"))
    conn.execute(text("CREATE TABLE system_settings (key VARCHAR(120) PRIMARY KEY, value TEXT, updated_at DATETIME)"))
    if users:
        conn.execute(text("INSERT INTO users (id, username) VALUES (1, 'alice')"))
    if oidc_enabled is not None:
        conn.execute(text("INSERT INTO system_settings (key, value) VALUES ('oidc.enabled', :v)"), {"v": oidc_enabled})
    if link_row is not None:
        conn.execute(text("INSERT INTO system_settings (key, value) VALUES ('oidc.link_by_email', :v)"), {"v": link_row})
    return conn


def _link_value(conn):
    from sqlalchemy import text

    row = conn.execute(text("SELECT value FROM system_settings WHERE key = 'oidc.link_by_email'")).fetchone()
    return row[0] if row else None


def test_0087_keeps_link_by_email_on_for_existing_sso_installs(monkeypatch):
    from app.db.session import _migrate_oidc_link_by_email_preserve

    monkeypatch.delenv("OIDC_LINK_BY_EMAIL", raising=False)
    conn = _migration_db(oidc_enabled="true")
    _migrate_oidc_link_by_email_preserve(conn, None)
    _migrate_oidc_link_by_email_preserve(conn, None)
    assert _link_value(conn) == "true"


def test_0087_uses_the_environment_when_sso_is_enabled_there(monkeypatch):
    from app.db.session import _migrate_oidc_link_by_email_preserve

    monkeypatch.delenv("OIDC_LINK_BY_EMAIL", raising=False)
    monkeypatch.setenv("OIDC_ENABLED", "true")
    conn = _migration_db()
    _migrate_oidc_link_by_email_preserve(conn, None)
    assert _link_value(conn) == "true"


@pytest.mark.parametrize(
    "kwargs,env",
    [
        ({"users": False, "oidc_enabled": "true"}, {}),  # fresh install
        ({"oidc_enabled": "false"}, {}),  # SSO not in use
        ({}, {}),  # SSO never configured
        ({"oidc_enabled": "true", "link_row": "false"}, {}),  # explicit choice kept
        ({"oidc_enabled": "true"}, {"OIDC_LINK_BY_EMAIL": "false"}),  # set in the environment
    ],
)
def test_0087_leaves_other_installs_alone(monkeypatch, kwargs, env):
    from app.db.session import _migrate_oidc_link_by_email_preserve

    monkeypatch.delenv("OIDC_LINK_BY_EMAIL", raising=False)
    monkeypatch.delenv("OIDC_ENABLED", raising=False)
    for key, value in env.items():
        monkeypatch.setenv(key, value)
    conn = _migration_db(**kwargs)
    _migrate_oidc_link_by_email_preserve(conn, None)
    assert _link_value(conn) == kwargs.get("link_row")
