/*!
 * D.A.R.S. Drone Map — a custom Lovelace card for Home Assistant.
 *
 * Renders a live map of every drone reported by the D.A.R.S. integration
 * (reads the `drones` attribute of `sensor.dars_active_drones`). Self-contained
 * vanilla JS — no build step, no HACS: drop this file in `config/www/` and add
 * it as a Lovelace resource (JavaScript Module), then use
 * `type: custom:dars-map-card` on a dashboard.
 *
 * The card is a viewer only; the D.A.R.S. integration is what connects to the
 * receiver over Bluetooth and populates the entity.
 *
 * © D.A.R.S. — getdars.com
 */

const DARS_CARD_VERSION = '0.6.3';
const LEAFLET_VER = '1.9.4';
const MAPLIBRE_VER = '4.7.1';
const MGL_LEAFLET_VER = '0.0.22';

// Base-map styles — the same free-for-commercial OpenFreeMap vector styles the
// D.A.R.S. Android app uses (no API key). Default Fiord, matching the app.
const DARS_MAP_STYLES = {
  'Fiord': 'https://tiles.openfreemap.org/styles/fiord',
  'Dark Matter': 'https://tiles.openfreemap.org/styles/dark',
  'Positron': 'https://tiles.openfreemap.org/styles/positron',
  'Liberty': 'https://tiles.openfreemap.org/styles/liberty',
  'Bright': 'https://tiles.openfreemap.org/styles/bright',
};
const DARS_MAP_STYLE_DEFAULT = 'Fiord';
const DARS_STYLE_LS_KEY = 'dars-map-style';
// Shown in the map's attribution control (© data + tiles). OpenFreeMap serves
// OpenMapTiles-schema vector tiles built from OpenStreetMap data.
const DARS_MAP_ATTR =
  '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>' +
  ' contributors · <a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a>' +
  ' · <a href="https://openmaptiles.org/" target="_blank" rel="noopener">OpenMapTiles</a>';

const DARS_UNITS_LS_KEY = 'dars-units';   // 'metric' | 'imperial'

function darsSavedStyle() {
  try { return localStorage.getItem(DARS_STYLE_LS_KEY); } catch (e) { return null; }
}
function darsSaveStyle(name) {
  try { localStorage.setItem(DARS_STYLE_LS_KEY, name); } catch (e) { /* private mode */ }
}
function darsSavedUnits() {
  try { return localStorage.getItem(DARS_UNITS_LS_KEY); } catch (e) { return null; }
}
function darsSaveUnits(u) {
  try { localStorage.setItem(DARS_UNITS_LS_KEY, u); } catch (e) { /* private mode */ }
}

function darsAddCss(href, tag) {
  if (document.querySelector(`link[data-dars="${tag}"]`)) return;
  const css = document.createElement('link');
  css.rel = 'stylesheet';
  css.href = href;
  css.setAttribute('data-dars', tag);
  document.head.appendChild(css);
}
function darsLoadScript(src) {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[data-dars-src="${src}"]`);
    if (existing) {
      if (existing.getAttribute('data-loaded')) return resolve();
      existing.addEventListener('load', () => resolve());
      existing.addEventListener('error', () => reject(new Error('failed to load ' + src)));
      return;
    }
    const s = document.createElement('script');
    s.src = src;
    s.setAttribute('data-dars-src', src);
    s.onload = () => { s.setAttribute('data-loaded', '1'); resolve(); };
    s.onerror = () => reject(new Error('failed to load ' + src));
    document.head.appendChild(s);
  });
}

// Load Leaflet + MapLibre GL + the maplibre-gl-leaflet bridge once (CDN, pinned).
// Needs internet + WebGL on the *viewing* browser; if it fails the card degrades
// to the detection list. The promise is shared across all cards on the page.
function darsLoadMapLibs() {
  if (window.__darsMapLibs) return window.__darsMapLibs;
  window.__darsMapLibs = (async () => {
    darsAddCss(`https://unpkg.com/leaflet@${LEAFLET_VER}/dist/leaflet.css`, 'leaflet');
    darsAddCss(`https://unpkg.com/maplibre-gl@${MAPLIBRE_VER}/dist/maplibre-gl.css`, 'maplibre');
    if (!(window.L && window.L.map)) {
      await darsLoadScript(`https://unpkg.com/leaflet@${LEAFLET_VER}/dist/leaflet.js`);
    }
    if (!window.maplibregl) {
      await darsLoadScript(`https://unpkg.com/maplibre-gl@${MAPLIBRE_VER}/dist/maplibre-gl.js`);
    }
    if (!(window.L && window.L.maplibreGL)) {
      await darsLoadScript(
        `https://unpkg.com/@maplibre/maplibre-gl-leaflet@${MGL_LEAFLET_VER}/leaflet-maplibre-gl.js`);
    }
    if (!window.L || !window.L.maplibreGL) throw new Error('map libraries unavailable');
    return window.L;
  })();
  return window.__darsMapLibs;
}

const esc = (s) =>
  String(s == null ? '' : s).replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Marker palette matching the D.A.R.S. app ("Set B"): the first drone is the
// brand green, then a fixed distinct palette cycles. A drone and its take-off
// point share one colour so pairs are easy to tell apart.
const DARS_PALETTE = ['#00FF41', '#F4A62A', '#E93D82', '#8B5CF6', '#FF4D4D', '#2E9BFF', '#00B8A9'];

// Drone marker: a heading-pointing chevron (points north at 0°, rotated to
// heading), coloured fill with a white outline — same shape the app draws.
function droneIconHtml(color, heading) {
  const rot = Number.isFinite(heading) ? heading : 0;
  return (
    '<div style="transform:rotate(' + rot + 'deg);transform-origin:50% 50%;' +
    'filter:drop-shadow(0 0 2px rgba(0,0,0,.7))">' +
    '<svg viewBox="0 0 32 32" width="30" height="30">' +
    '<path d="M16 4 L26.5 26 L16 19.5 L5.5 26 Z" fill="' + color + '" ' +
    'stroke="#fff" stroke-width="3" stroke-linejoin="round"/></svg></div>'
  );
}
// Take-off marker: a white disc with a coloured ring and a coloured "H".
function takeoffIconHtml(color) {
  return (
    '<div style="filter:drop-shadow(0 0 2px rgba(0,0,0,.7))">' +
    '<svg viewBox="0 0 32 32" width="26" height="26">' +
    '<circle cx="16" cy="16" r="11" fill="#fff" stroke="' + color + '" stroke-width="3"/>' +
    '<text x="16" y="21.5" text-anchor="middle" font-family="Arial,sans-serif" ' +
    'font-size="15" font-weight="800" fill="' + color + '">H</text></svg></div>'
  );
}

class DarsMapCard extends HTMLElement {
  setConfig(config) {
    this._entity = (config && config.entity) || 'sensor.dars_active_drones';
    // The header already shows a "D.A.R.S." brand chip, so strip a redundant
    // leading "D.A.R.S." (with optional dash) from the title to avoid doubling.
    this._title = (((config && config.title) || 'Drone Map')
      .replace(/^\s*D\.?A\.?R\.?S\.?\s*[—–-]?\s*/i, '').trim()) || 'Drone Map';
    // Accept the old `show_operator` key too, for configs saved before the rename.
    this._showTakeoff = !(config && (config.show_takeoff === false || config.show_operator === false));
    this._showReplay = !(config && config.show_replay === false);
    this._config = config || {};
    this._mapStyle = (config && config.map_style) || DARS_MAP_STYLE_DEFAULT;
    this._units = (config && config.units === 'imperial') ? 'imperial' : 'metric';
  }

  getCardSize() { return 9; }

  // Visual editor hooks (HA card UI).
  static getConfigElement() { return document.createElement('dars-map-card-editor'); }
  static getStubConfig() {
    return { entity: 'sensor.dars_active_drones', title: 'Drone Map', show_takeoff: true, map_style: DARS_MAP_STYLE_DEFAULT };
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._built) this._build();
    this._update();
  }

  // ---- one-time DOM + map setup -----------------------------------------
  // Stable per-drone colour (keyed by MAC): first drone -> brand green, then the
  // palette cycles — matches the app so a drone + its take-off + list row match.
  _colorFor(mac) {
    if (this._colorIdx[mac] == null) {
      this._colorIdx[mac] = this._nextColor % DARS_PALETTE.length;
      this._nextColor += 1;
    }
    return DARS_PALETTE[this._colorIdx[mac]];
  }

  _build() {
    this._built = true;
    this._markers = {};            // mac -> {drone, takeoff, line}
    this._colorIdx = {};
    this._nextColor = 0;
    this.attachShadow({ mode: 'open' });
    this.shadowRoot.innerHTML = `
      <!-- Leaflet + MapLibre CSS must live INSIDE the shadow root or the map can't be styled. -->
      <link rel="stylesheet" href="https://unpkg.com/leaflet@${LEAFLET_VER}/dist/leaflet.css" />
      <link rel="stylesheet" href="https://unpkg.com/maplibre-gl@${MAPLIBRE_VER}/dist/maplibre-gl.css" />
      <style>
        :host { --g:#00FF41; --g-dim:#00cc33; --bg:#0d0d0d; --bg2:#020101;
                --bd:#2a2a2a; --bd-hi:#3a3a3a; --muted:#8a8a8a; --white:#fff; }
        [hidden] { display:none !important; }
        ha-card, .card { background:var(--bg); border:1px solid var(--bd);
                border-radius:12px; overflow:hidden; position:relative;
                font-family:'Inter','Segoe UI',system-ui,sans-serif; color:var(--white); }
        .card::before { content:''; position:absolute; top:0; left:0; right:0; height:2px;
                background:linear-gradient(90deg,transparent,var(--g),transparent); z-index:5; }
        .hd { display:flex; align-items:center; gap:10px; padding:14px 16px 12px;
              border-bottom:1px solid var(--bd); }
        .brand { font-weight:800; letter-spacing:.04em; color:var(--g); font-size:13px; }
        .ttl { font-size:14px; font-weight:700; flex:1; }
        .unit { background:#141414; color:var(--muted); border:1px solid var(--bd);
                border-radius:7px; padding:2px 9px; font-size:12px; font-weight:800; cursor:pointer;
                font-family:'Inter',system-ui,sans-serif; min-width:30px; }
        .unit:hover { color:var(--g); border-color:var(--g-dim); }
        .badge { font-size:12px; font-weight:800; color:var(--bg2); background:var(--g);
                 border-radius:999px; padding:2px 10px; }
        .badge.zero { background:var(--bd-hi); color:var(--muted); }
        #map { width:100%; height:320px; background:#0a1410; }
        .warn { padding:10px 16px; font-size:12px; color:#ffb454;
                background:rgba(255,180,84,.08); border-bottom:1px solid var(--bd); }
        .list { max-height:220px; overflow:auto; }
        .row { display:grid; grid-template-columns:1fr auto; gap:2px 10px;
               padding:10px 16px; border-bottom:1px solid #1c1c1c; cursor:pointer;
               transition:background .15s; }
        .row:hover { background:rgba(0,255,65,.05); }
        .row .id { font-family:'JetBrains Mono','Consolas',monospace; font-size:13px;
                   color:var(--g); font-weight:600; }
        .row .rssi { font-size:12px; color:var(--muted); text-align:right; }
        .row .meta { font-size:12px; color:var(--muted); grid-column:1/-1; }
        .empty { padding:26px 16px; text-align:center; color:var(--muted); font-size:13px; }
        .tag { display:inline-block; font-size:10px; font-weight:700; letter-spacing:.04em;
               border:1px solid var(--bd-hi); border-radius:4px; padding:0 5px; color:var(--muted); }
        /* Leaflet marker glyphs (divIcon, no external images) */
        .mk { width:16px; height:16px; border-radius:50%; border:2px solid var(--bg2);
              box-shadow:0 0 0 2px rgba(0,0,0,.5); }
        .mk.drone { background:var(--g); box-shadow:0 0 10px var(--g); }
        .mk-drone { filter:drop-shadow(0 0 4px var(--g)); display:block; }
        .mk.op { background:#F4A62A; border-radius:2px; transform:rotate(45deg); }
        .mk.home { background:#3aa0ff; }
        /* Dark popups to match the D.A.R.S. theme (bright marker colours stay legible). */
        .leaflet-popup-content-wrapper { background:#0d0d0d; color:#ddd; border:1px solid var(--bd); border-radius:8px; }
        .leaflet-popup-tip { background:#0d0d0d; border:1px solid var(--bd); }
        .leaflet-popup-content { font-family:'Inter',system-ui,sans-serif; color:#cfcfcf; }
        .leaflet-popup-content b { color:#fff; }
        .leaflet-container a.leaflet-popup-close-button { color:#888; }
        .leaflet-bar a { background:#0d0d0d; color:#ddd; border-bottom:1px solid var(--bd); }
        .leaflet-bar a:hover { background:#1a1a1a; }
        /* Dark map-style switcher (dropdown) to match the theme */
        .dars-style-ctl { background:#0d0d0d; border:1px solid var(--bd); border-radius:8px;
                box-shadow:0 1px 4px rgba(0,0,0,.4); }
        .dars-style-ctl select { background:#0d0d0d; color:#ddd; border:none; outline:none;
                font-family:'Inter',system-ui,sans-serif; font-size:12px; font-weight:600;
                padding:5px 6px; border-radius:8px; cursor:pointer; }
        /* Map attribution (© data + tiles) kept legible on the dark theme */
        .leaflet-control-attribution { background:rgba(13,13,13,.82) !important; color:#9a9a9a;
                font-size:10px; }
        .leaflet-control-attribution a { color:#00cc33; }
        /* Live / Replay controls */
        .ctrls { border-bottom:1px solid var(--bd); background:#0b0b0b; }
        .modes { display:flex; gap:6px; padding:8px 12px; }
        .modes button { flex:0 0 auto; background:#141414; color:var(--muted); border:1px solid var(--bd);
                border-radius:8px; padding:5px 12px; font-size:12px; font-weight:700; cursor:pointer;
                font-family:'Inter',system-ui,sans-serif; letter-spacing:.02em; }
        .modes button.on { background:var(--g); color:var(--bg2); border-color:var(--g); }
        .replay-bar { display:flex; align-items:center; gap:8px; padding:0 12px 10px; flex-wrap:wrap; }
        .replay-bar select, .replay-bar button { background:#141414; color:#ddd; border:1px solid var(--bd);
                border-radius:8px; padding:5px 8px; font-size:12px; font-weight:600; cursor:pointer;
                font-family:'Inter',system-ui,sans-serif; outline:none; }
        .replay-bar #play { min-width:34px; color:var(--g); }
        .replay-bar #scrub { flex:1 1 120px; min-width:100px; accent-color:var(--g); cursor:pointer; }
        .replay-bar .tlabel { font-size:11px; color:var(--muted); font-family:'JetBrains Mono','Consolas',monospace;
                flex:1 1 100%; text-align:right; }
        /* Attributions & licenses footer */
        .attrib { border-top:1px solid var(--bd); font-size:11px; color:var(--muted); }
        .attrib > summary { list-style:none; cursor:pointer; padding:9px 16px; user-select:none;
                color:#7a7a7a; font-weight:600; letter-spacing:.02em; }
        .attrib > summary::-webkit-details-marker { display:none; }
        .attrib > summary::before { content:'ⓘ '; color:var(--g-dim); }
        .attrib[open] > summary { color:#9a9a9a; }
        .attrib-body { padding:0 16px 12px; line-height:1.55; }
        .attrib-body a { color:#00cc33; text-decoration:none; }
        .attrib-body a:hover { text-decoration:underline; }
        .attrib-body b { color:#bdbdbd; font-weight:600; }
      </style>
      <ha-card>
        <div class="card">
          <div class="hd">
            <span class="brand">D.A.R.S.</span>
            <span class="ttl">${esc(this._title)}</span>
            <button type="button" class="unit" id="unit" title="Toggle units (metric / imperial)">m</button>
            <span class="badge zero" id="count">0</span>
          </div>
          <div class="warn" id="warn" style="display:none"></div>
          <div id="map"></div>
          <div class="ctrls" id="ctrls" hidden>
            <div class="modes">
              <button type="button" data-mode="live" class="on" id="mode-live">● Live</button>
              <button type="button" data-mode="replay" id="mode-replay">⟲ Replay</button>
            </div>
            <div class="replay-bar" id="replay-bar" hidden>
              <select id="win" title="Day to replay"></select>
              <button type="button" id="play" title="Play/pause">▶</button>
              <input type="range" id="scrub" min="0" max="1000" value="1000" step="1" />
              <select id="speed" title="Playback speed">
                <option value="1">1×</option>
                <option value="4" selected>4×</option>
                <option value="16">16×</option>
                <option value="60">60×</option>
              </select>
              <span class="tlabel" id="tlabel">—</span>
            </div>
          </div>
          <div class="list" id="list"></div>
          <details class="attrib">
            <summary>Attributions &amp; licenses</summary>
            <div class="attrib-body">
              <b>Map</b> — © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>
              contributors (ODbL). Tiles by <a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a>
              (free for any use); vector schema © <a href="https://openmaptiles.org/" target="_blank" rel="noopener">OpenMapTiles</a>.<br>
              <b>Aircraft data</b> — make/model from the FAA
              <a href="https://uasdoc.faa.gov/listdocs" target="_blank" rel="noopener">UAS Declaration of Compliance</a>
              database (public product data).<br>
              <b>Libraries</b> — <a href="https://leafletjs.com/" target="_blank" rel="noopener">Leaflet</a> (BSD-2-Clause),
              <a href="https://maplibre.org/" target="_blank" rel="noopener">MapLibre GL JS</a> (BSD-3-Clause),
              <a href="https://github.com/maplibre/maplibre-gl-leaflet" target="_blank" rel="noopener">maplibre-gl-leaflet</a> (ISC).<br>
              <b>D.A.R.S.</b> — © <a href="https://getdars.com" target="_blank" rel="noopener">getdars.com</a>.
            </div>
          </details>
        </div>
      </ha-card>`;

    const $ = (id) => this.shadowRoot.getElementById(id);
    this._el = {
      count: $('count'), warn: $('warn'), map: $('map'), list: $('list'), unit: $('unit'),
      ctrls: $('ctrls'), replayBar: $('replay-bar'),
      modeLive: $('mode-live'), modeReplay: $('mode-replay'),
      win: $('win'), play: $('play'), scrub: $('scrub'), speed: $('speed'), tlabel: $('tlabel'),
    };

    // Units: the viewer's saved choice (localStorage) wins over the card config.
    const savedUnits = darsSavedUnits();
    if (savedUnits === 'metric' || savedUnits === 'imperial') this._units = savedUnits;
    this._el.unit.textContent = this._units === 'imperial' ? 'ft' : 'm';
    this._el.unit.addEventListener('click', () => this._toggleUnits());

    // Replay state.
    this._mode = 'live';
    this._replay = null;

    // Wire the Live/Replay controls.
    if (this._showReplay) {
      this._el.ctrls.hidden = false;
      this._populateDayOptions();
      this._el.modeLive.addEventListener('click', () => this._setMode('live'));
      this._el.modeReplay.addEventListener('click', () => this._setMode('replay'));
      this._el.win.addEventListener('change', () => this._loadHistory());
      this._el.speed.addEventListener('change', () => {
        if (this._replay) this._replay.speed = Number(this._el.speed.value);
      });
      this._el.play.addEventListener('click', () => this._togglePlay());
      this._el.scrub.addEventListener('input', () => {
        if (!this._replay) return;
        this._pauseReplay();
        this._replay.tCur = Number(this._el.scrub.value);
        this._renderReplayFrame();
      });
    }

    darsLoadMapLibs()
      .then((L) => this._initMap(L))
      .catch((e) => {
        this._el.map.style.display = 'none';
        this._mapWarn = 'Map unavailable (' + e.message + '). Detection list still works.';
        this._update(true);
      });
  }

  // Resolve which entity to read: the configured one if it exists, otherwise
  // auto-detect the D.A.R.S. "active drones" sensor by its `drones` attribute
  // (its entity_id varies with the device name, e.g. sensor.dars_c5_active_drones).
  _resolveEntity() {
    if (this._hass.states[this._entity]) return this._entity;
    for (const id in this._hass.states) {
      if (id.indexOf('sensor.') !== 0) continue;
      const a = this._hass.states[id].attributes;
      if (a && Array.isArray(a.drones)) return id;
    }
    return this._entity;
  }

  _initMap(L) {
    this._L = L;
    this._map = L.map(this._el.map, { attributionControl: true, zoomControl: true })
      .setView([this._hass.config.latitude || 0, this._hass.config.longitude || 0], 13);
    this._map.attributionControl.setPrefix(false);

    // Pick the starting style: the viewer's last manual choice (localStorage)
    // wins, then the card's configured default, then Fiord.
    const saved = darsSavedStyle();
    this._styleName = (saved && DARS_MAP_STYLES[saved]) ? saved
      : (DARS_MAP_STYLES[this._mapStyle] ? this._mapStyle : DARS_MAP_STYLE_DEFAULT);
    this._addBaseLayer(this._styleName);

    // Style switcher (dropdown, top-right) — the same styles as the D.A.R.S. app.
    const ctl = L.control({ position: 'topright' });
    ctl.onAdd = () => {
      const div = L.DomUtil.create('div', 'dars-style-ctl');
      const sel = document.createElement('select');
      sel.title = 'Map style';
      for (const name of Object.keys(DARS_MAP_STYLES)) {
        const o = document.createElement('option');
        o.value = name; o.textContent = name;
        if (name === this._styleName) o.selected = true;
        sel.appendChild(o);
      }
      L.DomEvent.disableClickPropagation(div);
      L.DomEvent.disableScrollPropagation(div);
      sel.addEventListener('change', () => this._setStyle(sel.value));
      div.appendChild(sel);
      return div;
    };
    ctl.addTo(this._map);

    // Home / receiver location marker.
    if (this._hass.config.latitude != null) {
      this._home = L.marker([this._hass.config.latitude, this._hass.config.longitude], {
        icon: L.divIcon({ className: '', html: '<div class="mk home"></div>', iconSize: [16, 16] }),
      }).addTo(this._map).bindPopup('Home');
    }
    setTimeout(() => this._map && this._map.invalidateSize(), 200);
    this._update(true);
  }

  // Add the OpenFreeMap vector base layer (MapLibre GL under Leaflet). Kept
  // behind the markers/overlays. The style's own attribution is augmented with
  // our explicit © string so it always shows on the dark control.
  _addBaseLayer(name) {
    const L = this._L;
    const url = DARS_MAP_STYLES[name] || DARS_MAP_STYLES[DARS_MAP_STYLE_DEFAULT];
    this._glLayer = L.maplibreGL({ style: url, attribution: DARS_MAP_ATTR });
    this._glLayer.addTo(this._map);
  }

  // Switch base map style; remember the choice per-viewer so it survives a
  // refresh/restart. Re-creating the GL layer is the robust way to swap styles.
  _setStyle(name) {
    if (!this._map || !DARS_MAP_STYLES[name] || name === this._styleName) return;
    this._styleName = name;
    darsSaveStyle(name);
    if (this._glLayer) { this._map.removeLayer(this._glLayer); this._glLayer = null; }
    this._addBaseLayer(name);
  }

  _warn(msg) {
    this._el.warn.style.display = msg ? 'block' : 'none';
    this._el.warn.textContent = msg || '';
  }

  // ---- per-update: markers + list ---------------------------------------
  _update(force) {
    if (!this._hass || !this._el) return;
    if (this._mode === 'replay') return;   // replay drives its own rendering
    const eid = this._resolveEntity();
    const st = this._hass.states[eid];
    if (!st) {
      this._warn(`No D.A.R.S. "active drones" sensor found — is the integration set up? (configured: "${this._entity}")`);
      return;
    }
    this._warn(this._mapWarn || '');   // clear the not-found notice once resolved
    const drones = Array.isArray(st.attributes.drones) ? st.attributes.drones : [];

    // Skip redundant re-renders (hass fires on every state change). Key off
    // last_updated (not last_changed) so a drone *moving* — an attribute change
    // that leaves the count/state string the same — still re-renders live.
    const sig = eid + '|' + st.last_updated + '|' + drones.length;
    if (!force && sig === this._sig) return;
    this._sig = sig;

    this._renderCountAndList(drones);
    if (this._map) this._syncMarkers(drones);
  }

  // Shared by live + replay: count badge + detection list for a drone snapshot.
  _renderCountAndList(drones) {
    this._el.count.textContent = drones.length;
    this._el.count.classList.toggle('zero', drones.length === 0);

    if (!drones.length) {
      this._el.list.innerHTML = `<div class="empty">${
        this._mode === 'replay' ? 'No drones at this moment.' : 'No drones detected.'}</div>`;
      return;
    }
    this._el.list.innerHTML = drones.map((d) => {
      const id = esc(d.id || d.mac || '—');
      const bits = [];
      if (d.height_m != null) bits.push(`Height: ${this._fmtDist(d.height_m)}`);
      if (d.speed_mps != null) bits.push(this._fmtSpeed(d.speed_mps));
      if (d.heading != null) bits.push(`${d.heading}°`);
      const mm = [d.make, d.model].filter(Boolean).join(' ');
      const modelLine = mm
        ? `<div class="meta">${esc(mm)}${d.faa_registration ? ' · ' + esc(d.faa_registration) : ''}</div>`
        : '';
      return `<div class="row" data-mac="${esc(d.mac)}">
          <div class="id" style="color:${this._colorFor(d.mac)}">${id}</div>
          <div class="rssi">${d.rssi != null ? d.rssi + ' dBm' : ''}</div>
          <div class="meta"><span class="tag">${esc(d.source || '')}</span> ${esc(bits.join(' · '))}</div>
          ${modelLine}
        </div>`;
    }).join('');
    this._el.list.querySelectorAll('.row').forEach((row) => {
      row.addEventListener('click', () => this._focus(row.getAttribute('data-mac')));
    });
  }

  _syncMarkers(drones) {
    const L = this._L;
    const seen = new Set();
    const bounds = [];
    if (this._home) bounds.push(this._home.getLatLng());

    for (const d of drones) {
      if (d.lat == null || d.lon == null) continue;
      seen.add(d.mac);
      const color = this._colorFor(d.mac);
      const ll = [d.lat, d.lon];
      bounds.push(ll);
      const dIcon = L.divIcon({
        className: '', html: droneIconHtml(color, d.heading), iconSize: [30, 30], iconAnchor: [15, 15],
      });
      let m = this._markers[d.mac];
      if (!m) {
        m = { drone: L.marker(ll, { icon: dIcon }).addTo(this._map) };
        this._markers[d.mac] = m;
      } else {
        m.drone.setLatLng(ll);
        m.drone.setIcon(dIcon);            // refresh heading rotation
      }
      m.drone.bindPopup(this._popup(d, color));

      // Take-off marker (ODID System location) + coloured tether to the drone.
      const tlat = d.takeoff_lat != null ? d.takeoff_lat : d.operator_lat;
      const tlon = d.takeoff_lon != null ? d.takeoff_lon : d.operator_lon;
      if (this._showTakeoff && tlat != null && tlon != null) {
        const oll = [tlat, tlon];
        bounds.push(oll);
        const tIcon = L.divIcon({
          className: '', html: takeoffIconHtml(color), iconSize: [26, 26], iconAnchor: [13, 13],
        });
        if (!m.takeoff) {
          m.takeoff = L.marker(oll, { icon: tIcon }).addTo(this._map).bindPopup('Take-off');
          m.line = L.polyline([ll, oll], { color, weight: 1.5, opacity: 0.55, dashArray: '4 5' }).addTo(this._map);
        } else {
          m.takeoff.setLatLng(oll); m.takeoff.setIcon(tIcon);
          m.line.setLatLngs([ll, oll]); m.line.setStyle({ color });
        }
      } else if (m.takeoff) {
        this._map.removeLayer(m.takeoff); this._map.removeLayer(m.line);
        m.takeoff = m.line = null;
      }
    }

    // Drop markers for drones that expired.
    for (const mac of Object.keys(this._markers)) {
      if (seen.has(mac)) continue;
      const m = this._markers[mac];
      [m.drone, m.takeoff, m.line].forEach((l) => l && this._map.removeLayer(l));
      delete this._markers[mac];
    }

    // Auto-fit once we have something to show (don't fight the user's zoom after).
    if (bounds.length && !this._fitted) {
      this._fitted = true;
      if (bounds.length === 1) this._map.setView(bounds[0], 15);
      else this._map.fitBounds(bounds, { padding: [30, 30], maxZoom: 16 });
    }
  }

  _popup(d, color) {
    const line = (k, v) => (v != null && v !== '' ? `<div><b>${k}:</b> ${esc(v)}</div>` : '');
    const tlat = d.takeoff_lat != null ? d.takeoff_lat : d.operator_lat;
    const tlon = d.takeoff_lon != null ? d.takeoff_lon : d.operator_lon;
    return `<div style="min-width:150px">
      <div style="font-weight:700;color:${color || '#00FF41'}">${esc(d.id || d.mac)}</div>
      ${line('Make', d.make)}
      ${line('Model', d.model)}
      ${line('FAA reg', d.faa_registration)}
      ${line('Source', d.source)}
      ${line('RSSI', d.rssi != null ? d.rssi + ' dBm' : '')}
      ${line('Height', d.height_m != null ? this._fmtDist(d.height_m) : '')}
      ${line('Speed', d.speed_mps != null ? this._fmtSpeed(d.speed_mps) : '')}
      ${line('Heading', d.heading != null ? d.heading + '°' : '')}
      ${tlat != null ? `<div><b>Take-off:</b> ${esc(tlat)}, ${esc(tlon)}</div>` : ''}
    </div>`;
  }

  _focus(mac) {
    const m = this._markers[mac];
    if (m && this._map) { this._map.setView(m.drone.getLatLng(), 16); m.drone.openPopup(); }
  }

  // ---- unit formatting (metric default; imperial matches the D.A.R.S. app) - #
  _fmtDist(m) {
    if (m == null) return '';
    return this._units === 'imperial' ? `${Math.round(m * 3.28084)} ft` : `${Math.round(m)} m`;
  }
  _fmtSpeed(mps) {
    if (mps == null) return '';
    return this._units === 'imperial' ? `${(mps * 2.23694).toFixed(1)} mph` : `${mps} m/s`;
  }

  _toggleUnits() {
    this._units = this._units === 'metric' ? 'imperial' : 'metric';
    darsSaveUnits(this._units);
    this._el.unit.textContent = this._units === 'imperial' ? 'ft' : 'm';
    this._refresh();
  }

  // Re-render the current view (live or replay) after a display-only change.
  _refresh() {
    if (this._mode === 'replay') this._renderReplayFrame();
    else { this._sig = null; this._update(true); }
  }

  // ---- replay: read HA Recorder history, scrub + play back --------------- #
  // Fill the day picker with recent calendar days (Today, Yesterday, then dated),
  // matching the D.A.R.S. app's day-grouped history. Value = that day's local
  // midnight (ms). Covers a bit more than the usual Recorder retention.
  _populateDayOptions() {
    const sel = this._el.win;
    if (!sel) return;
    const DAYS = 14;
    const now = new Date();
    const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    sel.innerHTML = '';
    for (let i = 0; i < DAYS; i++) {
      const d = new Date(midnight.getTime() - i * 86400000);
      const opt = document.createElement('option');
      opt.value = String(d.getTime());
      opt.textContent = i === 0 ? 'Today' : i === 1 ? 'Yesterday'
        : d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
      sel.appendChild(opt);
    }
  }

  _setMode(mode) {
    if (mode === this._mode) return;
    this._mode = mode;
    this._el.modeLive.classList.toggle('on', mode === 'live');
    this._el.modeReplay.classList.toggle('on', mode === 'replay');
    this._el.replayBar.hidden = mode !== 'replay';
    if (mode === 'replay') {
      this._populateDayOptions();   // refresh so "Today" is current
      this._clearMarkers();
      this._loadHistory();
    } else {
      this._pauseReplay();
      this._clearPaths();
      this._clearMarkers();
      this._replay = null;
      this._fitted = true;          // don't refit when live resumes
      this._sig = null;
      this._update(true);           // resume live rendering
    }
  }

  // Pull the drones sensor's state history for the chosen window and rebuild
  // per-drone tracks. Uses HA's own Recorder (no extra storage on our side).
  async _loadHistory() {
    if (this._mode !== 'replay') return;
    this._pauseReplay();
    this._clearPaths();
    this._clearMarkers();
    const eid = this._resolveEntity();
    // Selected calendar day: local midnight → next midnight, clamped to now.
    const now = new Date();
    const dayStart = Number(this._el.win.value)
      || new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const start = new Date(dayStart);
    const dayEnd = new Date(dayStart + 86400000);
    const end = dayEnd > now ? now : dayEnd;
    const dayLabel = this._el.win.selectedOptions[0] ? this._el.win.selectedOptions[0].textContent : 'that day';
    this._warn('Loading history…');
    this._el.tlabel.textContent = 'loading…';
    let res;
    try {
      res = await this._hass.callWS({
        type: 'history/history_during_period',
        start_time: start.toISOString(),
        end_time: end.toISOString(),
        entity_ids: [eid],
        minimal_response: false,
        no_attributes: false,
        significant_changes_only: false,
      });
    } catch (e) {
      this._warn('History unavailable (' + (e && e.message ? e.message : e) + ').');
      return;
    }
    const arr = (res && res[eid]) || [];
    const tracks = {};
    let tMin = Infinity, tMax = -Infinity;
    let lastAttrs = {};
    for (const item of arr) {
      // Compressed WS format: lu=last_updated(s), a=attributes (omitted if unchanged).
      const t = item.lu != null ? item.lu * 1000
        : (item.last_updated ? Date.parse(item.last_updated) : null);
      if (t == null) continue;
      const a = item.a || item.attributes || lastAttrs;
      lastAttrs = a;
      const drones = Array.isArray(a.drones) ? a.drones : [];
      for (const d of drones) {
        if (d.lat == null || d.lon == null) continue;
        const key = d.id || d.mac;
        if (!key) continue;
        (tracks[key] || (tracks[key] = { key, mac: d.mac || key, samples: [] }))
          .samples.push(Object.assign({ t }, d));
        if (t < tMin) tMin = t;
        if (t > tMax) tMax = t;
      }
    }
    if (!Object.keys(tracks).length) {
      this._warn(`No drone positions recorded for ${dayLabel} (Recorder retention / no flights).`);
      this._el.tlabel.textContent = '—';
      this._el.scrub.disabled = true;
      return;
    }
    for (const k in tracks) tracks[k].samples.sort((a, b) => a.t - b.t);
    this._warn(this._mapWarn || '');
    this._replay = { tracks, tMin, tMax, tCur: tMax, playing: false,
      speed: Number(this._el.speed.value) || 4 };
    this._el.scrub.disabled = false;
    this._el.scrub.min = String(tMin);
    this._el.scrub.max = String(tMax);
    this._el.scrub.step = '1000';
    this._el.scrub.value = String(tMax);

    // Fit once to the whole session, then render the final frame paused.
    if (this._map) {
      const pts = [];
      for (const k in tracks) for (const s of tracks[k].samples) pts.push([s.lat, s.lon]);
      if (this._home) pts.push([this._home.getLatLng().lat, this._home.getLatLng().lng]);
      if (pts.length) this._map.fitBounds(pts, { padding: [30, 30], maxZoom: 16 });
      this._fitted = true;   // keep the session fit; stop per-frame auto-fit
    }
    this._renderReplayFrame();
  }

  // Interpolated snapshot of every track at time t (drone dicts like live).
  _dronesAt(t) {
    const out = [];
    const tr = this._replay.tracks;
    for (const key in tr) {
      const s = tr[key].samples;
      let lo = 0, hi = s.length - 1, idx = -1;
      while (lo <= hi) { const m = (lo + hi) >> 1; if (s[m].t <= t) { idx = m; lo = m + 1; } else hi = m - 1; }
      if (idx < 0) continue;                 // drone not seen yet at this instant
      const cur = s[idx], nxt = s[idx + 1];
      const d = Object.assign({}, cur);
      if (nxt && nxt.t > cur.t) {
        const f = Math.max(0, Math.min(1, (t - cur.t) / (nxt.t - cur.t)));
        d.lat = cur.lat + (nxt.lat - cur.lat) * f;
        d.lon = cur.lon + (nxt.lon - cur.lon) * f;
      }
      out.push(d);
    }
    return out;
  }

  _renderReplayFrame() {
    if (!this._replay) return;
    const t = this._replay.tCur;
    const drones = this._dronesAt(t);
    this._renderCountAndList(drones);
    if (this._map) { this._syncMarkers(drones); this._renderPaths(t); }
    if (this._el.scrub.value !== String(Math.round(t))) this._el.scrub.value = String(Math.round(t));
    this._el.tlabel.textContent = new Date(t).toLocaleString();
  }

  // Breadcrumb trail: each track's path from window start up to t.
  _renderPaths(t) {
    const L = this._L;
    if (!this._replayPaths) this._replayPaths = {};
    const tr = this._replay.tracks;
    for (const key in tr) {
      const pts = [];
      for (const s of tr[key].samples) { if (s.t > t) break; pts.push([s.lat, s.lon]); }
      const color = this._colorFor(tr[key].mac);
      let p = this._replayPaths[key];
      if (pts.length < 2) { if (p) { this._map.removeLayer(p); this._replayPaths[key] = null; } continue; }
      if (!p) {
        this._replayPaths[key] = L.polyline(pts, { color, weight: 2, opacity: 0.5 }).addTo(this._map);
      } else {
        p.setLatLngs(pts); p.setStyle({ color });
      }
    }
  }

  _togglePlay() {
    if (!this._replay) return;
    if (this._replay.playing) { this._pauseReplay(); return; }
    if (this._replay.tCur >= this._replay.tMax) this._replay.tCur = this._replay.tMin; // restart
    this._replay.playing = true;
    this._replay.lastFrame = performance.now();
    this._el.play.textContent = '❚❚';
    // setInterval (not requestAnimationFrame): rAF is paused/throttled in
    // backgrounded tabs and some webviews (incl. the HA companion app). We
    // advance by the real elapsed time so playback speed stays accurate.
    this._playTimer = setInterval(() => {
      if (!this._replay || !this._replay.playing) return;
      const now = performance.now();
      const dt = now - this._replay.lastFrame;
      this._replay.lastFrame = now;
      this._replay.tCur += dt * this._replay.speed;
      if (this._replay.tCur >= this._replay.tMax) {
        this._replay.tCur = this._replay.tMax;
        this._renderReplayFrame();
        this._pauseReplay();
        return;
      }
      this._renderReplayFrame();
    }, 66);
  }

  _pauseReplay() {
    if (this._playTimer) { clearInterval(this._playTimer); this._playTimer = null; }
    if (this._replay) this._replay.playing = false;
    if (this._el && this._el.play) this._el.play.textContent = '▶';
  }

  _clearPaths() {
    if (!this._replayPaths) return;
    for (const k in this._replayPaths) { const p = this._replayPaths[k]; if (p && this._map) this._map.removeLayer(p); }
    this._replayPaths = {};
  }

  _clearMarkers() {
    if (!this._markers || !this._map) { this._markers = {}; return; }
    for (const mac in this._markers) {
      const m = this._markers[mac];
      [m.drone, m.takeoff, m.line].forEach((l) => l && this._map.removeLayer(l));
    }
    this._markers = {};
  }

  disconnectedCallback() { this._pauseReplay(); }
}

// Guarded so the module is safe to load twice (e.g. the integration's auto-load
// AND a manually-added Lovelace resource for the companion app).
if (!customElements.get('dars-map-card')) {
  customElements.define('dars-map-card', DarsMapCard);
}

// ---- visual editor (uses HA's native ha-form) ---------------------------
const DARS_EDITOR_SCHEMA = [
  { name: 'entity', required: true, selector: { entity: { domain: 'sensor' } } },
  { name: 'title', selector: { text: {} } },
  { name: 'map_style', selector: { select: { mode: 'dropdown', options: [
    { value: 'Fiord', label: 'Fiord (default)' },
    { value: 'Dark Matter', label: 'Dark Matter' },
    { value: 'Positron', label: 'Positron' },
    { value: 'Liberty', label: 'Liberty' },
    { value: 'Bright', label: 'Bright' },
  ] } } },
  { name: 'units', selector: { select: { mode: 'dropdown', options: [
    { value: 'metric', label: 'Metric (m, m/s)' },
    { value: 'imperial', label: 'Imperial (ft, mph)' },
  ] } } },
  { name: 'show_takeoff', selector: { boolean: {} } },
  { name: 'show_replay', selector: { boolean: {} } },
];
const DARS_EDITOR_LABELS = {
  entity: 'Drones entity',
  title: 'Card title',
  map_style: 'Map style',
  units: 'Units (viewers can also toggle on the card)',
  show_takeoff: 'Show take-off location',
  show_replay: 'Show Live/Replay controls',
};

class DarsMapCardEditor extends HTMLElement {
  setConfig(config) { this._config = { ...config }; this._render(); }
  set hass(hass) { this._hass = hass; this._render(); }

  _render() {
    if (!this._hass || !this._config) return;
    if (!this._form) {
      this._form = document.createElement('ha-form');
      this._form.computeLabel = (s) => DARS_EDITOR_LABELS[s.name] || s.name;
      this._form.addEventListener('value-changed', (e) => {
        e.stopPropagation();
        this.dispatchEvent(new CustomEvent('config-changed', {
          detail: { config: e.detail.value }, bubbles: true, composed: true,
        }));
      });
      this.appendChild(this._form);
    }
    this._form.hass = this._hass;
    this._form.schema = DARS_EDITOR_SCHEMA;
    this._form.data = this._config;
  }
}
if (!customElements.get('dars-map-card-editor')) {
  customElements.define('dars-map-card-editor', DarsMapCardEditor);
}

window.customCards = window.customCards || [];
if (!window.customCards.some((c) => c.type === 'dars-map-card')) {
  window.customCards.push({
    type: 'dars-map-card',
    name: 'D.A.R.S. Drone Map',
    description: 'Live map of drones detected by a D.A.R.S. receiver.',
    preview: false,
  });
}
console.info(`%c D.A.R.S. Drone Map %c v${DARS_CARD_VERSION} `,
  'background:#00FF41;color:#020101;font-weight:700;border-radius:3px 0 0 3px;padding:2px 6px',
  'background:#0d0d0d;color:#00FF41;border-radius:0 3px 3px 0;padding:2px 6px');
