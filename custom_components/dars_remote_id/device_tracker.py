"""Map tracker following the nearest detected drone.

A single tracker keeps the integration's map footprint simple: it always shows
the strongest-signal drone that has a GPS fix. Its attributes carry that drone's
telemetry and the operator location. (Per-drone trackers are a future option.)
"""

from __future__ import annotations

from homeassistant.components.device_tracker import SourceType, TrackerEntity
from homeassistant.config_entries import ConfigEntry
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
    async_add_entities([DarsNearestTracker(coordinator, entry)])


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
