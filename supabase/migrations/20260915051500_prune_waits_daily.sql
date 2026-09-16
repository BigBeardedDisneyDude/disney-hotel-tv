-- Switch prune-waits from weekly to daily.
--
-- Found 2026-09-15: the first scheduled run after the 2026-09-07 auth-header
-- fix (Sunday 2026-09-13 05:00 UTC) logged "succeeded" in cron.job_run_details,
-- but the delete never actually happened -- the oldest wait_times row was
-- still 127+ days old three days later, and function_alerts had zero rows for
-- prune-waits (so the function's own error handling never even fired). A
-- manual invoke with the exact same URL/auth/headers the cron job uses worked
-- instantly and cleared the backlog, proving the function and its credentials
-- are fine. That points at the delivery path from pg_cron -> pg_net as the
-- weak link: collect-waits fires every 15 minutes and never has this problem,
-- while prune-waits only fired once a week, which is plenty of idle time for
-- that path to go stale between runs.
--
-- Note cron.job_run_details "succeeded" only means the net.http_post call was
-- queued without a SQL error -- it is NOT proof the HTTP request was ever
-- delivered or that the function completed. Don't trust that log alone to
-- verify this job; check wait_times' oldest row age instead.
--
-- Running daily instead of weekly keeps this delivery path exercised far more
-- often, and shrinks the exposure window for any future silent drop from a
-- week down to a day.

select cron.schedule(
  'prune-waits',
  '0 5 * * *',
  $$
  select net.http_post(
    url     := 'https://qumvjdwimpvnaijjwght.supabase.co/functions/v1/prune-waits',
    headers := '{"Authorization":"Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InF1bXZqZHdpbXB2bmFpamp3Z2h0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc4NzQ4ODcsImV4cCI6MjA5MzQ1MDg4N30.BjBeX8GSZkZoUnW3Ecy3MTPdHVV-6E2U1oJnVHiyr5I"}'::jsonb,
    timeout_milliseconds := 5000
  );
  $$
);
