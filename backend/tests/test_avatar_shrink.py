import base64
import io
import os

from PIL import Image
from sqlalchemy import create_engine, text

from app.db import session
from app.schemas.auth import ProfileUpdateRequest, UserUpdateRequest

SMALL_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="


def _data_uri(image: Image.Image, fmt: str = "PNG") -> str:
    buffer = io.BytesIO()
    image.save(buffer, fmt)
    mime = {"PNG": "image/png", "JPEG": "image/jpeg", "WEBP": "image/webp"}[fmt]
    return f"data:{mime};base64,{base64.b64encode(buffer.getvalue()).decode()}"


def _decode(uri: str) -> Image.Image:
    return Image.open(io.BytesIO(base64.b64decode(uri.partition(",")[2])))


def _large_photo(mode: str = "RGB") -> str:
    width, height = (800, 600) if mode == "RGB" else (600, 450)
    image = Image.frombytes(mode, (width, height), os.urandom(width * height * len(mode)))
    return _data_uri(image, "JPEG" if mode == "RGB" else "PNG")


def test_large_avatar_is_shrunk_to_a_small_webp_keeping_its_shape():
    original = _large_photo()
    shrunk = ProfileUpdateRequest(avatar_data=original).avatar_data
    assert shrunk.startswith("data:image/webp;base64,")
    image = _decode(shrunk)
    assert max(image.size) == 256
    assert abs(image.size[0] / image.size[1] - 800 / 600) < 0.02
    assert len(shrunk) < 120_000 < len(original)


def test_admin_avatar_update_is_shrunk_too():
    assert UserUpdateRequest(avatar_data=_large_photo()).avatar_data.startswith("data:image/webp;base64,")


def test_small_avatar_is_stored_unchanged():
    assert ProfileUpdateRequest(avatar_data=SMALL_PNG).avatar_data == SMALL_PNG


def test_shrinking_keeps_transparency():
    shrunk = ProfileUpdateRequest(avatar_data=_large_photo("RGBA")).avatar_data
    assert "A" in _decode(shrunk).mode


def _users_table():
    engine = create_engine("sqlite://")
    conn = engine.connect()
    conn.execute(text("CREATE TABLE users (id INTEGER PRIMARY KEY, avatar_data TEXT)"))
    return conn


def test_migration_shrinks_stored_avatars_and_leaves_others_alone():
    conn = _users_table()
    large = _large_photo()
    broken = "data:image/png;base64," + base64.b64encode(b"x" * 200_000).decode()
    rows = {1: large, 2: SMALL_PNG, 3: broken, 4: None}
    for user_id, avatar in rows.items():
        conn.execute(text("INSERT INTO users (id, avatar_data) VALUES (:id, :avatar)"), {"id": user_id, "avatar": avatar})

    session._migrate_shrink_avatars(conn, None)

    stored = dict(conn.execute(text("SELECT id, avatar_data FROM users")).fetchall())
    assert stored[1].startswith("data:image/webp;base64,") and max(_decode(stored[1]).size) == 256
    assert stored[2] == SMALL_PNG
    assert stored[3] == broken
    assert stored[4] is None


def test_migration_skips_a_database_without_avatar_column():
    engine = create_engine("sqlite://")
    conn = engine.connect()
    conn.execute(text("CREATE TABLE users (id INTEGER PRIMARY KEY)"))
    session._migrate_shrink_avatars(conn, None)
