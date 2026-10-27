// Favorite-ride wait alerts: checked by collect-waits at the end of every
// normal 15-minute run, using the live wait data it already fetched (no
// extra API calls). Reads/writes the ride_alerts table with the service
// role key (bypasses RLS; anon RLS policy is for the browser's own
// subscribe/unsubscribe writes, not this function).
//
// normName() below is a hand-synced duplicate of the one in predict-core.js
// (same reason as computeEaster()/nonRideFilter.ts in collect-waits/index.ts:
// no build step to share code between browser JS and this Deno function).
// Keep it in sync if that one changes.

import webpush from 'npm:web-push@3.6.7';

type LiveEntry = { wait: number | null; isOpen: boolean };
type LiveByPark = Record<string, Record<string, LiveEntry>>;

type AlertRow = {
  id: number;
  endpoint: string;
  subscription: webpush.PushSubscription;
  park: string;
  ride_id: string;
  qt: string;
  ride_name: string;
  threshold_minutes: number;
  last_state: 'above' | 'below';
};

const VAPID_PUBLIC_KEY = 'BGAn-lmNWfAu83quM_hgVOY36Fp2OjXHVCNE4JaCDlFzde9fGZkFhVE3Nrj7AyvrQX1B7_Uld4HTvgSnXxvfOpo';

const PARK_URL: Record<string, string> = {
  dl: '/disney-hotel-tv/predict.html',
  dca: '/disney-hotel-tv/predict.html',
  mk: '/disney-hotel-tv/wdwpredict.html',
  epcot: '/disney-hotel-tv/wdwpredict.html',
  hs: '/disney-hotel-tv/wdwpredict.html',
  ak: '/disney-hotel-tv/wdwpredict.html',
};

function normName(s: string): string {
  let t = String(s ?? '').toLowerCase().trim();
  t = t.replace(/[™®©]/g, '');
  t = t.replace(/^["“”]+|["“”]+$/g, '');
  t = t.replace(/[‘’ʼ`]/g, "'");
  t = t.replace(/[–—]/g, '-');
  t = t.replace(/\s+/g, ' ');
  return t.trim();
}

// Same loose match as predict-core.js's getLive(): exact first, else a
// 10-char substring either direction, so a seasonal overlay title (e.g.
// "Soarin' Across America") still matches the roster's stable `qt` stem.
function findLive(liveMap: Record<string, LiveEntry>, qt: string): LiveEntry | null {
  const k = normName(qt);
  if (liveMap[k]) return liveMap[k];
  for (const key of Object.keys(liveMap)) {
    if (key.includes(k.slice(0, 10)) || k.includes(key.slice(0, 10))) return liveMap[key];
  }
  return null;
}

export function buildLiveByPark(rows: { park: string; ride_name: string; wait_time: number | null; is_open: boolean }[]): LiveByPark {
  const liveByPark: LiveByPark = {};
  for (const row of rows) {
    const byPark = liveByPark[row.park] ??= {};
    byPark[normName(row.ride_name)] = { wait: row.wait_time, isOpen: row.is_open };
  }
  return liveByPark;
}

export async function checkRideAlerts(
  liveByPark: LiveByPark,
  SUPABASE_URL: string,
  SUPABASE_KEY: string
): Promise<{ checked: number; fired: number; staleRemoved: number }> {
  const headers = {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
  };

  const VAPID_PRIVATE_KEY = Deno.env.get('VAPID_PRIVATE_KEY');
  if (!VAPID_PRIVATE_KEY) {
    console.error('VAPID_PRIVATE_KEY not set — skipping ride alert checks');
    return { checked: 0, fired: 0, staleRemoved: 0 };
  }
  webpush.setVapidDetails('mailto:andpcooke@gmail.com', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

  const res = await fetch(`${SUPABASE_URL}/rest/v1/ride_alerts?select=*`, { headers });
  if (!res.ok) {
    console.error('ride_alerts fetch failed:', res.status, await res.text());
    return { checked: 0, fired: 0, staleRemoved: 0 };
  }
  const alertRows: AlertRow[] = await res.json();
  if (!alertRows.length) return { checked: 0, fired: 0, staleRemoved: 0 };

  let fired = 0;
  let staleRemoved = 0;

  for (const row of alertRows) {
    const liveMap = liveByPark[row.park] || {};
    const match = findLive(liveMap, row.qt);

    // Honesty guardrail: only ever act on a ride that's currently open and
    // actually reporting a real live wait — never a closed ride, and never
    // (collect-waits doesn't produce these anyway) a fallback/estimated one.
    if (!match || !match.isOpen || match.wait == null) continue;

    const isBelow = match.wait < row.threshold_minutes;
    const wasBelow = row.last_state === 'below';
    if (isBelow === wasBelow) continue; // no crossing — nothing to do

    if (isBelow && !wasBelow) {
      const payload = JSON.stringify({
        title: `${row.ride_name}: ${match.wait} min`,
        body: `Dropped below your ${row.threshold_minutes}-min alert.`,
        url: PARK_URL[row.park] || '/disney-hotel-tv/predict.html',
      });
      try {
        await webpush.sendNotification(row.subscription, payload);
        fired++;
      } catch (err: any) {
        const statusCode = err?.statusCode;
        if (statusCode === 404 || statusCode === 410) {
          // Subscription is gone (uninstalled, permission revoked, etc.) —
          // delete it rather than retry it forever.
          await fetch(`${SUPABASE_URL}/rest/v1/ride_alerts?id=eq.${row.id}`, { method: 'DELETE', headers });
          staleRemoved++;
          continue;
        }
        console.error(`Push send failed for ride_alerts id ${row.id}:`, err?.message || err);
        continue; // leave last_state as-is, retry next run
      }
    }

    await fetch(`${SUPABASE_URL}/rest/v1/ride_alerts?id=eq.${row.id}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ last_state: isBelow ? 'below' : 'above', updated_at: new Date().toISOString() }),
    });
  }

  return { checked: alertRows.length, fired, staleRemoved };
}
