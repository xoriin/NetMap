"""0089: users.has_local_password, false only for SSO-created accounts that
never had a password set."""
from sqlalchemy import create_engine, text

from app.db.session import _live_columns, _migrate_user_has_local_password


def _legacy(conn):
    conn.execute(text("CREATE TABLE users (id INTEGER PRIMARY KEY, username VARCHAR(80), password_hash VARCHAR(255))"))
    conn.execute(
        text("CREATE TABLE audit_log (id INTEGER PRIMARY KEY, action VARCHAR(80), target VARCHAR(255), created_at DATETIME)")
    )
    users = ["local", "sso_only", "sso_then_reset", "sso_then_self_reset", "sso_reset_before_reprovision"]
    for i, name in enumerate(users, start=1):
        conn.execute(text("INSERT INTO users (id, username, password_hash) VALUES (:i, :n, 'h')"), {"i": i, "n": name})
    audit = [
        ("auth.user_created", "user:local", "2026-01-01 00:00:00"),
        ("auth.oidc_user_provisioned", "user:sso_only", "2026-01-02 00:00:00"),
        ("auth.oidc_login_success", "user:sso_only", "2026-01-03 00:00:00"),
        ("auth.oidc_user_provisioned", "user:sso_then_reset", "2026-01-02 00:00:00"),
        ("auth.admin_password_reset", "user:sso_then_reset", "2026-01-04 00:00:00"),
        ("auth.oidc_user_provisioned", "user:sso_then_self_reset", "2026-01-02 00:00:00"),
        ("auth.password_reset_self_service", "user:sso_then_self_reset", "2026-01-05 00:00:00"),
        # A password event from before a later re-provisioning of the same name does not count.
        ("auth.admin_password_reset", "user:sso_reset_before_reprovision", "2026-01-01 00:00:00"),
        ("auth.oidc_user_provisioned", "user:sso_reset_before_reprovision", "2026-01-06 00:00:00"),
    ]
    for action, target, at in audit:
        conn.execute(
            text("INSERT INTO audit_log (action, target, created_at) VALUES (:a, :t, :c)"), {"a": action, "t": target, "c": at}
        )


def _flags(conn):
    return dict(conn.execute(text("SELECT username, has_local_password FROM users ORDER BY id")).fetchall())


def test_0089_backfills_only_passwordless_sso_accounts_and_is_idempotent():
    engine = create_engine("sqlite://")
    with engine.begin() as conn:
        _legacy(conn)
        _migrate_user_has_local_password(conn, None)
        expected = {
            "local": 1,
            "sso_only": 0,
            "sso_then_reset": 1,
            "sso_then_self_reset": 1,
            "sso_reset_before_reprovision": 0,
        }
        assert _flags(conn) == expected
        # A later password set must survive a rerun, and the rerun changes nothing.
        conn.execute(text("UPDATE users SET has_local_password = 1 WHERE username = 'sso_only'"))
        _migrate_user_has_local_password(conn, None)
        assert _flags(conn) == {**expected, "sso_only": 1}
        assert conn.execute(text("SELECT count(*), min(password_hash) FROM users")).fetchone() == (5, "h")


def test_0089_fresh_install_and_missing_audit_table():
    engine = create_engine("sqlite://")
    with engine.begin() as conn:
        _migrate_user_has_local_password(conn, None)  # before create_all: no users table, no-op
        conn.execute(text("CREATE TABLE users (id INTEGER PRIMARY KEY, username VARCHAR(80))"))
        conn.execute(text("INSERT INTO users (id, username) VALUES (1, 'kept')"))
        _migrate_user_has_local_password(conn, None)
        assert "has_local_password" in _live_columns(conn, "users")
        assert _flags(conn) == {"kept": 1}


def test_new_users_default_to_having_a_password():
    from app.core.security import hash_password
    from app.models.user import User
    from tests.test_oidc_flow import memory_session_factory

    db = memory_session_factory()()
    user = User(username="bob", password_hash=hash_password("correct horse battery"), role="Viewer", is_active=True)
    db.add(user)
    db.commit()
    assert user.has_local_password is True
