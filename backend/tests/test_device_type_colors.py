"""Device type colours: stored as a system setting, merged into the listing.

Built-in device types are code constants with no `device_types` row, so their
colour cannot live on the table — these tests pin that built-ins and custom
types are both colourable through the same map.
"""

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.api.v1.admin import (
    DEVICE_TYPE_COLORS_KEY,
    _list_device_types,
    update_device_type_colors,
)
from app.db.session import Base
from app.models.device import Device  # noqa: F401 — registers mappers Device relates to
from app.models.device_type import DeviceType
from app.models.site import Site  # noqa: F401
from app.models.topology_group import TopologyGroup  # noqa: F401
from app.models.system_setting import SystemSetting
from app.models.user import User, UserRole
from app.schemas.admin import DeviceTypeColorsUpdate


def _db():
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(
        engine,
        tables=[User.__table__, DeviceType.__table__, SystemSetting.__table__],
    )
    db = sessionmaker(bind=engine, autoflush=False, autocommit=False)()
    db.add(DeviceType(value="ups", label="UPS", icon="device", is_builtin=False))
    db.commit()
    return db


def _admin():
    return User(username="admin", password_hash="x", role=UserRole.SUPER_ADMIN.value)


def _by_value(rows):
    return {row.value: row for row in rows}


def test_colors_default_to_none():
    db = _db()
    rows = _by_value(_list_device_types(db))
    assert rows["router"].color is None
    assert rows["ups"].color is None


def test_builtin_and_custom_types_are_both_colourable():
    db = _db()
    result = update_device_type_colors(
        DeviceTypeColorsUpdate(colors={"router": "#3B82F6", "ups": "#22c55e"}),
        _admin(),
        db,
    )
    rows = _by_value(result)
    # Hex is normalised to lower case on the way in.
    assert rows["router"].color == "#3b82f6"
    assert rows["ups"].color == "#22c55e"
    assert rows["switch"].color is None

    # Survives a fresh read rather than only living in the response.
    assert _by_value(_list_device_types(db))["router"].color == "#3b82f6"


def test_stamping_colour_does_not_mutate_the_builtin_constants():
    db = _db()
    update_device_type_colors(DeviceTypeColorsUpdate(colors={"router": "#3b82f6"}), _admin(), db)

    other = _db()
    assert _by_value(_list_device_types(other))["router"].color is None


def test_put_replaces_the_whole_map():
    db = _db()
    update_device_type_colors(DeviceTypeColorsUpdate(colors={"router": "#3b82f6"}), _admin(), db)
    update_device_type_colors(DeviceTypeColorsUpdate(colors={"switch": "#ef4444"}), _admin(), db)

    rows = _by_value(_list_device_types(db))
    assert rows["router"].color is None
    assert rows["switch"].color == "#ef4444"


def test_unknown_device_type_is_rejected():
    db = _db()
    with pytest.raises(HTTPException) as excinfo:
        update_device_type_colors(DeviceTypeColorsUpdate(colors={"nope": "#3b82f6"}), _admin(), db)
    assert excinfo.value.status_code == 400


def test_invalid_hex_is_rejected():
    with pytest.raises(ValueError):
        DeviceTypeColorsUpdate(colors={"router": "blue"})


def test_blank_colour_is_dropped_rather_than_stored():
    payload = DeviceTypeColorsUpdate(colors={"router": "  ", "switch": "#ef4444"})
    assert payload.colors == {"switch": "#ef4444"}


def test_corrupt_setting_value_falls_back_to_no_colours():
    db = _db()
    db.add(SystemSetting(key=DEVICE_TYPE_COLORS_KEY, value="{not json"))
    db.commit()
    assert _by_value(_list_device_types(db))["router"].color is None
