/* dh-season.js
 * --------------------------------------------------------------------------
 * Shared crowd-season classifier, used by predict-core.js, mainstreet.html
 * and ride_predictor_diagnostic.html — all three had their own copy of the
 * same four-line rule.
 *
 * Exposes on window.DH:
 *   getSeason(month) -> 'holiday' | 'summer' | 'spring_break' | 'regular'
 *     (month is 1-12)
 *
 * Load this file BEFORE any script that uses window.DH.getSeason.
 * --------------------------------------------------------------------------
 */
(function () {
  'use strict';

  function getSeason(month) {
    if (month === 12 || month === 1) return 'holiday';
    if (month >= 6 && month <= 8) return 'summer';
    if (month === 3 || month === 4) return 'spring_break';
    return 'regular';
  }

  window.DH = window.DH || {};
  window.DH.getSeason = getSeason;
})();
