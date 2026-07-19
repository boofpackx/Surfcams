// Settings, favorites and recents — persisted to localStorage, with a tiny
// pub/sub so views can react to changes.

const SETTINGS_KEY = 'pb:settings';
const FAVS_KEY = 'pb:favs';
const RECENTS_KEY = 'pb:recents';

const DEFAULTS = {
  theme: 'auto',            // auto | light | dark
  height: 'ft',             // ft | m
  speed: 'mph',             // mph | kts | kph
  temp: 'F',                // F | C
};

function load(key, fallback) {
  try {
    const v = JSON.parse(localStorage.getItem(key));
    return v == null ? fallback : v;
  } catch { return fallback; }
}
function save(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode */ }
}

const listeners = new Map(); // event -> Set<fn>
export function on(event, fn) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(fn);
  return () => listeners.get(event).delete(fn);
}
export function emit(event, data) {
  (listeners.get(event) || []).forEach((fn) => { try { fn(data); } catch (e) { console.error(e); } });
}

// ---------------------------------------------------------------- settings
export const settings = { ...DEFAULTS, ...load(SETTINGS_KEY, {}) };

export function setSetting(key, value) {
  settings[key] = value;
  save(SETTINGS_KEY, settings);
  if (key === 'theme') applyTheme();
  emit('settings', { key, value });
}

export function applyTheme() {
  let t = settings.theme;
  if (t === 'auto') t = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  document.documentElement.dataset.theme = t;
  emit('theme', t);
}
matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => {
  if (settings.theme === 'auto') applyTheme();
});

export function cycleTheme() {
  // auto → (opposite of current) → back; simple two-state toggle that
  // remembers an explicit choice.
  const cur = document.documentElement.dataset.theme;
  setSetting('theme', cur === 'dark' ? 'light' : 'dark');
}

// --------------------------------------------------------------- favorites
export let favorites = load(FAVS_KEY, []); // [{id, name, sub}]

export function isFavorite(id) { return favorites.some((f) => f.id === id); }

export function toggleFavorite(spot) {
  if (isFavorite(spot.id)) favorites = favorites.filter((f) => f.id !== spot.id);
  else favorites = [...favorites, { id: spot.id, name: spot.name, sub: spot.sub || '' }];
  save(FAVS_KEY, favorites);
  emit('favorites', favorites);
  return isFavorite(spot.id);
}

// ----------------------------------------------------------------- recents
export let recents = load(RECENTS_KEY, []); // [{id, name, sub}]

export function pushRecent(spot) {
  recents = [{ id: spot.id, name: spot.name, sub: spot.sub || '' },
    ...recents.filter((r) => r.id !== spot.id)].slice(0, 8);
  save(RECENTS_KEY, recents);
}

export function clearAllData() {
  try {
    localStorage.removeItem(SETTINGS_KEY);
    localStorage.removeItem(FAVS_KEY);
    localStorage.removeItem(RECENTS_KEY);
  } catch { /* ignore */ }
  location.reload();
}
