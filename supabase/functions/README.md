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

Hardened 2026-09-10: if any single park's fetch fails, the run now returns
HTTP 500 with a `failedParks` array (still inserting whatever rows the other
parks did return) instead of silently reporting success — see Alerting below.

## `prune-waits`

Runs **weekly**. Deletes `wait_times` rows older than 120 days to keep the
database under the Supabase free-tier size limit.

Hardened 2026-09-10: deletes in batches of 5000 (ordered by `recorded_at`,
capped at 50 batches/run as a circuit breaker — a real backlog just continues
on the next scheduled run) instead of one unbounded `DELETE`, and reports the
true deleted-row count via `Prefer: count=exact` on the batch delete's
`Content-Range` header, so the response actually confirms it did something.

## Alerting

Added 2026-09-10. Both functions call `alertOnFailure()` from
`../_shared/alerts.ts` on their failure path, which emails
**andpcooke@gmail.com** via [Resend](https://resend.com) whenever a run isn't
fully clean (a failed park fetch, a failed insert, or a failed delete batch).
Re-alerts for the same function are throttled to at most once every 3 hours
(tracked in the `function_alerts` table — see
`migrations/*_add_function_alerts_table.sql`) so a sustained outage sends a
handful of emails, not one every 15 minutes. Requires the `RESEND_API_KEY`
secret; if it's unset, `alertOnFailure()` just logs and does nothing — a
missing key never makes the pipeline itself fail.

## Environment

Both read `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` from the function
environment (set in the Supabase dashboard, never committed). The alerting
path additionally reads `RESEND_API_KEY` (same place).

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
