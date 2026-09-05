"""Device trackers for D.A.R.S. drones (for Home Assistant's built-in map).

Two flavours:
- ``DarsNearestTracker`` — one always-present tracker following the strongest
  drone. Simple, bounded (a single entity).
- ``DarsDroneTracker`` — one tracker **per drone**, created dynamically as new
  serial-identified drones appear, so every drone shows on the built-in Map card.
  Keyed by serial (uasId) rather than MAC, so a drone that rotates its BLE MAC
  keeps a single entity instead of spawning a new one each rotation. Drones that
  never present a serial are not tracked here (they still appear in the card and
  the count sensor).
"""

from __future__ import annotations

import re

from homeassistant.components.device_tracker import SourceType, TrackerEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.device_registry import CONNECTION_BLUETOOTH, DeviceInfo
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
    async_add_entities([DarsNearestTracker(coordinator, entry)])

    # Dynamically add one tracker per newly-seen drone serial.
    known: set[str] = set()

    @callback
    def _add_new_drones() -> None:
        new = [
            DarsDroneTracker(coordinator, entry, serial)
            for serial in coordinator.active_serials()
            if serial not in known
        ]
        for ent in new:
            known.add(ent._serial)
        if new:
            async_add_entities(new)

    entry.async_on_unload(coordinator.async_add_listener(_add_new_drones))
    _add_new_drones()


class DarsNearestTracker(DarsEntity, TrackerEntity):
    """GPS position of the nearest (strongest-signal) drone."""

    _attr_translation_key = "nearest_drone"
    _attr_icon = "mdi:quadcopter"

    def __init__(self, coordinator: DarsCoordinator, entry: ConfigEntry) -> None:
        super().__init__(coordinator, entry)
        self._attr_unique_id = f"{entry.unique_id}_nearest_drone"

    @property
    def source_type(self) -> SourceType:
        return SourceType.GPS

    @property
    def latitude(self) -> float | None:
        drone = self.coordinator.nearest()
        return drone.lat if drone else None

    @property
    def longitude(self) -> float | None:
        drone = self.coordinator.nearest()
        return drone.lon if drone else None

    @property
    def extra_state_attributes(self) -> dict:
        drone = self.coordinator.nearest()
        return drone.as_dict() if drone else {}


class DarsDroneTracker(TrackerEntity):
    """One tracker for a single drone, keyed by its serial (uasId)."""

    _attr_has_entity_name = False
    _attr_should_poll = False
    _attr_icon = "mdi:quadcopter"

    def __init__(
        self, coordinator: DarsCoordinator, entry: ConfigEntry, serial: str
    ) -> None:
        self.coordinator = coordinator
        self._serial = serial
        slug = re.sub(r"[^A-Za-z0-9]", "", serial) or "unknown"
        self._attr_unique_id = f"{entry.unique_id}_drone_{slug}"
        self._attr_name = f"Drone {serial}"
        # Group under the receiver device.
        self._attr_device_info = DeviceInfo(
            connections={(CONNECTION_BLUETOOTH, coordinator.address)},
            identifiers={(DOMAIN, entry.unique_id)},
        )

    async def async_added_to_hass(self) -> None:
        await super().async_added_to_hass()
        self.async_on_remove(
            self.coordinator.async_add_listener(self.async_write_ha_state)
        )

    @property
    def _drone(self):
        return self.coordinator.drone_for_serial(self._serial)

    @property
    def available(self) -> bool:
        # Available only while this drone is currently detected with a position.
        d = self._drone
        return d is not None and d.lat is not None

    @property
    def source_type(self) -> SourceType:
        return SourceType.GPS

    @property
    def latitude(self) -> float | None:
        d = self._drone
        return d.lat if d else None

    @property
    def longitude(self) -> float | None:
        d = self._drone
        return d.lon if d else None

    @property
    def extra_state_attributes(self) -> dict:
        d = self._drone
        return d.as_dict() if d else {}
