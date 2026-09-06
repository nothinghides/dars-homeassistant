"""Constants for the D.A.R.S. Drone Remote ID integration."""

from __future__ import annotations

DOMAIN = "dars_remote_id"

# Bundled Lovelace card that the integration serves + auto-registers on the
# frontend. Bump when dars-map-card.js changes (used as a cache-busting query).
CARD_VERSION = "0.7.0"
CARD_FILENAME = "dars-map-card.js"

# GATT UUIDs — full 128-bit forms of the 16-bit UUIDs the D.A.R.S. firmware exposes.
SVC_UUID = "0000fff1-0000-1000-8000-00805f9b34fb"
DATA_UUID = "0000fff2-0000-1000-8000-00805f9b34fb"  # notify: 34-byte detection frames
STATUS_UUID = "0000fff3-0000-1000-8000-00805f9b34fb"  # read: status/licence, write: settings

# Advertised BLE name prefix (e.g. "DARS-C5", "DARS-...").
NAME_PREFIX = "DARS"

# A drone drops off the active list this many seconds after its last frame.
DRONE_EXPIRE_S = 30.0

# Coordinator housekeeping tick: prune stale drones + refresh entity attributes.
TICK_S = 1.0

# Delay before retrying a dropped/failed BLE connection.
RECONNECT_S = 10.0
