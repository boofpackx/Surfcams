// Spot search with debounce, keyboard navigation and graceful offline notes.
// attachSearch(rootEl) wires an input+results dropdown inside rootEl.

import { searchSpots } from '../api.js';
import { navigate } from '../router.js';
import { el, esc, debounce } from '../format.js';
import { recents } from '../state.js';

export function searchboxHTML(placeholder = 'Search any surf spot…') {
  return `
  <div class="searchbox" role="combobox" aria-expanded="false" aria-haspopup="listbox">
    <svg class="s-icon" viewBox="0 0 24 24"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l5 5"/></svg>
    <input type="search" placeholder="${esc(placeholder)}" autocomplete="off"
      autocapitalize="off" spellcheck="false" aria-label="Search surf spots" enterkeyhint="search">
    <button class="iconbtn s-clear" aria-label="Clear search" hidden>
      <svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>
    </button>
    <div class="search-results" role="listbox" hidden></div>
  </div>`;
}

export function attachSearch(root, { onPick } = {}) {
  const box = root.querySelector('.searchbox');
  const input = box.querySelector('input');
  const clearBtn = box.querySelector('.s-clear');
  const results = box.querySelector('.search-results');
  let items = [];
  let sel = -1;
  let openToken = 0;

  const pick = (spot) => {
    close();
    input.blur();
    if (onPick) onPick(spot);
    else navigate(['spot', spot.id], { name: spot.name });
  };

  function renderList(spots, { note } = {}) {
    items = spots;
    sel = -1;
    if (!spots.length && !note) { close(); return; }
    results.innerHTML =
      (note ? `<div class="sr-note">${esc(note)}</div>` : '') +
      spots.map((s, i) => `
        <button class="sr-item" role="option" data-i="${i}" aria-selected="false">
          <span>
            <span class="sr-name">${esc(s.name)}</span>
            ${s.sub ? `<span class="sr-crumbs"> — ${esc(s.sub)}</span>` : ''}
          </span>
          ${s.hasCam ? '<span class="sr-badge">CAM</span>' : ''}
        </button>`).join('');
    results.hidden = false;
    box.setAttribute('aria-expanded', 'true');
    results.querySelectorAll('.sr-item').forEach((b) => {
      b.addEventListener('click', () => pick(items[+b.dataset.i]));
    });
  }

  function close() {
    results.hidden = true;
    box.setAttribute('aria-expanded', 'false');
    sel = -1;
  }

  const run = debounce(async (q) => {
    const token = ++openToken;
    const { spots, demo } = await searchSpots(q);
    if (token !== openToken || input.value.trim() !== q) return;
    renderList(spots.slice(0, 10), demo
      ? { note: 'Offline — showing sample spots.' } : spots.length ? {} : { note: `Nothing found for “${q}”.` });
  }, 220);

  input.addEventListener('input', () => {
    const q = input.value.trim();
    clearBtn.hidden = !q;
    if (q.length < 2) { close(); return; }
    run(q);
  });

  input.addEventListener('focus', () => {
    if (!input.value.trim() && recents.length) {
      renderList(recents.map((r) => ({ ...r })), { note: 'Recently viewed' });
    }
  });

  input.addEventListener('keydown', (e) => {
    const opts = [...results.querySelectorAll('.sr-item')];
    if (e.key === 'Escape') { close(); input.blur(); return; }
    if (!opts.length) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      sel = (sel + (e.key === 'ArrowDown' ? 1 : -1) + opts.length) % opts.length;
      opts.forEach((o, i) => o.setAttribute('aria-selected', String(i === sel)));
      opts[sel].scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      e.preventDefault();
      pick(items[sel >= 0 ? sel : 0]);
    }
  });

  clearBtn.addEventListener('click', () => {
    input.value = '';
    clearBtn.hidden = true;
    close();
    input.focus();
  });

  const onDocDown = (e) => { if (!box.contains(e.target)) close(); };
  document.addEventListener('pointerdown', onDocDown);

  return {
    focus: () => input.focus(),
    destroy: () => document.removeEventListener('pointerdown', onDocDown),
  };
}
