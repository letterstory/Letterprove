-- Vendor self-service accounts: the DB-backed replacement for
-- src/lib/fixtures/vendors.ts, so a vendor can sign up and get a key that
-- actually works with the live collector — not just a dashboard demo.
--
-- Seeded with the two existing fixture vendors at byte-identical
-- slug/domain/key values, so POST /v1/observe's origin pin, GET /v1/config,
-- and every already-published /proofs/{vendor} and /attest/{vendor}/{customer}
-- URL keep resolving exactly as before (this includes the real, live
-- lettertrace.com integration — not just the fictional Vantage fixture).

create table if not exists vendors (
	id uuid primary key default gen_random_uuid(),
	slug text unique not null,
	name text not null,
	domain text not null,
	category text not null,
	-- Publishable key attest.js sends on every event — origin-pinned to
	-- `domain` in the collector, not a secret (see fixtures/vendors.ts).
	key text unique not null,
	created_at timestamptz not null default now()
);

-- A user account that can manage a vendor's dashboard (key, customers,
-- consent). One row per (vendor, staff-of-that-vendor) pair. `role` is
-- reserved for a future invite flow — v0 only ever writes 'owner', at signup.
create table if not exists vendor_members (
	vendor_id uuid not null references vendors (id) on delete cascade,
	user_id uuid not null references auth.users (id) on delete cascade,
	role text not null default 'owner',
	created_at timestamptz not null default now(),
	primary key (vendor_id, user_id)
);

create table if not exists vendor_customers (
	id uuid primary key default gen_random_uuid(),
	vendor_id uuid not null references vendors (id) on delete cascade,
	slug text not null,
	name text not null,
	domain text not null,
	since text not null,
	tier smallint not null default 1,
	verified boolean not null default false,
	features text[] not null default '{}',
	-- Opt-in, defaults private. README § Consent: a customer who has never
	-- been asked has not agreed — see fixtures/vendors.ts's consentOf().
	consent text not null default 'anonymous' check (consent in ('named', 'anonymous')),
	created_at timestamptz not null default now(),
	unique (vendor_id, slug)
);

create index if not exists vendor_customers_vendor_idx on vendor_customers (vendor_id);

-- RLS: the collector/publish routes (src/lib/db/client.ts, service role)
-- bypass RLS entirely and are unaffected by the policies below. These
-- policies exist only to scope the vendor dashboard (anon key + user
-- session) to rows the signed-in user actually owns.
alter table vendors enable row level security;
alter table vendor_members enable row level security;
alter table vendor_customers enable row level security;

create policy "vendor members can read their own vendor" on vendors
	for select
	using (id in (select vendor_id from vendor_members where user_id = auth.uid()));

create policy "a user can read their own memberships" on vendor_members
	for select
	using (user_id = auth.uid());

create policy "vendor members can manage their own customers" on vendor_customers
	for all
	using (vendor_id in (select vendor_id from vendor_members where user_id = auth.uid()))
	with check (vendor_id in (select vendor_id from vendor_members where user_id = auth.uid()));

-- Seed: the two vendors that already exist as code fixtures today.
insert into vendors (slug, name, domain, category, key)
values
	('vantage', 'Vantage', 'vantage.example', 'customer data platforms', 'lp_live_vantage_9f2c'),
	('lettertrace', 'Lettertrace', 'lettertrace.com', 'AI brand monitoring', 'lp_live_lettertrace_5747b5e0f521')
on conflict (slug) do nothing;

-- Vantage's fixture customers. Lettertrace ships with none, matching the
-- fixture's deliberately-empty list (see fixtures/vendors.ts's comment on
-- why: discovery before assertion — no customer record until consent).
insert into vendor_customers (vendor_id, slug, name, domain, since, tier, verified, features, consent)
select v.id, c.slug, c.name, c.domain, c.since, c.tier, c.verified, c.features, c.consent
from vendors v
join (
	values
		('acme-corp', 'Acme Corp', 'acme-corp.example', '2023-03', 2::smallint, true, array['sso', 'api', 'analytics'], 'named'),
		('northwind', 'Northwind', 'northwind.example', '2024-08', 2::smallint, true, array['sso', 'api', 'analytics', 'sla'], 'anonymous'),
		('globex', 'Globex', 'globex.example', '2022-11', 1::smallint, false, array['sso', 'audit_log', 'api'], 'anonymous')
) as c (slug, name, domain, since, tier, verified, features, consent)
on true
where v.slug = 'vantage'
on conflict (vendor_id, slug) do nothing;
