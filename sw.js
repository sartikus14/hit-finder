// Minimal service worker so phones offer "Install app".
// It never caches stats: every request goes straight to the network,
// so the rankings are always live.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (event) => {
  event.respondWith(fetch(event.request));
});
