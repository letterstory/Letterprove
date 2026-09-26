-- Agentic-read billing: a durable count of AI-agent reads on published
-- proofs, and the monthly rollup billing actually reads.
--
-- logProofAccess() (src/lib/access/log.ts) classifies every /proofs/* and
-- /attest/* request by user-agent already; until now that classification
-- only ever reached stdout ("this repo has no data layer yet" per its own
-- comment). This is that data layer's first real consumer: usage billing.
--
-- Deliberately separate from hot_events/hot_rollups: those track a VENDOR'S
-- OWN customers using the vendor's product (summed into sessions_30d and
-- published inside the proof as evidence). This tracks who reads the proof
-- itself — a different subject, a different retention need (a full billing
-- month plus a dispute window, not 35 days), and a different consumer.
-- Conflating them would make a change to either table silently break the
-- other.
--
-- RLS on with no policies, the same posture as hot_events: only the
-- service-role client (dbClient()) can read or write either table.

create table if not exists agentic_read_events (
	id bigint generated always as identity primary key,
	vendor_slug text not null,
	subject text not null,
	agent_name text not null,
	receipt_ts timestamptz not null default now()
);

create index if not exists agentic_read_events_vendor_receipt_idx on agentic_read_events (vendor_slug, receipt_ts);
create index if not exists agentic_read_events_receipt_idx on agentic_read_events (receipt_ts);

alter table agentic_read_events enable row level security;

comment on table agentic_read_events is
	'Raw AI-agent proof/attest reads, for usage billing. Service-role only. Retained 65 days — see prune_agentic_read_events.';

-- The monthly per-vendor count billing reads. `billing_month` is always the
-- first of the month, so one row per (vendor, calendar month).
create table if not exists agentic_read_rollups (
	id bigint generated always as identity primary key,
	vendor_slug text not null,
	billing_month date not null,
	read_count integer not null default 0,
	computed_at timestamptz not null default now(),
	unique (vendor_slug, billing_month)
);

create index if not exists agentic_read_rollups_vendor_idx on agentic_read_rollups (vendor_slug, billing_month desc);

alter table agentic_read_rollups enable row level security;

comment on table agentic_read_rollups is
	'Monthly agentic-read count per vendor — the number src/lib/billing/agentic-reads.ts prices. Service-role only.';

-- Recomputes the current AND previous calendar month from agentic_read_events
-- and upserts them. Recomputing (not incrementing) makes a retried or
-- overlapping cron invocation idempotent. Two months, not one: a read in the
-- last hour of the month must still land in that closing month's total even
-- if this job's next tick runs just after midnight into the new month.
--
-- Runs DAILY, not hourly (unlike rollup_hot_events_hourly, which it was
-- otherwise modeled on): this feeds a monthly bill, not a live proof page, so
-- there is no freshness requirement finer than a day. That matters because
-- this query, unlike the hourly one, rescans up to two full months of raw
-- rows every run (a monthly count can't be windowed to the last 2 hours the
-- way a per-hour bucket can) — hourly would mean paying that full-range scan
-- 24x more often than the number it produces is ever read.
create or replace function rollup_agentic_reads_daily()
returns void
language sql
as $$
	insert into agentic_read_rollups (vendor_slug, billing_month, read_count, computed_at)
	select
		vendor_slug,
		date_trunc('month', receipt_ts)::date as billing_month,
		count(*) as read_count,
		now()
	from agentic_read_events
	where receipt_ts >= date_trunc('month', now() - interval '1 month')
	group by vendor_slug, date_trunc('month', receipt_ts)
	on conflict (vendor_slug, billing_month)
	do update set
		read_count = excluded.read_count,
		computed_at = excluded.computed_at;
$$;

-- Raw events expire after 65 days: long enough that the rollup above always
-- has the full current AND previous month to recompute from, plus a
-- dispute-window buffer past the previous month's close. Mirrors
-- prune_hot_events' reasoning (migration 20260922230000) at a longer window,
-- because this table backs an actual invoice rather than an internal signal.
create or replace function prune_agentic_read_events()
returns bigint
language sql
set search_path = public
as $$
	with deleted as (
		delete from agentic_read_events
		where receipt_ts < now() - interval '65 days'
		returning 1
	)
	select count(*) from deleted;
$$;

comment on function prune_agentic_read_events() is
	'Deletes agentic_read_events rows older than 65 days; returns how many. See migration 20260926120000.';
