import json
from datetime import datetime, timedelta, timezone

from app.models.monitor import MonitorCheckHistory
from app.models.monitor_history import DeviceMonitorHistory
from app.models.status_page import StatusPage, StatusPageItem
from app.services.status_pages.projection import build_page_payload, next_deadline, summarize
from app.services.status_pages.sources import SourceRef, freshness_deadline, load_current_states
from tests.status_page_helpers import make_session, seed_device, seed_monitor, seed_page, seed_service_check

NOW = datetime(2026, 1, 1, 12, 0, tzinfo=timezone.utc)

PAYLOAD_KEYS = {
    "slug", "title", "accent", "logo", "heartbeat_window", "custom_css", "generated_at", "valid_until",
    "summary", "notices", "incidents", "maintenance", "past", "groups",
}
GROUP_KEYS = {"id", "name", "state", "collapsed", "items"}
ITEM_KEYS = {"id", "name", "state", "availability", "heartbeats", "response", "metrics", "incident_ids"}
AVAILABILITY_KEYS = {"percent", "label", "coverage"}
SUMMARY_KEYS = {"state", "label", "counts"}
COUNT_KEYS = {"operational", "degraded", "down", "maintenance", "unknown"}
NOTICE_KEYS = {"id", "level", "title", "body", "link", "expires_at"}
INCIDENT_KEYS = {"id", "title", "severity", "status", "opened_at", "resolved_at", "ticket", "updates"}
UPDATE_KEYS = {"id", "at", "status", "message", "author", "internal"}
TICKET_KEYS = {"url", "label"}


def _device(db, **kw):
    kw.setdefault("monitor_status", "online")
    kw.setdefault("last_monitored_at", NOW - timedelta(seconds=10))
    return seed_device(db, **kw)


def _history(db, device, minutes_ago, rtt=10.0, healthy=True, port_results="[]"):
    db.add(DeviceMonitorHistory(
        device_id=device.id, checked_at=NOW - timedelta(minutes=minutes_ago),
        status="online" if healthy else "offline", is_healthy=healthy, rtt_ms=rtt, port_results=port_results,
    ))
    db.commit()


def _set_extras(db, page, **extras):
    for item in db.query(StatusPageItem).filter_by(page_id=page.id):
        item.extras = dict(extras)
    db.commit()


def test_summary_precedence_matches_spec():
    assert summarize([], False) == ("empty", "No systems configured")
    assert summarize(["down", "down", "operational"], False)[1] == "Major outage"
    assert summarize(["down", "operational", "operational"], False)[1] == "Some systems are affected"
    assert summarize(["operational"], True)[1] == "Some systems are affected"
    assert summarize(["degraded", "operational"], False)[1] == "Some systems are affected"
    assert summarize(["unknown", "operational"], False)[1] == "Status unavailable for some systems"
    assert summarize(["maintenance", "operational"], False)[1] == "Maintenance in progress"
    assert summarize(["operational", "operational"], False) == ("operational", "All systems operational")


def test_all_unknown_is_never_operational():
    state, label = summarize(["unknown", "unknown"], False)
    assert state == "unknown" and label == "Status unavailable for some systems"
    assert summarize(["maintenance"], False)[0] == "maintenance"


def test_critical_notice_never_downgrades_major():
    assert summarize(["down", "down", "operational"], True) == ("major", "Major outage")
    assert summarize(["down", "operational"], False)[0] == "affected"


def test_half_down_is_not_major():
    assert summarize(["down", "operational"], False)[0] == "affected"


def test_public_projection_never_contains_private_alias_or_internal_text():
    db = make_session()
    device = _device(db, hostname="media-01", ip_address="10.0.0.5")
    monitor = seed_monitor(db, name="Secret monitor", url="https://internal.example.test/health")
    check = seed_service_check(db, device.id, label="service_check HTTPS")
    _history(db, device, 5, rtt=12.0, port_results=json.dumps(
        [{"target_id": check.id, "open": True, "response_time_ms": 30, "error": "connection refused to 10.0.0.5"}]))
    db.add(MonitorCheckHistory(monitor_id=monitor.id, checked_at=NOW - timedelta(minutes=5), status="online", response_time_ms=40))
    db.commit()
    refs = [SourceRef("device", device_id=device.id), SourceRef("monitor", monitor_id=monitor.id),
            SourceRef("service_check", device_id=device.id, port_target_id=check.id)]
    public = seed_page(db, "public", "public", [(refs[0], "Media"), (refs[1], "Website"), (refs[2], "Web")])
    seed_page(db, "private", "private", [(refs[0], "media-01 (10.0.0.5)")])
    private = db.query(StatusPage).filter_by(slug="private").one()
    for page in (public, private):
        _set_extras(db, page, rtt_graph=True, uptime_period="24h", avg_response=True, p95_response=True,
                    failure_rate=True, last_check=True)
    body = json.dumps(build_page_payload(db, public, "public", NOW))
    private_body = json.dumps(build_page_payload(db, private, "private", NOW))
    assert "media-01 (10.0.0.5)" in private_body
    for leaked in ("10.0.0.5", "media-01", "device:", "monitor:", "service:", "hostname", "service_check",
                   "internal.example.test", "Secret monitor", "connection refused", "kind", "device_id",
                   "monitor_id", "port_target_id", "source"):
        assert leaked not in body, leaked
    assert "Media" in body


def test_payload_keys_are_exactly_the_allowlist_at_every_level():
    db = make_session()
    device = _device(db)
    _history(db, device, 5)
    ref = SourceRef("device", device_id=device.id)
    page = seed_page(db, "p", "public", [(ref, "Media")])
    _set_extras(db, page, rtt_graph=True)
    for audience in ("public", "private"):
        payload = build_page_payload(db, page, audience, NOW)
        assert set(payload) == PAYLOAD_KEYS
        assert set(payload["summary"]) == SUMMARY_KEYS
        assert set(payload["summary"]["counts"]) == COUNT_KEYS
        (group,) = payload["groups"]
        assert set(group) == GROUP_KEYS
        (item,) = group["items"]
        assert set(item) == ITEM_KEYS
        assert set(item["availability"]) == AVAILABILITY_KEYS
        assert len(item["heartbeats"]) == 60 and len(item["response"]) == 60
        assert payload["notices"] == payload["incidents"] == payload["maintenance"] == payload["past"] == []
        assert payload["custom_css"] is None and item["incident_ids"] == []
        json.dumps(payload)

    from app.models.user import User
    from app.services.status_pages import incidents, notices
    from app.services.status_pages.incidents import PersonActor, Ticket

    user = User(username="u", password_hash="x", role="NetworkAdmin", is_active=True)
    db.add(user)
    db.commit()
    actor = PersonActor(user)
    open_one = incidents.open_manual_incident(
        db, actor, "Open", "partial", "m", True, [page.id], [ref], Ticket("https://t.test/1", "T-1"), now=NOW,
    )
    incidents.add_update(db, actor, open_one.id, "internal", False, None, None, None, now=NOW)
    done = incidents.open_manual_incident(db, actor, "Done", "partial", "m", True, [page.id], [], None, now=NOW)
    incidents.resolve(db, actor, done.id, None, now=NOW)
    notices.set_notice(db, actor, page.id, "info", "N", "b", "https://n.test/", NOW + timedelta(hours=1), now=NOW)
    for audience in ("public", "private"):
        payload = build_page_payload(db, page, audience, NOW)
        assert set(payload) == PAYLOAD_KEYS
        (notice,) = payload["notices"]
        assert set(notice) == NOTICE_KEYS
        (incident,) = payload["incidents"]
        (past,) = payload["past"]
        assert set(incident) == INCIDENT_KEYS
        assert set(past) == INCIDENT_KEYS | {"kind"} and past["kind"] == "incident"
        for entry in (incident, past):
            assert all(set(update) == UPDATE_KEYS for update in entry["updates"])
        assert set(incident["ticket"]) == TICKET_KEYS
        assert len(incident["updates"]) == (2 if audience == "private" else 1)
        assert payload["groups"][0]["items"][0]["incident_ids"] == [open_one.id]


def test_extras_absent_unless_enabled():
    db = make_session()
    device = _device(db)
    _history(db, device, 5, rtt=20.0)
    _history(db, device, 4, rtt=40.0)
    ref = SourceRef("device", device_id=device.id)
    page = seed_page(db, "p", "public", [(ref, "Media")])
    item = build_page_payload(db, page, "public", NOW)["groups"][0]["items"][0]
    assert item["response"] is None and item["metrics"] is None

    _set_extras(db, page, avg_response=True, p95_response=True, failure_rate=True, last_check=True, uptime_period="7d")
    item = build_page_payload(db, page, "public", NOW)["groups"][0]["items"][0]
    assert item["response"] is None
    assert set(item["metrics"]) == {"avg_response", "p95_response", "failure_rate", "last_check", "uptime_period"}
    assert item["metrics"]["avg_response"] == 30.0 and item["metrics"]["p95_response"] == 40.0
    assert item["metrics"]["failure_rate"] == 0.0
    assert item["metrics"]["uptime_period"]["period"] == "7d"

    _set_extras(db, page, avg_response=True)
    item = build_page_payload(db, page, "public", NOW)["groups"][0]["items"][0]
    assert set(item["metrics"]) == {"avg_response"}


def test_availability_is_straight_from_history_label():
    db = make_session()
    device = _device(db)
    ref = SourceRef("device", device_id=device.id)
    page = seed_page(db, "p", "public", [(ref, "Media")])
    item = build_page_payload(db, page, "public", NOW)["groups"][0]["items"][0]
    assert item["availability"]["label"] == "no_data" and item["availability"]["percent"] is None


def test_uptime_period_uses_its_own_window_and_history_loads_once_per_window():
    db = make_session()
    device = _device(db)
    _history(db, device, 60 * 24 * 2, healthy=False)
    _history(db, device, 5)
    ref = SourceRef("device", device_id=device.id)
    page = seed_page(db, "p", "public", [(ref, "Media")])
    _set_extras(db, page, uptime_period="7d")
    from app.services.status_pages import projection

    calls = []
    real = projection.load_samples
    projection.load_samples = lambda db_, refs, s, e: (calls.append((s, e)), real(db_, refs, s, e))[1]
    try:
        payload = build_page_payload(db, page, "public", NOW)
    finally:
        projection.load_samples = real
    assert len(calls) == len({(s, e) for s, e in calls}) == 2
    metric = payload["groups"][0]["items"][0]["metrics"]["uptime_period"]
    assert metric["label"] != "ok" and metric["percent"] is None


def test_summary_counts_and_group_state():
    db = make_session()
    up = _device(db)
    down = _device(db, monitor_status="offline")
    unknown = seed_device(db, monitoring_paused=True)
    refs = [SourceRef("device", device_id=d.id) for d in (up, down, unknown)]
    page = seed_page(db, "p", "public", [(r, f"N{i}") for i, r in enumerate(refs)])
    payload = build_page_payload(db, page, "public", NOW)
    assert payload["summary"]["counts"] == {"operational": 1, "degraded": 0, "down": 1, "maintenance": 0, "unknown": 1}
    assert payload["summary"]["state"] == "affected"
    assert payload["groups"][0]["state"] == "affected"
    assert [i["state"] for i in payload["groups"][0]["items"]] == ["operational", "down", "unknown"]


def test_valid_until_is_at_most_30_seconds_and_respects_freshness():
    db = make_session()
    device = _device(db)
    ref = SourceRef("device", device_id=device.id)
    page = seed_page(db, "p", "public", [(ref, "Media")])
    probe = load_current_states(db, [ref], NOW)[ref]
    window = freshness_deadline(NOW, probe.interval_seconds) - NOW
    device.last_monitored_at = NOW + timedelta(seconds=10) - window
    db.commit()
    states = list(load_current_states(db, [ref], NOW).values())
    assert next_deadline(page, NOW, states) == NOW + timedelta(seconds=10)
    assert next_deadline(page, NOW, []) == NOW + timedelta(seconds=30)
    assert next_deadline(page, NOW, [], notice_expiries=[NOW + timedelta(seconds=5)]) == NOW + timedelta(seconds=5)
    assert next_deadline(page, NOW, [], maintenance_edges=[NOW + timedelta(seconds=7)]) == NOW + timedelta(seconds=7)
    assert next_deadline(page, NOW, [], notice_expiries=[NOW - timedelta(seconds=5)]) == NOW + timedelta(seconds=30)
    payload = build_page_payload(db, page, "public", NOW)
    assert payload["valid_until"] == (NOW + timedelta(seconds=10)).isoformat()
    assert payload["generated_at"] == NOW.isoformat()


def test_next_slot_boundary_bounds_deadline():
    db = make_session()
    page = seed_page(db, "p", "public")
    page.heartbeat_window = "24h"
    odd = NOW + timedelta(seconds=7)
    assert next_deadline(page, odd, []) <= odd + timedelta(seconds=30)
    assert next_deadline(page, odd, []) > odd
    quiet = NOW + timedelta(seconds=10)
    assert next_deadline(page, quiet, []) == quiet + timedelta(seconds=30)
    page.heartbeat_window = "1h"
    cross = NOW + timedelta(seconds=45)
    assert next_deadline(page, cross, []) == NOW + timedelta(seconds=60)


def test_slots_are_stable_within_a_slot_and_shift_across_a_boundary():
    db = make_session()
    device = _device(db, last_monitored_at=NOW - timedelta(seconds=30))
    _history(db, device, 30, rtt=20.0)
    _history(db, device, 0.5, rtt=41.3)
    ref = SourceRef("device", device_id=device.id)
    page = seed_page(db, "p", "public", [(ref, "Media")])
    _set_extras(db, page, rtt_graph=True)

    def slots(now):
        item = build_page_payload(db, page, "public", now)["groups"][0]["items"][0]
        return item["heartbeats"], item["response"]

    base = NOW + timedelta(seconds=5)
    assert slots(base) == slots(base + timedelta(seconds=30)) == slots(base + timedelta(seconds=54))
    assert slots(base) != slots(base + timedelta(seconds=60))
    assert all(v is None or v == round(v) for v in slots(base)[1])


def test_payload_values_are_quantised():
    db = make_session()
    device = _device(db)
    for minutes, rtt in ((50, 10.4), (40, 20.6), (30, 33.33)):
        _history(db, device, minutes, rtt=rtt)
    ref = SourceRef("device", device_id=device.id)
    page = seed_page(db, "p", "public", [(ref, "Media")])
    _set_extras(db, page, avg_response=True, p95_response=True, failure_rate=True)
    item = build_page_payload(db, page, "public", NOW)["groups"][0]["items"][0]
    for key in ("avg_response", "p95_response"):
        assert item["metrics"][key] == round(item["metrics"][key])
    for key in ("percent", "coverage"):
        assert item["availability"][key] is None or item["availability"][key] == round(item["availability"][key], 4)
