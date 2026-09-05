"""Binary sensors for D.A.R.S.: drone-present and receiver-connected."""

from __future__ import annotations

from homeassistant.components.binary_sensor import (
    BinarySensorDeviceClass,
    BinarySensorEntity,
)
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import EntityCategory
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import DOMAIN
from .coordinator import DarsCoordinator
from .entity import DarsEntity


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    coordinator: DarsCoordinator = hass.data[DOMAIN][entry.entry_id]
    async_add_entities(
        [
            DarsDroneDetected(coordinator, entry),
            DarsConnected(coordinator, entry),
        ]
    )


class DarsDroneDetected(DarsEntity, BinarySensorEntity):
    """On whenever at least one drone is currently being detected."""

    _attr_translation_key = "drone_detected"
    _attr_device_class = BinarySensorDeviceClass.OCCUPANCY

    def __init__(self, coordinator: DarsCoordinator, entry: ConfigEntry) -> None:
        super().__init__(coordinator, entry)
        self._attr_unique_id = f"{entry.unique_id}_drone_detected"

    @property
    def is_on(self) -> bool:
        return len(self.coordinator.drones) > 0

    @property
    def extra_state_attributes(self) -> dict:
        return {"count": len(self.coordinator.drones)}


class DarsConnected(DarsEntity, BinarySensorEntity):
    """Diagnostic: is the BLE link to the receiver up. Stays available so it can
    report 'off' while the receiver is out of range."""

    _attr_translation_key = "connected"
    _attr_device_class = BinarySensorDeviceClass.CONNECTIVITY
    _attr_entity_category = EntityCategory.DIAGNOSTIC

    def __init__(self, coordinator: DarsCoordinator, entry: ConfigEntry) -> None:
        super().__init__(coordinator, entry)
        self._attr_unique_id = f"{entry.unique_id}_connected"

    @property
    def available(self) -> bool:
        return True

    @property
    def is_on(self) -> bool:
        return self.coordinator.connected

    @property
    def extra_state_attributes(self) -> dict:
        return {"licensed": self.coordinator.licensed}
