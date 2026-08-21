-- Proof that a vendor controls the domain they claim.
--
-- Origin-pinning stops a *browser* lying about where a page was served from —
-- `Origin` is a forbidden header name, so page script cannot override it. It
-- does nothing about a non-browser client, and /v1/observe says so in its own
-- comment. So today the whole chain is claimable:
--
--   1. sign up as "Stripe", claim domain stripe.com (nothing checks it)
--   2. curl /v1/observe with `Origin: https://stripe.com` and your own key
--   3. the rollup counts it, and your proof page reads verified / tier 2
--
-- The publishable key is public by design, so it is not the secret that stops
-- this. Domain control is. Until a vendor proves it, their observations are
-- assertions wearing evidence's clothes, and `earned()` now treats them that
-- way — same ceiling it already applies to an unobserved customer.
--
-- Verification is a DNS TXT record, which proves control of the domain rather
-- than of one path on a host that serves it.

alter table vendors
	add column if not exists domain_verification_token text,
	-- Null means unverified. Cleared whenever `domain` changes, or a vendor
	-- could verify a domain they own and then point the row at one they do
	-- not — see update_vendor in src/lib/tools/registry.ts.
	add column if not exists domain_verified_at timestamptz;

-- Existing rows need a token to be able to verify at all. gen_random_uuid()
-- is already available (vendors.id defaults to it), and its hex is plenty of
-- entropy for a value that only has to be unguessable.
update vendors
set domain_verification_token = replace(gen_random_uuid()::text, '-', '')
where domain_verification_token is null;

comment on column vendors.domain_verification_token is
	'Value published in a _letterprove TXT record to prove control of `domain`. Not a secret — it is meant to be public in DNS — but it must be unguessable so nobody can pre-publish someone else''s.';
comment on column vendors.domain_verified_at is
	'When DNS control of `domain` was last confirmed. Null = unverified, which caps everything the vendor can earn at tier 0.';
