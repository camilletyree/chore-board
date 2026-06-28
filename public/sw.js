// sw.js — tiny service worker so ChoreBoard installs to a home screen and the shell loads offline.
// Strategy: precache the static shell; stale-while-revalidate for same-origin GETs; never touch
// /api/* (the app's own outbox already handles offline writes and sync — see app.js). Bump CACHE
// to ship a new shell. NB: service workers need a secure context, so over a plain-http LAN IP this
// won't register (it does on localhost / behind HTTPS) — app.js guards the registration accordingly.
const CACHE = 'choreboard-v2';
const SHELL = ['./', 'index.html', 'styles.css', 'app.js', 'scheduler.js', 'sync.js', 'templates.js', 'stats.js', 'manifest.webmanifest', 'icon.svg'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;                 // writes always hit the network
  if (url.origin !== location.origin) return;             // leave cross-origin (fonts) to the browser
  if (url.pathname.startsWith('/api/')) return;           // sync talks to the server directly
  e.respondWith(caches.match(e.request).then(hit => {
    const net = fetch(e.request).then(res => {
      if (res && res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
      return res;
    }).catch(() => hit);
    return hit || net;                                    // cache-first, refresh in the background
  }));
});
