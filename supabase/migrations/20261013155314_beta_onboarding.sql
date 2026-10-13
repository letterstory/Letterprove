-- What a new vendor needs to see during setup, and to hear when it breaks.
--
-- 1. vendor_rejected_origins: events /v1/observe dropped because their origin
--    is not the verified domain, a host beneath it, or an accepted extra host.
--    Counts per origin per day, nothing else: no user domain, no payload. It
--    exists so setup can say "events are arriving from staging.acme.com" rather
--    than leaving the first-sign-in step quiet forever.
--
-- 2. vendors.first_event_at: the first accepted event ever. hot_events keeps
--    35 days, so "has this vendor ever received anything" needs its own column.
--    Backfilled from what is still held.
--
-- 3. vendors.contact_email: where Letterprove tells the vendor something broke.
--    Letterstory is the identity authority, so the app supplies it.
--
-- 4. vendor_notifications: one row per incident emailed, so a failing cron
--    does not email the same vendor every hour.
--
-- Additive only: migrations apply during the production build, before the new
-- code serves, and the running code never reads these.

create table if not exists vendor_rejected_origins (
	vendor_id uuid not null references vendors (id) on delete cascade,
	day date not null,
	origin text not null,
	count integer not null default 0,
	first_at timestamptz not null,
	last_at timestamptz not null,
	primary key (vendor_id, day, origin)
);

alter table vendor_rejected_origins enable row level security;

comment on table vendor_rejected_origins is
	'Daily counts of observe events dropped for an unaccepted origin. Origin host and count only. src/lib/telemetry/rejected-origins.ts.';

create or replace function record_rejected_origin(p_vendor_id uuid, p_origin text, p_at timestamptz default now())
returns void
language sql
as $$
	insert into vendor_rejected_origins (vendor_id, day, origin, count, first_at, last_at)
	values (p_vendor_id, (p_at at time zone 'utc')::date, p_origin, 1, p_at, p_at)
	on conflict (vendor_id, day, origin) do update
		set count = vendor_rejected_origins.count + 1,
			last_at = greatest(vendor_rejected_origins.last_at, excluded.last_at);
$$;

revoke all on function record_rejected_origin(uuid, text, timestamptz) from public;
grant execute on function record_rejected_origin(uuid, text, timestamptz) to service_role;

alter table vendors
	add column if not exists first_event_at timestamptz,
	add column if not exists contact_email text;

update vendors v
set first_event_at = sub.first_at
from (
	select vendor_slug, min(window_start) as first_at from hot_rollups group by vendor_slug
) sub
where sub.vendor_slug = v.slug and v.first_event_at is null;

update vendors v
set first_event_at = sub.first_at
from (
	select vendor_slug, min(receipt_ts) as first_at from hot_events group by vendor_slug
) sub
where sub.vendor_slug = v.slug and (v.first_event_at is null or sub.first_at < v.first_event_at);

create table if not exists vendor_notifications (
	vendor_id uuid not null references vendors (id) on delete cascade,
	-- dns_lost | collection_quiet | stripe_failing | posthog_failing
	kind text not null,
	-- Identifies one incident: a new incident of the same kind gets a new key.
	incident text not null,
	sent_at timestamptz not null default now(),
	recipient text not null,
	primary key (vendor_id, kind, incident)
);

alter table vendor_notifications enable row level security;

comment on table vendor_notifications is
	'Incident emails sent to vendors, one row per incident, so a failing check emails once. src/lib/notify/vendor-email.ts.';
