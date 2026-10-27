-- ride_alerts needs two more columns than the first migration gave it, found
-- while wiring up collect-waits: the Edge Function has no access to either
-- predictor's roster (no build step to share that JS data with Deno), so it
-- can't turn `ride_id` (a roster-internal short id like 'indy') into
-- anything matchable against the live Queue-Times feed, or into a readable
-- notification title, on its own.
--
-- qt: the same lowercase match-stem string predict-core.js's getLive()
-- already matches against live Queue-Times ride names (normName() folding +
-- loose substring, to tolerate seasonal title overlays) — collect-waits
-- replicates that exact matching, so alerts stay accurate through the same
-- seasonal renames the live predictor already handles.
-- ride_name: the roster's display name, purely for the push notification's
-- title text.
--
-- Table is brand new with zero rows (just added this session), so adding
-- these as not-null with no backfill is safe.

alter table public.ride_alerts add column qt text not null;
alter table public.ride_alerts add column ride_name text not null;
