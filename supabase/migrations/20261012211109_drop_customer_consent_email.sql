-- Customer counter-signing (tier 4) is retired: Letterprove no longer emails a
-- vendor's customers. Attestation rests on the vendor's DNS proof and its own
-- Stripe ledger (tier 3 is the top). See README, "Customer counter-signing —
-- Retired (10-12)", and decision 28.
--
-- Run AFTER the code that stops reading these columns has deployed; the old
-- code selects them on every customer read.
--
-- Snapshots already signed with "tier": 4 live in published_snapshots and are
-- untouched: their signatures cover their own bytes, not this table.
--
-- `consent` (named | anonymous) stays. It is the vendor's own statement that it
-- holds the customer's permission to be named.

drop index if exists vendor_customers_consent_token_idx;

alter table vendor_customers
	drop column if exists countersigned_at,
	drop column if exists countersigned_by,
	drop column if exists consent_token,
	drop column if exists consent_token_expires_at,
	drop column if exists consent_sent_to,
	drop column if exists consent_declined_at,
	drop column if exists consent_decline_count;
