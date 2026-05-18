from fastapi import APIRouter

from app.api.v1 import admin, alerts, audit, auth, dashboard, discovery, exports, ipam, monitoring, syslog, topology, tools

router = APIRouter()


@router.get("/health", tags=["health"])
async def health_check() -> dict[str, str]:
    return {"status": "ok"}


router.include_router(admin.router)
router.include_router(auth.router)
router.include_router(audit.router)
router.include_router(dashboard.router)
router.include_router(discovery.router)
router.include_router(exports.router)
router.include_router(syslog.router)
router.include_router(topology.router)
router.include_router(tools.router)
router.include_router(alerts.router)
router.include_router(monitoring.router)
router.include_router(ipam.router)

api_router = router
