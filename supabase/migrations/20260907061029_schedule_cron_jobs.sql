-- Recreate the pg_cron schedule that drives the wait-times pipeline.
--
-- This is the piece that used to live only in the live database. If the
-- Supabase project is ever rebuilt, applying this migration (plus deploying
-- the two Edge Functions in ../functions/) restores the whole pipeline.
--
-- Notes:
--   * cron.schedule(name, schedule, command) upserts by job name, so this is
--     safe to re-run against a database where the jobs already exist.
--   * The token below is the project ANON key. It is already public — it ships
--     in predict-core.js in this repo — so committing it here is not a new
--     exposure. Both functions only need *a* valid project JWT to pass the
--     gateway; they do their privileged work with the SERVICE_ROLE key from
--     their own function environment, which is NOT in the repo.
--   * The prune job originally shipped with headers:='{}' (no Authorization),
--     which the function gateway rejected — so pruning silently never ran
--     until this was corrected on 2026-09-07.

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Collector: every 15 minutes, all six US Disney parks -> wait_times.
select cron.schedule(
  'collect-waits',
  '*/15 * * * *',
  $$
  select net.http_post(
    url     := 'https://qumvjdwimpvnaijjwght.supabase.co/functions/v1/collect-waits',
    headers := '{"Authorization":"Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InF1bXZqZHdpbXB2bmFpamp3Z2h0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc4NzQ4ODcsImV4cCI6MjA5MzQ1MDg4N30.BjBeX8GSZkZoUnW3Ecy3MTPdHVV-6E2U1oJnVHiyr5I"}'::jsonb,
    timeout_milliseconds := 5000
  );
  $$
);

-- Pruner: Sundays 05:00 UTC, delete wait_times rows older than 120 days.
select cron.schedule(
  'prune-waits',
  '0 5 * * 0',
  $$
  select net.http_post(
    url     := 'https://qumvjdwimpvnaijjwght.supabase.co/functions/v1/prune-waits',
    headers := '{"Authorization":"Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InF1bXZqZHdpbXB2bmFpamp3Z2h0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc4NzQ4ODcsImV4cCI6MjA5MzQ1MDg4N30.BjBeX8GSZkZoUnW3Ecy3MTPdHVV-6E2U1oJnVHiyr5I"}'::jsonb,
    timeout_milliseconds := 5000
  );
  $$
);
