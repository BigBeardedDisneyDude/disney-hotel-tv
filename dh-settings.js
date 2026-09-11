/* dh-settings.js
 * --------------------------------------------------------------------------
 * Shared "family name + trip date" settings storage and the matching
 * "go home and carry those settings along as URL params" navigation, used
 * across the site's pages. Each home screen (index.html, wdw.html) keeps its
 * own localStorage key since they're separate resorts, but the read/write
 * shape and the "go home" pattern were identical hand-typed copies.
 *
 * Exposes on window.DH:
 *   settingsStore(lsKey) -> { load, persist }
 *     load()            -> { name, trip }  (empty strings if nothing saved)
 *     persist(name, trip)
 *   goHome(lsKey, homeUrl)
 *     Reads { name, trip } from lsKey and redirects to homeUrl, carrying
 *     them as ?family=&trip= if present; falls back to a plain redirect.
 *
 * Load this file BEFORE any script that uses window.DH.settingsStore /
 * window.DH.goHome.
 * --------------------------------------------------------------------------
 */
(function () {
  'use strict';

  function settingsStore(lsKey) {
    return {
      load: function () {
        try {
          var raw = localStorage.getItem(lsKey);
          if (raw) return JSON.parse(raw);
        } catch (e) {}
        return { name: '', trip: '' };
      },
      persist: function (name, trip) {
        try { localStorage.setItem(lsKey, JSON.stringify({ name: name, trip: trip })); } catch (e) {}
      }
    };
  }

  function goHome(lsKey, homeUrl) {
    try {
      var raw = localStorage.getItem(lsKey);
      if (raw) {
        var s = JSON.parse(raw), p = new URLSearchParams();
        if (s.name) p.set('family', s.name);
        if (s.trip) p.set('trip', s.trip);
        var qs = p.toString();
        window.location.href = homeUrl + (qs ? '?' + qs : '');
        return;
      }
    } catch (e) {}
    window.location.href = homeUrl;
  }

  window.DH = window.DH || {};
  window.DH.settingsStore = settingsStore;
  window.DH.goHome = goHome;
})();
