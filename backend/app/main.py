from datetime import datetime, timezone
import logging
import threading

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import select
from starlette.middleware.trustedhost import TrustedHostMiddleware

from app.api.v1.router import api_router
from app.api_docs import (
    API_DESCRIPTION,
    OPENAPI_TAGS,
    app_version,
    configure_openapi,
    swagger_ui_html,
)
from app.core.config import settings
from app.core.startup import validate_runtime_configuration
from app.db.firewall_session import init_firewall_db, rebuild_firewall_fts_if_needed
from app.db.session import SessionLocal, init_db
from app.middleware.csrf import CsrfProtectionMiddleware
from app.middleware.security import SecurityHeadersMiddleware
from app.services.syslog.server import syslog_service
from app.services.syslog.storage import cleanup_expired_events

logger = logging.getLogger(__name__)


def create_app() -> FastAPI:
    app = FastAPI(
        title="NetMap API",
        version=app_version(),
        description=API_DESCRIPTION,
        openapi_tags=OPENAPI_TAGS,
        docs_url=None,
        redoc_url=None,
        openapi_url="/api/openapi.json",
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=True,
        allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
        allow_headers=["Authorization", "Content-Type", "X-CSRF-Token", "X-API-Key"],
    )
    app.add_middleware(CsrfProtectionMiddleware)
    if settings.trusted_hosts:
        app.add_middleware(TrustedHostMiddleware, allowed_hosts=settings.trusted_hosts)
    if settings.secure_headers_enabled:
        app.add_middleware(SecurityHeadersMiddleware)

    app.include_router(api_router, prefix="/api/v1")
    configure_openapi(app)

    app.add_api_route(
        "/api/docs",
        swagger_ui_html,
        methods=["GET"],
        include_in_schema=False,
    )

    @app.get("/api/health", tags=["health"])
    async def root_health_check() -> dict[str, str]:
        return {"status": "ok"}

    @app.on_event("startup")
    def on_startup() -> None:
        from app.models.system_setting import SystemSetting
        from app.services.alerting.service import alert_monitor
        from app.services.discovery.scheduled import scheduled_discovery
        from app.services.exports.backup_schedule import backup_schedule_service
        from app.services.ipam.reminders import ip_reservation_reminder_service
        from app.services.monitors.service import standalone_monitor_service
        from app.services.rbac.permissions import load_from_db

        validate_runtime_configuration()
        init_db()
        init_firewall_db()
        _cleanup_stuck_scans()
        with SessionLocal() as db:
            setting = db.get(SystemSetting, "role_permissions")
            if setting:
                load_from_db(setting.value)
        syslog_service.start()
        alert_monitor.start()
        scheduled_discovery.start()
        ip_reservation_reminder_service.start()
        backup_schedule_service.start()
        standalone_monitor_service.start()
        _start_firewall_startup_maintenance()

    @app.on_event("shutdown")
    def on_shutdown() -> None:
        from app.services.alerting.service import alert_monitor
        from app.services.discovery.scheduled import scheduled_discovery
        from app.services.exports.backup_schedule import backup_schedule_service
        from app.services.ipam.reminders import ip_reservation_reminder_service
        from app.services.monitors.service import standalone_monitor_service

        syslog_service.stop()
        alert_monitor.stop()
        scheduled_discovery.stop()
        ip_reservation_reminder_service.stop()
        standalone_monitor_service.stop()
        backup_schedule_service.stop()

    return app


def _start_firewall_startup_maintenance() -> None:
    thread = threading.Thread(
        target=_run_firewall_startup_maintenance,
        name="firewall-startup-maintenance",
        daemon=True,
    )
    thread.start()


def _run_firewall_startup_maintenance() -> None:
    try:
        rebuild_firewall_fts_if_needed()
    except Exception:
        logger.exception("Firewall FTS startup maintenance failed")
    try:
        cleanup_expired_events()
    except Exception:
        logger.exception("Firewall retention startup maintenance failed")


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
