from app.core.config import installed_app_version, settings
from app.main import create_app


def test_swagger_page_uses_local_csp_compatible_assets() -> None:
    app = create_app()
    docs_route = next(route for route in app.routes if getattr(route, "path", None) == "/api/docs")

    response = docs_route.endpoint()
    html = response.body.decode()

    assert response.status_code == 200
    assert "/swagger-ui/swagger-ui.css" in html
    assert "/swagger-ui/swagger-ui-bundle.js" in html
    assert "/swagger-ui/swagger-initializer.js" in html
    assert "cdn.jsdelivr.net" not in html


def test_openapi_schema_has_version_tags_and_readable_operations() -> None:
    schema = create_app().openapi()

    assert schema["info"]["version"] == installed_app_version(settings.app_version).lstrip("v")
    assert schema["info"]["description"]
    assert {tag["name"] for tag in schema["tags"]} >= {
        "auth",
        "topology",
        "monitoring",
        "ipam",
        "syslog",
    }
    assert all(tag.get("description") for tag in schema["tags"])
    assert all(
        operation.get("summary")
        for path_item in schema["paths"].values()
        for method, operation in path_item.items()
        if method in {"get", "post", "put", "patch", "delete"}
    )


def test_openapi_security_is_only_added_to_protected_operations() -> None:
    schema = create_app().openapi()
    schemes = schema["components"]["securitySchemes"]

    assert schemes["ApiKeyAuth"] == {
        "type": "apiKey",
        "in": "header",
        "name": "X-API-Key",
        "description": "A registered NetMap API key (`nm_<prefix>_<secret>`).",
    }
    assert "security" not in schema
    assert schema["paths"]["/api/v1/health"]["get"].get("security") is None

    protected = schema["paths"]["/api/v1/dashboard/summary"]["get"]
    assert {"ApiKeyAuth": []} in protected["security"]
    assert {"BearerAuth": []} in protected["security"]
    assert protected["responses"]["401"]["description"]
