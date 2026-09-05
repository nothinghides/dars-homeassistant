"""BLE connection + detection coordinator for D.A.R.S. receivers.

The receiver *pushes* detections over a GATT notify characteristic, so this is a
``local_push`` integration: we hold a long-lived connection, subscribe to
0xFFF2, decode each frame into the drone registry, and notify entities. A
periodic tick prunes stale drones and keeps location/RSSI attributes fresh.
"""

from __future__ import annotations

import logging
import time
from collections.abc import Callable
from datetime import timedelta

from bleak.backends.device import BLEDevice
from bleak_retry_connector import (
    BleakClientWithServiceCache,
    establish_connection,
)

from homeassistant.components import bluetooth
from homeassistant.core import CALLBACK_TYPE, HomeAssistant, callback
from homeassistant.helpers.event import async_call_later, async_track_time_interval

from .const import (
    DATA_UUID,
    DRONE_EXPIRE_S,
    RECONNECT_S,
    STATUS_UUID,
    TICK_S,
)
from .decoder import DarsDrone, apply_message, is_licensed, parse_frame

_LOGGER = logging.getLogger(__name__)


class DarsCoordinator:
    """Owns the BLE link and the live drone registry for one receiver."""

    def __init__(self, hass: HomeAssistant, address: str, name: str) -> None:
        self.hass = hass
        self.address = address.upper()
        self.name = name
        self.drones: dict[str, DarsDrone] = {}
        self.connected = False
        # Assume licensed until a successful status read says otherwise, so the
        # integration still works if the (open) read is momentarily blocked.
        self.licensed = True

        self._client: BleakClientWithServiceCache | None = None
        self._listeners: list[CALLBACK_TYPE] = []
        self._cancel_bt: CALLBACK_TYPE | None = None
        self._cancel_tick: CALLBACK_TYPE | None = None
        self._closing = False
        self._connecting = False

    # ----- entity subscription --------------------------------------------- #
    @callback
    def async_add_listener(self, update_callback: CALLBACK_TYPE) -> Callable[[], None]:
        """Register an entity's state-write callback; returns an unsubscribe."""
        self._listeners.append(update_callback)

        def _remove() -> None:
            if update_callback in self._listeners:
                self._listeners.remove(update_callback)

        return _remove

    @callback
    def _async_notify(self) -> None:
        for update_callback in list(self._listeners):
            update_callback()

    # ----- lifecycle ------------------------------------------------------- #
    async def async_start(self) -> None:
        self._cancel_tick = async_track_time_interval(
            self.hass, self._async_tick, timedelta(seconds=TICK_S)
        )
        # Re-attempt whenever the adapter sees the device advertise.
        self._cancel_bt = bluetooth.async_register_callback(
            self.hass,
            self._async_device_seen,
            bluetooth.BluetoothCallbackMatcher(address=self.address, connectable=True),
            bluetooth.BluetoothScanningMode.ACTIVE,
        )
        # Try now in case it is already in range.
        self.hass.async_create_task(self._async_connect())

    async def async_stop(self) -> None:
        self._closing = True
        if self._cancel_bt:
            self._cancel_bt()
            self._cancel_bt = None
        if self._cancel_tick:
            self._cancel_tick()
            self._cancel_tick = None
        await self._async_disconnect()

    @callback
    def _async_device_seen(
        self,
        service_info: bluetooth.BluetoothServiceInfoBleak,
        change: bluetooth.BluetoothChange,
    ) -> None:
        if not self.connected and not self._connecting:
            self.hass.async_create_task(self._async_connect())

    # ----- connection ------------------------------------------------------ #
    async def _async_connect(self) -> None:
        if self._closing or self.connected or self._connecting:
            return
        self._connecting = True
        try:
            ble_device: BLEDevice | None = bluetooth.async_ble_device_from_address(
                self.hass, self.address, connectable=True
            )
            if ble_device is None:
                return  # not in range; the bluetooth callback will retry

            client = await establish_connection(
                BleakClientWithServiceCache,
                ble_device,
                self.name,
                self._on_disconnect,
            )
            self._client = client

            await client.start_notify(DATA_UUID, self._on_frame)

            # Best-effort licence gate — the status read is open (no bond) on the
            # firmware, but proceed if a stack blocks it before bonding.
            try:
                status = await client.read_gatt_char(STATUS_UUID)
                self.licensed = is_licensed(status)
            except Exception as err:  # noqa: BLE001 - read is optional
                _LOGGER.debug("%s: licence read skipped (%s)", self.address, err)
                self.licensed = True

            self.connected = True
            _LOGGER.debug(
                "%s: connected (licensed=%s)", self.address, self.licensed
            )
            self._async_notify()
        except Exception as err:  # noqa: BLE001 - many bleak error types
            _LOGGER.debug("%s: connect failed (%s)", self.address, err)
            await self._async_disconnect()
            self._schedule_reconnect()
        finally:
            self._connecting = False

    @callback
    def _on_disconnect(self, _client: BleakClientWithServiceCache) -> None:
        was_connected = self.connected
        self.connected = False
        self._client = None
        if was_connected:
            self._async_notify()
        if not self._closing:
            self._schedule_reconnect()

    def _schedule_reconnect(self) -> None:
        if self._closing:
            return

        @callback
        def _retry(_now) -> None:
            self.hass.async_create_task(self._async_connect())

        async_call_later(self.hass, RECONNECT_S, _retry)

    async def _async_disconnect(self) -> None:
        client, self._client = self._client, None
        self.connected = False
        if client is not None:
            try:
                await client.disconnect()
            except Exception as err:  # noqa: BLE001
                _LOGGER.debug("%s: disconnect error (%s)", self.address, err)

    # ----- data ------------------------------------------------------------ #
    @callback
    def _on_frame(self, _char, data: bytearray) -> None:
        parsed = parse_frame(data)
        if parsed is None:
            return
        mac, rssi, channel, msg = parsed
        now = time.monotonic()
        drone = self.drones.get(mac)
        is_new = drone is None
        if drone is None:
            drone = DarsDrone(mac=mac, first=now)
            self.drones[mac] = drone
        drone.rssi = rssi
        drone.channel = channel
        drone.last = now
        apply_message(drone, msg)
        # Surface a brand-new drone immediately; steady-state refreshes ride the
        # 1 s tick so we don't rewrite entity state on every single frame.
        if is_new:
            self._async_notify()

    @callback
    def _async_tick(self, _now) -> None:
        cutoff = time.monotonic() - DRONE_EXPIRE_S
        stale = [mac for mac, drone in self.drones.items() if drone.last < cutoff]
        for mac in stale:
            del self.drones[mac]
        self._async_notify()

    # ----- helpers for entities ------------------------------------------- #
    @callback
    def nearest(self) -> DarsDrone | None:
        """Drone with the strongest signal (RSSI closest to 0) that has a
        position fix — used for the map tracker and 'nearest' sensors."""
        located = [d for d in self.drones.values() if d.lat is not None]
        if not located:
            return None
        return max(located, key=lambda d: d.rssi if d.rssi is not None else -999)

    @callback
    def active_serials(self) -> set[str]:
        """Serials (uasId) of currently-detected, serial-identified drones.
        Per-drone trackers are keyed by serial so a drone that rotates its BLE
        MAC keeps ONE tracker rather than spawning a new entity each time."""
        return {d.uas_id for d in self.drones.values() if d.uas_id}

    @callback
    def drone_for_serial(self, serial: str) -> DarsDrone | None:
        """The freshest currently-active drone reporting this serial, or None if
        no active drone has it right now."""
        best: DarsDrone | None = None
        for d in self.drones.values():
            if d.uas_id == serial and (best is None or d.last > best.last):
                best = d
        return best
