/* waits-core.js
 * --------------------------------------------------------------------------
 * Shared logic for the live wait-times pages:
 *   waittimes.html  (Disneyland Resort)
 *   wdwwait.html    (Walt Disney World)
 *
 * Each page ("shell") loads this file AFTER defining a global `RESORT`
 * object that says which parks to show, for example:
 *
 *   const RESORT = {
 *     parks: [
 *       { key: 'dl',  id: 16, name: 'Disneyland' },
 *       { key: 'dca', id: 17, name: 'California Adventure', tabLabel: 'Cal Adventure' },
 *     ],
 *   };
 *
 *     key      - short internal id; also used as the panel element id (park-<key>)
 *     id       - Queue-Times.com park id (the number in their API URL)
 *     name     - full park name, used in error messages
 *     tabLabel - optional shorter text for the tab button (defaults to `name`)
 *     refreshMs - optional auto-refresh interval (defaults to 5 minutes)
 *
 * The shell also supplies: the page styling, the header, a global `goHome()`
 * function, and these empty containers for this file to fill in:
 *
 *   <div class="park-tabs" id="park-tabs"></div>
 *   <div id="park-panels"></div>
 *
 * plus the static #status-text, #last-updated, #loading, #error elements and
 * the #stat-open / #stat-avg / #stat-max / #stat-short stat values.
 *
 * IMPORTANT: bump the `?v=` on every shell's `<script src="waits-core.js?v=...">`
 * whenever you edit this file, so browsers don't keep serving a stale cached copy.
 * --------------------------------------------------------------------------
 */
(function () {
  'use strict';

  var WORKER_PROXY = 'https://restless-glade-a1e4.andpcooke.workers.dev/proxy?url=';
  // Last-resort fallback if our own Worker is down or over its free-tier request
  // ceiling — it's a single point of failure shared by every page that fetches
  // park data. Only tried when the Worker itself fails.
  var FALLBACK_PROXY = 'https://api.allorigins.win/raw?url=';
  function qtUrl(id) { return 'https://queue-times.com/parks/' + id + '/queue_times.json'; }

  // Small localStorage cache so a transient fetch failure shows slightly stale,
  // clearly-labeled data instead of blanking the panel.
  var WAITS_CACHE_MAX_AGE_MS = 20 * 60 * 1000;
  function cacheKey(parkKey) { return 'dh_waits_cache_' + parkKey; }
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

  var PARKS = {};                 // key -> park config, for quick lookup
  var PARK_KEYS = [];             // park keys, in display order
  var rideData = {};              // key -> last fetched JSON (or null on failure)
  var activeTab = null;           // key of the park currently on screen
  var refreshTimer = null;
  var REFRESH_MS = RESORT.refreshMs || 5 * 60 * 1000;

  RESORT.parks.forEach(function (p) {
    PARKS[p.key] = p;
    PARK_KEYS.push(p.key);
    rideData[p.key] = null;
  });
  activeTab = PARK_KEYS[0];

  function $(id) { return document.getElementById(id); }
  function panelId(key) { return 'park-' + key; }

  // Escape text before dropping it into innerHTML.
  function x(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  async function fetchJSON(url) {
    try {
      var res = await fetch(WORKER_PROXY + encodeURIComponent(url), { signal: AbortSignal.timeout(9000) });
      if (res.ok) return res.json();
    } catch (e) {}
    // Worker failed — try the fallback CORS proxy before giving up.
    var fb = await fetch(FALLBACK_PROXY + encodeURIComponent(url), { signal: AbortSignal.timeout(9000) });
    if (!fb.ok) throw new Error('Proxy HTTP ' + fb.status);
    console.warn('[waits] Worker proxy failed — used fallback CORS proxy for', url);
    return JSON.parse(await fb.text());
  }

  function showLoading(on) { $('loading').style.display = on ? 'flex' : 'none'; }
  function hideError() { var e = $('error'); if (e) e.style.display = 'none'; }

  // Build the tab buttons and the empty park panels from RESORT.parks.
  function buildChrome() {
    var tabs = $('park-tabs');
    var panels = $('park-panels');
    tabs.innerHTML = '';
    panels.innerHTML = '';

    PARK_KEYS.forEach(function (key, i) {
      var p = PARKS[key];

      var btn = document.createElement('button');
      btn.className = 'park-tab' + (i === 0 ? ' active' : '');
      btn.dataset.park = key;
      btn.textContent = p.tabLabel || p.name;
      btn.addEventListener('click', function () { switchPark(key); });
      tabs.appendChild(btn);

      var panel = document.createElement('div');
      panel.id = panelId(key);
      panel.className = 'park-panel' + (i === 0 ? ' visible' : '');
      panels.appendChild(panel);
    });
  }

  function switchPark(key) {
    activeTab = key;
    document.querySelectorAll('.park-tab').forEach(function (t) {
      t.classList.toggle('active', t.dataset.park === key);
    });
    PARK_KEYS.forEach(function (k) {
      $(panelId(k)).style.display = (k === key) ? 'block' : 'none';
    });
    updateStats();
  }

  function updateStats() {
    var data = rideData[activeTab];
    if (!data) return;
    var all = (data.lands || []).flatMap(function (l) { return l.rides || []; }).concat(data.rides || []);
    var open = all.filter(function (r) { return r.is_open; });
    var waits = open.map(function (r) { return r.wait_time; }).filter(function (w) { return w > 0; });
    $('stat-open').textContent = open.length + '/' + all.length;
    $('stat-avg').textContent = waits.length ? Math.round(waits.reduce(function (a, b) { return a + b; }, 0) / waits.length) + 'm' : '–';
    $('stat-max').textContent = waits.length ? Math.max.apply(null, waits) + 'm' : '–';
    $('stat-short').textContent = waits.length ? Math.min.apply(null, waits) + 'm' : '–';
  }

  function waitClass(w) {
    return w < 20 ? 'open-low' : w < 40 ? 'open-med' : w < 60 ? 'open-high' : 'open-max';
  }

  // --- non-ride filtering ---------------------------------------------------
  // Queue-Times gives us no attraction "type", so shows, character meet-and-
  // greets, theatre acts and walkthroughs are recognised by name. Ride-style
  // attractions that still post a real standby wait (Enchanted Tiki Room, the
  // PeopleMover, the park railroads) are deliberately NOT matched here.
  // A page can override per park via RESORT config: `keep: ['Exact Name']`
  // always wins, `hide: ['Exact Name']` force-removes a straggler.
  var NON_RIDE_PATTERNS = [
    /\bmeet\b/i, /sing-?along/i, /\bon stage\b/i, /stunt spectacular/i,
    /\bmusical\b/i, /\bconcert\b/i, /clubhouse live/i, /disney jr\./i,
    /mickey mouse clubhouse/i, /turtle talk/i, /philharmagic/i,
    /\bshort film\b/i, /film festival/i, /film spotlight/i, /animated short/i,
    /circle-?vision/i, /\bcinema\b/i, /\bgallery\b/i, /hall of presidents/i,
    /great moments with mr\.? lincoln/i, /a magical life/i,
    /carousel of progress/i, /country bear/i, /festival of the lion king/i,
    /\blion king\b/i, /feathered friends in flight/i,
    /for the first time in forever/i, /the big blue/i,
    /beauty and the beast/i, /\bzootopia\b/i, /better zoogether/i,
    /enchanted tales with belle/i, /shootin['’ ]/i, /exposition/i,
    /\btheat(er|re)\b/i, /celebrity spotlight/i, /red carpet dreams/i,
    /walt disney presents/i, /animation academy/i, /sorcerer'?s workshop/i,
    /bakery tour/i, /awesome planet/i, /\bexhibits?\b/i,
    /conservation station/i, /wilderness explorers/i, /\btrails?\b/i,
    /\bwalkthrough\b/i, /\btreehouse\b/i, /tree of life/i, /journey of water/i,
    /\baquarium\b/i, /games of pixar pier/i, /main street vehicles/i,
    /\bminnie'?s house\b/i, /\bmickey'?s house\b/i, /world of color/i,
    /laugh floor/i, /pirate'?s adventure/i, /soak station/i,
    /cinderella castle/i
  ];

  function isRide(name, hideSet, keepSet) {
    if (keepSet.has(name)) return true;
    if (hideSet.has(name)) return false;
    for (var i = 0; i < NON_RIDE_PATTERNS.length; i++) {
      if (NON_RIDE_PATTERNS[i].test(name)) return false;
    }
    return true;
  }

  function filterNonRides(data, park) {
    var hideSet = new Set(park.hide || []);
    var keepSet = new Set(park.keep || []);
    var removed = [];
    function keep(r) {
      var ok = isRide(r.name, hideSet, keepSet);
      if (!ok) removed.push(r.name);
      return ok;
    }
    (data.lands || []).forEach(function (land) {
      land.rides = (land.rides || []).filter(keep);
    });
    if (data.rides) data.rides = data.rides.filter(keep);
    if (removed.length) console.log('[waits] ' + park.name + ': hid ' + removed.length + ' non-rides', removed);
    return data;
  }

  function renderPark(key, data) {
    var panel = $(panelId(key));
    var lands = (data.lands || []).slice();
    if ((data.rides || []).length) lands.push({ name: 'Other Attractions', rides: data.rides });

    if (!lands.length) {
      panel.innerHTML = '<p class="panel-note">No ride data available.</p>';
      return;
    }

    var html = '';
    lands.forEach(function (land) {
      if (!land.rides || !land.rides.length) return;
      var sorted = land.rides.slice().sort(function (a, b) {
        if (a.is_open && !b.is_open) return -1;
        if (!a.is_open && b.is_open) return 1;
        return b.wait_time - a.wait_time;
      });
      html += '<div class="land-group"><div class="land-header"><div class="land-title">' +
              x(land.name) + '</div><div class="land-divider"></div></div><div class="ride-grid">';
      sorted.forEach(function (ride) {
        var cls = !ride.is_open ? 'closed' : waitClass(ride.wait_time);
        var badge = !ride.is_open ? 'Closed'
          : ((ride.wait_time || 0) === 0 ? '0 min' : ride.wait_time + ' min');
        html += '<div class="ride-card ' + cls + '"><div class="ride-name">' + x(ride.name) +
                '</div><div class="wait-badge">' + badge + '</div></div>';
      });
      html += '</div></div>';
    });
    panel.innerHTML = html;
  }

  async function fetchPark(key) {
    try {
      var data = await fetchJSON(qtUrl(PARKS[key].id));
      filterNonRides(data, PARKS[key]);
      rideData[key] = data;
      cacheSet(cacheKey(key), data);
      renderPark(key, data);
    } catch (err) {
      var cached = cacheGet(cacheKey(key), WAITS_CACHE_MAX_AGE_MS);
      if (cached) {
        rideData[key] = cached.value;
        renderPark(key, cached.value);
        var mins = Math.round(cached.ageMs / 60000);
        var panel = $(panelId(key));
        panel.insertAdjacentHTML('afterbegin',
          '<p class="panel-note" style="margin-bottom:.6rem">' +
            'Live fetch failed — showing wait times from ' + (mins < 1 ? 'under a minute' : mins + ' min') + ' ago.' +
          '</p>');
        console.warn('[waits] ' + PARKS[key].name + ': fetch failed, used cached data from ' + mins + ' min ago');
        return;
      }
      rideData[key] = null;
      $(panelId(key)).innerHTML =
        '<div class="panel-error">' +
          '<p>Could not load ' + x(PARKS[key].name) + ' wait times.</p>' +
          '<p class="detail">' + x(err.message) + '</p>' +
          '<button class="retry-btn" onclick="fetchAll()">Try Again</button>' +
        '</div>';
    }
  }

  async function fetchAll() {
    showLoading(true);
    hideError();
    PARK_KEYS.forEach(function (k) { $(panelId(k)).style.display = 'none'; });
    $('status-text').textContent = 'Refreshing…';

    await Promise.all(PARK_KEYS.map(fetchPark));

    showLoading(false);
    PARK_KEYS.forEach(function (k) {
      $(panelId(k)).style.display = (k === activeTab) ? 'block' : 'none';
    });

    var anyLoaded = PARK_KEYS.some(function (k) { return rideData[k]; });
    $('status-text').textContent = anyLoaded ? 'Live data' : 'Data unavailable';
    $('last-updated').textContent =
      'Updated ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) +
      ' · Auto-refreshes every ' + Math.round(REFRESH_MS / 60000) + ' min';

    updateStats();
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(fetchAll, REFRESH_MS);
  }

  // Inline onclick="" handlers in the page markup call these two by name.
  window.fetchAll = fetchAll;
  window.switchPark = switchPark;

  buildChrome();
  fetchAll();
})();
