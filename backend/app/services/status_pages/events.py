from __future__ import annotations

import logging
from collections.abc import Iterable
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from app.services.status_pages.sources import SourceRef

logger = logging.getLogger(__name__)


def notify_pages_changed(page_ids: Iterable[int]) -> None:
    from app.services.status_pages import cache

    try:
        cache.status_cache.invalidate_pages(page_ids)
    except Exception:
        logger.exception("Could not schedule status page rebuilds")


def notify_sources_checked(refs: Iterable[SourceRef]) -> None:
    from app.services.status_pages import cache

    try:
        cache.status_cache.sources_checked(refs)
    except Exception:
        logger.exception("Could not schedule status page rebuilds for checked sources")
