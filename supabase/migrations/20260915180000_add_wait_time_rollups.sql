-- Pre-aggregated rollup of wait_times, so the predictor reads a few thousand
-- summary rows instead of paging through ~1M+ raw samples on every page load.
--
-- One row per (park, ride_name, season, day_of_week, hour_of_day) bucket --
-- exactly the grouping predict-core.js's loadHistoricalProfiles() already
-- computes client-side from raw rows, just pre-computed here instead. Same
-- filters as that query (is_open = true, wait_time >= 0), and the same
-- linear-interpolation percentile predict-core.js's own percentile() helper
-- used to compute (percentile_cont matches it exactly).
--
-- Refreshed once daily via pg_cron. Deliberately a plain SQL command inside
-- pg_cron (REFRESH MATERIALIZED VIEW), NOT a net.http_post to an Edge
-- Function -- the prune-waits incident earlier today (2026-09-15) showed that
-- an infrequent net.http_post can silently fail to deliver while
-- cron.job_run_details still reports "succeeded", because that status only
-- reflects the SQL call being queued, not the HTTP request completing. A
-- direct SQL command has no such gap: if REFRESH fails, cron.job_run_details
-- will actually say so.

create materialized view public.wait_time_rollups as
select
  park,
  ride_name,
  season,
  day_of_week,
  hour_of_day,
  count(*)::int as sample_count,
  round(avg(wait_time))::int as avg_wait,
  round(percentile_cont(0.25) within group (order by wait_time))::int as p25_wait,
  round(percentile_cont(0.75) within group (order by wait_time))::int as p75_wait
from public.wait_times
where is_open = true and wait_time >= 0
group by park, ride_name, season, day_of_week, hour_of_day;

-- Required for REFRESH MATERIALIZED VIEW CONCURRENTLY (lets refreshes happen
-- without locking out reads from the predictor mid-refresh).
create unique index wait_time_rollups_pk
  on public.wait_time_rollups (park, ride_name, season, day_of_week, hour_of_day);

-- Materialized views have no RLS -- PostgREST exposes them purely on grants.
grant select on public.wait_time_rollups to anon, authenticated;

select cron.schedule(
  'refresh-wait-rollups',
  '0 4 * * *',
  $$refresh materialized view concurrently public.wait_time_rollups$$
);

-- Make sure PostgREST picks up the new relation immediately rather than
-- waiting for its own schema-cache poll interval.
notify pgrst, 'reload schema';
