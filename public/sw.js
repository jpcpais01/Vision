// Deliberately does no caching. This is a live trading dashboard — a cached
// price or a cached trading state is actively dangerous to show as current.
// This exists only to satisfy PWA installability, which on some platforms
// requires a service worker with a fetch handler present, even a no-op one.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {
  /* pass every request straight through to the network */
});
