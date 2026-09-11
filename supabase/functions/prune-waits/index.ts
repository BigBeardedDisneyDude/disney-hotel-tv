// Supabase Edge Function: prune-waits
// Deploy with: supabase functions deploy prune-waits
// Then schedule via Supabase Dashboard > Integrations > Cron (weekly)

import { alertOnFailure } from '../_shared/alerts.ts';

// Deletes at most this many rows per batch, so one run can't hold a single
// DELETE open long enough to hit a statement timeout on the free tier.
const BATCH_SIZE = 5000;
// Safety circuit breaker (mirrors predict-core.js's SUPABASE_MAX_ROWS
// pattern): caps a single run at 50 batches. Normal weekly upkeep never gets
// close to this — it only matters if the job has been silently broken for a
// long time and is catching up on a big backlog, in which case the next
// weekly run picks up where this one left off.
const MAX_BATCHES = 50;

Deno.serve(async (_req: Request) => {
  const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
  const SUPABASE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

  const cutoff = new Date(Date.now() - 120 * 24 * 60 * 60 * 1000).toISOString();

  let totalDeleted = 0;
  let batches = 0;
  let truncated = false;

  while (batches < MAX_BATCHES) {
    // Find the next batch of old rows to delete. Ordering by recorded_at
    // lets this use the existing idx_waits_recorded_at index instead of a
    // sequential scan.
    const selRes = await fetch(
      `${SUPABASE_URL}/rest/v1/wait_times?select=id&recorded_at=lt.${cutoff}&order=recorded_at.asc&limit=${BATCH_SIZE}`,
      {
        headers: {
          'apikey':        SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`,
        },
      }
    );
    if (!selRes.ok) {
      const text = await selRes.text();
      console.error(`Prune batch select failed: ${selRes.status} ${text}`);
      await alertOnFailure(
        'prune-waits',
        'disney-hotel-tv: prune-waits failed',
        `Batch select failed (HTTP ${selRes.status}) after deleting ${totalDeleted} row(s) in ${batches} batch(es).\n${text}`,
        SUPABASE_URL,
        SUPABASE_KEY
      );
      return new Response(JSON.stringify({ ok: false, error: text, totalDeleted }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const idRows: { id: number }[] = await selRes.json();
    if (idRows.length === 0) break;
    const ids = idRows.map((r) => r.id);

    const delRes = await fetch(
      `${SUPABASE_URL}/rest/v1/wait_times?id=in.(${ids.join(',')})`,
      {
        method: 'DELETE',
        headers: {
          'apikey':        SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`,
          // count=exact makes PostgREST report how many rows it actually
          // deleted in the Content-Range header, instead of just "success" —
          // that number is what confirms this job is truly keeping pace.
          'Prefer':        'return=minimal,count=exact',
        },
      }
    );
    if (!delRes.ok) {
      const text = await delRes.text();
      console.error(`Prune batch delete failed: ${delRes.status} ${text}`);
      await alertOnFailure(
        'prune-waits',
        'disney-hotel-tv: prune-waits failed',
        `Batch delete failed (HTTP ${delRes.status}) after deleting ${totalDeleted} row(s) in ${batches} batch(es).\n${text}`,
        SUPABASE_URL,
        SUPABASE_KEY
      );
      return new Response(JSON.stringify({ ok: false, error: text, totalDeleted }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const contentRange = delRes.headers.get('content-range'); // e.g. "*/5000"
    const batchDeleted = contentRange ? parseInt(contentRange.split('/')[1], 10) : ids.length;
    totalDeleted += Number.isFinite(batchDeleted) ? batchDeleted : ids.length;
    batches++;

    if (idRows.length < BATCH_SIZE) break; // that was the last batch
    if (batches === MAX_BATCHES) truncated = true;
  }

  console.log(`✓ Pruned ${totalDeleted} row(s) older than ${cutoff} in ${batches} batch(es)${truncated ? ' — backlog remains, next scheduled run will continue' : ''}`);
  return new Response(JSON.stringify({ ok: true, cutoff, totalDeleted, batches, truncated }), {
    headers: { 'Content-Type': 'application/json' },
  });
});
