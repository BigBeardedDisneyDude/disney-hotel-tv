# Supabase backend — full picture & rebuild guide

Everything the wait-times predictors depend on, server-side, lives in Supabase
project `qumvjdwimpvnaijjwght`. This folder is the version-controlled copy of
it, so the whole backend can be rebuilt from the repo if the project is ever
lost or recreated.

## What's here

| Path | What it is |
|---|---|
| `functions/collect-waits/` | Edge Function: every 15 min, fetches Queue-Times for all six US Disney parks, tags each row with Pacific-time context, inserts to `wait_times`. |
| `functions/prune-waits/` | Edge Function: weekly, deletes `wait_times` rows older than 120 days (Supabase free-tier size limit). |
| `functions/README.md` | Function details, known limitations, env vars, deploy commands. |
| `migrations/*_add_wait_times_indexes.sql` | The two indexes that keep predictor page loads off a full-table scan. |
| `migrations/*_schedule_cron_jobs.sql` | The `pg_cron` schedule that invokes the two functions. |

## What is NOT here (and can't be)

- **`SUPABASE_SERVICE_ROLE_KEY`** — the functions read it from their own
  environment (Supabase dashboard → Edge Functions → Secrets). Never committed.
- **Table data** — `wait_times` history, `conversations`. Not backed up; the
  predictor tolerates a cold history (falls back to its hand-authored baseline
  curves) and rebuilds coverage automatically as the collector runs.
- **The base `wait_times` table definition / RLS policies** — created by hand
  early on, not yet captured as a migration. Columns: `id`, `park`,
  `ride_name`, `wait_time` (null when closed), `is_open`, `recorded_at`,
  `day_of_week`, `hour_of_day`, `month`, `is_weekend`, `season`. If you rebuild,
  run `supabase db dump --schema public` against the live project first and
  commit that so the table shape is captured too.

## Rebuild from scratch

1. Create the project, then link it: `supabase link --project-ref <ref>`.
2. Recreate the `wait_times` table (from a `db dump`, see above).
3. `supabase db push` — applies the migrations in `migrations/` (indexes + the
   pg_cron schedule; enables the `pg_cron` and `pg_net` extensions).
4. `supabase functions deploy collect-waits && supabase functions deploy prune-waits`.
5. In the dashboard, set the `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`
   function secrets.
6. Update the anon-key bearer token in the cron migration if the new project
   has a different one, then re-run that migration.

## Inspecting / changing the schedule on the live project

There is no Cron UI in this project's dashboard version — use the SQL Editor:

```sql
-- list jobs
select jobid, jobname, schedule, active, command from cron.job;

-- recent run outcomes (DB-side only; does not show the function's HTTP status)
select jobid, status, return_message, start_time
from cron.job_run_details order by start_time desc limit 20;

-- what the HTTP calls actually returned (kept ~6h)
select id, status_code, error_msg, created
from net._http_response where created > now() - interval '3 hours'
order by created desc;

-- change a job in place
select cron.alter_job(job_id := <id>, command := $$ ... $$);
```

## History

- **2026-09-06** — migrated off two disabled GitHub Actions workflows (deleted
  from the repo); committed the Edge Function source here.
- **2026-09-07** — added the two `wait_times` indexes after the free-tier DB
  flapped to "unhealthy" (predictor loads were sequential-scanning ~1.1M rows).
  Found and fixed the `prune-waits` cron job: it had been calling the function
  with no `Authorization` header, so pruning had silently never run. Corrected
  in the live DB and captured here as `*_schedule_cron_jobs.sql`.
