# Paperbreak — surf, quietly

A minimalist, paperwhite-style surf site: live cams, cam rewind, and full
forecasts (surf, swell, rating, wind, tide, weather) for every Surfline spot,
rendered like a well-set page instead of a dashboard.

No framework, no build step, no tracking. One tiny Node server, vanilla ES
modules, hand-rolled SVG charts.

## Run it

```sh
node server.js          # → http://localhost:8080
PORT=3000 node server.js
```

Node 18+ is the only requirement. The server serves `public/` and proxies the
(unofficial) Surfline API + cam media, because those endpoints don't send CORS
headers for third-party origins.

Deploying to Netlify also works out of the box (`netlify.toml` proxies
`/api/*` at the edge); cam playback then streams straight from Surfline's CDN.

### GitHub Pages (no server at all)

The repo ships a workflow (`.github/workflows/pages.yml`) that publishes
`public/` to GitHub Pages on every push — the site lands at
`https://<user>.github.io/<repo>/`. If the first run fails with a Pages
permission error, enable it once under **Settings → Pages → Source: GitHub
Actions**, then re-run the workflow.

Pages is static-only, so there is no proxy there. The app detects `*.github.io`
and switches to **direct mode**: each API call walks a route chain — straight
to `services.surfline.com`, then through public CORS relays (allorigins,
corsproxy.io, codetabs) — and remembers the first route that answers with
valid JSON. Public relays are best-effort; for a relay you own (recommended,
~3 minutes, free), deploy `workers/relay.js` to Cloudflare Workers and run
this once in your browser's console on the site:

```js
localStorage.setItem('pb:relay', 'https://<your-worker>.workers.dev/?url=')
```

Live cams attempt the CDN stream directly and fall back to the cam's still
image if the CDN refuses cross-origin playback. For bullet-proof cams and
rewind, run `node server.js` on any Node host instead — the proxy makes
every stream work.

## Features

- **Every Surfline spot** — search by name, browse the world **map** (zoom in
  and spots load per-viewport, tinted by current rating), or use *near me*.
- **Live cams** — HLS playback with snapshot-to-PNG and fullscreen.
- **Cam rewind** — scrub back through the archive in 10-minute clips across
  the past 5 days: previous/next clip, ±10 s, 0.5–8× speed, download.
- **Forecast timeline** — 6 days hourly. Drag to pan, pinch (or ctrl+scroll,
  or double-tap) to zoom, tap to set the time cursor, drag the mini-rail to
  scrub the whole range, or press play and watch conditions roll through at
  1–4×. Day chips jump straight to a morning.
- **Paperwhite themes** — a warm paper light mode and a charcoal dark mode
  (auto-follows the system, one-tap override).
- **Units** — ft/m, mph/kts/km/h, °F/°C.
- **Favorites & recents** — stored locally, shown with live conditions.
- **Installable PWA** — the app shell and your last-viewed forecasts work
  offline; anything unreachable degrades to clearly-labeled sample data
  rather than a broken page.
- **Keyboard-first on desktop** — `space` play, `←/→` scrub, `[`/`]` days,
  `+/−` zoom, `n` now, `f` favorite, `/` search, `m` map, `t` theme.
- Shareable URLs — the selected time (`?t=`) and map position travel in the
  link.

## How it talks to Surfline

Surfline has no official public API. Paperbreak reads the same JSON
endpoints their site uses (`services.surfline.com/kbyg/...`), documented by
the community over the years:

| Endpoint | Used for |
|---|---|
| `/kbyg/spots/details` | spot name, location, cameras |
| `/kbyg/spots/forecasts/{wave,rating,wind,tides,weather,sunlight}` | the charts |
| `/kbyg/mapview` | spots in a map viewport |
| `/search/site` | spot search |

Free-tier limits apply (6 forecast days, hourly). Premium-only cams and the
16-day outlook require a Surfline subscription and are **not** accessed or
circumvented — premium cams fall back to the public still image. Rewind
clips are fetched only where Surfline's CDN serves them without auth.

These endpoints can change or disappear at any time; when they do, every
layer falls back gracefully (memory cache → session cache → generated demo
data, always labeled as such in the UI).

Please be gentle: the server memoizes API responses for 60 s specifically so
a browser full of tabs doesn't hammer Surfline. This project is for
personal, non-commercial use and is not affiliated with or endorsed by
Surfline. Surf data can be wrong — look at the ocean before you trust it.

## Project layout

```
server.js                 static files + /api proxy + /proxy media passthrough
public/
  index.html  css/main.css        shell + paperwhite design system
  js/main.js  router.js  state.js api.js  demo.js  units.js  format.js
  js/views/   home.js  spot.js  map.js
  js/components/ search.js  charts.js  cam.js  sheet.js
  sw.js  manifest.webmanifest  icons/
  vendor/     hls.js 1.6 (light), Leaflet 1.9 — vendored, no CDN at runtime
```
