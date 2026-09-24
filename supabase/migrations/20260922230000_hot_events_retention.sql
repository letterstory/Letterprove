-- Raw events expire after 35 days.
--
-- Until now nothing ever deleted a hot_events row (the only delete in the
-- codebase removes the collector health-check's own canary row), which
-- contradicted both the README ("Retained internally … Short TTL") and the
-- privacy page. Raw rows carry the most sensitive fields we hold — salted
-- per-user hashes, ASN, coarse geo — so they are the ones that must not
-- accumulate.
--
-- WHY 35 DAYS. Every reader of hot_events looks back at most 30 days:
-- attest/fraud-features.ts, attest/geo-distribution.ts and stripe/sync.ts
-- all use a 30-day window, staff/health.ts and vendors/status.ts use hours.
-- The five extra days are slack so an hourly prune can never race a
-- 30-day read at the boundary. Anything that needs history beyond that
-- reads hot_rollups (domain × hour counts, no per-user data), which this
-- does NOT touch — e.g. attest/domain-arrivals.ts's all-time "first seen".
-- A new reader with a window longer than 35 days must raise this first.
--
-- Called hourly from /api/cron/rollup, after the rollup.
create or replace function prune_hot_events()
returns bigint
language sql
set search_path = public
as $$
	with deleted as (
		delete from hot_events
		where receipt_ts < now() - interval '35 days'
		returning 1
	)
	select count(*) from deleted;
$$;

comment on function prune_hot_events() is
	'Deletes hot_events rows older than 35 days; returns how many. Every hot_events reader looks back <= 30 days. See migration 20260922230000.';

-- The hourly rollup filters on receipt_ts alone (last 2 hours) and so does
-- the prune above. The two existing indexes lead with vendor_slug and
-- domain, so neither can serve that filter and both queries were full-table
-- scans that grow with every event.
create index if not exists hot_events_receipt_idx on hot_events (receipt_ts);
