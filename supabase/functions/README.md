# Supabase Edge Functions — the live wait-times pipeline

These two functions **are** the production data pipeline for the ride wait
predictors (`predict.html`, `wdwpredict.html`). They run in the Supabase
project `qumvjdwimpvnaijjwght` and are scheduled through the Supabase
dashboard's Cron integration (not GitHub Actions — the old
`.github/workflows/collect-waits.yml` / `prune-waits.yml` were disabled and
removed in Sept 2026; this directory is now the canonical source).

## `collect-waits`

Runs **every 15 minutes, 24/7**. Fetches Queue-Times JSON for all six US
Disney parks, tags each ride row with Pacific-time context (day of week, hour,
month, weekend flag, season), and batch-inserts to the `wait_times` table.

Park IDs (Queue-Times): `dl` 16, `dca` 17, `mk` 6, `epcot` 5, `hs` 7, `ak` 8.

Known limitation: if a single park's fetch fails it is logged and skipped, and
the run still reports success as long as any rows were inserted — so a
persistently failing park shows up as silent gaps, not an alarm.

## `prune-waits`

Runs **weekly**. Deletes `wait_times` rows older than 120 days to keep the
database under the Supabase free-tier size limit.

Known limitation: the function reports success even if the `DELETE` matched
zero rows or was truncated, so the logs alone don't confirm it is keeping
pace. If the table grows unbounded, check that this function is actually on a
schedule and that its `DELETE` is completing rather than hitting a statement
timeout on a large first pass.

## Environment

Both read `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` from the function
environment (set in the Supabase dashboard, never committed).

## Deploy / update

```
supabase functions deploy collect-waits --project-ref qumvjdwimpvnaijjwght
supabase functions deploy prune-waits  --project-ref qumvjdwimpvnaijjwght
```

To re-sync this directory with what is actually deployed:

```
supabase functions download collect-waits --project-ref qumvjdwimpvnaijjwght
supabase functions download prune-waits  --project-ref qumvjdwimpvnaijjwght
```
