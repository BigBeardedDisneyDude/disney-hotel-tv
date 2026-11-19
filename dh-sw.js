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
const CACHE = 'dh-tv-v2';
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
      // Keep ENDPOINT_CACHE across updates (defined below, with the push
      // listeners) — it's the fallback record of this device's push
      // subscription address, not app-shell cache, and must survive every
      // time this file gets a new version.
      Promise.all(keys.filter(k => k !== CACHE && k !== 'dh-push-endpoint').map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
    // Also opportunistically refresh the endpoint record right now, so a
    // device upgrading from a pre-fix dh-sw.js already has one cached
    // before the next pushsubscriptionchange event needs it.
    .then(() => self.registration.pushManager.getSubscription())
    .then(sub => rememberEndpoint(sub && sub.endpoint))
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

  // Network-first for actual page loads (index.html itself, in any of its
  // ?resort= variants) — this is the one thing that changes every time we
  // ship a fix, so it must never get stuck on a stale cached copy the way
  // cache-first would. Falls back to whatever's cached only if the network
  // request fails (offline).
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request).then(res => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return res;
      }).catch(() => caches.match(e.request))
    );
    return;
  }

  // Cache-first for everything else (fonts, icons) — these rarely change,
  // so it's worth saving the network round-trip.
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

// Hand-synced duplicates of predict-core.js's copies (same no-build-step
// reason as that file's own header comment, and rideAlerts.ts's normName()).
// Needed here, not just there, because the browser can rotate a push
// subscription's endpoint on its own — observed on iOS web push roughly a
// day after subscribing — and only the service worker (which runs even with
// every tab/installed app closed) gets a chance to react when that happens.
const SUPABASE_URL = 'https://qumvjdwimpvnaijjwght.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InF1bXZqZHdpbXB2bmFpamp3Z2h0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc4NzQ4ODcsImV4cCI6MjA5MzQ1MDg4N30.BjBeX8GSZkZoUnW3Ecy3MTPdHVV-6E2U1oJnVHiyr5I';
const VAPID_PUBLIC_KEY = 'BGAn-lmNWfAu83quM_hgVOY36Fp2OjXHVCNE4JaCDlFzde9fGZkFhVE3Nrj7AyvrQX1B7_Uld4HTvgSnXxvfOpo';

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from([...atob(base64)].map(c => c.charCodeAt(0)));
}

// Safari doesn't reliably hand pushsubscriptionchange its oldSubscription
// (spec says it should; WebKit often fires the event with it undefined) —
// and Safari/iOS is the actual platform this has to work on. So the service
// worker keeps its own record of the last endpoint it saw, using Cache
// Storage (service workers have no localStorage) as a fallback for when the
// browser doesn't tell us what the old address was.
const ENDPOINT_CACHE = 'dh-push-endpoint';
const ENDPOINT_KEY = new Request('https://dh-sw.local/last-push-endpoint');
async function rememberEndpoint(endpoint) {
  if (!endpoint) return;
  const c = await caches.open(ENDPOINT_CACHE);
  await c.put(ENDPOINT_KEY, new Response(endpoint));
}
async function recallEndpoint() {
  const c = await caches.open(ENDPOINT_CACHE);
  const res = await c.match(ENDPOINT_KEY);
  return res ? await res.text() : null;
}

// Favorite-ride wait alerts: collect-waits sends a push (title/body/url) the
// moment a favorited ride's live wait crosses below its threshold. This
// fires even if predict.html/wdwpredict.html isn't open — that's the whole
// point of true push over a foreground-only check.
self.addEventListener('push', e => {
  let data = {};
  try { data = e.data.json(); } catch (_) { data = {}; }
  const title = data.title || 'Ride wait alert';
  const url = data.url || '/disney-hotel-tv/predict.html';
  e.waitUntil(Promise.all([
    self.registration.showNotification(title, {
      body: data.body || '',
      icon: '/disney-hotel-tv/mainstreet-icon.png',
      badge: '/disney-hotel-tv/mainstreet-icon.png',
      data: { url }
    }),
    // Piggyback on this guaranteed-active moment to refresh our own record
    // of the current endpoint (see ENDPOINT_CACHE above) — cheap insurance
    // against Safari not telling us the old one when it later rotates.
    self.registration.pushManager.getSubscription().then(sub => rememberEndpoint(sub && sub.endpoint))
  ]));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/disney-hotel-tv/predict.html';
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
      const page = url.split('/').pop();
      for (const client of clients) {
        if (client.url.includes(page) && 'focus' in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});

// The fix for the "alerts work for a day then silently stop" bug: when the
// browser rotates this device's push subscription endpoint out from under
// us, this is the only code path that ever runs to catch it (the page
// itself may be closed). Re-subscribe with the same VAPID key, then
// re-point every ride_alerts row that pointed at the old endpoint to the
// new one. Without this, the old endpoint starts returning 410 Gone and
// collect-waits's checkRideAlerts() quietly deletes the alert row as
// stale — no error anywhere, the notifications just stop for good.
self.addEventListener('pushsubscriptionchange', e => {
  e.waitUntil((async () => {
    const oldEndpoint = (e.oldSubscription && e.oldSubscription.endpoint) || await recallEndpoint();
    const newSub = e.newSubscription || await self.registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY)
    });
    await rememberEndpoint(newSub.endpoint);
    if (!oldEndpoint || oldEndpoint === newSub.endpoint) return; // nothing to re-point
    await fetch(`${SUPABASE_URL}/rest/v1/ride_alerts?endpoint=eq.${encodeURIComponent(oldEndpoint)}`, {
      method: 'PATCH',
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        endpoint: newSub.endpoint,
        subscription: newSub.toJSON(),
        updated_at: new Date().toISOString()
      })
    });
  })());
});
