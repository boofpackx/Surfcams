// Forecast chart stack: hand-rolled SVG panels (surf+rating, wind, tide, temp)
// sharing one zoomable, pannable, scrubbable time axis.
//
// Interactions
//   drag / swipe horizontally   pan
//   pinch, ctrl+wheel, dblclick zoom (12h … full forecast)
//   tap                         move the time cursor
//   rail drag                   scrub across the whole forecast
//   play                        animate the cursor through time

import { fmtHour, fmtDayShort, startOfSpotDay, ratingColor, compass } from '../format.js';
import { heightVal, speedFromKts } from '../units.js';
import { settings } from '../state.js';

const MIN_SPAN = 12 * 3600;

// ------------------------------------------------------------------ timeline
export class Timeline {
  constructor(start, end, utcOffset) {
    this.start = start; this.end = end; this.off = utcOffset;
    this.t0 = start; this.t1 = Math.min(end, start + 2.5 * 86400);
    this.cursor = Math.max(start, Math.min(end, Date.now() / 1000));
    this.playing = false;
    this.speed = 1;                // multiplier on base rate (2 fc-hours / s)
    this._view = new Set(); this._cur = new Set(); this._play = new Set();
    this._raf = null; this._lastTick = 0;
  }
  onView(fn) { this._view.add(fn); return () => this._view.delete(fn); }
  onCursor(fn) { this._cur.add(fn); return () => this._cur.delete(fn); }
  onPlayState(fn) { this._play.add(fn); return () => this._play.delete(fn); }

  setView(t0, t1) {
    let span = Math.max(MIN_SPAN, Math.min(t1 - t0, this.end - this.start));
    t0 = Math.max(this.start, Math.min(t0, this.end - span));
    this.t0 = t0; this.t1 = t0 + span;
    this._view.forEach((f) => f(this));
  }
  panBy(dt) { this.setView(this.t0 + dt, this.t1 + dt); }
  zoom(factor, centerT = (this.t0 + this.t1) / 2) {
    const span = (this.t1 - this.t0) / factor;
    const k = (centerT - this.t0) / (this.t1 - this.t0);
    this.setView(centerT - span * k, centerT - span * k + span);
  }
  setCursor(t, { follow = true } = {}) {
    this.cursor = Math.max(this.start, Math.min(this.end, t));
    if (follow) {
      const span = this.t1 - this.t0;
      if (this.cursor > this.t1 - span * 0.05) this.setView(this.cursor - span * 0.2, this.cursor - span * 0.2 + span);
      else if (this.cursor < this.t0 + span * 0.02) this.setView(this.cursor - span * 0.5, this.cursor - span * 0.5 + span);
    }
    this._cur.forEach((f) => f(this));
  }
  goNow() {
    const now = Date.now() / 1000;
    const span = this.t1 - this.t0;
    this.setView(now - span * 0.25, now - span * 0.25 + span);
    this.setCursor(now, { follow: false });
  }
  jumpDay(dir) {
    const day = startOfSpotDay(this.cursor, this.off) + dir * 86400 + 8 * 3600; // 8am
    this.setCursor(Math.max(this.start, Math.min(this.end - 1, day)));
  }
  play() {
    if (this.playing) return;
    this.playing = true; this._lastTick = performance.now();
    this._play.forEach((f) => f(true));
    const step = (now) => {
      if (!this.playing) return;
      const dt = (now - this._lastTick) / 1000;
      this._lastTick = now;
      const next = this.cursor + dt * 7200 * this.speed;
      if (next >= this.end) { this.setCursor(this.end); this.pause(); return; }
      this.setCursor(next);
      this._raf = requestAnimationFrame(step);
    };
    this._raf = requestAnimationFrame(step);
  }
  pause() {
    this.playing = false;
    if (this._raf) cancelAnimationFrame(this._raf);
    this._play.forEach((f) => f(false));
  }
  toggle() { this.playing ? this.pause() : this.play(); }
}

// ----------------------------------------------------------------- helpers
export function nearest(arr, t, tolSec = 5400) {
  if (!arr || !arr.length) return null;
  let lo = 0, hi = arr.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].timestamp < t) lo = mid + 1; else hi = mid;
  }
  const cand = [arr[lo], arr[lo - 1]].filter(Boolean);
  const best = cand.reduce((a, b) => (Math.abs(a.timestamp - t) <= Math.abs(b.timestamp - t) ? a : b));
  return Math.abs(best.timestamp - t) <= tolSec ? best : null;
}

function niceStep(maxVal, targetTicks = 3) {
  const raw = maxVal / targetTicks;
  const pow = 10 ** Math.floor(Math.log10(raw || 1));
  for (const m of [1, 2, 2.5, 5, 10]) if (raw <= m * pow) return m * pow;
  return 10 * pow;
}

function nightBands(sunlight, start, end) {
  if (!sunlight || !sunlight.length) return [];
  const bands = [];
  const sl = [...sunlight].sort((a, b) => (a.midnight || a.sunrise) - (b.midnight || b.sunrise));
  // band before first sunrise
  if (sl[0].sunrise > start) bands.push([start, sl[0].sunrise]);
  for (let i = 0; i < sl.length; i++) {
    const to = i + 1 < sl.length ? sl[i + 1].sunrise : end;
    if (sl[i].sunset < to) bands.push([sl[i].sunset, to]);
  }
  return bands.filter(([a, b]) => b > start && a < end);
}

// ------------------------------------------------------------- chart stack
export function createChartStack(container, data, tl) {
  const off = data.utcOffset;
  container.innerHTML = '';
  const panels = [];
  const nights = nightBands(data.sunlight, tl.start, tl.end);

  function addPanel(title, height, draw, headExtra = '') {
    const block = document.createElement('div');
    block.className = 'chart-block';
    block.innerHTML = `
      <div class="ch-head"><span class="label">${title}</span><span class="small muted ch-cur">${headExtra}</span></div>
      <div class="chart-svg-wrap"><svg height="${height}" preserveAspectRatio="none" aria-hidden="true"></svg></div>`;
    container.appendChild(block);
    const svg = block.querySelector('svg');
    const panel = { svg, height, draw, block, wrap: block.querySelector('.chart-svg-wrap') };
    panels.push(panel);
    return panel;
  }

  let W = Math.max(280, container.clientWidth || 320);

  const X = (t) => ((t - tl.t0) / (tl.t1 - tl.t0)) * W;

  function deco(h, { cursorTop = 0 } = {}) {
    // night bands + day separators + now + cursor, shared by every panel
    let s = '';
    for (const [a, b] of nights) {
      const x1 = Math.max(0, X(a)), x2 = Math.min(W, X(b));
      if (x2 > 0 && x1 < W) s += `<rect x="${x1.toFixed(1)}" y="0" width="${(x2 - x1).toFixed(1)}" height="${h}" fill="var(--night)"/>`;
    }
    for (let d = startOfSpotDay(tl.t0, off); d <= tl.t1; d += 86400) {
      const x = X(d);
      if (x > 0 && x < W) s += `<line x1="${x.toFixed(1)}" y1="0" x2="${x.toFixed(1)}" y2="${h}" stroke="var(--line-soft)"/>`;
    }
    const now = Date.now() / 1000;
    if (now > tl.t0 && now < tl.t1) {
      s += `<line x1="${X(now).toFixed(1)}" y1="0" x2="${X(now).toFixed(1)}" y2="${h}" stroke="var(--accent)" stroke-width="1.3" opacity=".75"/>`;
    }
    const cx = X(tl.cursor);
    if (cx >= 0 && cx <= W) {
      s += `<line x1="${cx.toFixed(1)}" y1="${cursorTop}" x2="${cx.toFixed(1)}" y2="${h}" stroke="var(--ink)" stroke-width="1" stroke-dasharray="2 3" opacity=".8"/>`;
    }
    return s;
  }

  // ---- axis strip -------------------------------------------------------
  addPanel('', 34, (svg) => {
    const h = 34;
    let s = deco(h);
    const spanH = (tl.t1 - tl.t0) / 3600;
    const tickEvery = spanH <= 30 ? 3 : spanH <= 78 ? 6 : spanH <= 200 ? 12 : 24;
    const firstDay = startOfSpotDay(tl.t0, off);
    for (let t = firstDay; t <= tl.t1; t += tickEvery * 3600) {
      if (t < tl.t0) continue;
      const x = X(t);
      const isMid = (t - firstDay) % 86400 === 0;
      if (!isMid && tickEvery < 24 && x > 14 && x < W - 14) {
        s += `<text x="${x.toFixed(1)}" y="29" font-size="9.5" fill="var(--ink-faint)" text-anchor="middle">${fmtHour(t, off)}</text>`;
      }
    }
    for (let d = firstDay; d < tl.t1; d += 86400) {
      const a = Math.max(tl.t0, d), b = Math.min(tl.t1, d + 86400);
      if (b - a < 3 * 3600) continue;
      const { day, date } = fmtDayShort(d + 43200, off);
      s += `<text x="${(X((a + b) / 2)).toFixed(1)}" y="${tickEvery >= 24 ? 21 : 12}" font-size="10.5" font-weight="650" fill="var(--ink-soft)" text-anchor="middle">${day} ${date}</text>`;
    }
    svg.innerHTML = s;
  });

  // ---- surf + rating ----------------------------------------------------
  const surfMaxRaw = Math.max(2, ...data.wave.map((w) => (w.surf?.max || 0)));
  addPanel('Surf', 132, (svg, headEl) => {
    const h = 118, pad = 4, ribbonY = 122;
    const yMax = surfMaxRaw * 1.12;
    const Y = (v) => h - (v / yMax) * (h - pad);
    let s = deco(132);

    // horizontal grid in display units
    const stepDisp = niceStep(heightVal(yMax));
    const perDisp = heightVal(1);
    for (let v = stepDisp; v / perDisp < yMax; v += stepDisp) {
      const y = Y(v / perDisp);
      s += `<line x1="0" y1="${y.toFixed(1)}" x2="${W}" y2="${y.toFixed(1)}" stroke="var(--line-soft)" stroke-dasharray="1 4"/>`;
      s += `<text x="${W - 3}" y="${(y - 3).toFixed(1)}" font-size="9" fill="var(--ink-faint)" text-anchor="end">${stepDisp % 1 ? (v).toFixed(1) : v} ${settings.height}</text>`;
    }

    const visible = data.wave.filter((w) => w.timestamp >= tl.t0 - 3600 && w.timestamp <= tl.t1 + 3600);
    const barW = W / ((tl.t1 - tl.t0) / 3600);

    if (barW >= 3) {
      for (const w of visible) {
        const x = X(w.timestamp), bw = Math.max(1.5, barW - Math.max(1, barW * 0.18));
        const yMaxPix = Y(w.surf.max), yMinPix = Y(w.surf.min);
        s += `<rect x="${x.toFixed(1)}" y="${yMaxPix.toFixed(1)}" width="${bw.toFixed(1)}" height="${(h - yMaxPix).toFixed(1)}" fill="var(--ink)" opacity=".16" rx="1"/>`;
        s += `<rect x="${x.toFixed(1)}" y="${yMinPix.toFixed(1)}" width="${bw.toFixed(1)}" height="${(h - yMinPix).toFixed(1)}" fill="var(--ink)" opacity=".26" rx="1"/>`;
        if (w.surf.plus) s += `<text x="${(x + bw / 2).toFixed(1)}" y="${(yMaxPix - 3).toFixed(1)}" font-size="9" fill="var(--ink-soft)" text-anchor="middle">+</text>`;
      }
    } else {
      // zoomed out: min–max band
      const pts = visible;
      if (pts.length > 1) {
        const top = pts.map((w) => `${X(w.timestamp).toFixed(1)},${Y(w.surf.max).toFixed(1)}`).join(' ');
        const bot = [...pts].reverse().map((w) => `${X(w.timestamp).toFixed(1)},${Y(w.surf.min).toFixed(1)}`).join(' ');
        s += `<polygon points="${top} ${bot}" fill="var(--ink)" opacity=".18"/>`;
        s += `<polyline points="${top}" fill="none" stroke="var(--ink)" stroke-width="1.3" opacity=".55"/>`;
      }
    }

    // rating ribbon
    if (data.rating && data.rating.length) {
      const rvis = data.rating.filter((r) => r.timestamp >= tl.t0 - 3600 && r.timestamp <= tl.t1 + 3600);
      const rw = Math.max(1, W / ((tl.t1 - tl.t0) / 3600));
      for (const r of rvis) {
        s += `<rect x="${X(r.timestamp).toFixed(1)}" y="${ribbonY}" width="${(rw + 0.5).toFixed(1)}" height="6" fill="${ratingColor(r.rating?.key)}" opacity=".9"/>`;
      }
    }
    svg.innerHTML = s;
  });

  // ---- wind ---------------------------------------------------------------
  if (data.wind && data.wind.length) {
    const windMax = Math.max(10, ...data.wind.map((w) => w.gust || w.speed || 0));
    addPanel('Wind', 84, (svg) => {
      const h = 84, arrowY = 13;
      const Y = (v) => h - (v / (windMax * 1.15)) * (h - 26);
      let s = deco(h);
      const visible = data.wind.filter((w) => w.timestamp >= tl.t0 - 3600 && w.timestamp <= tl.t1 + 3600);
      const barW = W / ((tl.t1 - tl.t0) / 3600);
      const typeColor = (w) => {
        const t = String(w.directionType || '').toUpperCase();
        return t.startsWith('OFF') ? 'var(--wind-off)' : t.startsWith('ON') ? 'var(--wind-on)' : 'var(--wind-cross)';
      };

      if (barW >= 3) {
        for (const w of visible) {
          const x = X(w.timestamp), bw = Math.max(1.5, barW - Math.max(1, barW * 0.18));
          const y = Y(w.speed);
          s += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${(h - y).toFixed(1)}" fill="${typeColor(w)}" opacity=".38" rx="1"/>`;
          if (w.gust) s += `<line x1="${x.toFixed(1)}" y1="${Y(w.gust).toFixed(1)}" x2="${(x + bw).toFixed(1)}" y2="${Y(w.gust).toFixed(1)}" stroke="${typeColor(w)}" stroke-width="1" opacity=".8"/>`;
        }
      } else if (visible.length > 1) {
        const line = visible.map((w) => `${X(w.timestamp).toFixed(1)},${Y(w.speed).toFixed(1)}`).join(' ');
        s += `<polyline points="${line}" fill="none" stroke="var(--wind-cross)" stroke-width="1.3"/>`;
      }

      // direction arrows, spaced ≥ 28px
      const everyH = Math.max(1, Math.ceil(28 / Math.max(barW, 0.001)));
      for (let i = 0; i < visible.length; i += everyH) {
        const w = visible[i];
        const x = X(w.timestamp) + (barW >= 3 ? barW / 2 : 0);
        if (x < 8 || x > W - 8) continue;
        const rot = ((w.direction ?? 0) + 180) % 360; // point where it blows TO
        s += `<g transform="translate(${x.toFixed(1)},${arrowY}) rotate(${rot})" opacity=".9">
          <line x1="0" y1="5" x2="0" y2="-5" stroke="${typeColor(w)}" stroke-width="1.5"/>
          <path d="M-3-1L0-5L3-1" fill="none" stroke="${typeColor(w)}" stroke-width="1.5"/>
        </g>`;
      }
      svg.innerHTML = s;
    });
  }

  // ---- tide ---------------------------------------------------------------
  if (data.tides && data.tides.length) {
    const tMin = Math.min(...data.tides.map((t) => t.height));
    const tMax = Math.max(...data.tides.map((t) => t.height));
    addPanel('Tide', 92, (svg) => {
      const h = 92, padT = 16, padB = 8;
      const Y = (v) => padT + (1 - (v - tMin) / Math.max(0.5, tMax - tMin)) * (h - padT - padB);
      let s = deco(h);
      const vis = data.tides.filter((t) => t.timestamp >= tl.t0 - 7200 && t.timestamp <= tl.t1 + 7200);
      if (vis.length > 1) {
        let d = `M${X(vis[0].timestamp).toFixed(1)},${Y(vis[0].height).toFixed(1)}`;
        for (let i = 1; i < vis.length; i++) {
          const p0 = vis[Math.max(0, i - 1)], p1 = vis[i];
          const x0 = X(p0.timestamp), x1 = X(p1.timestamp);
          const cx = (x0 + x1) / 2;
          d += ` C${cx.toFixed(1)},${Y(p0.height).toFixed(1)} ${cx.toFixed(1)},${Y(p1.height).toFixed(1)} ${x1.toFixed(1)},${Y(p1.height).toFixed(1)}`;
        }
        s += `<path d="${d} L${X(vis[vis.length - 1].timestamp).toFixed(1)},${h} L${X(vis[0].timestamp).toFixed(1)},${h} Z" fill="var(--accent)" opacity=".10"/>`;
        s += `<path d="${d}" fill="none" stroke="var(--accent)" stroke-width="1.5"/>`;
        if (tMin < 0) {
          s += `<line x1="0" y1="${Y(0).toFixed(1)}" x2="${W}" y2="${Y(0).toFixed(1)}" stroke="var(--line)" stroke-dasharray="2 3"/>`;
        }
        for (const t of vis) {
          if (t.type !== 'HIGH' && t.type !== 'LOW') continue;
          const x = X(t.timestamp), y = Y(t.height);
          if (x < 0 || x > W) continue;
          s += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2.4" fill="var(--accent)"/>`;
          const above = t.type === 'HIGH';
          const ly = Math.max(9, Math.min(h - 3, above ? y - 7 : y + 14));
          s += `<text x="${x.toFixed(1)}" y="${ly.toFixed(1)}" font-size="9.5" fill="var(--ink-soft)" text-anchor="middle">${heightVal(t.height).toFixed(1)}${settings.height} ${fmtHour(t.timestamp, off)}</text>`;
        }
      }
      svg.innerHTML = s;
    });
  }

  // ---- air temp -----------------------------------------------------------
  if (data.weather && data.weather.length) {
    const temps = data.weather.map((w) => w.temperature);
    const wMin = Math.min(...temps), wMax = Math.max(...temps);
    addPanel('Air', 52, (svg) => {
      const h = 52;
      const Y = (v) => 10 + (1 - (v - wMin) / Math.max(2, wMax - wMin)) * (h - 20);
      let s = deco(h);
      const vis = data.weather.filter((w) => w.timestamp >= tl.t0 - 3600 && w.timestamp <= tl.t1 + 3600);
      if (vis.length > 1) {
        const line = vis.map((w) => `${X(w.timestamp).toFixed(1)},${Y(w.temperature).toFixed(1)}`).join(' ');
        s += `<polyline points="${line}" fill="none" stroke="var(--ink-soft)" stroke-width="1.3" opacity=".8"/>`;
      }
      svg.innerHTML = s;
    });
  }

  // ------------------------------------------------------------- rendering
  let rafPending = false;
  function render() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      W = Math.max(280, container.clientWidth || 320);
      for (const p of panels) {
        p.svg.setAttribute('viewBox', `0 0 ${W} ${p.height}`);
        p.svg.setAttribute('width', W);
        p.draw(p.svg);
      }
    });
  }
  render();

  const ro = new ResizeObserver(render);
  ro.observe(container);
  const offView = tl.onView(render);
  const offCur = tl.onCursor(render);

  // ----------------------------------------------------------- interaction
  const detachers = [];
  for (const p of panels) {
    detachers.push(attachGestures(p.wrap, tl, () => W));
  }

  return {
    render,
    destroy() {
      ro.disconnect(); offView(); offCur();
      detachers.forEach((d) => d());
      tl.pause();
    },
  };
}

// Pointer gestures for pan / pinch-zoom / tap-to-scrub on a chart element.
function attachGestures(elem, tl, getW) {
  const pointers = new Map();
  let startView = null, startDist = 0, startCenterT = 0, moved = false, downAt = 0;

  const tAt = (clientX) => {
    const r = elem.getBoundingClientRect();
    return tl.t0 + ((clientX - r.left) / Math.max(1, r.width)) * (tl.t1 - tl.t0);
  };

  function onDown(e) {
    elem.setPointerCapture?.(e.pointerId);
    pointers.set(e.pointerId, e);
    moved = false; downAt = performance.now();
    startView = { t0: tl.t0, t1: tl.t1 };
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      startDist = Math.abs(a.clientX - b.clientX) || 1;
      startCenterT = tAt((a.clientX + b.clientX) / 2);
    }
  }
  function onMove(e) {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, e);
    const r = elem.getBoundingClientRect();
    if (pointers.size === 2) {
      e.preventDefault();
      const [a, b] = [...pointers.values()];
      const dist = Math.abs(a.clientX - b.clientX) || 1;
      const span0 = startView.t1 - startView.t0;
      const span = span0 * (startDist / dist);
      const centerX = (a.clientX + b.clientX) / 2 - r.left;
      const k = centerX / Math.max(1, r.width);
      tl.setView(startCenterT - span * k, startCenterT - span * k + span);
      moved = true;
    }
  }
  // Single-pointer pan needs the original down position:
  let down1 = null;
  function onDown1(e) { if (pointers.size === 1) down1 = { x: e.clientX, t0: tl.t0, t1: tl.t1 }; }
  function onMove1(e) {
    if (!down1 || pointers.size !== 1 || !pointers.has(e.pointerId)) return;
    const r = elem.getBoundingClientRect();
    const dx = e.clientX - down1.x;
    if (Math.abs(dx) > 6) moved = true;
    if (moved) {
      const dt = (-dx / Math.max(1, r.width)) * (down1.t1 - down1.t0);
      tl.setView(down1.t0 + dt, down1.t1 + dt);
    }
  }
  function onUp(e) {
    pointers.delete(e.pointerId);
    if (pointers.size === 1) {
      // pinch ended with one finger still down — re-anchor the pan
      const rest = [...pointers.values()][0];
      down1 = { x: rest.clientX, t0: tl.t0, t1: tl.t1 };
    } else if (pointers.size === 0) {
      if (!moved && performance.now() - downAt < 400) {
        tl.setCursor(tAt(e.clientX), { follow: false });
      }
      down1 = null;
    }
  }
  function onWheel(e) {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      tl.zoom(e.deltaY < 0 ? 1.18 : 1 / 1.18, tAt(e.clientX));
    } else if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      e.preventDefault();
      tl.panBy((e.deltaX / Math.max(1, elem.clientWidth)) * (tl.t1 - tl.t0));
    }
  }
  function onDbl(e) { tl.zoom(1.8, tAt(e.clientX)); }

  elem.addEventListener('pointerdown', onDown);
  elem.addEventListener('pointerdown', onDown1);
  elem.addEventListener('pointermove', onMove);
  elem.addEventListener('pointermove', onMove1);
  elem.addEventListener('pointerup', onUp);
  elem.addEventListener('pointercancel', onUp);
  elem.addEventListener('wheel', onWheel, { passive: false });
  elem.addEventListener('dblclick', onDbl);
  return () => {
    elem.removeEventListener('pointerdown', onDown);
    elem.removeEventListener('pointerdown', onDown1);
    elem.removeEventListener('pointermove', onMove);
    elem.removeEventListener('pointermove', onMove1);
    elem.removeEventListener('pointerup', onUp);
    elem.removeEventListener('pointercancel', onUp);
    elem.removeEventListener('wheel', onWheel);
    elem.removeEventListener('dblclick', onDbl);
  };
}

// ------------------------------------------------------------------- rail
// Full-forecast minimap: silhouette of wave height, viewport window, cursor.
export function createRail(elem, data, tl) {
  const canvas = document.createElement('canvas');
  elem.appendChild(canvas);
  const ctx = canvas.getContext('2d');
  const nights = nightBands(data.sunlight, tl.start, tl.end);

  const css = () => getComputedStyle(document.documentElement);

  function draw() {
    const r = elem.getBoundingClientRect();
    const dpr = devicePixelRatio || 1;
    if (canvas.width !== Math.round(r.width * dpr)) {
      canvas.width = Math.round(r.width * dpr);
      canvas.height = Math.round(r.height * dpr);
    }
    const Wp = r.width, Hp = r.height;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, Wp, Hp);
    const st = css();
    const X = (t) => ((t - tl.start) / (tl.end - tl.start)) * Wp;

    // nights
    ctx.fillStyle = st.getPropertyValue('--night');
    for (const [a, b] of nights) ctx.fillRect(X(a), 0, X(b) - X(a), Hp);

    // wave silhouette
    const maxH = Math.max(2, ...data.wave.map((w) => w.surf?.max || 0)) * 1.15;
    ctx.beginPath();
    ctx.moveTo(0, Hp);
    for (const w of data.wave) ctx.lineTo(X(w.timestamp), Hp - ((w.surf?.max || 0) / maxH) * (Hp - 6));
    ctx.lineTo(Wp, Hp);
    ctx.closePath();
    ctx.fillStyle = st.getPropertyValue('--ink-faint');
    ctx.globalAlpha = 0.4;
    ctx.fill();
    ctx.globalAlpha = 1;

    // day ticks
    ctx.strokeStyle = st.getPropertyValue('--line');
    ctx.beginPath();
    for (let d = startOfSpotDay(tl.start, tl.off) + 86400; d < tl.end; d += 86400) {
      ctx.moveTo(X(d), 0); ctx.lineTo(X(d), Hp);
    }
    ctx.stroke();

    // viewport window
    ctx.strokeStyle = st.getPropertyValue('--ink-soft');
    ctx.lineWidth = 1.2;
    ctx.strokeRect(X(tl.t0) + 0.5, 0.5, X(tl.t1) - X(tl.t0) - 1, Hp - 1);

    // now + cursor
    const now = Date.now() / 1000;
    if (now > tl.start && now < tl.end) {
      ctx.strokeStyle = st.getPropertyValue('--accent');
      ctx.beginPath(); ctx.moveTo(X(now), 0); ctx.lineTo(X(now), Hp); ctx.stroke();
    }
    ctx.strokeStyle = st.getPropertyValue('--ink');
    ctx.lineWidth = 1.6;
    ctx.beginPath(); ctx.moveTo(X(tl.cursor), 0); ctx.lineTo(X(tl.cursor), Hp); ctx.stroke();
  }

  let scrubbing = false;
  const scrubTo = (clientX) => {
    const r = elem.getBoundingClientRect();
    const t = tl.start + ((clientX - r.left) / Math.max(1, r.width)) * (tl.end - tl.start);
    tl.setCursor(t);
  };
  const onDown = (e) => { scrubbing = true; elem.setPointerCapture?.(e.pointerId); scrubTo(e.clientX); };
  const onMove = (e) => { if (scrubbing) scrubTo(e.clientX); };
  const onUp = () => { scrubbing = false; };
  elem.addEventListener('pointerdown', onDown);
  elem.addEventListener('pointermove', onMove);
  elem.addEventListener('pointerup', onUp);
  elem.addEventListener('pointercancel', onUp);

  const offV = tl.onView(draw), offC = tl.onCursor(draw);
  const ro = new ResizeObserver(draw);
  ro.observe(elem);
  draw();

  return {
    draw,
    destroy() {
      offV(); offC(); ro.disconnect();
      elem.removeEventListener('pointerdown', onDown);
      elem.removeEventListener('pointermove', onMove);
      elem.removeEventListener('pointerup', onUp);
      elem.removeEventListener('pointercancel', onUp);
      canvas.remove();
    },
  };
}
