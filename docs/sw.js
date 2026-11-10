// Service worker: caches every app file as one versioned set (brief 6.2).
// A new version installs quietly in the background and waits; it takes over
// only when the app is next opened (the page asks a waiting worker to take
// over at start-up, before anything is shown).  It never reloads a page.
// Requests to other sites (api.github.com) are not touched.

importScripts('version.js');
const VERSION = self.SWOLE_VERSION;
const CACHE = `swole-${VERSION}`;
const FILES = [
  './',
  'index.html',
  'app.css',
  'version.js',
  'manifest.webmanifest',
  'js/app.js',
  'js/db.js',
  'js/github.js',
  'js/model.js',
  'js/sync.js',
  'js/ui.js',
  'js/util.js',
  'icons/icon-180.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE).then(cache => cache.addAll(FILES.map(f => new Request(f, { cache: 'reload' }))))
  );
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k.startsWith('swole-') && k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    if (req.mode === 'navigate') {
      const page = await cache.match('index.html');
      if (page) return page;
    }
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    return fetch(req);
  })());
});
