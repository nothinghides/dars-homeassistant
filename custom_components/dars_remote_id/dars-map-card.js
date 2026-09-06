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

const DARS_CARD_VERSION = '0.3.3';
const LEAFLET_VER = '1.9.4';

// Load Leaflet once (from CDN, pinned). Needs internet on the *viewing* browser;
// if it fails the card degrades to the detection list. Shared across all cards.
function darsLoadLeaflet() {
  if (window.L && window.L.map) return Promise.resolve(window.L);
  if (window.__darsLeaflet) return window.__darsLeaflet;
  window.__darsLeaflet = new Promise((resolve, reject) => {
    if (!document.querySelector('link[data-dars-leaflet]')) {
      const css = document.createElement('link');
      css.rel = 'stylesheet';
      css.href = `https://unpkg.com/leaflet@${LEAFLET_VER}/dist/leaflet.css`;
      css.setAttribute('data-dars-leaflet', '');
      document.head.appendChild(css);
    }
    const js = document.createElement('script');
    js.src = `https://unpkg.com/leaflet@${LEAFLET_VER}/dist/leaflet.js`;
    js.onload = () => resolve(window.L);
    js.onerror = () => reject(new Error('Leaflet failed to load (offline or blocked)'));
    document.head.appendChild(js);
  });
  return window.__darsLeaflet;
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
    this._title = (config && config.title) || 'D.A.R.S. — Drone Map';
    // Accept the old `show_operator` key too, for configs saved before the rename.
    this._showTakeoff = !(config && (config.show_takeoff === false || config.show_operator === false));
    this._config = config || {};
    this._mapStyle = (config && config.map_style) || 'Streets';
  }

  getCardSize() { return 9; }

  // Visual editor hooks (HA card UI).
  static getConfigElement() { return document.createElement('dars-map-card-editor'); }
  static getStubConfig() {
    return { entity: 'sensor.dars_active_drones', title: 'D.A.R.S. — Drone Map', show_takeoff: true, map_style: 'Streets' };
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
      <!-- Leaflet CSS must live INSIDE the shadow root or it can't style the map. -->
      <link rel="stylesheet" href="https://unpkg.com/leaflet@${LEAFLET_VER}/dist/leaflet.css" />
      <style>
        :host { --g:#00FF41; --g-dim:#00cc33; --bg:#0d0d0d; --bg2:#020101;
                --bd:#2a2a2a; --bd-hi:#3a3a3a; --muted:#8a8a8a; --white:#fff; }
        ha-card, .card { background:var(--bg); border:1px solid var(--bd);
                border-radius:12px; overflow:hidden; position:relative;
                font-family:'Inter','Segoe UI',system-ui,sans-serif; color:var(--white); }
        .card::before { content:''; position:absolute; top:0; left:0; right:0; height:2px;
                background:linear-gradient(90deg,transparent,var(--g),transparent); z-index:5; }
        .hd { display:flex; align-items:center; gap:10px; padding:14px 16px 12px;
              border-bottom:1px solid var(--bd); }
        .brand { font-weight:800; letter-spacing:.04em; color:var(--g); font-size:13px; }
        .ttl { font-size:14px; font-weight:700; flex:1; }
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
        /* Dark map-style switcher to match the theme */
        .leaflet-control-layers { background:#0d0d0d; color:#ddd; border:1px solid var(--bd);
                border-radius:8px; }
        .leaflet-control-layers-expanded { padding:8px 10px; }
        .leaflet-control-layers label { font-family:'Inter',system-ui,sans-serif; font-size:13px; }
        .leaflet-control-layers-selector { accent-color:var(--g); }
        .leaflet-bar a { background:#0d0d0d; color:#ddd; border-bottom:1px solid var(--bd); }
        .leaflet-bar a:hover { background:#1a1a1a; }
      </style>
      <ha-card>
        <div class="card">
          <div class="hd">
            <span class="brand">D.A.R.S.</span>
            <span class="ttl">${esc(this._title)}</span>
            <span class="badge zero" id="count">0</span>
          </div>
          <div class="warn" id="warn" style="display:none"></div>
          <div id="map"></div>
          <div class="list" id="list"></div>
        </div>
      </ha-card>`;

    this._el = {
      count: this.shadowRoot.getElementById('count'),
      warn: this.shadowRoot.getElementById('warn'),
      map: this.shadowRoot.getElementById('map'),
      list: this.shadowRoot.getElementById('list'),
    };

    darsLoadLeaflet()
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
    this._map = L.map(this._el.map, { attributionControl: false, zoomControl: true })
      .setView([this._hass.config.latitude || 0, this._hass.config.longitude || 0], 13);

    // Selectable base layers (all free, no key). Needs internet on the viewer.
    const bases = {
      'Streets': L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }),
      'Dark': L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
        { maxZoom: 20, subdomains: 'abcd' }),
      'Satellite': L.tileLayer(
        'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
        { maxZoom: 19 }),
    };
    const startName = bases[this._mapStyle] ? this._mapStyle : 'Streets';
    bases[startName].addTo(this._map);
    L.control.layers(bases, null, { position: 'topright' }).addTo(this._map);
    this._map.on('baselayerchange', (e) => { this._mapStyle = e.name; });
    // Home / receiver location marker.
    if (this._hass.config.latitude != null) {
      this._home = L.marker([this._hass.config.latitude, this._hass.config.longitude], {
        icon: L.divIcon({ className: '', html: '<div class="mk home"></div>', iconSize: [16, 16] }),
      }).addTo(this._map).bindPopup('Home');
    }
    setTimeout(() => this._map && this._map.invalidateSize(), 200);
    this._update(true);
  }

  _warn(msg) {
    this._el.warn.style.display = msg ? 'block' : 'none';
    this._el.warn.textContent = msg || '';
  }

  // ---- per-update: markers + list ---------------------------------------
  _update(force) {
    if (!this._hass || !this._el) return;
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

    // Count badge.
    this._el.count.textContent = drones.length;
    this._el.count.classList.toggle('zero', drones.length === 0);

    // Detection list.
    if (!drones.length) {
      this._el.list.innerHTML = `<div class="empty">No drones detected.</div>`;
    } else {
      this._el.list.innerHTML = drones.map((d) => {
        const id = esc(d.id || d.mac || '—');
        const bits = [];
        if (d.height_m != null) bits.push(`${d.height_m} m AGL`);
        if (d.speed_mps != null) bits.push(`${d.speed_mps} m/s`);
        if (d.heading != null) bits.push(`${d.heading}°`);
        return `<div class="row" data-mac="${esc(d.mac)}">
            <div class="id" style="color:${this._colorFor(d.mac)}">${id}</div>
            <div class="rssi">${d.rssi != null ? d.rssi + ' dBm' : ''}</div>
            <div class="meta"><span class="tag">${esc(d.source || '')}</span> ${esc(bits.join(' · '))}</div>
          </div>`;
      }).join('');
      this._el.list.querySelectorAll('.row').forEach((row) => {
        row.addEventListener('click', () => this._focus(row.getAttribute('data-mac')));
      });
    }

    if (this._map) this._syncMarkers(drones);
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
      ${line('Source', d.source)}
      ${line('RSSI', d.rssi != null ? d.rssi + ' dBm' : '')}
      ${line('Height', d.height_m != null ? d.height_m + ' m AGL' : '')}
      ${line('Speed', d.speed_mps != null ? d.speed_mps + ' m/s' : '')}
      ${line('Heading', d.heading != null ? d.heading + '°' : '')}
      ${tlat != null ? `<div><b>Take-off:</b> ${esc(tlat)}, ${esc(tlon)}</div>` : ''}
    </div>`;
  }

  _focus(mac) {
    const m = this._markers[mac];
    if (m && this._map) { this._map.setView(m.drone.getLatLng(), 16); m.drone.openPopup(); }
  }
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
    { value: 'Streets', label: 'Streets' },
    { value: 'Dark', label: 'Dark' },
    { value: 'Satellite', label: 'Satellite' },
  ] } } },
  { name: 'show_takeoff', selector: { boolean: {} } },
];
const DARS_EDITOR_LABELS = {
  entity: 'Drones entity',
  title: 'Card title',
  map_style: 'Map style',
  show_takeoff: 'Show take-off location',
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
