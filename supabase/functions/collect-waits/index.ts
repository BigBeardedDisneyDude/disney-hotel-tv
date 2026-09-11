// Supabase Edge Function: collect-waits
// Deploy with: supabase functions deploy collect-waits
// Then schedule via Supabase Dashboard > Integrations > Cron

import { alertOnFailure } from '../_shared/alerts.ts';

const PARKS: Record<string, number> = {
  dl: 16, dca: 17,
  mk: 6, epcot: 5, hs: 7, ak: 8,
};

function getContext(date: Date) {
  const pt = new Date(date.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
  const month = pt.getMonth() + 1;
  const dow   = pt.getDay();
  const hour  = pt.getHours();

  let season: string;
  if (month === 12 || month === 1)       season = 'holiday';
  else if (month >= 6 && month <= 8)     season = 'summer';
  else if (month === 3 || month === 4)   season = 'spring_break';
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

  let insertError: string | null = null;
  if (rows.length === 0) {
    console.log('No rows to insert — all parks may have failed');
  } else {
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

    if (!res.ok) {
      insertError = await res.text();
      console.error(`Supabase insert failed: ${res.status} ${insertError}`);
    } else {
      console.log(`✓ Stored ${rows.length} rows at ${now.toISOString()}`);
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
