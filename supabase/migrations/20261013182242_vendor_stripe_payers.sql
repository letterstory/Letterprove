-- Companies that paid a settled, in-scope invoice in the vendor's bound Stripe
-- account but were NOT observed signing in (managed accounts, report readers).
--
-- Read by one thing only: the logo wall, which may mark a company the vendor
-- already shows publicly as "paying, verified by Stripe". Every count on the
-- proof joins vendor_payment_evidence to observed domains and never reads
-- this table. Replaced wholesale by each Stripe sync; cleared with evidence.
create table if not exists vendor_stripe_payers (
	vendor_id uuid not null references vendors(id) on delete cascade,
	domain text not null,
	since timestamptz,
	synced_at timestamptz not null,
	primary key (vendor_id, domain)
);

alter table vendor_stripe_payers enable row level security;

comment on table vendor_stripe_payers is
	'Stripe-paying company domains not observed signing in. Logo wall only; never counted on the proof. Service-role only.';
