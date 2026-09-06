/* predict-core.js
 * --------------------------------------------------------------------------
 * Shared behaviour for the ride-wait predictor pages:
 *   predict.html      (Disneyland Resort - Disneyland + California Adventure)
 *   wdwpredict.html   (Walt Disney World - Magic Kingdom / EPCOT / HS / AK)
 *
 * Each page ("shell") loads this file AFTER defining a global `PREDICT`
 * object that lists which parks it covers and the per-ride baseline data:
 *
 *   const PREDICT = {
 *     parks: [
 *       {
 *         key: 'dl',                       // internal id + localStorage + Supabase `park` code
 *         name: 'Disneyland',              // full name (used in the LL advisor subtitle)
 *         tabLabel: 'Disneyland',          // optional shorter tab text (defaults to `name`)
 *         qtId: 16,                        // Queue-Times.com park id
 *         twId: '7340550b-...-acdb51d49a66',// ThemeParks.wiki entity id for /schedule
 *         closeIdx: 17,                    // last modelled hour, index into HRS (0 = 6am); 17 = 11pm
 *         rides: [
 *           { id:'indy', name:'Indiana Jones Adventure', land:'Adventureland',
 *             qt:'indiana jones adventure',   // lower-case Queue-Times ride name to match on
 *             ll:true,                        // is a Lightning Lane / Genie+ ride
 *             p:[ 18 numbers ] },             // 6am-11pm baseline wait curve
 *           ...
 *         ],
 *       },
 *       ...
 *     ],
 *   };
 *
 * IMPORTANT: each park's `key` must equal the `park` code the wait-times
 * collector writes to Supabase (`dl`, `dca`, `mk`, `epcot`, `hs`, `ak`), or
 * the historical-profile blend for that park will never match any rows.
 *
 * IMPORTANT: bump the `?v=` on every shell's `<script src="predict-core.js?v=...">`
 * whenever you edit this file, so browsers don't keep serving a stale cached copy.
 *
 * The shell also supplies: the page styling, the <header> + home link, the
 * <title>, and these containers for this file to fill / drive:
 *
 *   <div class="tabs" id="tabs"></div>          (park tab buttons)
 *   #picks #fav-picks #grid #ll-* #modal-*      (as in predict.html today)
 * --------------------------------------------------------------------------
 */

// ── SUPABASE CONFIG ───────────────────────────────────────────────────────────
const SUPABASE_URL = 'https://qumvjdwimpvnaijjwght.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InF1bXZqZHdpbXB2bmFpamp3Z2h0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc4NzQ4ODcsImV4cCI6MjA5MzQ1MDg4N30.BjBeX8GSZkZoUnW3Ecy3MTPdHVV-6E2U1oJnVHiyr5I';
const MIN_SAMPLES = 10;

// ── PARK CONFIG HELPERS ──────────────────────────────────────────────────────
const parkCfg = k => PREDICT.parks.find(p => p.key === k) || PREDICT.parks[0];
const ridesOf = k => parkCfg(k).rides;

// ── HISTORICAL PROFILE CACHE ─────────────────────────────────────────────────
let historicalProfiles = null;
let historicalBands = null; // profiles[park][rideName][idx] = {p25,p75}, raw minutes (not multiplier-scaled)
let usingRealData = false;
// Empirical correction on top of the hand-authored crowdLevel()/mult() table,
// derived from how far real Supabase averages land from what that table would
// have predicted for the SAME rides/hours today. Keyed by park; absent = 1x
// (not enough same-day data yet to trust a correction). See effectiveMult().
let autoTuneFactor = {};

function percentile(sortedAsc, p) {
if (!sortedAsc.length) return null;
const idx = (sortedAsc.length - 1) * p;
const lo = Math.floor(idx), hi = Math.ceil(idx);
if (lo === hi) return sortedAsc[lo];
return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (idx - lo);
}

// PostgREST (Supabase's REST layer) caps a response at 1000 rows by default,
// with no error or warning — it just silently truncates. Combined with the
// `order=ride_name,hour_of_day` below, an unpaginated query only ever sees
// rides early in the alphabet, no matter how much history actually exists.
// On a single busy day-type/season bucket for one park, the true row count is
// easily 10x that cap (confirmed 11k+ for a Friday/regular-season/Disneyland
// query on 2026-09-05), so this must page through everything rather than
// trust the first page. MAX_ROWS is a circuit breaker, not a normal limit.
const SUPABASE_PAGE_SIZE = 1000;
const SUPABASE_MAX_ROWS = 20000;
async function fetchAllRows(params) {
const rows = [];
let offset = 0;
while (true) {
const res = await fetch(`${SUPABASE_URL}/rest/v1/wait_times?${params}`, {
headers: {
apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`,
Range: `${offset}-${offset + SUPABASE_PAGE_SIZE - 1}`
},
signal: AbortSignal.timeout(8000)
});
if (!res.ok && res.status !== 206) throw new Error(`Supabase ${res.status}`);
const page = await res.json();
rows.push(...page);
if (page.length < SUPABASE_PAGE_SIZE || rows.length >= SUPABASE_MAX_ROWS) break;
offset += SUPABASE_PAGE_SIZE;
}
return rows;
}

async function loadHistoricalProfiles() {
if (SUPABASE_URL === 'YOUR_SUPABASE_URL') return;
const now = new Date();
const pt = new Date(now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
const dow = pt.getDay();
const seasonKey = getSeason(pt.getMonth() + 1);
try {
const perPark = await Promise.all(PREDICT.parks.map(p => {
const params = new URLSearchParams({
select: 'park,ride_name,hour_of_day,wait_time',
park: `eq.${p.key}`,
day_of_week: `eq.${dow}`,
season: `eq.${seasonKey}`,
is_open: 'eq.true',
wait_time: 'gte.0',
order: 'ride_name,hour_of_day'
});
return fetchAllRows(params);
}));
const rows = perPark.flat();
if (!rows.length) return;
const buckets = {};
for (const row of rows) {
const key = `${row.park}|${row.ride_name}|${row.hour_of_day}`;
if (!buckets[key]) buckets[key] = [];
buckets[key].push(row.wait_time);
}
const profiles = {}, bands = {};
PREDICT.parks.forEach(p => { profiles[p.key] = {}; bands[p.key] = {}; });
// Reference point for measuring drift below: what the hand-authored table
// would have predicted for today's day-type/season, before any tuning.
const baselineMult = mult(crowdLevel(dayType(now), season(now)));
const ratiosByPark = {};
for (const [key, waits] of Object.entries(buckets)) {
if (waits.length < MIN_SAMPLES) continue;
const [pk, rideName, hourStr] = key.split('|');
if (!profiles[pk]) continue;             // a park this page doesn't show
const hour = parseInt(hourStr);
const idx = hour - 6;
if (idx < 0 || idx > 17) continue;
const sorted = [...waits].sort((a,b)=>a-b);
const mean = waits.reduce((a,b)=>a+b,0) / waits.length;
if (!profiles[pk][rideName]) profiles[pk][rideName] = new Array(18).fill(null);
if (!bands[pk][rideName]) bands[pk][rideName] = new Array(18).fill(null);
profiles[pk][rideName][idx] = Math.round(mean);
bands[pk][rideName][idx] = { p25: Math.round(percentile(sorted, 0.25)), p75: Math.round(percentile(sorted, 0.75)) };
// How far off was the hand-authored baseline for this exact (ride, hour)?
const cfg = PREDICT.parks.find(pp => pp.key === pk);
const ride = cfg?.rides.find(r => r.name === rideName);
const predicted = ride ? ride.p[idx] * baselineMult : 0;
if (predicted > 0) (ratiosByPark[pk] = ratiosByPark[pk] || []).push(mean / predicted);
}
const covered = PREDICT.parks.some(p =>
Object.keys(profiles[p.key]).length / Math.max(p.rides.length, 1) > 0.5);
if (covered) {
historicalProfiles = profiles;
historicalBands = bands;
usingRealData = true;
autoTuneFactor = {};
const MIN_RATIOS = 8; // need signal from enough (ride,hour) buckets to trust a park-wide correction
for (const [pk, ratios] of Object.entries(ratiosByPark)) {
if (ratios.length < MIN_RATIOS) continue;
const sortedRatios = [...ratios].sort((a,b)=>a-b);
const median = sortedRatios[Math.floor(sortedRatios.length / 2)];
autoTuneFactor[pk] = Math.max(0.5, Math.min(2, median)); // clamp against noisy/small samples
}
console.log('Historical profiles loaded: ' +
PREDICT.parks.map(p => `${Object.keys(profiles[p.key]).length} ${p.key}` +
(autoTuneFactor[p.key] ? ` (auto-tune ×${autoTuneFactor[p.key].toFixed(2)} from ${ratiosByPark[p.key].length} buckets)` : '')).join(', '));
}
} catch(e) {
console.warn('Could not load historical profiles:', e.message);
}
}

// The crowd multiplier actually used for display: the hand-authored table,
// corrected by today's measured drift once there's enough same-day data to
// trust a correction (see loadHistoricalProfiles). This is what "auto-tuning
// the crowd multipliers from measured drift" means in practice — it only
// affects hours estimated from the baseline shape; hours with real per-ride
// data bypass this entirely (see getProfile below).
function effectiveMult(l) {
const base = mult(l);
const factor = autoTuneFactor[park];
return factor ? base * factor : base;
}

function getProfile(ride) {
if (!usingRealData || !historicalProfiles) return { p: ride.p, real: false, band: null };
const rideProfile = historicalProfiles[park]?.[ride.name];
if (!rideProfile) return { p: ride.p, real: false, band: null };
// Real per-hour averages already reflect today's actual day-type/season crowd
// level, so they must NOT be scaled by the crowd multiplier again — every
// caller multiplies this whole array by `m` uniformly, so pre-dividing real
// values by that same `m` here cancels back out to the true measured value,
// while `ride.p[i]` fallback hours (a plain baseline shape) still get scaled
// as intended. `m` is deterministic for a given day, so this matches whatever
// `m` each caller computes independently.
const now = new Date();
const m = effectiveMult(crowdLevel(dayType(now), season(now)));
const filled = rideProfile.map((v, i) => v !== null ? v / m : ride.p[i]);
const band = historicalBands?.[park]?.[ride.name] || null;
return { p: filled, real: true, band };
}

// How much of the CURRENT park's roster is running on real Supabase history
// right now (vs. the hand-authored cold-start curve). A shell can define
// window.onPredictRender(stats) to surface this — e.g. a "still building its
// history" banner that fades out on its own as coverage climbs. Both the
// per-park data-source badge and any shell banner read from here, so the
// honesty on screen always tracks the actual data, never a stale hard-coded
// claim.
function predictCoverage() {
const rides = ridesOf(park);
let real = 0;
if (usingRealData && historicalProfiles && historicalProfiles[park]) {
rides.forEach(r => { if (historicalProfiles[park][r.name]) real++; });
}
return {
park,
parkName: parkCfg(park).name,
totalRides: rides.length,
ridesWithHistory: real,
coverage: rides.length ? real / rides.length : 0,
usingRealData,
autoTune: autoTuneFactor[park] || null
};
}

function getSeason(month) {
if (month === 12 || month === 1) return 'holiday';
if (month >= 6 && month <= 8) return 'summer';
if (month === 3 || month === 4) return 'spring_break';
return 'regular';
}

// ── LIVE WAITS (Queue-Times via Worker proxy) ────────────────────────────────
const WORKER_PROXY = 'https://restless-glade-a1e4.andpcooke.workers.dev/proxy?url=';
// Last-resort fallback if our own Worker is down or over its free-tier request
// ceiling — the Worker is a single point of failure shared by this page, the
// wait-times pages and the Rainmeter widget. Only tried when the Worker fails.
const FALLBACK_PROXY = 'https://api.allorigins.win/raw?url=';

// Returns { ok, status, data } so callers that need the real HTTP status (park
// hours does, to tell a rotted ThemeParks.wiki id apart from a rate limit)
// can see it, instead of just success/failure.
async function fetchProxyStatus(url) {
try {
const r = await fetch(WORKER_PROXY + encodeURIComponent(url), {signal:AbortSignal.timeout(9000)});
if (r.ok) return { ok: true, status: r.status, data: await r.json() };
return { ok: false, status: r.status, data: null };
} catch(e) {
return { ok: false, status: 0, data: null };
}
}
async function fetchProxy(url) {
const primary = await fetchProxyStatus(url);
if (primary.ok) return primary.data;
try {
const r = await fetch(FALLBACK_PROXY + encodeURIComponent(url), {signal:AbortSignal.timeout(9000)});
if (r.ok) {
console.warn('[predict] Worker proxy failed (status ' + primary.status + ') — used fallback CORS proxy for', url);
return JSON.parse(await r.text());
}
} catch(e) {}
return null;
}

// ── SMALL LOCALSTORAGE RESPONSE CACHE ────────────────────────────────────────
// Keeps the last good response around so a transient fetch failure degrades to
// "slightly stale data, clearly labeled" instead of blanking the page.
function cacheGet(key, maxAgeMs) {
try {
const raw = localStorage.getItem(key);
if (!raw) return null;
const { t, v } = JSON.parse(raw);
if (Date.now() - t > maxAgeMs) return null;
return { value: v, ageMs: Date.now() - t };
} catch(e) { return null; }
}
function cacheSet(key, v) {
try { localStorage.setItem(key, JSON.stringify({ t: Date.now(), v })); } catch(e) {}
}
const WAITS_CACHE_MAX_AGE_MS = 20 * 60 * 1000; // generous ceiling above the ~60s normal freshness
// Normalise a ride name for matching: lower-case, unify curly/〝smart〞
// apostrophes and dashes to plain ASCII, collapse whitespace. Queue-Times is
// inconsistent about these (e.g. "Soarin’ Across America" with a curly quote),
// which otherwise breaks the string match against the roster's `qt` value.
function normName(s) {
return String(s == null ? '' : s).toLowerCase()
.replace(/[‘’ʼ`]/g, "'")
.replace(/[–—]/g, '-')
.replace(/\s+/g, ' ')
.trim();
}
function liveCacheKey(parkId) { return `dh_live_cache_${parkId}`; }
async function loadLive(parkId) {
const d = await fetchProxy(`https://queue-times.com/parks/${parkId}/queue_times.json`);
if (!d?.lands) {
const cached = cacheGet(liveCacheKey(parkId), WAITS_CACHE_MAX_AGE_MS);
if (cached) {
console.warn(`[predict] Live fetch failed — showing cached wait times from ${Math.round(cached.ageMs/1000)}s ago`);
return { data: cached.value, stale: true, ageMs: cached.ageMs };
}
return { data: {}, stale: false, ageMs: 0 };
}
const m = {};
for (const land of d.lands)
for (const ride of land.rides)
m[normName(ride.name)] = {wait:ride.wait_time, open:ride.is_open};
cacheSet(liveCacheKey(parkId), m);
return { data: m, stale: false, ageMs: 0 };
}

// ── PARK HOURS (ThemeParks.wiki) ─────────────────────────────────────────────
// parkHours[key] holds an array of { open, close } windows for today. Rides
// run - and Queue-Times keeps posting waits - during regular hours, hard-ticket
// after-hours events (Oogie Boogie Bash, Halloween/holiday parties) and the
// resort early-entry / extended-evening blocks, so all three schedule types
// count as "park open".
const parkHours = {};
const OPEN_SCHEDULE_TYPES = ['OPERATING', 'TICKETED_EVENT', 'EXTRA_HOURS'];
async function loadParkHours(parkKey) {
const cfg = parkCfg(parkKey);
const id = cfg.twId;
if (!id) return;
const url = `https://api.themeparks.wiki/v1/entity/${id}/schedule`;
let res = await fetchProxyStatus(url);
if (!res.ok && res.status !== 404) {
// A 404 means the entity id itself is bad — retrying via a different proxy
// won't fix that. Anything else (network failure, 5xx, rate limit) might be
// our own Worker having a bad moment, so it's worth the fallback proxy.
try {
const r = await fetch(FALLBACK_PROXY + encodeURIComponent(url), {signal:AbortSignal.timeout(9000)});
if (r.ok) { res = { ok:true, status:r.status, data: JSON.parse(await r.text()) }; console.warn('[predict] Worker proxy failed for park hours — used fallback CORS proxy'); }
} catch(e) {}
}
if (!res.ok) {
if (res.status === 404) {
console.error(`[predict] ThemeParks.wiki entity id "${id}" for ${cfg.name} returned 404 — the id has likely rotted. Look up the current one at https://api.themeparks.wiki/v1/destinations and update twId in this page's PREDICT config. Falling back to assuming the park is open (no hours data available).`);
} else if (res.status !== 0) {
console.warn(`[predict] Park hours fetch for ${cfg.name} failed with status ${res.status}. Falling back to assuming the park is open.`);
}
return;
}
const data = res.data;
if (!data?.schedule) return;
const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
const windows = data.schedule
.filter(s => s.date === todayStr && OPEN_SCHEDULE_TYPES.includes(s.type) && s.openingTime && s.closingTime)
.map(s => ({ open: new Date(s.openingTime), close: new Date(s.closingTime) }))
.sort((a, b) => a.open - b.open);
if (!windows.length) return;
parkHours[parkKey] = windows;
console.log(`Park hours loaded for ${parkKey}: ` +
windows.map(w => `${w.open.toLocaleTimeString()}–${w.close.toLocaleTimeString()}`).join(', '));
}
function isParkOpen() {
const windows = parkHours[park];
if (!windows || !windows.length) return true;
const now = new Date();
return windows.some(w => now >= w.open && now < w.close);
}

// ── DAY / SEASON / CROWD MATH ────────────────────────────────────────────────
const HRS = ['6am','7am','8am','9am','10am','11am','12pm','1pm','2pm','3pm','4pm','5pm','6pm','7pm','8pm','9pm','10pm','11pm'];
let park = PREDICT.parks[0].key, live = {}, searchQ = '';

function favsKey() { return `favs_${park}`; }
function loadFavs() { try { return new Set(JSON.parse(localStorage.getItem(favsKey())||'[]')); } catch(e){ return new Set(); } }
function saveFavs(s) { localStorage.setItem(favsKey(), JSON.stringify([...s])); }
let favs = loadFavs();

function tick() {
const n=new Date(); let h=n.getHours(); const m=String(n.getMinutes()).padStart(2,'0'),ap=h>=12?'PM':'AM';
h=h%12||12; document.getElementById('clock').textContent=`${h}:${m} ${ap}`;
}
setInterval(tick,1000); tick();

const hIdx = n => {
const raw = n.getHours() - 6;
const { start, end } = parkOpenRange();
return Math.max(start, Math.min(end, raw));
};
const dayType = n => [0,6].includes(n.getDay())?'Weekend':'Weekday';
const season = n => {
const s = getSeason(n.getMonth() + 1);
return {holiday:'Holiday Season', summer:'Summer', spring_break:'Spring Break', regular:'Regular Season'}[s];
};
const crowdLevel = (d,s) => {if(s==='Holiday Season')return d==='Weekend'?5:4;if(s==='Summer')return d==='Weekend'?5:4;if(s==='Spring Break')return d==='Weekend'?4:3;return d==='Weekend'?3:2;};
const mult = l => ({1:.6,2:.8,3:1,4:1.25,5:1.5})[l];
const status = w => (w===null||w===undefined) ? 'skip' : w<=20?'go':w<=40?'caution':'skip';
const slabel = s => ({go:'Go Now',caution:'Moderate',skip:'Skip'})[s];

function parkOpenRange() {
return { start: 2, end: parkCfg(park).closeIdx ?? 17 };
}

const BLOCKS = [
{ label: 'Mid-Morning', start: 3, end: 4 },
{ label: 'Lunch Break', start: 5, end: 7 },
{ label: 'Afternoon', start: 7, end: 10 },
{ label: 'Late Afternoon', start: 10, end: 12 },
{ label: 'Evening', start: 12, end: 14 },
];

function bestBlock(p, m) {
const { start: pStart, end: pEnd } = parkOpenRange();
const scored = BLOCKS.map(b => {
const s = Math.max(b.start, pStart);
const e = Math.min(b.end, pEnd);
if (s >= e) return { ...b, avg: Infinity };
let sum = 0, count = 0;
for (let i = s; i <= e; i++) { sum += p[i] * m; count++; }
return { ...b, avg: count ? sum / count : Infinity };
}).filter(b => b.avg < Infinity);
if (!scored.length) return 'Afternoon';
scored.sort((a, b) => a.avg - b.avg);
return scored[0].label;
}

function getTrend(p, m, hi) {
const curr = p[hi] * m;
const next1 = p[Math.min(hi + 1, p.length - 1)] * m;
const next2 = p[Math.min(hi + 2, p.length - 1)] * m;
const delta1 = next1 - curr;
const delta2 = next2 - curr;
if (delta1 > 8) return { arrow: '↑', phrase: 'Rising fast — go now', color: 'var(--red)' };
if (delta1 > 3) return { arrow: '↑', phrase: 'Wait climbing', color: 'var(--red)' };
if (delta1 < -8) return { arrow: '↓', phrase: 'Dropping fast — good window', color: 'var(--green)' };
if (delta1 < -3) return { arrow: '↓', phrase: 'Wait easing', color: 'var(--green)' };
if (delta2 > 8) return { arrow: '→', phrase: 'Go soon — gets busy', color: '#c9a000' };
if (delta2 < -8) return { arrow: '→', phrase: 'Gets better soon', color: '#c9a000' };
return { arrow: '→', phrase: 'Holding steady', color: '#c9a000' };
}

function getLive(ride) {
if (!isParkOpen()) return { wait: null, closed: true };
if(!live||!Object.keys(live).length) return {wait:null, closed:false};
const k=normName(ride.qt);
const match = live[k] || Object.entries(live).find(([key])=>key.includes(k.slice(0,10))||k.includes(key.slice(0,10)))?.[1];
if(!match) return {wait:null, closed:false};
if(!match.open) return {wait:null, closed:true};
return {wait:match.wait, closed:false};
}

// ── RENAME WATCHDOG ──────────────────────────────────────────────────────────
// Disney reskins some rides seasonally (Soarin' -> "Soarin' Across America",
// Luigi's -> "Honkin' Haul-O-Ween", etc.), which silently breaks the `qt`
// name match and quietly falls back to the estimated profile. Rather than let
// that drift go unnoticed, flag any roster ride that fails to match a live
// Queue-Times name for several refreshes in a row (a single miss can just be
// the ride being briefly absent from the feed) while the park is confirmed
// open and the live payload looks real. Findings are logged to the console
// and persisted to localStorage so predict-validation.html can surface them
// even though it's a different page load.
const MISMATCH_KEY = 'dh_qt_mismatches';
const MISMATCH_STREAK_THRESHOLD = 3;
const mismatchStreaks = {};
function checkRenameWatchdog() {
if (!isParkOpen()) return;
const liveKeys = Object.keys(live);
if (liveKeys.length < 5) return; // payload too small to trust a "no match" verdict
ridesOf(park).forEach(r => {
const k = normName(r.qt);
const matched = live[k] || liveKeys.some(key => key.includes(k.slice(0,10)) || k.includes(key.slice(0,10)));
const streakKey = `${park}|${r.id}`;
if (matched) { mismatchStreaks[streakKey] = 0; return; }
mismatchStreaks[streakKey] = (mismatchStreaks[streakKey] || 0) + 1;
if (mismatchStreaks[streakKey] === MISMATCH_STREAK_THRESHOLD) {
console.warn(`[predict] "${r.name}" (qt: "${r.qt}") hasn't matched any live Queue-Times name in ${MISMATCH_STREAK_THRESHOLD} refreshes — it may have a seasonal overlay name right now. Check queue-times.com/parks/${parkCfg(park).qtId}/queue_times.json and update its qt value.`);
recordMismatch(r);
}
});
}
function recordMismatch(ride) {
let store;
try { store = JSON.parse(localStorage.getItem(MISMATCH_KEY) || '{}'); } catch(e) { store = {}; }
const key = `${park}|${ride.id}`;
const now = new Date().toISOString();
store[key] = { park, parkName: parkCfg(park).name, id: ride.id, name: ride.name, qt: ride.qt, firstDetected: store[key]?.firstDetected || now, lastSeen: now };
localStorage.setItem(MISMATCH_KEY, JSON.stringify(store));
}

function disneyRound(wait, rideId) {
if (wait === null) return null;
const r5 = Math.max(5, Math.round(wait / 5) * 5);
if (rideId === 'hm' && r5 === 5) return 13;
return r5;
}

function resolveWait(lv, hist, rideId) {
if (lv.closed) return { wait: null, estimated: false };
if (lv.wait !== null) return { wait: disneyRound(lv.wait, rideId), estimated: false };
return { wait: disneyRound(hist, rideId), estimated: true };
}

function sparkline(canvas,p,m,hi) {
const W=canvas.width=canvas.offsetWidth||170, H=canvas.height=24;
const ctx=canvas.getContext('2d');
const vals=p.map(v=>v*m), max=Math.max(...vals,10);
const pts=vals.map((v,i)=>({x:(i/(vals.length-1))*W, y:H-(v/max)*(H-4)-2}));
const g=ctx.createLinearGradient(0,0,0,H);
g.addColorStop(0,'rgba(10,74,74,.14)'); g.addColorStop(1,'rgba(10,74,74,0)');
ctx.beginPath(); ctx.moveTo(pts[0].x,pts[0].y);
pts.slice(1).forEach(p=>ctx.lineTo(p.x,p.y));
ctx.lineTo(pts[pts.length-1].x,H); ctx.lineTo(pts[0].x,H);
ctx.closePath(); ctx.fillStyle=g; ctx.fill();
ctx.beginPath(); ctx.moveTo(pts[0].x,pts[0].y);
pts.slice(1).forEach(p=>ctx.lineTo(p.x,p.y));
ctx.strokeStyle='#0a4a4a'; ctx.lineWidth=1.5; ctx.stroke();
if(hi>=0&&hi<pts.length){ctx.beginPath();ctx.arc(pts[hi].x,pts[hi].y,3.5,0,Math.PI*2);ctx.fillStyle='#c9a84c';ctx.fill();}
}

function makePickCard(r, m, hi) {
const el = document.createElement('div');
el.className = `card ${r.closed?'skip':r.status}`;
el.style.cursor = 'pointer';
el.style.opacity = r.closed ? '0.6' : '1';
el.onclick = e => { if(!e.target.classList.contains('fav-btn')) openModal(r.id); };
const waitRow = r.closed
? `<div style="font-family:'Crimson Pro',serif;font-size:.85rem;color:var(--muted);font-style:italic;margin:.3rem 0 .5rem">Currently closed</div>`
: `<div class="cwait-row"><div class="cwait">${r.estimated?'~':''}${r.wait}<span> min</span></div>${!r.estimated?'<span class="live-tag">LIVE</span>':'<span class="est-tag">EST</span>'}</div>`;
el.innerHTML = `
<div style="display:flex;justify-content:space-between;align-items:flex-start">
<div class="cbadge">${r.closed?'Closed':slabel(r.status)}</div>
<button class="fav-btn on" onclick="event.stopPropagation();toggleFav('${r.id}',this)" title="Remove from My Rides" style="font-size:13px;margin-top:1px">&#9733;</button>
</div>
<div class="cname">${r.name}</div>
<div class="cland">${r.land}</div>
${waitRow}
<canvas class="spark" id="sp-${r.id}-fav"></canvas>
${r.trend?`<div class="ctip" style="color:${r.trend.color};font-style:normal;font-weight:600;margin-top:.38rem">${r.trend.arrow} ${r.trend.phrase}</div>`:''}
<div class="ctip" style="margin-top:.2rem">Tap for full day chart</div>`;
return el;
}

function renderFavs() {
const now=new Date(), dt=dayType(now), s=season(now);
const cl=crowdLevel(dt,s), m=effectiveMult(cl), hi=hIdx(now);
const rides = ridesOf(park);
const section = document.getElementById('fav-section');
const pg = document.getElementById('fav-picks');
pg.innerHTML='';
const favRides = rides
.filter(r=>favs.has(r.id))
.map(r=>{
const lv=getLive(r);
const {p, real} = getProfile(r);
const hist=Math.round(p[hi]*m);
const {wait, estimated}=resolveWait(lv, hist, r.id);
const trend=lv.closed?null:getTrend(p,m,hi);
return {...r, p, real, wait, estimated, status:lv.closed?'closed':status(wait), trend, closed:lv.closed};
})
.sort((a,b)=>{
if(a.closed&&!b.closed) return 1;
if(!a.closed&&b.closed) return -1;
return a.wait-b.wait;
});
section.classList.toggle('visible', favRides.length > 0);
if (!favRides.length) return;
favRides.forEach(r => pg.appendChild(makePickCard(r, m, hi)));
requestAnimationFrame(()=>{
favRides.forEach(r=>{const c=document.getElementById(`sp-${r.id}-fav`);if(c)sparkline(c,r.p,m,hi);});
});
}

function render() {
const now=new Date(), dt=dayType(now), s=season(now);
const cl=crowdLevel(dt,s), m=effectiveMult(cl), hi=hIdx(now);
document.getElementById('ctx-day').textContent=dt;
document.getElementById('ctx-season').textContent=s;
document.getElementById('crowd-lbl').textContent=['','Low','Mild','Moderate','Busy','Very Busy'][cl];
document.querySelectorAll('.dot').forEach((d,i)=>d.classList.toggle('on',i<cl));
const dsBadge = document.getElementById('data-source');
const cov = predictCoverage();
if (usingRealData) {
const tune = autoTuneFactor[park];
dsBadge.textContent = `✦ Real data · ${cov.ridesWithHistory}/${cov.totalRides} rides`
+ (tune ? ` · crowd ×${tune.toFixed(2)} auto-tuned` : '');
dsBadge.style.display = 'inline';
dsBadge.style.background = 'rgba(45,106,45,.18)';
dsBadge.style.color = 'var(--green)';
dsBadge.style.border = '1px solid rgba(45,106,45,.25)';
} else {
dsBadge.textContent = '~ Estimated profile';
dsBadge.style.display = 'inline';
dsBadge.style.background = 'rgba(138,110,47,.12)';
dsBadge.style.color = 'var(--muted)';
dsBadge.style.border = '1px solid rgba(138,110,47,.2)';
}
const rides = ridesOf(park);
const computed = rides.map(r=>{
const lv=getLive(r);
const {p, real} = getProfile(r);
const hist=Math.round(p[hi]*m);
const {wait, estimated}=resolveWait(lv, hist, r.id);
const trend=lv.closed?null:getTrend(p,m,hi);
return {...r, p, real, wait, estimated, status:lv.closed?'closed':status(wait), trend, closed:lv.closed};
});
const picks=[...computed].filter(r=>r.status==='go').sort((a,b)=>a.wait-b.wait).slice(0,4);
document.getElementById('picks-sub').textContent = picks.length
? `rides worth heading to around ${HRS[hi]}`
: `all rides are busy around ${HRS[hi]} — see best windows below`;
const pg=document.getElementById('picks');
pg.innerHTML='';
if(!picks.length) {
pg.innerHTML='<div style="grid-column:1/-1;font-style:italic;color:var(--muted);font-size:.82rem;padding:.4rem 0">No short waits right now. Check the best windows in the table below.</div>';
} else {
picks.forEach(r=>{
const el=document.createElement('div');
el.className=`card ${r.status}`;
el.style.cursor='pointer';
el.onclick=()=>openModal(r.id);
el.innerHTML=`
<div class="cbadge">${slabel(r.status)}</div>
<div class="cname">${r.name}</div>
<div class="cland">${r.land}</div>
<div class="cwait-row">
<div class="cwait">${r.estimated?'~':''}${r.wait}<span> min</span></div>
${!r.estimated?'<span class="live-tag">LIVE</span>':'<span class="est-tag">EST</span>'}
</div>
<canvas class="spark" id="sp-${r.id}"></canvas>
${r.trend?`<div class="ctip" style="color:${r.trend.color};font-style:normal;font-weight:600">${r.trend.arrow} ${r.trend.phrase}</div>`:''}
<div class="ctip" style="margin-top:.2rem">Tap for full day chart</div>`;
pg.appendChild(el);
});
requestAnimationFrame(()=>{
picks.forEach(r=>{const c=document.getElementById(`sp-${r.id}`);if(c)sparkline(c,r.p,m,hi);});
});
}
const ag=document.getElementById('grid');
ag.innerHTML='';
[...computed].sort((a,b)=>{
if(a.closed && !b.closed) return 1;
if(!a.closed && b.closed) return -1;
return a.wait-b.wait;
}).forEach(r=>{
const row=document.createElement('div');
row.className='row'+(searchQ&&!r.name.toLowerCase().includes(searchQ)&&!r.land.toLowerCase().includes(searchQ)?' hide':'')+(r.closed?' closed-row':'');
row.dataset.name=r.name.toLowerCase();
row.dataset.land=r.land.toLowerCase();
row.style.cursor='pointer';
row.onclick = e => { if(!e.target.classList.contains('fav-btn')) openModal(r.id); };
const waitDisplay = r.closed
? `<div class="rwait" style="color:var(--muted);font-size:.72rem;font-weight:400;font-style:italic">Closed</div><div class="rbest">&nbsp;</div>`
: `<div class="rwait">${r.estimated?'~':''}${r.wait}<small> min ${r.estimated?'<span style="opacity:.55">est</span>':'●'}</small></div>
<div class="rbest" style="color:${r.trend.color}">${r.trend.arrow} ${r.trend.phrase}</div>`;
row.innerHTML=`
<div class="rdot ${r.closed ? 'closed' : r.status}"></div>
<div class="rcol">
<div class="rname" style="${r.closed?'opacity:.5':''}">${r.name}</div>
<div class="rland">${r.land}</div>
</div>
<div class="rright">${waitDisplay}</div>
<button class="fav-btn${favs.has(r.id)?' on':''}" onclick="event.stopPropagation();toggleFav('${r.id}',this)" title="${favs.has(r.id)?'Remove from My Rides':'Add to My Rides'}">&#9733;</button>`;
ag.appendChild(row);
});
const nr=document.createElement('div');
nr.className='noresult'; nr.id='nores'; nr.textContent='No rides match your search.';
const visCount=[...ag.querySelectorAll('.row')].filter(r=>!r.classList.contains('hide')).length;
if(!visCount) nr.style.display='block';
ag.appendChild(nr);
renderFavs();
renderLL();
if (typeof window.onPredictRender === 'function') {
try { window.onPredictRender(predictCoverage()); } catch(e) { console.warn('onPredictRender threw:', e); }
}
}

function toggleFav(id, btn) {
if (favs.has(id)) { favs.delete(id); } else { favs.add(id); }
saveFavs(favs);
render();
}

// ── LIGHTNING LANE ADVISOR ────────────────────────────────────────────────────
const LL_THRESHOLD_SKIP = 35;
const LL_TOP_N = 5;
let llOpen = false;

function toggleLL() {
llOpen = !llOpen;
document.getElementById('ll-body').classList.toggle('open', llOpen);
document.getElementById('ll-collapsed').style.display = llOpen ? 'none' : '';
const btn = document.getElementById('ll-toggle');
btn.textContent = llOpen ? 'Hide ▴' : 'Show ▾';
btn.classList.toggle('open', llOpen);
}

function peakHour(p, m) {
const { start, end } = parkOpenRange();
let maxV = -1, maxI = start;
for (let i = start; i <= end; i++) {
const v = p[i] * m;
if (v > maxV) { maxV = v; maxI = i; }
}
return { idx: maxI, label: HRS[maxI], wait: Math.round(maxV) };
}

function bestStandbyWindow(p, m) {
const { start, end } = parkOpenRange();
let bestAvg = Infinity, bestHour = start;
for (let i = start; i <= end - 1; i++) {
const avg = (p[i] + p[i+1]) * m / 2;
if (avg < bestAvg) { bestAvg = avg; bestHour = i; }
}
return { label: `${HRS[bestHour]}–${HRS[Math.min(bestHour+1,17)]}`, avg: Math.round(bestAvg) };
}

function llScore(p, m) {
const { start, end } = parkOpenRange();
const vals = [];
for (let i = start; i <= end; i++) vals.push(Math.round(p[i] * m));
const max = Math.max(...vals);
const min = Math.min(...vals);
const spread = max - min;
return Math.round(spread * (max / 50));
}

function suggestedBookTime(peakIdx) {
const bookIdx = Math.max(2, peakIdx - 2);
return HRS[bookIdx];
}

function renderLL() {
const now = new Date();
const dt = dayType(now), s = season(now);
const cl = crowdLevel(dt, s), m = effectiveMult(cl);
const rides = ridesOf(park);

const scored = rides.map(r => {
const { p } = getProfile(r);
const score = llScore(p, m);
const peak = peakHour(p, m);
const standby = bestStandbyWindow(p, m);
const lv = getLive(r);
return { ...r, p, score, peak, standby, closed: lv.closed };
})
.filter(r => r.ll && !r.closed && r.peak.wait >= LL_THRESHOLD_SKIP)
.sort((a, b) => b.score - a.score);

const top = scored.slice(0, LL_TOP_N);
const section = document.getElementById('ll-section');

if (!top.length) {
section.classList.remove('visible');
return;
}
section.classList.add('visible');

const maxScore = top[0].score;
document.getElementById('ll-sub').textContent =
`top picks for ${parkCfg(park).name} today`;

const names = top.slice(0,2).map(r => r.name.split(' ').slice(0,2).join(' ')).join(' & ');
const collapsedEl = document.getElementById('ll-collapsed');
collapsedEl.textContent = `Prioritize: ${names}${top.length > 2 ? ` + ${top.length - 2} more` : ''}. Tap "Show" for booking sequence.`;
collapsedEl.style.display = llOpen ? 'none' : '';

// Ranked grid
const grid = document.getElementById('ll-grid');
grid.innerHTML = '';
top.forEach((r, idx) => {
const pct = Math.round((r.score / maxScore) * 100);
const valueTier = pct >= 75 ? 'll-val-high' : pct >= 45 ? 'll-val-med' : 'll-val-low';
const valueLabel = pct >= 75 ? 'High Value' : pct >= 45 ? 'Moderate' : 'Lower';
const bookAt = suggestedBookTime(r.peak.idx);
const card = document.createElement('div');
card.className = 'll-card';
card.onclick = () => openModal(r.id);
card.innerHTML = `
<div class="ll-rank">#${idx+1}</div>
<div class="ll-info">
<div class="ll-name">${r.name}</div>
<div class="ll-land">${r.land}</div>
<div class="ll-meta">
<span>Peak ~${r.peak.wait} min @ ${r.peak.label}</span>
<span class="ll-book-time">⚡ Book by ${bookAt}</span>
</div>
</div>
<div class="ll-score-col">
<div class="ll-score-bar-wrap"><div class="ll-score-bar" style="width:${pct}%"></div></div>
<div class="ll-score-label ${valueTier}">${valueLabel}</div>
</div>`;
grid.appendChild(card);
});

// Suggested stack (top 3, sorted by earliest peak)
const stack = top.slice(0, 3).sort((a, b) => a.peak.idx - b.peak.idx);
const stackEl = document.getElementById('ll-stack');
stackEl.innerHTML = '';
const stepLabels = ['First', 'Second', 'Third'];
const stepTips = [
'Book at rope drop or as soon as park opens',
'Book right after redeeming your first LL',
'Book ~1hr before park hits full crowd'
];
stack.forEach((r, idx) => {
const bookAt = suggestedBookTime(r.peak.idx);
const stepEl = document.createElement('div');
stepEl.className = 'll-step';
stepEl.innerHTML = `
${idx > 0 ? '<div class="ll-arrow">→</div>' : ''}
<div class="ll-step-card">
<div class="ll-step-num">Book ${stepLabels[idx]}</div>
<div class="ll-step-name">${r.name}</div>
<div class="ll-step-time">⚡ Target: ${bookAt}</div>
<div class="ll-step-tip">${stepTips[idx]}</div>
</div>`;
stackEl.appendChild(stepEl);
});

// Standby note: LL-eligible rides whose peak is low enough to skip burning a LL
const standbyRides = rides
.map(r => {
const { p } = getProfile(r);
const lv = getLive(r);
if (lv.closed) return null;
if (!r.ll) return null; // only LL rides are relevant here
const pk = peakHour(p, m);
if (pk.wait >= LL_THRESHOLD_SKIP) return null; // already in LL targets above
const sb = bestStandbyWindow(p, m);
return { name: r.name, sb };
})
.filter(Boolean)
.sort((a, b) => a.sb.avg - b.sb.avg)
.slice(0, 3);

// Quietest overall windows
const allP = rides.slice(0, 8).map(r => getProfile(r).p);
const { start, end } = parkOpenRange();
const freeWindows = [];
for (let i = start; i <= end; i++) {
const avg = allP.reduce((sum, p) => sum + p[i] * m, 0) / allP.length;
freeWindows.push({ i, avg });
}
freeWindows.sort((a, b) => a.avg - b.avg);
const quietTimes = freeWindows.slice(0, 2).map(f => HRS[f.i]);

const noteEl = document.getElementById('ll-standby-note');
noteEl.innerHTML = standbyRides.length
? `<strong>Save LL For:</strong> The rides above — real wait savings at peak.&nbsp;&nbsp;
   <strong>Skip LL On:</strong> ${standbyRides.map(r=>`${r.name.split(' ').slice(0,3).join(' ')} (~${r.sb.avg} min standby around ${r.sb.label})`).join(', ')}.&nbsp;&nbsp;
   <strong>Quietest Standby Windows:</strong> ${quietTimes.join(' and ')}.`
: `<strong>Quietest Standby Windows:</strong> ${quietTimes.join(' and ')} — ride the high-value stuff during these windows to stretch your LL budget.`;
}

// ── DETAIL MODAL ─────────────────────────────────────────────────────────────
function openModal(id) {
const rides = ridesOf(park);
const r = rides.find(x=>x.id===id);
if (!r) return;
const now=new Date(), dt=dayType(now), s=season(now);
const cl=crowdLevel(dt,s), m=effectiveMult(cl), hi=hIdx(now);
const {start, end} = parkOpenRange();
const {p, real, band} = getProfile(r);
const hourBand = band ? band[hi] : null;
document.getElementById('modal-name').textContent = r.name;
document.getElementById('modal-land').textContent = r.land + (real ? ' · ✦ real data' : ' · est. profile');
const openVals = p.slice(start, end+1).map(v=>disneyRound(Math.round(v*m), r.id));
const minWait = Math.min(...openVals);
const maxWait = Math.max(...openVals);
const lv=getLive(r);
const isClosed=lv.closed;
const hist=Math.round(p[hi]*m);
const {wait: nowWait, estimated: nowEst} = resolveWait(lv, hist, r.id);
const trend = isClosed ? null : getTrend(p, m, hi);
const heatHours = [];
for (let i = start; i <= end; i++) heatHours.push(i);
const heatMax = Math.max(...heatHours.map(i => p[i]*m), 1);
const heatCells = heatHours.map(i => {
const v = p[i]*m / heatMax;
const r_ = Math.round(30 + v*180);
const g_ = Math.round(106 - v*76);
const b_ = Math.round(45 - v*15);
const isCur = i === hi;
return `<div style="flex:1;height:${isCur?'22px':'16px'};border-radius:2px;background:rgb(${r_},${g_},${b_});opacity:${isCur?1:.75};position:relative;transition:height .2s;${isCur?'box-shadow:0 0 0 2px #c9a84c;':''}"></div>`;
}).join('');
const heatLabels = heatHours.filter((_,i)=>i%2===0).map(i=>`<div style="flex:1;font-size:9px;color:var(--muted);text-align:center;font-family:serif">${HRS[i]}</div>`).join('');
document.getElementById('modal-stats').innerHTML = `
<div class="modal-stat">
<div class="modal-stat-lbl">Right Now</div>
<div class="modal-stat-val" style="${isClosed?'font-size:.8rem;color:var(--muted)':''}">${isClosed?'Closed':(nowEst?'~':'')+nowWait+' min'}</div>
<div class="modal-stat-sub" style="color:${trend?trend.color:'inherit'}">${isClosed?'check back later':trend?`${trend.arrow} ${trend.phrase}`:''}</div>
</div>
${hourBand && !isClosed ? `<div class="modal-stat">
<div class="modal-stat-lbl">Typical Range</div>
<div class="modal-stat-val">${hourBand.p25}–${hourBand.p75} min</div>
<div class="modal-stat-sub">25th–75th pctile, this hour</div>
</div>` : ''}
<div class="modal-stat">
<div class="modal-stat-lbl">Today's Low</div>
<div class="modal-stat-val">${minWait} min</div>
<div class="modal-stat-sub">see chart for timing</div>
</div>
<div class="modal-stat">
<div class="modal-stat-lbl">Today's Peak</div>
<div class="modal-stat-val">${maxWait} min</div>
<div class="modal-stat-sub">avoid if possible</div>
</div>
<div style="width:100%;margin-top:.5rem">
<div style="font-family:'Cinzel',serif;font-size:.52rem;letter-spacing:.09em;color:var(--muted);text-transform:uppercase;margin-bottom:.3rem">Wait heat — today</div>
<div style="display:flex;gap:2px;align-items:flex-end;height:24px">${heatCells}</div>
<div style="display:flex;gap:0;margin-top:3px">${heatLabels}</div>
</div>`;
document.getElementById('modal-backdrop').classList.add('open');
requestAnimationFrame(()=>drawModalChart(p, m, hi, start, end));
}

function drawModalChart(p, m, hi, start, end) {
const canvas = document.getElementById('modal-canvas');
const W = canvas.width = canvas.offsetWidth || 480;
const H = canvas.height = canvas.offsetHeight || 160;
const ctx = canvas.getContext('2d');
ctx.clearRect(0,0,W,H);
const PAD = {top:12, right:10, bottom:28, left:36};
const cW = W - PAD.left - PAD.right;
const cH = H - PAD.top - PAD.bottom;
const openP = p.slice(start, end+1);
const openHRS = HRS.slice(start, end+1);
const vals = openP.map(v=>Math.round(v*m));
const maxV = Math.max(...vals, 20);
const n = vals.length;
const px = i => PAD.left + (i/(n-1))*cW;
const py = v => PAD.top + cH - (v/maxV)*cH;
ctx.strokeStyle='rgba(138,110,47,.15)'; ctx.lineWidth=1;
[0,.25,.5,.75,1].forEach(f=>{
const y=PAD.top+cH*(1-f);
ctx.beginPath(); ctx.moveTo(PAD.left,y); ctx.lineTo(PAD.left+cW,y); ctx.stroke();
ctx.fillStyle='rgba(90,74,42,.5)'; ctx.font='9px serif'; ctx.textAlign='right';
ctx.fillText(Math.round(maxV*f), PAD.left-4, y+3);
});
const grad=ctx.createLinearGradient(0,PAD.top,0,PAD.top+cH);
grad.addColorStop(0,'rgba(10,74,74,.18)'); grad.addColorStop(1,'rgba(10,74,74,.02)');
ctx.beginPath(); ctx.moveTo(px(0),py(vals[0]));
vals.forEach((_,i)=>ctx.lineTo(px(i),py(vals[i])));
ctx.lineTo(px(n-1),PAD.top+cH); ctx.lineTo(px(0),PAD.top+cH);
ctx.closePath(); ctx.fillStyle=grad; ctx.fill();
ctx.beginPath(); ctx.moveTo(px(0),py(vals[0]));
vals.forEach((_,i)=>ctx.lineTo(px(i),py(vals[i])));
ctx.strokeStyle='#0a4a4a'; ctx.lineWidth=2; ctx.stroke();
ctx.fillStyle='rgba(90,74,42,.65)'; ctx.font='9px serif'; ctx.textAlign='center';
openHRS.forEach((lbl,i)=>{ if(i%2===0) ctx.fillText(lbl, px(i), H-6); });
const curIdx = hi - start;
if (curIdx >= 0 && curIdx < n) {
ctx.beginPath(); ctx.moveTo(px(curIdx),PAD.top); ctx.lineTo(px(curIdx),PAD.top+cH);
ctx.strokeStyle='rgba(201,168,76,.4)'; ctx.lineWidth=1.5; ctx.setLineDash([3,3]); ctx.stroke();
ctx.setLineDash([]);
ctx.beginPath(); ctx.arc(px(curIdx),py(vals[curIdx]),5,0,Math.PI*2);
ctx.fillStyle='#c9a84c'; ctx.fill();
ctx.strokeStyle='#fff'; ctx.lineWidth=1.5; ctx.stroke();
}
}

function closeModal(e) {
if (e && e.target !== document.getElementById('modal-backdrop')) return;
document.getElementById('modal-backdrop').classList.remove('open');
}
document.addEventListener('keydown', e=>{ if(e.key==='Escape') document.getElementById('modal-backdrop').classList.remove('open'); });

function filter(q) {
searchQ=q.toLowerCase().trim();
document.querySelectorAll('.row').forEach(r=>{
const match=!searchQ||r.dataset.name.includes(searchQ)||r.dataset.land.includes(searchQ);
r.classList.toggle('hide',!match);
});
const nores=document.getElementById('nores');
if(nores){
const vis=[...document.querySelectorAll('.row')].filter(r=>!r.classList.contains('hide')).length;
nores.style.display=vis?'none':'block';
}
}

function setLoading(on) {
document.getElementById('loading-overlay').classList.toggle('visible', on);
document.getElementById('main-content').classList.toggle('hidden', on);
}

async function refresh() {
const badge=document.getElementById('badge');
badge.textContent='● FETCHING'; badge.className='badge stale';
const {data, stale, ageMs}=await loadLive(parkCfg(park).qtId);
if(data&&Object.keys(data).length){
live=data;
if (stale) {
badge.textContent='● CACHED'; badge.className='badge stale';
document.getElementById('updated').textContent=`Live fetch failed — showing wait times from ${Math.round(ageMs/60000)} min ago`;
} else {
badge.textContent='● LIVE'; badge.className='badge';
const n=new Date();
document.getElementById('updated').textContent=`Live data as of ${n.toLocaleTimeString([],{hour:'numeric',minute:'2-digit'})}`;
checkRenameWatchdog();
}
} else {
badge.textContent='● HISTORICAL'; badge.className='badge err';
document.getElementById('updated').textContent='Live data unavailable — showing historical estimates only';
}
render();
setLoading(false);
if (document.getElementById('modal-backdrop').classList.contains('open')) {
const rides=ridesOf(park);
const name=document.getElementById('modal-name').textContent;
const r=rides.find(x=>x.name===name);
if(r) openModal(r.id);
}
}

function switchPark(key) {
park=key; live={}; searchQ='';
favs = loadFavs();
llOpen = false;
document.getElementById('ll-body').classList.remove('open');
document.getElementById('ll-toggle').textContent = 'Show ▾';
document.getElementById('ll-toggle').classList.remove('open');
document.querySelectorAll('.tab').forEach(t=>t.classList.toggle('on', t.dataset.park === key));
document.getElementById('q').value='';
setLoading(true);
// Deliberately NOT re-calling loadHistoricalProfiles() here: it always fetches
// every park in PREDICT.parks in one go (see its own comment), so the initial
// page-load call already cached every park's data for today. Re-running it on
// every tab switch used to re-fetch every park's data again just to switch
// which one is on screen — the actual waste the 2026-09-05 Supabase-egress
// review flagged. The 24h interval at the bottom of this file still refreshes
// everything once the day/season rolls over.
loadParkHours(key).then(() => refresh());
}

// Inline oninput="" / onclick="" handlers in the shell markup call these by name.
window.switchPark = switchPark;
window.toggleFav = toggleFav;
window.toggleLL = toggleLL;
window.filter = filter;
window.closeModal = closeModal;
window.openModal = openModal;

// ── BUILD TABS + INIT ────────────────────────────────────────────────────────
(function buildTabs() {
const wrap = document.getElementById('tabs');
if (!wrap) return;
wrap.innerHTML = '';
PREDICT.parks.forEach((p, i) => {
const b = document.createElement('button');
b.className = 'tab' + (i === 0 ? ' on' : '');
b.dataset.park = p.key;
b.textContent = p.tabLabel || p.name;
b.addEventListener('click', () => switchPark(p.key));
wrap.appendChild(b);
});
})();

Promise.all([
...PREDICT.parks.map(p => loadParkHours(p.key)),
loadHistoricalProfiles()
]).then(() => {
refresh();
setInterval(refresh, 5*60*1000);
setInterval(render, 60*1000);
setInterval(() => {
PREDICT.parks.forEach(p => loadParkHours(p.key));
loadHistoricalProfiles();
}, 24*60*60*1000);
});
