// Paperbreak CORS relay — a Cloudflare Worker (free tier is plenty).
//
// Public CORS proxies come and go; this 25-liner is yours forever.
//
// Deploy (no CLI needed):
//   1. dash.cloudflare.com → Workers & Pages → Create → Worker
//   2. Paste this file, Deploy. Note the URL, e.g. https://pb-relay.you.workers.dev
//   3. On your Paperbreak site, open the browser console once and run:
//        localStorage.setItem('pb:relay', 'https://pb-relay.you.workers.dev/?url=')
//   Every API call now flows through your own relay first.
//
// Only Surfline hosts are relayed, so the worker can't be abused as an
// open proxy.

function hostAllowed(hostname) {
  return (
    hostname === 'surfline.com' ||
    hostname.endsWith('.surfline.com') ||
    hostname === 'cdn-surfline.com' ||
    hostname.endsWith('.cdn-surfline.com')
  );
}

export default {
  async fetch(request) {
    const target = new URL(request.url).searchParams.get('url');
    let upstream;
    try { upstream = new URL(target); } catch { return new Response('bad url', { status: 400 }); }
    if (!/^https?:$/.test(upstream.protocol) || !hostAllowed(upstream.hostname)) {
      return new Response('host not allowed', { status: 403 });
    }
    const res = await fetch(upstream.href, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Paperbreak-relay)', Accept: 'application/json' },
    });
    const headers = new Headers(res.headers);
    headers.set('Access-Control-Allow-Origin', '*');
    headers.delete('set-cookie');
    return new Response(res.body, { status: res.status, headers });
  },
};
