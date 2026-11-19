-- Adds a per-snapshot ThemeParks.wiki live status (OPERATING, DOWN, CLOSED,
-- REFURBISHMENT) to wait_times, alongside the existing Queue-Times-derived
-- is_open/wait_time. Needed to tell a real unscheduled breakdown (DOWN)
-- apart from announced maintenance (REFURBISHMENT) -- the plain open/closed
-- flag can't make that distinction, which is exactly what the new
-- "average downtime when it breaks" predictor stat needs.
--
-- Nullable, no backfill: wait_times already holds 1M+ historical rows that
-- predate this column and never will have a real value for it (ThemeParks.
-- wiki's live endpoint has no history API) -- null there correctly reads as
-- "unknown, collected before this existed," not as "the ride was fine."
-- collect-waits (supabase/functions/collect-waits/index.ts, via the new
-- _shared/liveStatus.ts) starts populating it going forward from whenever
-- this ships.

alter table public.wait_times add column status text;
