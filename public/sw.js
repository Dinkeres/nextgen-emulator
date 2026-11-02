// Service worker: (1) offline cache for the app shell + cores, (2) adds COOP/COEP headers so
// the page is cross-origin isolated on hosts that can't set headers (GitHub Pages). Same idea
// as coi-serviceworker (MIT). If isolation fails, the app falls back to non-shared audio.
// main.tsx registers sw.js?v=<build id>, so every deploy gets a fresh cache
const VERSION = 'kaiser-' + (new URL(self.location.href).searchParams.get('v') || 'dev');
const SHELL = ['./', './index.html', './manifest.webmanifest', './icon.svg'];

self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).catch(() => {}));
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== VERSION) await caches.delete(k);
    await self.clients.claim();
  })());
});

function isolate(res) {
  if (!res || res.status === 0 || res.type === 'opaque') return res;
  const h = new Headers(res.headers);
  h.set('Cross-Origin-Opener-Policy', 'same-origin');
  h.set('Cross-Origin-Embedder-Policy', 'require-corp');
  h.set('Cross-Origin-Resource-Policy', 'cross-origin');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  if (req.cache === 'only-if-cached' && req.mode !== 'same-origin') return;
  const url = new URL(req.url);
  // cores, fonts, hashed assets and homebrew are immutable per deploy: cache-first
  const immutable = /\/(cores|assets|homebrew)\//.test(url.pathname);
  e.respondWith((async () => {
    const cache = await caches.open(VERSION);
    if (immutable) {
      const hit = await cache.match(req);
      if (hit) return isolate(hit);
      const res = await fetch(req);
      if (res.ok) cache.put(req, res.clone());
      return isolate(res);
    }
    // app shell: network-first so updates land, cache as offline fallback
    try {
      const res = await fetch(req);
      if (res.ok) cache.put(req, res.clone());
      return isolate(res);
    } catch {
      const hit = (await cache.match(req)) || (req.mode === 'navigate' ? await cache.match('./index.html') || await cache.match('./') : null);
      if (hit) return isolate(hit);
      throw new Error('offline');
    }
  })());
});
