from __future__ import annotations

import base64
import binascii
import re
from dataclasses import dataclass
from email.message import EmailMessage
from email.utils import formataddr
from html import escape
from urllib.parse import urlparse

from sqlalchemy import select
from sqlalchemy.orm import Session


EMAIL_BRANDING_DEFAULTS: dict[str, str] = {
    "email_brand_theme": "login_banner",
    "email_brand_name": "",
    "email_brand_accent": "#1d9ab0",
    "email_brand_logo": "",
    "email_brand_footer": "",
    "email_brand_url": "",
    "email_brand_show_support": "true",
}

# The default logo is linked rather than embedded: an embedded image shows up as an attachment in
# Gmail and Outlook, and linking to the installation itself would make every recipient's mail client
# call back to it. A public, versioned asset on GitHub avoids both.
# RELEASE: this points at the `test` branch while the PNG only exists there. When the version is
# released to `main`, change `test` to `main` here (see docs/PROJECT_RULES.md § Release Process).
DEFAULT_LOGO_URL = "https://raw.githubusercontent.com/xoriin/NetMap/test/frontend/public/brand/email-logo.png"
# The same PNG, served by the app itself. The in-app preview uses this because the app's
# Content-Security-Policy (img-src 'self') applies to the preview frame and blocks the GitHub URL.
PREVIEW_DEFAULT_LOGO_URL = "/brand/email-logo.png"
_LOGO_CID = "netmap-brand-logo"


@dataclass(frozen=True)
class EmailContent:
    eyebrow: str
    heading: str
    paragraphs: tuple[str, ...]
    detail_title: str = ""
    detail_text: str = ""
    action_label: str = ""
    action_url: str = ""
    note: str = ""


def load_email_branding_settings(db: Session) -> dict[str, str]:
    """Load the bounded branding fields plus existing installation contact details."""
    from app.models.system_setting import SystemSetting

    allowed = set(EMAIL_BRANDING_DEFAULTS) | {"app_name", "support_email", "support_url"}
    result = {
        **EMAIL_BRANDING_DEFAULTS,
        "app_name": "NetMap",
        "support_email": "",
        "support_url": "",
    }
    rows = db.scalars(select(SystemSetting).where(SystemSetting.key.in_(allowed))).all()
    for row in rows:
        result[row.key] = row.value
    return result


def branding_subset(settings: dict[str, str]) -> dict[str, str]:
    keys = set(EMAIL_BRANDING_DEFAULTS) | {"app_name", "support_email", "support_url"}
    return {key: str(settings[key]) for key in keys if key in settings}


def build_email_message(
    plain_text: str,
    settings: dict[str, str],
    *,
    subject: str,
    from_addr: str,
    to_addr: str,
    content: EmailContent | None = None,
) -> EmailMessage:
    brand_name = _brand_name(settings)
    message = EmailMessage()
    message["Subject"] = subject
    message["From"] = formataddr((brand_name, from_addr))
    message["To"] = to_addr
    message.set_content(plain_text)
    custom_logo = _custom_logo(settings.get("email_brand_logo", ""))
    logo_src = f"cid:{_LOGO_CID}" if custom_logo else DEFAULT_LOGO_URL
    message.add_alternative(_render_html(plain_text, settings, content, logo_src), subtype="html")

    if custom_logo:
        logo_mime, logo_bytes, logo_name = custom_logo
        maintype, subtype = logo_mime.split("/", 1)
        message.get_payload()[-1].add_related(
            logo_bytes,
            maintype=maintype,
            subtype=subtype,
            cid=f"<{_LOGO_CID}>",
            filename=logo_name,
            disposition="inline",
        )
    return message


PREVIEW_CONTENT = EmailContent(
    eyebrow="Account security",
    heading="Reset your password",
    paragraphs=(
        "Hi Alex,",
        "We received a request to reset the password for your account.",
    ),
    detail_title="Link expires in 1 hour",
    detail_text="For your security, this link can only be used once.",
    action_label="Set a new password",
    action_url="https://netmap.example/reset-password",
    note="If you did not request this, you can safely ignore this email. Your password will not change.",
)


def render_email_preview_html(settings: dict[str, str]) -> str:
    """Render the sample reset email as sent, with an embedded custom logo inlined for a browser."""
    custom_logo = _custom_logo(settings.get("email_brand_logo", ""))
    if custom_logo:
        logo_mime, logo_bytes, _name = custom_logo
        logo_src = f"data:{logo_mime};base64,{base64.b64encode(logo_bytes).decode('ascii')}"
    else:
        logo_src = PREVIEW_DEFAULT_LOGO_URL
    return _render_html("", settings, PREVIEW_CONTENT, logo_src)


def _render_html(plain_text: str, settings: dict[str, str], content: EmailContent | None, logo_src: str) -> str:
    brand_name = _brand_name(settings)
    accent = _safe_accent(settings.get("email_brand_accent", ""))
    theme = settings.get("email_brand_theme", "login_banner")
    if theme not in {"login_banner", "clean_stripe"}:
        theme = "login_banner"
    if content is None:
        chunks = tuple(chunk.strip() for chunk in plain_text.split("\n\n") if chunk.strip())
        content = EmailContent(
            eyebrow="Notification",
            heading=chunks[0].splitlines()[0] if chunks else "Notification",
            paragraphs=chunks[1:] if len(chunks) > 1 else chunks,
        )

    safe_name = escape(brand_name)
    safe_logo = escape(logo_src, quote=True)
    header = _render_banner_header(safe_name, accent, safe_logo) if theme == "login_banner" else _render_stripe_header(safe_name, safe_logo)
    paragraphs = "".join(
        f'<p style="margin:0 0 16px;color:#4a6070;">{escape(paragraph).replace(chr(10), "<br>")}</p>'
        for paragraph in content.paragraphs
    )
    detail = ""
    if content.detail_title or content.detail_text:
        detail = (
            f'<div style="margin:20px 0;padding:14px 16px;border-left:3px solid {accent};'
            'border-radius:0 6px 6px 0;background:#ecf1f6;color:#4a6070;">'
            f'<strong style="display:block;color:#1a2c38;font-weight:600;">{escape(content.detail_title)}</strong>'
            f'{escape(content.detail_text)}</div>'
        )
    action = ""
    if content.action_label and _safe_http_url(content.action_url):
        action = (
            '<a href="' + escape(content.action_url, quote=True) + '" style="display:inline-block;margin:2px 0 20px;'
            'border-radius:10px;background:#0d5963;color:#ffffff;padding:12px 19px;text-decoration:none;'
            'font-weight:600;box-shadow:0 3px 12px rgba(29,100,114,.28);">'
            + escape(content.action_label) + '</a>'
        )
    note = (
        f'<p style="margin:0;color:#7a96a8;font-size:12px;">{escape(content.note)}</p>'
        if content.note else ""
    )
    footer = _render_footer(settings, safe_name)
    top_border = f"border-top:5px solid {accent};" if theme == "clean_stripe" else ""
    return f"""<!doctype html>
<html><body style="margin:0;padding:0;background:#f0f4f8;">
<div style="display:none;max-height:0;overflow:hidden;color:transparent;">{escape(content.heading)}</div>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f0f4f8;"><tr><td style="padding:30px 12px;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="{top_border}max-width:600px;margin:0 auto;overflow:hidden;border:1px solid rgba(210,214,218,.85);border-radius:16px;background:#ffffff;box-shadow:0 4px 20px rgba(0,0,0,.10),0 1px 6px rgba(0,0,0,.06);font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;line-height:1.55;">
{header}
<tr><td style="padding:30px 32px 28px;">
<div style="margin-bottom:8px;color:#1d6472;font-size:12px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;">{escape(content.eyebrow)}</div>
<h1 style="margin:0 0 16px;color:#1a2c38;font-size:25px;line-height:1.25;font-weight:600;">{escape(content.heading)}</h1>
{paragraphs}{detail}{action}{note}
</td></tr>{footer}
</table></td></tr></table></body></html>"""


def _render_banner_header(brand_name: str, accent: str, logo_src: str) -> str:
    return f"""<tr><td style="padding:22px 28px;border-bottom:3px solid {accent};background:#091420;color:#ffffff;">
<table role="presentation" cellspacing="0" cellpadding="0"><tr><td style="padding-right:10px;"><img src="{logo_src}" width="42" height="42" alt="{brand_name} logo" style="display:block;width:42px;height:42px;object-fit:contain;"></td>
<td><strong style="display:block;color:#ffffff;font-size:17px;font-weight:600;letter-spacing:.01em;">{brand_name}</strong><span style="color:#7a96a8;font-size:11px;letter-spacing:.08em;text-transform:uppercase;">Network visibility</span></td></tr></table>
</td></tr>"""


def _render_stripe_header(brand_name: str, logo_src: str) -> str:
    return f"""<tr><td style="padding:20px 30px 0;background:#ffffff;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td style="padding-right:10px;"><img src="{logo_src}" width="36" height="36" alt="{brand_name} logo" style="display:block;width:36px;height:36px;object-fit:contain;"></td>
<td style="width:100%;"><strong style="display:block;color:#1a2c38;font-size:16px;font-weight:600;">{brand_name}</strong><span style="color:#7a96a8;font-size:11px;letter-spacing:.08em;text-transform:uppercase;">Network visibility</span></td><td style="white-space:nowrap;color:#7a96a8;font-size:12px;">Account notification</td></tr></table>
</td></tr>"""


def _render_footer(settings: dict[str, str], brand_name: str) -> str:
    lines = [f"<strong style=\"color:#4a6070;font-weight:600;\">{brand_name}</strong>"]
    install_url = settings.get("email_brand_url", "").strip()
    if _safe_http_url(install_url):
        label = escape(urlparse(install_url).netloc or install_url)
        lines[0] += f' · <a href="{escape(install_url, quote=True)}" style="color:#4a6070;">{label}</a>'
    footer_text = settings.get("email_brand_footer", "").strip()
    if footer_text:
        lines.append(escape(footer_text))
    if settings.get("email_brand_show_support", "true").lower() == "true":
        contacts = [settings.get("support_email", "").strip(), settings.get("support_url", "").strip()]
        contacts = [escape(value) for value in contacts if value]
        if contacts:
            lines.append("Need help? " + " or ".join(contacts))
    return '<tr><td style="padding:18px 28px;border-top:1px solid rgba(209,220,230,.8);background:#f4f7fa;color:#7a96a8;font-size:12px;">' + "<br>".join(lines) + "</td></tr>"


def _safe_http_url(value: str) -> bool:
    try:
        parsed = urlparse(value)
    except ValueError:
        return False
    return parsed.scheme in {"http", "https"} and bool(parsed.netloc)


def _brand_name(settings: dict[str, str]) -> str:
    value = settings.get("email_brand_name", "").strip() or settings.get("app_name", "").strip() or "NetMap"
    return " ".join(value.splitlines())[:80] or "NetMap"


def _safe_accent(value: str) -> str:
    return value if re.fullmatch(r"#[0-9A-Fa-f]{6}", value) else "#1d9ab0"


def _custom_logo(data_uri: str) -> tuple[str, bytes, str] | None:
    """Decode an uploaded raster logo for embedding, or None to use the linked default."""
    if not data_uri:
        return None
    try:
        header, separator, encoded = data_uri.partition(",")
        mime_type = header[5:].split(";", 1)[0]
        extension = {"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp"}[mime_type]
        if not separator:
            raise ValueError("missing data URI separator")
        return mime_type, base64.b64decode(encoded, validate=True), f"brand-logo.{extension}"
    except (KeyError, ValueError, binascii.Error):
        return None
