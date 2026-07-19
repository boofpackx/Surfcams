import { route, startRouter, navigate } from './router.js';
import { renderHome } from './views/home.js';
import { renderSpot } from './views/spot.js';
import { renderMap } from './views/map.js';
import { openSettings } from './components/sheet.js';
import { applyTheme, cycleTheme, on } from './state.js';
import { apiDown } from './api.js';

applyTheme();

route('', renderHome);
route('spot/:id', renderSpot);
route('map', renderMap);
startRouter();

// ---------------------------------------------------------------- topbar
document.getElementById('nav-theme').addEventListener('click', cycleTheme);
document.getElementById('nav-settings').addEventListener('click', openSettings);
document.getElementById('nav-search').addEventListener('click', () => {
  // The home hero owns search — jump there and focus it.
  if (location.hash.replace(/^#\/?/, '') !== '') navigate([], {});
  setTimeout(() => document.querySelector('.searchbox input')?.focus(), 80);
});

// ------------------------------------------------------- offline banner
const note = document.getElementById('offline-note');
function syncNote() {
  const offline = !navigator.onLine;
  const down = apiDown;
  if (offline) note.textContent = 'Offline — showing cached or sample data.';
  else if (down) note.textContent = 'Surfline API unreachable — showing cached or sample data.';
  note.hidden = !(offline || down);
}
on('apidown', syncNote);
addEventListener('online', syncNote);
addEventListener('offline', syncNote);
syncNote();

// ------------------------------------------------------ global shortcuts
document.addEventListener('keydown', (e) => {
  if (e.target.matches('input, textarea, select') || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === '/') {
    e.preventDefault();
    document.getElementById('nav-search').click();
  } else if (e.key === 'm' || e.key === 'M') {
    navigate(['map']);
  } else if (e.key === 't' || e.key === 'T') {
    cycleTheme();
  }
});

// -------------------------------------------------------- service worker
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => { /* fine without */ });
  });
}
