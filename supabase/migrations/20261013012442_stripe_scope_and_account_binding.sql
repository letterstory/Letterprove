-- Tier-3 evidence gets honest about WHICH money and WHOSE account.
--
-- 1. Product scope. One Stripe account often bills several products (Letter
--    Company's bills Letterstory, Phantomstory and more), and every
--    subscription in it used to count as payment for this vendor's product.
--    `product_ids` is the vendor's choice of which Stripe products are this
--    product. Empty means every product, the behaviour before this column, and
--    the connection reports which mode it is in.
--
-- 2. Account binding. Nothing tied the Stripe account to the vendor, so any
--    account's key could corroborate any vendor. Each connect and sync now
--    reads the account (GET /v1/account) and requires one of the domains it
--    publishes about itself to share the vendor's verified registrable domain.
--    What it read is recorded here so the vendor and staff can see why.
--
-- 3. Staff override, for the honest exceptions (a parent company billing for a
--    subsidiary on another domain). Bound to one Stripe account id, so a key
--    for a different account is checked afresh rather than riding the
--    override. Set only by the staff:write tool `set_stripe_account_override`,
--    never by the vendor.
--
-- Additive only: Letterprove applies migrations during the production build,
-- before the new code serves, so the running code must not notice these.

alter table vendor_stripe_credentials
	add column if not exists product_ids text[] not null default '{}',
	add column if not exists stripe_account_id text,
	add column if not exists stripe_account_domains text[],
	add column if not exists account_checked_at timestamptz;

comment on column vendor_stripe_credentials.product_ids is
	'Stripe product ids that count as this vendor''s product. Empty = every product in the account.';
comment on column vendor_stripe_credentials.stripe_account_domains is
	'Domains the connected Stripe account publishes about itself (business URL, support email, account email), as last read.';

alter table vendors
	add column if not exists stripe_account_override_account_id text,
	add column if not exists stripe_account_override_at timestamptz,
	add column if not exists stripe_account_override_by text,
	add column if not exists stripe_account_override_reason text;

comment on column vendors.stripe_account_override_account_id is
	'Staff-approved Stripe account whose domains need not match the vendor''s. Set only by staff, never by the vendor.';
