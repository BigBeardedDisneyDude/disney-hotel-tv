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
- **The base `wait_times` / `conversations` table definitions and any RLS
  policies** — made by hand early on, not yet captured. The authoritative way
  to grab them is a `db dump` (needs the database password, one-time link):

  ```
  supabase link --project-ref qumvjdwimpvnaijjwght     # prompts for DB password
  supabase db dump --schema public -f supabase/schema.sql
  git add supabase/schema.sql && git commit
  ```

  Until that's done, here is the `wait_times` shape **reconstructed from the
  collector code and observed data** — close enough to rebuild against, but not
  verified against the live DDL (exact int widths, constraints, and RLS may
  differ):

  ```sql
  create table public.wait_times (
    id           bigint generated always as identity primary key,
    park         text        not null,   -- 'dl' 'dca' 'mk' 'epcot' 'hs' 'ak'
    ride_name    text        not null,
    wait_time    integer,                -- null when the ride is closed
    is_open      boolean     not null,
    recorded_at  timestamptz not null,
    day_of_week  smallint,               -- 0=Sun .. 6=Sat (Pacific)
    hour_of_day  smallint,               -- 0..23 (Pacific)
    month        smallint,               -- 1..12 (Pacific)
    is_weekend   boolean,
    season       text                    -- 'holiday' 'summer' 'spring_break' 'regular'
  );
  ```

## Rebuild from scratch

1. Create the project, then link it: `supabase link --project-ref <ref>`.
2. Recreate the `wait_times` (and `conversations`) tables — from
   `supabase/schema.sql` if it exists, else the reconstructed DDL above.
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
