// Per-ride live status from ThemeParks.wiki, used to tell a real unscheduled
// breakdown (status DOWN) apart from a scheduled closure (REFURBISHMENT) or
// just being outside today's operating hours (CLOSED) -- something Queue-
// Times' plain open/closed flag can't distinguish on its own. Feeds
// ride_downtime_stats (see that migration) for the predictor's "average
// downtime when it breaks" stat.
//
// Reuses the same twId entity ids already hand-verified and used client-side
// in predict.html/wdwpredict.html for park-hours lookups.

import { normName } from './rideAlerts.ts';

export const PARK_TWID: Record<string, string> = {
  dl:    '7340550b-c14d-4def-80bb-acdb51d49a66',
  dca:   '832fcd51-ea19-4e77-85c7-75d5843b127c',
  mk:    '75ea578a-adc8-4116-a54d-dccb60765ef9',
  epcot: '47f90d2c-e191-4239-a466-5892ef59a88b',
  hs:    '288747d1-8b4f-4a64-867e-ea7c9b27bad8',
  ak:    '1c84a229-8862-4648-9c71-378ddd2c7693',
};

// Fetches one park's live attraction statuses and returns a normName()-keyed
// map (ThemeParks.wiki attraction name -> status string: OPERATING, DOWN,
// CLOSED, or REFURBISHMENT). Returns null on any failure -- a missing status
// map just means this run's rows get status: null, same "skip, don't fail
// the pipeline" treatment as the ride-alerts check gets.
export async function fetchLiveStatusMap(twId: string): Promise<Record<string, string> | null> {
  try {
    const res = await fetch(`https://api.themeparks.wiki/v1/entity/${twId}/live`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const map: Record<string, string> = {};
    for (const e of data.liveData ?? []) {
      if (e.entityType === 'ATTRACTION' && typeof e.name === 'string' && typeof e.status === 'string') {
        map[normName(e.name)] = e.status;
      }
    }
    return map;
  } catch (err) {
    console.error(`fetchLiveStatusMap(${twId}) failed:`, (err as Error).message);
    return null;
  }
}

// Same loose match as rideAlerts.ts's findLive(): exact normName first, else
// a 10-char substring either direction, since ThemeParks.wiki's own ride
// names don't always match Queue-Times' character-for-character (this has
// no access to either roster's hand-curated `qt`/`aliases` -- browser-only
// data, no build step to share it here).
//
// Found 2026-11-19 (Luigi's Rollickin' Roadsters / Mater's Junkyard
// Jamboree at DCA): unlike rideAlerts.ts's findLive(), both names compared
// here can be long AND independently seasonally overlaid at once -- Queue-
// Times calling a ride "Luigi's Rollickin' Roadsters" while ThemeParks.wiki
// calls the same ride "Luigi's Joy to the Whirl" for the holidays. Their
// only common ground is the short leading stem ("luigi's"), which a fixed
// 10-char prefix test can miss entirely since each name diverges from the
// other well before character 10. Falls back to comparing just the first
// word (5+ chars, to avoid a generic word like "the" causing a false
// match) when the straight prefix test finds nothing.
function firstWord(s: string): string { return s.split(' ')[0]; }
export function findStatus(map: Record<string, string>, rideName: string): string | null {
  const k = normName(rideName);
  if (map[k]) return map[k];
  const kFirst = firstWord(k);
  for (const key of Object.keys(map)) {
    if (key.includes(k.slice(0, 10)) || k.includes(key.slice(0, 10))) return map[key];
  }
  if (kFirst.length >= 5) {
    for (const key of Object.keys(map)) {
      if (firstWord(key) === kFirst) return map[key];
    }
  }
  return null;
}
