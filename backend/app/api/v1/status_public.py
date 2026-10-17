from datetime import datetime, timezone

from fastapi import APIRouter, Request, Response
from fastapi.responses import JSONResponse

from app.core.network import request_client_ip
from app.services.status_pages import throttle
from app.services.status_pages.cache import RegistryEntry, status_cache

router = APIRouter(prefix="/public/status-pages", tags=["status-pages-public"])

RETRY_AFTER_BUILD = "5"
BASE_HEADERS = {"Cache-Control": "no-cache, private, must-revalidate", "Vary": "Cookie, Authorization"}


def error_response(status_code: int, detail: str, retry_after: str | None = None) -> JSONResponse:
    headers = dict(BASE_HEADERS)
    if retry_after:
        headers["Retry-After"] = retry_after
    return JSONResponse({"detail": detail}, status_code=status_code, headers=headers)


def not_found() -> JSONResponse:
    return error_response(404, "Not found")


def throttled(request: Request) -> JSONResponse | None:
    if throttle.allow(request_client_ip(request)):
        return None
    return error_response(429, "Too many requests", str(throttle.RETRY_AFTER_SECONDS))


def _etag_matches(header: str | None, etag: str) -> bool:
    if not header:
        return False
    tokens = [token.strip().removeprefix("W/") for token in header.split(",")]
    return "*" in tokens or etag in tokens


def resolve(slug: str) -> RegistryEntry | Response:
    entry = status_cache.lookup(slug)
    if entry is None:
        return not_found() if status_cache.ready else error_response(503, "Status page is being prepared", RETRY_AFTER_BUILD)
    return entry


def serve_snapshot(request: Request, entry: RegistryEntry, audience: str) -> Response:
    snapshot = status_cache.get(entry.page_id, audience, datetime.now(timezone.utc)) if status_cache.ready else None
    if snapshot is None:
        if status_cache.ready:
            status_cache.request_build(entry.page_id)
        return error_response(503, "Status page is being prepared", RETRY_AFTER_BUILD)
    headers = {**BASE_HEADERS, "ETag": snapshot.etag}
    if _etag_matches(request.headers.get("if-none-match"), snapshot.etag):
        return Response(status_code=304, headers=headers)
    return Response(content=snapshot.body, media_type="application/json", headers=headers)


@router.get("/{slug}")
async def read_public_page(slug: str, request: Request) -> Response:
    if (rejected := throttled(request)) is not None:
        return rejected
    entry = resolve(slug)
    if isinstance(entry, Response):
        return entry
    if entry.visibility != "public":
        return not_found()
    return serve_snapshot(request, entry, "public")
