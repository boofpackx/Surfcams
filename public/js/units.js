import { settings } from './state.js';

// Surfline returns surf heights in feet (associated.units.waveHeight === 'FT'),
// wind speed in kts... actually KBYG returns speed in the unit named in
// associated.units — we normalize everything to the raw unit the API declares
// and convert for display here. Callers pass the raw value + raw unit.

const M_PER_FT = 0.3048;

export function heightVal(ft) {
  return settings.height === 'm' ? ft * M_PER_FT : ft;
}
export function fmtHeight(ft, { unit = true, digits } = {}) {
  const v = heightVal(ft);
  const d = digits != null ? digits : (settings.height === 'm' ? 1 : 0);
  return `${round(v, d)}${unit ? ' ' + settings.height : ''}`;
}
export function fmtSurfRange(min, max, plus = false) {
  const u = settings.height;
  const [a, b] = [heightVal(min), heightVal(max)];
  const d = u === 'm' ? 1 : 0;
  return `${round(a, d)}–${round(b, d)}${plus ? '+' : ''} ${u}`;
}

const KTS_PER = { kts: 1, mph: 1.15078, kph: 1.852 };
export function speedFromKts(kts) { return kts * KTS_PER[settings.speed]; }
export function fmtSpeed(kts, { unit = true } = {}) {
  return `${Math.round(speedFromKts(kts))}${unit ? ' ' + settings.speed : ''}`;
}

export function tempFromF(f) { return settings.temp === 'C' ? (f - 32) * 5 / 9 : f; }
export function fmtTemp(f, { unit = true } = {}) {
  return `${Math.round(tempFromF(f))}°${unit ? settings.temp : ''}`;
}

function round(v, d) {
  const p = 10 ** d;
  const r = Math.round(v * p) / p;
  return d === 0 ? String(Math.round(r)) : r.toFixed(d).replace(/\.0$/, '');
}
