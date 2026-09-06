"""FAA UAS Declaration of Compliance lookup: serial number -> make / model.

Ported from the D.A.R.S. Android app (``DroneInfoLookup.java``). Resolves an ODID
serial number (Basic-ID, id_type 1) to the manufacturer / model the maker
declared to the FAA, via the public ``uasdoc.faa.gov`` API.

This runs server-side in the integration (not in the Lovelace card) on purpose:
the browser cannot perform the cross-origin cookie handshake the API needs, and
CORS would block the request anyway. The Python side does the same homepage ->
cookie -> query flow the app does.

Data source: FAA UAS Declaration of Compliance database (uasdoc.faa.gov). This
returns the declared make / model / declaration reg number for a serial — public
product data, no owner or personal information.
"""

from __future__ import annotations

import logging
from urllib.parse import quote

import aiohttp

_LOGGER = logging.getLogger(__name__)

_API = "https://uasdoc.faa.gov/api/v1/serialNumbers"
_HOME = "https://uasdoc.faa.gov/listdocs"
_UA = "Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36"
_TIMEOUT = aiohttp.ClientTimeout(total=12)


class FaaLookup:
    """Caches serial -> declaration info. Uses one aiohttp session so the site's
    session cookie (set on the homepage) is replayed automatically on the API
    call by the session's cookie jar."""

    def __init__(self, session: aiohttp.ClientSession) -> None:
        self._session = session
        self._cache: dict[str, dict] = {}
        self._cookie_ready = False

    def cached(self, serial: str | None) -> dict | None:
        """Return a previously-resolved result (or None if not looked up yet)."""
        if not serial:
            return None
        return self._cache.get(serial.strip())

    async def _ensure_cookie(self) -> None:
        if self._cookie_ready:
            return
        try:
            async with self._session.get(
                _HOME, headers={"User-Agent": _UA}, timeout=_TIMEOUT
            ) as resp:
                await resp.read()
                self._cookie_ready = resp.status == 200
        except Exception as err:  # noqa: BLE001 - network best-effort
            _LOGGER.debug("FAA cookie fetch failed: %s", err)

    async def async_lookup(self, serial: str) -> dict:
        """Resolve a serial to ``{found, make, model, registration}``.

        Results (including negative ones) are cached, so each serial hits the
        network at most once. Transient network errors are not cached."""
        serial = (serial or "").strip()
        if not serial:
            return {"found": False}
        if serial in self._cache:
            return self._cache[serial]

        try:
            await self._ensure_cookie()
            info = await self._query(serial)
            if info.pop("_retry", False):
                # Session cookie likely stale — refresh once and retry.
                self._cookie_ready = False
                await self._ensure_cookie()
                info = await self._query(serial)
                info.pop("_retry", None)
        except Exception as err:  # noqa: BLE001 - network best-effort
            _LOGGER.debug("FAA lookup error for %s: %s", serial, err)
            return {"found": False}  # don't cache transient failures

        self._cache[serial] = info
        return info

    async def _query(self, serial: str) -> dict:
        url = (
            f"{_API}?itemsPerPage=8&pageIndex=0"
            "&orderBy[0]=updatedAt&orderBy[1]=DESC"
            f"&findBy=serialNumber&serialNumber={quote(serial)}"
        )
        headers = {
            "User-Agent": _UA,
            "Accept": "application/json, text/plain, */*",
            "Accept-Language": "en-US,en;q=0.5",
            "Referer": _HOME,
            "client": "external",
        }
        async with self._session.get(url, headers=headers, timeout=_TIMEOUT) as resp:
            if resp.status in (401, 403):
                return {"found": False, "_retry": True}
            if resp.status != 200:
                return {"found": False}
            data = await resp.json(content_type=None)
        return _parse(data, serial)


def _parse(root: dict, serial: str) -> dict:
    try:
        items = (root or {}).get("data", {}).get("items", [])
        if not items:
            return {"found": False}
        item = items[0]
        return {
            "found": True,
            "make": item.get("makeName") or item.get("manufacturer"),
            "model": item.get("modelName") or item.get("model"),
            "registration": item.get("registrationNumber"),
        }
    except Exception:  # noqa: BLE001 - defensive against schema drift
        return {"found": False}
