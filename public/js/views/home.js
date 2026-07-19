// Home: hero search, favorites with live conditions, near-me, popular names.

import { searchboxHTML, attachSearch } from '../components/search.js';
import { favorites, recents, on, toggleFavorite } from '../state.js';
import { getSpotReport, searchSpots, getMapSpots } from '../api.js';
import { el, esc, ratingLabel, ratingColor, toast } from '../format.js';
import { fmtSurfRange } from '../units.js';
import { href, navigate } from '../router.js';

const POPULAR = [
  'Pipeline', 'Malibu', 'Trestles', 'Ocean Beach SF', 'Huntington Beach',
  'Steamer Lane', 'Waikiki', 'Bells Beach', 'Hossegor', 'Uluwatu',
];

function spotRowHTML(s) {
  return `
  <li>
    <a class="spot-row" href="${href(['spot', s.id], { name: s.name })}" data-id="${esc(s.id)}">
      <div class="sp-main">
        <div class="sp-name">${esc(s.name)}</div>
        <div class="sp-sub">${esc(s.sub || '')}</div>
      </div>
      <div class="sp-cond" data-cond="${esc(s.id)}">
        <div class="sp-surf skel">0–0 ft</div>
        <div class="sp-rating skel">loading</div>
      </div>
      <button class="starbtn on" data-star="${esc(s.id)}" aria-label="Remove ${esc(s.name)} from favorites">
        <svg viewBox="0 0 24 24"><path d="M12 3.6l2.5 5.2 5.7.7-4.2 3.9 1.1 5.6L12 16.2 6.9 19l1.1-5.6-4.2-3.9 5.7-.7z"/></svg>
      </button>
    </a>
  </li>`;
}

async function fillConditions(container, spots) {
  await Promise.all(spots.map(async (s) => {
    const box = container.querySelector(`[data-cond="${CSS.escape(s.id)}"]`);
    if (!box) return;
    const rep = await getSpotReport(s.id).catch(() => null);
    if (!box.isConnected) return;
    if (!rep) { box.innerHTML = '<div class="sp-sub faint">—</div>'; return; }
    const { surf, ratingKey, demo } = rep;
    box.innerHTML = `
      <div class="sp-surf num">${surf ? fmtSurfRange(surf.min, surf.max, surf.plus) : '—'}</div>
      <div class="sp-rating" style="color:${ratingColor(ratingKey)}">
        <span class="dot" style="background:${ratingColor(ratingKey)}"></span>${esc(ratingLabel(ratingKey))}${demo ? ' · demo' : ''}
      </div>`;
  }));
}

export async function renderHome(container) {
  container.innerHTML = `
    <section class="hero">
      <h1>Surf, quietly.</h1>
      <p>Cams, tides, wind and swell for every Surfline spot — on paper-calm pages that stay out of your way.</p>
      ${searchboxHTML()}
    </section>

    <section class="section" id="home-favs">
      <div class="section-head"><span class="label">Favorites</span></div>
      <ul class="spotlist"></ul>
      <div class="empty" hidden>Star a spot and it will live here, one tap from the lineup.</div>
    </section>

    <section class="section" id="home-near">
      <div class="section-head">
        <span class="label">Near me</span>
        <button class="chip" id="near-btn">Use my location</button>
      </div>
      <ul class="spotlist"></ul>
      <div class="empty">Share your location to see the closest breaks.</div>
    </section>

    <section class="section" id="home-popular">
      <div class="section-head"><span class="label">Popular lineups</span></div>
      <div class="chiprow">
        ${POPULAR.map((n) => `<button class="chip" data-pop="${esc(n)}">${esc(n)}</button>`).join('')}
      </div>
    </section>

    <p class="footnote">
      Paperbreak reads Surfline’s unofficial public forecast endpoints and is not
      affiliated with Surfline. Data can lag or vanish without notice — always
      check conditions with your own eyes before paddling out. Premium-only cams
      and 16-day forecasts require a Surfline account and are not accessed here.
    </p>
  `;

  const search = attachSearch(container.querySelector('.hero'));

  // Favorites -------------------------------------------------------------
  const favsSection = container.querySelector('#home-favs');
  function renderFavs() {
    const ul = favsSection.querySelector('ul');
    const empty = favsSection.querySelector('.empty');
    ul.innerHTML = favorites.map(spotRowHTML).join('');
    empty.hidden = favorites.length > 0;
    ul.querySelectorAll('[data-star]').forEach((b) => {
      b.addEventListener('click', (e) => {
        e.preventDefault(); e.stopPropagation();
        const id = b.dataset.star;
        const f = favorites.find((x) => x.id === id);
        if (f) { toggleFavorite(f); toast(`Removed ${f.name}`); renderFavs(); }
      });
    });
    fillConditions(ul, favorites);
  }
  renderFavs();
  const offFavs = on('favorites', renderFavs);

  // Near me ---------------------------------------------------------------
  const nearSection = container.querySelector('#home-near');
  nearSection.querySelector('#near-btn').addEventListener('click', () => {
    const empty = nearSection.querySelector('.empty');
    empty.textContent = 'Locating…';
    navigator.geolocation.getCurrentPosition(async (pos) => {
      const { latitude: lat, longitude: lon } = pos.coords;
      try {
        const spots = (await getMapSpots({
          north: lat + 0.35, south: lat - 0.35, east: lon + 0.45, west: lon - 0.45,
        }))
          .map((s) => ({ ...s, d: Math.hypot(s.lat - lat, s.lon - lon) }))
          .sort((a, b) => a.d - b.d)
          .slice(0, 6);
        if (!spots.length) { empty.textContent = 'No Surfline spots within ~40 km.'; return; }
        empty.hidden = true;
        const ul = nearSection.querySelector('ul');
        ul.innerHTML = spots.map((s) => `
          <li><a class="spot-row" href="${href(['spot', s.id], { name: s.name })}">
            <div class="sp-main"><div class="sp-name">${esc(s.name)}</div>
              <div class="sp-sub">${(s.d * 111).toFixed(1)} km away${s.hasCam ? ' · cam' : ''}</div></div>
            <div class="sp-cond">
              <div class="sp-surf num">${s.surf ? fmtSurfRange(s.surf.min, s.surf.max, s.surf.plus) : ''}</div>
              <div class="sp-rating" style="color:${ratingColor(s.ratingKey)}">${esc(ratingLabel(s.ratingKey))}</div>
            </div>
          </a></li>`).join('');
      } catch {
        empty.textContent = 'Couldn’t load nearby spots (offline?). Try the map instead.';
      }
    }, () => {
      nearSection.querySelector('.empty').textContent = 'Location unavailable — you can browse the map instead.';
    }, { maximumAge: 300_000, timeout: 12_000 });
  });

  // Popular ---------------------------------------------------------------
  container.querySelectorAll('[data-pop]').forEach((b) => {
    b.addEventListener('click', async () => {
      b.classList.add('on');
      const { spots } = await searchSpots(b.dataset.pop);
      b.classList.remove('on');
      if (spots.length) navigate(['spot', spots[0].id], { name: spots[0].name });
      else toast('Not found — try the search box');
    });
  });

  return () => { offFavs(); search.destroy(); };
}
