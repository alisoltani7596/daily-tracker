/* Daily Tracker — service worker
 * Strategy:
 *   - App shell (same-origin): cache-first, populate on first fetch, offline-ready
 *   - Google Fonts (CSS + font files): cache-first after first load (so the app
 *     keeps its typography offline)
 *   - Everything else external (YouTube thumbs already local, LeetCode, the AI
 *     Coach Worker API, etc.): network-first, never cache non-GET requests
 *
 * Bump CACHE_VERSION whenever the shell changes to force a clean re-cache.
 */

const CACHE_VERSION = 'daily-tracker-v24';
const SHELL_CACHE = `${CACHE_VERSION}-shell`;
const FONT_CACHE  = `${CACHE_VERSION}-fonts`;
const RUNTIME_CACHE = `${CACHE_VERSION}-runtime`;

// Core files precached at install so the very first offline load works.
const APP_SHELL = [
  './',
  './index.html',
  './style-1.css',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-512-maskable.png',
];

const FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];

// ─── Install ─────────────────────────────────────────────────────────────────
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

// ─── Activate: clean up caches from older versions ───────────────────────────
self.addEventListener('activate', (event) => {
  const keep = new Set([SHELL_CACHE, FONT_CACHE, RUNTIME_CACHE]);
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => !keep.has(k)).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// ─── Fetch ───────────────────────────────────────────────────────────────────
self.addEventListener('fetch', (event) => {
  const req = event.request;

  // Only GET requests are cacheable. Everything else (e.g. the Coach POST to the
  // Cloudflare Worker) goes straight to the network.
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Google Fonts — cache-first after first load.
  if (FONT_HOSTS.includes(url.hostname)) {
    event.respondWith(cacheFirst(req, FONT_CACHE));
    return;
  }

  // Same-origin app shell + assets — cache-first, fall back to network+cache.
  if (url.origin === self.location.origin) {
    // For navigations, serve the cached app shell so deep offline reloads work.
    if (req.mode === 'navigate') {
      event.respondWith(
        cacheFirst(req, SHELL_CACHE).catch(() => caches.match('./index.html'))
      );
      return;
    }
    event.respondWith(cacheFirst(req, RUNTIME_CACHE));
    return;
  }

  // Any other external GET — network-first, no persistent caching.
  event.respondWith(
    fetch(req).catch(() => caches.match(req))
  );
});

// ─── Helpers ─────────────────────────────────────────────────────────────────
async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req);
  if (cached) return cached;
  const res = await fetch(req);
  // Cache successful (and opaque cross-origin font) responses for next time.
  if (res && (res.ok || res.type === 'opaque')) {
    cache.put(req, res.clone());
  }
  return res;
}
