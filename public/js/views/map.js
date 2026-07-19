// World map explorer: every Surfline spot, loaded per-viewport from the
// mapview endpoint, drawn as rating-tinted dots on a monochrome basemap.

import { getMapSpots } from '../api.js';
import { esc, ratingColor, ratingLabel, debounce, toast } from '../format.js';
import { fmtSurfRange } from '../units.js';
import { navigate, replaceQuery } from '../router.js';
import { on } from '../state.js';

const TILES = {
  light: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
  dark: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
};
const ATTRIB = '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/attributions">CARTO</a> · spots &copy; Surfline';
const MIN_SPOT_ZOOM = 6;

let leafletReady = null;
function loadLeaflet() {
  if (window.L) return Promise.resolve();
  if (!leafletReady) {
    leafletReady = new Promise((resolve, reject) => {
      const css = document.createElement('link');
      css.rel = 'stylesheet'; css.href = 'vendor/leaflet/leaflet.css';
      document.head.appendChild(css);
      const s = document.createElement('script');
      s.src = 'vendor/leaflet/leaflet.js';
      s.onload = resolve; s.onerror = reject;
      document.head.appendChild(s);
    });
  }
  return leafletReady;
}

export async function renderMap(container, { query }) {
  container.className = 'view view-full';
  document.body.classList.add('map-open');
  container.innerHTML = `
    <div class="mapwrap">
      <div id="map" role="application" aria-label="Map of surf spots"></div>
      <div class="map-topbar">
        <a class="map-back" href="#/">
          <svg viewBox="0 0 24 24"><path d="M14 6l-6 6 6 6"/></svg> Paperbreak
        </a>
      </div>
      <button class="map-locate" aria-label="Go to my location" title="My location">
        <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/><circle cx="12" cy="12" r="8"/></svg>
      </button>
      <div class="map-hint" id="map-hint">Zoom in to load spots</div>
    </div>`;

  try {
    await loadLeaflet();
  } catch {
    container.innerHTML = '<div class="view"><div class="empty">Map library failed to load.</div></div>';
    return () => document.body.classList.remove('map-open');
  }
  if (!container.isConnected) {
    document.body.classList.remove('map-open');
    return () => {};
  }

  const L = window.L;
  const theme = () => document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';

  // restore last view from URL (?c=lat,lon,z)
  let center = [33.9, -118.5], zoom = 9;
  const c = (query.get('c') || '').split(',').map(Number);
  if (c.length === 3 && c.every(isFinite)) { center = [c[0], c[1]]; zoom = c[2]; }

  const map = L.map(container.querySelector('#map'), {
    center, zoom, zoomControl: false, worldCopyJump: true,
    attributionControl: true,
  });
  L.control.zoom({ position: 'bottomleft' }).addTo(map);
  let tiles = L.tileLayer(TILES[theme()], { attribution: ATTRIB, maxZoom: 18 }).addTo(map);
  const offTheme = on('theme', () => {
    map.removeLayer(tiles);
    tiles = L.tileLayer(TILES[theme()], { attribution: ATTRIB, maxZoom: 18 }).addTo(map);
  });

  const hint = container.querySelector('#map-hint');
  const layer = L.layerGroup().addTo(map);
  const seen = new Map(); // spotId -> marker

  const loadSpots = debounce(async () => {
    if (!container.isConnected) return;
    if (map.getZoom() < MIN_SPOT_ZOOM) {
      hint.textContent = 'Zoom in to load spots';
      hint.style.opacity = '1';
      return;
    }
    hint.textContent = 'Loading spots…';
    hint.style.opacity = '1';
    const b = map.getBounds();
    let spots;
    try {
      spots = await getMapSpots({
        north: b.getNorth(), south: b.getSouth(), east: b.getEast(), west: b.getWest(),
      });
    } catch {
      hint.textContent = 'Couldn’t load spots here (offline?)';
      return;
    }
    if (!container.isConnected) return;
    for (const s of spots) {
      if (seen.has(s.id) || s.lat == null) continue;
      const color = getComputedStyle(document.documentElement)
        .getPropertyValue(cssVar(s.ratingKey)).trim() || '#888';
      const m = L.circleMarker([s.lat, s.lon], {
        radius: s.hasCam ? 7 : 5,
        color, weight: s.hasCam ? 2.5 : 1.5,
        fillColor: color, fillOpacity: 0.55,
      });
      m.bindTooltip(
        `<span class="pb-spot-tip">${esc(s.name)}</span>` +
        (s.surf ? `<br>${esc(fmtSurfRange(s.surf.min, s.surf.max, s.surf.plus))} · ${esc(ratingLabel(s.ratingKey))}` : '') +
        (s.hasCam ? '<br>📷 cam' : ''),
        { direction: 'top', offset: [0, -6] },
      );
      m.on('click', () => navigate(['spot', s.id], { name: s.name }));
      m.addTo(layer);
      seen.set(s.id, m);
    }
    hint.style.opacity = '0';
  }, 350);

  map.on('moveend', () => {
    const ctr = map.getCenter();
    replaceQuery((q) => q.set('c', `${ctr.lat.toFixed(3)},${ctr.lng.toFixed(3)},${map.getZoom()}`));
    loadSpots();
  });
  loadSpots();

  container.querySelector('.map-locate').addEventListener('click', () => {
    navigator.geolocation.getCurrentPosition(
      (pos) => map.setView([pos.coords.latitude, pos.coords.longitude], Math.max(map.getZoom(), 10)),
      () => toast('Location unavailable'),
      { maximumAge: 300_000, timeout: 12_000 },
    );
  });

  return () => {
    document.body.classList.remove('map-open');
    offTheme();
    map.remove();
  };
}

function cssVar(key) {
  const m = {
    FLAT: '--r-flat', VERY_POOR: '--r-vpoor', POOR: '--r-poor', POOR_TO_FAIR: '--r-pfair',
    FAIR: '--r-fair', FAIR_TO_GOOD: '--r-fgood', GOOD: '--r-good', VERY_GOOD: '--r-vgood',
    GOOD_TO_EPIC: '--r-epic', EPIC: '--r-epic',
  };
  return m[key] || '--r-flat';
}
