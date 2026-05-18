from datetime import datetime, timezone

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import select, update
from starlette.middleware.trustedhost import TrustedHostMiddleware

from app.api.v1.router import api_router
from app.core.config import settings
from app.core.startup import validate_runtime_configuration
from app.db.session import SessionLocal, init_db
from app.middleware.security import SecurityHeadersMiddleware
from app.services.syslog.server import syslog_service
from app.services.syslog.storage import cleanup_expired_events


def create_app() -> FastAPI:
    app = FastAPI(
        title="NetMap API",
        version="0.1.0",
        docs_url="/api/docs",
        openapi_url="/api/openapi.json",
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=True,
        allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
        allow_headers=["Authorization", "Content-Type"],
    )
    if settings.trusted_hosts:
        app.add_middleware(TrustedHostMiddleware, allowed_hosts=settings.trusted_hosts)
    if settings.secure_headers_enabled:
        app.add_middleware(SecurityHeadersMiddleware)

    app.include_router(api_router, prefix="/api/v1")

    @app.get("/api/health", tags=["health"])
    async def root_health_check() -> dict[str, str]:
        return {"status": "ok"}

    @app.on_event("startup")
    def on_startup() -> None:
        from app.models.system_setting import SystemSetting
        from app.services.alerting.service import alert_monitor
        from app.services.rbac.permissions import load_from_db
        validate_runtime_configuration()
        init_db()
        cleanup_expired_events()
        _cleanup_stuck_scans()
        with SessionLocal() as db:
            setting = db.get(SystemSetting, "role_permissions")
            if setting:
                load_from_db(setting.value)
        syslog_service.start()
        alert_monitor.start()

    @app.on_event("shutdown")
    def on_shutdown() -> None:
        from app.services.alerting.service import alert_monitor
        syslog_service.stop()
        alert_monitor.stop()

    return app


def _cleanup_stuck_scans() -> None:
    from app.models.discovery import DiscoveryScan

    with SessionLocal() as db:
        stuck = db.scalars(select(DiscoveryScan).where(DiscoveryScan.status == "running")).all()
        if not stuck:
            return
        for scan in stuck:
            scan.status = "failed"
            scan.error = "Server restarted while scan was in progress"
            scan.completed_at = datetime.now(timezone.utc)
        db.commit()


app = create_app()
