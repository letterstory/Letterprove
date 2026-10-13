-- A vendor's public logo wall, declared by the vendor, checked by us.
--
-- Letterprove names no customer, with one opt-in exception: companies the
-- vendor ALREADY shows on its own public logo wall. The vendor lists them and
-- the page they appear on; Letterprove fetches that page and keeps, per
-- company, whether it is actually there. The attestation then names only the
-- listed companies that are on the page AND observed signing in (or paying),
-- and counts the rest. A name that is not already public on the vendor's own
-- site can never reach a proof through this table.
--
-- RLS on, no policies: service role only, like every vendor-private table.

create table if not exists vendor_logo_wall (
	vendor_id uuid primary key references vendors(id) on delete cascade,
	-- https URL on the vendor's verified domain, a host beneath it, or an
	-- accepted extra host.
	page_url text not null,
	-- [{ "name": "Acme", "domain": "acme.com", "on_page": true }]
	companies jsonb not null default '[]'::jsonb,
	-- When the page was last fetched and matched successfully. Null until then.
	checked_at timestamptz,
	-- Why the last check failed, when it did.
	check_error text,
	updated_at timestamptz not null default now()
);

alter table vendor_logo_wall enable row level security;

comment on table vendor_logo_wall is
	'Companies a vendor shows on its own public logo wall, and whether each was found on that page at the last check. Names reach a proof only when on the page and observed. Service-role only.';
