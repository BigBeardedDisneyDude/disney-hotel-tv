/*
 * =====================================================
 *  tv-mode.js  —  Drop this BEFORE </body> on any page
 *
 *  Activates TV mode when ?tv=1 is in the URL,
 *  OR when the user's screen is very wide (≥1800px)
 *  and very tall (≥900px) — a good heuristic for
 *  a TV or large display.
 *
 *  Usage:
 *    <link rel="stylesheet" href="tv-mode.css">
 *    <script src="tv-mode.js"></script>
 *
 *  Or paste inline at the bottom of each page's <script>
 * =====================================================
 */

(function () {
  const urlParams = new URLSearchParams(window.location.search);
  const forcedOn  = urlParams.get('tv') === '1';
  const forcedOff = urlParams.get('tv') === '0';

  // Auto-detect large displays (TV heuristic)
  const looksLikeTV = window.screen.width >= 1800 && window.screen.height >= 900;

  if (!forcedOff && (forcedOn || looksLikeTV)) {
    document.body.classList.add('tv-mode');
    console.log('[DH TV] TV mode active');
  }
})();
