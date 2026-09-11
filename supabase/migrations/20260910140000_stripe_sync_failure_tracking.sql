-- Track failed Stripe syncs, so a vendor cannot freeze a favourable claim by
-- breaking their own connection.
--
-- The failure this closes: `last_synced_at` was stamped on the way out of a
-- FAILED sync as well as a successful one, so the single column that could
-- answer "how old is this evidence?" reported "just now" every hour a revoked
-- key failed to read anything. Evidence stood untouched, `earned()` went on
-- publishing tier 3 from it, and the only consequence was an alert addressed
-- to the vendor who revoked the key.
--
-- `last_synced_at` now means the last SUCCESSFUL sync and nothing else. The two
-- columns below carry the failure side, and src/lib/stripe/sync.ts deletes the
-- evidence once the count passes its threshold.
alter table vendor_stripe_credentials
	add column if not exists last_sync_failed_at timestamptz,
	-- Reset to zero by every success, so this is a run of failures rather than a
	-- lifetime tally. A lifetime tally would eventually delete the evidence of a
	-- vendor whose connection has simply been alive a long time.
	add column if not exists consecutive_sync_failures integer not null default 0;

comment on column vendor_stripe_credentials.last_synced_at is
	'The last sync that SUCCEEDED. Never stamped by a failure: evidence freshness is measured from here and from vendor_payment_evidence.synced_at.';
comment on column vendor_stripe_credentials.consecutive_sync_failures is
	'Consecutive failed syncs, reset by any success. Past the threshold in src/lib/stripe/sync.ts the vendor payment evidence is deleted rather than left standing uncorroborated.';
