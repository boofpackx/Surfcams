#!/usr/bin/env node
/**
 * Paperbreak — static file server + Surfline proxy.
 *
 * Zero dependencies. Node 18+ (built-in fetch).
 *
 *   node server.js            → http://localhost:8080
 *   PORT=3000 node server.js  → http://localhost:3000
 *
 * Routes:
 *   /api/<path>?...   → https://services.surfline.com/<path>?...   (JSON, 60s cache)
 *   /proxy?url=<enc>  → passthrough for Surfline media (HLS playlists rewritten
 *                       so every segment also flows through this proxy; mp4 Range
 *                       requests forwarded for rewind scrubbing)
 *   everything else   → static files from ./public (SPA fallback to index.html)
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');

const PORT = Number(process.env.PORT) || 8080;
const PUBLIC_DIR = path.join(__dirname, 'public');
const API_ORIGIN = 'https://services.surfline.com';
const UA = 'Mozilla/5.0 (compatible; Paperbreak/1.0; personal, non-commercial)';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
};

// ---------------------------------------------------------------- api cache
const API_TTL_MS = 60_000;
const API_CACHE_MAX = 500;
const apiCache = new Map(); // url -> { at, status, body, type }

function cacheGet(url) {
  const hit = apiCache.get(url);
  if (!hit) return null;
  if (Date.now() - hit.at > API_TTL_MS) { apiCache.delete(url); return null; }
  return hit;
}
function cacheSet(url, entry) {
  if (apiCache.size >= API_CACHE_MAX) {
    // drop oldest entry (Map preserves insertion order)
    apiCache.delete(apiCache.keys().next().value);
  }
  apiCache.set(url, { at: Date.now(), ...entry });
}

// ------------------------------------------------------------------- proxy
function hostAllowed(hostname) {
  return (
    hostname === 'surfline.com' ||
    hostname.endsWith('.surfline.com') ||
    hostname === 'cdn-surfline.com' ||
    hostname.endsWith('.cdn-surfline.com')
  );
}

async function handleApi(req, res, reqUrl) {
  const upstream = API_ORIGIN + reqUrl.pathname.replace(/^\/api/, '') + reqUrl.search;

  const cached = req.method === 'GET' && cacheGet(upstream);
  if (cached) {
    res.writeHead(cached.status, { 'Content-Type': cached.type, 'X-Proxy-Cache': 'HIT' });
    res.end(cached.body);
    return;
  }

  let up;
  try {
    up = await fetch(upstream, {
      method: req.method === 'HEAD' ? 'HEAD' : 'GET',
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'upstream_unreachable', detail: String(err && err.message) }));
    return;
  }

  const type = up.headers.get('content-type') || 'application/json';
  const body = Buffer.from(await up.arrayBuffer());
  if (req.method === 'GET' && up.ok && body.length < 2_000_000) {
    cacheSet(upstream, { status: up.status, body, type });
  }
  res.writeHead(up.status, { 'Content-Type': type, 'X-Proxy-Cache': 'MISS' });
  res.end(req.method === 'HEAD' ? undefined : body);
}

function rewritePlaylist(text, playlistUrl) {
  // Route every URI in an HLS playlist back through /proxy.
  const base = new URL(playlistUrl);
  const rewriteUri = (uri) => '/proxy?url=' + encodeURIComponent(new URL(uri, base).href);
  return text
    .split('\n')
    .map((line) => {
      const t = line.trim();
      if (!t) return line;
      if (t.startsWith('#')) {
        // Rewrite URI="..." attributes (keys, media playlists in master lists)
        return line.replace(/URI="([^"]+)"/g, (_, uri) => `URI="${rewriteUri(uri)}"`);
      }
      return rewriteUri(t);
    })
    .join('\n');
}

async function handleProxy(req, res, reqUrl) {
  const target = reqUrl.searchParams.get('url');
  let targetUrl;
  try {
    targetUrl = new URL(target);
  } catch {
    res.writeHead(400); res.end('bad url'); return;
  }
  if (!/^https?:$/.test(targetUrl.protocol) || !hostAllowed(targetUrl.hostname)) {
    res.writeHead(403); res.end('host not allowed'); return;
  }

  const headers = { 'User-Agent': UA };
  if (req.headers.range) headers.Range = req.headers.range;

  let up;
  try {
    up = await fetch(targetUrl.href, {
      method: req.method === 'HEAD' ? 'HEAD' : 'GET',
      headers,
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    res.writeHead(502); res.end('upstream unreachable: ' + String(err && err.message));
    return;
  }

  const type = up.headers.get('content-type') || '';
  const isPlaylist =
    /mpegurl/i.test(type) || /\.m3u8($|\?)/.test(targetUrl.pathname + targetUrl.search);

  if (isPlaylist && req.method !== 'HEAD') {
    const text = await up.text();
    const body = rewritePlaylist(text, up.url || targetUrl.href);
    res.writeHead(up.status, {
      'Content-Type': 'application/vnd.apple.mpegurl',
      'Cache-Control': 'no-store',
    });
    res.end(body);
    return;
  }

  const outHeaders = {};
  for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified']) {
    const v = up.headers.get(h);
    if (v) outHeaders[h] = v;
  }
  res.writeHead(up.status, outHeaders);
  if (req.method === 'HEAD' || !up.body) { res.end(); return; }
  Readable.fromWeb(up.body).pipe(res);
}

// ------------------------------------------------------------------ static
function serveStatic(req, res, reqUrl) {
  let pathname = decodeURIComponent(reqUrl.pathname);
  if (pathname === '/') pathname = '/index.html';

  let filePath = path.normalize(path.join(PUBLIC_DIR, pathname));
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end(); return; }

  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    // SPA fallback: any non-file path renders the app shell
    filePath = path.join(PUBLIC_DIR, 'index.html');
  }

  const ext = path.extname(filePath).toLowerCase();
  const immutable = pathname.startsWith('/vendor/');
  const noStore = ext === '.html' || pathname === '/sw.js';
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': noStore
      ? 'no-cache'
      : immutable
        ? 'public, max-age=604800, immutable'
        : 'public, max-age=300',
  });
  fs.createReadStream(filePath).pipe(res);
}

// ------------------------------------------------------------------ server
const server = http.createServer((req, res) => {
  const reqUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405); res.end(); return;
  }
  try {
    if (reqUrl.pathname.startsWith('/api/')) return void handleApi(req, res, reqUrl);
    if (reqUrl.pathname === '/proxy') return void handleProxy(req, res, reqUrl);
    return void serveStatic(req, res, reqUrl);
  } catch (err) {
    res.writeHead(500); res.end('server error');
  }
});

server.listen(PORT, () => {
  console.log(`Paperbreak → http://localhost:${PORT}`);
});
