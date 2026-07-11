from fastapi import HTTPException
import pytest
from pydantic import ValidationError
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.api.v1.topology import (
    deserialize_layout_positions,
    import_topology_layout,
    list_topology_layouts,
    preview_shared_layout,
    revoke_topology_layout_share,
    share_topology_layout,
)
from app.db.session import Base
from app.models.audit_log import AuditLog
from app.models.topology_layout import TopologyLayout
from app.models.user import User, UserRole
from app.schemas.topology import TopologyLayoutCreate, TopologyLayoutImportRequest


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


def _share_db():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine, tables=[User.__table__, TopologyLayout.__table__, AuditLog.__table__])
    Session = sessionmaker(bind=engine)
    db = Session()
    owner = User(username="owner", password_hash="x", role=UserRole.NETWORK_ADMIN.value)
    other = User(username="other", password_hash="x", role=UserRole.VIEWER.value)
    db.add_all([owner, other])
    db.flush()
    layout = TopologyLayout(
        owner_user_id=owner.id,
        name="Office",
        positions_json='{"device-1":{"x":1.0,"y":2.0}}',
        display_prefs_json='{"showNodeIcons": true}',
    )
    autosave = TopologyLayout(owner_user_id=owner.id, name="__autosave__", positions_json="{}")
    db.add_all([layout, autosave])
    db.commit()
    return db, owner, other, layout, autosave


def test_share_generates_stable_code_and_revoke_clears_it():
    db, owner, _other, layout, _autosave = _share_db()

    first = share_topology_layout(layout_id=layout.id, current_user=owner, db=db)
    assert len(first.share_code) == 12
    second = share_topology_layout(layout_id=layout.id, current_user=owner, db=db)
    assert second.share_code == first.share_code

    revoke_topology_layout_share(layout_id=layout.id, current_user=owner, db=db)
    db.refresh(layout)
    assert layout.share_code is None


def test_share_rejects_autosave_and_foreign_layouts():
    db, owner, other, layout, autosave = _share_db()

    with pytest.raises(HTTPException) as exc:
        share_topology_layout(layout_id=autosave.id, current_user=owner, db=db)
    assert exc.value.status_code == 400

    with pytest.raises(HTTPException) as exc:
        share_topology_layout(layout_id=layout.id, current_user=other, db=db)
    assert exc.value.status_code == 404


def test_import_copies_layout_to_other_user():
    db, owner, other, layout, _autosave = _share_db()
    code = share_topology_layout(layout_id=layout.id, current_user=owner, db=db).share_code

    imported = import_topology_layout(
        payload=TopologyLayoutImportRequest(code=code.lower()),  # codes are case-insensitive
        current_user=other,
        db=db,
    )
    assert imported.owner_user_id == other.id
    assert imported.name == "Office"
    assert set(imported.positions) == {"device-1"}
    assert imported.positions["device-1"].x == 1.0
    assert imported.positions["device-1"].y == 2.0
    assert imported.display_prefs == {"showNodeIcons": True}
    assert imported.share_code is None  # copies are private until shared themselves

    # A second import gets a suffixed name rather than a unique-constraint error.
    again = import_topology_layout(
        payload=TopologyLayoutImportRequest(code=code),
        current_user=other,
        db=db,
    )
    assert again.name == "Office (2)"


def test_preview_shared_layout_returns_readonly_view():
    db, owner, other, layout, _autosave = _share_db()
    code = share_topology_layout(layout_id=layout.id, current_user=owner, db=db).share_code

    preview = preview_shared_layout(code=code.lower(), _current_user=other, db=db)
    assert preview.name == "Office"
    assert set(preview.positions) == {"device-1"}
    assert preview.share_code is None  # code never leaks to non-owners

    with pytest.raises(HTTPException) as exc:
        preview_shared_layout(code="NOSUCHCODE22", _current_user=other, db=db)
    assert exc.value.status_code == 404


def test_import_with_unknown_code_returns_404():
    db, _owner, other, _layout, _autosave = _share_db()
    with pytest.raises(HTTPException) as exc:
        import_topology_layout(
            payload=TopologyLayoutImportRequest(code="NOSUCHCODE22"),
            current_user=other,
            db=db,
        )
    assert exc.value.status_code == 404
