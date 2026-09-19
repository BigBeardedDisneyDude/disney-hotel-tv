// Supabase Edge Function: collect-waits
// Deploy with: supabase functions deploy collect-waits
// Then schedule via Supabase Dashboard > Integrations > Cron

import { alertOnFailure } from '../_shared/alerts.ts';
import { isRide } from '../_shared/nonRideFilter.ts';

const PARKS: Record<string, number> = {
  dl: 16, dca: 17,
  mk: 6, epcot: 5, hs: 7, ak: 8,
};

// Anonymous Gregorian algorithm (Meeus/Jones/Butcher) for Easter Sunday.
// Kept in sync by hand with the identical copy in dh-season.js (no build
// step to share code between browser JS and this Deno function) — see that
// file's header comment for why spring_break is Easter-relative rather
// than a fixed month.
function computeEaster(year: number): Date {
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

const SPRING_BREAK_DAYS_BEFORE_EASTER = 21;
const SPRING_BREAK_DAYS_AFTER_EASTER = 14;

function isSpringBreak(date: Date): boolean {
  const easter = computeEaster(date.getFullYear());
  const dayOnly = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const diffDays = Math.round((dayOnly.getTime() - easter.getTime()) / 86400000);
  return diffDays >= -SPRING_BREAK_DAYS_BEFORE_EASTER && diffDays <= SPRING_BREAK_DAYS_AFTER_EASTER;
}

function getContext(date: Date) {
  const pt = new Date(date.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
  const month = pt.getMonth() + 1;
  const dow   = pt.getDay();
  const hour  = pt.getHours();

  let season: string;
  if (month === 12 || month === 1)       season = 'holiday';
  else if (month >= 6 && month <= 8)     season = 'summer';
  else if (isSpringBreak(pt))            season = 'spring_break';
  else                                   season = 'regular';

  return {
    day_of_week: dow,
    hour_of_day: hour,
    month,
    is_weekend: dow === 0 || dow === 6,
    season,
  };
}

Deno.serve(async (_req: Request) => {
  const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
  const SUPABASE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

  const now = new Date();
  const ctx = getContext(now);
  const rows: object[] = [];
  // Every park that failed to fetch is a silent gap in the prediction history
  // unless we surface it — collected here so the response (and therefore any
  // cron/monitoring that checks the status code) can flag it.
  const failedParks: string[] = [];
  let nonRidesSkipped = 0;

  for (const [park, parkId] of Object.entries(PARKS)) {
    let data: any;
    try {
      const res = await fetch(
        `https://queue-times.com/parks/${parkId}/queue_times.json`,
        { signal: AbortSignal.timeout(8000) }
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      data = await res.json();
    } catch (err) {
      console.error(`Failed to fetch ${park}:`, err.message);
      failedParks.push(park);
      continue;
    }

    for (const land of data.lands ?? []) {
      for (const ride of land.rides ?? []) {
        if (!isRide(ride.name, park)) {
          nonRidesSkipped++;
          continue;
        }
        rows.push({
          park,
          ride_name:   ride.name,
          wait_time:   ride.is_open ? (ride.wait_time ?? 0) : null,
          is_open:     ride.is_open,
          recorded_at: now.toISOString(),
          ...ctx,
        });
      }
    }
  }

  if (nonRidesSkipped > 0) {
    console.log(`Filtered ${nonRidesSkipped} non-ride entries (shows/meets/walkthroughs) before insert`);
  }

  let insertError: string | null = null;
  if (rows.length === 0) {
    console.log('No rows to insert — all parks may have failed');
  } else {
    // The insert occasionally hits a transient Gateway Timeout from Supabase's
    // free-tier infra with no fault of ours — retry a couple of times before
    // treating it as a real failure, so a one-off blip doesn't silently drop
    // a whole 15-minute snapshot.
    const INSERT_ATTEMPTS = 3;
    for (let attempt = 1; attempt <= INSERT_ATTEMPTS; attempt++) {
      if (attempt > 1) {
        await new Promise((r) => setTimeout(r, 1500 * (attempt - 1)));
      }

      try {
        const res = await fetch(`${SUPABASE_URL}/rest/v1/wait_times`, {
          method: 'POST',
          headers: {
            'Content-Type':  'application/json',
            'apikey':        SUPABASE_KEY,
            'Authorization': `Bearer ${SUPABASE_KEY}`,
            'Prefer':        'return=minimal',
          },
          body: JSON.stringify(rows),
        });

        if (res.ok) {
          insertError = null;
          console.log(`✓ Stored ${rows.length} rows at ${now.toISOString()}${attempt > 1 ? ` (attempt ${attempt})` : ''}`);
          break;
        }

        insertError = await res.text();
        console.error(`Supabase insert attempt ${attempt} failed: ${res.status} ${insertError}`);
      } catch (err) {
        insertError = (err as Error).message;
        console.error(`Supabase insert attempt ${attempt} threw: ${insertError}`);
      }
    }
  }

  if (failedParks.length > 0) {
    console.error(`Parks that failed to fetch this run: ${failedParks.join(', ')}`);
  }

  const ok = insertError === null && failedParks.length === 0;

  if (!ok) {
    await alertOnFailure(
      'collect-waits',
      'disney-hotel-tv: collect-waits failed',
      [
        `Time: ${now.toISOString()}`,
        `Rows inserted this run: ${rows.length}`,
        `Failed parks: ${failedParks.length ? failedParks.join(', ') : 'none'}`,
        `Insert error: ${insertError ?? 'none'}`,
      ].join('\n'),
      SUPABASE_URL,
      SUPABASE_KEY
    );
  }

  return new Response(JSON.stringify({
    ok,
    inserted: rows.length,
    failedParks,
    ...(insertError ? { insertError } : {}),
  }), {
    status: ok ? 200 : 500,
    headers: { 'Content-Type': 'application/json' },
  });
});
