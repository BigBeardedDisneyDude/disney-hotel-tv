-- wait_times indexes — cut the predictor's per-load full-table scans.
--
-- Context: predict-core.js loadHistoricalProfiles() runs this per park on every
-- page load (6 parks), paginated 1000 rows at a time:
--
--   SELECT park, ride_name, hour_of_day, wait_time
--   FROM wait_times
--   WHERE park = ? AND season = ? AND day_of_week = ?
--     AND is_open = true AND wait_time >= 0
--   ORDER BY ride_name, hour_of_day
--
-- With no matching index that is a sequential scan over ~1.1M rows every time,
-- which is what pushes the free-tier database into its "unhealthy" state.
--
-- Run each statement on its own in the Supabase SQL Editor (select the line,
-- click Run). CREATE INDEX CONCURRENTLY cannot run inside a transaction block,
-- so it must not be batched with other statements. Each build takes ~15-30s on
-- this table and does not block the 15-minute collector while it runs.

-- 1. Covering + partial index matching the predictor query exactly:
--    - (park, season, day_of_week) satisfy the three equality filters
--    - (ride_name, hour_of_day) satisfy the ORDER BY (no separate sort step)
--    - INCLUDE (wait_time) lets it be answered index-only (no heap fetch)
--    - WHERE is_open = true keeps closed-ride rows out of the index
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_wait_times_predictor
  ON public.wait_times (park, season, day_of_week, ride_name, hour_of_day)
  INCLUDE (wait_time)
  WHERE is_open = true;

-- 2. Straight btree on recorded_at for the prune-waits DELETE
--    (WHERE recorded_at < cutoff) and any latest-row / recent-window lookups.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_wait_times_recorded_at
  ON public.wait_times (recorded_at);
