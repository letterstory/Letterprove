-- Extra hosts a vendor collects from, beyond its verified domain.
--
-- /v1/observe accepted events only from `vendors.domain`, so a company signing
-- people in on app.acme.com and www.acme.com silently dropped one of them.
-- A vendor may now name more hosts, but only ones its DNS proof covers — see
-- src/lib/vendors/hosts.ts for the rule:
--
--   under_verified_domain  the host sits below the verified domain; the same
--                          TXT record proves control. Accepted while the
--                          vendor stays verified.
--   own_dns                a sibling or parent on the same registrable domain;
--                          needs the vendor's record on that host (or on the
--                          registrable domain). verified_at is set when it
--                          checks out and cleared by the daily re-check after
--                          three misses over two days.
--
-- One vendor per host: whoever adds it first would otherwise share another
-- vendor's traffic.
--
-- Additive only: Letterprove applies migrations during the production build,
-- before the new code serves; the running code never reads this table.

create table if not exists vendor_hosts (
	vendor_id uuid not null references vendors (id) on delete cascade,
	host text not null,
	proof text not null check (proof in ('under_verified_domain', 'own_dns')),
	verified_at timestamptz,
	created_at timestamptz not null default now(),
	dns_checked_at timestamptz,
	dns_failures integer not null default 0,
	dns_failing_since timestamptz,
	primary key (vendor_id, host)
);

create unique index if not exists vendor_hosts_host_idx on vendor_hosts (host);

-- Service role only, like every other Letterprove table since 08-28.
alter table vendor_hosts enable row level security;

comment on table vendor_hosts is
	'Extra origins /v1/observe accepts for a vendor. Rule and re-check: src/lib/vendors/hosts.ts.';
