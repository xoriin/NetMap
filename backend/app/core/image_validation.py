from __future__ import annotations

import base64
import binascii
import io
from xml.etree.ElementTree import Element

from defusedxml import ElementTree as SafeElementTree
from PIL import Image, UnidentifiedImageError

MAX_AVATAR_BYTES = 2 * 1024 * 1024
MAX_ICON_BYTES = 300_000
MAX_EMAIL_LOGO_BYTES = 256 * 1024
MAX_IMAGE_PIXELS = 16_000_000

_RASTER_MIME_TO_FORMAT = {
    "image/png": "PNG",
    "image/jpeg": "JPEG",
    "image/webp": "WEBP",
}
_BLOCKED_SVG_TAGS = {"script", "foreignobject", "iframe", "object", "embed"}


def validate_avatar_data_uri(value: str) -> str:
    mime_type, payload = _decode_data_uri(value, set(_RASTER_MIME_TO_FORMAT), MAX_AVATAR_BYTES)
    try:
        with Image.open(io.BytesIO(payload)) as image:
            if image.format != _RASTER_MIME_TO_FORMAT[mime_type]:
                raise ValueError("Avatar image type does not match its content")
            width, height = image.size
            if width < 1 or height < 1 or width * height > MAX_IMAGE_PIXELS:
                raise ValueError("Avatar image dimensions are not allowed")
            image.verify()
    except (UnidentifiedImageError, OSError, SyntaxError, Image.DecompressionBombError) as exc:
        raise ValueError("Avatar must contain a valid PNG, JPEG, or WebP image") from exc
    return value


def validate_icon_data_uri(value: str) -> str:
    allowed = set(_RASTER_MIME_TO_FORMAT) | {"image/svg+xml"}
    mime_type, payload = _decode_data_uri(value, allowed, MAX_ICON_BYTES)
    if mime_type != "image/svg+xml":
        validate_avatar_data_uri(value)
        return value

    try:
        root = SafeElementTree.fromstring(payload)
    except Exception as exc:
        raise ValueError("Icon must contain valid SVG markup") from exc
    if _local_name(root.tag) != "svg":
        raise ValueError("Icon SVG must have an svg root element")
    _validate_svg_tree(root)
    return value


def validate_email_logo_data_uri(value: str) -> str:
    """Validate a small raster logo suitable for broad email-client support."""
    mime_type, payload = _decode_data_uri(value, set(_RASTER_MIME_TO_FORMAT), MAX_EMAIL_LOGO_BYTES)
    try:
        with Image.open(io.BytesIO(payload)) as image:
            if image.format != _RASTER_MIME_TO_FORMAT[mime_type]:
                raise ValueError("Email logo type does not match its content")
            width, height = image.size
            if width < 1 or height < 1 or width * height > MAX_IMAGE_PIXELS:
                raise ValueError("Email logo dimensions are not allowed")
            image.verify()
    except (UnidentifiedImageError, OSError, SyntaxError, Image.DecompressionBombError) as exc:
        raise ValueError("Email logo must contain a valid PNG, JPEG, or WebP image") from exc
    return value


def _decode_data_uri(value: str, allowed_mime_types: set[str], max_bytes: int) -> tuple[str, bytes]:
    header, separator, encoded = value.partition(",")
    if not separator or not header.startswith("data:") or not header.endswith(";base64"):
        raise ValueError("Image must be a base64 data URI")
    mime_type = header[5:-7].lower()
    if mime_type not in allowed_mime_types:
        raise ValueError("Image type is not allowed")
    if len(encoded) > ((max_bytes + 2) // 3) * 4 + 4:
        raise ValueError(f"Image is too large ({max_bytes // 1024} KB max)")
    try:
        payload = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise ValueError("Image contains invalid base64 data") from exc
    if not payload:
        raise ValueError("Image payload is empty")
    if len(payload) > max_bytes:
        raise ValueError(f"Image is too large ({max_bytes // 1024} KB max)")
    return mime_type, payload


def _local_name(name: str) -> str:
    return name.rsplit("}", 1)[-1].lower()


def _validate_svg_tree(root: Element) -> None:
    for element in root.iter():
        if _local_name(element.tag) in _BLOCKED_SVG_TAGS:
            raise ValueError("Icon SVG contains blocked active content")
        for raw_name, raw_value in element.attrib.items():
            name = _local_name(raw_name)
            value = raw_value.strip().lower()
            if name.startswith("on"):
                raise ValueError("Icon SVG event handlers are not allowed")
            if name in {"href", "src"} and value and not value.startswith("#"):
                raise ValueError("Icon SVG external references are not allowed")
            if "url(" in value and "url(#" not in value:
                raise ValueError("Icon SVG external references are not allowed")
