-- Payment evidence per customer domain, as of the last Stripe sync.
--
-- This is the tier-3 input: a fact corroborated by Stripe rather than asserted
-- by the vendor. It is stored rather than fetched at publish time because
-- building a signed attestation must not depend on a third party's API being
-- reachable at that moment — a Stripe outage would otherwise silently drop
-- every vendor's tier from 3 to 2 and change what the published document says.
create table if not exists vendor_payment_evidence (
	vendor_id uuid not null references vendors(id) on delete cascade,
	domain text not null,

	-- Earliest active subscription start for this domain. The honest answer to
	-- "since when", from Stripe rather than from the vendor.
	since timestamptz not null,
	currency text not null,
	-- Minor units per month, normalised from whatever interval Stripe holds.
	-- bigint because a large annual contract in a minor-unit currency (JPY has
	-- none, but IDR and COP are routinely in the millions) overflows int.
	monthly_amount bigint not null,
	subscription_count integer not null,

	synced_at timestamptz not null default now(),
	primary key (vendor_id, domain)
);

-- Payments that could NOT be attached to an observed domain, kept so a vendor
-- can see and fix them. Silently dropping these would leave someone wondering
-- why a customer they know pays them is missing from their proof.
create table if not exists vendor_payment_unmatched (
	vendor_id uuid not null references vendors(id) on delete cascade,
	subscription_id text not null,
	reason text not null,
	-- Null when there was no email to derive one from.
	domain text,
	synced_at timestamptz not null default now(),
	primary key (vendor_id, subscription_id)
);

alter table vendor_payment_evidence enable row level security;
alter table vendor_payment_unmatched enable row level security;

comment on table vendor_payment_evidence is
	'Stripe-corroborated payment per customer domain — the tier-3 input. Service-role only; the vendor dashboard reads a shaped subset through the server.';
comment on table vendor_payment_unmatched is
	'Payments that could not be joined to an observed domain, with the reason. Surfaced to the vendor rather than dropped.';
