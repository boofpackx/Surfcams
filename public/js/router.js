// Tiny hash router: '#/spot/xyz?name=Pipeline' → { path: ['spot','xyz'], query }
// Views are async render(container, route) functions returning a cleanup fn.

const routes = [];
let cleanup = null;
let gen = 0; // navigation generation — stale async renders must not win

export function route(pattern, render) {
  routes.push({ pattern: pattern.split('/').filter(Boolean), render });
}

export function parseHash(hash = location.hash) {
  const raw = hash.replace(/^#\/?/, '');
  const [pathPart, queryPart] = raw.split('?');
  return {
    path: pathPart.split('/').filter(Boolean).map(decodeURIComponent),
    query: new URLSearchParams(queryPart || ''),
  };
}

export function href(parts, query) {
  let h = '#/' + parts.map(encodeURIComponent).join('/');
  if (query) {
    const q = new URLSearchParams(query).toString();
    if (q) h += `?${q}`;
  }
  return h;
}

export function navigate(parts, query) {
  location.hash = href(parts, query).slice(1);
}

// Replace query params of the current route without adding history entries —
// used for shareable state like scrub time.
export function replaceQuery(mutate) {
  const { path, query } = parseHash();
  mutate(query);
  const h = href(path, query);
  history.replaceState(null, '', h);
}

function match(patternParts, pathParts) {
  if (patternParts.length !== pathParts.length) return null;
  const params = {};
  for (let i = 0; i < patternParts.length; i++) {
    if (patternParts[i].startsWith(':')) params[patternParts[i].slice(1)] = pathParts[i];
    else if (patternParts[i] !== pathParts[i]) return null;
  }
  return params;
}

export async function dispatch() {
  const viewRoot = document.getElementById('view');
  const { path, query } = parseHash();
  const myGen = ++gen;

  if (typeof cleanup === 'function') { try { cleanup(); } catch (e) { console.error(e); } }
  cleanup = null;

  // Fresh child container per navigation: if another dispatch happens while
  // this render is awaiting data, the stale render writes into a detached
  // node (its container.isConnected guards work) instead of the live view.
  viewRoot.className = '';
  viewRoot.innerHTML = '';
  const container = document.createElement('div');
  container.className = 'view';
  viewRoot.appendChild(container);
  window.scrollTo(0, 0);

  const run = async (r, params) => {
    let c;
    try {
      c = await r.render(container, { params, query });
    } catch (err) {
      if (myGen === gen) throw err;
      return; // superseded render died against a torn-down DOM — irrelevant
    }
    if (myGen === gen) cleanup = c;
    else if (typeof c === 'function') { try { c(); } catch { /* */ } }
  };

  for (const r of routes) {
    const params = match(r.pattern, path);
    if (params) return run(r, params);
  }
  // default → home (empty pattern)
  const home = routes.find((r) => r.pattern.length === 0);
  if (home) return run(home, {});
}

export function startRouter() {
  addEventListener('hashchange', dispatch);
  dispatch();
}
