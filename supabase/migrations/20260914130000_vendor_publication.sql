-- A vendor is PRIVATE until someone publishes it.
--
-- Until now a vendor went public the instant its row existed: /proofs/{slug},
-- /attest/{slug}, and both chain routes resolved off `findVendor` alone, so
-- creating a vendor published a signed document about it before anyone had
-- decided to. Found in production on 09-14, creating the `letterstory` vendor
-- for fraud calibration: it immediately served a signed aggregate of zeros at
-- app.letterprove.com/attest/letterstory, and installing the collector on
-- app.letterstory.com would have turned those zeros into a public, signed
-- count of how many companies use Letterstory — before Letterprove has
-- launched, and with nobody having chosen to say it.
--
-- WHY A TIMESTAMP, NOT A BOOLEAN. "Published" is an event, and when it
-- happened is the part support and the vendor both ask about. `null` is
-- private; a timestamp is public and says since when. Same shape, same
-- reasoning, and the same null-is-the-private-default rule as
-- `domain_verified_at` and `vendor_customers.countersigned_at`.
--
-- NOT NAMED `published_at`. That name is already taken, twice, for a
-- different fact: every attestation body carries `published_at` meaning "when
-- this document was signed", and `published_snapshots` has a column of that
-- name. A vendor row's version of it is about the vendor's PROOFS becoming
-- public, and code that reads both in one function (proofs.ts does) must not
-- have to guess which is which.
alter table vendors add column if not exists proofs_published_at timestamptz;

comment on column vendors.proofs_published_at is
	'When this vendor''s proofs became publicly readable. NULL = private: collection, rollup, freeze, signing and countersigning all still run, but every public route 404s. See src/lib/fixtures/vendors.ts findPublishedVendor().';

-- Backfill the truth, rather than the default.
--
-- Defaulting every existing row to private would take `lettertrace` — the one
-- real, live integration, whose proofs are the only genuine ones we have —
-- dark at deploy. But "publish them all with now()" would be a lie about when
-- they went public. Every vendor that exists at this moment HAS been public
-- since the moment it was created, because that was the old rule. So
-- `created_at` is the honest value, and it is also the one that keeps every
-- already-published URL resolving byte-identically across this deploy.
update vendors set proofs_published_at = created_at where proofs_published_at is null;

-- Then retract the one row that should never have gone out.
--
-- `letterstory` was created hours ago as a second vendor for fraud calibration
-- (decision: "every fraud threshold is calibrated on one vendor's traffic
-- shape") and as an end-to-end test of our own install. It is not a launch.
-- This is a retraction of something currently public, not a claim that it
-- never was — which is why it is a separate statement from the backfill above
-- rather than an exception carved into it.
--
-- A no-op anywhere the row does not exist (CI, local dev, a fresh db push).
update vendors set proofs_published_at = null where slug = 'letterstory';
