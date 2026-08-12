-- Hourly rollup of hot_events into per-account counts. README § Publication:
-- this is what publishing eventually reads instead of fixtures.ts.
--
-- Scoped to what phase-1 events actually support: hot_events has no
-- per-feature or per-user dimension (see telemetry/events.ts — named events
-- are a phase-2 addition), so this aggregates session/signup/login counts
-- per account (domain, per Decision #1) per hour. It does not compute
-- seats_active or per-feature counts — those need phase-2 data, not just a
-- rollup job.
--
-- RLS is enabled with no policies, matching hot_events: only the
-- service-role client (dbClient()) can read or write this table.

create table if not exists hot_rollups (
	id bigint generated always as identity primary key,
	vendor_slug text not null,
	domain text not null,
	window_start timestamptz not null,
	sessions integer not null default 0,
	signups integer not null default 0,
	logins integer not null default 0,
	computed_at timestamptz not null default now(),
	unique (vendor_slug, domain, window_start)
);

create index if not exists hot_rollups_vendor_domain_idx on hot_rollups (vendor_slug, domain, window_start desc);

alter table hot_rollups enable row level security;

-- Recomputes the last 2 hours of buckets from hot_events and upserts them.
-- Recomputing (not incrementing) makes a retried or overlapping cron
-- invocation idempotent; the 2-hour window catches events that land late
-- for the previous bucket without rescanning the whole table as it grows.
create or replace function rollup_hot_events_hourly()
returns void
language sql
as $$
	insert into hot_rollups (vendor_slug, domain, window_start, sessions, signups, logins, computed_at)
	select
		vendor_slug,
		domain,
		date_trunc('hour', receipt_ts) as window_start,
		count(*) filter (where ev = 'session') as sessions,
		count(*) filter (where ev = 'signup') as signups,
		count(*) filter (where ev = 'login') as logins,
		now()
	from hot_events
	where receipt_ts >= now() - interval '2 hours'
	group by vendor_slug, domain, date_trunc('hour', receipt_ts)
	on conflict (vendor_slug, domain, window_start)
	do update set
		sessions = excluded.sessions,
		signups = excluded.signups,
		logins = excluded.logins,
		computed_at = excluded.computed_at;
$$;
