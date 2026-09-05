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

const DARS_CARD_VERSION = '0.1.0';
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

class DarsMapCard extends HTMLElement {
  setConfig(config) {
    this._entity = (config && config.entity) || 'sensor.dars_active_drones';
    this._title = (config && config.title) || 'D.A.R.S. — Drone Map';
    this._showOperator = config && config.show_operator === false ? false : true;
    this._config = config || {};
  }

  getCardSize() { return 9; }

  set hass(hass) {
    this._hass = hass;
    if (!this._built) this._build();
    this._update();
  }

  // ---- one-time DOM + map setup -----------------------------------------
  _build() {
    this._built = true;
    this._markers = {};            // mac -> {drone, operator, line}
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
        .mk.op { background:#F4A62A; border-radius:2px; transform:rotate(45deg); }
        .mk.home { background:#3aa0ff; }
        .leaflet-popup-content { font-family:'Inter',system-ui,sans-serif; }
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
        this._warn('Map unavailable (' + e.message + '). Detection list still works.');
      });
  }

  _initMap(L) {
    this._L = L;
    this._map = L.map(this._el.map, { attributionControl: false, zoomControl: true })
      .setView([this._hass.config.latitude || 0, this._hass.config.longitude || 0], 13);
    L.tileLayer(`https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png`, { maxZoom: 19 })
      .addTo(this._map);
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
    const st = this._hass.states[this._entity];
    if (!st) { this._warn(`Entity "${this._entity}" not found — is the D.A.R.S. integration set up?`); return; }
    const drones = Array.isArray(st.attributes.drones) ? st.attributes.drones : [];

    // Skip redundant re-renders (hass fires on every state change).
    const sig = st.last_changed + '|' + drones.length;
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
        if (d.altitude_m != null) bits.push(`${d.altitude_m} m`);
        if (d.speed_mps != null) bits.push(`${d.speed_mps} m/s`);
        if (d.heading != null) bits.push(`${d.heading}°`);
        return `<div class="row" data-mac="${esc(d.mac)}">
            <div class="id">${id}</div>
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
      const ll = [d.lat, d.lon];
      bounds.push(ll);
      let m = this._markers[d.mac];
      if (!m) {
        m = { drone: L.marker(ll, {
          icon: L.divIcon({ className: '', html: '<div class="mk drone"></div>', iconSize: [16, 16] }),
        }).addTo(this._map) };
        this._markers[d.mac] = m;
      } else {
        m.drone.setLatLng(ll);
      }
      m.drone.bindPopup(this._popup(d));

      // Operator marker + tether line.
      if (this._showOperator && d.operator_lat != null && d.operator_lon != null) {
        const oll = [d.operator_lat, d.operator_lon];
        bounds.push(oll);
        if (!m.operator) {
          m.operator = L.marker(oll, {
            icon: L.divIcon({ className: '', html: '<div class="mk op"></div>', iconSize: [16, 16] }),
          }).addTo(this._map).bindPopup('Operator');
          m.line = L.polyline([ll, oll], { color: '#F4A62A', weight: 1, opacity: 0.5, dashArray: '4 4' }).addTo(this._map);
        } else {
          m.operator.setLatLng(oll);
          m.line.setLatLngs([ll, oll]);
        }
      } else if (m.operator) {
        this._map.removeLayer(m.operator); this._map.removeLayer(m.line);
        m.operator = m.line = null;
      }
    }

    // Drop markers for drones that expired.
    for (const mac of Object.keys(this._markers)) {
      if (seen.has(mac)) continue;
      const m = this._markers[mac];
      [m.drone, m.operator, m.line].forEach((l) => l && this._map.removeLayer(l));
      delete this._markers[mac];
    }

    // Auto-fit once we have something to show (don't fight the user's zoom after).
    if (bounds.length && !this._fitted) {
      this._fitted = true;
      if (bounds.length === 1) this._map.setView(bounds[0], 15);
      else this._map.fitBounds(bounds, { padding: [30, 30], maxZoom: 16 });
    }
  }

  _popup(d) {
    const line = (k, v) => (v != null && v !== '' ? `<div><b>${k}:</b> ${esc(v)}</div>` : '');
    return `<div style="min-width:150px">
      <div style="font-weight:700;color:#0a7d20">${esc(d.id || d.mac)}</div>
      ${line('Source', d.source)}
      ${line('RSSI', d.rssi != null ? d.rssi + ' dBm' : '')}
      ${line('Altitude', d.altitude_m != null ? d.altitude_m + ' m' : '')}
      ${line('Height', d.height_m != null ? d.height_m + ' m' : '')}
      ${line('Speed', d.speed_mps != null ? d.speed_mps + ' m/s' : '')}
      ${line('Heading', d.heading != null ? d.heading + '°' : '')}
      ${d.operator_lat != null ? `<div><b>Operator:</b> ${esc(d.operator_lat)}, ${esc(d.operator_lon)}</div>` : ''}
    </div>`;
  }

  _focus(mac) {
    const m = this._markers[mac];
    if (m && this._map) { this._map.setView(m.drone.getLatLng(), 16); m.drone.openPopup(); }
  }
}

customElements.define('dars-map-card', DarsMapCard);
window.customCards = window.customCards || [];
window.customCards.push({
  type: 'dars-map-card',
  name: 'D.A.R.S. Drone Map',
  description: 'Live map of drones detected by a D.A.R.S. receiver.',
  preview: false,
});
console.info(`%c D.A.R.S. Drone Map %c v${DARS_CARD_VERSION} `,
  'background:#00FF41;color:#020101;font-weight:700;border-radius:3px 0 0 3px;padding:2px 6px',
  'background:#0d0d0d;color:#00FF41;border-radius:0 3px 3px 0;padding:2px 6px');
