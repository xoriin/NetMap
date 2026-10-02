import os
import subprocess
import sys
from pathlib import Path

import pyotp

from app import cli
from app.models.audit_log import AuditLog
from app.models.user import User
from app.services import totp
from tests.oidc_helpers import memory_session_factory


def _factory_with_enrolled_user():
    factory = memory_session_factory()
    db = factory()
    user = User(username="alice", password_hash="x", role="SuperAdmin", is_active=True)
    db.add(user)
    db.commit()
    secret, _ = totp.begin_enrolment(db, user)
    totp.confirm_enrolment(db, user, pyotp.TOTP(secret).now())
    db.commit()
    db.close()
    return factory


def test_refuses_to_run_as_non_root(monkeypatch, capsys):
    monkeypatch.setattr(cli.os, "geteuid", lambda: 1000)
    assert cli.main(["reset-2fa", "alice"], session_factory=_factory_with_enrolled_user()) == 2
    assert "must be run as root" in capsys.readouterr().err


def test_drops_privileges_before_touching_the_database(monkeypatch):
    calls = []
    monkeypatch.setattr(cli.os, "geteuid", lambda: 0)
    monkeypatch.setattr(cli, "_drop_privileges", lambda name: calls.append(("drop", name)))
    factory = _factory_with_enrolled_user()

    def tracking_factory():
        calls.append(("db", None))
        return factory()

    assert cli.main(["reset-2fa", "alice"], session_factory=tracking_factory) == 0
    assert calls[0] == ("drop", "netmap")


def test_resets_and_audits(monkeypatch, capsys):
    monkeypatch.setattr(cli.os, "geteuid", lambda: 0)
    monkeypatch.setattr(cli, "_drop_privileges", lambda name: None)
    factory = _factory_with_enrolled_user()
    assert cli.main(["reset-2fa", "alice"], session_factory=factory) == 0
    db = factory()
    assert db.query(User).filter_by(username="alice").one().totp_enabled is False
    audit = db.query(AuditLog).filter_by(action="auth.mfa_reset").one()
    assert audit.detail == "source=console"
    assert "Two-factor authentication reset for alice" in capsys.readouterr().out


def test_unknown_user_exits_non_zero(monkeypatch, capsys):
    monkeypatch.setattr(cli.os, "geteuid", lambda: 0)
    monkeypatch.setattr(cli, "_drop_privileges", lambda name: None)
    assert cli.main(["reset-2fa", "nobody"], session_factory=_factory_with_enrolled_user()) == 1
    assert "No user named nobody" in capsys.readouterr().err


def test_missing_netmap_user_exits_three(monkeypatch, capsys):
    monkeypatch.setattr(cli.os, "geteuid", lambda: 0)

    def missing(name):
        raise KeyError(name)

    monkeypatch.setattr(cli, "_drop_privileges", missing)
    assert cli.main(["reset-2fa", "alice"], session_factory=_factory_with_enrolled_user()) == 3
    assert "user 'netmap' not found" in capsys.readouterr().err


def test_cli_runs_in_a_fresh_interpreter(tmp_path):
    backend = Path(__file__).resolve().parent.parent
    env = {**os.environ, "DATABASE_URL": f"sqlite:///{tmp_path}/t.db"}
    seed = (
        "import pyotp\n"
        "from app.db.session import Base, SessionLocal, engine, import_all_models\n"
        "import_all_models()\n"
        "Base.metadata.create_all(bind=engine)\n"
        "from app.models.user import User\n"
        "from app.services import totp\n"
        "db = SessionLocal()\n"
        "u = User(username='alice', password_hash='x', role='SuperAdmin', is_active=True)\n"
        "db.add(u); db.commit()\n"
        "s, _ = totp.begin_enrolment(db, u)\n"
        "totp.confirm_enrolment(db, u, pyotp.TOTP(s).now())\n"
        "db.commit()\n"
    )
    run = (
        "import os\n"
        "os.geteuid = lambda: 0\n"
        "import app.cli as cli\n"
        "cli._drop_privileges = lambda name: None\n"
        "raise SystemExit(cli.main(['reset-2fa', 'alice']))\n"
    )
    first = subprocess.run([sys.executable, "-c", seed], cwd=backend, env=env, capture_output=True, text=True)
    assert first.returncode == 0, first.stderr
    second = subprocess.run([sys.executable, "-c", run], cwd=backend, env=env, capture_output=True, text=True)
    assert second.returncode == 0, second.stderr
