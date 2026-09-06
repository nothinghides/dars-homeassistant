# D.A.R.S. Drone Remote ID — Home Assistant integration

Bring live drone **Remote ID** detections from a [D.A.R.S.](https://getdars.com)
receiver into Home Assistant over Bluetooth. The receiver passively picks up the
Remote ID that nearby drones broadcast (2.4 GHz / 5 GHz Wi‑Fi and Bluetooth) and
streams each detection to HA, where it becomes entities you can put on a
dashboard, a map, and into automations.

> Local push, no cloud. The BLE link is entirely local; nothing leaves your
> network.

## What you get

Per receiver (one device in HA):

| Entity | Type | What it is |
| --- | --- | --- |
| **Drone detected** | binary_sensor (occupancy) | On while ≥ 1 drone is being detected. Attribute: `count`. |
| **Active drones** | sensor | Number of drones right now. Attribute `drones`: full list (id, source, RSSI, lat/lon, altitude, height, speed, heading, operator lat/lon). |
| **Nearest drone ID** | sensor | Serial/ID of the strongest‑signal drone. Attributes: that drone's telemetry. |
| **Nearest drone signal** | sensor (dBm) | RSSI of the strongest drone. |
| **Nearest drone** | device_tracker | Map marker following the strongest drone (with operator location in attributes). |
| **Receiver connected** | binary_sensor (connectivity, diagnostic) | BLE link status. Attribute: `licensed`. |

Automation ideas: announce on a speaker when *Drone detected* turns on, flash a
light, push a phone notification with the nearest drone's ID and distance, or log
the `drones` attribute to history.

## Integration icon

HA shows an integration's logo from the central `home-assistant/brands` repo (a
custom component can't ship its own brand icon). Ready-to-submit icons are in
[`brands/`](brands/) — see that folder's README to add them via a brands PR.
Until merged, HA shows a generic placeholder; functionality is unaffected.

## Requirements

- Home Assistant **2024.8** or newer with a working **Bluetooth** adapter in
  range of the receiver — either a local adapter or an
  [ESPHome Bluetooth Proxy](https://esphome.io/components/bluetooth_proxy/)
  (needs an *active‑connection* capable proxy).
- A genuine, **activated** D.A.R.S. receiver (M5Stack Unit C6L or XIAO ESP32‑C5)
  running current firmware. Activate at
  [getdars.com/installer](https://getdars.com/installer).

## Install (HACS)

1. HACS → ⋮ → **Custom repositories** → add this repo's URL, category
   **Integration**.
2. Install **D.A.R.S. Drone Remote ID**, then restart Home Assistant.
3. The receiver is usually **auto‑discovered** (Settings → Devices & Services →
   *Discovered*). Otherwise **+ Add Integration → D.A.R.S. Drone Remote ID** and
   pick your `DARS‑…` device from the list.

Manual install: copy `custom_components/dars_remote_id/` into your HA
`config/custom_components/` and restart.

## Map card — bundled, no separate install

The integration **ships and auto-loads** a D.A.R.S.-styled map card
(`dars-map-card.js`) that plots every detected drone (marker per drone + operator,
tether line, popups, and a detection list) from `sensor.dars_active_drones`. It's
a **viewer** — the integration is what connects to the receiver and supplies the
data.

Nothing to install for the card: after the integration is set up (HACS or manual)
and Home Assistant is restarted, just add it to a dashboard:

```yaml
type: custom:dars-map-card
entity: sensor.dars_active_drones   # optional (auto-detected if omitted)
title: Drone Map                    # optional
map_style: Fiord                    # optional: Fiord | Dark Matter | Positron | Liberty | Bright
units: metric                       # optional: metric (m, m/s) | imperial (ft, mph)
show_takeoff: true                  # optional
show_replay: true                   # optional: show the Live/Replay controls
```

**Units.** `units` sets the default; each viewer can also flip metric ⇄ imperial
with the **m / ft** button in the card header (their choice is remembered on that
device). Matches the D.A.R.S. app (m→ft, m/s→mph).

**Map styles** use free‑for‑commercial [OpenFreeMap](https://openfreemap.org)
vector tiles (same styles as the D.A.R.S. app). The on‑map switcher remembers the
viewer's choice. See `ATTRIBUTIONS.md` for data/library licences.

**Live / Replay.** The card has a **Live** and a **Replay** mode. Replay reads
this receiver's history straight from Home Assistant's **Recorder** (no extra
storage): pick a **day** (Today, Yesterday, or a specific date) and use the
**timeline scrubber, play/pause and speed** to watch that day's flights animate —
breadcrumb trails included. Replay depends on Recorder retention (default
~10 days) and needs the drones sensor to be recorded; a single history sample
whose attributes exceed 16 KiB (≈ 60+ simultaneous drones) is dropped by HA. Set
`show_replay: false` to hide the controls.

The integration serves the card at `/dars_remote_id/dars-map-card.js` and
registers it as a frontend module automatically — no `www/` copy, no Lovelace
resource entry needed. (Hard-refresh the browser once after updating so the new
card JS is fetched.)

<details><summary>Manual card install (only if you're not using the integration's copy)</summary>

Copy **`www/dars-map-card.js`** into `config/www/`, then **Settings → Dashboards →
⋮ → Resources → + Add Resource** → `/local/dars-map-card.js`, type **JavaScript
Module**.
</details>

The map uses Leaflet + OpenStreetMap loaded from a CDN, so the **browser viewing
the dashboard needs internet**; if it's offline the card falls back to the
detection list (which always works). Drones without a GPS fix are listed but not
placed on the map.

## How it works

The receiver exposes a GATT service `0xFFF1` with a notify characteristic
`0xFFF2` that streams fixed 34‑byte frames (`mac`, `rssi`, `channel`, 25‑byte
ASTM F3411 message). The integration keeps a long‑lived connection, decodes each
frame (`decoder.py`, a faithful port of the D.A.R.S. web viewer's decoder, unit
tested for parity), maintains a registry of drones (dropped 30 s after their last
frame), and pushes entity updates. On connect it reads the `0xFFF3` status to
check the licence flag.

## Notes & limits

- **Foreground live view.** The Android app remains the full product (background
  scanning, widget, EFB output, USB, PRO). This integration is the live feed for
  a Home Assistant dashboard.
- One receiver drives one BLE connection. Keep it in good range of the HA adapter
  or a Bluetooth proxy.
- The map tracker follows a single (nearest) drone by design; per‑drone trackers
  may come later.

## Dashboard & automation examples

> Entity IDs are built from the **device name** you gave the receiver, e.g. a
> device named *DARS C6L* yields `sensor.dars_c6l_active_drones`. The examples
> below use the slug `dars` — replace it with yours (Developer Tools → States).

**Map — nearest drone** (Lovelace, add as a Manual card):

```yaml
type: map
title: Drones
default_zoom: 12
hours_to_show: 0
entities:
  - entity: device_tracker.dars_nearest_drone
```

**Status panel:**

```yaml
type: entities
title: D.A.R.S.
entities:
  - entity: binary_sensor.dars_drone_detected
  - entity: sensor.dars_active_drones
  - entity: sensor.dars_nearest_drone_id
  - entity: sensor.dars_nearest_drone_signal
  - entity: binary_sensor.dars_receiver_connected
```

**Live drone table** (renders the full `drones` attribute):

```yaml
type: markdown
title: Detected drones
content: >
  {% set drones = state_attr('sensor.dars_active_drones', 'drones') %}
  {% if drones %}
  | ID | Source | RSSI | Alt m | Speed m/s | Heading |
  | --- | --- | ---: | ---: | ---: | ---: |
  {% for d in drones -%}
  | {{ d.id or d.mac }} | {{ d.source }} | {{ d.rssi }} | {{ d.altitude_m }} | {{ d.speed_mps }} | {{ d.heading }} |
  {% endfor %}
  {% else %}
  _No drones detected._
  {% endif %}
```

**Automation — notify on a new drone** (Settings → Automations → Edit in YAML):

```yaml
alias: Drone detected alert
triggers:
  - trigger: state
    entity_id: binary_sensor.dars_drone_detected
    from: "off"
    to: "on"
actions:
  - action: notify.notify
    data:
      title: Drone detected
      message: >
        {{ states('sensor.dars_active_drones') }} drone(s) nearby. Nearest:
        {{ states('sensor.dars_nearest_drone_id') }}
        ({{ states('sensor.dars_nearest_drone_signal') }} dBm).
```

Swap `notify.notify` for your mobile app service (e.g. `notify.mobile_app_phone`)
to get a push notification, or add a `light.turn_on` / `media_player` action to
flash a light or announce on a speaker.

## Development

`decoder.py` is Home Assistant independent and unit‑testable in isolation. The
byte layout and ODID math match the firmware and the web viewer exactly.

## License & attributions

Licensed under the **[MIT License](LICENSE)** (© getdars.com). Third‑party map
data and libraries remain under their own licences — see
**[ATTRIBUTIONS.md](ATTRIBUTIONS.md)** (OpenStreetMap / OpenFreeMap / OpenMapTiles,
Leaflet, MapLibre GL JS, maplibre‑gl‑leaflet, and the FAA UAS Declaration of
Compliance data).

---

*Not affiliated with Home Assistant or the Open Home Foundation. D.A.R.S. is
independent firmware; see [getdars.com/terms](https://getdars.com/terms).*
