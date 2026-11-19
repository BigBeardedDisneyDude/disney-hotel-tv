-- "Average downtime when it breaks" stat for the predictor's ride detail
-- modal: per (park, ride_name), how many distinct unscheduled breakdowns
-- (status = 'DOWN') have been observed, and how long they typically last.
--
-- Built as a classic gaps-and-islands query over wait_times.status (added in
-- the prior migration): group consecutive same-status snapshots per ride
-- into one "island" (a run that starts whenever status differs from the
-- previous snapshot), keep only the DOWN islands, and average their
-- duration. REFURBISHMENT and CLOSED islands are excluded entirely by the
-- final filter -- that's the whole point: those aren't "it broke and came
-- back," they're scheduled/expected closures.
--
-- Duration per island is (last DOWN sample - first DOWN sample) + one
-- sampling interval (15 min) -- the ride was still confirmed down at the
-- last DOWN sample and only confirmed back up at the *next* sample, which
-- is outside the island, so the raw span alone would always undercount by
-- about one interval. This also gives a lone single-sample blip a sane
-- 15-minute floor instead of reading as a 0-minute "incident."
--
-- Known limitation, acceptable for a nightly-refreshed secondary stat (same
-- staleness tradeoff already accepted for wait_time_rollups): an incident
-- still ongoing at refresh time looks shorter than it'll end up being, and
-- gets corrected on the next night's refresh once it resolves. Also, a
-- missed live-status fetch (collect-waits logs status: null for that run --
-- see liveStatus.ts) is skipped via the `where status is not null` filter
-- below rather than breaking the island it falls inside, so one dropped
-- sample won't artificially split (or, in a long outage, could wrongly
-- bridge) a real incident -- acceptable since ThemeParks.wiki's live
-- endpoint is reliable in practice and this is an enrichment stat, not the
-- core pipeline.

create materialized view public.ride_downtime_stats as
with ordered as (
  select
    park, ride_name, status, recorded_at,
    lag(status) over (partition by park, ride_name order by recorded_at) as prev_status
  from public.wait_times
  where status is not null
),
flagged as (
  select *,
    case when status is distinct from prev_status then 1 else 0 end as is_new_group
  from ordered
),
grouped as (
  select *,
    sum(is_new_group) over (partition by park, ride_name order by recorded_at) as grp
  from flagged
),
islands as (
  select park, ride_name, status, grp,
    min(recorded_at) as started_at,
    max(recorded_at) as ended_at
  from grouped
  group by park, ride_name, status, grp
)
select
  park,
  ride_name,
  count(*)::int as down_incidents,
  round(avg(extract(epoch from (ended_at - started_at)) / 60.0 + 15))::int as avg_down_minutes,
  min(started_at) as first_seen_down,
  max(started_at) as last_seen_down
from islands
where status = 'DOWN'
group by park, ride_name;

-- Required for REFRESH MATERIALIZED VIEW CONCURRENTLY.
create unique index ride_downtime_stats_pk
  on public.ride_downtime_stats (park, ride_name);

-- Materialized views have no RLS -- PostgREST exposes them purely on grants.
grant select on public.ride_downtime_stats to anon, authenticated;

-- Offset 10 minutes from the wait_time_rollups refresh (0 4 * * *) so the
-- two don't contend for the same moment.
select cron.schedule(
  'refresh-ride-downtime-stats',
  '10 4 * * *',
  $$refresh materialized view concurrently public.ride_downtime_stats$$
);

notify pgrst, 'reload schema';
