/* dh-season.js
 * --------------------------------------------------------------------------
 * Shared crowd-season classifier, used by predict-core.js, mainstreet.html
 * and ride_predictor_diagnostic.html — all three had their own copy of the
 * same four-line rule.
 *
 * Exposes on window.DH:
 *   getSeason(date) -> 'holiday' | 'summer' | 'spring_break' | 'regular'
 *     (date is a JS Date)
 *
 * Load this file BEFORE any script that uses window.DH.getSeason.
 *
 * Spring break isn't one fixed calendar month — US school districts stagger
 * their breaks across roughly six weeks (early March through late April),
 * and a lot of that clusters around Easter, which itself moves every year
 * (as early as March 22, as late as April 25). A fixed "March or April"
 * rule mis-tags real high-crowd weeks in years where Easter lands near
 * either edge. So as of 2026-09-19, spring_break is a floating window
 * around Easter Sunday instead: has to have a real Date (not just a month
 * number) to compute that, which is why getSeason's signature changed from
 * a month number to a Date. `collect-waits/index.ts` (the Edge Function
 * that actually writes the `season` column) carries an independent copy of
 * this same Easter math — no build step to share code between browser JS
 * and that Deno function — keep both in sync if this ever changes again.
 * --------------------------------------------------------------------------
 */
(function () {
  'use strict';

  // Anonymous Gregorian algorithm (Meeus/Jones/Butcher) for Easter Sunday.
  // Standard, widely-used method; valid for any Gregorian calendar year.
  function computeEaster(year) {
    const a = year % 19;
    const b = Math.floor(year / 100);
    const c = year % 100;
    const d = Math.floor(b / 4);
    const e = b % 4;
    const f = Math.floor((b + 8) / 25);
    const g = Math.floor((b - f + 1) / 3);
    const h = (19 * a + b - d - g + 15) % 30;
    const i = Math.floor(c / 4);
    const k = c % 4;
    const l = (32 + 2 * e + 2 * i - h - k) % 7;
    const m = Math.floor((a + 11 * h + 22 * l) / 451);
    const month = Math.floor((h + l - 7 * m + 114) / 31); // 3 = March, 4 = April
    const day = ((h + l - 7 * m + 114) % 31) + 1;
    return new Date(year, month - 1, day);
  }

  // Window around Easter Sunday treated as spring_break. Chosen to roughly
  // match how travel-industry crowd calendars define the season, while
  // never reaching into June (earliest Easter+14 is May 9) or December/
  // January (latest Easter-21 is March 1) — so it never collides with the
  // summer/holiday checks below.
  const DAYS_BEFORE_EASTER = 21;
  const DAYS_AFTER_EASTER = 14;

  function isSpringBreak(date) {
    const easter = computeEaster(date.getFullYear());
    const dayOnly = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    const diffDays = Math.round((dayOnly - easter) / 86400000);
    return diffDays >= -DAYS_BEFORE_EASTER && diffDays <= DAYS_AFTER_EASTER;
  }

  function getSeason(date) {
    const month = date.getMonth() + 1;
    if (month === 12 || month === 1) return 'holiday';
    if (month >= 6 && month <= 8) return 'summer';
    if (isSpringBreak(date)) return 'spring_break';
    return 'regular';
  }

  window.DH = window.DH || {};
  window.DH.getSeason = getSeason;
})();
