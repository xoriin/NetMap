import json
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import get_current_user, require_alert_write
from app.db.session import get_db
from app.models.alert_event import AlertEvent
from app.models.alert_rule import AlertRule
from app.models.device import Device
from app.models.notification_delivery import NotificationDelivery
from app.schemas.alert import (
    AlertEventRead,
    AlertRuleCreate,
    AlertRuleRead,
    AlertRuleUpdate,
    NotificationDeliveryRead,
)
from app.models.user import User
from app.services.alerting.service import AlertMonitorService
from app.services.notifications import (
    list_notification_profiles,
    load_notification_settings,
    send_notification_target,
)

router = APIRouter(prefix="/alerts", tags=["alerts"])


def _to_read(rule: AlertRule) -> AlertRuleRead:
    return AlertRuleRead.model_validate(rule)


@router.get("/rules", response_model=list[AlertRuleRead])
def list_rules(
    _current_user: Annotated[User, Depends(require_alert_write)],
    db: Annotated[Session, Depends(get_db)],
) -> list[AlertRuleRead]:
    rules = db.scalars(select(AlertRule).order_by(AlertRule.created_at)).all()
    return [_to_read(r) for r in rules]


@router.post("/rules", response_model=AlertRuleRead, status_code=status.HTTP_201_CREATED)
def create_rule(
    payload: AlertRuleCreate,
    _current_user: Annotated[User, Depends(require_alert_write)],
    db: Annotated[Session, Depends(get_db)],
) -> AlertRuleRead:
    if payload.device_id is not None:
        if not db.get(Device, payload.device_id):
            raise HTTPException(status_code=404, detail="Device not found")
    rule = AlertRule(
        name=payload.name,
        enabled=payload.enabled,
        event_type=payload.event_type,
        device_id=payload.device_id,
        channels=json.dumps(payload.channels),
        cooldown_minutes=payload.cooldown_minutes,
        threshold_ms=payload.threshold_ms,
        loss_pct_threshold=payload.loss_pct_threshold,
        loss_window_minutes=payload.loss_window_minutes,
    )
    db.add(rule)
    db.commit()
    db.refresh(rule)
    return _to_read(rule)


@router.patch("/rules/{rule_id}", response_model=AlertRuleRead)
def update_rule(
    rule_id: int,
    payload: AlertRuleUpdate,
    _current_user: Annotated[User, Depends(require_alert_write)],
    db: Annotated[Session, Depends(get_db)],
) -> AlertRuleRead:
    rule = db.get(AlertRule, rule_id)
    if not rule:
        raise HTTPException(status_code=404, detail="Alert rule not found")
    updates = payload.model_dump(exclude_unset=True)
    if "channels" in updates:
        updates["channels"] = json.dumps(updates["channels"])
    if "device_id" in updates and updates["device_id"] is not None:
        if not db.get(Device, updates["device_id"]):
            raise HTTPException(status_code=404, detail="Device not found")
    for key, value in updates.items():
        setattr(rule, key, value)
    if rule.event_type == "rtt_above" and rule.threshold_ms is None:
        raise HTTPException(status_code=422, detail="threshold_ms is required for rtt_above rules")
    if rule.event_type == "ping_loss_above" and rule.loss_pct_threshold is None:
        raise HTTPException(status_code=422, detail="loss_pct_threshold is required for ping_loss_above rules")
    db.commit()
    db.refresh(rule)
    return _to_read(rule)


@router.delete("/rules/{rule_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_rule(
    rule_id: int,
    _current_user: Annotated[User, Depends(require_alert_write)],
    db: Annotated[Session, Depends(get_db)],
) -> None:
    rule = db.get(AlertRule, rule_id)
    if not rule:
        raise HTTPException(status_code=404, detail="Alert rule not found")
    db.delete(rule)
    db.commit()


@router.post("/rules/{rule_id}/test", response_model=dict[str, str])
def test_rule(
    rule_id: int,
    _current_user: Annotated[User, Depends(require_alert_write)],
    db: Annotated[Session, Depends(get_db)],
) -> dict[str, str]:
    rule = db.get(AlertRule, rule_id)
    if not rule:
        raise HTTPException(status_code=404, detail="Alert rule not found")

    channels = json.loads(rule.channels) if isinstance(rule.channels, str) else rule.channels
    if not channels:
        raise HTTPException(status_code=400, detail="Rule has no notification channels configured")

    notif_settings = load_notification_settings(db)
    profiles = {
        int(profile["id"]): profile
        for profile in list_notification_profiles(db, redacted=False)
    }
    app_name = AlertMonitorService._get_app_name(db)

    # Use the specific device if the rule targets one, otherwise use a placeholder
    if rule.device_id is not None:
        device = db.get(Device, rule.device_id)
        if device:
            label = device.display_name or device.hostname or device.ip_address
            ip = device.ip_address
        else:
            label = f"Device #{rule.device_id}"
            ip = "unknown"
    else:
        label = "Example Device"
        ip = "192.0.2.1"

    # Build using the same format as a real alert, but prefixed with [TEST]
    event_status_map = {
        "device_offline": "offline",
        "device_online": "online",
        "device_warning": "warning",
        "any_status_change": "offline",
        "rtt_above": "online",
        "device_flapping": "online",
        "ping_loss_above": "online",
    }
    status = event_status_map.get(rule.event_type, "unknown")
    threshold = rule.threshold_ms or 100
    loss_threshold = rule.loss_pct_threshold or 50.0
    body = AlertMonitorService._build_message(
        rule.event_type, label, ip, status, app_name,
        rtt_ms=float(threshold) + 25, threshold_ms=threshold, flap_count=5,
        loss_pct=loss_threshold + 10, loss_pct_threshold=loss_threshold,
    )
    message = f"[TEST] {body}"

    results: dict[str, str] = {}
    for channel in channels:
        results[channel] = send_notification_target(channel, message, notif_settings, profiles)

    return results


@router.get("/deliveries", response_model=list[NotificationDeliveryRead])
def list_deliveries(
    _current_user: Annotated[User, Depends(require_alert_write)],
    db: Annotated[Session, Depends(get_db)],
    limit: int = 100,
) -> list[NotificationDeliveryRead]:
    q = select(NotificationDelivery).order_by(NotificationDelivery.sent_at.desc(), NotificationDelivery.id.desc()).limit(min(limit, 500))
    return list(db.scalars(q))


@router.get("/events", response_model=list[AlertEventRead])
def list_events(
    _current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
    device_id: int | None = None,
    limit: int = 100,
) -> list[AlertEventRead]:
    q = select(AlertEvent).order_by(AlertEvent.fired_at.desc()).limit(min(limit, 500))
    if device_id is not None:
        q = q.where(AlertEvent.device_id == device_id)
    return list(db.scalars(q))
