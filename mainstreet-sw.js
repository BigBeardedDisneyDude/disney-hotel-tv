const CACHE = 'mainstreet-v1';
const PRECACHE = [
  '/disney-hotel-tv/mainstreet.html',
  'https://fonts.googleapis.com/css2?family=Cinzel:wght@400;600;700&family=Crimson+Pro:ital,wght@0,300;0,400;1,300&display=swap'
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

  // Always go network-first for API calls (Supabase, Anthropic worker, Queue-Times, etc.)
  const isApi = url.hostname.includes('supabase.co')
    || url.hostname.includes('workers.dev')
    || url.hostname.includes('queue-times.com')
    || url.hostname.includes('themeparks.wiki')
    || url.hostname.includes('open-meteo.com')
    || url.hostname.includes('allorigins.win')
    || url.hostname.includes('corsproxy.io')
    || url.hostname.includes('codetabs.com');

  if (isApi) {
    e.respondWith(fetch(e.request));
    return;
  }

  // Cache-first for the app shell and fonts
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
