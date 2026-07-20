// Spot page: cam on top, then a sticky time readout with a scrub rail, the
// synced chart stack, and per-day jump chips.

import { getSpotDetails, getForecast, getMapSpots } from '../api.js';
import { createCamPlayer } from '../components/cam.js';
import { Timeline, createChartStack, createRail, nearest } from '../components/charts.js';
import {
  esc, el, toast, fmtDayHour, fmtDayShort, startOfSpotDay,
  ratingLabel, ratingColor, compass, debounce,
} from '../format.js';
import { fmtSurfRange, fmtHeight, fmtSpeed, fmtTemp } from '../units.js';
import { isFavorite, toggleFavorite, pushRecent, on } from '../state.js';
import { replaceQuery, parseHash, href } from '../router.js';

// Spots without a cam say so explicitly (silence looks like a bug) and
// point at the closest spots that do have one.
async function showNoCamNote(root, spot) {
  root.innerHTML = `
    <div class="nocam">
      <span class="small muted">No public cam at this spot.</span>
      <span class="small nocam-nearby faint">Looking for cams nearby…</span>
    </div>`;
  const slot = root.querySelector('.nocam-nearby');
  if (spot.lat == null) { slot.textContent = ''; return; }
  try {
    const spots = await getMapSpots({
      north: spot.lat + 0.6, south: spot.lat - 0.6,
      east: spot.lon + 0.7, west: spot.lon - 0.7,
    });
    if (!slot.isConnected) return;
    const withCams = spots
      .filter((s) => s.hasCam && s.id !== spot.id && s.lat != null)
      .map((s) => ({ ...s, d: Math.hypot(s.lat - spot.lat, s.lon - spot.lon) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, 3);
    slot.innerHTML = withCams.length
      ? 'Nearest cams: ' + withCams
        .map((s) => `<a href="${href(['spot', s.id], { name: s.name })}">${esc(s.name)}</a>`)
        .join(' · ')
      : 'No cams within ~60 km — spots with cams show a CAM badge in search.';
  } catch {
    if (slot.isConnected) slot.textContent = '';
  }
}

export async function renderSpot(container, { params, query }) {
  const spotId = params.id;
  const nameHint = query.get('name') || '';

  container.innerHTML = `
    <div class="spot-head">
      <div class="crumbs skel" style="max-width:220px">&nbsp;</div>
      <div class="headrow">
        <h1 id="spot-name">${esc(nameHint) || '<span class="skel">Loading spot</span>'}</h1>
        <div style="display:flex; gap:2px; flex:none">
          <button class="iconbtn" id="share-btn" aria-label="Share this spot" title="Share">
            <svg viewBox="0 0 24 24"><circle cx="6" cy="12" r="2.5"/><circle cx="17" cy="5.5" r="2.5"/><circle cx="17" cy="18.5" r="2.5"/><path d="M8.3 10.8l6.4-4M8.3 13.2l6.4 4"/></svg>
          </button>
          <button class="iconbtn starbtn" id="fav-btn" aria-label="Toggle favorite" title="Favorite (f)">
            <svg viewBox="0 0 24 24"><path d="M12 3.6l2.5 5.2 5.7.7-4.2 3.9 1.1 5.6L12 16.2 6.9 19l1.1-5.6-4.2-3.9 5.7-.7z"/></svg>
          </button>
        </div>
      </div>
      <div class="spot-meta" id="spot-meta"></div>
    </div>
    <div id="cam-root"></div>
    <div class="readout" id="readout" hidden>
      <div class="ro-time">
        <span class="ro-when num" id="ro-when">—</span>
        <button class="ro-live" id="ro-now">NOW</button>
        <span class="small faint" id="ro-note"></span>
      </div>
      <div class="ro-vals" id="ro-vals"></div>
      <div class="rail" id="rail" aria-label="Forecast scrubber"></div>
      <div class="timeline-controls">
        <button class="cambtn" data-tc="prevday" aria-label="Previous day" title="Previous day ( [ )">
          <svg viewBox="0 0 24 24"><path d="M17 5l-8 7 8 7M7 5v14"/></svg>
        </button>
        <button class="cambtn" data-tc="rw" title="Back 3 hours (←)">−3h</button>
        <button class="cambtn" data-tc="play" aria-label="Play forecast" title="Play (space)">
          <svg viewBox="0 0 24 24" class="pp"><path d="M8 5l11 7-11 7z"/></svg>
        </button>
        <button class="cambtn" data-tc="ff" title="Forward 3 hours (→)">+3h</button>
        <button class="cambtn" data-tc="nextday" aria-label="Next day" title="Next day ( ] )">
          <svg viewBox="0 0 24 24"><path d="M7 5l8 7-8 7M17 5v14"/></svg>
        </button>
        <button class="cambtn" data-tc="speed" title="Playback speed">1×</button>
        <span class="spacer"></span>
        <button class="cambtn" data-tc="zoomout" aria-label="Zoom out" title="Zoom out (−)">−</button>
        <button class="cambtn" data-tc="zoomin" aria-label="Zoom in" title="Zoom in (+)">+</button>
      </div>
    </div>
    <div class="charts" id="charts"></div>
    <div class="day-chips" id="day-chips"></div>
    <p class="footnote" id="spot-note"></p>
  `;

  const cleanups = [];
  let tl = null;

  // ---------------------------------------------------------- spot details
  const spot = await getSpotDetails(spotId);
  if (!container.isConnected) return () => {};
  document.title = `${spot.name || 'Spot'} — Paperbreak`;
  container.querySelector('#spot-name').textContent = spot.name || 'Unknown spot';
  container.querySelector('.crumbs').textContent = spot.sub || (spot.demo ? 'Offline — sample data' : '');
  container.querySelector('.crumbs').classList.remove('skel');
  pushRecent({ id: spotId, name: spot.name, sub: spot.sub });

  const favBtn = container.querySelector('#fav-btn');
  const syncFav = () => {
    const on = isFavorite(spotId);
    favBtn.classList.toggle('on', on);
    favBtn.setAttribute('aria-label', on ? 'Remove from favorites' : 'Add to favorites');
  };
  syncFav();
  favBtn.addEventListener('click', () => {
    const added = toggleFavorite({ id: spotId, name: spot.name, sub: spot.sub });
    toast(added ? `Saved ${spot.name}` : `Removed ${spot.name}`);
    syncFav();
  });

  container.querySelector('#share-btn').addEventListener('click', async () => {
    const url = location.href;
    try {
      if (navigator.share) await navigator.share({ title: `${spot.name} — Paperbreak`, url });
      else { await navigator.clipboard.writeText(url); toast('Link copied'); }
    } catch { /* dismissed */ }
  });

  // ------------------------------------------------------------------ cam
  const camSpot = { ...spot };
  const cam = createCamPlayer(container.querySelector('#cam-root'), camSpot);
  if (cam) cleanups.push(() => cam.destroy());
  else if (!spot.demo) showNoCamNote(container.querySelector('#cam-root'), spot);

  // ------------------------------------------------------------- forecast
  const fc = await getForecast(spotId, { days: 6, intervalHours: 1 });
  if (!container.isConnected) { cleanups.forEach((f) => f()); return () => {}; }

  const meta = container.querySelector('#spot-meta');
  const bits = [];
  if (spot.lola) bits.push(spot.lola);
  if (fc.demo) bits.push('sample data (offline)');
  else if (fc.stale) bits.push('cached data — may be out of date');
  meta.innerHTML = bits.map((b) => `<span>${esc(b)}</span>`).join('');

  container.querySelector('#spot-note').innerHTML = fc.demo
    ? 'You are looking at generated sample data — the Surfline API was unreachable. Everything still works; reconnect for real conditions.'
    : 'Forecast via Surfline’s unofficial public API (free tier: 6 days, hourly). Times are shown in the spot’s local time.';

  if (!fc.wave.length) {
    container.querySelector('#charts').innerHTML = '<div class="empty">No forecast data for this spot.</div>';
    return () => cleanups.forEach((f) => f());
  }

  // ------------------------------------------------- timeline + readout
  const off = fc.utcOffset;
  const start = fc.wave[0].timestamp;
  const end = fc.wave[fc.wave.length - 1].timestamp + 3600;
  tl = new Timeline(start, end, off);

  const qt = Number(query.get('t'));
  if (qt && qt > start && qt < end) {
    tl.setCursor(qt, { follow: false });
    tl.setView(qt - 86400 * 0.6, qt + 86400 * 1.9);
  }

  const readout = container.querySelector('#readout');
  readout.hidden = false;
  const roWhen = container.querySelector('#ro-when');
  const roVals = container.querySelector('#ro-vals');
  const roNote = container.querySelector('#ro-note');
  if (fc.demo) roNote.textContent = 'sample';

  const syncUrl = debounce(() => {
    // the debounce can fire after navigating away — never touch another view's URL
    const { path } = parseHash();
    if (path[0] !== 'spot' || path[1] !== spotId) return;
    replaceQuery((q) => q.set('t', String(Math.round(tl.cursor))));
  }, 400);

  function updateReadout() {
    roWhen.textContent = fmtDayHour(tl.cursor, off);
    const w = nearest(fc.wave, tl.cursor);
    const r = fc.rating ? nearest(fc.rating, tl.cursor) : null;
    const wd = fc.wind ? nearest(fc.wind, tl.cursor) : null;
    const td = fc.tides ? nearest(fc.tides, tl.cursor, 7200) : null;
    const wx = fc.weather ? nearest(fc.weather, tl.cursor, 7200) : null;
    const swell = w?.swells?.filter((s) => s.height > 0.2).sort((a, b) => b.height - a.height)[0];

    const vals = [];
    if (w?.surf) vals.push({ k: 'Surf', v: `${fmtSurfRange(w.surf.min, w.surf.max, w.surf.plus)}` });
    if (r?.rating) vals.push({ k: 'Rating', v: ratingLabel(r.rating.key), c: ratingColor(r.rating.key) });
    if (wd) vals.push({ k: `Wind · ${esc(wd.directionType || compass(wd.direction))}`, v: `${fmtSpeed(wd.speed)} <small>${compass(wd.direction)}</small>` });
    if (td) vals.push({ k: 'Tide', v: `${fmtHeight(td.height, { digits: 1 })}` });
    if (wx) vals.push({ k: 'Air', v: fmtTemp(wx.temperature) });
    if (swell) vals.push({ k: 'Swell', v: `${fmtHeight(swell.height, { digits: 1 })} <small>@ ${Math.round(swell.period)}s ${compass(swell.direction)}</small>` });

    roVals.innerHTML = vals.map((x) => `
      <div class="ro-val">
        <div class="v num" ${x.c ? `style="color:${x.c}"` : ''}>${x.v}</div>
        <div class="k">${x.k}</div>
      </div>`).join('');
    syncUrl();
  }
  cleanups.push(tl.onCursor(updateReadout));
  updateReadout();

  // charts + rail
  const stack = createChartStack(container.querySelector('#charts'), fc, tl);
  cleanups.push(() => stack.destroy());
  const rail = createRail(container.querySelector('#rail'), fc, tl);
  cleanups.push(() => rail.destroy());
  cleanups.push(on('settings', () => { stack.render(); updateReadout(); }));
  cleanups.push(on('theme', () => rail.draw()));

  container.querySelector('#ro-now').addEventListener('click', () => tl.goNow());

  // transport controls
  const playBtn = container.querySelector('[data-tc="play"]');
  cleanups.push(tl.onPlayState((playing) => {
    playBtn.innerHTML = playing
      ? '<svg viewBox="0 0 24 24" class="pp"><path d="M8 5v14M16 5v14" stroke="currentColor" stroke-width="2.4" fill="none" stroke-linecap="round"/></svg>'
      : '<svg viewBox="0 0 24 24" class="pp"><path d="M8 5l11 7-11 7z"/></svg>';
    playBtn.setAttribute('aria-label', playing ? 'Pause' : 'Play forecast');
  }));
  container.querySelector('.timeline-controls').addEventListener('click', (e) => {
    const b = e.target.closest('[data-tc]');
    if (!b) return;
    const act = b.dataset.tc;
    if (act === 'play') tl.toggle();
    if (act === 'rw') tl.setCursor(tl.cursor - 3 * 3600);
    if (act === 'ff') tl.setCursor(tl.cursor + 3 * 3600);
    if (act === 'prevday') tl.jumpDay(-1);
    if (act === 'nextday') tl.jumpDay(1);
    if (act === 'zoomin') tl.zoom(1.5);
    if (act === 'zoomout') tl.zoom(1 / 1.5);
    if (act === 'speed') {
      tl.speed = tl.speed >= 4 ? 1 : tl.speed * 2;
      b.textContent = `${tl.speed}×`;
    }
  });

  // day chips
  const chips = container.querySelector('#day-chips');
  const dayStart = startOfSpotDay(start, off);
  let chipHtml = '';
  for (let d = dayStart; d < end; d += 86400) {
    const dayWaves = fc.wave.filter((w) => w.timestamp >= d && w.timestamp < d + 86400);
    if (!dayWaves.length) continue;
    const mx = Math.max(...dayWaves.map((w) => w.surf?.max || 0));
    const bestKey = fc.rating
      ? fc.rating.filter((r) => r.timestamp >= d && r.timestamp < d + 86400)
        .reduce((best, r) => ((r.rating?.value ?? -1) > (best?.rating?.value ?? -1) ? r : best), null)?.rating?.key
      : null;
    const { day, date } = fmtDayShort(d + 43200, off);
    chipHtml += `
      <button class="chip day-chip" data-day="${d}">
        <div class="dc-day">${day} <span class="faint">${date}</span></div>
        <div class="dc-sub num"><span class="dot" style="background:${ratingColor(bestKey)}"></span>to ${fmtHeight(mx)}</div>
      </button>`;
  }
  chips.innerHTML = chipHtml;
  chips.addEventListener('click', (e) => {
    const b = e.target.closest('[data-day]');
    if (!b) return;
    const d = Number(b.dataset.day);
    tl.setView(d, d + Math.min(86400 * 1.5, end - start));
    tl.setCursor(Math.max(d + 8 * 3600, start), { follow: false });
  });

  // keyboard
  const onKey = (e) => {
    if (e.target.matches('input, textarea, select') || e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key;
    if (k === ' ') { e.preventDefault(); tl.toggle(); }
    else if (k === 'ArrowLeft') { e.preventDefault(); tl.setCursor(tl.cursor - (e.shiftKey ? 1 : 3) * 3600); }
    else if (k === 'ArrowRight') { e.preventDefault(); tl.setCursor(tl.cursor + (e.shiftKey ? 1 : 3) * 3600); }
    else if (k === '[') tl.jumpDay(-1);
    else if (k === ']') tl.jumpDay(1);
    else if (k === '+' || k === '=') tl.zoom(1.5);
    else if (k === '-') tl.zoom(1 / 1.5);
    else if (k === 'n' || k === 'N') tl.goNow();
    else if (k === 'f' || k === 'F') favBtn.click();
  };
  document.addEventListener('keydown', onKey);
  cleanups.push(() => document.removeEventListener('keydown', onKey));

  return () => cleanups.forEach((f) => { try { f(); } catch { /* */ } });
}
