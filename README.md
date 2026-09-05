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

## Map card (optional) — install without HACS

The `www/dars-map-card.js` card renders a live D.A.R.S.-styled map of every
detected drone (marker per drone + operator, tether line, popups, and a detection
list) from the integration's `sensor.dars_active_drones` entity. It's a **viewer**
— the integration above is what connects to the receiver and supplies the data.

Install it manually (no HACS needed):

1. Copy **`www/dars-map-card.js`** into your HA **`config/www/`** folder (create
   `www` if it doesn't exist). It's now served at `/local/dars-map-card.js`.
2. **Settings → Dashboards → ⋮ (top-right) → Resources → + Add Resource**
   → URL `/local/dars-map-card.js`, type **JavaScript Module**. (YAML-mode
   dashboards: add it under `lovelace: resources:` and restart.)
3. Add the card to a dashboard:

   ```yaml
   type: custom:dars-map-card
   entity: sensor.dars_active_drones   # optional (this is the default)
   title: Drone Map                    # optional
   ```

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

---

*Not affiliated with Home Assistant or the Open Home Foundation. D.A.R.S. is
independent firmware; see [getdars.com/terms](https://getdars.com/terms).*
