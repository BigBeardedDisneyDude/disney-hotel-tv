/* dh-proxy.js
 * --------------------------------------------------------------------------
 * Shared Worker-proxy fetch helper, used by every page that pulls Queue-Times
 * or ThemeParks.wiki data: waits-core.js, predict-core.js, mainstreet.html.
 *
 * All three used to hand-roll the same "call our Cloudflare Worker, and if
 * that fails try a public CORS proxy" logic plus the same small localStorage
 * response cache. This file is the single copy.
 *
 * Exposes on window.DH:
 *   fetchProxyStatus(url) -> { ok, status, data }   (data is null on failure)
 *   fetchProxy(url, label) -> data or null          (label is just for the
 *                                                     console.warn tag)
 *   cacheGet(key, maxAgeMs) -> { value, ageMs } or null
 *   cacheSet(key, value)
 *
 * Load this file BEFORE any script that uses window.DH.
 * Bump every consuming page's `?v=` when this file changes, so browsers
 * don't keep serving a stale cached copy.
 * --------------------------------------------------------------------------
 */
(function () {
  'use strict';

  var WORKER_PROXY = 'https://restless-glade-a1e4.andpcooke.workers.dev/proxy?url=';
  // Last-resort fallback if our own Worker is down or over its free-tier request
  // ceiling — the Worker is a single point of failure shared by every page that
  // fetches park data. Only tried when the Worker itself fails.
  var FALLBACK_PROXY = 'https://api.allorigins.win/raw?url=';

  // Returns the real HTTP status too, for callers that need to tell a rotted
  // upstream id (404) apart from a rate limit (429) — park hours does this.
  async function fetchProxyStatus(url) {
    try {
      var r = await fetch(WORKER_PROXY + encodeURIComponent(url), { signal: AbortSignal.timeout(9000) });
      if (r.ok) return { ok: true, status: r.status, data: await r.json() };
      return { ok: false, status: r.status, data: null };
    } catch (e) {
      return { ok: false, status: 0, data: null };
    }
  }

  async function fetchProxy(url, label) {
    var primary = await fetchProxyStatus(url);
    if (primary.ok) return primary.data;
    try {
      var r = await fetch(FALLBACK_PROXY + encodeURIComponent(url), { signal: AbortSignal.timeout(9000) });
      if (r.ok) {
        console.warn('[' + (label || 'dh') + '] Worker proxy failed (status ' + primary.status + ') — used fallback CORS proxy for', url);
        return JSON.parse(await r.text());
      }
    } catch (e) {}
    return null;
  }

  // Small localStorage cache so a transient fetch failure can show slightly
  // stale, clearly-labeled data instead of blanking the page.
  function cacheGet(key, maxAgeMs) {
    try {
      var raw = localStorage.getItem(key);
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      if (Date.now() - parsed.t > maxAgeMs) return null;
      return { value: parsed.v, ageMs: Date.now() - parsed.t };
    } catch (e) { return null; }
  }
  function cacheSet(key, v) {
    try { localStorage.setItem(key, JSON.stringify({ t: Date.now(), v: v })); } catch (e) {}
  }

  window.DH = window.DH || {};
  window.DH.fetchProxyStatus = fetchProxyStatus;
  window.DH.fetchProxy = fetchProxy;
  window.DH.cacheGet = cacheGet;
  window.DH.cacheSet = cacheSet;
})();
