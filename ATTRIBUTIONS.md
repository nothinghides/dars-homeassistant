# Attributions & licenses

The D.A.R.S. Home Assistant integration and its bundled map card build on the
following third‑party data and software. Each is used under a licence that
permits commercial use.

## Map data & tiles

- **Map data © OpenStreetMap contributors** — licensed under the
  [Open Database License (ODbL)](https://www.openstreetmap.org/copyright).
- **Tiles: [OpenFreeMap](https://openfreemap.org/)** — a free, no‑API‑key,
  open vector tile provider; free for any use, including commercial.
- **Vector tile schema © [OpenMapTiles](https://openmaptiles.org/)**
  (BSD‑3‑Clause schema; data © OpenStreetMap contributors).

The map card uses the same OpenFreeMap vector styles as the D.A.R.S. Android app
(Fiord, Dark Matter, Positron, Liberty, Bright). Attribution is shown in the
map's on‑screen attribution control and in the card's "Attributions & licenses"
footer.

## Aircraft (drone) make / model data

- **FAA UAS Declaration of Compliance database**
  (<https://uasdoc.faa.gov/listdocs>) — used to resolve a broadcast Remote ID
  serial number to the manufacturer‑declared make/model. This is public product
  declaration data; it contains **no owner or personal information**. The lookup
  is performed server‑side by the integration (the same flow the D.A.R.S.
  Android app uses).

## Software libraries (loaded on the viewing browser, from CDN)

| Library | Licence | Use |
| --- | --- | --- |
| [Leaflet](https://leafletjs.com/) | BSD‑2‑Clause | Map/marker framework for the card |
| [MapLibre GL JS](https://maplibre.org/) | BSD‑3‑Clause | Renders the OpenFreeMap vector styles |
| [maplibre-gl-leaflet](https://github.com/maplibre/maplibre-gl-leaflet) | ISC | Bridges MapLibre GL as a Leaflet layer |

## Python dependencies

| Package | Licence | Use |
| --- | --- | --- |
| [bleak-retry-connector](https://github.com/Bluetooth-Devices/bleak-retry-connector) | MIT | Robust BLE connect/reconnect |

## This project

- **D.A.R.S.** — © [getdars.com](https://getdars.com).
