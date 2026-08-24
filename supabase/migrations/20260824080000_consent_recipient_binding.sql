-- Bind a tier-4 counter-signature to the customer's own domain.
--
-- The gap this closes: 20260821060000 gave the *vendor* the consent link and
-- trusted them to hand it to their customer. Nothing checked that they did.
-- A vendor could open their own link and approve on the customer's behalf,
-- and because earned() (src/lib/attest/body.ts) treats countersigned_at as
-- tier-4 proof *ahead of* the domain-verified and observed gates, that
-- published the strongest tier in the system with no DNS proof and no
-- telemetry behind it. On a product whose entire pitch is "logo walls can be
-- faked, this can't", that is the one failure mode that matters most.
--
-- The fix is delivery, not another flag: Letterprove now emails the link
-- itself, to an address the vendor names but does not choose freely — it must
-- be on the customer's own domain. The vendor never sees the token. So
-- approving requires a mailbox at the customer's domain, which a vendor
-- attesting to a real third party does not control.
--
-- What this deliberately does NOT claim to stop: a vendor who registers a
-- domain and invents a company on it still controls both ends and can still
-- self-approve. Email delivery cannot fix that, and pretending otherwise
-- would be worse than documenting it — fraud scoring in Letterstory remains
-- the backstop for a fabricated-company rig. What this closes is the easy
-- case: self-approving for a customer whose domain you do not control.

alter table vendor_customers
	-- Where the live link was sent. Set when a link is minted, cleared with the
	-- token when the customer responds. Nullable for rows predating this.
	add column consent_sent_to text,
	-- Which address the approval actually came from, copied from consent_sent_to
	-- at the moment of approval. Kept after the token is cleared, because this
	-- is the provenance of the counter-signature: countersigned_at says a
	-- customer approved, this says who. Never cleared, same as countersigned_at.
	add column countersigned_by text;

comment on column vendor_customers.consent_sent_to is
	'Address the live consent link was emailed to. Must be on the customer''s own domain; enforced in generateConsentLink().';
comment on column vendor_customers.countersigned_by is
	'Address that approved the attestation. Provenance for countersigned_at — set once, never cleared.';
