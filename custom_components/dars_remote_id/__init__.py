"""The D.A.R.S. Drone Remote ID integration."""

from __future__ import annotations

import logging
from pathlib import Path

from homeassistant.config_entries import ConfigEntry
from homeassistant.const import CONF_ADDRESS, Platform
from homeassistant.core import HomeAssistant

from .const import CARD_FILENAME, CARD_VERSION, DOMAIN
from .coordinator import DarsCoordinator

_LOGGER = logging.getLogger(__name__)

PLATFORMS: list[Platform] = [
    Platform.BINARY_SENSOR,
    Platform.DEVICE_TRACKER,
    Platform.SENSOR,
]

_CARD_URL = f"/{DOMAIN}/{CARD_FILENAME}"
_CARD_REGISTERED = f"{DOMAIN}_card_registered"


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up D.A.R.S. from a config entry."""
    await _async_register_card(hass)

    address: str = entry.data[CONF_ADDRESS]
    coordinator = DarsCoordinator(hass, address, entry.title)
    await coordinator.async_start()

    hass.data.setdefault(DOMAIN, {})[entry.entry_id] = coordinator
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Unload a config entry."""
    unload_ok = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    if unload_ok:
        coordinator: DarsCoordinator = hass.data[DOMAIN].pop(entry.entry_id)
        await coordinator.async_stop()
    return unload_ok


async def _async_register_card(hass: HomeAssistant) -> None:
    """Serve the bundled Lovelace map card and auto-load it on the frontend.

    This makes ``type: custom:dars-map-card`` available with no manual `www/`
    copy and no Lovelace resource entry — for both HACS and manual installs.
    It is best-effort: a failure here never blocks the integration setup.
    """
    if hass.data.get(_CARD_REGISTERED):
        return
    hass.data[_CARD_REGISTERED] = True
    try:
        # Imported lazily so an API change only disables the card, not the whole
        # integration.
        from homeassistant.components.frontend import add_extra_js_url
        from homeassistant.components.http import StaticPathConfig

        card_path = Path(__file__).parent / CARD_FILENAME
        await hass.http.async_register_static_paths(
            [StaticPathConfig(_CARD_URL, str(card_path), False)]
        )
        add_extra_js_url(hass, f"{_CARD_URL}?v={CARD_VERSION}")
        _LOGGER.debug("Registered D.A.R.S. map card at %s", _CARD_URL)
    except Exception as err:  # noqa: BLE001 - card is optional cosmetic frontend
        hass.data[_CARD_REGISTERED] = False
        _LOGGER.warning("Could not register the D.A.R.S. map card: %s", err)
