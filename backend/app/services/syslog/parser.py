from __future__ import annotations

import csv
import ipaddress
import json
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from io import StringIO
from typing import Any


RFC3164_RE = re.compile(
    r"^(?:<(?P<pri>\d{1,3})>)?"
    r"(?P<timestamp>[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2})\s+"
    r"(?P<host>[^\s]+)\s+"
    r"(?P<message>.*)$"
)
RFC5424_RE = re.compile(
    r"^(?:<(?P<pri>\d{1,3})>)?1\s+"
    r"(?P<timestamp>\S+)\s+"
    r"(?P<host>\S+)\s+"
    r"(?P<app>\S+)\s+"
    r"(?P<procid>\S+)\s+"
    r"(?P<msgid>\S+)\s+"
    r"(?P<structured>(?:-|\[[^\]]+\]))\s*"
    r"(?P<message>.*)$"
)
FILTERLOG_PREFIX_RE = re.compile(r"(?:^|\s)filterlog(?:\[\d+\])?:\s*(?P<body>.+)$")
KEY_VALUE_RE = re.compile(
    r"\b(?P<key>src|dst|spt|dpt|proto|action|in|out)=('([^']*)'|\"([^\"]*)\"|[^\s]+)",
    re.IGNORECASE,
)
ACTION_TOKEN_RE = re.compile(r"(?:^|\s)(?P<action>DROP|ACCEPT|REJECT|ALLOW|DENY|BLOCK|PASS)(?:\s|:|$)", re.IGNORECASE)

MAX_TEXT_LENGTH = 255


@dataclass(frozen=True)
class ParsedFirewallEvent:
    event_time: datetime | None
    source_host: str | None
    src_ip: str | None
    dst_ip: str | None
    src_port: int | None
    dst_port: int | None
    protocol: str | None
    action: str | None
    interface: str | None
    direction: str | None
    rule_id: str | None
    tracker_id: str | None
    reason: str | None
    raw_log: str


def parse_syslog_line(raw_line: bytes | str, sender_host: str | None = None) -> ParsedFirewallEvent:
    raw_log = sanitize_raw_log(raw_line)
    event_time: datetime | None = None
    source_host: str | None = sender_host
    message = raw_log

    json_data = parse_json(raw_log)
    if json_data is not None:
        return parsed_from_json(json_data, raw_log, source_host)

    rfc5424 = RFC5424_RE.match(raw_log)
    if rfc5424:
        event_time = parse_datetime(rfc5424.group("timestamp"))
        source_host = clean_text(rfc5424.group("host")) or source_host
        message = rfc5424.group("message")
    else:
        rfc3164 = RFC3164_RE.match(raw_log)
        if rfc3164:
            event_time = parse_rfc3164_time(rfc3164.group("timestamp"))
            source_host = clean_text(rfc3164.group("host")) or source_host
            message = rfc3164.group("message")

    filterlog = parse_filterlog(message)
    if filterlog is not None:
        return ParsedFirewallEvent(
            event_time=event_time,
            source_host=source_host,
            raw_log=raw_log,
            **filterlog,
        )

    key_value = parse_key_value_message(message)
    if key_value is not None:
        return ParsedFirewallEvent(
            event_time=event_time,
            source_host=source_host,
            raw_log=raw_log,
            **key_value,
        )

    return ParsedFirewallEvent(
        event_time=event_time,
        source_host=source_host,
        src_ip=None,
        dst_ip=None,
        src_port=None,
        dst_port=None,
        protocol=None,
        action=None,
        interface=None,
        direction=None,
        rule_id=None,
        tracker_id=None,
        reason=None,
        raw_log=raw_log,
    )


def sanitize_raw_log(raw_line: bytes | str) -> str:
    if isinstance(raw_line, bytes):
        value = raw_line.decode("utf-8", errors="replace")
    else:
        value = raw_line
    value = value.replace("\x00", "")
    value = value.replace("\r", "\\r").replace("\n", "\\n")
    return value[:8192]


def parse_json(raw_log: str) -> dict[str, Any] | None:
    try:
        data = json.loads(raw_log)
    except json.JSONDecodeError:
        return None
    return data if isinstance(data, dict) else None


def parsed_from_json(
    data: dict[str, Any],
    raw_log: str,
    sender_host: str | None,
) -> ParsedFirewallEvent:
    event_time = parse_datetime(first_present(data, "event_time", "time", "timestamp", "@timestamp"))
    source_host = clean_text(first_present(data, "source_host", "host", "hostname")) or sender_host
    src_ip = clean_ip(first_present(data, "src_ip", "source_ip", "src", "source.address"))
    dst_ip = clean_ip(first_present(data, "dst_ip", "destination_ip", "dst", "destination.address"))
    return ParsedFirewallEvent(
        event_time=event_time,
        source_host=source_host,
        src_ip=src_ip,
        dst_ip=dst_ip,
        src_port=clean_port(first_present(data, "src_port", "source_port", "spt")),
        dst_port=clean_port(first_present(data, "dst_port", "destination_port", "dpt")),
        protocol=clean_protocol(first_present(data, "protocol", "proto")),
        action=clean_text(first_present(data, "action", "event.action")),
        interface=clean_text(first_present(data, "interface", "iface", "in", "out")),
        direction=clean_text(first_present(data, "direction")),
        rule_id=clean_text(first_present(data, "rule_id", "rule")),
        tracker_id=clean_text(first_present(data, "tracker_id", "tracker")),
        reason=clean_text(first_present(data, "reason")),
        raw_log=raw_log,
    )


def parse_filterlog(message: str) -> dict[str, Any] | None:
    match = FILTERLOG_PREFIX_RE.search(message)
    body = match.group("body") if match else message
    if "," not in body:
        return None
    try:
        fields = next(csv.reader(StringIO(body)))
    except csv.Error:
        return None
    if len(fields) < 19:
        return None

    protocol = clean_protocol(value_at(fields, 16))
    src_port = None
    dst_port = None
    if protocol in {"tcp", "udp"} and len(fields) > 21:
        src_port = clean_port(value_at(fields, 20))
        dst_port = clean_port(value_at(fields, 21))

    return {
        "src_ip": clean_ip(value_at(fields, 18)),
        "dst_ip": clean_ip(value_at(fields, 19)),
        "src_port": src_port,
        "dst_port": dst_port,
        "protocol": protocol,
        "action": clean_text(value_at(fields, 6)),
        "interface": clean_text(value_at(fields, 4)),
        "direction": clean_text(value_at(fields, 7)),
        "rule_id": clean_text(value_at(fields, 0)),
        "tracker_id": clean_text(value_at(fields, 3)),
        "reason": clean_text(value_at(fields, 5)),
    }


def parse_key_value_message(message: str) -> dict[str, Any] | None:
    values: dict[str, str] = {}
    for match in KEY_VALUE_RE.finditer(message):
        value = match.group(3) or match.group(4) or match.group(2)
        values[match.group("key").lower()] = value.strip("'\"")
    if not values:
        return None
    action = values.get("action")
    if action is None:
        action_match = ACTION_TOKEN_RE.search(message)
        if action_match:
            action = action_match.group("action")
    return {
        "src_ip": clean_ip(values.get("src")),
        "dst_ip": clean_ip(values.get("dst")),
        "src_port": clean_port(values.get("spt")),
        "dst_port": clean_port(values.get("dpt")),
        "protocol": clean_protocol(values.get("proto")),
        "action": clean_text(action.lower() if action else None),
        "interface": clean_text(values.get("in") or values.get("out")),
        "direction": "in" if values.get("in") else "out" if values.get("out") else None,
        "rule_id": None,
        "tracker_id": None,
        "reason": None,
    }


def first_present(data: dict[str, Any], *keys: str) -> Any:
    for key in keys:
        value = data
        for part in key.split("."):
            if not isinstance(value, dict) or part not in value:
                value = None
                break
            value = value[part]
        if value not in (None, ""):
            return value
    return None


def value_at(fields: list[str], index: int) -> str | None:
    return fields[index].strip() if index < len(fields) else None


def clean_text(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).replace("\x00", "").replace("\r", " ").replace("\n", " ").strip()
    if not text or text == "-":
        return None
    return text[:MAX_TEXT_LENGTH]


def clean_ip(value: Any) -> str | None:
    text = clean_text(value)
    if text is None:
        return None
    try:
        return str(ipaddress.ip_address(text))
    except ValueError:
        return None


def clean_port(value: Any) -> int | None:
    try:
        port = int(str(value))
    except (TypeError, ValueError):
        return None
    return port if 0 <= port <= 65535 else None


def clean_protocol(value: Any) -> str | None:
    text = clean_text(value)
    if text is None:
        return None
    return text.lower()[:20]


def parse_datetime(value: Any) -> datetime | None:
    text = clean_text(value)
    if text is None:
        return None
    if text.endswith("Z"):
        text = f"{text[:-1]}+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed


def parse_rfc3164_time(value: str) -> datetime | None:
    try:
        parsed = datetime.strptime(value, "%b %d %H:%M:%S")
    except ValueError:
        return None
    now = datetime.now(timezone.utc)
    return parsed.replace(year=now.year, tzinfo=timezone.utc)
