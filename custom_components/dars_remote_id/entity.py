"""Base entity for the D.A.R.S. Drone Remote ID integration."""

from __future__ import annotations

from homeassistant.config_entries import ConfigEntry
from homeassistant.helpers.device_registry import CONNECTION_BLUETOOTH, DeviceInfo
from homeassistant.helpers.entity import Entity

from .const import DOMAIN
from .coordinator import DarsCoordinator


class DarsEntity(Entity):
    """Common wiring: device info + push-update subscription + availability."""

    _attr_has_entity_name = True
    _attr_should_poll = False

    def __init__(self, coordinator: DarsCoordinator, entry: ConfigEntry) -> None:
        self.coordinator = coordinator
        self._entry = entry
        self._attr_device_info = DeviceInfo(
            connections={(CONNECTION_BLUETOOTH, coordinator.address)},
            identifiers={(DOMAIN, entry.unique_id)},
            name=entry.title,
            manufacturer="D.A.R.S.",
            model="Drone Remote ID receiver",
        )

    async def async_added_to_hass(self) -> None:
        await super().async_added_to_hass()
        self.async_on_remove(
            self.coordinator.async_add_listener(self.async_write_ha_state)
        )

    @property
    def available(self) -> bool:
        return self.coordinator.connected
