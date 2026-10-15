import base64

import pytest
from pydantic import ValidationError

from app.schemas.admin import CloudProviderCreate
from app.schemas.auth import ProfileUpdateRequest
from app.schemas.topology import DeviceBulkImportRequest

PNG_DATA_URI = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="


def test_avatar_accepts_verified_raster_and_rejects_spoofed_content():
    assert ProfileUpdateRequest(avatar_data=PNG_DATA_URI).avatar_data == PNG_DATA_URI
    spoofed = "data:image/png;base64," + base64.b64encode(b"not an image").decode()
    with pytest.raises(ValidationError, match="valid PNG, JPEG, or WebP"):
        ProfileUpdateRequest(avatar_data=spoofed)


def test_cloud_svg_rejects_active_content_and_external_references():
    malicious = base64.b64encode(
        b'<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'
    ).decode()
    with pytest.raises(ValidationError, match="blocked active content"):
        CloudProviderCreate(
            name="Unsafe Cloud",
            icon="custom",
            icon_data=f"data:image/svg+xml;base64,{malicious}",
        )


def test_bulk_import_has_server_side_row_limit():
    with pytest.raises(ValidationError, match="at most 5000"):
        DeviceBulkImportRequest(devices=[{"ip_address": "10.0.0.1"}] * 5001)
