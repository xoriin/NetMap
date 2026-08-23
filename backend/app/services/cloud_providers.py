"""Cloud provider helpers.

Providers used to live as a JSON catalogue in the `cloud_provider_catalog` system
setting, matched to pools by name/alias string comparison. Migration `0068` promoted
them to the `cloud_providers` table, so identity is now referential and a rename no
longer splits a provider's group.

Only the slug helper survives here; the catalogue reader/writer were removed with the
blob. Migration `0068` reads the old setting row directly in raw SQL, and the row is
deliberately left in place for one release as a rollback path.
"""

import re


CLOUD_PROVIDERS_KEY = "cloud_provider_catalog"


def provider_key(value: str) -> str:
    """Slugify a provider name into its stable lookup key."""
    return re.sub(r"[^a-z0-9]+", "-", value.strip().lower()).strip("-")[:60]
