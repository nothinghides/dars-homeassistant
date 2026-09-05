"""ASTM F3411 Remote ID frame decoder for D.A.R.S. receivers.

This module is intentionally Home Assistant independent (pure Python, no HA
imports) so it can be unit-tested on its own. It is a faithful port of the
decoder in the D.A.R.S. Web Bluetooth viewer.

The receiver streams fixed 34-byte frames on GATT characteristic 0xFFF2::

    byte  [0:6]   source MAC (of the transmitting drone)
    byte  [6]     RSSI (int8, dBm)
    byte  [7]     firmware frame counter
    byte  [8:33]  25-byte ASTM F3411 / ASD-STAN Remote ID message
    byte  [33]    radio channel (0 = BLE, >14 = WiFi 5 GHz, else WiFi 2.4 GHz)
"""

from __future__ import annotations

from dataclasses import dataclass, field

FRAME_LEN = 34
_MSG_OFF = 8  # offset of the 25-byte ODID message inside a frame


# --------------------------------------------------------------------------- #
#  Little-endian byte helpers (match the viewer's i16/i32/int8 semantics)
# --------------------------------------------------------------------------- #
def _u16(b: bytes, o: int) -> int:
    return b[o] | (b[o + 1] << 8)


def _s32(b: bytes, o: int) -> int:
    v = b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)
    return v - 0x100000000 if v & 0x80000000 else v


def _s8(v: int) -> int:
    return v - 0x100 if v & 0x80 else v


def _ascii(b: bytes, o: int, n: int) -> str:
    """Printable-ASCII string, terminated at the first NUL (ODID strings are
    NUL-padded), then stripped."""
    out: list[str] = []
    for i in range(n):
        c = b[o + i]
        if c == 0:
            break
        if 32 <= c < 127:
            out.append(chr(c))
    return "".join(out).strip()


def mac_str(b: bytes, o: int = 0) -> str:
    return ":".join(f"{b[o + i]:02X}" for i in range(6))


# --------------------------------------------------------------------------- #
#  Drone model
# --------------------------------------------------------------------------- #
@dataclass
class DarsDrone:
    """Accumulated state for one detected drone (keyed by transmitter MAC)."""

    mac: str
    first: float  # monotonic time of first frame
    last: float = 0.0  # monotonic time of most recent frame
    rssi: int | None = None
    channel: int | None = None
    # Basic ID (message type 0)
    uas_id: str | None = None
    id_type: int | None = None
    ua_type: int | None = None
    # Location / Vector (message type 1)
    lat: float | None = None
    lon: float | None = None
    alt: float | None = None  # geodetic altitude, metres MSL
    height: float | None = None  # height above take-off, metres
    speed: float | None = None  # ground speed, m/s
    vspeed: float | None = None  # vertical speed, m/s
    heading: float | None = None  # track direction, degrees
    # System (message type 4)
    op_lat: float | None = None  # operator latitude
    op_lon: float | None = None  # operator longitude

    @property
    def source(self) -> str:
        if self.channel is None:
            return "unknown"
        if self.channel == 0:
            return "BLE"
        if self.channel > 14:
            return "WiFi 5 GHz"
        return "WiFi 2.4 GHz"

    def as_dict(self) -> dict:
        """Compact, JSON-friendly view for entity attributes."""
        return {
            "mac": self.mac,
            "id": self.uas_id,
            "source": self.source,
            "rssi": self.rssi,
            "lat": round(self.lat, 6) if self.lat is not None else None,
            "lon": round(self.lon, 6) if self.lon is not None else None,
            "altitude_m": round(self.alt) if self.alt is not None else None,
            "height_m": round(self.height) if self.height is not None else None,
            "speed_mps": round(self.speed, 1) if self.speed is not None else None,
            "heading": round(self.heading) if self.heading is not None else None,
            "takeoff_lat": round(self.op_lat, 6) if self.op_lat is not None else None,
            "takeoff_lon": round(self.op_lon, 6) if self.op_lon is not None else None,
        }


# --------------------------------------------------------------------------- #
#  Decode
# --------------------------------------------------------------------------- #
def parse_frame(data: bytes | bytearray) -> tuple[str, int, int, bytes] | None:
    """Split a raw 34-byte frame into (mac, rssi, channel, message). Returns
    None if the frame is too short."""
    if len(data) < FRAME_LEN:
        return None
    b = bytes(data)
    return mac_str(b, 0), _s8(b[6]), b[33], b[_MSG_OFF:_MSG_OFF + 25]


def apply_message(drone: DarsDrone, msg: bytes) -> None:
    """Merge a 25-byte ODID message into ``drone`` (mutates in place)."""
    t = (msg[0] >> 4) & 0x0F

    if t == 0:  # Basic ID
        id_type = (msg[1] >> 4) & 0x0F
        ua_type = msg[1] & 0x0F
        uas = _ascii(msg, 2, 20)
        # Keep an already-known serial (id_type 1) rather than letting a later
        # non-serial or empty Basic ID overwrite it.
        keep = drone.id_type == 1 and bool(drone.uas_id) and not (id_type == 1 and uas)
        if not keep:
            drone.id_type = id_type
            drone.ua_type = ua_type
            drone.uas_id = uas
    elif t == 1:  # Location / Vector
        b1 = msg[1]
        ew = (b1 >> 1) & 1  # E/W direction segment (adds 180° to track)
        mult = b1 & 1  # speed multiplier flag
        drone.lat = _s32(msg, 5) / 1e7
        drone.lon = _s32(msg, 9) / 1e7
        drone.alt = _u16(msg, 15) * 0.5 - 1000
        drone.height = _u16(msg, 17) * 0.5 - 1000
        drone.speed = msg[3] * 0.75 + 63.75 if mult else msg[3] * 0.25
        drone.vspeed = _s8(msg[4]) * 0.5
        drone.heading = msg[2] + (180 if ew else 0)
    elif t == 4:  # System (operator location)
        drone.op_lat = _s32(msg, 2) / 1e7
        drone.op_lon = _s32(msg, 6) / 1e7


def is_licensed(status: bytes | bytearray) -> bool:
    """Licence gate: the receiver's 0xFFF3 status read carries the VALID flag in
    bit 0 of byte 21. A genuine, activated D.A.R.S. unit sets it."""
    b = bytes(status)
    return len(b) >= 22 and (b[21] & 0x01) != 0
