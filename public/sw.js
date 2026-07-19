// Paperbreak service worker: app shell cache-first, same-origin API proxy
// network-first with cache fallback (so the last forecast survives going
// offline). Media (/proxy) is never cached. All paths are resolved against
// the worker's own directory, so this works at a domain root *and* under a
// subpath (GitHub Pages).

const VERSION = 'pb-v2';
const BASE = new URL('./', self.location).pathname; // '/' or '/Surfcams/'
const SHELL = [
  '', 'index.html', 'css/main.css', 'manifest.webmanifest', 'icons/icon.svg',
  'js/main.js', 'js/router.js', 'js/state.js', 'js/api.js', 'js/demo.js',
  'js/units.js', 'js/format.js',
  'js/views/home.js', 'js/views/spot.js', 'js/views/map.js',
  'js/components/search.js', 'js/components/charts.js', 'js/components/cam.js',
  'js/components/sheet.js',
  'vendor/hls.min.js', 'vendor/leaflet/leaflet.js', 'vendor/leaflet/leaflet.css',
].map((p) => BASE + p);

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname === BASE + 'proxy' || url.pathname === '/proxy') return; // media passthrough

  if (url.pathname.startsWith('/api/')) {
    // network-first, fall back to last good response
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(VERSION).then((c) => c.put(e.request, copy));
          }
          return res;
        })
        .catch(() => caches.match(e.request).then((hit) => hit || Response.error())),
    );
    return;
  }

  // shell: cache-first, refresh in background
  e.respondWith(
    caches.match(e.request).then((hit) => {
      const refresh = fetch(e.request)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(VERSION).then((c) => c.put(e.request, copy));
          }
          return res;
        })
        .catch(() => hit);
      return hit || refresh;
    }),
  );
});
