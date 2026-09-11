-- Throttle table for the collect-waits / prune-waits alert emails.
--
-- Both Edge Functions email andpcooke@gmail.com (via Resend) when they fail.
-- Without a throttle, collect-waits (which runs every 15 minutes) would send
-- an email every single run during a sustained outage. This table just
-- records the last time each function actually sent an alert, so the
-- functions can skip re-alerting within a few hours of the last one.
--
-- Only ever read/written by the Edge Functions using the service role key,
-- which bypasses RLS entirely — so RLS is enabled here with no policies,
-- denying anon/authenticated access outright rather than leaving it open.

create table if not exists public.function_alerts (
  function_name text primary key,
  last_alert_at timestamptz not null default now()
);

alter table public.function_alerts enable row level security;
