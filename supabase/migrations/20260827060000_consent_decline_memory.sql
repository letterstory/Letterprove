-- Give a customer's "no" a memory.
--
-- The gap this closes: declining a consent request only cleared the token
-- (recordConsentDecision, src/lib/vendors/consent.ts). Nothing recorded that a
-- human had been asked and said no. The vendor's Customers page then rendered
-- that row identically to a customer who had never been asked at all — same
-- "Request consent" button, same empty state — so a vendor could not tell
-- "they declined" from "the email never arrived", and could re-send
-- immediately, and again, indefinitely.
--
-- On a product whose entire subject is consent, an un-recorded "no" is the
-- wrong default. The customer is the one party here with no account, no
-- dashboard, and no way to complain: the only signal they can send is that
-- decline, and it was being dropped.
--
-- Two columns rather than one flag, because they answer different questions:
-- declined_at drives both the display and the cooldown, and decline_count is
-- what distinguishes a single "not right now" from a pattern of being asked
-- repeatedly and refusing every time. A vendor should be able to see the
-- difference; so should we, if a dispute ever lands.
--
-- Deliberately NOT cleared on a later approval. It is an audit trail, not
-- current state — "declined in March, approved in June" is a true and useful
-- history, and callers render countersigned_at ahead of it. Same reasoning
-- that keeps countersigned_by after the token is gone.
--
-- Deliberately NOT published. It follows countersigned_by: recorded for the
-- vendor's own audit trail and for dispute resolution, never served in an
-- attestation. A customer who declined has consented to nothing at all —
-- including to the fact of their refusal being public. A guard test asserts
-- this rather than trusting the publish path to keep omitting it by accident.
--
-- What this does NOT do: make a "no" permanent. A decline is often about
-- timing or the wrong recipient, and a permanent lockout would be its own
-- failure — a customer who declined once could never later agree. The cooldown
-- in generateConsentLink() is the middle position: asking again is allowed,
-- but not immediately and not invisibly.

alter table vendor_customers
	-- When the customer last declined. Drives the cooldown in
	-- generateConsentLink() and the vendor-visible state. Never cleared.
	add column consent_declined_at timestamptz,
	-- How many times this customer has declined. Not null so the cooldown
	-- arithmetic and the UI never have to special-case a null count; rows
	-- predating this migration start at 0, which is accurate — no decline of
	-- theirs was ever recorded, and inventing one would be worse.
	add column consent_decline_count integer not null default 0;

comment on column vendor_customers.consent_declined_at is
	'When the customer last declined a consent request. Set by recordConsentDecision(); never cleared, including on a later approval. Never published.';
comment on column vendor_customers.consent_decline_count is
	'How many times this customer has declined. Distinguishes one "not now" from a pattern of refusal. Never published.';
