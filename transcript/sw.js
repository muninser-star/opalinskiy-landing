const CACHE_PREFIX = 'opalinskiy-transcript-offline-';
const CACHE_NAME = CACHE_PREFIX + 'v1';
const OFFLINE_URL = new URL('offline.html', self.registration.scope).href;

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.add(new Request(OFFLINE_URL, { cache: 'reload', credentials: 'omit' }));
  })());
});

// Let an open recording keep its current worker until the app is closed.
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names
      .filter(name => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
      .map(name => caches.delete(name)));
  })());
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' ||
      event.request.mode !== 'navigate' ||
      url.origin !== self.location.origin ||
      !url.pathname.startsWith('/transcript/')) {
    return;
  }
  event.respondWith((async () => {
    try {
      return await fetch(event.request);
    } catch {
      const cache = await caches.open(CACHE_NAME);
      return await cache.match(OFFLINE_URL) || Response.error();
    }
  })());
});
