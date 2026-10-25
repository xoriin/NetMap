"""Personal chart views survive upgrades and remain isolated by account and chart."""

import pytest
from fastapi import HTTPException
from pydantic import ValidationError
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool
from app.db.session import Base, _migrate_chart_views, import_all_models

from app.models.user import User
from app.models.chart_view import ChartView
from app.schemas.chart_view import ChartViewOptions
from app.api.v1.chart_views import list_views, save_view, reset_view, reset_all_views


import_all_models()


def test_clean_and_legacy_migration_preserves_data():
    for fresh in (False, True):
        engine = create_engine("sqlite://")
        with engine.begin() as conn:
            if fresh:
                Base.metadata.create_all(conn, tables=[User.__table__, ChartView.__table__])
            else:
                conn.execute(text("CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT)"))
            if fresh:
                conn.execute(
                    User.__table__.insert().values(
                        id=1, username="keep", password_hash="x", role="Viewer"
                    )
                )
            else:
                conn.execute(text("INSERT INTO users (id, username) VALUES (1, 'keep')"))
            _migrate_chart_views(conn, inspect(conn))
            conn.execute(
                text(
                    "INSERT INTO user_chart_views VALUES (1, 'overview.health', '{\"type\":\"pie\"}')"
                )
            )
            _migrate_chart_views(conn, inspect(conn))
            assert (
                conn.execute(text("SELECT username FROM users WHERE id=1")).scalar_one() == "keep"
            )
            assert conn.execute(text("SELECT COUNT(*) FROM user_chart_views")).scalar_one() == 1
            assert set(
                inspect(conn).get_pk_constraint("user_chart_views")["constrained_columns"]
            ) == {"user_id", "chart_id"}


def test_preferences_are_atomic_per_chart_and_owned_by_current_user():
    engine = create_engine("sqlite://")
    Base.metadata.create_all(engine, tables=[User.__table__, ChartView.__table__])
    with Session(engine) as db:
        alice = User(username="alice", password_hash="x", role="Viewer")
        bob = User(username="bob", password_hash="x", role="Viewer")
        db.add_all([alice, bob])
        db.commit()
        save_view("overview.health", ChartViewOptions(type="pie"), alice, db)
        save_view("inventory.types", ChartViewOptions(type="bars"), alice, db)
        save_view("overview.health", ChartViewOptions(type="columns"), bob, db)
        save_view("overview.health", ChartViewOptions(type="area"), alice, db)
        assert list_views(alice, db)["overview.health"].type == "area"
        assert list_views(alice, db)["inventory.types"].type == "bars"
        reset_view("overview.health", alice, db)
        assert set(list_views(alice, db)) == {"inventory.types"}
        assert list_views(bob, db)["overview.health"].type == "columns"
        reset_all_views(alice, db)
        assert list_views(alice, db) == {}
        assert list_views(bob, db)
        with pytest.raises(HTTPException):
            save_view("invalid/chart", ChartViewOptions(), alice, db)


@pytest.mark.parametrize(
    "payload",
    [
        dict(type="script"),
        dict(version=99),
        dict(order="random"),
        dict(legend="true"),
        dict(extra="x"),
    ],
)
def test_options_are_bounded_and_strict(payload):
    with pytest.raises(ValidationError):
        ChartViewOptions(**payload)


def test_http_routes_require_a_session_and_never_accept_another_owner():
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from app.api.deps import get_current_user
    from app.api.v1.chart_views import router
    from app.db.session import get_db

    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    Base.metadata.create_all(engine, tables=[User.__table__, ChartView.__table__])
    with Session(engine) as db:
        user = User(username="viewer", password_hash="x", role="Viewer")
        db.add(user)
        db.commit()
        app = FastAPI()
        app.include_router(router)
        app.dependency_overrides[get_db] = lambda: db
        with TestClient(app) as client:
            assert client.get("/auth/me/chart-views").status_code == 401
            app.dependency_overrides[get_current_user] = lambda: user
            assert (
                client.put(
                    "/auth/me/chart-views/overview.health", json={"type": "pie", "user_id": 999}
                ).status_code
                == 422
            )
            assert (
                client.put("/auth/me/chart-views/overview.health", json={"type": "pie"}).status_code
                == 200
            )
            assert client.get("/auth/me/chart-views").json()["overview.health"]["type"] == "pie"
            assert client.delete("/auth/me/chart-views/overview.health").status_code == 204
            assert client.get("/auth/me/chart-views").json() == {}


def test_concurrent_different_chart_saves_preserve_each_override(tmp_path):
    from concurrent.futures import ThreadPoolExecutor

    engine = create_engine(f"sqlite:///{tmp_path / 'charts.db'}")
    Base.metadata.create_all(engine, tables=[User.__table__, ChartView.__table__])
    with Session(engine) as db:
        user = User(username="viewer", password_hash="x", role="Viewer")
        db.add(user)
        db.commit()
        user_id = user.id

    def save(index):
        with Session(engine) as db:
            save_view(
                f"test.chart-{index}", ChartViewOptions(type="bars"), db.get(User, user_id), db
            )

    with ThreadPoolExecutor(max_workers=4) as executor:
        list(executor.map(save, range(8)))
    with Session(engine) as db:
        assert len(list_views(db.get(User, user_id), db)) == 8
        db.add(ChartView(user_id=user_id, chart_id="retired.chart", options='{"version":99}'))
        db.commit()
        assert "retired.chart" not in list_views(db.get(User, user_id), db)


@pytest.mark.parametrize("position", ["top", "bottom", "left", "right", "side", "below"])
def test_legend_positions_round_trip_and_preserve_legacy_choices(position):
    engine = create_engine("sqlite://")
    Base.metadata.create_all(engine, tables=[User.__table__, ChartView.__table__])
    with Session(engine) as db:
        user = User(username="viewer", password_hash="x", role="Viewer")
        db.add(user)
        db.commit()
        save_view("inventory.types", ChartViewOptions(type="ring", position=position), user, db)
        db.expire_all()
        assert list_views(user, db)["inventory.types"].position == position
    with pytest.raises(ValidationError):
        ChartViewOptions(position="floating")
