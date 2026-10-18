from datetime import datetime, timezone

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.api.deps import get_current_user
from app.api.v1 import admin as admin_api
from app.api.v1 import status_pages as status_pages_api
from app.db.session import Base, get_db, import_all_models
from app.models.status_page import StatusPage
from app.models.system_setting import SystemSetting
from app.models.user import User, UserRole
from app.services.status_pages.css import validate_css
from app.services.status_pages.projection import build_page_payload
from tests.status_page_helpers import make_session, seed_page

NOW = datetime(2026, 1, 1, 12, 0, tzinfo=timezone.utc)


@pytest.mark.parametrize("css", [
    "@import 'x.css';", "a{background:url(x)}", "a{background:URL(x)}", "a{background:u\\72l(x)}",
    "a{background:image-set('x' 1x)}", "@font-face{src:local(x)}", "a{behavior:url(x)}",
    "a{width:expression(1)}", "a{content:'</style><script>'}", "a::-webkit-scrollbar{}",
    "a{background:url(data:image/png;base64,AAAA)}",
])
def test_rejected_css(css):
    assert validate_css(css).ok is False


@pytest.mark.parametrize("css", [
    "@IMPORT 'x.css';", "@\\69mport 'x.css';", "@charset 'utf-8';", "@namespace svg url(x);", "@page{margin:0}",
    "a{background:url( 'x' )}", "a{background:\\75rl(x)}", "a{background:\\69mage-set('x' 1x)}",
    "a{background:image('x')}", "a{background:element(#x)}", "a{content:attr(title)}",
    "a{padding:env(safe-area-inset-top)}", "a{src:src('x')}",
    "a{-moz-binding:x}", "a{beh\\61vior:x}", "a{width:-ms-expression(1)}", "a{x-expression-y:1}",
    "a{content:'\\3c /style>'}", "a{content:'<!--'}", "a{content:\"a>b\"}", "a{font-family:\\3c x}",
    "a::part(x){}", "a::backdrop{}", "a::-moz-selection{}", "a::\\2d webkit-scrollbar{}",
    "a:nope(b){}", "a url(x){}",
    "@media (min-width: url(x)){a{color:red}}", "@supports (background: url(x)){a{color:red}}",
    "@media (min-width: image-set('x' 1x)){a{}}", "@supports (background: u\\72l(x)){a{}}",
    "@media (width < 600px){a{}}",
    "a{width:calc(1px + url(x))}", "a{color:rgb(var(--a, image-set('x' 1x)))}",
    "a{width:calc(min(1px, max(2px, \\75rl(x))))}", "a{--x:{url(x)}}", "a{--x:[image('y')]}",
    "a{--x:url(x)}", "a{background:linear-gradient(red, attr(x))}",
    "@keyframes k{from{background:url(x)}}", "@keyframes k{@media x{from{}}}", "@keyframes k{a b{}}",
    "@media screen{@import 'x';}", "@media screen{a{background:url(x)}}",
    "a{color:'unterminated\n}", "a{color:red}}",
])
def test_rejected_css_escapes_nesting_and_preludes(css):
    result = validate_css(css)
    assert result.ok is False and result.css is None and result.errors


def test_allowed_presentation_css_round_trips():
    css = (
        ".sp-row{color:rgb(1 2 3);background:linear-gradient(90deg, hsl(10 20% 30%), color-mix(in srgb, red 50%, blue))}\n"
        ".sp-row:hover, .sp-group > .sp-row:not(.sp-x):nth-child(2n+1)::before{content:'ok';transform:translateX(2px) rotate(3deg)}\n"
        "a[href^=\"https\"]::after{content:\"→\"} li::marker{color:var(--accent, #123)} ::selection{color:oklch(50% 0.1 20)}\n"
        "@media (max-width:600px){.sp-row{padding:calc(1rem + 2px) clamp(1px, 2vw, 3px) !important}}\n"
        "@supports (display:grid){@media screen{.sp-grid{display:grid}}}\n"
        "@keyframes pulse{from{opacity:0}50%{opacity:.5}to{opacity:1}}\n"
        ".sp-dot{animation:pulse 2s cubic-bezier(.4,0,.2,1) infinite;--gap:4px;transition:opacity steps(4)}\n"
    )
    result = validate_css(css)
    assert result.ok is True, result.errors
    assert result.errors == []
    for fragment in (".sp-row", "rgb(1 2 3)", "@media (max-width:600px)", "@keyframes pulse", "!important", "::marker"):
        assert fragment in result.css
    again = validate_css(result.css)
    assert again.ok is True and again.css == result.css
    assert validate_css(" /* only a comment */ ").ok is True


def test_escaped_allowed_names_are_normalized():
    result = validate_css("a{\\63olor:\\72gb(1 2 3)}")
    assert result.ok is True, result.errors
    assert validate_css(result.css).css == result.css


def test_errors_name_line_and_column():
    result = validate_css("a{color:red}\n.sp-row{\n  background: url(x);\n}")
    assert result.ok is False
    assert any("line 3" in e.lower() and "column" in e.lower() for e in result.errors), result.errors
    assert any("line 1" in e.lower() for e in validate_css("@import 'x';").errors)


def test_size_and_rule_caps():
    big = "a{color:red}" + " " * (65536 - len("a{color:red}"))
    assert validate_css(big).ok is True
    assert validate_css(big + " ").ok is False
    assert validate_css("a{content:'é'}" + " " * (65536 - len("a{content:'é'}"))).ok is False
    assert validate_css("a{}" * 2000).ok is True
    assert validate_css("a{}" * 2001).ok is False
    assert validate_css("@media x{" + "a{}" * 2000 + "}").ok is False
    assert validate_css("@media a{@supports (b:c){@media d{e{color:red}}}}").ok is False
    assert validate_css("@media a{@supports (b:c){e{color:red}}}").ok is True
    assert validate_css("a{x:" + "(" * 40 + ")" * 40 + "}").ok is False
    assert validate_css("a{x:" + "1," * 30000 + "}").ok is False


def test_output_never_contains_html_delimiters():
    for css in ("a{x:\\3c}", "a{x:'\\3e'}", "a > b{color:red}"):
        result = validate_css(css)
        if result.ok:
            assert "<" not in result.css and "</style" not in result.css.lower()


@pytest.fixture
def env():
    import_all_models()
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(bind=engine)
    Session = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    with Session() as db:
        db.add(User(username="root", password_hash="x", role=UserRole.SUPER_ADMIN, is_active=True))
        db.add(User(username="admin", password_hash="x", role=UserRole.NETWORK_ADMIN, is_active=True))
        db.commit()
    current = {"name": "root"}
    app = FastAPI()
    app.include_router(status_pages_api.router, prefix="/api/v1")
    app.include_router(admin_api.router, prefix="/api/v1")

    def override_db():
        db = Session()
        try:
            yield db
        finally:
            db.close()

    def override_user():
        with Session() as db:
            return db.scalar(select(User).where(User.username == current["name"]))

    app.dependency_overrides[get_db] = override_db
    app.dependency_overrides[get_current_user] = override_user
    client = TestClient(app)
    client.as_user = lambda name: current.update(name=name)
    client.Session = Session
    return client


def _css_errors(response) -> list[str]:
    assert response.status_code == 422, response.text
    detail = response.json()["detail"]
    assert isinstance(detail["message"], str)
    return detail["css_errors"]


def test_page_save_rejects_invalid_css_with_line_column(env):
    page = env.post("/api/v1/status-pages", json={"name": "Media", "slug": "media"}).json()
    url = f"/api/v1/status-pages/{page['id']}"
    saved = env.patch(url, json={"custom_css": ".sp-row { color : red }"})
    assert saved.status_code == 200, saved.text
    stored = saved.json()["custom_css"]
    assert stored == ".sp-row { color : red }"

    errors = _css_errors(env.patch(url, json={"custom_css": ".sp-row{color:red}\n.sp-x{background:url(x)}", "title": "T"}))
    assert any("line 2" in e.lower() and "column" in e.lower() for e in errors), errors
    after = env.get(url).json()
    assert after["custom_css"] == stored and after["title"] is None

    assert _css_errors(env.patch(url, json={"custom_css": "@import 'x';"}))
    assert env.patch(url, json={"custom_css": "   "}).json()["custom_css"] is None
    assert env.patch(url, json={"custom_css": None}).json()["custom_css"] is None


def test_default_css_is_super_admin_only_and_validated(env):
    path = "/api/v1/admin/status-page-default-css"
    env.as_user("admin")
    assert env.get(path).status_code == 403
    assert env.put(path, json={"css": "a{color:red}"}).status_code == 403

    env.as_user("root")
    assert env.get(path).json() == {"css": None}
    errors = _css_errors(env.put(path, json={"css": "a{color:red}\n\na{background:image-set('x' 1x)}"}))
    assert any("line 3" in e.lower() for e in errors), errors
    assert env.get(path).json() == {"css": None}

    saved = env.put(path, json={"css": ".sp-row { color: red }"})
    assert saved.status_code == 200, saved.text
    assert saved.json()["css"] == ".sp-row { color: red }"
    assert env.get(path).json() == saved.json()
    page = env.post("/api/v1/status-pages", json={"name": "Media", "slug": "media"}).json()
    assert page["custom_css"] == saved.json()["css"]

    assert env.put(path, json={"css": ""}).json() == {"css": None}
    with env.Session() as db:
        assert db.get(SystemSetting, "status_page_default_css") is None or not db.get(SystemSetting, "status_page_default_css").value
    assert env.post("/api/v1/status-pages", json={"name": "B", "slug": "b"}).json()["custom_css"] is None


def test_public_payload_contains_only_validated_css():
    db = make_session()
    page = seed_page(db, "p", "public")
    page.custom_css = ".sp-row { color : red }"
    db.commit()
    assert build_page_payload(db, page, "public", NOW)["custom_css"] == validate_css(".sp-row { color : red }").css

    for stored in ("a{background:url(x)}", "a{content:'</style><script>'}", "@import 'x';", "a" * 70000):
        db.get(StatusPage, page.id).custom_css = stored
        db.commit()
        assert build_page_payload(db, page, "public", NOW)["custom_css"] is None
