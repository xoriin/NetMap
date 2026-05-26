import pytest
from pydantic import ValidationError
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.api.v1.topology import deserialize_layout_positions, list_topology_layouts
from app.db.session import Base
from app.models.topology_layout import TopologyLayout
from app.models.user import User, UserRole
from app.schemas.topology import TopologyLayoutCreate


def test_topology_layout_accepts_device_and_group_positions():
    payload = TopologyLayoutCreate(
        name="Office",
        positions={
            "device-1": {"x": 10, "y": 20},
            "group-office": {"x": 100, "y": 200},
        },
    )

    assert set(payload.positions) == {"device-1", "group-office"}


def test_topology_layout_rejects_non_topology_position_keys():
    with pytest.raises(ValidationError):
        TopologyLayoutCreate(
            name="Office",
            positions={"edge-1": {"x": 10, "y": 20}},
        )


def test_topology_layout_rejects_non_finite_coordinates():
    with pytest.raises(ValidationError):
        TopologyLayoutCreate(
            name="Office",
            positions={"device-1": {"x": float("inf"), "y": 20}},
        )


def test_deserialize_layout_positions_discards_invalid_saved_rows():
    positions = deserialize_layout_positions(
        """
        {
          "device-1": {"x": 10, "y": 20},
          "group-office": {"x": "100.5", "y": 200},
          "device-2": {"x": null, "y": 30},
          "group-bad": {"x": 1e999, "y": 30},
          "edge-1": {"x": 40, "y": 50}
        }
        """
    )

    assert positions == {
        "device-1": {"x": 10.0, "y": 20.0},
        "group-office": {"x": 100.5, "y": 200.0},
    }


def test_list_topology_layouts_includes_latest_shared_autosaves_but_not_other_named_layouts():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine, tables=[User.__table__, TopologyLayout.__table__])
    Session = sessionmaker(bind=engine)

    with Session() as db:
        user_one = User(username="one", password_hash="x", role=UserRole.SUPER_ADMIN.value)
        user_two = User(username="two", password_hash="x", role=UserRole.NETWORK_ADMIN.value)
        db.add_all([user_one, user_two])
        db.flush()
        db.add_all(
            [
                TopologyLayout(owner_user_id=user_one.id, name="__autosave__", positions_json='{"device-1":{"x":1,"y":2}}'),
                TopologyLayout(owner_user_id=user_one.id, name="Private one", positions_json='{}'),
                TopologyLayout(owner_user_id=user_two.id, name="Private two", positions_json='{}'),
            ]
        )
        db.commit()

        layouts = list_topology_layouts(current_user=user_two, db=db)

    names = [layout.name for layout in layouts]
    assert "__autosave__" in names
    assert "Private two" in names
    assert "Private one" not in names
