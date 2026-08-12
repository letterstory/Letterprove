-- Hot tier: raw accepted observations from POST /v1/observe.
-- README § Publication / Freshness: "raw events, minutes old, unsigned.
-- What the team sees internally." The hourly rollup (account × feature)
-- reads from this table; nothing public ever reads it directly — RLS is
-- enabled with no policies, so only the service role (which bypasses RLS)
-- can touch it.

create table if not exists hot_events (
	id bigint generated always as identity primary key,
	vendor_slug text not null,
	domain text not null,
	ev text not null check (ev in ('session', 'signup', 'login')),
	cfg integer not null,
	origin text not null,
	-- ASN isn't wired yet (no GeoIP/ASN lookup in this deploy, see
	-- src/lib/telemetry/log.ts) — nullable until that lands for real.
	asn integer,
	receipt_ts timestamptz not null default now()
);

create index if not exists hot_events_vendor_receipt_idx on hot_events (vendor_slug, receipt_ts);
create index if not exists hot_events_domain_receipt_idx on hot_events (domain, receipt_ts);

alter table hot_events enable row level security;
