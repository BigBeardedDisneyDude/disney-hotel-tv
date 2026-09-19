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

// "regular" season repeats every week and recent data predicts it just
// fine, so it keeps the short window. Special seasons (summer, holiday,
// spring_break) are rare and short each year, so predict-core.js's
// season-bucketed rollup benefits from blending in prior years' data
// instead of only ever knowing the current year's occurrence of that
// season — added 2026-09-19 at the user's request.
//
// Cutoff is ~1 year (not 2): a full year gives one complete prior
// occurrence of each special season, which is most of the benefit. Went
// from an initial 2-year (730-day) cutoff down to 1 year the same day
// after checking the real numbers: at the live insert rate (~12,576
// rows/day) and current per-row footprint (~196 bytes incl. indexes),
// special seasons already cover 7 of 12 months, so a full 2-year window
// would grow this table to ~1.2GB at steady state — well over Supabase's
// 500MB free-tier cap. A 1-year window keeps it far more sustainable;
// see the followup-verify-season-retention memory for the numbers this
// was based on and what to re-check if the insert rate changes a lot.
const REGULAR_CUTOFF_DAYS = 120;
const SPECIAL_SEASON_CUTOFF_DAYS = 365;

// Runs one age-based delete pass against a single simple filter (e.g.
// "season=eq.regular&recorded_at=lt.X"). Kept to ONE equality/range
// condition pair per pass deliberately — an OR across two different
// season/cutoff combinations was tried first and made Postgres abandon the
// recorded_at index for an ORDER BY+LIMIT plan, causing a full table scan
// that hit the statement timeout (found 2026-09-19). Two simple passes each
// behave like the original single-cutoff query and stay fast.
async function prunePass(
  label: string,
  ageParam: string,
  SUPABASE_URL: string,
  SUPABASE_KEY: string
): Promise<{ deleted: number; batches: number; truncated: boolean } | { error: string }> {
  let totalDeleted = 0;
  let batches = 0;
  let truncated = false;

  while (batches < MAX_BATCHES) {
    // Find the next batch of old rows to delete. Ordering by recorded_at
    // lets this use the existing idx_waits_recorded_at index instead of a
    // sequential scan.
    const selRes = await fetch(
      `${SUPABASE_URL}/rest/v1/wait_times?select=id&${ageParam}&order=recorded_at.asc&limit=${BATCH_SIZE}`,
      {
        headers: {
          'apikey':        SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`,
        },
      }
    );
    if (!selRes.ok) {
      const text = await selRes.text();
      console.error(`Prune batch select failed (${label}): ${selRes.status} ${text}`);
      return { error: `Batch select failed (HTTP ${selRes.status}) after deleting ${totalDeleted} row(s) in ${batches} batch(es) [${label}].\n${text}` };
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
      console.error(`Prune batch delete failed (${label}): ${delRes.status} ${text}`);
      return { error: `Batch delete failed (HTTP ${delRes.status}) after deleting ${totalDeleted} row(s) in ${batches} batch(es) [${label}].\n${text}` };
    }

    const contentRange = delRes.headers.get('content-range'); // e.g. "*/5000"
    const batchDeleted = contentRange ? parseInt(contentRange.split('/')[1], 10) : ids.length;
    totalDeleted += Number.isFinite(batchDeleted) ? batchDeleted : ids.length;
    batches++;

    // NOTE: don't infer "no more rows" from idRows.length < BATCH_SIZE — this
    // project's PostgREST db-max-rows setting silently caps every select at
    // 1000 rows regardless of the `limit` param above, so that condition was
    // always true and this loop always stopped after one ~1000-row batch no
    // matter how large the real backlog was (found 2026-09-19: 82k+ rows
    // stuck well past the 120-day cutoff despite daily "succeeded" runs).
    // The only reliable "done" signal is an empty page, checked at the top
    // of the loop.
    if (batches === MAX_BATCHES) truncated = true;
  }

  return { deleted: totalDeleted, batches, truncated };
}

Deno.serve(async (_req: Request) => {
  const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
  const SUPABASE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

  const regularCutoff = new Date(Date.now() - REGULAR_CUTOFF_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const specialCutoff = new Date(Date.now() - SPECIAL_SEASON_CUTOFF_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const regularResult = await prunePass(
    'regular',
    `season=eq.regular&recorded_at=lt.${regularCutoff}`,
    SUPABASE_URL,
    SUPABASE_KEY
  );
  if ('error' in regularResult) {
    await alertOnFailure('prune-waits', 'disney-hotel-tv: prune-waits failed', regularResult.error, SUPABASE_URL, SUPABASE_KEY);
    return new Response(JSON.stringify({ ok: false, error: regularResult.error }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const specialResult = await prunePass(
    'special-season',
    `season=neq.regular&recorded_at=lt.${specialCutoff}`,
    SUPABASE_URL,
    SUPABASE_KEY
  );
  if ('error' in specialResult) {
    await alertOnFailure('prune-waits', 'disney-hotel-tv: prune-waits failed', specialResult.error, SUPABASE_URL, SUPABASE_KEY);
    return new Response(JSON.stringify({ ok: false, error: specialResult.error, regularResult }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const totalDeleted = regularResult.deleted + specialResult.deleted;
  const truncated = regularResult.truncated || specialResult.truncated;
  console.log(`✓ Pruned ${totalDeleted} row(s) — regular: ${regularResult.deleted} (< ${regularCutoff}), special seasons: ${specialResult.deleted} (< ${specialCutoff})${truncated ? ' — backlog remains, next scheduled run will continue' : ''}`);
  return new Response(JSON.stringify({ ok: true, regularCutoff, specialCutoff, totalDeleted, regularResult, specialResult, truncated }), {
    headers: { 'Content-Type': 'application/json' },
  });
});
