// Time & misc formatting. All Surfline timestamps are unix seconds paired
// with a utcOffset (hours) for the spot — we render in *spot-local* time by
// shifting the epoch and reading UTC fields, so the forecast reads correctly
// no matter where the visitor is.

export function spotDate(ts, utcOffset = 0) {
  return new Date((ts + utcOffset * 3600) * 1000);
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function fmtHour(ts, off) {
  const d = spotDate(ts, off);
  let h = d.getUTCHours();
  const ap = h < 12 ? 'am' : 'pm';
  h = h % 12 || 12;
  const m = d.getUTCMinutes();
  return m ? `${h}:${String(m).padStart(2, '0')}${ap}` : `${h}${ap}`;
}

export function fmtDay(ts, off) {
  const d = spotDate(ts, off);
  return `${DAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

export function fmtDayShort(ts, off) {
  const d = spotDate(ts, off);
  return { day: DAYS[d.getUTCDay()], date: `${d.getUTCMonth() + 1}/${d.getUTCDate()}` };
}

export function fmtDayHour(ts, off) {
  return `${fmtDay(ts, off)} · ${fmtHour(ts, off)}`;
}

export function isSameSpotDay(a, b, off) {
  const da = spotDate(a, off), db = spotDate(b, off);
  return da.getUTCFullYear() === db.getUTCFullYear() &&
    da.getUTCMonth() === db.getUTCMonth() && da.getUTCDate() === db.getUTCDate();
}

// Start of the spot-local day containing ts, as a unix timestamp.
export function startOfSpotDay(ts, off) {
  const d = spotDate(ts, off);
  const localMidnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 1000;
  return localMidnight - off * 3600;
}

const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
export function compass(deg) {
  return COMPASS[Math.round(((deg % 360) + 360) % 360 / 22.5) % 16];
}

export const RATING_ORDER = [
  'FLAT', 'VERY_POOR', 'POOR', 'POOR_TO_FAIR', 'FAIR', 'FAIR_TO_GOOD',
  'GOOD', 'VERY_GOOD', 'GOOD_TO_EPIC', 'EPIC',
];
const RATING_LABEL = {
  FLAT: 'Flat', VERY_POOR: 'Very poor', POOR: 'Poor', POOR_TO_FAIR: 'Poor–fair',
  FAIR: 'Fair', FAIR_TO_GOOD: 'Fair–good', GOOD: 'Good', VERY_GOOD: 'Very good',
  GOOD_TO_EPIC: 'Good–epic', EPIC: 'Epic', NONE: '—',
};
const RATING_VAR = {
  FLAT: '--r-flat', VERY_POOR: '--r-vpoor', POOR: '--r-poor', POOR_TO_FAIR: '--r-pfair',
  FAIR: '--r-fair', FAIR_TO_GOOD: '--r-fgood', GOOD: '--r-good', VERY_GOOD: '--r-vgood',
  GOOD_TO_EPIC: '--r-epic', EPIC: '--r-epic',
};
export function ratingLabel(key) { return RATING_LABEL[key] || (key ? String(key).toLowerCase() : '—'); }
export function ratingColor(key) { return `var(${RATING_VAR[key] || '--r-flat'})`; }

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

export function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

export function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

export function toast(msg, ms = 2600) {
  const root = document.getElementById('toast-root');
  const n = el(`<div class="toast">${esc(msg)}</div>`);
  root.appendChild(n);
  setTimeout(() => { n.style.opacity = '0'; n.style.transition = 'opacity .3s'; }, ms - 300);
  setTimeout(() => n.remove(), ms);
}
