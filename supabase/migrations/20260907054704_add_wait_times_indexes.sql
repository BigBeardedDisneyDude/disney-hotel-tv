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
-- The pre-existing idx_waits_lookup (park, ride_name, day_of_week,
-- hour_of_day, season) does NOT serve this query well: its 2nd column,
-- ride_name, is not an equality filter here, so Postgres cannot use the
-- (day_of_week, season) parts as a contiguous prefix and cannot get the rows
-- pre-sorted for the ORDER BY.
--
-- Run this on its own in the Supabase SQL Editor. CREATE INDEX CONCURRENTLY
-- cannot run inside a transaction block, so it must not be batched with other
-- statements. The build takes ~15-30s on this table and does not block the
-- 15-minute collector while it runs.

-- Covering + partial index matching the predictor query exactly:
--   - (park, season, day_of_week) satisfy the three equality filters
--   - (ride_name, hour_of_day) satisfy the ORDER BY (no separate sort step)
--   - INCLUDE (wait_time) lets it be answered index-only (no heap fetch)
--   - WHERE is_open = true keeps closed-ride rows out of the index
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_wait_times_predictor
  ON public.wait_times (park, season, day_of_week, ride_name, hour_of_day)
  INCLUDE (wait_time)
  WHERE is_open = true;

-- NOTE: the first version of this migration also created idx_wait_times_recorded_at
-- on (recorded_at). That duplicated the pre-existing idx_waits_recorded_at
-- (see schema.sql), so it was dropped again:
--   DROP INDEX IF EXISTS idx_wait_times_recorded_at;
