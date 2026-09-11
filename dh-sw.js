/* dh-sw.js
 * --------------------------------------------------------------------------
 * Service worker for the "Magic Key TV" home screen (index.html), making it
 * installable as a kiosk app (Add to Home Screen / desktop PWA install).
 * Mirrors mainstreet-sw.js's pattern: cache the app shell + fonts so it opens
 * instantly and works through a flaky connection, but always hit the network
 * for anything that has to be fresh (live data, and the R2-hosted background
 * video, which is too large to want cached indefinitely).
 * --------------------------------------------------------------------------
 */
const CACHE = 'dh-tv-v1';
const PRECACHE = [
  '/disney-hotel-tv/index.html',
  'https://fonts.googleapis.com/css2?family=Cinzel:wght@400;600;700&family=Raleway:wght@200;300;400;600&family=Cormorant+Garamond:ital,wght@0,300;0,400;1,300;1,400&display=swap'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(PRECACHE)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Always go to the network for live data and the background video —
  // caching these would either show stale info or bloat storage on a
  // kiosk device with a large media file.
  const isNetworkOnly = url.hostname.includes('supabase.co')
    || url.hostname.includes('workers.dev')
    || url.hostname.includes('queue-times.com')
    || url.hostname.includes('themeparks.wiki')
    || url.hostname.includes('open-meteo.com')
    || url.hostname.includes('r2.dev');

  if (isNetworkOnly) {
    e.respondWith(fetch(e.request));
    return;
  }

  // Cache-first for the app shell and fonts.
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(res => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return res;
      });
    })
  );
});
