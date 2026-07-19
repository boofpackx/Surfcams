// Bottom sheet — used for settings.

import { el, esc } from '../format.js';
import { settings, setSetting, clearAllData } from '../state.js';

export function openSettings() {
  const root = document.getElementById('sheet-root');
  root.innerHTML = `
    <div class="sheet-backdrop"></div>
    <div class="sheet" role="dialog" aria-modal="true" aria-label="Settings">
      <div class="grab"></div>
      <h2>Settings</h2>

      <div class="set-row">
        <span>Theme</span>
        <span class="seg" data-set="theme">
          <button data-v="auto">Auto</button><button data-v="light">Light</button><button data-v="dark">Dark</button>
        </span>
      </div>
      <div class="set-row">
        <span>Wave height</span>
        <span class="seg" data-set="height">
          <button data-v="ft">ft</button><button data-v="m">m</button>
        </span>
      </div>
      <div class="set-row">
        <span>Wind speed</span>
        <span class="seg" data-set="speed">
          <button data-v="mph">mph</button><button data-v="kts">kts</button><button data-v="kph">km/h</button>
        </span>
      </div>
      <div class="set-row">
        <span>Temperature</span>
        <span class="seg" data-set="temp">
          <button data-v="F">°F</button><button data-v="C">°C</button>
        </span>
      </div>

      <div class="section">
        <div class="section-head"><span class="label">Keyboard</span></div>
        <div class="kbd-list">
          <div><kbd>space</kbd> play / pause forecast</div>
          <div><kbd>←</kbd><kbd>→</kbd> scrub 3 h (<kbd>shift</kbd> for 1 h)</div>
          <div><kbd>[</kbd><kbd>]</kbd> previous / next day</div>
          <div><kbd>+</kbd><kbd>−</kbd> zoom the timeline</div>
          <div><kbd>n</kbd> jump to now · <kbd>f</kbd> favorite</div>
          <div><kbd>/</kbd> search · <kbd>m</kbd> map · <kbd>t</kbd> theme</div>
        </div>
      </div>

      <div class="section">
        <div class="section-head"><span class="label">About</span></div>
        <p class="small muted" style="line-height:1.6">
          Paperbreak is an independent, minimalist reader for Surfline’s public
          forecast data — not affiliated with or endorsed by Surfline. Forecasts
          are the free 6-day tier; cams stream only where Surfline offers them
          free. Be kind to the ocean and to their servers.
        </p>
        <button class="chip" id="clear-data" style="margin-top:12px">Clear favorites &amp; settings</button>
      </div>
    </div>`;

  const close = () => { root.innerHTML = ''; document.removeEventListener('keydown', onEsc); };
  const onEsc = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onEsc);
  root.querySelector('.sheet-backdrop').addEventListener('click', close);

  const syncSegs = () => {
    root.querySelectorAll('.seg').forEach((seg) => {
      const key = seg.dataset.set;
      seg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === String(settings[key])));
    });
  };
  syncSegs();
  root.querySelectorAll('.seg button').forEach((b) => {
    b.addEventListener('click', () => {
      setSetting(b.closest('.seg').dataset.set, b.dataset.v);
      syncSegs();
    });
  });
  root.querySelector('#clear-data').addEventListener('click', () => {
    if (confirm('Clear all saved favorites and settings?')) clearAllData();
  });

  return close;
}
