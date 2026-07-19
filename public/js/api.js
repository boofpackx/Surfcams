// Data layer over the (unofficial) Surfline KBYG API, reached through this
// site's own /api proxy. Everything degrades gracefully:
//   live fetch → session cache (marked stale) → generated demo data (marked demo)
//
// Endpoints used (all GET):
//   /api/kbyg/spots/details?spotId=
//   /api/kbyg/spots/forecasts/{wave|rating|wind|tides|weather|sunlight}?spotId=&days=&intervalHours=
//   /api/kbyg/mapview?north=&south=&east=&west=
//   /api/search/site?q=&querySize=&suggestionSize=

import { demoForecast, demoSpotDetails, DEMO_SEARCH } from './demo.js';
import { emit } from './state.js';

const mem = new Map();      // url -> {at, data}
const inflight = new Map(); // url -> Promise

export let apiDown = false;
function setApiDown(v) {
  if (apiDown !== v) { apiDown = v; emit('apidown', v); }
}

export class ApiError extends Error {
  constructor(status, url) { super(`API ${status} for ${url}`); this.status = status; }
}

function qs(params) {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) if (v != null) u.set(k, v);
  const s = u.toString();
  return s ? `?${s}` : '';
}

export async function apiGet(path, params, { ttl = 60_000 } = {}) {
  const url = `/api${path}${qs(params)}`;
  const hit = mem.get(url);
  if (hit && Date.now() - hit.at < ttl) return hit.data;
  if (inflight.has(url)) return inflight.get(url);

  const p = (async () => {
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new ApiError(res.status, url);
    const data = await res.json();
    mem.set(url, { at: Date.now(), data });
    try { sessionStorage.setItem(`pb:c:${url}`, JSON.stringify({ at: Date.now(), data })); } catch { /* full */ }
    setApiDown(false);
    return data;
  })().finally(() => inflight.delete(url));

  inflight.set(url, p);
  return p;
}

function sessionFallback(path, params) {
  try {
    const raw = sessionStorage.getItem(`pb:c:/api${path}${qs(params)}`);
    if (!raw) return null;
    return JSON.parse(raw).data;
  } catch { return null; }
}

// `network` errors (proxy down / offline / 5xx) trigger fallbacks; 4xx means
// the endpoint answered and just doesn't have data — callers treat those as
// "missing", not "down".
function isDownError(err) {
  return !(err instanceof ApiError)
    || err.status >= 500
    || [401, 403, 407, 429].includes(err.status);
}

// ------------------------------------------------------------ spot details
export async function getSpotDetails(spotId) {
  try {
    const r = await apiGet('/kbyg/spots/details', { spotId }, { ttl: 10 * 60_000 });
    const spot = r.spot || r;
    return {
      id: spotId,
      name: spot.name,
      lat: spot.lat, lon: spot.lon,
      sub: spot.subregion?.name || spot.breadCrumbs?.join(', ') || '',
      cameras: (spot.cameras || []).map((c) => ({
        id: c._id, title: c.title || spot.name,
        streamUrl: c.streamUrl, stillUrl: c.stillUrl,
        rewindBaseUrl: c.rewindBaseUrl,
        alias: c.alias, isDown: !!c.status?.isDown, isPremium: !!c.isPremium,
      })),
      lola: spot.lat != null ? `${spot.lat.toFixed(3)}, ${spot.lon.toFixed(3)}` : '',
      raw: spot,
      demo: false,
    };
  } catch (err) {
    const cached = sessionFallback('/kbyg/spots/details', { spotId });
    if (cached?.spot) {
      const spot = cached.spot;
      return {
        id: spotId, name: spot.name, lat: spot.lat, lon: spot.lon,
        sub: spot.subregion?.name || '', stale: true, demo: false,
        cameras: (spot.cameras || []).map((c) => ({
          id: c._id, title: c.title || spot.name, streamUrl: c.streamUrl,
          stillUrl: c.stillUrl, rewindBaseUrl: c.rewindBaseUrl, alias: c.alias,
          isDown: !!c.status?.isDown, isPremium: !!c.isPremium,
        })),
      };
    }
    if (isDownError(err)) setApiDown(true);
    const d = demoSpotDetails(spotId);
    return {
      id: spotId, name: d.spot.name, lat: d.spot.lat, lon: d.spot.lon,
      sub: d.spot.subregion.name, cameras: [], demo: true,
    };
  }
}

// ---------------------------------------------------------------- forecast
const FC_TYPES = ['wave', 'rating', 'wind', 'tides', 'weather', 'sunlight'];

export async function getForecast(spotId, { days = 6, intervalHours = 1 } = {}) {
  const reqs = {
    wave: apiGet('/kbyg/spots/forecasts/wave', { spotId, days, intervalHours }, { ttl: 5 * 60_000 }),
    rating: apiGet('/kbyg/spots/forecasts/rating', { spotId, days, intervalHours }, { ttl: 5 * 60_000 }),
    wind: apiGet('/kbyg/spots/forecasts/wind', { spotId, days, intervalHours }, { ttl: 5 * 60_000 }),
    tides: apiGet('/kbyg/spots/forecasts/tides', { spotId, days }, { ttl: 5 * 60_000 }),
    weather: apiGet('/kbyg/spots/forecasts/weather', { spotId, days, intervalHours }, { ttl: 5 * 60_000 }),
    sunlight: apiGet('/kbyg/spots/forecasts/sunlight', { spotId, days }, { ttl: 30 * 60_000 }),
  };
  const settled = {};
  await Promise.all(FC_TYPES.map(async (k) => {
    settled[k] = await reqs[k].then((v) => ({ ok: true, v })).catch((e) => ({ ok: false, e }));
  }));

  // Wave data is the backbone; without it fall back to cache, then demo.
  if (!settled.wave.ok) {
    const cached = sessionFallback('/kbyg/spots/forecasts/wave', { spotId, days, intervalHours });
    if (!cached) {
      if (isDownError(settled.wave.e)) setApiDown(true);
      return demoForecast(spotId, days);
    }
    settled.wave = { ok: true, v: cached, stale: true };
    for (const k of FC_TYPES.slice(1)) {
      if (!settled[k].ok) {
        const c = sessionFallback(`/kbyg/spots/forecasts/${k}`,
          k === 'tides' || k === 'sunlight' ? { spotId, days } : { spotId, days, intervalHours });
        if (c) settled[k] = { ok: true, v: c, stale: true };
      }
    }
  }

  const waveR = settled.wave.v;
  const out = {
    demo: false,
    stale: !!settled.wave.stale,
    utcOffset: waveR.associated?.utcOffset ?? waveR.data?.wave?.[0]?.utcOffset ?? 0,
    units: waveR.associated?.units || {},
    wave: waveR.data?.wave || [],
    rating: settled.rating.ok ? (settled.rating.v.data?.rating || []) : null,
    wind: settled.wind.ok ? (settled.wind.v.data?.wind || []) : null,
    weather: settled.weather.ok ? (settled.weather.v.data?.weather || []) : null,
    tides: settled.tides.ok ? (settled.tides.v.data?.tides || []) : null,
    sunlight: settled.sunlight.ok
      ? (settled.sunlight.v.data?.sunlight || [])
      : (settled.weather.ok ? settled.weather.v.data?.sunlightTimes || null : null),
  };
  return out;
}

// ------------------------------------------------------- light spot report
// Small "now" summary for list rows. Cached hard (5 min) — favorites lists
// hit this once per spot.
export async function getSpotReport(spotId) {
  try {
    const [waveR, ratingR] = await Promise.all([
      apiGet('/kbyg/spots/forecasts/wave', { spotId, days: 1, intervalHours: 3 }, { ttl: 5 * 60_000 }),
      apiGet('/kbyg/spots/forecasts/rating', { spotId, days: 1, intervalHours: 3 }, { ttl: 5 * 60_000 })
        .catch(() => null),
    ]);
    const now = Date.now() / 1000;
    const nearest = (arr) => (arr || []).reduce((best, x) =>
      (!best || Math.abs(x.timestamp - now) < Math.abs(best.timestamp - now)) ? x : best, null);
    const w = nearest(waveR.data?.wave);
    const r = nearest(ratingR?.data?.rating);
    if (!w) return null;
    return {
      surf: w.surf, ratingKey: r?.rating?.key || null, demo: false,
    };
  } catch (err) {
    if (isDownError(err)) setApiDown(true);
    const d = demoForecast(spotId, 1);
    const now = Date.now() / 1000;
    const w = d.wave.reduce((b, x) => (!b || Math.abs(x.timestamp - now) < Math.abs(b.timestamp - now)) ? x : b, null);
    const r = d.rating.reduce((b, x) => (!b || Math.abs(x.timestamp - now) < Math.abs(b.timestamp - now)) ? x : b, null);
    return { surf: w.surf, ratingKey: r.rating.key, demo: true };
  }
}

// ------------------------------------------------------------------ search
export async function searchSpots(q) {
  try {
    const r = await apiGet('/search/site', { q, querySize: 10, suggestionSize: 0 }, { ttl: 5 * 60_000 });
    const groups = Array.isArray(r) ? r : [r];
    const spots = [];
    for (const g of groups) {
      for (const h of g?.hits?.hits || []) {
        if (h._type && h._type !== 'spot') continue;
        const s = h._source || {};
        if (!s.name) continue;
        spots.push({
          id: h._id,
          name: s.name,
          sub: Array.isArray(s.breadCrumbs) ? s.breadCrumbs.join(', ') : '',
          hasCam: Array.isArray(s.cams) ? s.cams.length > 0 : !!s.camCount,
        });
      }
    }
    return { spots, demo: false };
  } catch (err) {
    if (isDownError(err)) setApiDown(true);
    const needle = q.trim().toLowerCase();
    return {
      demo: true,
      spots: DEMO_SEARCH.filter((s) => s.name.toLowerCase().includes(needle) || !needle),
    };
  }
}

// --------------------------------------------------------------------- map
export async function getMapSpots(bounds) {
  const { north, south, east, west } = bounds;
  const r = await apiGet('/kbyg/mapview', {
    north: north.toFixed(4), south: south.toFixed(4),
    east: east.toFixed(4), west: west.toFixed(4),
  }, { ttl: 2 * 60_000 });
  const spots = r.data?.spots || r.spots || [];
  return spots.map((s) => ({
    id: s._id, name: s.name, lat: s.lat, lon: s.lon,
    ratingKey: s.rating?.key || s.conditions?.value || null,
    surf: s.waveHeight ? { min: s.waveHeight.min, max: s.waveHeight.max, plus: s.waveHeight.plus } : null,
    hasCam: Array.isArray(s.cameras) ? s.cameras.length > 0 : false,
  }));
}

// ------------------------------------------------------------------- media
export function proxied(url) {
  return url ? `/proxy?url=${encodeURIComponent(url)}` : '';
}

export async function probeUrl(url) {
  try {
    const res = await fetch(proxied(url), { method: 'HEAD' });
    return res.ok;
  } catch { return false; }
}

// Try Surfline's cam-rewind clip listing endpoints (unofficial, may change).
// Returns [{url, startTimestamp, endTimestamp}] or null if unsupported.
export async function getRewindClips(cameraId, startISO, endISO) {
  for (const path of ['/cameras/recording/clips', '/kbyg/cameras/recording/clips']) {
    try {
      const r = await apiGet(path, { cameraId, startDate: startISO, endDate: endISO }, { ttl: 5 * 60_000 });
      const clips = r.clips || r.data?.clips || (Array.isArray(r) ? r : null);
      if (Array.isArray(clips) && clips.length) {
        return clips
          .map((c) => ({
            url: c.recordingUrl || c.url || c.clipUrl,
            start: c.startTimestampInMs ? c.startTimestampInMs / 1000 : c.startDate,
            end: c.endTimestampInMs ? c.endTimestampInMs / 1000 : c.endDate,
          }))
          .filter((c) => c.url);
      }
    } catch { /* try next shape */ }
  }
  return null;
}
