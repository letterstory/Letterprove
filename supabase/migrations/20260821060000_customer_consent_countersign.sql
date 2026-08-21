-- Tier-4 counter-signature: a customer approving their own attestation is the
-- strongest proof in the system (README § Consent, § The trust model). Until
-- now `consent` on vendor_customers was a plain enum the *vendor* flipped
-- themselves — pure self-attestation. This adds the mechanism that actually
-- reaches the customer: an unguessable, expiring link the vendor generates
-- and hands to their customer, plus a durable record of that customer's own
-- approval.
--
-- consent_token/consent_token_expires_at are the bearer credential for the
-- public /attest/{vendor}/{customer}/consent page — the same
-- unguessable-token-in-a-column shape as vendors.domain_verification_token,
-- but generated on demand (a vendor can re-issue to invalidate a stale link)
-- rather than defaulted once at row creation. Cleared back to null once the
-- customer responds (approve or decline), so a link is single-use.
--
-- countersigned_at is the evidence itself: null until the customer approves,
-- set exactly once, never cleared. src/lib/attest/body.ts's earned() treats
-- its presence as tier-4 proof independent of the vendor's own domain/script
-- observation pipeline — the whole point of tier 4 is that it doesn't run
-- through the vendor at all.
alter table vendor_customers
	add column consent_token text,
	add column consent_token_expires_at timestamptz,
	add column countersigned_at timestamptz;

-- A vendor can only ever have one live link per customer — generating a new
-- one overwrites the old, so this doesn't need uniqueness scoped narrower
-- than the column itself. Partial: most rows have no live link.
create unique index if not exists vendor_customers_consent_token_idx
	on vendor_customers (consent_token)
	where consent_token is not null;
