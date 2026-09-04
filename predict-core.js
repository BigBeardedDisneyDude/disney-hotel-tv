/* predict-core.js
 * --------------------------------------------------------------------------
 * Shared behaviour for the ride-wait predictor pages:
 *   predict.html      (Disneyland Resort - Disneyland + California Adventure)
 *   wdwpredict.html   (Walt Disney World - planned)
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
let usingRealData = false;

async function loadHistoricalProfiles() {
if (SUPABASE_URL === 'YOUR_SUPABASE_URL') return;
const now = new Date();
const pt = new Date(now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
const dow = pt.getDay();
const season = getSeason(pt.getMonth() + 1);
const params = new URLSearchParams({
select: 'park,ride_name,hour_of_day,wait_time',
day_of_week: `eq.${dow}`,
season: `eq.${season}`,
is_open: 'eq.true',
wait_time: 'gte.0',
order: 'ride_name,hour_of_day'
});
try {
const res = await fetch(`${SUPABASE_URL}/rest/v1/wait_times?${params}`, {
headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
signal: AbortSignal.timeout(8000)
});
if (!res.ok) throw new Error(`Supabase ${res.status}`);
const rows = await res.json();
if (!rows.length) return;
const buckets = {};
for (const row of rows) {
const key = `${row.park}|${row.ride_name}|${row.hour_of_day}`;
if (!buckets[key]) buckets[key] = [];
buckets[key].push(row.wait_time);
}
const profiles = {};
PREDICT.parks.forEach(p => { profiles[p.key] = {}; });
for (const [key, waits] of Object.entries(buckets)) {
if (waits.length < MIN_SAMPLES) continue;
const [pk, rideName, hourStr] = key.split('|');
if (!profiles[pk]) continue;             // a park this page doesn't show
const hour = parseInt(hourStr);
const idx = hour - 6;
if (idx < 0 || idx > 17) continue;
if (!profiles[pk][rideName]) profiles[pk][rideName] = new Array(18).fill(null);
profiles[pk][rideName][idx] = Math.round(waits.reduce((a,b)=>a+b,0) / waits.length);
}
const covered = PREDICT.parks.some(p =>
Object.keys(profiles[p.key]).length / Math.max(p.rides.length, 1) > 0.5);
if (covered) {
historicalProfiles = profiles;
usingRealData = true;
console.log('Historical profiles loaded: ' +
PREDICT.parks.map(p => `${Object.keys(profiles[p.key]).length} ${p.key}`).join(', '));
}
} catch(e) {
console.warn('Could not load historical profiles:', e.message);
}
}

function getProfile(ride) {
if (!usingRealData || !historicalProfiles) return { p: ride.p, real: false };
const rideProfile = historicalProfiles[park]?.[ride.name];
if (!rideProfile) return { p: ride.p, real: false };
const filled = rideProfile.map((v, i) => v !== null ? v : ride.p[i]);
return { p: filled, real: true };
}

function getSeason(month) {
if (month === 12 || month === 1) return 'holiday';
if (month >= 6 && month <= 8) return 'summer';
if (month === 3 || month === 4) return 'spring_break';
return 'regular';
}

// ── LIVE WAITS (Queue-Times via Worker proxy) ────────────────────────────────
const WORKER_PROXY = 'https://restless-glade-a1e4.andpcooke.workers.dev/proxy?url=';
async function fetchProxy(url) {
try {
const r = await fetch(WORKER_PROXY + encodeURIComponent(url), {signal:AbortSignal.timeout(9000)});
if (r.ok) return await r.json();
} catch(e) {}
return null;
}
async function loadLive(parkId) {
const d = await fetchProxy(`https://queue-times.com/parks/${parkId}/queue_times.json`);
if (!d?.lands) return {};
const m = {};
for (const land of d.lands)
for (const ride of land.rides)
m[ride.name.toLowerCase().trim()] = {wait:ride.wait_time, open:ride.is_open};
return m;
}

// ── PARK HOURS (ThemeParks.wiki) ─────────────────────────────────────────────
const parkHours = {};
async function loadParkHours(parkKey) {
const id = parkCfg(parkKey).twId;
if (!id) return;
const url = `https://api.themeparks.wiki/v1/entity/${id}/schedule`;
const data = await fetchProxy(url);
if (!data?.schedule) return;
const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
const today = data.schedule.find(s => s.date === todayStr && s.type === 'OPERATING');
if (!today) return;
parkHours[parkKey] = {
open: new Date(today.openingTime),
close: new Date(today.closingTime)
};
console.log(`Park hours loaded for ${parkKey}: ${today.openingTime} – ${today.closingTime}`);
}
function isParkOpen() {
const hours = parkHours[park];
if (!hours?.open || !hours?.close) return true;
const now = new Date();
return now >= hours.open && now < hours.close;
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
const k=ride.qt.toLowerCase().trim();
const match = live[k] || Object.entries(live).find(([key])=>key.includes(k.slice(0,10))||k.includes(key.slice(0,10)))?.[1];
if(!match) return {wait:null, closed:false};
if(!match.open) return {wait:null, closed:true};
return {wait:match.wait, closed:false};
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
const cl=crowdLevel(dt,s), m=mult(cl), hi=hIdx(now);
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
const cl=crowdLevel(dt,s), m=mult(cl), hi=hIdx(now);
document.getElementById('ctx-day').textContent=dt;
document.getElementById('ctx-season').textContent=s;
document.getElementById('crowd-lbl').textContent=['','Low','Mild','Moderate','Busy','Very Busy'][cl];
document.querySelectorAll('.dot').forEach((d,i)=>d.classList.toggle('on',i<cl));
const dsBadge = document.getElementById('data-source');
if (usingRealData) {
dsBadge.textContent = '✦ Real historical data';
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
const cl = crowdLevel(dt, s), m = mult(cl);
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
const cl=crowdLevel(dt,s), m=mult(cl), hi=hIdx(now);
const {start, end} = parkOpenRange();
const {p, real} = getProfile(r);
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
const data=await loadLive(parkCfg(park).qtId);
if(data&&Object.keys(data).length){
live=data;
badge.textContent='● LIVE'; badge.className='badge';
const n=new Date();
document.getElementById('updated').textContent=`Live data as of ${n.toLocaleTimeString([],{hour:'numeric',minute:'2-digit'})}`;
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
historicalProfiles = null;
usingRealData = false;
llOpen = false;
document.getElementById('ll-body').classList.remove('open');
document.getElementById('ll-toggle').textContent = 'Show ▾';
document.getElementById('ll-toggle').classList.remove('open');
document.querySelectorAll('.tab').forEach(t=>t.classList.toggle('on', t.dataset.park === key));
document.getElementById('q').value='';
setLoading(true);
Promise.all([
loadParkHours(key),
loadHistoricalProfiles()
]).then(() => refresh());
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
